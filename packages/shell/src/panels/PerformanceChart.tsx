import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  chartAxis,
  chartWindow,
  nearestSample,
  type ChartScale,
} from "@/lib/performanceChart"
import type { PerformancePoint } from "@/lib/performance"

export interface ChartSeries {
  key: string
  label: string
  read(point: PerformancePoint): number | undefined
}
const COLORS = [
  "#e68a46",
  "#329fb5",
  "#76a85d",
  "#b88adb",
  "#dc6c87",
  "#7d94df",
  "#aa9b52",
]
export const formatValue = (value: number | undefined) =>
  value === undefined
    ? "—"
    : value >= 1000
      ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : value >= 10
        ? value.toFixed(1)
        : value.toFixed(2)
export const sampleClock = (at: number) =>
  new Date(performance.timeOrigin + at).toLocaleTimeString(undefined, {
    hour12: false,
  })

/** Shared elapsed-time chart for independent stage distributions and raw counters. */
export function PerformanceChart({
  points,
  series,
  seconds,
  scale,
  selectedAt,
  onSelect,
  unit,
  title,
  reference,
  height = 210,
}: {
  points: readonly PerformancePoint[]
  series: readonly ChartSeries[]
  seconds: number
  scale: ChartScale
  selectedAt: number | null
  onSelect(at: number | null): void
  unit: "ms" | "count"
  title: string
  reference?: number | undefined
  height?: number
}) {
  const id = useId(),
    container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(420)
  const [hoverAt, setHoverAt] = useState<number | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next && next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const window = useMemo(() => chartWindow(points, seconds), [points, seconds])
  const visible = window.points,
    end = window.end,
    start = window.start
  const cursor = hoverAt ?? selectedAt
  const active =
    cursor === null
      ? visible.at(-1)
      : visible.find((point) => point.at === cursor)
  const enabled = series.filter((item) => !hidden.has(item.key))
  const values = visible.flatMap((point) =>
    enabled
      .map((item) => item.read(point))
      .filter((value): value is number => value !== undefined),
  )
  const axis = chartAxis(
    values.length ? Math.max(unit === "count" ? 1 : 0.001, ...values) : 1,
    scale,
  )
  const left = 44,
    right = width - 12,
    top = 20,
    bottom = height - 30
  const x = (at: number) =>
    left + ((at - start) / (end - start)) * (right - left)
  const y = (value: number) => bottom - axis.normalise(value) * (bottom - top)
  const nearestAt = (event: {
    currentTarget: SVGSVGElement
    clientX: number
  }) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const time =
      start +
      ((((event.clientX - rect.left) / rect.width) * width - left) /
        (right - left)) *
        (end - start)
    return nearestSample(visible, time)?.at ?? null
  }
  const path = (item: ChartSeries) => {
    let previous: number | null = null
    return visible
      .map((point) => {
        const value = item.read(point)
        if (value === undefined) {
          previous = null
          return ""
        }
        const command =
          previous === null || point.at - previous > 2500 ? "M" : "L"
        previous = point.at
        return `${command}${x(point.at).toFixed(2)},${y(value).toFixed(2)}`
      })
      .join(" ")
  }
  const sampleIndex = active ? visible.indexOf(active) : 0
  return (
    <div ref={container} className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ height }}
        className="w-full overflow-visible touch-pan-y"
        role="img"
        aria-labelledby={`${id}-title ${id}-description`}
        onPointerMove={(event) => setHoverAt(nearestAt(event))}
        onPointerLeave={() => setHoverAt(null)}
        onClick={(event) => {
          onSelect(nearestAt(event))
          setHoverAt(null)
        }}
      >
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-description`}>
          Actual elapsed time, {scale === "log" ? "logarithmic" : "linear"}{" "}
          scale. Missing samples are gaps. Click or use the slider to pin a
          sample while recording continues.
        </desc>
        <text x={left} y="10" fill="currentColor" opacity=".55" fontSize="10">
          {unit === "ms" ? "ms" : "per sample"}
        </text>
        {axis.ticks
          .filter((value) => unit !== "count" || Number.isInteger(value))
          .map((value) => (
            <g key={value}>
              <line
                x1={left}
                x2={right}
                y1={y(value)}
                y2={y(value)}
                stroke="currentColor"
                opacity=".08"
              />
              <text
                x={left - 7}
                y={y(value) + 3}
                textAnchor="end"
                fill="currentColor"
                opacity=".55"
                fontSize="10"
                fontFamily="monospace"
              >
                {Number(value.toPrecision(3)).toLocaleString()}
              </text>
            </g>
          ))}
        {reference !== undefined && reference <= axis.ceiling && (
          <g>
            <line
              x1={left}
              x2={right}
              y1={y(reference)}
              y2={y(reference)}
              stroke="currentColor"
              strokeDasharray="4 4"
              opacity=".3"
            />
            <text
              x={right - 3}
              y={y(reference) - 5}
              textAnchor="end"
              fill="currentColor"
              opacity=".55"
              fontSize="9"
            >
              60 fps reference
            </text>
          </g>
        )}
        {series.map(
          (item, index) =>
            !hidden.has(item.key) && (
              <path
                key={item.key}
                d={path(item)}
                fill="none"
                stroke={COLORS[index % COLORS.length]}
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ),
        )}
        {active && (
          <g>
            <line
              x1={x(active.at)}
              x2={x(active.at)}
              y1={top}
              y2={bottom}
              stroke="currentColor"
              opacity=".25"
              strokeDasharray="2 3"
            />
            {series.map((item, index) => {
              const value = item.read(active)
              return value !== undefined && !hidden.has(item.key) ? (
                <circle
                  key={item.key}
                  cx={x(active.at)}
                  cy={y(value)}
                  r="2.5"
                  fill={COLORS[index % COLORS.length]}
                />
              ) : null
            })}
          </g>
        )}
        {[0, ...(width > 340 && end - start > 5000 ? [0.5] : []), 1].map(
          (fraction) => (
            <text
              key={fraction}
              x={left + (right - left) * fraction}
              y={height - 9}
              textAnchor={
                fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"
              }
              fill="currentColor"
              opacity=".55"
              fontSize="10"
              fontFamily="monospace"
            >
              {sampleClock(start + (end - start) * fraction)}
            </text>
          ),
        )}
        {!values.length && (
          <text
            x={(left + right) / 2}
            y={(top + bottom) / 2}
            textAnchor="middle"
            fill="currentColor"
            opacity=".5"
            fontSize="12"
          >
            No measurements in this range
          </text>
        )}
      </svg>
      {visible.length > 1 && (
        <input
          type="range"
          min="0"
          max={visible.length - 1}
          value={sampleIndex}
          onChange={(event) => {
            setHoverAt(null)
            onSelect(visible[Number(event.target.value)]!.at)
          }}
          aria-label={`Inspect ${title.toLowerCase()} sample`}
          className="h-4 w-full cursor-pointer accent-primary"
        />
      )}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">
          {active
            ? sampleClock(active.at)
            : points.length
              ? "Selected sample outside this range"
              : "Waiting for samples"}{" "}
          ·{" "}
          {hoverAt !== null
            ? "Hover preview"
            : selectedAt === null
              ? "Following latest"
              : "Pinned"}
        </span>
        {selectedAt !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              setHoverAt(null)
              onSelect(null)
            }}
          >
            Follow latest
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {series.map((item, index) => (
          <button
            type="button"
            key={item.key}
            aria-pressed={!hidden.has(item.key)}
            aria-label={`Toggle ${item.label}`}
            onClick={() =>
              setHidden((previous) => {
                const next = new Set(previous)
                if (next.has(item.key)) next.delete(item.key)
                else next.add(item.key)
                return next
              })
            }
            className={cn(
              "flex min-h-9 items-center justify-between gap-2 text-left text-[11px]",
              hidden.has(item.key) && "opacity-40",
            )}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span
                className="h-0.5 w-3 shrink-0"
                style={{ background: COLORS[index % COLORS.length] }}
              />
              {item.label}
            </span>
            <span className="shrink-0 font-mono tabular-nums">
              {active && unit === "count"
                ? (item.read(active)?.toLocaleString() ?? "—")
                : formatValue(active ? item.read(active) : undefined)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
