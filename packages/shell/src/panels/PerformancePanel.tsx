import { useId, useMemo, useState } from "react"
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
  type PerformancePoint,
} from "@/lib/performance"
import { cn } from "@/lib/utils"

const VIEWS = {
  processing: {
    title: "Processing",
    keys: [
      "capture",
      "encoderQueue",
      "encode",
      "decode",
      "render",
      "nativeWrite",
    ],
  },
  network: {
    title: "Network",
    keys: [
      "controlRtt",
      "transportRtt",
      "sendQueue",
      "datagramSend",
      "websocketFlush",
      "reassembly",
      "reorder",
    ],
  },
  cadence: {
    title: "Frame intervals",
    keys: ["captureGap", "arrivalGap", "videoCallback", "rafGap", "longTask"],
  },
  audio: { title: "Audio", keys: ["audioCaptureWait", "audioEncode", "audioSend", "audioDecode", "audioBuffer"] },
} satisfies Record<string, { title: string; keys: Metric[] }>
const COLORS = [
  "#e68a46",
  "#329fb5",
  "#b88adb",
  "#76a85d",
  "#dc6c87",
  "#7d94df",
  "#aa9b52",
]
const ms = (value: number | undefined) =>
  value === undefined ? "—" : value < 10 ? value.toFixed(2) : value.toFixed(1)
const clock = (at: number) =>
  new Date(performance.timeOrigin + at).toLocaleTimeString(undefined, {
    hour12: false,
  })
type View = keyof typeof VIEWS
type Percentile = "p95" | "max"

