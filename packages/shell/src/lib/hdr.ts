/// <reference types="@webgpu/types" />
/** HDR presentation stays on VideoFrame -> external texture -> float canvas.
 * ImageBitmap/8-bit 2D intermediates would discard highlights. */
export interface HdrFrame {
  readonly hdr: true
  readonly width: number
  readonly height: number
  readonly video: VideoFrame
  close(): void
}
export type DrawableFrame = ImageBitmap | HdrFrame
export const HDR_CHANGED = "lwfa-hdr-capability-changed"
let device: GPUDevice | null = null
let pipeline: GPURenderPipeline | null = null
let initializing: Promise<boolean> | null = null
let failed = false
const contexts = new WeakMap<HTMLCanvasElement, GPUCanvasContext>()
const shader = `
@group(0) @binding(0) var image: texture_external;
@group(0) @binding(1) var imageSampler: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) index: u32) -> Vertex {
  let p = array(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0))[index];
  return Vertex(vec4f(p,0.0,1.0), vec2f((p.x+1.0)*0.5,(1.0-p.y)*0.5));
}
@fragment fn fs(vertex: Vertex) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(image, imageSampler, vertex.uv);
}`
let sampler: GPUSampler | null = null

export function disableHdr(): void {
  if (failed) return
  failed = true
  window.dispatchEvent(new Event(HDR_CHANGED))
}

/** Recheck the display on every negotiation, rather than caching an HDR screen. */
export async function supportsHdr(): Promise<boolean> {
  if (failed || typeof window === "undefined" || typeof navigator === "undefined"
      || !window.matchMedia?.("(dynamic-range: high)").matches || !navigator.gpu) return false
  initializing ??= (async () => {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) return false
      device = await adapter.requestDevice()
      const canvas = document.createElement("canvas")
      const context = canvas.getContext("webgpu")
      if (!context) return false
      device.pushErrorScope("validation")
      context.configure({ device, format: "rgba16float", colorSpace: "display-p3", toneMapping: { mode: "extended" }, alphaMode: "opaque" })
      const configuration = context.getConfiguration()
      const error = await device.popErrorScope()
      context.unconfigure()
      if (error || configuration?.toneMapping?.mode !== "extended" || configuration.format !== "rgba16float") return false
      pipeline = await device.createRenderPipelineAsync({
        layout: "auto", vertex: { module: device.createShaderModule({ code: shader }), entryPoint: "vs" },
        fragment: { module: device.createShaderModule({ code: shader }), entryPoint: "fs", targets: [{ format: "rgba16float" }] },
        primitive: { topology: "triangle-list" },
      })
      sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })
      void device.lost.then(disableHdr)
      device.addEventListener("uncapturederror", disableHdr)
      return true
    } catch { return false }
  })()
  return initializing
}

export function drawHdr(canvas: HTMLCanvasElement, frame: HdrFrame): void {
  if (!device || !pipeline || !sampler || failed) { disableHdr(); return }
  try {
    let context = contexts.get(canvas)
    if (!context) {
      context = canvas.getContext("webgpu") ?? undefined
      if (!context) throw new Error("HDR canvas unavailable")
      context.configure({ device, format: "rgba16float", colorSpace: "display-p3", toneMapping: { mode: "extended" }, alphaMode: "opaque" })
      contexts.set(canvas, context)
    }
    const image = device.importExternalTexture({ source: frame.video, colorSpace: "display-p3" })
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: image }, { binding: 1, resource: sampler }] })
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0,0,0,1] }] })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])
  } catch { disableHdr() }
}

export function hdrFrame(video: VideoFrame): HdrFrame {
  return { hdr: true, get width() { return video.displayWidth }, get height() { return video.displayHeight }, video, close: () => video.close() }
}

// lib.dom may lag the WebCodecs BT.2020 matrix enum. The string is defined by
// https://www.w3.org/TR/webcodecs/#video-matrix-coefficients .
export const HDR_COLOR_SPACE: VideoColorSpaceInit = { primaries: "bt2020" as VideoColorPrimaries, transfer: "smpte2084" as VideoTransferCharacteristics, matrix: "bt2020-ncl" as VideoMatrixCoefficients, fullRange: false }
