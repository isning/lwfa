import { useSyncExternalStore } from "react"
import type { WindowId } from "@lwfa/proto"
import type { DrawableFrame } from "./hdr"
import { nativeHdrMetadata } from "./native-hdr"

export type PresentationPreference = "auto" | "video" | "canvas"
export type Presentation = { path: "Native video" | "WebGPU Canvas" | "Canvas2D"; reason?: string }
export function choosePresentation(preference: PresentationPreference, frame: DrawableFrame, native: boolean): Presentation {
  if (!("video" in frame)) return { path: "Canvas2D", ...(preference === "video" ? { reason: "Image frames use Canvas; native video requires decoded video frames." } : {}) }
  const hdr = "hdr" in frame
  const canVideo = native && (!hdr || nativeHdrMetadata(frame.video))
  if (preference === "video" && canVideo) return { path: "Native video" }
  if (hdr && frame.video.format === null && canVideo) return { path: "Native video", ...(preference === "canvas" ? { reason: "This HDR frame cannot be read as planes; native video preserves HDR." } : {}) }
  return { path: hdr ? "WebGPU Canvas" : "Canvas2D", ...(preference === "video" ? { reason: native ? "This HDR frame requires Canvas color conversion." : "Native video is unavailable or failed; using Canvas." } : {}) }
}
const listeners = new Set<() => void>()
const windows = new Map<WindowId, Presentation>()
let snapshot: Presentation[] = []
function notify() { snapshot = [...windows.values()]; for (const listener of listeners) listener() }
export function notePresentation(id: WindowId, value: Presentation): void {
  const old = windows.get(id)
  if (old?.path === value.path && old.reason === value.reason) return
  windows.set(id, value); notify()
}
export function forgetPresentation(id: WindowId): void { if (windows.delete(id)) notify() }
export function usePresentations(): Presentation[] {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => snapshot, () => snapshot)
}
