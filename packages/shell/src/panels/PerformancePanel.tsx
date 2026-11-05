import { useState } from "react"
import { Download, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { FieldRow, PanelGroup, PanelSection } from "./parts"
import { patchPrefs, usePrefs } from "@/lib/prefs"
import {
  COUNTERS,
  METRICS,
  usePerformance,
  performanceStats,
  resetFrameTimings,
  exportPerformance,
  type Metric,
  type Counter,
  type PerformancePoint,
} from "@/lib/performance"
import type { ChartScale } from "@/lib/performanceChart"
import { PerformanceChart, formatValue, sampleClock } from "./PerformanceChart"
import { cn } from "@/lib/utils"

const VIEWS = {
  processing: {
    title: "Overview",
    keys: ["encode", "capture", "decode", "frameWait", "nativeWrite", "render"],
    hint: "Independent stage distributions; do not add their percentiles. Submission timing stops before physical display.",
  },
  encoder: {
    title: "Encoder",
    keys: [
      "encode",
      "encoderQueue",
      "encoderOpen",
      "encoderSubmit",
      "encoderOutput",
    ],
    hint: "Session open, submission and bitstream output are parts of Encode, not additional delay. Near-zero queueing does not rule out capture being skipped while the encoder is busy.",
  },
  client: {
    title: "Browser",
    keys: [
      "decode",
      "convert",
      "frameWait",
      "nativeWrite",
      "render",
      "receiveToSubmit",
    ],
    hint: "Waiting and receive-to-submission measure the first successful submission of each new frame. Cached redraws are counted separately.",
  },
  network: {
    title: "Transport",
    keys: [
      "controlRtt",
      "transportRtt",
      "sendQueue",
      "datagramSend",
      "websocketFlush",
      "reassembly",
      "reorder",
    ],
    hint: "RTT is round trip. Enqueue/flush stops at the local transport; reassembly combines audio and video. These are not one-way latency or a packet-loss percentage.",
  },
  control: {
    title: "Input / control",
    keys: ["controlRtt", "controlQueue", "inputDispatch"],
    hint: "Dispatch ends in the compositor, before the application handles input. Control RTT includes transport and handling.",
  },
  cadence: {
    title: "Frame intervals",
    keys: ["captureGap", "arrivalGap", "videoCallback", "rafGap", "longTask"],
    hint: "Idle applications naturally have long capture/arrival/video callback gaps. Long tasks are browser observations, not custom fault classifications.",
  },
  audio: {
    title: "Audio",
    keys: [
      "audioBuffer",
      "audioCaptureWait",
      "audioEncode",
      "audioDecode",
      "audioSend",
    ],
    hint: "Playback buffer contributes local audio delay. Capture read wait includes the normal PCM chunk production period; it is not CPU encoding time.",
  },
} satisfies Record<string, { title: string; keys: Metric[]; hint: string }>
const EVENTS = {
  frames: {
    title: "Frame flow",
    keys: [
      "receivedFrames",
      "renderedFrames",
      "redraws",
      "nativeReplaced",
      "nativeDropped",
    ],
  },
  transport: {
    title: "Transport",
    keys: [
      "sendExpired",
      "receiptTimeouts",
      "incompleteFrames",
      "dependencyDrops",
      "recoveries",
    ],
  },
  encoder: {
    title: "Encoder",
    keys: [
      "encoderOpens",
      "encoderDrops",
      "encodeFailures",
      "sendBackpressure",
    ],
  },
  audio: { title: "Audio", keys: ["audioUnderruns", "probeTimeouts"] },
} satisfies Record<string, { title: string; keys: Counter[] }>
type View = keyof typeof VIEWS
type Statistic = "p50" | "p95" | "max"
const selectClass =
  "min-h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs"

export function PerformancePanel() {
  const { stream } = usePrefs(),
    state = usePerformance()
  const [view, setView] = useState<View>("processing")
  const [statistic, setStatistic] = useState<Statistic>("p95")
  const [seconds, setSeconds] = useState(60)
  const [scale, setScale] = useState<ChartScale>("linear")
  const [selectedAt, setSelectedAt] = useState<number | null>(null)
  const [events, setEvents] = useState<keyof typeof EVENTS>("frames")
  const latest = state.points.at(-1)
  const inspected =
    selectedAt === null
      ? latest
      : state.points.find((point) => point.at === selectedAt)
  const duration =
    latest && state.points[0] ? (latest.at - state.points[0].at) / 1000 : 0
  const sampled = (Object.keys(METRICS) as Metric[]).filter(
    (key) => inspected?.stages[key],
  )
  const exportData = () => {
    const url = URL.createObjectURL(
      new Blob([exportPerformance(state)], { type: "application/json" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = `lwfa-performance-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const clear = () => {
    setSelectedAt(null)
    resetFrameTimings()
    performanceStats.clear()
  }
  return (
    <PanelSection
      title="Performance"
      description="Trace stage costs and frame flow. Recording stays on when this panel closes."
    >
      <PanelGroup>
        <FieldRow className="py-2.5">
          <div>
            <div className="text-sm font-medium">Record diagnostics</div>
            <p className="text-xs text-muted-foreground">
              One-second samples · five-minute history
            </p>
          </div>
          <Switch
            checked={stream.diagnostics}
            onCheckedChange={(diagnostics) =>
              patchPrefs("stream", { diagnostics })
            }
            aria-label="Record performance diagnostics"
          />
        </FieldRow>
        {!state.enabled && state.points.length === 0 ? (
          <p className="border-t border-border px-3 py-3 text-xs leading-relaxed text-muted-foreground">
            Enable recording, then interact with an application. Charts show
            measured costs and intervals; an idle window may produce no new
            video samples.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    state.enabled ? "bg-primary" : "bg-muted-foreground",
                  )}
                />
                {state.enabled ? "Recording" : "Paused"} ·{" "}
                {state.server === "supported"
                  ? "Server + browser"
                  : state.server === "waiting"
                    ? "Waiting for server"
                    : state.server === "checking"
                      ? "Checking server"
                      : "Browser only"}
              </span>
              <span className="font-mono">
                {state.points.length} points ·{" "}
                {duration < 60
                  ? `${Math.round(duration)}s`
                  : `${Math.floor(duration / 60)}m ${Math.round(duration % 60)}s`}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
              <span className="min-w-0 text-[11px] text-muted-foreground">
                {selectedAt === null ? "Latest sample" : "Pinned sample"} ·{" "}
                <span className="font-mono">
                  {inspected
                    ? sampleClock(inspected.at)
                    : selectedAt === null
                      ? "Waiting"
                      : "Expired"}
                </span>
              </span>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-[11px]"
                  onClick={exportData}
                  disabled={!state.points.length}
                  aria-label="Export performance JSON"
                >
                  <Download className="size-3.5" aria-hidden />
                  JSON
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-[11px]"
                  onClick={clear}
                  aria-label="Clear performance recording"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Clear
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border px-3 py-3">
              <NumberReadout
                label="Encode · P95"
                value={formatValue(inspected?.stages.encode?.p95)}
                unit="ms"
              />
              <NumberReadout
                label="Receive → first submit · P95"
                value={formatValue(inspected?.stages.receiveToSubmit?.p95)}
                unit="ms"
              />
              <NumberReadout
                label="Control RTT · P50"
                value={formatValue(inspected?.stages.controlRtt?.p50)}
                unit="ms"
              />
              <NumberReadout
                label="Decoded frame rate"
                value={inspected ? String(inspected.fps) : "—"}
                unit="fps"
              />
            </div>
            <div className="space-y-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              {inspected?.video ? (
                <p className="font-mono">
                  Last video · {inspected.video.width}×{inspected.video.height}{" "}
                  · {inspected.video.codec} · w{inspected.video.window}
                </p>
              ) : (
                <p>No video frame metadata in this sample</p>
              )}
              {inspected && (
                <p className="font-mono">
                  {inspected.kbits.toLocaleString()} kbit/s ·{" "}
                  {inspected.bufferedKiB.toFixed(1)} KiB buffered media
                </p>
              )}
              {inspected && !inspected.counters.receivedFrames && (
                <p>No new video frames counted in this sample.</p>
              )}
            </div>
            <div className="space-y-3 border-t border-border px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-xs font-medium">Stage timings</h4>
                <span className="text-[10px] text-muted-foreground">
                  Click or use slider to pin
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-[10px] text-muted-foreground">
                  Stage group
                  <select
                    className={`${selectClass} block w-full text-foreground`}
                    aria-label="Performance chart group"
                    value={view}
                    onChange={(event) => setView(event.target.value as View)}
                  >
                    {Object.entries(VIEWS).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-[10px] text-muted-foreground">
                  Statistic
                  <select
                    className={`${selectClass} block w-full text-foreground`}
                    aria-label="Performance chart statistic"
                    value={statistic}
                    onChange={(event) =>
                      setStatistic(event.target.value as Statistic)
                    }
                  >
                    <option value="p50">P50 · median</option>
                    <option value="p95">P95</option>
                    <option value="max">Maximum</option>
                  </select>
                </label>
                <label className="space-y-1 text-[10px] text-muted-foreground">
                  History
                  <select
                    className={`${selectClass} block w-full text-foreground`}
                    aria-label="Performance history range"
                    value={seconds}
                    onChange={(event) => setSeconds(Number(event.target.value))}
                  >
                    <option value={60}>Last minute</option>
                    <option value={300}>Last five minutes</option>
                  </select>
                </label>
                <label className="space-y-1 text-[10px] text-muted-foreground">
                  Scale
                  <select
                    className={`${selectClass} block w-full text-foreground`}
                    aria-label="Performance chart scale"
                    value={scale}
                    onChange={(event) =>
                      setScale(event.target.value as ChartScale)
                    }
                  >
                    <option value="linear">Linear</option>
                    <option value="log">Log · keep spikes visible</option>
                  </select>
                </label>
              </div>
              <PerformanceChart
                points={state.points}
                series={VIEWS[view].keys.map((key) => ({
                  key,
                  label: METRICS[key].label,
                  read: (point) => point.stages[key]?.[statistic],
                }))}
                seconds={seconds}
                scale={scale}
                selectedAt={selectedAt}
                onSelect={setSelectedAt}
                unit="ms"
                title={`${VIEWS[view].title} latency`}
                reference={
                  view === "encoder" ||
                  view === "processing" ||
                  view === "cadence"
                    ? 1000 / 60
                    : undefined
                }
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {VIEWS[view].hint}
              </p>
              {scale === "log" && (
                <p className="text-[10px] text-muted-foreground">
                  Log(1 + ms) keeps zero visible while compressing large spikes.
                  Values and exports remain unchanged.
                </p>
              )}
            </div>
            <details className="border-t border-border">
              <summary className="min-h-11 cursor-pointer px-3 py-3 text-xs font-medium">
                Stage breakdown{" "}
                <span className="ml-1 font-mono text-[10px] font-normal text-muted-foreground">
                  {sampled.length} measured
                </span>
              </summary>
              <div className="overflow-x-auto px-3 pb-3">
                <p className="pb-2 text-[10px] text-muted-foreground">
                  {selectedAt === null ? "Latest" : "Pinned"} sample ·{" "}
                  {inspected ? sampleClock(inspected.at) : "expired"} · rolling
                  two-second windows
                </p>
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="border-b border-border text-right text-muted-foreground">
                      <th className="pb-2 text-left font-normal">Stage · ms</th>
                      <th className="pb-2 font-normal">P50</th>
                      <th className="pb-2 font-normal">P95</th>
                      <th className="pb-2 font-normal">Max</th>
                      <th className="pb-2 pl-2 font-normal">N</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sampled.map((key) => {
                      const sample = inspected!.stages[key]!
                      return (
                        <tr
                          key={key}
                          className="border-b border-border/40 last:border-0"
                        >
                          <td className="py-2 pr-2 text-muted-foreground">
                            {METRICS[key].label}
                          </td>
                          <td className="text-right font-mono">
                            {formatValue(sample.p50)}
                          </td>
                          <td className="text-right font-mono">
                            {formatValue(sample.p95)}
                          </td>
                          <td className="text-right font-mono">
                            {formatValue(sample.max)}
                          </td>
                          <td className="pl-2 text-right font-mono text-muted-foreground">
                            {sample.samples}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {!sampled.length && (
                  <p className="py-3 text-xs text-muted-foreground">
                    No stage measurements in this sample.
                  </p>
                )}
                <p className="pt-2 text-[10px] text-muted-foreground">
                  At most 256 observations per stage. Missing or stale stages
                  are omitted; these are independent distributions, not additive
                  frame traces.
                </p>
              </div>
            </details>
            <details className="border-t border-border">
              <summary className="min-h-11 cursor-pointer px-3 py-3 text-xs font-medium">
                Frame flow & events
              </summary>
              <div className="space-y-3 px-3 pb-3">
                <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
                  {(
                    ["receivedFrames", "renderedFrames", "redraws"] as const
                  ).map((key) => (
                    <div key={key}>
                      <div className="font-mono text-lg text-foreground">
                        {(state.totals[key] ?? 0).toLocaleString()}
                      </div>
                      {COUNTERS[key]}
                    </div>
                  ))}
                </div>
                <select
                  className={selectClass}
                  aria-label="Performance event group"
                  value={events}
                  onChange={(event) =>
                    setEvents(event.target.value as keyof typeof EVENTS)
                  }
                >
                  {Object.entries(EVENTS).map(([key, value]) => (
                    <option key={key} value={key}>
                      {value.title}
                    </option>
                  ))}
                </select>
                <PerformanceChart
                  points={state.points}
                  series={EVENTS[events].keys.map((key) => ({
                    key,
                    label: COUNTERS[key],
                    read: (point: PerformancePoint) => point.counters[key] ?? 0,
                  }))}
                  seconds={seconds}
                  scale="linear"
                  selectedAt={selectedAt}
                  onSelect={setSelectedAt}
                  unit="count"
                  title={`${EVENTS[events].title} counts`}
                  height={160}
                />
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Counts per recorded sample. Intentional replacements, browser
                  playback drops and media send failures have different scopes;
                  counts may overlap and are not a network loss rate.
                </p>
                <details>
                  <summary className="min-h-9 cursor-pointer text-[11px] font-medium">
                    All totals since clear
                  </summary>
                  <dl className="space-y-1 pt-2 text-[11px]">
                    {Object.entries(COUNTERS).map(([key, label]) => (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-3"
                      >
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="font-mono">
                          {(state.totals[key as Counter] ?? 0).toLocaleString()}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </div>
            </details>
            <p className="border-t border-border px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
              Server stages cover this engine process; browser stages cover this
              tab. First submission and video callbacks do not measure physical
              display time. Raw observations only; no automatic fault alerts.
            </p>
          </>
        )}
      </PanelGroup>
    </PanelSection>
  )
}
function NumberReadout({
  label,
  value,
  unit,
}: {
  label: string
  value: string
  unit: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="pt-1 font-mono text-xl leading-none tracking-tight tabular-nums">
        {value}
        <span className="ml-1 text-[10px] text-muted-foreground">{unit}</span>
      </div>
    </div>
  )
}
