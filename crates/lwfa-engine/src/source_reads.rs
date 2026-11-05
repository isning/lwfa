//! Keep client buffers alive until GPU reads complete. In particular, Smithay
//! signals explicit release timelines when the last Buffer reference drops.
use smithay::backend::renderer::{
    element::{RenderElement, UnderlyingStorage},
    gles::GlesRenderer,
    sync::SyncPoint,
    utils::Buffer,
};

#[derive(Default)]
pub struct SourceReads(Vec<(SyncPoint, Vec<Buffer>)>);
impl SourceReads {
    pub fn buffers<E: RenderElement<GlesRenderer>>(
        renderer: &mut GlesRenderer,
        elements: &[E],
    ) -> Vec<Buffer> {
        elements
            .iter()
            .filter_map(|element| match element.underlying_storage(renderer) {
                Some(UnderlyingStorage::Wayland(buffer)) => Some(buffer.clone()),
                _ => None,
            })
            .collect()
    }
    pub fn reap(&mut self) {
        self.0.retain(|(fence, _)| !fence.is_reached());
    }
    pub fn hold(&mut self, fence: SyncPoint, buffers: Vec<Buffer>) {
        self.reap();
        if !fence.is_reached() && !buffers.is_empty() {
            self.0.push((fence, buffers));
        }
        // Backpressure rather than unbounded descriptor retention on a slow GPU.
        if self.0.len() > 8 {
            let (fence, buffers) = self.0.remove(0);
            let _ = fence.wait();
            drop(buffers);
        }
    }
}
impl Drop for SourceReads {
    fn drop(&mut self) {
        for (fence, _) in &self.0 {
            let _ = fence.wait();
        }
    }
}
