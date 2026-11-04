# Color management and HDR

LWFA accepts named Wayland surface color descriptions and converts them before
streaming. With compatible viewers it sends HEVC Main10 in BT.2020/PQ; otherwise
it maps the same application content to SDR. The browser still composes separate
window streams. No physical display or KMS color pipeline is required.

## Supported sources

The `wp_color_manager_v1` global is version 1. It is advertised only after the
actual GLES backend compiles the color shader and binds and renders through float and 10-bit
targets, then verifies PQ readback precision. The advertised parametric descriptions support:

- sRGB/BT.709, Display-P3, and BT.2020 primaries, with D65 white;
- sRGB, BT.1886, and ST2084/PQ transfer functions;
- optional maximum content/frame-average light levels within the default
  mastering range. Custom mastering luminances/primaries are not advertised.

Descriptions are double-buffered with surface commits, including synchronized
subsurfaces. Destroying an image description does not remove the copied surface
state. Untagged surfaces retain the legacy sRGB interpretation. Description-only
changes cause a fresh capture and a new encoder keyframe. Output and preferred
surface descriptions change when the shared rendition switches SDR/HDR.

SHM formats come from the actual renderer. On a capable GLES device this includes
10-bit and floating-point RGB formats. This change does not add Linux DMA-BUF
protocol support to LWFA; GPU applications requiring that protocol need additional
work. ICC profiles, arbitrary chromaticities, HLG, color-representation-v1,
XWayland HDR, monitor calibration and EDID handling are outside this version.
Unimplemented protocol features are not advertised and their requests are refused.

## Rendering and encoding

For a managed surface tree, GLES unpremultiplies source RGB, decodes its transfer
function, converts primaries in linear light, and anchors diffuse white to a
common working white. Surfaces are then composited into a float RGBA target.
The final resolve converts the complete composition to sRGB or BT.2020/PQ.
The nested local preview always resolves to SDR after linear-light composition.
An entirely untagged SDR capture keeps the existing capture/CUDA path.

SDR output uses a monotonic luminance shoulder and clips remaining out-of-gamut
RGB into sRGB. This is a practical perceptual rendering policy, not ICC proofing
or a promise to preserve every saturated color. An HDR window can therefore look
different on an SDR viewer, as highlights must fit the smaller display range.

HDR resolve writes a 10-bit RGB target. Readback is converted to limited-range
BT.2020 non-constant-luminance P010 and fed to `hevc_nvenc` with Main10 and
BT.2020/PQ signaling. SDR video explicitly signals its BT.601 matrix,
BT.709 primaries and sRGB transfer. Encoder creation/failure or a session limit falls back to
**tone-mapped SDR JPEG**, rather than sending PQ values as ordinary JPEG.

This first HDR path performs CPU readback/conversion and a hardware encoder
upload. It is not zero-copy HDR. The existing SDR CUDA path is retained. No
high-resolution HDR frame-rate or latency guarantee has been established.

## Viewers and compatibility

The existing shared rendition is preserved: every active, declared video viewer
must advertise `hevcHdr` before HDR is selected. A viewer without HDR support
forces shared SDR; HDR can return when it leaves. Separate SDR/HDR renditions per
viewer are not produced. In-flight HDR frames are not fanned out to viewers that
have not opted in.

The browser requires an HDR display (`dynamic-range: high`), HEVC Main10/PQ decode,
and WebGPU `rgba16float` canvas presentation with extended tone mapping. It probes
these capabilities, checks actual decoder configurations, and renegotiates after
display changes or operational failures. HDR VideoFrames go straight to WebGPU
external textures and an extended Display-P3 float canvas; no SDR ImageBitmap
intermediate is used. Ordinary SDR/JPEG frames keep the 2D canvas path.

HDR is selected through the Auto codec preference. Pinning HEVC or H.264 selects
the existing SDR formats. HTTPS/secure-context requirements still apply.

Protocol v2 and existing frame headers are unchanged. `hevcHdr` and frame format
3 are additive and require explicit opt-in. A new browser first probes the
engine-relative `/capabilities.json` endpoint before sending the new codec to a
strict older engine; a missing, invalid or timed-out response keeps SDR. Old
clients continue requesting existing codecs and receive SDR. If a reverse proxy
only forwards selected engine routes, forward this endpoint too; omission safely
disables HDR.

## Verification

Normal Rust and TypeScript suites cover color transfer math, shared negotiation,
frame lifetime, and old-engine feature probing. Explicit GLES and NVENC tests
require drivers and are ignored in the ordinary Rust suite:

```sh
env -u DISPLAY -u WAYLAND_DISPLAY cargo test -p lwfa-engine color_render::tests -- --ignored
cargo test -p lwfa-engine source_color_changes_force_a_new_hdr_keyframe -- --ignored
```

For real Wayland/stream checks, build the [headless fixture](headless.md#verification)
with the additional color-management protocol and compile flag:

```sh
protocols=$(pkg-config --variable=pkgdatadir wayland-protocols)
wayland-scanner client-header "$protocols/staging/color-management/color-management-v1.xml" \
  target/headless-test/color-management-v1-client-protocol.h
wayland-scanner private-code "$protocols/staging/color-management/color-management-v1.xml" \
  target/headless-test/color-management-v1-protocol.c
cc -Wall -Wextra -Werror -DLWFA_COLOR_TEST -I target/headless-test \
  scripts/fixtures/headless-shm.c target/headless-test/xdg-shell-protocol.c \
  target/headless-test/color-management-v1-protocol.c \
  $(pkg-config --cflags --libs wayland-client) -o target/headless-test/color-shm
cargo build -p lwfa-engine
LWFA_TEST_ENGINE="$PWD/target/debug/lwfa-engine" \
LWFA_TEST_SHM_CLIENT="$PWD/target/headless-test/color-shm" \
LWFA_TEST_COLOR=1 LWFA_TEST_HDR=1 \
node --experimental-strip-types scripts/e2e-headless.mjs
```

This uses a real 10-bit SHM/PQ client, validates protocol errors and image-description
copy semantics, inspects Main10/VUI metadata with ffprobe, checks decoded pixels,
exercises a mixed SDR/HDR viewer transition, then disconnects for 46 seconds and
reconnects. Add `LWFA_TEST_HDR_FALLBACK=1` to force the encoder-session limit to
zero and check tone-mapped JPEG instead. Omit `LWFA_TEST_HDR` to check the ordinary
SDR-viewer conversion. ffmpeg/ffprobe and a working Main10 NVENC encoder are needed
for the native HDR variant. `LWFA_TEST_DISCONNECT_MS=500` shortens iteration but
does not cover the session grace period.

Software Mesa GLES plus real NVENC has been used for precision and bitstream
checks. Physical HDR monitor appearance and browser WebGPU output still need
runtime validation. The current T3 browser cannot start on this host because its
required shared libraries are missing; unit tests do not replace that validation.

## References

- [Wayland color management](https://wayland.freedesktop.org/docs/book/Color.html)
- [Protocol XML](https://github.com/wayland-mirror/wayland-protocols/blob/main/staging/color-management/color-management-v1.xml)
- [Normative transfer functions](https://github.com/wayland-mirror/wayland-protocols/blob/main/staging/color-management/appendix.md)
- [WebCodecs color spaces](https://www.w3.org/TR/webcodecs/#video-color-space)
- [WebGPU external textures and HDR canvas](https://www.w3.org/TR/webgpu/)
