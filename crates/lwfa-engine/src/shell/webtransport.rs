//! Native QUIC adapter for the existing authenticated shell session registry.
//!
//! One reliable control stream, one audio stream and one stream per window.
//! Predictive frames stay ordered within a window; a lost packet on that stream
//! cannot block control, audio or another window. Media is counted until the
//! browser reads and acknowledges it, not until QUIC buffers a write.
use super::*;
use std::collections::HashMap;
use std::io;
use std::sync::OnceLock;
use std::time::Instant;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;
use wtransport::{Connection, Endpoint, Identity, RecvStream, SendStream, ServerConfig, VarInt};

const MAX_CONTROL: usize = 4 * 1024 * 1024;
const MAX_MEDIA: usize = 32 * 1024 * 1024;
const MAX_LANES: usize = 128;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
static DISCOVERY: OnceLock<serde_json::Value> = OnceLock::new();
type Accounts = Option<Arc<Mutex<crate::accounts::Accounts>>>;
type Failure = Box<dyn std::error::Error + Send + Sync>;

pub(crate) fn discovery() -> Option<&'static serde_json::Value> {
    DISCOVERY.get()
}

/// Opt-in so existing deployments need no certificate or UDP configuration.
/// Misconfiguration is fatal rather than silently advertising a broken endpoint.
pub(super) fn start(
    clients: Arc<Clients>,
    token: SharedToken,
    accounts: Accounts,
    events: LoopSender<ShellEvent>,
) -> io::Result<()> {
    let Ok(addr) = std::env::var("LWFA_WEBTRANSPORT_ADDR") else {
        return Ok(());
    };
    let cert = std::env::var("LWFA_WEBTRANSPORT_CERT").map_err(io::Error::other)?;
    let key = std::env::var("LWFA_WEBTRANSPORT_KEY").map_err(io::Error::other)?;
    let addr: std::net::SocketAddr = addr.parse().map_err(io::Error::other)?;
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    thread::Builder::new()
        .name("lwfa-quic".into())
        .spawn(move || {
            let result = (|| -> Result<(), Failure> {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()?;
                runtime.block_on(async move {
                    let identity = Identity::load_pemfiles(cert, key).await?;
                    use sha2::Digest;
                    let hash = if std::env::var("LWFA_WEBTRANSPORT_PIN_CERT").as_deref() == Ok("1")
                    {
                        Some(
                            sha2::Sha256::digest(
                                identity
                                    .certificate_chain()
                                    .as_slice()
                                    .first()
                                    .ok_or_else(|| io::Error::other("empty certificate chain"))?
                                    .der(),
                            )
                            .to_vec(),
                        )
                    } else {
                        None
                    };
                    let config = ServerConfig::builder()
                        .with_bind_address(addr)
                        .with_identity(identity)
                        .keep_alive_interval(Some(Duration::from_secs(1)))
                        .max_idle_timeout(Some(Duration::from_secs(15)))?
                        .build();
                    let endpoint = Endpoint::server(config)?;
                    let port = endpoint.local_addr()?.port();
                    let _ = DISCOVERY.set(
                        serde_json::json!({"port": port, "certificateHash": hash, "version": 1}),
                    );
                    tracing::info!("WebTransport listening on UDP {}", endpoint.local_addr()?);
                    let _ = ready_tx.send(Ok(()));
                    // Bound unauthenticated handshakes as well as authenticated sessions.
                    let permits = Arc::new(Semaphore::new(16));
                    loop {
                        let incoming = endpoint.accept().await;
                        let Ok(permit) = permits.clone().try_acquire_owned() else {
                            drop(incoming);
                            continue;
                        };
                        let (clients, token, accounts, events) = (
                            clients.clone(),
                            token.clone(),
                            accounts.clone(),
                            events.clone(),
                        );
                        tokio::spawn(async move {
                            let _permit = permit;
                            let result = async {
                                let request =
                                    tokio::time::timeout(HANDSHAKE_TIMEOUT, incoming).await??;
                                if request.path().split('?').next() != Some("/session") {
                                    request.not_found().await;
                                    return Ok::<_, Failure>(());
                                }
                                let Some(presented) = auth::token_from_query(request.path()) else {
                                    request.forbidden().await;
                                    return Ok(());
                                };
                                let device = auth::param_from_query(request.path(), "device")
                                    .map(|s| sanitise_device(&s))
                                    .unwrap_or_else(|| "WebTransport browser".into());
                                let client = auth::param_from_query(request.path(), "client")
                                    .map(|s| sanitise_device(&s))
                                    .unwrap_or_default();
                                let owner = token
                                    .lock()
                                    .map_err(|_| io::Error::other("token lock"))?
                                    .clone();
                                let who = tokio::task::spawn_blocking(move || {
                                    if auth::token_matches(&owner, &presented) {
                                        return Some(crate::accounts::Identity::Owner);
                                    }
                                    accounts
                                        .and_then(|db| db.lock().ok()?.authenticate(&presented))
                                        .map(crate::accounts::Identity::User)
                                })
                                .await?;
                                let Some(who) = who else {
                                    request.forbidden().await;
                                    return Ok(());
                                };
                                let connection =
                                    tokio::time::timeout(HANDSHAKE_TIMEOUT, request.accept())
                                        .await??;
                                run(connection, clients, events, who, device, client).await
                            }
                            .await;
                            if let Err(err) = result {
                                tracing::debug!("WebTransport session ended: {err}");
                            }
                        });
                    }
                    #[allow(unreachable_code)]
                    Ok::<(), Failure>(())
                })
            })();
            if let Err(err) = result {
                // No request paths or credentials are logged here.
                tracing::error!("WebTransport listener failed: {err}");
            }
        })?;
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(io::Error::other)?
}

