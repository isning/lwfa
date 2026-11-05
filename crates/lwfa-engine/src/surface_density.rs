//! Surface scale negotiation and bounded capture sizes.
use crate::state::Lwfa;
use lwfa_proto::WindowId;
use smithay::desktop::{PopupManager, find_popup_root_surface};
use smithay::reexports::wayland_server::Resource;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{Logical, Physical, Size, Transform};
use smithay::wayland::compositor::{
    TraversalAction, get_parent, send_surface_state, with_states, with_surface_tree_downward,
};
use smithay::wayland::fractional_scale::{FractionalScaleHandler, with_fractional_scale};
use smithay::wayland::seat::WaylandFocus;
use smithay::xwayland::XWaylandClientData;

/// Bound each capture before any texture or readback allocation. At most 64 MiB
/// of RGBA per target, and no dimension beyond a common encoder limit.
pub(crate) fn valid_capture_size(size: Size<i32, Physical>) -> bool {
    size.w > 0
        && size.h > 0
        && size.w <= 8192
        && size.h <= 8192
        && i64::from(size.w) * i64::from(size.h) <= 16_777_216
}

pub(crate) fn bounded_density(size: Size<i32, Logical>, requested: f64) -> f64 {
    let w = f64::from(size.w.max(1));
    let h = f64::from(size.h.max(1));
    let requested = if requested.is_finite() && requested > 0.0 {
        requested.clamp(1.0, 3.0)
    } else {
        1.0
    };
    // Reserve a pixel for rounding up either dimension.
    requested
        .min(8191.0 / w)
        .min(8191.0 / h)
        .min((16_769_025.0 / (w * h)).sqrt())
}

/// Keep AVC captures within a conservative 4096-pixel encoder envelope.
/// HEVC/JPEG retain the general texture and total-pixel bounds above.
fn codec_density(
    size: Size<i32, Logical>,
    requested: f64,
    codec: Option<lwfa_proto::Codec>,
) -> f64 {
    let density = bounded_density(size, requested);
    if codec == Some(lwfa_proto::Codec::H264) {
        density
            .min(4096.0 / f64::from(size.w.max(1)))
            .min(4096.0 / f64::from(size.h.max(1)))
    } else {
        density
    }
}

impl Lwfa {
    /// The shared output follows the primary connection's device pixel ratio.
    /// Secondary viewers scale that scene locally rather than changing it.
    pub fn render_density(&self) -> f64 {
        self.space
            .outputs()
            .next()
            .map(|output| output.current_scale().fractional_scale())
            .unwrap_or(1.0)
    }

    /// Capture native Wayland windows at the output's density. An app can
    /// refuse a configure or enforce a larger minimum, so bound its actual
    /// geometry before allocating textures. X11 retains logical-size capture
    /// until its separate RandR/DPI coordinate model supports HiDPI.
    pub fn capture_density(&self, id: WindowId) -> f64 {
        self.layout
            .window(id)
            .map(|window| {
                codec_density(
                    window.geometry().size,
                    if window.is_x11() {
                        1.0
                    } else {
                        self.render_density()
                    },
                    self.encoders
                        .as_ref()
                        .and_then(|worker| worker.negotiated_codec()),
                )
            })
            .unwrap_or(1.0)
    }
    /// Normalized browser positions stay valid even when the displayed frame
    /// belongs to the previous window size. Older clients keep logical coordinates.
    pub fn input_coordinates(
        &self,
        id: WindowId,
        x: f64,
        y: f64,
        normalized: bool,
    ) -> Option<(f64, f64)> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        if !normalized {
            return Some((x, y));
        }
        let size = self.layout.window(id)?.geometry().size;
        let projected = (x * f64::from(size.w), y * f64::from(size.h));
        (projected.0.is_finite() && projected.1.is_finite()).then_some(projected)
    }
    fn surface_owner(&self, surface: &WlSurface) -> Option<WindowId> {
        let mut root = surface.clone();
        while let Some(parent) = get_parent(&root) {
            root = parent;
        }
        if let Some(id) = self.layout.id_of_surface(&root) {
            return Some(id);
        }
        let popup = self.popups.find_popup(&root)?;
        let root = find_popup_root_surface(&popup).ok()?;
        self.layout.id_of_surface(&root)
    }
    fn default_surface_density(&self, surface: &WlSurface) -> f64 {
        if surface
            .client()
            .is_some_and(|client| client.get_data::<XWaylandClientData>().is_some())
        {
            1.0
        } else {
            self.render_density()
        }
    }
    pub fn init_surface_density(&self, surface: &WlSurface) {
        apply_density(surface, self.default_surface_density(surface));
    }
    pub fn inherit_surface_density(&self, surface: &WlSurface, parent: &WlSurface) {
        let density = self
            .surface_owner(parent)
            .map(|id| self.capture_density(id))
            .unwrap_or_else(|| self.default_surface_density(surface));
        apply_density(surface, density);
    }
    pub fn apply_window_density(&self, id: WindowId) {
        let Some(window) = self.layout.window(id) else {
            return;
        };
        if window.is_x11() {
            return;
        }
        let Some(surface) = window.wl_surface() else {
            return;
        };
        let density = self.capture_density(id);
        apply_density(&surface, density);
        for (popup, _) in PopupManager::popups_for_surface(&surface) {
            apply_density(popup.wl_surface(), density);
        }
    }
}

