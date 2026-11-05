import { afterEach, expect, it, vi } from "vitest"
import {
  PerformanceRecorder,
  performanceStats,
  exportPerformance,
  frameReceived,
  timing,
  decodeFinished,
  converted,
  inheritTiming,
  renderStarted,
  renderFinished,
  resetFrameTimings,
} from "../src/lib/performance"
import {
  decodeToEngine,
  decodeToShell,
  type PerformanceReport,
  type DecodedFrame,
} from "@lwfa/proto"
const report = (value = 10): PerformanceReport => ({
  type: "performance",
  nonce: 1,
  stages: [{ name: "encode", samples: 10, p50: 2, p95: 5, max: 9 }],
  counters: [{ name: "encoderOpens", value }],
  transportRttMs: 12,
})
afterEach(() => {
  performanceStats.setEnabled(false)
  performanceStats.clear()
  resetFrameTimings()
  vi.restoreAllMocks()
})
it("bounds stage samples and time history, and does not consume samples for readers", () => {
  const recorder = new PerformanceRecorder()
  recorder.setEnabled(true)
  for (let i = 0; i < 1000; i++) recorder.observe("decode", i, 1000)
  recorder.tick(1000)
  expect(recorder.snapshot().points[0]!.stages.decode).toEqual({
    samples: 256,
    p50: 871,
    p95: 987,
    max: 999,
  })
  recorder.tick(2000)
  expect(recorder.snapshot().points[1]!.stages.decode?.samples).toBe(256)
  recorder.tick(4001)
  expect(recorder.snapshot().points[2]!.stages.decode).toBeUndefined()
  for (let i = 0; i < 400; i++) recorder.tick(5000 + i * 1000)
  expect(recorder.snapshot().points).toHaveLength(300)
  recorder.tick(900000)
  expect(recorder.snapshot().points).toHaveLength(1)
})
it("keeps stage distributions independent, ignores invalid samples and pauses recording", () => {
  const recorder = new PerformanceRecorder()
  recorder.observe("encode", 50, 0)
  recorder.tick(0)
  expect(recorder.snapshot().points).toHaveLength(0)
  recorder.setEnabled(true)
  recorder.observe("encode", 5, 100)
  recorder.observe("decode", 12, 100)
  for (const value of [NaN, Infinity, -1])
    recorder.observe("encode", value, 100)
  recorder.tick(100)
  expect(recorder.snapshot().points[0]!.stages.encode?.samples).toBe(1)
  expect(recorder.snapshot().points[0]!.stages.decode?.p50).toBe(12)
  recorder.setEnabled(false)
  recorder.tick(1000)
  expect(recorder.snapshot().points).toHaveLength(1)
})
it("baselines server counters, handles restarts, and clears all published totals", () => {
  const recorder = new PerformanceRecorder()
  recorder.setEnabled(true)
  recorder.server(report(10), 100, 20)
  recorder.tick(100)
  expect(recorder.snapshot().totals.encoderOpens).toBe(0)
  recorder.server(report(12), 1100, 22)
  recorder.tick(1100)
  expect(recorder.snapshot().points.at(-1)!.counters.encoderOpens).toBe(2)
  recorder.clear()
  expect(recorder.snapshot().totals).toEqual({})
  expect(recorder.snapshot().points).toEqual([])
  recorder.server(report(13), 2100, 18)
  recorder.tick(2100)
  expect(recorder.snapshot().totals.encoderOpens).toBe(1)
  recorder.server(report(1), 3100, 18)
  recorder.tick(3100)
  expect(recorder.snapshot().totals.encoderOpens).toBe(0)
  expect(recorder.snapshot().points.at(-1)!.counters.encoderOpens).toBe(0)
})
it("expires remote timings without inventing zero latency", () => {
  const recorder = new PerformanceRecorder()
  recorder.setEnabled(true)
  recorder.server(report(), 100, 22)
  recorder.tick(100)
  expect(recorder.snapshot().points[0]!.stages.encode?.p95).toBe(5)
  expect(recorder.snapshot().points[0]!.stages.controlRtt?.p50).toBe(22)
  recorder.tick(4000)
  expect(recorder.snapshot().points.at(-1)!.stages.encode).toBeUndefined()
  expect(recorder.snapshot().server).toBe("waiting")
})
it("carries one frame's timing through asynchronous decode, bitmap conversion and rendering", () => {
  let now = 10
  vi.spyOn(performance, "now").mockImplementation(() => now)
  performanceStats.setEnabled(true)
  const wire = { header: { window: 1 } } as DecodedFrame
  frameReceived(wire)
  const trace = timing(wire),
    video = {},
    bitmap = {},
    wrapper = {}
  now = 14
  decodeFinished(video, trace, 11)
  now = 16
  converted(video, bitmap, 14)
  inheritTiming(bitmap, wrapper)
  now = 20
  const start = renderStarted(wrapper)
  now = 21
  renderFinished(wrapper, start)
  performanceStats.tick(now)
  const stages = performanceStats.snapshot().points.at(-1)!.stages
  expect(stages.decode?.p50).toBe(3)
  expect(stages.convert?.p50).toBe(2)
  expect(stages.frameWait?.p50).toBe(4)
  expect(stages.render?.p50).toBe(1)
  expect(stages.receiveToSubmit?.p50).toBe(11)
  resetFrameTimings()
  expect(renderStarted(wrapper)).toBeUndefined()
})
it("exports only numeric diagnostics and measurement scope", () => {
  const recorder = new PerformanceRecorder()
  recorder.setEnabled(true)
  recorder.tick(100)
  const exported = JSON.parse(exportPerformance(recorder.snapshot()))
  expect(exported.version).toBe(1)
  expect(exported.points[0].at).toBe(100)
  expect(exported.scope).toContain("not physical")
  expect(Object.keys(exported)).not.toContain("password")
})
it("validates optional probe bounds and bounded diagnostic replies", () => {
  expect(
    decodeToEngine(
      JSON.stringify({ type: "performanceProbe", nonce: 0xffffffff }),
    ),
  ).toEqual({ type: "performanceProbe", nonce: 0xffffffff })
  for (const nonce of [-1, 1.5, 0x100000000])
    expect(() =>
      decodeToEngine(JSON.stringify({ type: "performanceProbe", nonce })),
    ).toThrow()
  expect(decodeToShell(JSON.stringify(report()))).toEqual(report())
  for (const stages of [
    Array.from({ length: 65 }, () => report().stages[0]),
    [{ ...report().stages[0], p50: 10, p95: 2 }],
    [{ ...report().stages[0], name: "__proto__" }],
    [{ ...report().stages[0], max: -1 }],
  ])
    expect(() =>
      decodeToShell(JSON.stringify({ ...report(), stages })),
    ).toThrow()
})
