//! Real Wayland scale negotiation for windows, popups and subsurfaces.
use crate::state::{ClientState, Lwfa};
use smithay::reexports::{calloop::EventLoop, wayland_server::Display};
use smithay::utils::Transform;
use std::{os::unix::net::UnixStream, sync::Arc, time::Duration};
use wayland_client::{
    Connection, Dispatch, QueueHandle, delegate_noop,
    protocol::{
        wl_compositor, wl_output, wl_registry, wl_subcompositor, wl_subsurface, wl_surface,
    },
};
use wayland_protocols::{
    wp::fractional_scale::v1::client::{
        wp_fractional_scale_manager_v1 as manager, wp_fractional_scale_v1 as fractional,
    },
    xdg::shell::client::{xdg_popup, xdg_positioner, xdg_surface, xdg_toplevel, xdg_wm_base},
};

#[derive(Default)]
struct Client {
    compositor: Option<wl_compositor::WlCompositor>,
    subcompositor: Option<wl_subcompositor::WlSubcompositor>,
    manager: Option<manager::WpFractionalScaleManagerV1>,
    shell: Option<xdg_wm_base::XdgWmBase>,
    output: Option<wl_output::WlOutput>,
    fractional: Vec<(u8, u32)>,
    integer: Vec<(u8, i32)>,
    output_scales: Vec<i32>,
    modes: Vec<(i32, i32)>,
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
                    state.compositor = Some(registry.bind(name, version.min(6), qh, ()))
                }
                "wl_subcompositor" => state.subcompositor = Some(registry.bind(name, 1, qh, ())),
                "wp_fractional_scale_manager_v1" => {
                    state.manager = Some(registry.bind(name, 1, qh, ()))
                }
                "xdg_wm_base" => state.shell = Some(registry.bind(name, version.min(3), qh, ())),
                "wl_output" => state.output = Some(registry.bind(name, version.min(4), qh, ())),
                _ => {}
            }
        }
    }
}
impl Dispatch<fractional::WpFractionalScaleV1, u8> for Client {
    fn event(
        state: &mut Self,
        _: &fractional::WpFractionalScaleV1,
        event: fractional::Event,
        id: &u8,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let fractional::Event::PreferredScale { scale } = event {
            state.fractional.push((*id, scale));
        }
    }
}
impl Dispatch<wl_surface::WlSurface, u8> for Client {
    fn event(
        state: &mut Self,
        _: &wl_surface::WlSurface,
        event: wl_surface::Event,
        id: &u8,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_surface::Event::PreferredBufferScale { factor } = event {
            state.integer.push((*id, factor));
        }
    }
}
impl Dispatch<wl_output::WlOutput, ()> for Client {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_output::Event::Scale { factor } => state.output_scales.push(factor),
            wl_output::Event::Mode { width, height, .. } => state.modes.push((width, height)),
            _ => {}
        }
    }
}
delegate_noop!(Client: ignore wl_compositor::WlCompositor);
delegate_noop!(Client: ignore wl_subcompositor::WlSubcompositor);
delegate_noop!(Client: ignore wl_subsurface::WlSubsurface);
delegate_noop!(Client: ignore manager::WpFractionalScaleManagerV1);
delegate_noop!(Client: ignore xdg_wm_base::XdgWmBase);
delegate_noop!(Client: ignore xdg_surface::XdgSurface);
delegate_noop!(Client: ignore xdg_toplevel::XdgToplevel);
delegate_noop!(Client: ignore xdg_popup::XdgPopup);
delegate_noop!(Client: ignore xdg_positioner::XdgPositioner);

#[test]
fn density_changes_reach_existing_toplevel_subsurface_and_popup_without_resizing_layout() {
    let mut event_loop = EventLoop::try_new().unwrap();
    let display = Display::new().unwrap();
    let mut state = Lwfa::without_listener(&mut event_loop, display);
    let output = crate::output::init(
        &mut state,
        "hidpi-test",
        "headless",
        (800, 600).into(),
        Transform::Normal,
    );
    let (server, client) = UnixStream::pair().unwrap();
    state
        .display_handle
        .insert_client(server, Arc::new(ClientState::default()))
        .unwrap();
    let connection = Connection::from_socket(client).unwrap();
    let mut queue = connection.new_event_queue::<Client>();
    let qh = queue.handle();
    let _registry = connection.display().get_registry(&qh, ());
    let mut client = Client::default();
    let pump = |event_loop: &mut EventLoop<'static, Lwfa>,
                state: &mut Lwfa,
                queue: &mut wayland_client::EventQueue<Client>,
                client: &mut Client| {
        connection.flush().unwrap();
        event_loop.dispatch(Duration::ZERO, state).unwrap();
        state.display_handle.flush_clients().unwrap();
        queue.prepare_read().unwrap().read().unwrap();
        queue.dispatch_pending(client).unwrap();
    };
    pump(&mut event_loop, &mut state, &mut queue, &mut client);
    let compositor = client.compositor.as_ref().unwrap().clone();
    let manager = client.manager.as_ref().unwrap().clone();
    let shell = client.shell.as_ref().unwrap().clone();
    let root = compositor.create_surface(&qh, 1);
    let _root_scale = manager.get_fractional_scale(&root, &qh, 1);
    let xdg = shell.get_xdg_surface(&root, &qh, ());
    let _toplevel = xdg.get_toplevel(&qh, ());
    let child = compositor.create_surface(&qh, 2);
    let _child_scale = manager.get_fractional_scale(&child, &qh, 2);
    let _subsurface = client
        .subcompositor
        .as_ref()
        .unwrap()
        .get_subsurface(&child, &root, &qh, ());
    child.commit();
    root.commit();
    let popup = compositor.create_surface(&qh, 3);
    let _popup_scale = manager.get_fractional_scale(&popup, &qh, 3);
    let popup_xdg = shell.get_xdg_surface(&popup, &qh, ());
    let positioner = shell.create_positioner(&qh, ());
    positioner.set_size(100, 80);
    positioner.set_anchor_rect(0, 0, 10, 10);
    let _popup = popup_xdg.get_popup(Some(&xdg), &positioner, &qh, ());
    popup.commit();
    pump(&mut event_loop, &mut state, &mut queue, &mut client);
    for (scale, wire_scale) in [(2.0, 240), (1.25, 150), (1.0, 120)] {
        client.fractional.clear();
        client.integer.clear();
        crate::output::resize(&mut state, &output, 800, 600, scale);
        pump(&mut event_loop, &mut state, &mut queue, &mut client);
        for id in [1, 2, 3] {
            assert!(
                client.fractional.contains(&(id, wire_scale)),
                "surface {id} did not receive fractional scale {wire_scale}: {:?}",
                client.fractional
            );
        }
        assert!(
            client.integer.contains(&(1, scale.ceil() as i32)) || scale == 1.25,
            "at scale {scale}, integer events: {:?}",
            client.integer
        );
        assert_eq!(state.layout.output_size(), (800, 600).into());
        assert_eq!(
            state.space.output_geometry(&output).unwrap().size,
            (800, 600).into()
        );
        assert!(
            client
                .modes
                .contains(&((800.0 * scale) as i32, (600.0 * scale) as i32))
        );
    }
    // An unowned surface created after a density change starts at that density,
    // before a role, buffer or first configure exists.
    crate::output::resize(&mut state, &output, 800, 600, 1.5);
    let unowned = compositor.create_surface(&qh, 4);
    let _unowned_scale = manager.get_fractional_scale(&unowned, &qh, 4);
    pump(&mut event_loop, &mut state, &mut queue, &mut client);
    assert!(client.fractional.contains(&(4, 180)));
}