#[derive(Clone, Copy)]
struct Pending {
    size: usize,
    audio: bool,
    since: Instant,
}
type Acks = Arc<Mutex<HashMap<u64, Pending>>>;

struct SessionGuard {
    slot: Arc<Slot>,
    clients: Arc<Clients>,
    events: LoopSender<ShellEvent>,
    connection: Connection,
}
impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.slot.connected.store(false, Ordering::Relaxed);
        self.clients.remove(self.slot.id);
        self.connection.close(VarInt::from_u32(0), b"session-ended");
        let _ = self.events.send(ShellEvent::Disconnected(self.slot.id));
    }
}

async fn run(
    connection: Connection,
    clients: Arc<Clients>,
    events: LoopSender<ShellEvent>,
    who: crate::accounts::Identity,
    device: String,
    client: String,
) -> Result<(), Failure> {
    let (mut control_send, control_recv) =
        tokio::time::timeout(HANDSHAKE_TIMEOUT, connection.accept_bi()).await??;
    control_send.set_priority(100);
    let id = clients.allocate();
    let (slot, outgoing) = Slot::create(id);
    clients.add(slot.clone());
    let _guard = SessionGuard {
        slot: slot.clone(),
        clients: clients.clone(),
        events: events.clone(),
        connection: connection.clone(),
    };
    events.send(ShellEvent::Connected {
        session: id,
        permissions: who.permissions(),
        account: who.name().into(),
        device,
        client,
    })?;
    tracing::info!(
        "shell {id} connected over WebTransport from {}",
        connection.remote_address()
    );
    let acks: Acks = Arc::new(Mutex::new(HashMap::new()));
    let mut tasks = JoinSet::new();
    tasks.spawn(read_control(
        control_recv,
        slot.clone(),
        acks.clone(),
        events,
    ));
    let mut lanes: HashMap<u64, mpsc::Sender<(u64, tungstenite::Bytes)>> = HashMap::new();
    let mut sequence = 0u64;
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut delay = DelayEstimate::default();
    let mut over_limit = 0;
    loop {
        // Register before draining: a producer cannot race the sleep below.
        let notified = clients.quic_wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if slot.evict.load(Ordering::Relaxed) {
            let reason = if slot.superseded.load(Ordering::Relaxed) {
                SUPERSEDED_REASON
            } else {
                REPLACED_REASON
            };
            connection.close(VarInt::from_u32(0), reason.as_bytes());
            return Ok(());
        }
        while let Ok(message) = outgoing.try_recv() {
            match message {
                Outgoing::Control(text) => {
                    tokio::time::timeout(
                        WRITE_TIMEOUT,
                        write_packet(&mut control_send, text.as_bytes(), MAX_CONTROL),
                    )
                    .await??;
                }
                Outgoing::Frame(_) | Outgoing::Audio(_) => {
                    let (bytes, audio) = match message {
                        Outgoing::Frame(b) => (b, false),
                        Outgoing::Audio(b) => (b, true),
                        _ => unreachable!(),
                    };
                    if bytes.len() > MAX_MEDIA {
                        return Err(io::Error::other("media packet too large").into());
                    }
                    // Window IDs start at one; zero is the separate audio lane.
                    let lane = if audio {
                        0
                    } else {
                        lwfa_proto::FrameHeader::decode(&bytes)
                            .ok_or_else(|| io::Error::other("invalid encoded frame"))?
                            .0
                            .window
                            .0
                    };
                    if let std::collections::hash_map::Entry::Vacant(entry) = lanes.entry(lane) {
                        if tasks.len() > MAX_LANES {
                            return Err(io::Error::other("too many media lanes").into());
                        }
                        let (tx, rx) = mpsc::channel(4);
                        entry.insert(tx);
                        tasks.spawn(media_lane(connection.clone(), rx, audio));
                    }
                    sequence = sequence
                        .checked_add(1)
                        .ok_or_else(|| io::Error::other("sequence exhausted"))?;
                    acks.lock()
                        .map_err(|_| io::Error::other("ack lock"))?
                        .insert(
                            sequence,
                            Pending {
                                size: bytes.len(),
                                audio,
                                since: Instant::now(),
                            },
                        );
                    lanes[&lane]
                        .try_send((sequence, bytes))
                        .map_err(|_| io::Error::other("media queue overflow"))?;
                }
            }
        }
        tokio::select! {
            _ = &mut notified => {},
            _ = connection.closed() => return Ok(()),
            result = tasks.join_next() => {
                if let Some(result) = result { result??; }
                return Err(io::Error::other("transport stream closed").into())
            },
            _ = tick.tick() => {
                let queue = delay.observe(connection.rtt(), Instant::now());
                slot.rtt_excess.store(queue.as_micros().min(u64::MAX as u128) as u64, Ordering::Relaxed);
                over_limit = if queue >= crate::bitrate::QUEUE_DELAY_LIMIT { over_limit + 1 } else { 0 };
                slot.delay_congested.store(over_limit >= SUSTAINED_PROBES, Ordering::Relaxed);
                slot.answering.store(true, Ordering::Relaxed);
                if acks.lock().map_err(|_| io::Error::other("ack lock"))?.values().any(|p| p.since.elapsed() > WRITE_TIMEOUT) {
                    return Err(io::Error::other("browser stopped acknowledging media").into())
                }
            },
            _ = connection.accept_bi() => return Err(io::Error::other("extra control stream").into()),
            _ = connection.accept_uni() => return Err(io::Error::other("unexpected incoming media stream").into()),
        }
    }
}

