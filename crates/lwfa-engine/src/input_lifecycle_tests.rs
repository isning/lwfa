//! Exercise remote input against the actual compositor and Smithay seat.

use super::*;
use lwfa_proto::{Permissions, SessionMode, WindowId};
use smithay::reexports::calloop::EventLoop;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;
use wayland_client::protocol::{wl_compositor, wl_registry, wl_surface};
use wayland_client::{Connection, Dispatch, QueueHandle, delegate_noop};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

fn state() -> (EventLoop<'static, Lwfa>, Lwfa) {
    let mut event_loop = EventLoop::try_new().unwrap();
    let display = smithay::reexports::wayland_server::Display::new().unwrap();
    let mut state = Lwfa::without_listener(&mut event_loop, display);
    state.layout.set_output_size((800, 600).into());
    for id in [1, 2] {
        state.sessions.insert(
            id,
            new_session(
                Permissions {
                    mode: SessionMode::Interact,
                    allowed_apps: None,
                },
                if id == 1 { "owner" } else { "guest" }.into(),
                "test".into(),
                format!("client-{id}"),
            ),
        );
    }
    (event_loop, state)
}

fn message(state: &mut Lwfa, session: u64, message: ToEngine) {
    handle_shell_event(state, ShellEvent::Message(session, message));
}

#[test]
fn disconnect_releases_the_last_mouse_button() {
    let (_event_loop, mut state) = state();
    let pointer = state.seat.get_pointer().unwrap();
    message(
        &mut state,
        2,
        ToEngine::PointerButton {
            button: 0x110,
            pressed: true,
        },
    );
    assert!(pointer.is_grabbed());
    handle_shell_event(&mut state, ShellEvent::Disconnected(2));
    assert!(
        !pointer.is_grabbed(),
        "a disconnected drag must release its grab"
    );
}

#[test]
fn disconnect_does_not_release_another_sessions_mouse_button() {
    let (_event_loop, mut state) = state();
    let pointer = state.seat.get_pointer().unwrap();
    for id in [1, 2] {
        message(
            &mut state,
            id,
            ToEngine::PointerButton {
                button: 0x110,
                pressed: true,
            },
        );
    }
    handle_shell_event(&mut state, ShellEvent::Disconnected(2));
    assert!(pointer.is_grabbed());
    message(
        &mut state,
        1,
        ToEngine::PointerButton {
            button: 0x110,
            pressed: false,
        },
    );
    assert!(!pointer.is_grabbed());
}

#[test]
fn revoking_interaction_releases_a_mouse_grab() {
    let (_event_loop, mut state) = state();
    let pointer = state.seat.get_pointer().unwrap();
    message(
        &mut state,
        2,
        ToEngine::PointerButton {
            button: 0x110,
            pressed: true,
        },
    );
    assert!(pointer.is_grabbed());
    message(
        &mut state,
        1,
        ToEngine::SetSessionMode {
            session: 2,
            mode: SessionMode::View,
        },
    );
    assert!(!pointer.is_grabbed());
}

fn local_button(state: &mut Lwfa, pressed: bool) {
    state.preview_button(smithay::input::pointer::ButtonEvent {
        button: 0x110,
        state: if pressed {
            smithay::backend::input::ButtonState::Pressed
        } else {
            smithay::backend::input::ButtonState::Released
        },
        serial: smithay::utils::SERIAL_COUNTER.next_serial(),
        time: 0,
    });
}

#[test]
fn disconnect_preserves_a_locally_held_mouse_button() {
    let (_event_loop, mut state) = state();
    let pointer = state.seat.get_pointer().unwrap();
    local_button(&mut state, true);
    message(
        &mut state,
        2,
        ToEngine::PointerButton {
            button: 0x110,
            pressed: true,
        },
    );
    handle_shell_event(&mut state, ShellEvent::Disconnected(2));
    assert!(
        pointer.is_grabbed(),
        "the physical mouse still holds the drag"
    );
    local_button(&mut state, false);
    assert!(!pointer.is_grabbed());
}

#[test]
fn local_release_preserves_a_remotely_held_mouse_button() {
    let (_event_loop, mut state) = state();
    let pointer = state.seat.get_pointer().unwrap();
    message(
        &mut state,
        2,
        ToEngine::PointerButton {
            button: 0x110,
            pressed: true,
        },
    );
    local_button(&mut state, true);
    local_button(&mut state, false);
    assert!(pointer.is_grabbed(), "the browser still holds the drag");
    message(
        &mut state,
        2,
        ToEngine::PointerButton {
            button: 0x110,
            pressed: false,
        },
    );
    assert!(!pointer.is_grabbed());
}

