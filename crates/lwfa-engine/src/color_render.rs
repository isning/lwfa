//! GLES color conversion shared by capture and the SDR nested preview.
use crate::color::{Description, Primaries, Transfer};
use smithay::backend::renderer::{
    element::Id,
    gles::{GlesRenderer, GlesTexProgram, Uniform, UniformName, UniformType},
};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::wayland::compositor::{TraversalAction, with_surface_tree_downward};
use std::collections::HashMap;

/// Advertise only after this renderer proves it can preserve precision.
pub fn init_backend(state: &mut crate::state::Lwfa, renderer: &mut GlesRenderer) {
    use smithay::backend::allocator::Fourcc;
    use smithay::backend::renderer::gles::GlesTexture;
    use smithay::backend::renderer::{ImportMemWl, Offscreen};
    state.shm_state.update_formats(renderer.shm_formats());
    let supported = (|| -> Result<GlesTexProgram, Box<dyn std::error::Error>> {
        use smithay::backend::renderer::{Bind, Color32F, ExportMem, Frame, Renderer};
        use smithay::utils::{Rectangle, Transform};
        let program = program(renderer)?;
        let mut linear: GlesTexture =
            renderer.create_buffer(Fourcc::Abgr16161616f, (2, 2).into())?;
        {
            let mut target = renderer.bind(&mut linear)?;
            let mut frame = renderer.render(&mut target, (2, 2).into(), Transform::Normal)?;
            frame.clear(
                Color32F::new(80.0, 80.0, 80.0, 1.0),
                &[Rectangle::from_size((2, 2).into())],
            )?;
            frame.finish()?.wait()?;
        }
        let mut pq: GlesTexture = renderer.create_buffer(Fourcc::Abgr2101010, (2, 2).into())?;
        let mut target = renderer.bind(&mut pq)?;
        let mut frame = renderer.render(&mut target, (2, 2).into(), Transform::Normal)?;
        frame.override_default_tex_program(program.clone(), uniforms(Description::default(), 2.0));
        Frame::render_texture_from_to(
            &mut frame,
            &linear,
            Rectangle::from_size((2, 2).into()).to_f64(),
            Rectangle::from_size((2, 2).into()),
            &[Rectangle::from_size((2, 2).into())],
            &[],
            Transform::Normal,
            1.0,
        )?;
        frame.finish()?.wait()?;
        let mapping = renderer.copy_framebuffer(
            &target,
            Rectangle::from_size((2, 2).into()),
            Fourcc::Abgr2101010,
        )?;
        drop(target);
        let pixels = renderer.map_texture(&mapping)?;
        // 203 cd/m² in ST2084 is code 594/1023. This also detects a float
        // framebuffer silently clamping the working-white value 80 to 1.
        if pixels.len() != 16
            || pixels.as_chunks::<4>().0.iter().any(|pixel| {
                let pixel = u32::from_ne_bytes(*pixel);
                [0, 10, 20]
                    .into_iter()
                    .any(|shift| (((pixel >> shift) & 1023) as i32 - 594).abs() > 1)
            })
        {
            return Err("float-to-PQ render/readback precision probe failed".into());
        }
        Ok(program)
    })();
    match supported {
        Ok(program) => {
            state.capture.enable_color(program);
            state.color_state.available = true;
            crate::color_management::init(&state.display_handle);
        }
        Err(err) => tracing::warn!("CM/HDR disabled: GLES float/10-bit support unavailable: {err}"),
    }
}

pub fn program(
    renderer: &mut GlesRenderer,
) -> Result<GlesTexProgram, smithay::backend::renderer::gles::GlesError> {
    renderer.compile_custom_texture_shader(
        include_str!("color.frag"),
        &[
            "source_tf",
            "source_primaries",
            "source_white",
            "source_peak",
            "source_target",
            "source_black",
            "output_mode",
        ]
        .map(|name| UniformName::new(name, UniformType::_1f)),
    )
}