async fn media_lane(
    connection: Connection,
    mut packets: mpsc::Receiver<(u64, tungstenite::Bytes)>,
    audio: bool,
) -> Result<(), Failure> {
    let mut stream = tokio::time::timeout(WRITE_TIMEOUT, async {
        Ok::<_, Failure>(connection.open_uni().await?.await?)
    })
    .await??;
    stream.set_priority(if audio { 50 } else { 0 });
    stream.write_all(&[if audio { 2 } else { 1 }]).await?;
    while let Some((sequence, bytes)) = packets.recv().await {
        tokio::time::timeout(WRITE_TIMEOUT, async {
            stream
                .write_all(&((bytes.len() + 8) as u32).to_be_bytes())
                .await?;
            stream.write_all(&sequence.to_be_bytes()).await?;
            stream.write_all(&bytes).await
        })
        .await??;
    }
    Ok(())
}

async fn read_control(
    mut stream: RecvStream,
    slot: Arc<Slot>,
    acks: Acks,
    events: LoopSender<ShellEvent>,
) -> Result<(), Failure> {
    loop {
        let packet = read_packet(&mut stream, MAX_CONTROL).await?;
        let Some((&kind, body)) = packet.split_first() else {
            return Err(io::Error::other("empty control packet").into());
        };
        match kind {
            0 => {
                events.send(ShellEvent::Message(
                    slot.id,
                    serde_json::from_slice::<ToEngine>(body)?,
                ))?;
            }
            1 if body.len() == 8 => {
                let sequence = u64::from_be_bytes(body.try_into()?);
                let pending = acks
                    .lock()
                    .map_err(|_| io::Error::other("ack lock"))?
                    .remove(&sequence);
                let Some(pending) = pending else {
                    return Err(io::Error::other("unknown media acknowledgement").into());
                };
                if pending.audio {
                    slot.audio_in_flight.fetch_sub(1, Ordering::Relaxed);
                } else {
                    slot.in_flight.fetch_sub(1, Ordering::Relaxed);
                    slot.in_flight_bytes
                        .fetch_sub(pending.size, Ordering::Relaxed);
                }
            }
            2 if body == [1] => {}
            _ => return Err(io::Error::other("invalid control packet").into()),
        }
    }
}

