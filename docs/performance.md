# Performance diagnostics

Open **Session → Performance** and enable **Record diagnostics**. Recording is
local to this browser, off by default, and independent of codec and presentation
preferences. Closing the panel keeps recording; disabling the switch pauses it.

The panel keeps up to five minutes / 300 samples. Choose a one- or five-minute
view, P95 or maximum, and Processing, Network, Frame intervals or Audio. Hover the
chart or use its keyboard-accessible sample slider to inspect values. Legend
buttons toggle individual curves. Expand Stage breakdown for P50/P95/max/count,
or the counter section for drops, replacements and encoder opens. Clear resets
this tab's history; Export JSON saves the current samples and measurement scope.

## What the numbers mean

All stage durations use the clock local to their producer. Client/server clocks
are never subtracted. Stage distributions describe independent observations and
must not be added together to manufacture an end-to-end latency.

| Measurement | Starts / ends | Important limit |
| --- | --- | --- |
| Control round trip | Browser diagnostic request → matching reply | Includes control transport and compositor processing/queueing |
| Transport round trip | QUIC's RTT or WebSocket heartbeat RTT | Per asking connection; not one-way delay |
| Server control queue | Parsed session message → compositor handling | All measured control messages, not just input |
| Server input dispatch | Compositor's input handler call | Ends before the application processes input |
| Capture call / GPU wait | One compositor capture call | CPU elapsed time, including blocking GPU work; also samples damage-only/pipelined calls |
| Server capture interval | Successive captures of each window | Includes idle applications and intentional pacing |
| Encoder queue | Job submission → worker dequeue/control application | Only admitted frames |
| Encode | Encode call → encoded result | Includes session creation and fallback work |
| Encoder session open | Session construction call | A substage of encode; never add it to encode |
| Server send queue | Encoded frame fan-out → transport dequeue | Aggregates viewers/windows on this process |
| QUIC fragment enqueue | All fragments of one packet handed to QUIC, or failure | Includes local pacing; does not prove network delivery |
| WebSocket write → kernel flush | First queued media write → successful socket flush | Kernel acceptance is not client receipt |
| Fragment assembly | First received fragment → complete media packet | Excludes packets never observed at all |
| Reorder wait | Packet complete → safe release to decoder | Shows waiting for predictive references |
| Decode submit → output | Compressed video submission → decoder output callback | Includes decoder scheduling; JPEG includes bitmap decode |
| VideoFrame → bitmap | Conversion request → bitmap ready | Only applicable to the SDR bitmap path |
| Drawable → renderer wait | Decoded/converted drawable ready → first successful submission's renderer start | Cached redraws and failed draws do not create another latency sample |
| Canvas draw / upload / submit | Drawing starts → GPU submission / Canvas2D draw return | Not a GPU timestamp or display measurement |
| Native video write | Generated-track writer call → completion | Not the native video's display time |
| Receive → first submission | Complete frame received → first renderer/native write completed | One frame's browser-local age; cached redraws are counted separately |
| Native video callback interval | Successive requestVideoFrameCallback callbacks | Presentation cadence, not exact panel scanout |
| Browser animation interval | Successive visible-page animation callbacks | Reset when visibility changes; not a video FPS guarantee |
| Browser long task | Browser PerformanceObserver long-task duration | Browser-dependent; normally tasks over 50 ms, not a custom stall detector |
| Server audio read wait | One complete PCM capture read | Includes the normal chunk production period; not capture-to-speaker delay |
| Server Opus encode | One Opus encode call | Only present while Opus is active |
| Audio decode | Native decoder submission → output, or synchronous WASM decode | WASM module startup queue is not included |
| Audio playback buffer | Player's currently buffered samples | Local audio delay; not full microphone/app-to-speaker latency |

Frame intervals, local playback drop counts, incomplete media, dependency drops,
keyframe requests, intentional native queue replacements, server send admission
skips, failed/expired sends, receipt timeouts and encoder opens help explain
spikes. They are raw observations, not automatic burp classifications or alarms.
An idle window naturally has a long frame interval. A stale value is shown as a
dash rather than a fabricated zero. Loss-related counters are not a network
packet-loss percentage; receiver expiry and dependency recovery have different
causes from actual QUIC packet loss.

## Scope and cost

Server stages are process-wide aggregates across windows and viewers. Transport
RTT belongs to the asking connection. Browser stages belong to this tab; video
intervals are measured per window before aggregation. Audio buffer and native
playback drop counters come from the active playback implementations.

Samples update once a second. Each stage retains at most 256 observations from
the last two seconds; server values become stale after three seconds without a
report. History and exported data contain numbers, metric names and timing only:
no credentials, URLs, window titles, input content, pixels or audio samples.
The export includes the browser time origin so monotonic sample timestamps can
be mapped to wall time. Paused/background tabs may produce fewer timeline points.

Export version 2 measures frame waiting and receive-to-submission only for the
first successful submission of each new frame. Later Canvas repaints count as
cached redraws; geometry changes do not resubmit the same frame to native video.
Render-call durations still include actual repaint work. Version 1 recordings
can contain misleading multi-second frame ages when old content is redrawn.
Reset/visibility/connection boundaries invalidate timing from asynchronous work
that began before the boundary.

Server instrumentation is opt-in and expires five seconds after the last probe.
A connection may request at most two snapshots per second. Timers, long-task
observers and video callbacks are stopped when recording/presentation ends.
Recording adds bounded bookkeeping and periodic small control messages; it is
not a zero-overhead GPU profiler.

The new control messages are sent only after `/capabilities.json` advertises
`performanceStats: 1`. Older servers continue to work with browser-only metrics.
Existing media headers, encoding and transport behavior are unchanged.

Application rendering time, exact one-way network time, GPU execution timestamps,
canvas scanout and physical input-to-photon latency are not directly measured.
Those require additional causal instrumentation or external display measurement.

## Verification

Run `pnpm test`, `pnpm typecheck`, `cargo test --workspace` (after TypeScript parity
fixtures), and the production build. Recorder tests cover bounds, stale samples,
server counter baselines/restarts, clear/pause, frame timing propagation and
protocol validation. Connection tests cover old-server capability gating and
cancelled recording probes. Native video ownership/replacement tests remain in
`native-hdr.test.ts`.

On a disposable session, run a continuously animated native app, enable recording,
then switch between Canvas and Native video. Processing should show the matching
render path; native-video callbacks should appear only on native playback. A
WebTransport session should populate assembly/enqueue and transport RTT, while a
WebSocket session uses its flush timing. Enable audio to inspect decode, buffer
and underruns. Export, pause and clear should work without changing the stream.

Relevant browser semantics:
[WebCodecs](https://www.w3.org/TR/webcodecs/),
[video frame callbacks](https://wicg.github.io/video-rvfc/), and
[Long Tasks](https://www.w3.org/TR/longtasks-1/).
