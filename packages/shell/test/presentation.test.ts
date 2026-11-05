import { expect, it } from "vitest"
import { choosePresentation } from "../src/lib/presentation"
import type { DrawableFrame } from "../src/lib/hdr"
const sdr = { native: true, video: { format: "I420", colorSpace: {} } } as unknown as DrawableFrame
const hdr = (format: string | null, transfer = "pq") => ({ hdr: true, video: { format, colorSpace: { primaries: "bt2020", transfer, matrix: "bt2020-ncl", fullRange: false } } }) as unknown as DrawableFrame
it("keeps automatic SDR on Canvas and honors native video preference independently of codec", () => {
  expect(choosePresentation("auto", sdr, true).path).toBe("Canvas2D")
  expect(choosePresentation("video", sdr, true)).toEqual({ path: "Native video" })
  expect(choosePresentation("canvas", sdr, true)).toEqual({ path: "Canvas2D" })
})
it("preserves opaque HDR with an explained fallback from Canvas", () => {
  expect(choosePresentation("auto", hdr(null), true)).toEqual({ path: "Native video" })
  expect(choosePresentation("canvas", hdr(null), true)).toEqual({ path: "Native video", reason: expect.any(String) })
  expect(choosePresentation("canvas", hdr("I420P10"), true).path).toBe("WebGPU Canvas")
})
it("never sends synthetic HDR labels to native playback and explains unsupported video", () => {
  expect(choosePresentation("video", hdr(null, "linear"), true)).toEqual({ path: "WebGPU Canvas", reason: expect.any(String) })
  expect(choosePresentation("video", sdr, false)).toEqual({ path: "Canvas2D", reason: expect.any(String) })
  expect(choosePresentation("video", {} as DrawableFrame, true)).toEqual({ path: "Canvas2D", reason: expect.any(String) })
})
