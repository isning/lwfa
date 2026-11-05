import { expect, it } from "vitest"
import {
  chartAxis,
  chartWindow,
  nearestSample,
} from "../src/lib/performanceChart"

it("fits short recordings rather than leaving several minutes of blank chart", () => {
  const points = [1000, 2000, 3000].map((at) => ({ at }))
  expect(chartWindow(points, 300)).toEqual({ start: 1000, end: 3000, points })
})
it("limits history by timestamps rather than sample positions", () => {
  const points = [0, 5000, 60000, 61000, 120000].map((at) => ({ at }))
  expect(chartWindow(points, 60)).toEqual({
    start: 60000,
    end: 120000,
    points: points.slice(2),
  })
  expect(chartWindow([{ at: 1200 }], 60)).toMatchObject({
    start: 200,
    end: 1200,
  })
})
it("selects an actual point across recording gaps without averaging it", () => {
  const points = [1000, 2000, 6000].map((at) => ({ at }))
  expect(nearestSample(points, 5000)).toBe(points[2])
  expect(nearestSample(points, 1900)).toBe(points[1])
  expect(nearestSample([], 1000)).toBeUndefined()
})
it("keeps zero and sub-millisecond values finite on either scale", () => {
  for (const scale of ["linear", "log"] as const) {
    const axis = chartAxis(0.022, scale)
    expect(axis.normalise(0)).toBe(0)
    expect(axis.normalise(axis.ceiling)).toBeCloseTo(1)
    expect(axis.normalise(0.022)).toBeGreaterThan(0)
    expect(axis.ticks.every(Number.isFinite)).toBe(true)
    expect(chartAxis(0, scale).normalise(0)).toBe(0)
  }
})
it("gives a large spike room without hiding small values on a logarithmic axis", () => {
  const linear = chartAxis(2589.3, "linear"),
    logarithmic = chartAxis(2589.3, "log")
  expect(linear.ceiling).toBeGreaterThanOrEqual(2589.3)
  expect(logarithmic.normalise(4)).toBeGreaterThan(linear.normalise(4))
  expect(logarithmic.ticks).toEqual([0, 1, 10, 100, 1000, logarithmic.ceiling])
})
