//! Exercise color resource lifetimes over a real Wayland client connection.
use super::Lwfa;
use smithay::reexports::{calloop::EventLoop, wayland_server::Display};
use std::{os::unix::net::UnixStream, sync::Arc, time::Duration};
use wayland_client::{
    Connection, Dispatch, QueueHandle, delegate_noop,
    protocol::{wl_compositor, wl_registry, wl_surface},
};
use wayland_protocols::wp::color_management::v1::client::{
    wp_color_management_surface_feedback_v1 as feedback, wp_color_manager_v1 as manager,
    wp_image_description_info_v1 as info, wp_image_description_v1 as image,
};

#[derive(Default)]
struct Client {
    manager: Option<manager::WpColorManagerV1>,
    compositor: Option<wl_compositor::WlCompositor>,
    image: Option<image::WpImageDescriptionV1>,
    done: usize,
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
                "wp_color_manager_v1" => {
                    state.manager = Some(registry.bind(name, version.min(1), qh, ()))
                }
                "wl_compositor" => {
                    state.compositor = Some(registry.bind(name, version.min(4), qh, ()))
                }
                _ => {}
            }
        }
    }
}
impl Dispatch<image::WpImageDescriptionV1, ()> for Client {
    fn event(
        state: &mut Self,
        proxy: &image::WpImageDescriptionV1,
        event: image::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if matches!(event, image::Event::Ready { .. }) {
            state.image = Some(proxy.clone());
            proxy.get_information(qh, ());
        }
    }
}
impl Dispatch<info::WpImageDescriptionInfoV1, ()> for Client {
    fn event(
        state: &mut Self,
        _: &info::WpImageDescriptionInfoV1,
        event: info::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if matches!(event, info::Event::Done) {
            state.done += 1;
        }
    }
}
delegate_noop!(Client: ignore wl_compositor::WlCompositor);
delegate_noop!(Client: ignore wl_surface::WlSurface);
delegate_noop!(Client: ignore manager::WpColorManagerV1);
delegate_noop!(Client: ignore feedback::WpColorManagementSurfaceFeedbackV1);

#[test]
fn preferred_information_finishes_without_destroying_a_pending_new_object() {
    let mut event_loop = EventLoop::try_new().unwrap();
    let display = Display::new().unwrap();
    let mut state = Lwfa::without_listener(&mut event_loop, display);
    super::init(&state.display_handle);
    let (server, client) = UnixStream::pair().unwrap();
    state
        .display_handle
        .insert_client(server, Arc::new(crate::state::ClientState::default()))
        .unwrap();
    let connection = Connection::from_socket(client).unwrap();
    let mut queue = connection.new_event_queue::<Client>();
    let qh = queue.handle();
    let _registry = connection.display().get_registry(&qh, ());
    let mut client = Client::default();
    // All requests are local; a prepared read is consumed only after flushing
    // server events, so this harness needs no threads, renderer or GPU.
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
    let surface = client.compositor.as_ref().unwrap().create_surface(&qh, ());
    let feedback = client
        .manager
        .as_ref()
        .unwrap()
        .get_surface_feedback(&surface, &qh, ());
    let _image = feedback.get_preferred(&qh, ());
    pump(&mut event_loop, &mut state, &mut queue, &mut client);
    pump(&mut event_loop, &mut state, &mut queue, &mut client);
    assert_eq!(client.done, 1);
    // Repeat on the same live description: completion must not poison the
    // display or disrupt subsequent resource creation.
    client.image.as_ref().unwrap().get_information(&qh, ());
    pump(&mut event_loop, &mut state, &mut queue, &mut client);
    assert_eq!(client.done, 2);
}
