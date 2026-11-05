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
  // Decoder outputs are deliberately tagged linear BT.709, while retaining
  // the BT.2020 YUV matrix. Import into sRGB only applies its OETF. Undo it
  // to recover the original PQ RGB samples without browser HDR tone mapping.
  let encoded = textureSampleBaseClampToEdge(image, imageSampler, vertex.uv);
  let v = max(encoded.rgb, vec3f(0.0));
  let pq = select(v / 12.92, pow((v + 0.055) / 1.055, vec3f(2.4)), v > vec3f(0.04045));
  let p = pow(pq, vec3f(1.0 / 78.84375));
  let nits = pow(max(p - 0.8359375, vec3f(0.0)) / (18.8515625 - 18.6875 * p), vec3f(1.0 / 0.1593017578125)) * 10000.0;
  let p3 = mat3x3f(vec3f(1.343578,-0.065298,0.002822), vec3f(-0.282180,1.075788,-0.019599), vec3f(-0.061398,-0.010490,1.016777)) * (nits / 203.0);
  // Extended Display-P3 uses the extended sRGB transfer, not linear values.
  let a = abs(p3);
  let output = sign(p3) * select(a * 12.92, 1.055 * pow(a,vec3f(1.0/2.4)) - 0.055, a > vec3f(0.0031308));
  return vec4f(output, 1.0);
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
      if (!await probeImport()) return false
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
    if (String(frame.video.colorSpace.transfer) !== "linear" || frame.video.colorSpace.primaries !== "bt709") throw new Error("decoder did not preserve the HDR sample container")
    let context = contexts.get(canvas)
    if (!context) {
      context = canvas.getContext("webgpu") ?? undefined
      if (!context) throw new Error("HDR canvas unavailable")
      context.configure({ device, format: "rgba16float", colorSpace: "display-p3", toneMapping: { mode: "extended" }, alphaMode: "opaque" })
      contexts.set(canvas, context)
    }
    render(frame.video, context.getCurrentTexture().createView())
  } catch { disableHdr() }
}

function render(video: VideoFrame, view: GPUTextureView): void {
  if (!device || !pipeline || !sampler) throw new Error("HDR device unavailable")
    const image = device.importExternalTexture({ source: video, colorSpace: "srgb" })
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: image }, { binding: 1, resource: sampler }] })
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: view, loadOp: "clear", storeOp: "store", clearValue: [0,0,0,1] }] })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])
}

/** Validate the actual external-texture conversion, not just canvas allocation.
 * Some browsers accept float HDR canvases but tone-map PQ imports to SDR. */
async function probeImport(): Promise<boolean> {
  if (!device) return false
  const data = new Uint16Array([723,723,723,723,512,512]) // 1000-nit gray
  const video = new VideoFrame(data, { format: "I420P10" as VideoPixelFormat, codedWidth: 2, codedHeight: 2, timestamp: 0, colorSpace: HDR_COLOR_SPACE })
  const texture = device.createTexture({ size: [2,2], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const buffer = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  try {
    render(video, texture.createView())
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [2,2])
    device.queue.submit([encoder.finish()])
    await buffer.mapAsync(GPUMapMode.READ)
    const word = new Uint16Array(buffer.getMappedRange())[0]!
    // Positive finite binary16 between 1.8 and 2.2, approximately 1000/203
    // nits with extended sRGB encoding. SDR clipping or tone mapping fails.
    return word >= 0x3f33 && word <= 0x4066
  } finally { video.close(); buffer.destroy(); texture.destroy() }
}

export function hdrFrame(video: VideoFrame): HdrFrame {
  return { hdr: true, get width() { return video.displayWidth }, get height() { return video.displayHeight }, video, close: () => video.close() }
}

/** lib.dom currently omits the standard linear transfer enum.
 * Internal decoder container: preserve PQ code values for our shader. The
 * matrix still decodes the actual BT.2020 limited-range YUV correctly. These
 * frames must only be presented by drawHdr, never Canvas2D/ImageBitmap. */
export const HDR_COLOR_SPACE: VideoColorSpaceInit = { primaries: "bt709", transfer: "linear" as VideoTransferCharacteristics, matrix: "bt2020-ncl" as VideoMatrixCoefficients, fullRange: false }