async fn write_packet(stream: &mut SendStream, bytes: &[u8], max: usize) -> Result<(), Failure> {
    if bytes.len() > max {
        return Err(io::Error::other("control packet too large").into());
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    stream.write_all(bytes).await?;
    Ok(())
}

async fn read_packet(stream: &mut RecvStream, max: usize) -> Result<Vec<u8>, Failure> {
    let mut size = [0; 4];
    stream.read_exact(&mut size).await?;
    let size = u32::from_be_bytes(size) as usize;
    if size == 0 || size > max {
        return Err(io::Error::other("invalid control packet size").into());
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn quic_session_delivers_control_and_media_and_releases_budget_only_on_ack() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let identity = Identity::self_signed(["localhost"]).unwrap();
            let hash = identity.certificate_chain().as_slice()[0].hash();
            let server = Endpoint::server(
                ServerConfig::builder()
                    .with_bind_address("127.0.0.1:0".parse().unwrap())
                    .with_identity(identity)
                    .build(),
            )
            .unwrap();
            let addr = server.local_addr().unwrap();
            let endpoint = Endpoint::client(
                wtransport::ClientConfig::builder()
                    .with_bind_default()
                    .with_server_certificate_hashes([hash])
                    .build(),
            )
            .unwrap();
            let wake = rustix::event::eventfd(
                0,
                rustix::event::EventfdFlags::CLOEXEC | rustix::event::EventfdFlags::NONBLOCK,
            )
            .unwrap();
            let clients = Arc::new(Clients::new(4, wake));
            let registry = clients.clone();
            let (events, _receiver) = smithay::reexports::calloop::channel::channel();
            let task = tokio::spawn(async move {
                let request = server.accept().await.await.unwrap();
                let connection = request.accept().await.unwrap();
                run(
                    connection,
                    registry,
                    events,
                    crate::accounts::Identity::Owner,
                    "test".into(),
                    "stable".into(),
                )
                .await
            });
            let connection = endpoint
                .connect(format!("https://127.0.0.1:{}/session", addr.port()))
                .await
                .unwrap();
            let (mut send, mut recv) = connection.open_bi().await.unwrap().await.unwrap();
            write_packet(&mut send, &[2, 1], MAX_CONTROL).await.unwrap();
            while clients.with(1, |_| ()).is_none() {
                tokio::task::yield_now().await;
            }
            clients.send_to(1, ToShell::Pong);
            assert_eq!(
                serde_json::from_slice::<ToShell>(
                    &read_packet(&mut recv, MAX_CONTROL).await.unwrap()
                )
                .unwrap(),
                ToShell::Pong
            );
            clients.set_streams(1, HashSet::from([WindowId(1)]));
            let bytes = lwfa_proto::FrameHeader {
                window: WindowId(1),
                width: 2,
                height: 2,
                format: lwfa_proto::FrameFormat::Jpeg,
                keyframe: true,
            }
            .encode_with_payload(&[1, 2, 3]);
            FrameSink {
                clients: clients.clone(),
            }
            .send_frame(WindowId(1), bytes.clone());
            let mut media = connection.accept_uni().await.unwrap();
            let mut kind = [0];
            media.read_exact(&mut kind).await.unwrap();
            assert_eq!(kind, [1]);
            let data = read_packet(&mut media, MAX_MEDIA).await.unwrap();
            assert_eq!(&data[8..], bytes);
            assert_eq!(
                clients.with(1, |s| s.in_flight.load(Ordering::Relaxed)),
                Some(1)
            );
            // An unread video acknowledgement cannot hold up audio or control.
            clients.set_audio(1, true, true);
            FrameSink {
                clients: clients.clone(),
            }
            .send_audio(crate::audio::Chunk {
                opus: Some(vec![9, 8, 7]),
                pcm: None,
            });
            let mut audio = connection.accept_uni().await.unwrap();
            audio.read_exact(&mut kind).await.unwrap();
            assert_eq!(kind, [2]);
            let sound = read_packet(&mut audio, MAX_MEDIA).await.unwrap();
            assert_eq!(&sound[8..], &[9, 8, 7]);
            clients.send_to(1, ToShell::Pong);
            assert_eq!(
                serde_json::from_slice::<ToShell>(
                    &read_packet(&mut recv, MAX_CONTROL).await.unwrap()
                )
                .unwrap(),
                ToShell::Pong
            );
            write_packet(&mut send, &[&[1][..], &sound[..8]].concat(), MAX_CONTROL)
                .await
                .unwrap();
            while clients.with(1, |s| s.audio_in_flight.load(Ordering::Relaxed)) != Some(0) {
                tokio::task::yield_now().await;
            }
            assert_eq!(
                clients.with(1, |s| s.in_flight.load(Ordering::Relaxed)),
                Some(1)
            );
            let ack = [&[1][..], &data[..8]].concat();
            write_packet(&mut send, &ack, MAX_CONTROL).await.unwrap();
            while clients.with(1, |s| s.in_flight.load(Ordering::Relaxed)) != Some(0) {
                tokio::task::yield_now().await;
            }
            clients.evict(1, false);
            let reason = connection.closed().await;
            assert!(format!("{reason}").contains(REPLACED_REASON));
            assert!(task.await.unwrap().is_ok());
            assert!(clients.with(1, |_| ()).is_none());
        })
        .await
        .expect("QUIC integration timed out");
    }
}
