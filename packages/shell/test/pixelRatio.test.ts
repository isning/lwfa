import { afterEach, describe, expect, it, vi } from "vitest"
import { devicePixelRatio, watchPixelRatio } from "../src/lib/pixelRatio"

afterEach(() => vi.unstubAllGlobals())

describe("device pixel ratio changes", () => {
  it("reports a new density and rearms when the CSS box has not resized", () => {
    const queries: { query: string; listeners: Set<() => void> }[] = []
    vi.stubGlobal("devicePixelRatio", 1)
    vi.stubGlobal("matchMedia", (query: string) => {
      const listeners = new Set<() => void>()
      queries.push({ query, listeners })
      return { addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }
    })
    const ratios: number[] = []
    const stop = watchPixelRatio(() => ratios.push(devicePixelRatio()))
    expect(queries[0]!.query).toBe("(resolution: 1dppx)")
    vi.stubGlobal("devicePixelRatio", 2)
    for (const listener of [...queries[0]!.listeners]) listener()
    expect(ratios).toEqual([2])
    expect(queries[0]!.listeners.size).toBe(0)
    expect(queries[1]!.query).toBe("(resolution: 2dppx)")
    vi.stubGlobal("devicePixelRatio", 1.25)
    for (const listener of [...queries[1]!.listeners]) listener()
    expect(ratios).toEqual([2, 1.25])
    stop()
    expect(queries[2]!.listeners.size).toBe(0)
  })

  it("uses a safe density when the browser value is missing or invalid", () => {
    for (const ratio of [undefined, 0, -1, NaN, Infinity]) {
      vi.stubGlobal("devicePixelRatio", ratio)
      expect(devicePixelRatio()).toBe(1)
    }
    vi.stubGlobal("devicePixelRatio", 1.5)
    expect(devicePixelRatio()).toBe(1.5)
    vi.stubGlobal("matchMedia", undefined)
    expect(() => watchPixelRatio(() => {})()).not.toThrow()
  })
})