pub fn uniforms(description: Description, output_mode: f32) -> Vec<Uniform<'static>> {
    vec![
        Uniform::new(
            "source_tf",
            match description.transfer {
                Transfer::Srgb => 0.0_f32,
                Transfer::Bt1886 => 1.0,
                Transfer::Pq => 2.0,
            },
        ),
        Uniform::new(
            "source_primaries",
            match description.primaries {
                Primaries::Srgb => 0.0_f32,
                Primaries::DisplayP3 => 1.0,
                Primaries::Bt2020 => 2.0,
            },
        ),
        Uniform::new("source_white", description.reference_white),
        Uniform::new("source_peak", description.max_luminance),
        Uniform::new("source_black", description.min_luminance),
        Uniform::new("source_target", description.target_peak),
        Uniform::new("output_mode", output_mode),
    ]
}

pub fn descriptions(surface: &WlSurface, into: &mut HashMap<Id, Description>) {
    with_surface_tree_downward(
        surface,
        (),
        |_, _, _| TraversalAction::DoChildren(()),
        |surface, states, _| {
            let description = states
                .cached_state
                .get::<crate::color_management::SurfaceColor>()
                .current()
                .0
                .unwrap_or_default();
            into.insert(Id::from_wayland_resource(surface), description);
        },
        |_, _, _| true,
    );
}

/// Nested preview has an SDR framebuffer even when the remote stream is HDR.
/// Keep a per-element commit counter so changing only a description damages it.
#[derive(Default)]
pub struct PreviewColors {
    program: Option<GlesTexProgram>,
    linear: Option<(
        smithay::utils::Size<i32, smithay::utils::Physical>,
        smithay::backend::renderer::gles::GlesTexture,
    )>,
    peak: f32,
    commits: HashMap<
        Id,
        (
            Description,
            smithay::backend::renderer::utils::CommitCounter,
            smithay::backend::renderer::utils::CommitCounter,
        ),
    >,
}

impl PreviewColors {
    pub fn wrap(
        &mut self,
        renderer: &mut GlesRenderer,
        element: smithay::backend::renderer::element::surface::WaylandSurfaceRenderElement<
            GlesRenderer,
        >,
        description: Description,
        linear: bool,
    ) -> Option<PreviewElement> {
        use smithay::backend::renderer::element::Element;
        let id = element.id().clone();
        let buffer = element.current_commit();
        let previous = self
            .commits
            .entry(id)
            .or_insert((description, buffer, Default::default()));
        if previous.0 != description || previous.1 != buffer {
            previous.0 = description;
            previous.1 = buffer;
            previous.2.increment();
        }
        let managed = linear;
        if managed && self.program.is_none() {
            self.program = Some(
                program(renderer)
                    .inspect_err(|err| tracing::error!("preview color shader failed: {err}"))
                    .ok()?,
            );
        }
        Some(PreviewElement {
            inner: element,
            description,
            commit: previous.2,
            program: if managed { self.program.clone() } else { None },
        })
    }
    pub fn set_peak(&mut self, peak: f32) {
        self.peak = peak;
    }
    pub fn retain(&mut self, ids: &std::collections::HashSet<Id>) {
        self.commits.retain(|id, _| ids.contains(id));
    }
}

