/// <reference types="@webgpu/types" />
import { HDR_SHADER } from "./hdr-shader"
import { HdrPlanes } from "./hdr-planes"
import { log } from "./log"
/** HDR presentation stays in 10-bit/float precision, including planar upload
 * when external texture import fails the numeric color/precision probe.
 * ImageBitmap/8-bit 2D intermediates would discard highlights. */
export interface HdrFrame {
  readonly hdr: true
  readonly width: number
  readonly height: number
  readonly video: VideoFrame
  close(): void
}
export interface NativeVideoFrame {
  readonly native: true
  readonly width: number
  readonly height: number
  readonly video: VideoFrame
  close(): void
}
export function nativeVideoFrame(video: VideoFrame): NativeVideoFrame {
  return { native: true, get width() { return video.displayWidth }, get height() { return video.displayHeight }, video, close: () => video.close() }
}
export type DrawableFrame = ImageBitmap | HdrFrame | NativeVideoFrame
export const HDR_CHANGED = "lwfa-hdr-capability-changed"
let device: GPUDevice | null = null
let pipeline: GPURenderPipeline | null = null
let initializing: Promise<boolean> | null = null
let failed = false
let externalImport = false
let planesPipeline: GPURenderPipeline | null = null
let planesInitializing: Promise<void> | null = null
let observedDecoderFrame = false
const planePresenters = new WeakMap<HTMLCanvasElement, HdrPlanes>()
const contexts = new WeakMap<HTMLCanvasElement, GPUCanvasContext>()
const shader = `
@group(0) @binding(0) var image: texture_external;
@group(0) @binding(1) var imageSampler: sampler;
${HDR_SHADER}
@fragment fn fs(vertex: Vertex) -> @location(0) vec4f {
  // Decoder outputs are deliberately tagged linear BT.709, while retaining
  // the BT.2020 YUV matrix. Import into sRGB only applies its OETF. Undo it
  // to recover the original PQ RGB samples without browser HDR tone mapping.
  let encoded = textureSampleBaseClampToEdge(image, imageSampler, vertex.uv);
  let v = max(encoded.rgb, vec3f(0.0));
  let pq = select(v / 12.92, pow((v + 0.055) / 1.055, vec3f(2.4)), v > vec3f(0.04045));
  return present_pq(pq);
}`
let sampler: GPUSampler | null = null

let lastDiagnostic = ""
function diagnostic(message: string): false {
  if (message !== lastDiagnostic) {
    lastDiagnostic = message
    console.info(`[hdr] ${message}`)
    log("info", `[hdr] ${message}`)
  }
  return false
}
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function disableHdr(reason = "presentation device became unavailable"): void {
  if (failed) return
  failed = true
  diagnostic(`disabled: ${reason}`)
  window.dispatchEvent(new Event(HDR_CHANGED))
}

/** Recheck the display on every negotiation, rather than caching an HDR screen. */
export async function supportsHdr(): Promise<boolean> {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false
  if (failed) return false
  if (!window.matchMedia?.("(dynamic-range: high)").matches) return diagnostic("SDR: display does not report HDR")
  if (!navigator.gpu) return diagnostic("SDR: WebGPU unavailable")
  initializing ??= (async () => {
    let stage = "request adapter"
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) return diagnostic("SDR: no WebGPU adapter")
      stage = "request device"
      device = await adapter.requestDevice()
      const canvas = document.createElement("canvas")
      const context = canvas.getContext("webgpu")
      if (!context) return diagnostic("SDR: WebGPU canvas unavailable")
      stage = "configure extended float canvas"
      device.pushErrorScope("validation")
      context.configure({ device, format: "rgba16float", colorSpace: "display-p3", toneMapping: { mode: "extended" }, alphaMode: "opaque" })
      const configuration = context.getConfiguration()
      const error = await device.popErrorScope()
      context.unconfigure()
      if (error) return diagnostic(`SDR: extended float canvas: ${error.message}`)
      if (configuration?.toneMapping?.mode !== "extended" || configuration.format !== "rgba16float") return diagnostic("SDR: browser did not accept extended float canvas")
      stage = "compile external-texture shader"
      pipeline = await device.createRenderPipelineAsync({
        layout: "auto", vertex: { module: device.createShaderModule({ code: shader }), entryPoint: "vs" },
        fragment: { module: device.createShaderModule({ code: shader }), entryPoint: "fs", targets: [{ format: "rgba16float" }] },
        primitive: { topology: "triangle-list" },
      })
      sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })
      try { externalImport = await probeImport((video,view) => render(video,view)) }
      catch { externalImport = false }
      if (!externalImport) {
        stage = "10-bit plane precision probe"
        await preparePlanes()
        console.info("HDR uses exact 10-bit plane upload: external import failed its color/precision probe")
      }
      void device.lost.then((info) => disableHdr(`device lost: ${info.message}`))
      device.addEventListener("uncapturederror", (event) => disableHdr(event.error.message))
      diagnostic(`presentation ready (${externalImport ? "external texture" : "10-bit planes"})`)
      return true
    } catch (error) { return diagnostic(`SDR: ${stage}: ${detail(error)}`) }
  })()
  return initializing
}

