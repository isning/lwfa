/// <reference types="@webgpu/types" />
import { HDR_SHADER } from "./hdr-shader"

const shader = `${HDR_SHADER}
@group(0) @binding(0) var luma: texture_2d<u32>;
@group(0) @binding(1) var cb: texture_2d<u32>;
@group(0) @binding(2) var cr: texture_2d<u32>;
fn chroma(plane: texture_2d<u32>, uv: vec2f) -> f32 {
  let dimensions=vec2i(textureDimensions(plane));
  // Chroma spacing stays two luma pixels even when dimensions are odd.
  let point=uv*vec2f(textureDimensions(luma))*0.5-0.5;
  let base=vec2i(floor(point));
  let weight=fract(point);
  let a=f32(textureLoad(plane,clamp(base,vec2i(0),dimensions-1),0).r);
  let b=f32(textureLoad(plane,clamp(base+vec2i(1,0),vec2i(0),dimensions-1),0).r);
  let c=f32(textureLoad(plane,clamp(base+vec2i(0,1),vec2i(0),dimensions-1),0).r);
  let d=f32(textureLoad(plane,clamp(base+vec2i(1,1),vec2i(0),dimensions-1),0).r);
  return (mix(mix(a,b,weight.x),mix(c,d,weight.x),weight.y)-512.0)/896.0;
}
@fragment fn fs(vertex: Vertex) -> @location(0) vec4f {
  let dimensions=vec2i(textureDimensions(luma));
  let pixel=clamp(vec2i(vertex.uv*vec2f(dimensions)),vec2i(0),dimensions-1);
  let y=(f32(textureLoad(luma,pixel,0).r)-64.0)/876.0;
  let u=chroma(cb,vertex.uv);
  let v=chroma(cr,vertex.uv);
  return present_pq(vec3f(y+1.4746*v,y-0.164553*u-0.571353*v,y+1.8814*u));
}`

type Job = { video: VideoFrame; view: () => GPUTextureView; active: () => boolean; resolve: () => void; reject: (error: unknown) => void }

/** Exact integer-plane upload when a browser's external import converts HDR
 * through RGB8 or mishandles its matrix. One active copy and one latest frame
 * per canvas bound retained decoder frames, memory and latency. */
export class HdrPlanes {
  #device: GPUDevice
  #pipeline: GPURenderPipeline
  #textures: GPUTexture[] = []
  #shape = ""
  #data = new Uint8Array(0)
  #pending: Job | null = null
  #running = false
  #destroyed = false

  constructor(device: GPUDevice, pipeline: GPURenderPipeline) { this.#device = device; this.#pipeline = pipeline }

  static async pipeline(device: GPUDevice): Promise<GPURenderPipeline> {
    const module = device.createShaderModule({ code: shader })
    return device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float" }] }, primitive: { topology: "triangle-list" } })
  }

  draw(video: VideoFrame, view: () => GPUTextureView, active: () => boolean): Promise<void> {
    if (this.#destroyed) return Promise.reject(new Error("HDR plane uploader destroyed"))
    // Clone synchronously: callers may close the decoder frame immediately.
    const owned = video.clone()
    return new Promise((resolve, reject) => {
      this.#pending?.video.close()
      this.#pending?.resolve()
      this.#pending = { video: owned, view, active, resolve, reject }
      if (!this.#running) void this.#drain()
    })
  }

  async #drain(): Promise<void> {
    this.#running = true
    while (this.#pending) {
      const job = this.#pending
      this.#pending = null
      try {
        if (this.#destroyed || !job.active()) { job.resolve(); continue }
        const format = String(job.video.format)
        if (format !== "I420P10") throw new Error(`HDR requires accessible 10-bit planes, got ${format}`)
        const rect = job.video.visibleRect
        if (!rect) throw new Error("HDR frame is closed")
        const width = rect.width, height = rect.height
        const sizes = [[width,height], [Math.ceil(width/2),Math.ceil(height/2)]]
        const bytes = job.video.allocationSize()
        if (this.#data.length < bytes || this.#data.length > bytes*2) this.#data = new Uint8Array(bytes)
        const layout = await job.video.copyTo(this.#data)
        if (this.#destroyed || !job.active()) { job.resolve(); continue }
        const shape = `${width}x${height}`
        if (this.#shape !== shape) {
          for (const texture of this.#textures) texture.destroy()
          this.#textures = [0,1,2].map(plane => this.#device.createTexture({ size: sizes[plane === 0 ? 0 : 1]!, format: "r16uint", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING }))
          this.#shape = shape
        }
        for (let plane = 0; plane < 3; plane++) {
          const dimensions = sizes[plane === 0 ? 0 : 1]!
          this.#device.queue.writeTexture({ texture: this.#textures[plane]! }, this.#data, { offset: layout[plane]!.offset, bytesPerRow: layout[plane]!.stride }, { width: dimensions[0]!, height: dimensions[1]! })
        }
        const group = this.#device.createBindGroup({ layout: this.#pipeline.getBindGroupLayout(0), entries: this.#textures.map((texture,binding) => ({ binding, resource: texture.createView() })) })
        const encoder = this.#device.createCommandEncoder()
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: job.view(), loadOp: "clear", storeOp: "store", clearValue: [0,0,0,1] }] })
        pass.setPipeline(this.#pipeline); pass.setBindGroup(0,group); pass.draw(3); pass.end()
        this.#device.queue.submit([encoder.finish()])
        job.resolve()
      } catch (error) { job.reject(error) }
      finally { job.video.close() }
    }
    this.#running = false
  }

  destroy(): void {
    this.#destroyed = true
    this.#pending?.video.close(); this.#pending?.resolve(); this.#pending = null
    for (const texture of this.#textures) texture.destroy()
    this.#textures = []; this.#data = new Uint8Array(0)
  }
}