export function PerformancePanel() {
  const { stream } = usePrefs()
  const state = usePerformance()
  const [view, setView] = useState<View>("processing")
  const [percentile, setPercentile] = useState<Percentile>("p95")
  const [seconds, setSeconds] = useState(300)
  const latest = state.points.at(-1)
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
  return (
    <PanelSection
      title="Performance"
      description="Local stage timings and server measurements. Up to five minutes of history."
    >
      <PanelGroup>
        <FieldRow>
          <div>
            <div className="text-sm font-medium">Record diagnostics</div>
            <div className="text-xs text-muted-foreground">
              One-second updates · bounded history
            </div>
          </div>
          <Switch
            checked={stream.diagnostics}
            onCheckedChange={(diagnostics) =>
              patchPrefs("stream", { diagnostics })
            }
            aria-label="Record performance diagnostics"
          />
        </FieldRow>
        {(state.enabled || state.points.length > 0) && (
          <>
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
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
                    ? "Waiting for server sample"
                    : state.server === "checking"
                      ? "Checking server support"
                      : "Browser measurements"}
              </span>
              <span className="font-mono">{state.points.length} samples</span>
            </div>
            <div className="grid grid-cols-3 border-t border-border px-3 py-3 text-xs">
              <NumberReadout
                label="CONTROL RTT"
                value={ms(latest?.stages.controlRtt?.p50)}
                unit="ms"
              />
              <NumberReadout
                label="CLIENT → SUBMIT"
                value={ms(latest?.stages.receiveToSubmit?.p95)}
                unit="ms"
              />
              <NumberReadout
                label="RECEIVED"
                value={latest ? String(latest.fps) : "—"}
                unit="fps"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 pt-3">
              <select
                className="min-h-9 rounded-md border border-input bg-background px-2 text-xs"
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
              <select
                className="min-h-9 rounded-md border border-input bg-background px-2 text-xs"
                aria-label="Performance chart statistic"
                value={percentile}
                onChange={(event) =>
                  setPercentile(event.target.value as Percentile)
                }
              >
                <option value="p95">P95</option>
                <option value="max">Maximum</option>
              </select>
              <select
                className="min-h-9 rounded-md border border-input bg-background px-2 text-xs"
                aria-label="Performance history range"
                value={seconds}
                onChange={(event) => setSeconds(Number(event.target.value))}
              >
                <option value={60}>1 min</option>
                <option value={300}>5 min</option>
              </select>
            </div>
            <TrendChart
              points={state.points}
              keys={VIEWS[view].keys}
              statistic={percentile}
              seconds={seconds}
            />
            <div className="space-y-1 px-3 pb-3 text-[11px] leading-relaxed text-muted-foreground">
              {view === "cadence" ? (
                <p>
                  Arrival and video callback gaps include idle applications.
                  Long tasks measure browser work over 50 ms; no automatic stall
                  classification is applied.
                </p>
              ) : view === "network" ? (
                <p>
                  RTT is a round trip. Enqueue/flush stops at the local
                  transport, not at the viewer. Reassembly drops are not a
                  packet-loss percentage.
                </p>
              ) : view === "audio" ? (
                <p>
                  Audio buffer is local playback delay. Decode and enqueue do
                  not include the application or speaker.
                </p>
              ) : (
                <p>
                  Stages are independent samples. Do not add percentiles
                  together. Receive → submission excludes network and
                  application time.
                </p>
              )}
              <p>
                Canvas submission and native-video callbacks do not measure
                physical screen presentation. Server stages cover all windows
                and viewers; browser stages cover this tab.
              </p>
              {latest && (
                <p className="font-mono">
                  {latest.kbits.toLocaleString()} kbit/s ·{" "}
                  {latest.bufferedKiB.toFixed(1)} KiB media awaiting assembly
                </p>
              )}
            </div>
            <details className="border-t border-border">
              <summary className="min-h-10 cursor-pointer px-3 py-2.5 text-xs font-medium">
                Stage breakdown
              </summary>
              <div className="overflow-x-auto px-3 pb-3">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="border-b border-border text-right text-muted-foreground">
                      <th className="pb-2 text-left font-normal">Stage · ms</th>
                      <th className="pb-2 font-normal">P50</th>
                      <th className="pb-2 font-normal">P95</th>
                      <th className="pb-2 font-normal">Max</th>
                      <th className="pb-2 font-normal">N</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(Object.keys(METRICS) as Metric[]).map((key) => {
                      const sample = latest?.stages[key]
                      return (
                        <tr
                          key={key}
                          className="border-b border-border/40 last:border-0"
                        >
                          <td className="py-1.5 pr-2 text-muted-foreground">
                            {METRICS[key].label}
                          </td>
                          <td className="text-right font-mono">
                            {ms(sample?.p50)}
                          </td>
                          <td className="text-right font-mono">
                            {ms(sample?.p95)}
                          </td>
                          <td className="text-right font-mono">
                            {ms(sample?.max)}
                          </td>
                          <td className="pl-2 text-right font-mono text-muted-foreground">
                            {sample?.samples ?? 0}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <p className="pt-2 text-[10px] text-muted-foreground">
                  Rolling two-second windows; at most 256 samples per stage. A
                  dash means unmeasured or stale.
                </p>
              </div>
            </details>
            <details className="border-t border-border">
              <summary className="min-h-10 cursor-pointer px-3 py-2.5 text-xs font-medium">
                Drops, replacements &amp; encoder opens
              </summary>
              <dl className="space-y-1 px-3 pb-3 text-xs">
                {Object.entries(COUNTERS).map(([key, label]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-3"
                  >
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-mono">
                      {state.totals[key as keyof typeof COUNTERS] ?? 0}
                    </dd>
                  </div>
                ))}
              </dl>
              <CounterTrend points={state.points} />
            </details>
            <div className="flex gap-2 border-t border-border px-3 py-2">
              <Button
                variant="outline"
                size="sm"
                onClick={exportData}
                disabled={!state.points.length}
              >
                <Download className="size-3.5" aria-hidden />
                Export JSON
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  resetFrameTimings()
                  performanceStats.clear()
                }}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Clear
              </Button>
            </div>
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
    <div>
      <div className="text-[9px] tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="pt-1 font-mono text-lg leading-none tracking-tight">
        {value}
        <span className="ml-1 text-[10px] text-muted-foreground">{unit}</span>
      </div>
    </div>
  )
}
function TrendChart({
  points,
  keys,
  statistic,
  seconds,
}: {
  points: readonly PerformancePoint[]
  keys: readonly Metric[]
  statistic: Percentile
  seconds: number
}) {
  const id = useId(),
    [cursor, setCursor] = useState<number | null>(null),
    [hidden, setHidden] = useState<Set<Metric>>(() => new Set())
  const end = points.at(-1)?.at ?? 0,
    start = end - seconds * 1000
  const visible = useMemo(
    () => points.filter((point) => point.at >= start),
    [points, start],
  )
  const enabled = keys.filter((key) => !hidden.has(key))
  const max = Math.max(
    1,
    ...visible.flatMap((point) =>
      enabled.map((key) => point.stages[key]?.[statistic] ?? 0),
    ),
  )
  const ceiling = Math.ceil(max / 4) * 4
  const x = (at: number) => 44 + ((at - start) / (seconds * 1000)) * 580
  const y = (value: number) => 150 - (value / ceiling) * 130
  const active =
    visible[Math.min(cursor ?? visible.length - 1, visible.length - 1)]
  const path = (key: Metric) => {
    let previous: number | null = null
    return visible
      .map((point) => {
        const value = point.stages[key]?.[statistic]
        if (value === undefined) {
          previous = null
          return ""
        }
        const command =
          previous === null || point.at - previous > 2500 ? "M" : "L"
        previous = point.at
        return `${command}${x(point.at).toFixed(1)},${y(value).toFixed(1)}`
      })
      .join(" ")
  }
  return (
    <div className="space-y-2 px-3 py-3">
      <svg
        viewBox="0 0 640 180"
        role="img"
        aria-labelledby={`${id}-title ${id}-description`}
        className="w-full overflow-visible"
        onPointerLeave={() => setCursor(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect(),
            time =
              start +
              ((((event.clientX - rect.left) / rect.width) * 640 - 44) / 580) *
                seconds *
                1000
          let index = 0
          for (let i = 1; i < visible.length; i++)
            if (
              Math.abs(visible[i]!.at - time) <
              Math.abs(visible[index]!.at - time)
            )
              index = i
          setCursor(index)
        }}
      >
        <title id={`${id}-title`}>Stage latency trend in milliseconds</title>
        <desc id={`${id}-description`}>
          Last {seconds / 60} minutes,{" "}
          {statistic === "p95" ? "95th percentile" : "maximum"}. Missing samples
          appear as gaps. Use the sample slider for exact values.
        </desc>
        {[0, 1, 2, 3, 4].map((tick) => (
          <g key={tick}>
            <line
              x1="44"
              x2="624"
              y1={y((ceiling * tick) / 4)}
              y2={y((ceiling * tick) / 4)}
              stroke="currentColor"
              opacity=".09"
            />
            <text
              x="38"
              y={y((ceiling * tick) / 4) + 3}
              textAnchor="end"
              fill="currentColor"
              opacity=".55"
              fontSize="14"
              fontFamily="monospace"
            >
              {Number(((ceiling * tick) / 4).toFixed(1))}
            </text>
          </g>
        ))}
        {keys.map(
          (key, index) =>
            !hidden.has(key) && (
              <path
                key={key}
                d={path(key)}
                fill="none"
                stroke={COLORS[index % COLORS.length]}
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ),
        )}
        {active && (
          <line
            x1={x(active.at)}
            x2={x(active.at)}
            y1="20"
            y2="150"
            stroke="currentColor"
            opacity=".25"
            strokeDasharray="3 3"
          />
        )}
        <text x="44" y="171" fill="currentColor" opacity=".5" fontSize="14">
          −{seconds / 60} min
        </text>
        <text
          x="624"
          y="171"
          textAnchor="end"
          fill="currentColor"
          opacity=".5"
          fontSize="14"
        >
          Latest
        </text>
        {!visible.length && (
          <text
            x="334"
            y="85"
            textAnchor="middle"
            fill="currentColor"
            opacity=".5"
            fontSize="12"
          >
            Waiting for samples
          </text>
        )}
      </svg>
      {visible.length > 1 && (
        <input
          type="range"
          min="0"
          max={visible.length - 1}
          value={Math.min(cursor ?? visible.length - 1, visible.length - 1)}
          onChange={(event) => setCursor(Number(event.target.value))}
          aria-label="Inspect performance sample"
          className="h-3 w-full accent-primary"
        />
      )}
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{active ? clock(active.at) : "No sample"}</span>
        <span>{statistic.toUpperCase()} · ms</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {keys.map((key, index) => (
          <button
            type="button"
            key={key}
            aria-pressed={!hidden.has(key)}
            onClick={() =>
              setHidden((last) => {
                const next = new Set(last)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
            }
            className={cn(
              "flex min-h-8 items-center justify-between gap-2 text-left text-[10px]",
              hidden.has(key) && "opacity-40",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-0.5 w-3 shrink-0"
                style={{ background: COLORS[index % COLORS.length] }}
              />
              {METRICS[key].label}
            </span>
            <span className="font-mono">
              {ms(active?.stages[key]?.[statistic])}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
function CounterTrend({ points }: { points: readonly PerformancePoint[] }) {
  const visible = points.slice(-60)
  const keys = [
    "encoderOpens",
    "sendExpired",
    "incompleteFrames",
    "nativeReplaced",
  ] as const
  const max = Math.max(
    1,
    ...visible.flatMap((point) => keys.map((key) => point.counters[key] ?? 0)),
  )
  return (
    <div className="px-3 pb-3">
      <svg
        viewBox="0 0 600 90"
        role="img"
        aria-label="Encoder opens and discarded media per sample, last 60 samples"
        className="w-full"
      >
        <line
          x1="0"
          x2="600"
          y1="76"
          y2="76"
          stroke="currentColor"
          opacity=".15"
        />
        {keys.map((key, index) => (
          <path
            key={key}
            d={visible
              .map(
                (point, i) =>
                  `${i ? "L" : "M"}${(i * 600) / 59},${76 - ((point.counters[key] ?? 0) / max) * 65}`,
              )
              .join(" ")}
            fill="none"
            stroke={COLORS[index]}
            strokeWidth="1.5"
          />
        ))}
      </svg>
      <div className="grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
        {keys.map((key, index) => (
          <span key={key} className="inline-flex items-center gap-1">
            <span className="h-0.5 w-3" style={{ background: COLORS[index] }} />
            {COUNTERS[key]}
          </span>
        ))}
      </div>
      <p className="pt-2 text-[10px] text-muted-foreground">
        Counts per recorded sample, not automatic fault alerts. Queue
        replacements may be intentional.
      </p>
    </div>
  )
}
