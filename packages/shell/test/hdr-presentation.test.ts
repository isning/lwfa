import { afterEach, expect, it, vi } from "vitest"

const planes = vi.hoisted(() => ({ draw: vi.fn(async () => {}), pipeline: vi.fn(async () => ({})), destroy: vi.fn() }))
vi.mock("../src/lib/hdr-planes", () => ({ HdrPlanes: class {
  static pipeline = planes.pipeline
  draw = planes.draw
  destroy = planes.destroy
} }))

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks() })

it.each([false, true])("presents decoded PQ frames through verified planes (external import available: %s)", async (external) => {
  const dispatch = vi.fn()
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }), dispatchEvent: dispatch })
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, COPY_SRC: 2 })
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 })
  vi.stubGlobal("GPUMapMode", { READ: 1 })
  vi.stubGlobal("VideoFrame", class { close() {} })
  let sample = 0
  const device = {
    pushErrorScope() {}, popErrorScope: async () => null,
    createShaderModule: () => ({}), createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }), createSampler: () => ({}),
    importExternalTexture: () => { if (!external) throw new Error("external import unavailable"); return {} },
    createBindGroup: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createBuffer: () => ({ mapAsync: async () => {}, getMappedRange: () => new Uint16Array(sample++ % 2 === 0 ? [16383,16383,16383] : [47196,14729,16575]).buffer, destroy() {} }),
    createCommandEncoder: () => ({ copyTextureToBuffer() {}, beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }), finish: () => ({}) }),
    queue: { submit() {} }, lost: new Promise(() => {}), addEventListener() {},
  }
  vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } })
  const context = { configure() {}, getConfiguration: () => ({ toneMapping: { mode: "extended" }, format: "rgba16float" }), unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) }
  const canvas = { getContext: () => context } as unknown as HTMLCanvasElement
  vi.stubGlobal("document", { createElement: () => canvas })
  const { supportsHdr, drawHdr, hdrFrame } = await import("../src/lib/hdr")
  expect(await supportsHdr()).toBe(true)
  expect(planes.draw).toHaveBeenCalledTimes(external ? 0 : 2)
  const video = { colorSpace: { primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false }, displayWidth: 32, displayHeight: 24, close() {} } as unknown as VideoFrame
  await drawHdr(canvas, hdrFrame(video))
  expect(planes.draw).toHaveBeenCalledTimes(3)
  expect(dispatch).not.toHaveBeenCalled()
})
