//! Renderer-validated DMA-BUF imports. Only RGB formats are advertised: YUV
//! buffers need color-representation handling before they can be interpreted.
use crate::state::Lwfa;
use smithay::{
    backend::{
        allocator::{Fourcc, dmabuf::Dmabuf},
        egl::EGLDevice,
        renderer::{ImportDma, gles::GlesRenderer},
    },
    wayland::dmabuf::{
        DmabufFeedbackBuilder, DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier,
    },
};
use std::collections::VecDeque;
use std::os::unix::fs::MetadataExt;

pub struct Imports {
    pub state: DmabufState,
    pub syncobj: Option<smithay::wayland::drm_syncobj::DrmSyncobjState>,
    global: Option<DmabufGlobal>,
    pending: VecDeque<(Dmabuf, ImportNotifier)>,
    initialized: bool,
}
impl Default for Imports {
    fn default() -> Self {
        Self {
            state: DmabufState::new(),
            syncobj: None,
            global: None,
            pending: VecDeque::new(),
            initialized: false,
        }
    }
}
impl Lwfa {
    pub fn import_dmabufs(&mut self, renderer: &mut GlesRenderer) {
        if !self.dmabuf.initialized {
            self.dmabuf.initialized = true;
            let formats: Vec<_> = renderer
                .dmabuf_formats()
                .iter()
                .copied()
                .filter(|format| {
                    matches!(
                        format.code,
                        Fourcc::Argb8888
                            | Fourcc::Xrgb8888
                            | Fourcc::Abgr8888
                            | Fourcc::Xbgr8888
                            | Fourcc::Argb2101010
                            | Fourcc::Xrgb2101010
                            | Fourcc::Abgr2101010
                            | Fourcc::Xbgr2101010
                            | Fourcc::Abgr16161616f
                            | Fourcc::Xbgr16161616f
                    )
                })
                .collect();
            if !formats.is_empty() {
                let path = EGLDevice::device_for_display(renderer.egl_context().display())
                    .ok()
                    .and_then(|d| d.render_device_path().or_else(|_| d.drm_device_path()).ok());
                let device = path
                    .as_ref()
                    .and_then(|path| std::fs::metadata(path).ok())
                    .map(|metadata| metadata.rdev());
                if let Some(file) = path.and_then(|path| {
                    std::fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(path)
                        .ok()
                }) {
                    use smithay::{
                        backend::drm::DrmDeviceFd,
                        wayland::drm_syncobj::{DrmSyncobjState, supports_syncobj_eventfd},
                    };
                    let fd = DrmDeviceFd::new(std::os::fd::OwnedFd::from(file).into());
                    if supports_syncobj_eventfd(&fd) {
                        self.dmabuf.syncobj =
                            Some(DrmSyncobjState::new::<Self>(&self.display_handle, fd));
                    }
                }
                self.dmabuf.global = Some(
                    if let Some(feedback) = device.and_then(|device| {
                        DmabufFeedbackBuilder::new(device, formats.clone())
                            .build()
                            .ok()
                    }) {
                        self.dmabuf
                            .state
                            .create_global_with_default_feedback::<Self>(
                                &self.display_handle,
                                &feedback,
                            )
                    } else {
                        self.dmabuf
                            .state
                            .create_global::<Self>(&self.display_handle, formats)
                    },
                );
                tracing::info!("renderer-validated RGB DMA-BUF import enabled");
            }
        }
        while let Some((buffer, notifier)) = self.dmabuf.pending.pop_front() {
            match renderer.import_dmabuf(&buffer, None) {
                Ok(_) => {
                    let _ = notifier.successful::<Self>();
                }
                Err(error) => {
                    tracing::debug!(?error, "DMA-BUF import rejected");
                    notifier.failed();
                }
            }
        }
    }
}
impl DmabufHandler for Lwfa {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf.state
    }
    fn dmabuf_imported(&mut self, _: &DmabufGlobal, buffer: Dmabuf, notifier: ImportNotifier) {
        // Bound descriptor retention even when clients submit imports faster
        // than the render loop can validate them.
        if self.dmabuf.pending.len() >= 64 {
            notifier.failed();
        } else {
            self.dmabuf.pending.push_back((buffer, notifier));
        }
    }
}
smithay::delegate_dmabuf!(Lwfa);

impl smithay::wayland::drm_syncobj::DrmSyncobjHandler for Lwfa {
    fn drm_syncobj_state(&mut self) -> Option<&mut smithay::wayland::drm_syncobj::DrmSyncobjState> {
        self.dmabuf.syncobj.as_mut()
    }
}
smithay::delegate_drm_syncobj!(Lwfa);