export async function drawHdr(canvas: HTMLCanvasElement, frame: HdrFrame): Promise<void> {
  if (!device || !pipeline || !sampler || failed) { disableHdr(); return }
  try {
    const color = frame.video.colorSpace
    if (!observedDecoderFrame) {
      observedDecoderFrame = true
      log("info", `[hdr] decoded frame: format=${frame.video.format}; primaries=${color.primaries}; transfer=${color.transfer}; matrix=${color.matrix}; fullRange=${color.fullRange}`)
    }
    // Only the external importer relies on the synthetic linear container.
    // Raw-plane reads preserve the encoded YUV samples regardless of labels.
    // Hardware decoders may return the bitstream's PQ/BT.2020 labels instead.
    if (externalImport && (String(color.transfer) !== "linear" || color.primaries !== "bt709"
        || String(color.matrix) !== "bt2020-ncl" || color.fullRange !== false)) {
      await preparePlanes()
      externalImport = false
      diagnostic("decoder uses verified 10-bit planes; external-import container labels differ")
    }
    let context = contexts.get(canvas)
    if (!context) {
      context = canvas.getContext("webgpu") ?? undefined
      if (!context) throw new Error("HDR canvas unavailable")
      context.configure({ device, format: "rgba16float", colorSpace: "display-p3", toneMapping: { mode: "extended" }, alphaMode: "opaque" })
      contexts.set(canvas, context)
    }
    if (externalImport) render(frame.video, context.getCurrentTexture().createView())
    else {
      if (!planesPipeline) throw new Error("HDR plane pipeline unavailable")
      let presenter = planePresenters.get(canvas)
      if (!presenter) { presenter = new HdrPlanes(device,planesPipeline); planePresenters.set(canvas,presenter) }
      const target = context
      await presenter.draw(frame.video,()=>target.getCurrentTexture().createView(),()=>!failed)
    }
  } catch (error) { disableHdr(detail(error)) }
}

async function preparePlanes(): Promise<void> {
  if (!device) throw new Error("HDR device unavailable")
  const currentDevice = device
  planesInitializing ??= (async () => {
    planesPipeline = await HdrPlanes.pipeline(currentDevice)
    const planes = new HdrPlanes(currentDevice, planesPipeline)
    try {
      if (!await probeImport((video, view) => planes.draw(video, () => view, () => true))) {
        throw new Error("10-bit plane precision probe failed")
      }
    } finally { planes.destroy() }
  })()
  return planesInitializing
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
async function probeImport(draw: (video: VideoFrame, view: GPUTextureView) => void | Promise<void>): Promise<boolean> {
  if (!device) return false
  // Expected float Display-P3 values are computed from the quantized YUV words,
  // not the unquantized source. Saturated blue detects matrix/upload errors;
  // gray catches loss of highlight precision or browser HDR tone mapping.
  for (const [words,expected] of [
    [[723,723,723,723,512,512],[1.9987744,1.9987744,1.9987744]],
    [[508,508,508,508,649,471],[-0.5451187,0.6917263,2.3738728]],
  ]) {
    const video = new VideoFrame(new Uint16Array(words!), { format: "I420P10" as VideoPixelFormat, codedWidth: 2, codedHeight: 2, timestamp: 0, colorSpace: HDR_COLOR_SPACE })
    const texture = device.createTexture({ size: [2,2], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    const buffer = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    try {
      await draw(video,texture.createView())
      const encoder = device.createCommandEncoder()
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [2,2])
      device.queue.submit([encoder.finish()])
      await buffer.mapAsync(GPUMapMode.READ)
      const pixel = new Uint16Array(buffer.getMappedRange())
      for (let channel=0;channel<3;channel++) {
        const word=pixel[channel]!, sign=word&0x8000?-1:1, exponent=(word>>10)&31, fraction=word&1023
        const value=sign*(exponent === 0 ? fraction*2**-24 : (1+fraction/1024)*2**(exponent-15))
        if (!Number.isFinite(value) || Math.abs(value-expected![channel]!)>0.006) throw new Error(`precision mismatch channel ${channel}: got ${value}, expected ${expected![channel]!}`)
      }
    } finally { video.close(); buffer.destroy(); texture.destroy() }
  }
  return true
}

/** Useful for diagnostics; never advertises HDR without passing its probe. */
export function hdrPresentationPath(): "external" | "planes" | null {
  return failed || !pipeline ? null : externalImport ? "external" : planesPipeline ? "planes" : null
}

export function hdrFrame(video: VideoFrame): HdrFrame {
  return { hdr: true, get width() { return video.displayWidth }, get height() { return video.displayHeight }, video, close: () => video.close() }
}

/** lib.dom currently omits the standard linear transfer enum.
 * Internal decoder container: preserve PQ code values for our shader. The
 * matrix still decodes the actual BT.2020 limited-range YUV correctly. These
 * frames must only be presented by drawHdr, never Canvas2D/ImageBitmap. */
export const HDR_COLOR_SPACE: VideoColorSpaceInit = { primaries: "bt709", transfer: "linear" as VideoTransferCharacteristics, matrix: "bt2020-ncl" as VideoMatrixCoefficients, fullRange: false }
