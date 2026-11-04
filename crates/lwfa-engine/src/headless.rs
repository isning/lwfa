//! Independent offscreen EGL/GLES backend: no host window or display server.

use crate::state::{CalloopData, Lwfa};
use smithay::backend::egl::{EGLContext, EGLDevice, EGLDisplay};
use smithay::backend::renderer::Renderer;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::reexports::calloop::EventLoop;
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay::utils::Transform;
use std::path::Path;
use std::time::Duration;

/// Create a renderer without touching a host Wayland/X11 connection.
fn renderer(render_node: Option<&Path>) -> Result<GlesRenderer, Box<dyn std::error::Error>> {
    let mut devices: Vec<_> = EGLDevice::enumerate()
        .map_err(|err| format!("cannot enumerate headless EGL devices: {err}; check the EGL driver and device enumeration extensions"))?
        .collect();
    // Prefer hardware, but let Mesa's software device support GPU-less hosts.
    devices.sort_by_key(EGLDevice::is_software);
    let mut errors = Vec::new();
    for device in devices {
        let node = device.render_device_path().ok();
        if let Some(requested) = render_node
            && !node
                .as_deref()
                .is_some_and(|node| same_device(node, requested))
        {
            continue;
        }
        let description = node
            .map(|node| node.display().to_string())
            .unwrap_or_else(|| {
                if device.is_software() {
                    "software EGL device".into()
                } else {
                    "EGL device".into()
                }
            });
        match device_renderer(device) {
            Ok(renderer) => {
                tracing::info!("headless renderer: {description}");
                return Ok(renderer);
            }
            Err(err) => errors.push(format!("{description}: {err}")),
        }
    }
    Err(format!(
        "no usable headless EGL/GLES device{}; check EGL_EXT_platform_device, surfaceless GLES support and render-node permissions. {}",
        render_node.map(|path| format!(" matching {}", path.display())).unwrap_or_default(),
        errors.join("; "),
    ).into())
}

fn same_device(left: &Path, right: &Path) -> bool {
    left == right
        || std::fs::canonicalize(left)
            .ok()
            .zip(std::fs::canonicalize(right).ok())
            .is_some_and(|(left, right)| left == right)
}

#[allow(unsafe_code)]
fn device_renderer(device: EGLDevice) -> Result<GlesRenderer, Box<dyn std::error::Error>> {
    // SAFETY: Smithay alone owns this EGL display, and the freshly created
    // context is moved into a renderer used only on the compositor thread.
    let display = unsafe { EGLDisplay::new(device)? };
    let context = EGLContext::new(&display)?;
    Ok(unsafe { GlesRenderer::new(context)? })
}

pub fn init(
    event_loop: &mut EventLoop<CalloopData>,
    state: &mut Lwfa,
) -> Result<(), Box<dyn std::error::Error>> {
    let size = state.config.backend.size()?;
    let mut renderer = renderer(state.config.backend.render_node.as_deref())?;
    let output = crate::output::init(state, "lwfa-headless", "headless", size, Transform::Normal);
    let tick = state.config.render.tick().max(Duration::from_millis(1));
    event_loop
        .handle()
        .insert_source(Timer::immediate(), move |_, _, state| {
            state.tick_animations();
            state.stream_frames(&mut renderer);
            if let Some(dir) = std::env::var_os("LWFA_CAPTURE_DUMP") {
                state.dump_captures(&mut renderer, Path::new(&dir));
            }
            if let Err(err) = renderer.cleanup_texture_cache() {
                tracing::warn!("could not free finished GPU resources: {err}");
            }
            crate::output::finish_frame(state, &output);
            TimeoutAction::ToDuration(tick)
        })?;
    tracing::info!(
        "headless output is {}x{}; host preview and host clipboard are disabled",
        size.w,
        size.h
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use smithay::backend::allocator::Fourcc;
    use smithay::backend::renderer::gles::GlesTexture;
    use smithay::backend::renderer::{Bind, Color32F, ExportMem, Frame, Offscreen};
    use smithay::utils::Rectangle;

    #[test]
    #[ignore = "requires an EGL device and a GLES driver; run without DISPLAY/WAYLAND_DISPLAY"]
    fn offscreen_renderer_produces_pixels_without_a_host_window() {
        let mut renderer = renderer(None).expect("offscreen EGL/GLES renderer");
        let mut texture: GlesTexture = renderer
            .create_buffer(Fourcc::Abgr8888, (16, 16).into())
            .unwrap();
        let mut target = renderer.bind(&mut texture).unwrap();
        let mut frame = renderer
            .render(&mut target, (16, 16).into(), Transform::Normal)
            .unwrap();
        frame
            .clear(
                Color32F::new(1.0, 0.0, 0.0, 1.0),
                &[Rectangle::from_size((16, 16).into())],
            )
            .unwrap();
        frame.finish().unwrap().wait().unwrap();
        let mapping = renderer
            .copy_framebuffer(
                &target,
                Rectangle::from_size((16, 16).into()),
                Fourcc::Abgr8888,
            )
            .unwrap();
        drop(target);
        let pixels = renderer.map_texture(&mapping).unwrap();
        assert_eq!(pixels.len(), 16 * 16 * 4);
        assert!(
            pixels
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| *pixel == [255, 0, 0, 255])
        );
    }
}
