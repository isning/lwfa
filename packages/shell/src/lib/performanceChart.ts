export type ChartScale = "linear" | "log"

/** Fit available data inside the requested history, keeping real elapsed time. */
export function chartWindow<T extends { at: number }>(
  points: readonly T[],
  seconds: number,
) {
  const end = points.at(-1)?.at ?? 0
  let start = Math.max(end - seconds * 1000, points[0]?.at ?? end)
  if (start === end) start = end - 1000
  return { start, end, points: points.filter((point) => point.at >= start) }
}

/** Inspect the closest actual sample; never interpolate across an idle gap. */
export function nearestSample<T extends { at: number }>(
  points: readonly T[],
  at: number,
): T | undefined {
  let nearest: T | undefined
  for (const point of points)
    if (!nearest || Math.abs(point.at - at) < Math.abs(nearest.at - at))
      nearest = point
  return nearest
}

export function chartAxis(maximum: number, scale: ChartScale) {
  const maximumValue = Math.max(Number.isFinite(maximum) ? maximum : 0, 0.001)
  const magnitude = 10 ** Math.floor(Math.log10(maximumValue / 4))
  const fraction = maximumValue / 4 / magnitude
  const step =
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude
  const ceiling = Math.ceil(maximumValue / step) * step
  const transform = scale === "log" ? Math.log1p : (value: number) => value
  const normalise = (value: number) =>
    transform(Math.max(0, value)) / transform(ceiling)
  const ticks = Array.from(
    { length: Math.round(ceiling / step) + 1 },
    (_, index) => index * step,
  )
  if (scale === "log" && ceiling > 10) {
    const logarithmic = [0, 1]
    for (let value = 10; value < ceiling; value *= 10) logarithmic.push(value)
    logarithmic.push(ceiling)
    return { ceiling, ticks: logarithmic, normalise }
  }
  return { ceiling, ticks, normalise }
}
