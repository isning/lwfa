import { useSyncExternalStore } from "react"
import type {
  PerformanceReport,
  PerformanceStage,
  DecodedFrame,
} from "@lwfa/proto"
import { FrameFormat } from "@lwfa/proto"

export const METRICS = {
  controlRtt: { label: "Control round trip", group: "network", unit: "ms" },
  transportRtt: { label: "Transport round trip", group: "network", unit: "ms" },
  controlQueue: { label: "Server control queue", group: "server", unit: "ms" },
  inputDispatch: {
    label: "Server input dispatch",
    group: "server",
    unit: "ms",
  },
  captureGap: {
    label: "Server capture interval",
    group: "cadence",
    unit: "ms",
  },
  capture: { label: "Capture call / GPU wait", group: "server", unit: "ms" },
  encoderQueue: { label: "Encoder queue", group: "server", unit: "ms" },
  encode: {
    label: "Encode (includes session open)",
    group: "server",
    unit: "ms",
  },
  encoderOpen: { label: "Encoder session open", group: "server", unit: "ms" },
  encoderSubmit: {
    label: "Encoder frame submission",
    group: "server",
    unit: "ms",
  },
  encoderOutput: {
    label: "Bitstream retrieval / processing",
    group: "server",
    unit: "ms",
  },
  sendQueue: { label: "Server send queue", group: "network", unit: "ms" },
  websocketFlush: {
    label: "WebSocket write → kernel flush",
    group: "network",
    unit: "ms",
  },
  datagramSend: {
    label: "QUIC fragment enqueue",
    group: "network",
    unit: "ms",
  },
  reassembly: { label: "Fragment assembly", group: "network", unit: "ms" },
  reorder: {
    label: "Complete-frame reorder wait",
    group: "network",
    unit: "ms",
  },
  decode: { label: "Decode submit → output", group: "client", unit: "ms" },
  convert: { label: "VideoFrame → bitmap", group: "client", unit: "ms" },
  frameWait: { label: "Drawable → renderer wait", group: "client", unit: "ms" },
  render: {
    label: "Canvas draw / upload / submit",
    group: "client",
    unit: "ms",
  },
  nativeWrite: { label: "Native video write", group: "client", unit: "ms" },
  receiveToSubmit: {
    label: "Receive → render submission",
    group: "client",
    unit: "ms",
  },
  arrivalGap: {
    label: "Per-window arrival interval",
    group: "cadence",
    unit: "ms",
  },
  videoCallback: {
    label: "Native video callback interval",
    group: "cadence",
    unit: "ms",
  },
  rafGap: { label: "Browser animation interval", group: "cadence", unit: "ms" },
  longTask: { label: "Browser long task", group: "cadence", unit: "ms" },
  audioCaptureWait: {
    label: "Server audio read wait",
    group: "audio",
    unit: "ms",
  },
  audioEncode: { label: "Server Opus encode", group: "audio", unit: "ms" },
  audioDecode: { label: "Audio decode", group: "audio", unit: "ms" },
  audioSend: { label: "Server audio enqueue", group: "audio", unit: "ms" },
  audioBuffer: { label: "Audio playback buffer", group: "audio", unit: "ms" },
} as const
export type Metric = keyof typeof METRICS
export const COUNTERS = {
  capturedFrames: "Server captures",
  encodedFrames: "Server encodes",
  encoderOpens: "Encoder opens",
  encodeFailures: "Encode failures",
  encoderDrops: "Encoder queue drops",
  sendBackpressure: "Send admission skips",
  sendExpired: "QUIC send failures / expiry",
  receiptTimeouts: "Receipt timeouts",
  probeTimeouts: "Unanswered diagnostic probes",
  incompleteFrames: "Incomplete / expired media",
  dependencyDrops: "Dependency drops",
  recoveries: "Keyframe requests",
  duplicateFragments: "Duplicate fragments",
  nativeReplaced: "Native queue replacements",
  nativeDropped: "Native playback drops",
  audioUnderruns: "Audio underruns",
  decodeFailures: "Terminal decoder/config failures",
  receivedFrames: "Received frames",
  renderedFrames: "First frame submissions",
  redraws: "Cached frame redraws",
} as const
export type Counter = keyof typeof COUNTERS
export interface Distribution {
  samples: number
  p50: number
  p95: number
  max: number
}
export interface PerformancePoint {
  at: number
  stages: Partial<Record<Metric, Distribution>>
  counters: Partial<Record<Counter, number>>
  fps: number
  kbits: number
  bufferedKiB: number
  video?: VideoSample | null
}
export interface VideoSample {
  window: number
  width: number
  height: number
  codec: string
  receivedAt: number
}
export interface PerformanceSnapshot {
  enabled: boolean
  server: "off" | "checking" | "supported" | "unsupported" | "waiting"
  points: readonly PerformancePoint[]
  totals: Partial<Record<Counter, number>>
}
const HISTORY = 300,
  SAMPLES = 256,
  RECENT = 2000
