//! Native QUIC adapter for the existing authenticated shell session registry.
//!
//! One reliable control stream and unreliable fragmented media datagrams.
//! Receiver deadlines and IDR refresh recover predictive video after loss.
//! Delivery receipts bound queued media but never trigger retransmission;
//! expired media releases its budget without closing the control session.
use super::*;
use std::collections::HashMap;
use std::io;
use std::sync::OnceLock;
use std::time::Instant;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use wtransport::{Connection, Endpoint, Identity, RecvStream, SendStream, ServerConfig, VarInt};

const MAX_CONTROL: usize = 4 * 1024 * 1024;
const MAX_MEDIA: usize = 32 * 1024 * 1024;
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
                    let mut transport = wtransport::quinn::TransportConfig::default();
                    transport.datagram_send_buffer_size(8 * 1024);
                    let config = ServerConfig::builder()
                        .with_bind_address(addr)
                        .with_custom_transport(identity, transport)
                        .keep_alive_interval(Some(Duration::from_secs(1)))
                        .max_idle_timeout(Some(Duration::from_secs(15)))?
                        .build();
                    let endpoint = Endpoint::server(config)?;
                    let port = endpoint.local_addr()?.port();
                    let _ = DISCOVERY.set(
                        serde_json::json!({"port": port, "certificateHash": hash, "version": 2}),
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
    window: u64,
}
type Acks = Arc<Mutex<HashMap<u64, Pending>>>;
mod datagrams;

