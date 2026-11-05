//! Parametric color-management-v1. ICC and arbitrary source chromaticities are not
//! advertised. Surface descriptions use Smithay's transaction cache, including
//! synchronized subsurfaces, rather than applying requests immediately.

use crate::{
    color::{Description, Primaries, Transfer},
    state::Lwfa,
};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::{
    Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource, WEnum, Weak,
};
use smithay::wayland::compositor::{Cacheable, with_states};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use wayland_protocols::wp::color_management::v1::server::{
    wp_color_management_output_v1::{self as output, WpColorManagementOutputV1},
    wp_color_management_surface_feedback_v1::{
        self as feedback, WpColorManagementSurfaceFeedbackV1,
    },
    wp_color_management_surface_v1::{self as surface, WpColorManagementSurfaceV1},
    wp_color_manager_v1::{self as manager, WpColorManagerV1},
    wp_image_description_creator_icc_v1::{self as icc, WpImageDescriptionCreatorIccV1},
    wp_image_description_creator_params_v1::{self as params, WpImageDescriptionCreatorParamsV1},
    wp_image_description_info_v1::{self as info, WpImageDescriptionInfoV1},
    wp_image_description_v1::{self as image, WpImageDescriptionV1},
};

pub fn init(display: &DisplayHandle) {
    display.create_global::<Lwfa, WpColorManagerV1, _>(1, ());
}

#[derive(Debug, Default)]
pub struct ColorState {
    pub available: bool,
    hdr: bool,
    feedback: Vec<Weak<WpColorManagementSurfaceFeedbackV1>>,
    outputs: Vec<(
        Weak<WpColorManagementOutputV1>,
        Weak<smithay::reexports::wayland_server::protocol::wl_output::WlOutput>,
    )>,
}
impl ColorState {
    fn description(&self) -> Description {
        if self.hdr {
            Description::named(Primaries::Bt2020, Transfer::Pq)
        } else {
            Description::default()
        }
    }
    pub fn set_hdr(&mut self, hdr: bool) {
        if self.hdr == hdr {
            return;
        }
        self.hdr = hdr;
        self.feedback.retain(|weak| match weak.upgrade() {
            Ok(feedback) => {
                feedback.preferred_changed(if hdr { 2 } else { 1 });
                true
            }
            Err(_) => false,
        });
        self.outputs
            .retain(|(weak, output)| match (weak.upgrade(), output.upgrade()) {
                (Ok(color), Ok(output)) => {
                    color.image_description_changed();
                    if output.version() >= 2 {
                        output.done();
                    }
                    true
                }
                _ => false,
            });
    }
}
#[derive(Debug)]
pub struct OutputData(Weak<smithay::reexports::wayland_server::protocol::wl_output::WlOutput>);

#[derive(Debug, Clone, Copy, Default)]
pub struct SurfaceColor(pub Option<Description>);
impl Cacheable for SurfaceColor {
    fn commit(&mut self, _: &DisplayHandle) -> Self {
        *self
    }
    fn merge_into(self, into: &mut Self, _: &DisplayHandle) {
        *into = self;
    }
}

#[derive(Debug, Default)]
struct Attachment(AtomicBool);
#[derive(Debug)]
pub struct SurfaceData(Weak<WlSurface>);
#[derive(Debug, Default)]
pub struct Parameters(Mutex<ParameterSet>);
#[derive(Debug, Default)]
struct ParameterSet {
    primaries: Option<Primaries>,
    transfer: Option<Transfer>,
    luminances: Option<(u32,u32,u32)>,
    mastering_primaries: Option<[i32;8]>,
    mastering_luminance: Option<(u32,u32)>,
    cll: Option<u32>,
    fall: Option<u32>,
}
#[derive(Debug)]
pub struct ImageData {
    description: Option<Description>,
    information: bool,
}