const isMetric = (key: string): key is Metric => Object.hasOwn(METRICS, key)
const isCounter = (key: string): key is Counter => Object.hasOwn(COUNTERS, key)
function distribution(values: number[]): Distribution | undefined {
  if (!values.length) return undefined
  values.sort((a, b) => a - b)
  const at = (p: number) =>
    values[Math.max(0, Math.ceil(values.length * p) - 1)]!
  return {
    samples: values.length,
    p50: at(0.5),
    p95: at(0.95),
    max: values.at(-1)!,
  }
}
/** Bounded local recorder; independent clock input keeps timeline tests deterministic. */
export class PerformanceRecorder {
  enabled = false
  #samples = new Map<Metric, { at: number; value: number }[]>()
  #counts: Partial<Record<Counter, number>> = {}
  #previous: Partial<Record<Counter, number>> = {}
  #remoteBaseline: Partial<Record<Counter, number>> = {}
  #remoteCounts: Partial<Record<Counter, number>> = {}
  #server: { at: number; stages: PerformanceStage[] } | null = null
  #history: PerformancePoint[] = []
  #state: PerformanceSnapshot = {
    enabled: false,
    server: "off",
    points: [],
    totals: {},
  }
  #listeners = new Set<() => void>()
  #status: PerformanceSnapshot["server"] = "off"
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.#status = enabled ? "checking" : "off"
    this.#publish()
  }
  status(value: PerformanceSnapshot["server"]): void {
    if (this.#status === value) return
    this.#status = value
    this.#publish()
  }
  observe(name: Metric, value: number, at: number): void {
    if (!this.enabled || !Number.isFinite(value) || value < 0) return
    const samples = this.#samples.get(name) ?? []
    if (samples.length === SAMPLES) samples.shift()
    samples.push({ at, value })
    this.#samples.set(name, samples)
  }
  count(name: Counter, amount = 1): void {
    if (this.enabled && Number.isSafeInteger(amount) && amount > 0)
      this.#counts[name] = (this.#counts[name] ?? 0) + amount
  }
  server(report: PerformanceReport, at: number, rtt: number): void {
    if (!this.enabled) return
    this.#status = "supported"
    this.#server = { at, stages: report.stages }
    this.observe("controlRtt", rtt, at)
    if (report.transportRttMs !== null)
      this.observe("transportRtt", report.transportRttMs, at)
    for (const counter of report.counters)
      if (isCounter(counter.name)) {
        const name = counter.name,
          old = this.#remoteCounts[name]
        if (old === undefined || counter.value < old)
          this.#remoteBaseline[name] = counter.value
        this.#remoteCounts[name] = counter.value
      }
  }
  tick(
    at: number,
    gauges: Pick<
      PerformancePoint,
      "fps" | "kbits" | "bufferedKiB" | "video"
    > = { fps: 0, kbits: 0, bufferedKiB: 0 },
  ): void {
    if (!this.enabled) return
    const stages: PerformancePoint["stages"] = {}
    for (const [name, samples] of this.#samples) {
      const recent = samples.filter((s) => at - s.at <= RECENT)
      this.#samples.set(name, recent)
      const stats = distribution(recent.map((s) => s.value))
      if (stats) stages[name] = stats
    }
    if (this.#server && at - this.#server.at <= 3000) {
      for (const s of this.#server.stages)
        if (isMetric(s.name))
          stages[s.name] = {
            samples: s.samples,
            p50: s.p50,
            p95: s.p95,
            max: s.max,
          }
    } else if (this.#status === "supported") this.#status = "waiting"
    const totals = { ...this.#counts }
    for (const [key, value] of Object.entries(this.#remoteCounts))
      if (isCounter(key))
        totals[key] =
          (totals[key] ?? 0) + value - (this.#remoteBaseline[key] ?? value)
    const counters: PerformancePoint["counters"] = {}
    for (const [name, value] of Object.entries(totals))
      if (isCounter(name))
        counters[name] = Math.max(0, value - (this.#previous[name] ?? 0))
    this.#previous = totals
    this.#history = [
      ...this.#history
        .filter((point) => at - point.at < 300000)
        .slice(-(HISTORY - 1)),
      { at, stages, counters, ...gauges },
    ]
    this.#state = {
      enabled: this.enabled,
      server: this.#status,
      points: this.#history,
      totals,
    }
    this.#notify()
  }
  clear(): void {
    this.#samples.clear()
    this.#counts = {}
    this.#previous = {}
    this.#remoteBaseline = { ...this.#remoteCounts }
    this.#server = null
    this.#history = []
    this.#state = { ...this.#state, totals: {} }
    this.#publish()
  }
  reconnect(): void {
    this.#server = null
    if (this.enabled) this.status("checking")
  }
  #publish(): void {
    this.#state = {
      enabled: this.enabled,
      server: this.#status,
      points: this.#history,
      totals: this.#state.totals,
    }
    this.#notify()
  }
  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
  snapshot = (): PerformanceSnapshot => this.#state
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
export const performanceStats = new PerformanceRecorder()
export function usePerformance(): PerformanceSnapshot {
  return useSyncExternalStore(
    performanceStats.subscribe,
    performanceStats.snapshot,
    performanceStats.snapshot,
  )
}
export function observe(name: Metric, ms: number): void {
  performanceStats.observe(name, ms, performance.now())
}
export function count(name: Counter, amount = 1): void {
  performanceStats.count(name, amount)
}
export interface FrameTiming {
  epoch: number
  received: number
  decoded?: number
  ready?: number
  submitted?: number
}
interface RenderTiming {
  started: number
  trace: FrameTiming
  ready: number | undefined
}
let timingEpoch = 0
let timings = new WeakMap<object, FrameTiming>()
const arrivals = new Map<number, number>()
let lastVideo: VideoSample | null = null
const CODEC_NAMES = {
  [FrameFormat.Jpeg]: "JPEG",
  [FrameFormat.H264]: "H.264",
  [FrameFormat.Hevc]: "HEVC",
  [FrameFormat.HevcHdr]: "HEVC Main10 HDR",
}
export function latestVideoSample(): VideoSample | null {
  return lastVideo
}
export function frameReceived(frame: DecodedFrame): void {
  if (!performanceStats.enabled) return
  const now = performance.now(),
    last = arrivals.get(frame.header.window)
  if (last !== undefined) observe("arrivalGap", now - last)
  if (arrivals.size >= 128) arrivals.delete(arrivals.keys().next().value!)
  arrivals.set(frame.header.window, now)
  const { width, height, format, window } = frame.header
  if (width > 0 && height > 0)
    lastVideo = {
      window,
      width,
      height,
      codec: CODEC_NAMES[format],
      receivedAt: now,
    }
  timings.set(frame, { epoch: timingEpoch, received: now })
  count("receivedFrames")
}
export function timing(frame: object): FrameTiming | undefined {
  const trace = performanceStats.enabled ? timings.get(frame) : undefined
  return trace?.epoch === timingEpoch ? trace : undefined
}
export function inheritTiming(source: object, target: object): void {
  const trace = timing(source)
  if (trace) timings.set(target, trace)
}
export function decodeFinished(
  frame: object,
  trace: FrameTiming | undefined,
  started: number,
): void {
  if (!trace || trace.epoch !== timingEpoch || !performanceStats.enabled) return
  const now = performance.now()
  observe("decode", now - started)
  trace.decoded = now
  trace.ready = now
  timings.set(frame, trace)
}
export function converted(
  source: object,
  target: object,
  started: number,
): void {
  const trace = timing(source)
  if (!trace) return
  observe("convert", performance.now() - started)
  trace.ready = performance.now()
  timings.set(target, trace)
}
export function renderStarted(frame: object): RenderTiming | undefined {
  const trace = timing(frame)
  if (!trace) return undefined
  return { started: performance.now(), trace, ready: trace.ready }
}
export function renderFinished(
  frame: object,
  submission: RenderTiming | undefined,
  native = false,
): void {
  if (!submission || timing(frame) !== submission.trace) return
  const now = performance.now()
  observe(native ? "nativeWrite" : "render", now - submission.started)
  const trace = submission.trace
  // Aliases and cloned VideoFrames share a trace. Only the first successful
  // submission measures a new frame; a later repaint is the age of cached art.
  if (trace.submitted === undefined) {
    trace.submitted = now
    if (submission.ready !== undefined)
      observe("frameWait", submission.started - submission.ready)
    observe("receiveToSubmit", now - trace.received)
    count("renderedFrames")
  } else count("redraws")
}
export function resetFrameTimings(): void {
  timingEpoch++
  timings = new WeakMap()
  arrivals.clear()
  lastVideo = null
}
export function exportPerformance(snapshot: PerformanceSnapshot): string {
  return JSON.stringify(
    {
      version: 2,
      recordedAt: new Date().toISOString(),
      timeOrigin: performance.timeOrigin,
      units: "milliseconds unless labelled otherwise",
      scope:
        "Server stages are process-wide; client stages are this tab. Frame waiting/age and renderedFrames measure first successful submissions only; cached redraws are separate. Submission/callback timing is not physical screen presentation. No exact one-way network or application latency is measured.",
      ...snapshot,
    },
    null,
    2,
  )
}

let bufferedKiB = 0
export function mediaBuffered(bytes: number): void {
  bufferedKiB = Math.max(0, bytes / 1024)
}
export function bufferedMediaKiB(): number {
  return bufferedKiB
}
