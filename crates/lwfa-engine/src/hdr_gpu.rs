//! P010 packing on GLES. Each RGBA16 texel stores four raw P010 words, with
//! luma rows followed by interleaved chroma rows. CUDA copies the two planes
//! directly into FFmpeg's device pool; the portable path copies the same words.
use smithay::backend::renderer::gles::{
    GlesRenderer, GlesTexProgram, GlesTexture, Uniform, UniformName, UniformType,
};
use smithay::backend::renderer::{Bind, Color32F, ExportMem, Frame, Renderer};
use smithay::utils::{Physical, Rectangle, Size, Transform};

pub struct PackedP010 {
    pub texture: GlesTexture,
    program: GlesTexProgram,
    source: Size<i32, Physical>,
    packed: Size<i32, Physical>,
}
impl PackedP010 {
    pub fn new(
        renderer: &mut GlesRenderer,
        size: Size<i32, Physical>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let packed: Size<i32, Physical> = ((size.w + 3) / 4, size.h + (size.h + 1) / 2).into();
        let program = renderer.compile_custom_texture_shader(
            include_str!("hdr_p010.frag"),
            &[
                UniformName::new("source_size", UniformType::_2f),
                UniformName::new("packed_size", UniformType::_2f),
            ],
        )?;
        let mut texture: GlesTexture =
            renderer.create_buffer_unorm16((packed.w, packed.h).into())?;
        // Allocation alone does not establish normalized16 framebuffer support.
        drop(renderer.bind(&mut texture)?);
        Ok(Self {
            texture,
            program,
            source: size,
            packed,
        })
    }
    pub fn render(
        &mut self,
        renderer: &mut GlesRenderer,
        linear: &GlesTexture,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut target = renderer.bind(&mut self.texture)?;
        let mut frame = renderer.render(&mut target, self.packed, Transform::Normal)?;
        let whole = Rectangle::from_size(self.packed);
        frame.clear(Color32F::TRANSPARENT, &[whole])?;
        frame.override_default_tex_program(
            self.program.clone(),
            vec![
                Uniform::new("source_size", [self.source.w as f32, self.source.h as f32]),
                Uniform::new("packed_size", [self.packed.w as f32, self.packed.h as f32]),
            ],
        );
        Frame::render_texture_from_to(
            &mut frame,
            linear,
            Rectangle::from_size((self.source.w, self.source.h).into()).to_f64(),
            whole,
            &[whole],
            &[],
            Transform::Normal,
            1.0,
        )?;
        let _fence = frame.finish()?;
        Ok(())
    }
    pub fn cpu_frame(
        &mut self,
        renderer: &mut GlesRenderer,
    ) -> Result<ffmpeg_next::frame::Video, Box<dyn std::error::Error>> {
        let target = renderer.bind(&mut self.texture)?;
        let mapping = renderer.copy_framebuffer_unorm16(
            &target,
            Rectangle::from_size((self.packed.w, self.packed.h).into()),
        )?;
        drop(target);
        let bytes = renderer.map_texture(&mapping)?;
        let mut frame = ffmpeg_next::frame::Video::new(
            ffmpeg_next::format::Pixel::P010LE,
            self.source.w as u32,
            self.source.h as u32,
        );
        let source_stride = self.packed.w as usize * 8;
        for plane in 0..2 {
            let offset = if plane == 0 {
                0
            } else {
                self.source.h as usize * source_stride
            };
            let rows = if plane == 0 {
                self.source.h as usize
            } else {
                (self.source.h as usize).div_ceil(2)
            };
            let row_bytes = if plane == 0 {
                self.source.w as usize * 2
            } else {
                (self.source.w as usize).div_ceil(2) * 4
            };
            let stride = frame.stride(plane);
            for row in 0..rows {
                frame.data_mut(plane)[row * stride..row * stride + row_bytes].copy_from_slice(
                    &bytes[offset + row * source_stride..offset + row * source_stride + row_bytes],
                );
            }
        }
        Ok(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use smithay::backend::allocator::Fourcc;
    use smithay::backend::renderer::Offscreen;

    #[test]
    #[ignore = "requires NVIDIA GLES/CUDA interop and Main10 NVENC"]
    fn gpu_p010_matches_readback_and_encodes_main10() {
        let _ = tracing_subscriber::fmt().with_env_filter("info").try_init();
        ffmpeg_next::init().unwrap();
        let mut renderer = crate::headless::renderer(None).unwrap();
        let mut linear: GlesTexture = renderer
            .create_buffer(Fourcc::Abgr16161616f, (320, 240).into())
            .unwrap();
        let mut target = renderer.bind(&mut linear).unwrap();
        let mut frame = renderer
            .render(&mut target, (320, 240).into(), Transform::Normal)
            .unwrap();
        // Asymmetric colors/rows catch plane offsets, row orientation and
        // channel order errors that a uniform white test cannot expose.
        frame
            .clear(
                Color32F::new(100.0, 20.0, 5.0, 1.0),
                &[Rectangle::from_size((320, 240).into())],
            )
            .unwrap();
        frame
            .clear(
                Color32F::new(10.0, 200.0, 60.0, 1.0),
                &[Rectangle::new((0, 120).into(), (320, 120).into())],
            )
            .unwrap();
        frame.finish().unwrap().wait().unwrap();
        drop(target);
        let mut packed = PackedP010::new(&mut renderer, (320, 240).into()).unwrap();
        packed.render(&mut renderer, &linear).unwrap();
        let cpu = packed.cpu_frame(&mut renderer).unwrap();
        let mut bridge = crate::cuda::GpuTarget::new_p010(packed.texture.tex_id(), 320, 240)
            .expect("HDR interop must be available, not silently fall back");
        let gpu = bridge.frame().unwrap();
        assert!(crate::cuda::is_gpu(&gpu));
        let downloaded = crate::cuda::download(&gpu).unwrap();
        assert_eq!(downloaded.format(), ffmpeg_next::format::Pixel::P010LE);
        for plane in 0..2 {
            let rows = if plane == 0 { 240 } else { 120 };
            for row in 0..rows {
                assert_eq!(
                    &downloaded.data(plane)
                        [row * downloaded.stride(plane)..row * downloaded.stride(plane) + 640],
                    &cpu.data(plane)[row * cpu.stride(plane)..row * cpu.stride(plane) + 640]
                );
            }
        }
        let mut captured = crate::capture::CapturedFrame {
            id: lwfa_proto::WindowId(1),
            width: 320,
            height: 240,
            frame: crate::capture::PooledFrame::owned(gpu),
            hdr: true,
            hdr_peak: 1000.0,
            color_generation: 1,
        };
        let mut encoders = crate::encode::Encoders::default();
        encoders.set_codec(Some(lwfa_proto::Codec::HevcHdr));
        let encoded = encoders.encode(&mut captured).unwrap();
        assert_eq!(encoded.format, lwfa_proto::FrameFormat::HevcHdr);
        assert!(encoded.keyframe);
        assert!(
            crate::cuda::is_gpu(&captured.frame),
            "encoder must consume CUDA P010 directly"
        );
    }

    #[test]
    #[ignore = "requires EGL/GLES normalized16 rendering"]
    fn packed_planes_preserve_pq_and_chroma_at_odd_sizes() {
        ffmpeg_next::init().unwrap();
        let mut renderer = crate::headless::renderer(None).unwrap();
        for (w, h) in [(8, 4), (5, 3)] {
            let mut linear: GlesTexture = renderer
                .create_buffer(Fourcc::Abgr16161616f, (w, h).into())
                .unwrap();
            let mut target = renderer.bind(&mut linear).unwrap();
            let mut frame = renderer
                .render(&mut target, (w, h).into(), Transform::Normal)
                .unwrap();
            frame
                .clear(
                    Color32F::new(80.0, 80.0, 80.0, 1.0),
                    &[Rectangle::from_size((w, h).into())],
                )
                .unwrap();
            frame.finish().unwrap().wait().unwrap();
            drop(target);
            let mut packed = PackedP010::new(&mut renderer, (w, h).into()).unwrap();
            packed.render(&mut renderer, &linear).unwrap();
            let frame = packed.cpu_frame(&mut renderer).unwrap();
            let y = (64.0 + 876.0 * crate::color::encode_pq(203.0)).round() as i32;
            for plane in 0..2 {
                let rows = if plane == 0 {
                    h as usize
                } else {
                    (h as usize).div_ceil(2)
                };
                let words = if plane == 0 {
                    w as usize
                } else {
                    (w as usize).div_ceil(2) * 2
                };
                for row in 0..rows {
                    for col in 0..words {
                        let i = row * frame.stride(plane) + col * 2;
                        let word =
                            u16::from_le_bytes(frame.data(plane)[i..i + 2].try_into().unwrap());
                        assert_eq!(word & 63, 0, "P010 must retain six zero low bits");
                        let expected = if plane == 0 { y } else { 512 };
                        assert!(
                            ((word >> 6) as i32 - expected).abs() <= 1,
                            "plane {plane}, {w}x{h}: {word} vs {expected}"
                        );
                    }
                }
            }
        }
    }
}