#[derive(Default)]
struct Recovery {
    streams: Option<ToEngine>,
    last: Option<Instant>,
}
type SharedRecovery = Arc<Mutex<Recovery>>;
fn recover(recovery: &SharedRecovery, events: &LoopSender<ShellEvent>, id: SessionId, window: u64) {
    let Ok(mut state) = recovery.lock() else {
        return;
    };
    if state
        .last
        .is_some_and(|last| last.elapsed() < Duration::from_millis(500))
    {
        return;
    }
    let Some(ToEngine::SetStreams { windows, .. }) = state.streams.as_ref() else {
        return;
    };
    if !windows.contains(&WindowId(window)) {
        return;
    }
    if let Some(message) = state.streams.clone() {
        state.last = Some(Instant::now());
        // Reuse the normal permission-checked refresh path, including damage
        // invalidation for idle windows. Request NEW IDRs, never old fragments.
        let _ = events.send(ShellEvent::Message(id, message));
    }
}
fn retire(slot: &Slot, pending: Pending) {
    if pending.audio {
        slot.audio_in_flight.fetch_sub(1, Ordering::Relaxed);
    } else {
        slot.in_flight.fetch_sub(1, Ordering::Relaxed);
        slot.in_flight_bytes
            .fetch_sub(pending.size, Ordering::Relaxed);
    }
}

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
    let recovery: SharedRecovery = Arc::new(Mutex::new(Recovery::default()));
    let mut tasks = JoinSet::new();
    let read = tokio::spawn(read_control(
        control_recv,
        slot.clone(),
        acks.clone(),
        events.clone(),
        recovery.clone(),
    ));
    // Aborted even if an error exits the dispatch loop.
    struct ReaderGuard(tokio::task::AbortHandle);
    impl Drop for ReaderGuard {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _reader_guard = ReaderGuard(read.abort_handle());
    tokio::pin!(read);
    let mut sequence = 0u64;
    let mut tick = tokio::time::interval(Duration::from_millis(25));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut delay = DelayEstimate::default();
    let mut last_probe = Instant::now();
    let mut over_limit = 0;
    loop {
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
                Outgoing::Frame(_, _, _) | Outgoing::Audio(_) => {
                    let (bytes, audio, frame) = match message {
                        Outgoing::Frame(b, n, queued_at) => {
                            if let Some(at) = queued_at { crate::telemetry::observe("sendQueue", at.elapsed()); }
                            (b, false, n)
                        },
                        Outgoing::Audio(b) => (b, true, 0),
                        _ => unreachable!(),
                    };
                    if bytes.len() > MAX_MEDIA {
                        return Err(io::Error::other("media packet too large").into());
                    }
                    let (window, key) = if audio {
                        (0, true)
                    } else {
                        let header = lwfa_proto::FrameHeader::decode(&bytes)
                            .ok_or_else(|| io::Error::other("invalid encoded frame"))?
                            .0;
                        (
                            header.window.0,
                            header.keyframe || header.format == lwfa_proto::FrameFormat::Jpeg,
                        )
                    };
                    sequence = sequence
                        .checked_add(1)
                        .ok_or_else(|| io::Error::other("sequence exhausted"))?;
                    acks.lock()
                        .map_err(|_| io::Error::other("receipt lock"))?
                        .insert(
                            sequence,
                            Pending {
                                size: bytes.len(),
                                audio,
                                since: Instant::now(),
                                window,
                            },
                        );
                    let connection = connection.clone();
                    let media = datagrams::Media {
                        packet: sequence,
                        lane: window,
                        frame: if audio { sequence } else { frame },
                        audio,
                        key,
                        bytes,
                        deadline: Instant::now() + datagrams::LIFETIME,
                    };
                    tasks.spawn(
                        async move { (media.packet, datagrams::send(connection, media).await) },
                    );
                }
            }
        }
        tokio::select! {
            _ = &mut notified => {},
            _ = connection.closed() => return Ok(()),
            result = &mut read => { result??; return Ok(()) },
            result = tasks.join_next(), if !tasks.is_empty() => {
                let (packet, sent) = result.ok_or_else(|| io::Error::other("media task missing"))??;
                if sent.is_err() {
                    crate::telemetry::count("sendExpired");
                    // Congestion/deadline expiry drops media, never the session.
                    if let Some(pending) = acks.lock().map_err(|_| io::Error::other("receipt lock"))?.remove(&packet) {
                        if !pending.audio { recover(&recovery, &events, id, pending.window); }
                        retire(&slot, pending);
                    }
                }
            },
            _ = tick.tick() => {
                if last_probe.elapsed() >= PROBE_INTERVAL {
                    last_probe = Instant::now();
                    crate::telemetry::rtt(id, connection.rtt());
                    let queue = delay.observe(connection.rtt(), Instant::now());
                    slot.rtt_excess.store(queue.as_micros().min(u64::MAX as u128) as u64, Ordering::Relaxed);
                    over_limit = if queue >= crate::bitrate::QUEUE_DELAY_LIMIT { over_limit + 1 } else { 0 };
                    slot.delay_congested.store(over_limit >= SUSTAINED_PROBES, Ordering::Relaxed);
                    slot.answering.store(true, Ordering::Relaxed);
                }
                let mut pending = acks.lock().map_err(|_| io::Error::other("receipt lock"))?;
                let expired: Vec<_> = pending.iter().filter(|(_, p)| p.since.elapsed() >= datagrams::RECEIPT_TIMEOUT).map(|(&n, _)| n).collect();
                for n in expired {
                    if let Some(p) = pending.remove(&n) {
                        crate::telemetry::count("receiptTimeouts");
                        if !p.audio { recover(&recovery, &events, id, p.window); }
                        retire(&slot, p);
                    }
                }
            },
            _ = connection.accept_bi() => return Err(io::Error::other("extra control stream").into()),
            _ = connection.accept_uni() => return Err(io::Error::other("unexpected incoming media stream").into()),
        }
    }
}

