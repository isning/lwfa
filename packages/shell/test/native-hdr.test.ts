import { afterEach, expect, it, vi } from "vitest"
import { NativeHdrPresenter, needsNativeHdr } from "../src/lib/native-hdr"
afterEach(() => vi.unstubAllGlobals())

it("routes only opaque PQ BT.2020 frames with native playback support", () => {
  vi.stubGlobal("MediaStreamTrackGenerator", class {})
  const frame = { format: null, colorSpace: { primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false } } as unknown as VideoFrame
  expect(needsNativeHdr(frame)).toBe(true)
  expect(needsNativeHdr({ ...frame, format: "I420P10" } as unknown as VideoFrame)).toBe(false)
  expect(needsNativeHdr({ ...frame, colorSpace: { ...frame.colorSpace, transfer: "linear" } } as unknown as VideoFrame)).toBe(false)
  vi.stubGlobal("MediaStreamTrackGenerator", undefined)
  expect(needsNativeHdr(frame)).toBe(false)
})

it("bounds writes, owns frames, rebases timestamps and stops playback on cleanup", async () => {
  const frames: { timestamp: number; closed: boolean; close(): void }[] = []
  vi.stubGlobal("VideoFrame", class {
    timestamp: number
    closed = false
    constructor(_: unknown, init: { timestamp: number }) { this.timestamp = init.timestamp; frames.push(this) }
    close() { this.closed = true }
  })
  let finish!: () => void
  const firstWrite = new Promise<void>(resolve => { finish = resolve })
  const write = vi.fn().mockImplementationOnce(() => firstWrite).mockResolvedValue(undefined)
  const abort = vi.fn(async () => {})
  const stop = vi.fn()
  vi.stubGlobal("MediaStreamTrackGenerator", class { writable = { getWriter: () => ({ write, abort }) }; stop = stop })
  vi.stubGlobal("MediaStream", class {})
  const element = { play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null } as unknown as HTMLVideoElement
  const presenter = new NativeHdrPresenter(element, vi.fn())
  const jobs = [presenter.draw({} as VideoFrame), presenter.draw({} as VideoFrame), presenter.draw({} as VideoFrame)]
  await jobs[1]
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(write).toHaveBeenCalledTimes(1)
  expect(frames.map(f => f.closed)).toEqual([false, true, false])
  expect(frames[0]!.timestamp).toBeGreaterThan(0)
  finish()
  await Promise.all(jobs)
  expect(write).toHaveBeenCalledTimes(2)
  expect(frames.every(f => f.closed)).toBe(true)
  presenter.destroy()
  presenter.destroy()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(element.srcObject).toBeNull()
  expect(abort).toHaveBeenCalledTimes(1)
})

it("shares an identical source's submission and does not resubmit it on cached redraws", async () => {
  const clone = vi.fn()
  vi.stubGlobal("VideoFrame", class { constructor() { clone() } close() {} })
  let finish!: () => void
  const blocked = new Promise<void>(resolve => { finish = resolve })
  const write = vi.fn().mockImplementationOnce(() => blocked).mockResolvedValue(undefined)
  vi.stubGlobal("MediaStreamTrackGenerator", class { writable = { getWriter: () => ({ write, abort: vi.fn(async () => {}) }) }; stop() {} })
  vi.stubGlobal("MediaStream", class {})
  const element = { play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null } as unknown as HTMLVideoElement
  const source = { close: vi.fn() } as unknown as VideoFrame
  const presenter = new NativeHdrPresenter(element, vi.fn())
  const first = presenter.draw(source), duplicate = presenter.draw(source)
  expect(duplicate).toBe(first)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(clone).toHaveBeenCalledTimes(1)
  expect(write).toHaveBeenCalledTimes(1)
  finish()
  await first
  await presenter.draw(source)
  expect(write).toHaveBeenCalledTimes(1)
  await presenter.draw({} as VideoFrame)
  expect(write).toHaveBeenCalledTimes(2)
  expect(source.close).not.toHaveBeenCalled()
  presenter.destroy()
  const nextPresenter = new NativeHdrPresenter(element, vi.fn())
  await nextPresenter.draw(source)
  expect(write).toHaveBeenCalledTimes(3)
  nextPresenter.destroy()
})