fn apply_density(surface: &WlSurface, density: f64) {
    with_surface_tree_downward(
        surface,
        (),
        |_, _, _| TraversalAction::DoChildren(()),
        |surface, data, _| {
            send_surface_state(
                surface,
                data,
                density.ceil().max(1.0) as i32,
                Transform::Normal,
            );
            with_fractional_scale(data, |state| state.set_preferred_scale(density));
        },
        |_, _, _| true,
    );
}

impl FractionalScaleHandler for Lwfa {
    fn new_fractional_scale(&mut self, surface: WlSurface) {
        let density = self
            .surface_owner(&surface)
            .map(|id| self.capture_density(id))
            .unwrap_or_else(|| self.default_surface_density(&surface));
        with_states(&surface, |data| {
            with_fractional_scale(data, |state| state.set_preferred_scale(density))
        });
    }
}
smithay::delegate_fractional_scale!(Lwfa);
smithay::delegate_viewporter!(Lwfa);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_windows_capture_at_logical_size() {
        for size in [(1324, 838), (1920, 1080), (2560, 1440), (3840, 2160)] {
            assert_eq!(bounded_density(size.into(), 1.0), 1.0);
        }
    }

    #[test]
    fn hidpi_density_is_used_without_changing_logical_geometry() {
        let logical: Size<i32, Logical> = (2030, 1335).into();
        assert_eq!(bounded_density(logical, 2.0), 2.0);
        assert_eq!(
            logical
                .to_f64()
                .to_physical(bounded_density(logical, 2.0))
                .to_i32_round(),
            (4060, 2670).into()
        );
        assert_eq!(bounded_density((800, 600).into(), 1.25), 1.25);
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(bounded_density((800, 600).into(), scale), 1.0);
        }
    }

    #[test]
    fn high_density_targets_stay_inside_pixel_and_dimension_limits() {
        for (w, h) in [
            (2030, 1335),
            (3840, 2160),
            (8000, 1000),
            (1000, 8000),
            (8192, 8192),
        ] {
            let logical: Size<i32, Logical> = (w, h).into();
            for requested in [1.0, 1.25, 1.5, 2.0, 3.0, 10.0] {
                let density = bounded_density(logical, requested);
                assert!(density > 0.0 && density <= requested.min(3.0));
                assert!(valid_capture_size(
                    logical.to_f64().to_physical(density).to_i32_round()
                ));
            }
        }
    }

    #[test]
    fn avc_density_does_not_request_eight_k_from_a_four_k_encoder() {
        let size: Size<i32, Logical> = (2400, 1200).into();
        let avc = codec_density(size, 2.0, Some(lwfa_proto::Codec::H264));
        assert_eq!(
            size.to_f64().to_physical(avc).to_i32_round(),
            (4096, 2048).into()
        );
        assert_eq!(codec_density(size, 2.0, Some(lwfa_proto::Codec::Hevc)), 2.0);
        assert_eq!(
            codec_density(size, 2.0, Some(lwfa_proto::Codec::HevcHdr)),
            2.0
        );
    }

    #[test]
    fn oversized_windows_stay_within_capture_allocation_limits() {
        for size in [
            (8192, 8192),
            (16384, 1000),
            (1000, 16384),
            (i32::MAX, i32::MAX),
        ] {
            let logical: Size<i32, Logical> = size.into();
            let density = bounded_density(logical, 3.0);
            assert!(density > 0.0 && density < 1.0);
            assert!(valid_capture_size(
                logical.to_f64().to_physical(density).to_i32_round()
            ));
        }
    }

    #[test]
    fn unreasonable_capture_allocations_are_rejected() {
        assert!(valid_capture_size((2000, 1000).into()));
        assert!(!valid_capture_size((0, 1000).into()));
        assert!(!valid_capture_size((8193, 1000).into()));
        assert!(!valid_capture_size((8192, 8192).into()));
    }
}