fn make_image(
    data: &mut DataInit<'_, Lwfa>,
    id: New<WpImageDescriptionV1>,
    description: Option<Description>,
    information: bool,
) {
    let image = data.init(
        id,
        ImageData {
            description,
            information,
        },
    );
    if description.is_some() {
        // Identities may differ for identical descriptions, but never identify
        // different descriptions. A client resource id alone is reusable.
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(3);
        let identity = if information {
            if description.is_some_and(|d| d.transfer == Transfer::Pq) {
                2
            } else {
                1
            }
        } else {
            NEXT.fetch_add(1, Ordering::Relaxed)
        };
        image.ready(identity);
    } else {
        image.failed(
            image::Cause::Unsupported,
            "unsupported color description".into(),
        );
    }
}

impl GlobalDispatch<WpColorManagerV1, ()> for Lwfa {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<WpColorManagerV1>,
        _: &(),
        data: &mut DataInit<'_, Self>,
    ) {
        let manager = data.init(resource, ());
        manager.supported_intent(manager::RenderIntent::Perceptual);
        manager.supported_feature(manager::Feature::Parametric);
        manager.supported_feature(manager::Feature::WindowsScrgb);
        manager.supported_feature(manager::Feature::SetLuminances);
        manager.supported_feature(manager::Feature::SetMasteringDisplayPrimaries);
        for primaries in [
            manager::Primaries::Srgb,
            manager::Primaries::DisplayP3,
            manager::Primaries::Bt2020,
        ] {
            manager.supported_primaries_named(primaries);
        }
        for tf in [
            manager::TransferFunction::Srgb,
            manager::TransferFunction::Bt1886,
            manager::TransferFunction::St2084Pq,
            manager::TransferFunction::ExtLinear,
            manager::TransferFunction::Hlg,
        ] {
            manager.supported_tf_named(tf);
        }
        manager.done();
    }
}
impl Dispatch<WpColorManagerV1, ()> for Lwfa {
    fn request(
        state: &mut Self,
        _: &Client,
        resource: &WpColorManagerV1,
        request: manager::Request,
        _: &(),
        _: &DisplayHandle,
        data: &mut DataInit<'_, Self>,
    ) {
        match request {
            manager::Request::Destroy => {}
            manager::Request::GetOutput { id, output } => {
                let color = data.init(id, OutputData(output.downgrade()));
                state
                    .color_state
                    .outputs
                    .retain(|(weak, _)| weak.upgrade().is_ok());
                state
                    .color_state
                    .outputs
                    .push((color.downgrade(), output.downgrade()));
            }
            manager::Request::GetSurface { id, surface } => {
                let already = with_states(&surface, |states| {
                    states.data_map.insert_if_missing(Attachment::default);
                    states
                        .data_map
                        .get::<Attachment>()
                        .unwrap()
                        .0
                        .swap(true, Ordering::Relaxed)
                });
                if already {
                    resource.post_error(
                        manager::Error::SurfaceExists,
                        "surface already has color management",
                    );
                    return;
                }
                data.init(id, SurfaceData(surface.downgrade()));
            }
            manager::Request::GetSurfaceFeedback { id, surface } => {
                let feedback = data.init(id, SurfaceData(surface.downgrade()));
                feedback.preferred_changed(if state.color_state.hdr { 2 } else { 1 });
                state
                    .color_state
                    .feedback
                    .retain(|weak| weak.upgrade().is_ok());
                state.color_state.feedback.push(feedback.downgrade());
            }
            manager::Request::CreateWindowsScrgb { image_description } => {
                let mut description = Description::named(Primaries::Srgb, Transfer::Linear);
                description.reference_white = 203.0;
                description.min_luminance = 0.0;
                description.target_peak = 10000.0;
                make_image(data, image_description, Some(description), false);
            }
            manager::Request::CreateParametricCreator { obj } => {
                data.init(obj, Parameters::default());
            }
            _ => resource.post_error(
                manager::Error::UnsupportedFeature,
                "color feature not advertised",
            ),
        }
    }
}

