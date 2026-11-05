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

A session first authenticates `/session?token=…&client=…&device=…` using the same
owner/account lookup as WebSocket. A client opens exactly one bidirectional
control stream and writes its version preface. Control packets have a four-byte
big-endian length and a one-byte kind:

- `0`: UTF-8 JSON `ToEngine` message.
- `1`: eight-byte big-endian media sequence acknowledgement.
- `2`: one-byte transport version, currently `1` (the opening preface).

Server control packets are length-prefixed UTF-8 JSON `ToShell` messages.
The server opens independent unidirectional streams for each window and audio.
Each starts with one byte (`1` video, `2` audio), followed by length-prefixed
packets containing an eight-byte big-endian sequence and the unchanged binary
LWFA video/audio packet. Media sequences are session-wide, not codec timestamps.

Frames remain reliable and ordered **within each window**. This preserves
predictive codec references. A window's lost packet does not cause stream
head-of-line blocking in another window, audio, or control. All streams still
share the QUIC connection's congestion controller and available link capacity.
This implementation does not use datagrams, cancel stale predicted frames, or
remove the retransmission dependency within a window. Doing that requires
explicit frame dependency/recovery handling. It does not promise Moonlight
latency or quality merely by changing protocols.

## Queues, recovery and limits

The existing per-client frame/byte and audio budgets remain in force. A media
packet counts until the browser has read it and acknowledged its sequence;
merely copying into QUIC's send buffer does not release the budget. The server
tracks byte counts itself and rejects unknown/duplicate acknowledgements.
The acknowledgement confirms reading, not successful decoding or display.

QUIC RTT samples feed the existing rolling-baseline delay estimate. Browser
media-read acknowledgements supply backpressure; no WebSocket ping through the
HTTPS proxy is used to estimate the QUIC path. The existing bitrate controller
still chooses the encoder budget. Encoder quality, chroma subsampling, browser
scaling and that controller can still affect image quality.

Resource bounds are 8 registered sessions across both transports, 16 concurrent
QUIC handshake/session tasks, 128 media lanes per session lifetime, 4 MiB control
packets, 32 MiB media payloads, and 5-second media acknowledgement/write deadlines.
The opening handshake/control stream also has a 5-second deadline. A failed or
stalled stream closes its session, releases held input via normal disconnect
handling, and lets the existing shell reconnect logic re-establish the session
and codec state. Exceeding the lane lifetime bound also reconnects; a later
implementation can retire closed-window lanes without that reconnect.

Missing/unsupported discovery or an unsupported browser uses WebSocket. A
configured QUIC endpoint failing does **not** silently fall back to TCP: check
UDP reachability, certificate validity/trust, and browser support. Cross-origin
engines need readable discovery (CORS or same-origin proxy) for QUIC; otherwise
they keep their existing WebSocket behavior.

## Verification and diagnostics

Session → Connection → Transport shows the actual selected adapter. Browser
console also reports `WebTransport / QUIC (UDP)` or the legacy transport. Engine
logs identify QUIC sessions and budget changes. Do not include credential-bearing
request URLs in diagnostic reports.

```sh
pnpm exec vitest run packages/shell/test/transport.test.ts packages/shell/test/connection.test.ts
pnpm run typecheck
cargo test -p lwfa-engine shell::webtransport::tests
```

The Rust integration test uses real loopback QUIC with certificate pinning and
checks control/media delivery, acknowledgement accounting, eviction and cleanup.
Frontend tests cover fragmented/coalesced framing, size limits, independent
media streams, acknowledgements, and explicit compatibility/failure behavior.
