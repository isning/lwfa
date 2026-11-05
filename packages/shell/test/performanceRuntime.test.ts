import {afterEach,expect,it,vi} from "vitest"
import {recordPerformance} from "../src/lib/performanceRuntime"
import {performanceStats} from "../src/lib/performance"
import {noteFrame,statsNow,clearStats} from "../src/lib/streamStats"
afterEach(()=>{performanceStats.setEnabled(false);performanceStats.clear();clearStats();vi.unstubAllGlobals();vi.useRealTimers()})
it("keeps frame-rate expiry alive while the panel is closed and releases all timers",()=>{
  vi.useFakeTimers()
  vi.stubGlobal("document",{visibilityState:"visible",addEventListener:vi.fn(),removeEventListener:vi.fn()})
  vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn())
  const stop=recordPerformance()
  noteFrame(1000,100,100,false)
  vi.advanceTimersByTime(1000);noteFrame(1000,100,100,false)
  expect(statsNow().fps).toBeGreaterThan(0)
  vi.advanceTimersByTime(4000)
  expect(statsNow().fps).toBe(0)
  expect(performanceStats.snapshot().points.at(-1)!.fps).toBe(0)
  stop()
  expect(vi.getTimerCount()).toBe(0)
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
})
