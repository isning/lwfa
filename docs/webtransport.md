# WebTransport sessions

The shell prefers WebTransport over HTTP/3/QUIC when the engine advertises it
and the browser supports it. The application protocol, permissions, account
passwords, reconnect identity, window composition and codecs stay the same.
WebSocket remains available for older engines/browsers and file uploads.

## Deployment

The engine still serves the shell and HTTP endpoints on `LWFA_SHELL_ADDR`.
Enable its separate native QUIC listener with:

```sh
export LWFA_WEBTRANSPORT_ADDR=0.0.0.0:6734
export LWFA_WEBTRANSPORT_CERT=/absolute/path/to/cert.pem
export LWFA_WEBTRANSPORT_KEY=/absolute/path/to/key.pem
```

All three settings are required when the listener is enabled. Invalid TLS or
bind configuration fails the shell listener initialization; it does not silently
advertise a nonworking transport. Without `LWFA_WEBTRANSPORT_ADDR`, existing
WebSocket deployments work as before.

Serve the page over HTTPS, using the existing proxy instructions in
[remote access](remote-access.md#tls). Open the QUIC port for **UDP** to the
engine itself. An ordinary HTTP/WebSocket reverse proxy does not forward this
QUIC connection. Discovery currently advertises the actual bound UDP port on
the engine URL's hostname, so NAT must preserve that external port. An alternate
public hostname/port mapping is not implemented.

A publicly trusted certificate is the production default. Do not set the pin
option for an ordinary publicly trusted certificate with a long validity period.
The browser validates its chain and hostname normally.

### Local self-signed certificates

For local development, an explicit certificate hash can authenticate the QUIC
endpoint without installing its self-signed certificate. The browser requires
an ECDSA P-256 certificate valid for at most 14 days. For example:

```sh
mkdir -p deploy/local
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
  -days 12 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout deploy/local/quic.key -out deploy/local/quic.crt
chmod 600 deploy/local/quic.key
export LWFA_WEBTRANSPORT_CERT="$PWD/deploy/local/quic.crt"
export LWFA_WEBTRANSPORT_KEY="$PWD/deploy/local/quic.key"
export LWFA_WEBTRANSPORT_PIN_CERT=1
```

The HTTPS page still needs its own accepted/trusted certificate. Its authenticated
origin provides `capabilities.json`, including the QUIC port, transport version
and optional SHA-256 certificate hash. The shell does not discover a remote QUIC
endpoint over plaintext HTTP. The pin authenticates the certificate supplied by
that HTTPS origin; it is not an independent trust anchor. Renew short-lived
certificates and restart the engine before they expire.

## Wire layout and ordering

Version 2 uses **unreliable datagrams for video and audio**, with a reliable
bidirectional control stream. The browser requires an unreliable-capable
transport (`requireUnreliable: true`). The native server speaks HTTP/3/QUIC;
there is no TCP fallback hidden inside the v2 media path.

A session authenticates `/session?token=…&client=…&device=…` using the existing
owner/account lookup. The client opens one control stream. Each client control
packet has a four-byte big-endian length and a one-byte kind:

- `0`: UTF-8 JSON `ToEngine` message.
- `1`: eight-byte big-endian media disposition sequence (read or retired).
- `2`: one-byte transport version, currently `2` (the opening preface).
- `3`: eight-byte window ID requesting a **new** independently decodable frame.

Server control packets remain length-prefixed UTF-8 JSON `ToShell` messages.
A media datagram contains a 48-byte header followed by one fragment:

| Bytes | Meaning |
| --- | --- |
| 0–3 | ASCII `LWFD` |
| 4 | Fragment format version `1` |
| 5 | Kind: `1` video, `2` audio |
| 6 | Independent frame flag (IDR or JPEG); audio sets it too |
| 7 | Reserved, zero |
| 8–15 | Session-wide media packet sequence, big-endian u64 |
| 16–23 | Window ID, or zero for audio, big-endian u64 |
| 24–31 | Per-window encoded-frame sequence, big-endian u64 |
| 32–35 | Full media payload size, big-endian u32 |
| 36–37 | Fragment index, big-endian u16 |
| 38–39 | Fragment count, big-endian u16 |
| 40–41 | Fragment stride, big-endian u16 |
| 42–47 | Reserved, zero |

The assembled payload is the unchanged binary LWFA frame/audio packet.
Packet IDs identify transmission attempts, not decoder timestamps. Video frame
sequences are assigned **before** per-client fan-out, so a frame skipped for a
slow viewer leaves a detectable reference gap. Datagram payloads are at most
1200 bytes and never exceed the negotiated WebTransport datagram limit.

## Loss, deadlines and recovery

No media fragment is retransmitted, and media bytes never travel on the control
stream. Audio chunks can skip missing or obsolete chunks. JPEG and IDR video
frames are self-contained and can advance past a gap. Predictive H.264/HEVC
deltas are submitted only in contiguous encoded-frame order.

The receiver allows brief reordering. Incomplete video frames and deltas held
behind a gap expire after 150 ms from their first received fragment; audio
partials expire after 60 ms. A lost reference invalidates dependent deltas.
The client requests a fresh keyframe, waits for it, and rejects late fragments
from retired frames. Deltas that overtake a fragmented recovery keyframe stay
bounded in the reassembly queue until that keyframe completes or expires.

A completely missing packet has no receiver-side fragments to time out. The
server detects its missing disposition and requests a fresh frame through the
normal, permission-checked `SetStreams` refresh path. That path also invalidates
capture for idle windows. Refresh requests are throttled to one per 500 ms per
connection and refresh its currently requested windows. They do not resend an
old frame or fragment.

Local QUIC datagram buffering is bounded to 8 KiB. The sender uses Quinn's
`send_datagram_wait` to pace into available local queue space, with a 150 ms
per-frame send deadline. That wait is for queue capacity, not acknowledgement
or retransmission of media. It prevents a keyframe burst from evicting its own
fragments through the non-waiting enqueue API.

These are **local send and reassembly deadlines**, not a synchronized end-to-end
latency guarantee. Network/kernel queues and congestion control still apply.
No forward error correction is implemented; packet loss can cause a brief pause
while a fresh keyframe arrives. Moonlight parity and lossy-WAN performance are
not certified by this implementation.

## Budgets, compatibility and resource limits

Frame/byte/audio budgets are per client. A disposition releases a packet's
budget, whether it was read or retired; it does not certify decoding/display.
A missing disposition expires after 300 ms, also releasing the budget. Late or
duplicate dispositions are harmless. Neither missing media nor its telemetry
closes an otherwise healthy control session.

QUIC RTT feeds the rolling-baseline delay estimate. The existing bitrate
controller and media backpressure remain active. Changing transport does not
remove encoder quality, chroma subsampling or browser scaling effects.

Bounds include 8 registered sessions across transports, 16 QUIC handshake/session
tasks, 4 MiB control packets, 32 MiB media payloads, 32 simultaneous partial
packets and 64 MiB aggregate receiver reassembly storage. Receiver window
tracking is bounded to 128 entries; evicting an old entry requires a fresh
independent frame if it becomes active again. A 256-entry retirement cache
suppresses late fragments. Control writes/opening handshakes have 5-second
deadlines; QUIC idle timeout is 15 seconds.

The new shell also understands v1 engines with reliable per-window streams.
An old shell that cannot recognize v2 discovery keeps its WebSocket compatibility
path. Missing/unreadable discovery or unsupported WebTransport uses WebSocket.
An advertised QUIC endpoint failing does **not** silently fall back to TCP:
check UDP reachability, certificate validity/trust and browser support.
Cross-origin discovery needs CORS or a same-origin proxy. Bulk file uploads
continue using their existing reliable WebSocket channels.

## Verification and diagnostics

Session → Connection → Transport shows `WebTransport (QUIC datagrams)` for v2,
`WebTransport (QUIC streams)` for v1, or `WebSocket (TCP)` for compatibility.
Browser console reports the adapter too. Engine logs identify QUIC connections
and budget changes. Never include credential-bearing URLs in diagnostic reports.

```sh
pnpm exec vitest run packages/shell/test/mediaDatagrams.test.ts packages/shell/test/transport.test.ts
pnpm run typecheck
cargo test -p lwfa-engine shell::
```

Tests cover loss of fragments/whole frames, duplicate and reordered fragments,
reference-chain recovery, deltas overtaking IDRs, audio/window independence,
malformed metadata, memory limits and per-client fan-out sequence gaps. The
native test uses actual pinned QUIC datagrams, fragmentation, receipt expiry,
reliable control and eviction cleanup. Browser injection additionally exercises
actual H.264 decode after dropping an IDR fragment and a whole predictive frame.

The [WebTransport specification](https://www.w3.org/TR/webtransport/) defines
unreliable datagrams and the `requireUnreliable` option. The application's
fragmentation, deadlines and codec recovery above are LWFA protocol behavior.

## Connection troubleshooting

Open the HTTPS shell page, not the UDP session endpoint, and enter the account
password in the login field. The `token` session query parameter carries that
password; do not paste session URLs into logs or bug reports.

For Chromium `ERR_METHOD_NOT_SUPPORTED`, first test with HTTP/SOCKS browser and
system proxies bypassed for the engine hostname. WebTransport needs a direct
connection; a proxy application's own DIRECT routing rule can still leave the
browser configured to use an HTTP proxy. Keep the underlying VPN active when
it supplies connectivity to the engine. This error can also indicate HTTP/3
WebTransport negotiation failure, so proxy bypass alone is not a diagnosis.
For timeouts, check reachability of the advertised **UDP** port and certificate
validity. Successful HTTPS page loading only verifies the separate TCP listener.
