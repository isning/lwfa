//! NVENC does not write AVCodecContext's chroma location into HEVC VUI on all
//! SDK versions. FFmpeg's HEVC metadata filter sets it without re-encoding.
#![allow(unsafe_code)]
use ff::packet::Mut;
use ffmpeg_next as ff;
use std::ptr;

pub struct CenterChroma(*mut ff::ffi::AVBSFContext);
// SAFETY: the context is exclusively owned, may move with its encoder, and is
// accessed only through &mut self; it is never used concurrently.
unsafe impl Send for CenterChroma {}
impl CenterChroma {
    pub fn new(encoder: &ff::codec::context::Context) -> Result<Self, ff::Error> {
        // SAFETY: all C strings are terminated literals. Every allocation is
        // checked, and the owner frees the context on any subsequent error.
        unsafe {
            let filter = ff::ffi::av_bsf_get_by_name(c"hevc_metadata".as_ptr());
            if filter.is_null() {
                return Err(ff::Error::BsfNotFound);
            }
            let mut context = ptr::null_mut();
            let result = ff::ffi::av_bsf_alloc(filter, &mut context);
            if result < 0 {
                return Err(ff::Error::from(result));
            }
            let owner = Self(context);
            for result in [
                ff::ffi::avcodec_parameters_from_context((*context).par_in, encoder.as_ptr()),
                ff::ffi::av_opt_set(
                    (*context).priv_data,
                    c"chroma_sample_loc_type".as_ptr(),
                    c"1".as_ptr(),
                    0,
                ),
            ] {
                if result < 0 {
                    return Err(ff::Error::from(result));
                }
            }
            (*context).time_base_in = (*encoder.as_ptr()).time_base;
            let result = ff::ffi::av_bsf_init(context);
            if result < 0 {
                return Err(ff::Error::from(result));
            }
            Ok(owner)
        }
    }
    pub fn packet(&mut self, packet: &mut ff::Packet) -> Result<Vec<u8>, ff::Error> {
        // SAFETY: send consumes only this packet's owned AVPacket references.
        // Each output packet is owned by its Rust wrapper until copied.
        unsafe {
            let result = ff::ffi::av_bsf_send_packet(self.0, packet.as_mut_ptr());
            if result < 0 {
                return Err(ff::Error::from(result));
            }
            let mut output = ff::Packet::empty();
            let mut bytes = Vec::new();
            loop {
                let result = ff::ffi::av_bsf_receive_packet(self.0, output.as_mut_ptr());
                if result < 0 {
                    let error = ff::Error::from(result);
                    if error == ff::Error::Eof
                        || matches!(error,ff::Error::Other{errno} if errno==ff::error::EAGAIN)
                    {
                        break;
                    }
                    return Err(error);
                }
                if let Some(data) = output.data() {
                    bytes.extend_from_slice(data);
                }
                ff::ffi::av_packet_unref(output.as_mut_ptr());
            }
            Ok(bytes)
        }
    }
}
impl Drop for CenterChroma {
    fn drop(&mut self) {
        // SAFETY: this is the sole owner, created by av_bsf_alloc.
        unsafe {
            ff::ffi::av_bsf_free(&mut self.0);
        }
    }
}