impl Dispatch<WpColorManagementSurfaceV1, SurfaceData> for Lwfa {
    fn request(
        _: &mut Self,
        _: &Client,
        resource: &WpColorManagementSurfaceV1,
        request: surface::Request,
        attached: &SurfaceData,
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
        let Ok(surface) = attached.0.upgrade() else {
            if !matches!(request, surface::Request::Destroy) {
                resource.post_error(surface::Error::Inert, "surface was destroyed");
            }
            return;
        };
        let description = match request {
            surface::Request::Destroy => {
                with_states(&surface, |states| {
                    states
                        .data_map
                        .get::<Attachment>()
                        .unwrap()
                        .0
                        .store(false, Ordering::Relaxed)
                });
                None
            }
            surface::Request::UnsetImageDescription => None,
            surface::Request::SetImageDescription {
                image_description,
                render_intent,
            } => {
                if render_intent != WEnum::Value(manager::RenderIntent::Perceptual) {
                    resource.post_error(
                        surface::Error::RenderIntent,
                        "rendering intent not advertised",
                    );
                    return;
                }
                let Some(description) = image_description
                    .data::<ImageData>()
                    .and_then(|data| data.description)
                else {
                    resource.post_error(
                        surface::Error::ImageDescription,
                        "image description is not ready",
                    );
                    return;
                };
                Some(description)
            }
            _ => return,
        };
        with_states(&surface, |states| {
            states.cached_state.get::<SurfaceColor>().pending().0 = description
        });
    }
}
impl Dispatch<WpColorManagementOutputV1, OutputData> for Lwfa {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &WpColorManagementOutputV1,
        request: output::Request,
        output: &OutputData,
        _: &DisplayHandle,
        data: &mut DataInit<'_, Self>,
    ) {
        if let output::Request::GetImageDescription { image_description } = request {
            if output.0.upgrade().is_err() {
                let image = data.init(
                    image_description,
                    ImageData {
                        description: None,
                        information: false,
                    },
                );
                image.failed(image::Cause::NoOutput, "output was destroyed".into());
            } else {
                make_image(
                    data,
                    image_description,
                    Some(state.color_state.description()),
                    true,
                );
            }
        }
    }
}
impl Dispatch<WpColorManagementSurfaceFeedbackV1, SurfaceData> for Lwfa {
    fn request(
        state: &mut Self,
        _: &Client,
        resource: &WpColorManagementSurfaceFeedbackV1,
        request: feedback::Request,
        attached: &SurfaceData,
        _: &DisplayHandle,
        data: &mut DataInit<'_, Self>,
    ) {
        if matches!(request, feedback::Request::Destroy) {
            return;
        }
        if attached.0.upgrade().is_err() {
            resource.post_error(feedback::Error::Inert, "surface was destroyed");
            return;
        }
        match request {
            feedback::Request::GetPreferred { image_description }
            | feedback::Request::GetPreferredParametric { image_description } => make_image(
                data,
                image_description,
                Some(state.color_state.description()),
                true,
            ),
            _ => {}
        }
    }
}

