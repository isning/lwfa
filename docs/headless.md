# Headless sessions

The headless backend runs a real Wayland compositor without a host Wayland/X11
connection, local window, or DRM/KMS display ownership. It uses Smithay's
EGLDevice and GLES renderer. Each window is captured and streamed separately;
the browser continues to compose the session.

Nested mode remains the default. `[window].preview = false` only hides the
nested preview; it does not select headless mode.

## Configuration

```sh
LWFA_BACKEND=headless cargo run -p lwfa-engine
```

Alternatively, add this to your user configuration:

```toml
[backend]
mode = "headless"
width = 1280
height = 800
# render_node = "/dev/dri/renderD128"
```

The primary browser can change the virtual output size. With no browser the
engine keeps its Wayland clients alive, drives frame callbacks, and uses the
existing safe layout and background throttling. Disconnecting a browser does
not terminate applications. Host clipboard integration is disabled in headless
mode; the session/browser clipboard still works. XWayland remains optional and
starts against the virtual output when enabled.

Use a private, writable `XDG_RUNTIME_DIR` with mode 0700. Applications must
connect to the engine's advertised Wayland socket rather than the host socket;
applications launched by the engine already receive its socket environment.
Build the browser shell as described in [running.md](running.md), and configure
authentication and network exposure as usual.

## Driver requirements

An EGL implementation must support device enumeration, EGL platform devices,
and a GLES context without a native window. Hardware devices are tried first,
then software devices. `render_node` restricts selection to a matching device
and does not silently fall back to another GPU. The process needs permission to
use that render node; it does not need a physical monitor or DRM master.

Mesa software rendering can support GPU-less hosts, with greater CPU cost.
Encoding retains the existing hardware/software fallback behavior. This feature
has been verified with Mesa software GLES and JPEG streaming; NVIDIA/NVENC and
headless XWayland have not been runtime-verified. Audio still needs its configured
audio service, and virtual gamepads still need uinput permission. Neither is
provided by the headless backend.

## Verification

Normal engine tests do not require an EGL driver. The explicit driver test does:

```sh
env -u DISPLAY -u WAYLAND_DISPLAY cargo test -p lwfa-engine \
  headless::tests::offscreen_renderer -- --ignored
```

The end-to-end test needs Node with type stripping and built-in WebSocket,
a C compiler, wayland-scanner, Wayland client headers, wayland-protocols, and
ffmpeg. Build the small real wl_shm fixture into a local artifact directory:

```sh
mkdir -p target/headless-test
protocols=$(pkg-config --variable=pkgdatadir wayland-protocols)
wayland-scanner client-header "$protocols/stable/xdg-shell/xdg-shell.xml" \
  target/headless-test/xdg-shell-client-protocol.h
wayland-scanner private-code "$protocols/stable/xdg-shell/xdg-shell.xml" \
  target/headless-test/xdg-shell-protocol.c
cc -Wall -Wextra -Werror -I target/headless-test \
  scripts/fixtures/headless-shm.c target/headless-test/xdg-shell-protocol.c \
  $(pkg-config --cflags --libs wayland-client) -o target/headless-test/headless-shm
cargo build -p lwfa-engine
LWFA_TEST_ENGINE="$PWD/target/debug/lwfa-engine" \
LWFA_TEST_SHM_CLIENT="$PWD/target/headless-test/headless-shm" \
LWFA_TEST_OUTPUT="$PWD/target/headless-test" \
node --experimental-strip-types scripts/e2e-headless.mjs
```

The test starts an isolated engine with host display variables removed. It
checks application frame callbacks before any browser connects, viewport
resizing, decoded JPEG pixels, application survival across a 46-second browser
disconnect, and reconnection to the same window. It retains logs and images in
a new artifact directory. `LWFA_TEST_DISCONNECT_MS` can shorten the interval for
iteration; values below 45000 do not cover the session grace period. This is a
protocol client test, not browser WebCodecs or hardware encoder validation.

See [color management and HDR](color-management.md) for named source spaces,
Main10/PQ streaming, viewer requirements and color-specific verification.
