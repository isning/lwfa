//! Versioned media fragments; no stale payload is retransmitted.
use super::*;
use wtransport::proto::{datagram::Datagram as H3Datagram, ids::QStreamId};

pub const HEADER: usize = 48;
pub const LIFETIME: Duration = Duration::from_millis(150);
pub const RECEIPT_TIMEOUT: Duration = Duration::from_millis(300);

pub struct Media {
    pub packet: u64,
    pub lane: u64,
    pub frame: u64,
    pub audio: bool,
    pub key: bool,
    pub bytes: tungstenite::Bytes,
    pub deadline: Instant,
}

/// A bounded local queue wait is pacing, not reliable network delivery.
/// Quinn's non-waiting send_datagram evicts queued fragments when full; using
/// send_datagram_wait prevents us destroying large keyframes in our own queue.
/// The HTTP/3 quarter-stream ID is included exactly as wtransport's sender does.
pub async fn send(connection: Connection, media: Media) -> Result<(), Failure> {
    let max = connection
        .max_datagram_size()
        .ok_or_else(|| io::Error::other("peer has no datagrams"))?
        .min(1200);
    let stride = max
        .checked_sub(HEADER)
        .filter(|s| *s > 0)
        .ok_or_else(|| io::Error::other("datagram MTU too small"))?;
    let count = media.bytes.len().div_ceil(stride);
    if count == 0 || count > u16::MAX as usize {
        return Err(io::Error::other("too many media fragments").into());
    }
    for (index, chunk) in media.bytes.chunks(stride).enumerate() {
        // timeout_at may poll an immediately-ready future even after its
        // deadline; explicitly reject stale payload before enqueueing it.
        if Instant::now() >= media.deadline {
            return Err(
                io::Error::new(io::ErrorKind::TimedOut, "media expired before enqueue").into(),
            );
        }
        let payload = fragment(&media, index as u16, count as u16, stride as u16, chunk);
        let h3 = H3Datagram::new(
            QStreamId::from_session_id(connection.session_id()),
            &payload,
        );
        let mut wire = vec![0; h3.write_size()];
        h3.write(&mut wire)
            .map_err(|e| io::Error::other(format!("datagram framing: {e:?}")))?;
        tokio::time::timeout_at(
            media.deadline.into(),
            connection.quic_connection().send_datagram_wait(wire.into()),
        )
        .await??;
    }
    Ok(())
}

fn fragment(media: &Media, index: u16, count: u16, stride: u16, chunk: &[u8]) -> Vec<u8> {
    let mut out = vec![0; HEADER + chunk.len()];
    out[..4].copy_from_slice(b"LWFD");
    out[4] = 1;
    out[5] = if media.audio { 2 } else { 1 };
    out[6] = u8::from(media.key);
    out[8..16].copy_from_slice(&media.packet.to_be_bytes());
    out[16..24].copy_from_slice(&media.lane.to_be_bytes());
    out[24..32].copy_from_slice(&media.frame.to_be_bytes());
    out[32..36].copy_from_slice(&(media.bytes.len() as u32).to_be_bytes());
    out[36..38].copy_from_slice(&index.to_be_bytes());
    out[38..40].copy_from_slice(&count.to_be_bytes());
    out[40..42].copy_from_slice(&stride.to_be_bytes());
    out[HEADER..].copy_from_slice(chunk);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragment_header_matches_browser_layout_and_keeps_recovery_identity() {
        let media = Media {
            packet: 9,
            lane: 7,
            frame: 11,
            audio: false,
            key: true,
            bytes: vec![1, 2, 3, 4, 5].into(),
            deadline: Instant::now(),
        };
        let first = fragment(&media, 0, 2, 3, &[1, 2, 3]);
        let last = fragment(&media, 1, 2, 3, &[4, 5]);
        assert_eq!(&first[..8], &[76, 87, 70, 68, 1, 1, 1, 0]);
        assert_eq!(&first[8..16], &9u64.to_be_bytes());
        assert_eq!(&first[16..24], &7u64.to_be_bytes());
        assert_eq!(&first[24..32], &11u64.to_be_bytes());
        assert_eq!(&first[32..42], &[0, 0, 0, 5, 0, 0, 0, 2, 0, 3]);
        assert_eq!(&last[36..42], &[0, 1, 0, 2, 0, 3]);
        assert_eq!(
            [&first[HEADER..], &last[HEADER..]].concat(),
            &media.bytes[..]
        );
    }
}