impl Dispatch<WpImageDescriptionCreatorParamsV1, Parameters> for Lwfa {
    fn request(
        _: &mut Self,
        _: &Client,
        resource: &WpImageDescriptionCreatorParamsV1,
        request: params::Request,
        parameters: &Parameters,
        _: &DisplayHandle,
        data: &mut DataInit<'_, Self>,
    ) {
        let mut set = parameters.0.lock().unwrap();
        match request {
            params::Request::SetPrimariesNamed { primaries } => {
                if set.primaries.is_some() {
                    resource.post_error(params::Error::AlreadySet, "primaries already set");
                    return;
                }
                set.primaries = match primaries {
                    WEnum::Value(manager::Primaries::Srgb) => Some(Primaries::Srgb),
                    WEnum::Value(manager::Primaries::DisplayP3) => Some(Primaries::DisplayP3),
                    WEnum::Value(manager::Primaries::Bt2020) => Some(Primaries::Bt2020),
                    _ => {
                        resource.post_error(
                            params::Error::InvalidPrimariesNamed,
                            "primaries not advertised",
                        );
                        return;
                    }
                };
            }
            params::Request::SetTfNamed { tf } => {
                if set.transfer.is_some() {
                    resource.post_error(params::Error::AlreadySet, "transfer function already set");
                    return;
                }
                set.transfer = match tf {
                    WEnum::Value(manager::TransferFunction::Srgb) => Some(Transfer::Srgb),
                    WEnum::Value(manager::TransferFunction::Bt1886) => Some(Transfer::Bt1886),
                    WEnum::Value(manager::TransferFunction::St2084Pq) => Some(Transfer::Pq),
                    WEnum::Value(manager::TransferFunction::ExtLinear) => Some(Transfer::Linear),
                    WEnum::Value(manager::TransferFunction::Hlg) => Some(Transfer::Hlg),
                    _ => {
                        resource.post_error(
                            params::Error::InvalidTf,
                            "transfer function not advertised",
                        );
                        return;
                    }
                };
            }
            params::Request::SetMasteringDisplayPrimaries { r_x,r_y,g_x,g_y,b_x,b_y,w_x,w_y } => {
                if set.mastering_primaries.replace([r_x,r_y,g_x,g_y,b_x,b_y,w_x,w_y]).is_some() { resource.post_error(params::Error::AlreadySet, "mastering primaries already set"); }
            }
            params::Request::SetMasteringLuminance { min_lum,max_lum } => {
                if set.mastering_luminance.replace((min_lum,max_lum)).is_some() { resource.post_error(params::Error::AlreadySet, "mastering luminance already set"); }
                else if u64::from(max_lum)*10000 <= u64::from(min_lum) { resource.post_error(params::Error::InvalidLuminance, "invalid mastering range"); }
            }
            params::Request::SetLuminances { min_lum, max_lum, reference_lum } => {
                if set.luminances.replace((min_lum,max_lum,reference_lum)).is_some() {
                    resource.post_error(params::Error::AlreadySet, "luminances already set");
                } else if u64::from(max_lum)*10000 <= u64::from(min_lum) || u64::from(reference_lum)*10000 <= u64::from(min_lum) {
                    resource.post_error(params::Error::InvalidLuminance, "invalid luminance range");
                }
            }
            params::Request::SetMaxCll { max_cll } => {
                if set.cll.replace(max_cll).is_some() {
                    resource.post_error(params::Error::AlreadySet, "max CLL already set");
                }
            }
            params::Request::SetMaxFall { max_fall } => {
                if set.fall.replace(max_fall).is_some() {
                    resource.post_error(params::Error::AlreadySet, "max FALL already set");
                }
            }
            params::Request::Create { image_description } => {
                let (Some(primaries), Some(transfer)) = (set.primaries, set.transfer) else {
                    resource.post_error(
                        params::Error::IncompleteSet,
                        "primaries and transfer function required",
                    );
                    return;
                };
                let mut description = Description::named(primaries, transfer);
                if let Some((minimum,maximum,white)) = set.luminances {
                    description.min_luminance = minimum as f32 / 10000.0;
                    description.max_luminance = if transfer == Transfer::Pq { description.min_luminance+10000.0 } else { maximum as f32 };
                    description.reference_white = white as f32;
                    if white as f32 > description.max_luminance {
                        make_image(data, image_description, None, false);
                        return;
                    }
                }
                description.mastering_primaries = set.mastering_primaries;
                description.mastering_luminance = set.mastering_luminance;
                if !valid_mastering(description) {
                    make_image(data, image_description, None, false);
                    return;
                }
                let (minimum, maximum) = set.mastering_luminance.unwrap_or((
                    (description.min_luminance * 10000.0) as u32,
                    description.max_luminance as u32,
                ));
                if set.cll.zip(set.fall).is_some_and(|(cll, fall)| fall > cll)
                    || [set.cll, set.fall]
                        .into_iter()
                        .flatten()
                        .any(|v| u64::from(v) * 10000 <= u64::from(minimum) || v > maximum)
                {
                    resource.post_error(
                        params::Error::InvalidLuminance,
                        "content luminance exceeds mastering range",
                    );
                    return;
                }
                description.target_peak = set.cll.unwrap_or(maximum) as f32;
                make_image(data, image_description, Some(description), false);
            }
            _ => resource.post_error(
                params::Error::UnsupportedFeature,
                "parameter feature not advertised",
            ),
        }
    }
}

