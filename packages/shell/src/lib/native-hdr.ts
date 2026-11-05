import { performanceStats, observe, count, inheritTiming, renderStarted, renderFinished } from "./performance"
import { log } from "./log"

type VideoGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> }
type GeneratorConstructor = new (options: { kind: "video" }) => VideoGenerator
function generatorConstructor(): GeneratorConstructor | undefined {
  return (globalThis as typeof globalThis & { MediaStreamTrackGenerator?: GeneratorConstructor }).MediaStreamTrackGenerator
}

export function nativeVideoAvailable(): boolean { return !!generatorConstructor() }
export function nativeHdrMetadata(video: VideoFrame): boolean {
  const color = video.colorSpace
  return String(color.primaries) === "bt2020" && String(color.transfer) === "pq"
    && String(color.matrix) === "bt2020-ncl" && color.fullRange === false
}

/** Opaque hardware frames retain their HDR metadata in native video playback.
 * They cannot be read as planes or imported through a tone-mapping GPU path. */
export function needsNativeHdr(video: VideoFrame): boolean {
  return video.format === null && nativeHdrMetadata(video) && nativeVideoAvailable()
}

type Job = { frame: VideoFrame; resolve: () => void; reject: (error: unknown) => void }

/** At most one write and one latest frame, independent of decoder ownership. */
export class NativeHdrPresenter {
  #video: HTMLVideoElement
  #track: VideoGenerator
  #writer: WritableStreamDefaultWriter<VideoFrame>
  #ready: Promise<void>
  #pending: Job | null = null
  #running = false
  #destroyed = false
  #videoCallback: number | null = null
  #lastPresented: number | null = null
  #lastDropped = 0
  #unsubscribe: () => void

  constructor(video: HTMLVideoElement, failed: (reason: string) => void) {
    const Generator = generatorConstructor()
    if (!Generator) throw new Error("native HDR video generator unavailable")
    this.#video = video
    this.#track = new Generator({ kind: "video" })
    this.#writer = this.#track.writable.getWriter()
    video.muted = true
    video.playsInline = true
    video.srcObject = new MediaStream([this.#track])
    // Let the media element attach its sink before writing an idle window's
    // first (and possibly only) frame; generators do not retain old frames.
    this.#ready = new Promise(resolve => setTimeout(resolve, 0))
    void video.play().catch(error => { if (!this.#destroyed) failed(`native video playback: ${String(error)}`) })
    this.#unsubscribe=performanceStats.subscribe(()=>this.#watchPresentation())
    this.#watchPresentation()
    log("info", "[presentation] native video presenter started")
  }

  draw(video: VideoFrame): Promise<void> {
    if (this.#destroyed) return Promise.resolve()
    // Rebase on arrival time: decoder timestamps advance only on submitted
    // frames, so idle applications otherwise leave playback far in the past.
    const frame = new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) })
    inheritTiming(video,frame)
    return new Promise((resolve, reject) => {
      if(this.#pending)count("nativeReplaced")
      this.#pending?.frame.close()
      this.#pending?.resolve()
      this.#pending = { frame, resolve, reject }
      if (!this.#running) void this.#drain()
    })
  }

  async #drain(): Promise<void> {
    this.#running = true
    while (this.#pending) {
      const job = this.#pending
      this.#pending = null
      try {
        await this.#ready
        if (!this.#destroyed) {
          const started=renderStarted(job.frame)
          await this.#writer.write(job.frame)
          renderFinished(job.frame,started,true)
        }
        job.resolve()
      } catch (error) { if (this.#destroyed) job.resolve(); else job.reject(error) }
      finally { job.frame.close() }
    }
    this.#running = false
  }

  #watchPresentation(): void {
    if(!performanceStats.enabled||this.#destroyed) {
      if(this.#videoCallback!==null)this.#video.cancelVideoFrameCallback?.(this.#videoCallback)
      this.#videoCallback=null;this.#lastPresented=null
      this.#lastDropped=this.#video.getVideoPlaybackQuality?.().droppedVideoFrames??0
      return
    }
    if(this.#videoCallback!==null||typeof this.#video.requestVideoFrameCallback!=="function")return
    this.#videoCallback=this.#video.requestVideoFrameCallback(now=>{
      this.#videoCallback=null
      if(this.#lastPresented!==null)observe("videoCallback",now-this.#lastPresented)
      this.#lastPresented=now
      const dropped=this.#video.getVideoPlaybackQuality?.().droppedVideoFrames??0
      if(dropped>=this.#lastDropped)count("nativeDropped",dropped-this.#lastDropped)
      this.#lastDropped=dropped
      this.#watchPresentation()
    })
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#unsubscribe()
    this.#watchPresentation()
    this.#pending?.frame.close()
    this.#pending?.resolve()
    this.#pending = null
    this.#video.pause()
    this.#video.srcObject = null
    this.#track.stop()
    void this.#writer.abort().catch(() => {})
  }
}