pub struct PreviewElement {
    inner: smithay::backend::renderer::element::surface::WaylandSurfaceRenderElement<GlesRenderer>,
    description: Description,
    commit: smithay::backend::renderer::utils::CommitCounter,
    program: Option<GlesTexProgram>,
}
impl smithay::backend::renderer::element::Element for PreviewElement {
    fn id(&self) -> &Id {
        self.inner.id()
    }
    fn current_commit(&self) -> smithay::backend::renderer::utils::CommitCounter {
        self.commit
    }
    fn src(&self) -> smithay::utils::Rectangle<f64, smithay::utils::Buffer> {
        self.inner.src()
    }
    fn transform(&self) -> smithay::utils::Transform {
        self.inner.transform()
    }
    fn geometry(
        &self,
        scale: smithay::utils::Scale<f64>,
    ) -> smithay::utils::Rectangle<i32, smithay::utils::Physical> {
        self.inner.geometry(scale)
    }
    fn opaque_regions(
        &self,
        scale: smithay::utils::Scale<f64>,
    ) -> smithay::backend::renderer::utils::OpaqueRegions<i32, smithay::utils::Physical> {
        self.inner.opaque_regions(scale)
    }
    fn alpha(&self) -> f32 {
        self.inner.alpha()
    }
    fn kind(&self) -> smithay::backend::renderer::element::Kind {
        self.inner.kind()
    }
}
impl smithay::backend::renderer::element::RenderElement<GlesRenderer> for PreviewElement {
    fn draw(
        &self,
        frame: &mut smithay::backend::renderer::gles::GlesFrame<'_, '_>,
        src: smithay::utils::Rectangle<f64, smithay::utils::Buffer>,
        dst: smithay::utils::Rectangle<i32, smithay::utils::Physical>,
        damage: &[smithay::utils::Rectangle<i32, smithay::utils::Physical>],
        opaque: &[smithay::utils::Rectangle<i32, smithay::utils::Physical>],
    ) -> Result<(), smithay::backend::renderer::gles::GlesError> {
        if let Some(program) = &self.program {
            frame.override_default_tex_program(program.clone(), uniforms(self.description, 0.0));
        }
        let result = self.inner.draw(frame, src, dst, damage, opaque);
        frame.clear_tex_program_override();
        result
    }
}

