//! Output state shared by the nested and headless backends.

use crate::state::Lwfa;
use smithay::output::{Mode, Output, PhysicalProperties, Subpixel};
use smithay::utils::{Physical, Size, Transform};
use std::rc::Rc;

const REFRESH: i32 = 60_000;

pub fn init(
    state: &mut Lwfa,
    name: &str,
    model: &str,
    size: Size<i32, Physical>,
    transform: Transform,
) -> Output {
    let output = Output::new(
        name.into(),
        PhysicalProperties {
            size: (0, 0).into(),
            subpixel: Subpixel::Unknown,
            make: "lwfa".into(),
            model: model.into(),
        },
    );
    output.create_global::<Lwfa>(&state.display_handle);
    let mode = Mode {
        size,
        refresh: REFRESH,
    };
    output.change_current_state(Some(mode), Some(transform), None, Some((0, 0).into()));
    output.set_preferred(mode);
    state.space.map_output(&output, (0, 0));
    state.layout.set_output_size(size.to_logical(1));
    state.resize_output = Some(Rc::new({
        let output = output.clone();
        move |state, width, height, scale| resize(state, &output, width, height, scale)
    }));
    output
}

pub fn resize(state: &mut Lwfa, output: &Output, width: i32, height: i32, scale: f64) {
    let size: Size<i32, Physical> = (width, height).into();
    let mode = Mode {
        size,
        refresh: REFRESH,
    };
    output.change_current_state(Some(mode), None, None, None);
    output.set_preferred(mode);
    let logical = size.to_logical(1);
    state.layout.set_output_size(logical);
    state.send_to_shell(lwfa_proto::ToShell::OutputChanged {
        output: lwfa_proto::Output {
            width: logical.w,
            height: logical.h,
            scale,
        },
    });
    if state.layout.mode() == crate::layout::Mode::Safe {
        state.apply_safe_mode();
    }
    state.apply_layout();
}

/// Advance clients and reclaim protocol state even when nobody is watching.
pub fn finish_frame(state: &mut Lwfa, output: &Output) {
    state.space.elements().for_each(|window| {
        window.send_frame(
            output,
            state.start_time.elapsed(),
            state.frame_throttle(window),
            |_, _| Some(output.clone()),
        );
    });
    state.space.refresh();
    state.popups.cleanup();
    if let Err(err) = state.display_handle.flush_clients() {
        tracing::warn!("could not flush client events: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_output_and_viewport_resize_share_one_output_state() {
        let mut event_loop = smithay::reexports::calloop::EventLoop::try_new().unwrap();
        let display = smithay::reexports::wayland_server::Display::new().unwrap();
        let mut state = Lwfa::without_listener(&mut event_loop, display);
        let output = init(
            &mut state,
            "test-headless",
            "headless",
            (1280, 800).into(),
            Transform::Normal,
        );
        assert_eq!(output.current_mode().unwrap().size, (1280, 800).into());
        assert_eq!(state.layout.output_size(), (1280, 800).into());
        let resize = state.resize_output.clone().unwrap();
        resize(&mut state, 800, 600, 2.0);
        assert_eq!(output.current_mode().unwrap().size, (800, 600).into());
        assert_eq!(output.preferred_mode().unwrap().size, (800, 600).into());
        assert_eq!(state.layout.output_size(), (800, 600).into());
        assert_eq!(output.current_transform(), Transform::Normal);
    }
}
