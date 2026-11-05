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
- sRGB, BT.1886, extended linear, ST2084/PQ and HLG transfer functions;
- Windows scRGB descriptions: sRGB primaries, signed extended linear values,
  1.0 = 80 cd/m², 203 cd/m² reference white;
- custom source luminances and mastering display primaries/luminances, plus
  maximum content/frame-average light levels. Mastering volumes must fit the
  named source volume; unsupported combinations fail the image description.
  Duplicate properties and invalid luminance ranges are protocol errors.

Descriptions are double-buffered with surface commits, including synchronized
subsurfaces. Destroying an image description does not remove the copied surface
state. Untagged surfaces retain the legacy sRGB interpretation. Description-only
changes cause a fresh capture and a new encoder keyframe. Output and preferred
surface descriptions change when the shared rendition switches SDR/HDR.

SHM formats come from the actual renderer, including 10-bit and floating-point
RGB when supported. Linux DMA-BUF advertises only the renderer's RGB
fourcc/modifier pairs. Imports are validated by that renderer before acceptance;
feedback identifies its device. YUV formats are deliberately excluded until
color-representation handling exists. An import queue bounds retained descriptors.

The DRM syncobj protocol is available only when the render device supports
syncobj eventfd. Acquire timeline points block surface transactions; client
buffers remain referenced until GPU read fences complete, so release timeline
points cannot permit premature reuse. Both offscreen capture and nested preview
retain those references. No DRM output or KMS ownership is required.

ICC profiles, arbitrary **source** chromaticities, color-representation-v1,
XWayland HDR, physical monitor calibration and EDID handling remain outside this
implementation. Unimplemented features are not advertised.

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

HDR composition remains float linear RGB. A GLES shader converts it directly
to limited-range BT.2020 non-constant-luminance P010, packed as normalized RGBA16
words. Supported NVIDIA systems register that texture with CUDA and copy its
luma/chroma planes into a CUDA P010 pool consumed directly by Main10 NVENC.
There is no CPU pixel readback or color conversion on this path. An explicit
`stream.gpu_direct = false` disables interop; unsupported interop falls back to
reading the packed words. Without normalized16 rendering, the portable RGB10
readback/conversion remains available. Normalized16 is an internal GL format,
not a fabricated or advertised DRM fourcc.

P010 chroma is averaged over 2×2 blocks and reconstructed at pixel centers.
FFmpeg's `hevc_metadata` bitstream filter signals centered chroma in HEVC VUI;
setting the codec option alone is ignored by some NVENC SDK builds. This changes
metadata without re-encoding or reading GPU pixels.

Every HDR IDR contains HDR10 mastering-display and content-light prefix SEI,
independent of the NVENC SDK version. Metadata describes the **composited**
virtual BT.2020/D65 display (0–10000 cd/m²), not one application's mastering
display. MaxCLL is a conservative bound derived from source descriptions and
white anchoring, capped at 10000; unknown MaxFALL is zero. Description changes
invalidate capture and rebuild the encoder before a new IDR.

SDR video explicitly signals BT.601 matrix, BT.709 primaries and sRGB transfer.
Encoder creation/failure or session exhaustion falls back to **tone-mapped SDR
JPEG**, including when the captured HDR frame is CUDA-resident. High-resolution
frame-rate/latency targets still require workload-specific measurements.

## Viewers and compatibility

The existing shared rendition is preserved: every active, declared video viewer
must advertise `hevcHdr` before HDR is selected. A viewer without HDR support
forces shared SDR; HDR can return when it leaves. Separate SDR/HDR renditions per
viewer are not produced. In-flight HDR frames are not fanned out to viewers that
have not opted in.

The browser requires an HDR display (`dynamic-range: high`), HEVC Main10/PQ decode,
and WebGPU `rgba16float` canvas presentation with extended tone mapping. It probes
these capabilities, checks actual decoder configurations, and renegotiates after
display changes or operational failures. HDR VideoFrames go to WebGPU external textures and an extended Display-P3
float canvas. The decoder intentionally overrides its frame container to linear
BT.709 while keeping the real BT.2020 limited-range YUV matrix. Importing into
sRGB then applying its inverse transfer recovers the PQ RGB code values; our
shader applies PQ EOTF, BT.2020 → P3 conversion and extended sRGB encoding at
203-nit white. This avoids browser-dependent PQ import tone mapping. These
internal frames must never enter ordinary image/Canvas2D paths.

Capability negotiation reads back both a 1000-nit gray and saturated blue from
the actual pipeline. It compares all RGB components with references derived
from quantized YUV input. Browsers whose external importer loses precision or
misinterprets the matrix instead copy the original 10-bit YUV planes, upload
three `r16uint` textures and perform YUV/PQ/P3 conversion in WGSL. This fallback
copies raw plane bytes on the browser CPU; it never converts through RGB8.
The queue retains one active copy plus one latest frame, closes replaced frames,
and owns a clone so decoder frames may be closed immediately. Unsupported plane
access or operational failures downgrade to SDR. `hdrPresentationPath()` reports
which verified path is active. No SDR ImageBitmap intermediate is used. Ordinary SDR/JPEG frames keep the 2D canvas path.

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
cargo test -p lwfa-engine packed_planes_preserve_pq -- --ignored
# Requires NVIDIA GLES, libcuda and NVENC; asserts that fallback did not occur:
cargo test -p lwfa-engine gpu_p010_matches_readback -- --ignored
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
# Repeat with LWFA_TEST_SOURCE_SPACE=hlg or scrgb for native source variants.
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

### GPU client and browser probes

Compile the same C fixture with `LWFA_DMA_TEST` and generated linux-dmabuf client
bindings, linking `egl glesv2`. Add `LWFA_EXPLICIT_TEST`, generated
linux-drm-syncobj client bindings and `libdrm` to test explicit synchronization.
The producer commits before filling its texture, delays 30 ms, then signals the
acquire point. Reuse checks the previous release timeline. Run the same
`e2e-headless.mjs` harness with this fixture and `LWFA_TEST_GPU_DIRECT=1`.
Driver selection must match the producer/compositor; on NixOS ensure the selected
NVIDIA EGL vendor and `/run/opengl-driver/lib` are visible to the test process.

Serve `scripts/fixtures/hdr-browser.html` through the shell's Vite server (the
fixture imports `/src/lib/hdr.ts`) and invoke `window.runHdrProbe()`. This uses
real WebGPU and 10-bit planar VideoFrames, checks float samples at 203/1000/4000
cd/m² and verifies downgrade. It **emulates** HDR display detection, so passing
proves numeric presentation, not physical monitor appearance. A real HDR display,
OS/browser HDR configuration and supported Main10 decoder remain required for
user-visible HDR. The probe rejects lossy external imports in favor of exact plane upload, but
production acceptance must still include the target browser's actual hardware
decoder, which may expose different frame formats and resource behavior.