impl PreviewColors {
    pub fn render<E: smithay::backend::renderer::element::RenderElement<GlesRenderer>>(
        &mut self,
        renderer: &mut GlesRenderer,
        host: &mut smithay::backend::renderer::gles::GlesTarget<'_>,
        tracker: &mut smithay::backend::renderer::damage::OutputDamageTracker,
        elements: &[E],
        size: smithay::utils::Size<i32, smithay::utils::Physical>,
        backdrop: [f32; 4],
    ) -> Result<(), Box<dyn std::error::Error>> {
        use smithay::backend::{
            allocator::Fourcc,
            renderer::{Bind, Color32F, Frame, Offscreen, Renderer},
        };
        use smithay::utils::{Rectangle, Transform};
        if !self.linear.as_ref().is_some_and(|(old, _)| *old == size) {
            self.linear = Some((
                size,
                renderer.create_buffer(
                    Fourcc::Abgr16161616f,
                    smithay::utils::Size::from((size.w, size.h)),
                )?,
            ));
        }
        let texture = &mut self.linear.as_mut().unwrap().1;
        let mut linear = renderer.bind(texture)?;
        let source = Description::default();
        let rgb = [backdrop[0], backdrop[1], backdrop[2]].map(|v| {
            (crate::color::decode(v, source) - source.min_luminance) * 80.0
                / (source.reference_white - source.min_luminance)
        });
        tracker.render_output(
            renderer,
            &mut linear,
            0,
            elements,
            [rgb[0], rgb[1], rgb[2], backdrop[3]],
        )?;
        drop(linear);
        if self.program.is_none() {
            self.program = Some(program(renderer)?);
        }
        let mut frame = renderer.render(host, size, Transform::Normal)?;
        let whole = Rectangle::from_size(size);
        frame.clear(Color32F::TRANSPARENT, &[whole])?;
        let description = Description {
            reference_white: 80.0,
            target_peak: self.peak.max(1.0) * 80.0,
            ..Default::default()
        };
        frame.override_default_tex_program(
            self.program.as_ref().unwrap().clone(),
            uniforms(description, 1.0),
        );
        Frame::render_texture_from_to(
            &mut frame,
            texture,
            Rectangle::from_size(smithay::utils::Size::from((size.w, size.h))).to_f64(),
            whole,
            &[whole],
            &[],
            Transform::Normal,
            1.0,
        )?;
        let _fence = frame.finish()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use smithay::backend::allocator::Fourcc;
    use smithay::backend::renderer::gles::GlesTexture;
    use smithay::backend::renderer::{Bind, Color32F, ExportMem, Frame, Offscreen, Renderer};
    use smithay::utils::{Rectangle, Transform};

    #[test]
    #[ignore = "requires offscreen EGL/GLES with float rendering"]
    fn preview_blends_linear_light_before_sdr_resolve() {
        use smithay::backend::renderer::damage::OutputDamageTracker;
        use smithay::backend::renderer::element::{
            Kind,
            solid::{SolidColorBuffer, SolidColorRenderElement},
        };
        let mut renderer = crate::headless::renderer(None).unwrap();
        let mut texture: GlesTexture = renderer
            .create_buffer(Fourcc::Abgr8888, (2, 2).into())
            .unwrap();
        let mut target = renderer.bind(&mut texture).unwrap();
        // Premultiplied linear half-white over opaque black: 40 / 80 = 0.5.
        let buffer = SolidColorBuffer::new((2, 2), [40.0, 40.0, 40.0, 0.5]);
        let element =
            SolidColorRenderElement::from_buffer(&buffer, (0, 0), 1.0, 1.0, Kind::Unspecified);
        let mut colors = PreviewColors::default();
        colors.set_peak(1.0);
        let mut tracker = OutputDamageTracker::new((2, 2), 1.0, Transform::Normal);
        colors
            .render(
                &mut renderer,
                &mut target,
                &mut tracker,
                &[element],
                (2, 2).into(),
                [0.0, 0.0, 0.0, 1.0],
            )
            .unwrap();
        let mapping = renderer
            .copy_framebuffer(
                &target,
                Rectangle::from_size((2, 2).into()),
                Fourcc::Abgr8888,
            )
            .unwrap();
        drop(target);
        let pixels = renderer.map_texture(&mapping).unwrap();
        for pixel in pixels.as_chunks::<4>().0 {
            for channel in &pixel[..3] {
                assert!(
                    (*channel as i32 - 188).abs() <= 1,
                    "linear blend must encode as sRGB 0.735, got {pixel:?}"
                );
            }
        }
    }

    #[test]
    #[ignore = "requires offscreen EGL/GLES and float/10-bit render targets"]
    fn hdr_resolve_preserves_ten_bit_pq_precision() {
        let mut renderer = crate::headless::renderer(None).unwrap();
        let program = program(&mut renderer).unwrap();
        let size = (2, 2).into();
        let mut linear: GlesTexture = renderer.create_buffer(Fourcc::Abgr16161616f, size).unwrap();
        {
            let mut target = renderer.bind(&mut linear).unwrap();
            let mut frame = renderer
                .render(&mut target, (2, 2).into(), Transform::Normal)
                .unwrap();
            frame
                .clear(
                    Color32F::new(80.0, 80.0, 80.0, 1.0),
                    &[Rectangle::from_size((2, 2).into())],
                )
                .unwrap();
            frame.finish().unwrap().wait().unwrap();
        }
        let mut pq: GlesTexture = renderer.create_buffer(Fourcc::Abgr2101010, size).unwrap();
        let mut target = renderer.bind(&mut pq).unwrap();
        let mut frame = renderer
            .render(&mut target, (2, 2).into(), Transform::Normal)
            .unwrap();
        frame.override_default_tex_program(program, uniforms(Description::default(), 2.0));
        Frame::render_texture_from_to(
            &mut frame,
            &linear,
            Rectangle::from_size(size).to_f64(),
            Rectangle::from_size((2, 2).into()),
            &[Rectangle::from_size((2, 2).into())],
            &[],
            Transform::Normal,
            1.0,
        )
        .unwrap();
        frame.finish().unwrap().wait().unwrap();
        let mapping = renderer
            .copy_framebuffer(&target, Rectangle::from_size(size), Fourcc::Abgr2101010)
            .unwrap();
        drop(target);
        let pixels = renderer.map_texture(&mapping).unwrap();
        let expected = (crate::color::encode_pq(203.0) * 1023.0).round() as i32;
        for pixel in pixels.as_chunks::<4>().0 {
            let pixel = u32::from_ne_bytes(*pixel);
            for shift in [0, 10, 20] {
                assert!((((pixel >> shift) & 1023) as i32 - expected).abs() <= 1);
            }
        }
        assert_ne!(
            expected % 4,
            0,
            "fixture must distinguish 10-bit output from an 8-bit intermediate"
        );
    }
}