#[derive(Default)]
struct Client {
    compositor: Option<wl_compositor::WlCompositor>,
    shell: Option<xdg_wm_base::XdgWmBase>,
}

impl Dispatch<wl_registry::WlRegistry, ()> for Client {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            match interface.as_str() {
                "wl_compositor" => {
                    state.compositor = Some(registry.bind(name, version.min(4), qh, ()))
                }
                "xdg_wm_base" => state.shell = Some(registry.bind(name, version.min(3), qh, ())),
                _ => {}
            }
        }
    }
}

delegate_noop!(Client: ignore wl_compositor::WlCompositor);
delegate_noop!(Client: ignore wl_surface::WlSurface);
delegate_noop!(Client: ignore xdg_wm_base::XdgWmBase);
delegate_noop!(Client: ignore xdg_surface::XdgSurface);
delegate_noop!(Client: ignore xdg_toplevel::XdgToplevel);

fn window(event_loop: &mut EventLoop<'static, Lwfa>, state: &mut Lwfa) -> (Connection, WindowId) {
    let (server, client) = UnixStream::pair().unwrap();
    client.set_nonblocking(true).unwrap();
    state
        .display_handle
        .insert_client(server, Arc::new(state::ClientState::default()))
        .unwrap();
    let connection = Connection::from_socket(client).unwrap();
    let mut queue = connection.new_event_queue::<Client>();
    let qh = queue.handle();
    let _registry = connection.display().get_registry(&qh, ());
    connection.flush().unwrap();
    event_loop.dispatch(Duration::ZERO, state).unwrap();
    state.display_handle.flush_clients().unwrap();
    queue.prepare_read().unwrap().read().unwrap();
    let mut client = Client::default();
    queue.dispatch_pending(&mut client).unwrap();
    let surface = client.compositor.unwrap().create_surface(&qh, ());
    let xdg = client.shell.unwrap().get_xdg_surface(&surface, &qh, ());
    let _toplevel = xdg.get_toplevel(&qh, ());
    connection.flush().unwrap();
    event_loop.dispatch(Duration::ZERO, state).unwrap();
    let id = *state
        .layout
        .all_ids()
        .first()
        .expect("the client created a real toplevel");
    (connection, id)
}

#[test]
fn disconnect_releases_only_its_touch_contacts() {
    let (mut event_loop, mut state) = state();
    let (_client, window) = window(&mut event_loop, &mut state);
    let touch = state.seat.get_touch().unwrap();
    for session in [1, 2] {
        message(
            &mut state,
            session,
            ToEngine::TouchDown {
                window,
                id: 0,
                x: 10.0,
                y: 10.0,
                normalized: false,
            },
        );
    }
    assert!(touch.is_grabbed());
    handle_shell_event(&mut state, ShellEvent::Disconnected(2));
    assert!(
        touch.is_grabbed(),
        "the first browser still has a finger down"
    );
    message(&mut state, 1, ToEngine::TouchUp { id: 0 });
    assert!(
        !touch.is_grabbed(),
        "no contacts should remain after the last finger lifts"
    );
}

#[test]
fn duplicate_touch_down_and_unknown_up_do_not_corrupt_the_gesture() {
    let (mut event_loop, mut state) = state();
    let (_client, window) = window(&mut event_loop, &mut state);
    let touch = state.seat.get_touch().unwrap();
    for _ in 0..2 {
        message(
            &mut state,
            2,
            ToEngine::TouchDown {
                window,
                id: 0,
                x: 10.0,
                y: 10.0,
                normalized: false,
            },
        );
    }
    message(&mut state, 2, ToEngine::TouchUp { id: 99 });
    assert!(touch.is_grabbed());
    message(&mut state, 2, ToEngine::TouchUp { id: 0 });
    assert!(!touch.is_grabbed());
}

#[test]
fn revoking_interaction_releases_touch_contacts() {
    let (mut event_loop, mut state) = state();
    let (_client, window) = window(&mut event_loop, &mut state);
    let touch = state.seat.get_touch().unwrap();
    message(
        &mut state,
        2,
        ToEngine::TouchDown {
            window,
            id: 0,
            x: 10.0,
            y: 10.0,
            normalized: false,
        },
    );
    assert!(touch.is_grabbed());
    message(
        &mut state,
        1,
        ToEngine::SetSessionMode {
            session: 2,
            mode: SessionMode::View,
        },
    );
    assert!(!touch.is_grabbed());
}