// Without extended_target_volume, accept only mastering volumes contained in
// the named source triangle and luminance interval. Invalid descriptions fail
// gracefully rather than terminating an otherwise well-formed client.
fn valid_mastering(description: Description) -> bool {
    if let Some((min,max)) = description.mastering_luminance
        && (min as f32 / 10000.0 < description.min_luminance || max as f32 > description.max_luminance) { return false; }
    let Some(coords) = description.mastering_primaries else { return true };
    let source = match description.primaries {
        Primaries::Srgb => [[640000,330000],[300000,600000],[150000,60000]],
        Primaries::DisplayP3 => [[680000,320000],[265000,690000],[150000,60000]],
        Primaries::Bt2020 => [[708000,292000],[170000,797000],[131000,46000]],
    };
    let cross = |a: [i32;2], b: [i32;2], p: [i32;2]| (i128::from(b[0])-i128::from(a[0]))*(i128::from(p[1])-i128::from(a[1]))-(i128::from(b[1])-i128::from(a[1]))*(i128::from(p[0])-i128::from(a[0]));
    let points = coords.as_chunks::<2>().0;
    if cross(points[0],points[1],points[2]) == 0 { return false; }
    points.iter().all(|&p| (0..3).all(|i| cross(source[i],source[(i+1)%3],p)>=0))
}

impl Dispatch<WpImageDescriptionV1, ImageData> for Lwfa {
    fn request(
        state: &mut Self,
        _: &Client,
        resource: &WpImageDescriptionV1,
        request: image::Request,
        image: &ImageData,
        _: &DisplayHandle,
        data: &mut DataInit<'_, Self>,
    ) {
        if let image::Request::GetInformation { information } = request {
            if !image.information {
                resource.post_error(
                    image::Error::NoInformation,
                    "client-created descriptions cannot be queried",
                );
                return;
            }
            let Some(description) = image.description else {
                resource.post_error(image::Error::NotReady, "description is not ready");
                return;
            };
            let information = data.init(information, ());
            let coords = if description.primaries == Primaries::Bt2020 {
                (
                    708000, 292000, 170000, 797000, 131000, 46000, 312700, 329000,
                )
            } else {
                (
                    640000, 330000, 300000, 600000, 150000, 60000, 312700, 329000,
                )
            };
            information.primaries(
                coords.0, coords.1, coords.2, coords.3, coords.4, coords.5, coords.6, coords.7,
            );
            information.primaries_named(if description.primaries == Primaries::Bt2020 {
                manager::Primaries::Bt2020
            } else {
                manager::Primaries::Srgb
            });
            information.tf_named(if description.transfer == Transfer::Pq {
                manager::TransferFunction::St2084Pq
            } else {
                manager::TransferFunction::Srgb
            });
            information.luminances(
                (description.min_luminance * 10000.0) as u32,
                description.max_luminance as u32,
                description.reference_white as u32,
            );
            information.target_primaries(
                coords.0, coords.1, coords.2, coords.3, coords.4, coords.5, coords.6, coords.7,
            );
            information.target_luminance(
                (description.min_luminance * 10000.0) as u32,
                description.max_luminance as u32,
            );
            // `done` destroys this new resource. The Wayland backend installs
            // its object data after this request returns, so destroying it here
            // would remove the object before that installation and panic.
            state.loop_handle.insert_idle(move |_| {
                if information.is_alive() {
                    information.done();
                }
            });
        }
    }
}
impl Dispatch<WpImageDescriptionInfoV1, ()> for Lwfa {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WpImageDescriptionInfoV1,
        _: info::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}
impl Dispatch<WpImageDescriptionCreatorIccV1, ()> for Lwfa {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WpImageDescriptionCreatorIccV1,
        _: icc::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mastering_volume_must_fit_named_source_without_extended_feature() {
        let mut description=Description::named(Primaries::Bt2020,Transfer::Pq);
        description.mastering_primaries=Some([640000,330000,300000,600000,150000,60000,312700,329000]);
        description.mastering_luminance=Some((50,1000));
        assert!(valid_mastering(description));
        description.mastering_primaries=Some([708000,292000,170000,797000,131000,46000,312700,329000]);
        description.primaries=Primaries::Srgb;
        assert!(!valid_mastering(description));
        description.mastering_primaries=Some([i32::MIN,i32::MAX,i32::MAX,i32::MIN,0,0,0,0]);
        assert!(!valid_mastering(description));
    }
}

#[cfg(test)]
#[path = "color_management_tests.rs"]
mod protocol_tests;