async fn read_control(
    mut stream: RecvStream,
    slot: Arc<Slot>,
    acks: Acks,
    events: LoopSender<ShellEvent>,
    recovery: SharedRecovery,
) -> Result<(), Failure> {
    loop {
        let packet = read_packet(&mut stream, MAX_CONTROL).await?;
        let Some((&kind, body)) = packet.split_first() else {
            return Err(io::Error::other("empty control packet").into());
        };
        match kind {
            0 => {
                let message: ToEngine = serde_json::from_slice(body)?;
                if matches!(&message, ToEngine::SetStreams { .. }) {
                    recovery
                        .lock()
                        .map_err(|_| io::Error::other("recovery lock"))?
                        .streams = Some(message.clone());
                }
                events.send(incoming_message(slot.id, message))?;
            }
            1 if body.len() == 8 => {
                let sequence = u64::from_be_bytes(body.try_into()?);
                // Receipts for already expired or discarded media are harmless.
                let pending = acks
                    .lock()
                    .map_err(|_| io::Error::other("receipt lock"))?
                    .remove(&sequence);
                if let Some(pending) = pending {
                    retire(&slot, pending);
                }
            }
            2 if body == [2] => {}
            3 if body.len() == 8 => {
                recover(
                    &recovery,
                    &events,
                    slot.id,
                    u64::from_be_bytes(body.try_into()?),
                );
            }
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

    async fn receive_media(connection: &Connection) -> (u64, Vec<u8>) {
        let first = connection.receive_datagram().await.unwrap();
        assert_eq!(&first[..4], b"LWFD");
        let packet = u64::from_be_bytes(first[8..16].try_into().unwrap());
        let size = u32::from_be_bytes(first[32..36].try_into().unwrap()) as usize;
        let count = u16::from_be_bytes(first[38..40].try_into().unwrap()) as usize;
        let stride = u16::from_be_bytes(first[40..42].try_into().unwrap()) as usize;
        let mut bytes = vec![0; size];
        let mut parts = vec![first];
        for _ in 1..count {
            parts.push(connection.receive_datagram().await.unwrap());
        }
        for part in parts {
            assert_eq!(u64::from_be_bytes(part[8..16].try_into().unwrap()), packet);
            let offset = u16::from_be_bytes(part[36..38].try_into().unwrap()) as usize * stride;
            bytes[offset..offset + part.len() - datagrams::HEADER]
                .copy_from_slice(&part[datagrams::HEADER..]);
        }
        (packet, bytes)
    }

    #[tokio::test]
    async fn quic_datagrams_fragment_media_and_expire_lost_receipts_without_stalling_control() {
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
            write_packet(&mut send, &[2, 2], MAX_CONTROL).await.unwrap();
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
            .encode_with_payload(&vec![3; 5000]);
            FrameSink {
                clients: clients.clone(),
            }
            .send_frame(WindowId(1), bytes.clone());
            let (packet, media) = receive_media(&connection).await;
            assert_eq!(media, bytes);
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
            let (sound_packet, sound) = receive_media(&connection).await;
            assert_eq!(&sound, &[9, 8, 7]);
            clients.send_to(1, ToShell::Pong);
            assert_eq!(
                serde_json::from_slice::<ToShell>(
                    &read_packet(&mut recv, MAX_CONTROL).await.unwrap()
                )
                .unwrap(),
                ToShell::Pong
            );
            write_packet(
                &mut send,
                &[&[1][..], &sound_packet.to_be_bytes()].concat(),
                MAX_CONTROL,
            )
            .await
            .unwrap();
            while clients.with(1, |s| s.audio_in_flight.load(Ordering::Relaxed)) != Some(0) {
                tokio::task::yield_now().await;
            }
            assert_eq!(
                clients.with(1, |s| s.in_flight.load(Ordering::Relaxed)),
                Some(1)
            );
            // Deliberately lose the entire video receipt. Its finite budget
            // expires without retransmitting media or disconnecting control.
            while clients.with(1, |s| s.in_flight.load(Ordering::Relaxed)) != Some(0) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            // A late receipt is harmless rather than closing the session.
            write_packet(
                &mut send,
                &[&[1][..], &packet.to_be_bytes()].concat(),
                MAX_CONTROL,
            )
            .await
            .unwrap();
            clients.send_to(1, ToShell::Pong);
            assert_eq!(
                serde_json::from_slice::<ToShell>(
                    &read_packet(&mut recv, MAX_CONTROL).await.unwrap()
                )
                .unwrap(),
                ToShell::Pong
            );
            let expired = datagrams::Media {
                packet: 99,
                lane: 0,
                frame: 99,
                audio: true,
                key: true,
                bytes: vec![1, 2, 3].into(),
                deadline: Instant::now() - Duration::from_millis(1),
            };
            assert!(
                datagrams::send(connection.clone(), expired)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("expired before enqueue")
            );
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
