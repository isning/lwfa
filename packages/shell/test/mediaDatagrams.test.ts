import { describe, expect, it, vi } from "vitest"
import { AUDIO_HEADER_LEN, AUDIO_MAGIC, AudioFormat, FRAME_HEADER_LEN, FRAME_MAGIC, FRAME_VERSION, FrameFormat } from "@lwfa/proto"
import { DATAGRAM_HEADER, FRAME_LIFETIME_MS, MediaDatagrams } from "../src/lib/mediaDatagrams"

function video(sequence: number, key = false, lane = 1, jpeg = false): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_LEN + 20)
  out.set(FRAME_MAGIC); out[4] = FRAME_VERSION; out[5] = jpeg ? FrameFormat.Jpeg : FrameFormat.H264; out[6] = key ? 1 : 0
  const v = new DataView(out.buffer)
  v.setBigUint64(8, BigInt(lane), true); v.setUint32(16, 2, true); v.setUint32(20, 2, true)
  out[FRAME_HEADER_LEN] = sequence
  return out
}
function audio(): Uint8Array {
  const out = new Uint8Array(AUDIO_HEADER_LEN + 4)
  out.set(AUDIO_MAGIC); out[4] = 0; out[5] = AudioFormat.Pcm16; out[6] = 2
  const v = new DataView(out.buffer); v.setUint32(8, 48000, true); v.setUint32(12, 1, true)
  return out
}
function fragments(bytes: Uint8Array, packet: number, frame: number, lane = 1, key = false, stride = 16): Uint8Array[] {
  const count = Math.ceil(bytes.length / stride)
  return Array.from({ length: count }, (_, index) => {
    const data = bytes.subarray(index * stride, (index + 1) * stride)
    const out = new Uint8Array(DATAGRAM_HEADER + data.length)
    out.set([76, 87, 70, 68, 1, lane === 0 ? 2 : 1, key ? 1 : 0, 0])
    const v = new DataView(out.buffer)
    v.setBigUint64(8, BigInt(packet)); v.setBigUint64(16, BigInt(lane)); v.setBigUint64(24, BigInt(frame))
    v.setUint32(32, bytes.length); v.setUint16(36, index); v.setUint16(38, count); v.setUint16(40, stride)
    out.set(data, DATAGRAM_HEADER)
    return out
  })
}
function harness() {
  const delivered: ArrayBuffer[] = []
  const ack = vi.fn(), recover = vi.fn()
  const receiver = new MediaDatagrams((b) => delivered.push(b), ack, recover)
  const receive = (pieces: Uint8Array[], time = 0) => { for (const piece of pieces) receiver.receive(piece, time) }
  const numbers = () => delivered.map((b) => new Uint8Array(b)[FRAME_HEADER_LEN])
  return { receiver, receive, delivered, numbers, ack, recover }
}

describe("unreliable media", () => {
  it("stops recovery and rejects late media after a window is unsubscribed", () => {
    const h = harness()
    h.receiver.setWindows([1n], 0)
    h.receive(fragments(video(1, true), 1, 1, 1, true).slice(0,1))
    h.receiver.expire(150)
    expect(h.recover).toHaveBeenCalledTimes(1)
    h.receiver.setWindows([], 160)
    h.receiver.expire(1000)
    h.receive(fragments(video(2, true), 2, 2, 1, true), 1010)
    expect(h.recover).toHaveBeenCalledTimes(1)
    expect(h.delivered).toEqual([])
    expect(h.receiver.bufferedBytes).toBe(0)
  })
  it("reassembles reversed/duplicated fragments exactly once", () => {
    const h = harness(), bytes = video(1, true)
    const parts = fragments(bytes, 1, 1, 1, true).reverse()
    h.receive([parts[0]!, parts[0]!, ...parts.slice(1), ...parts])
    expect(h.delivered).toEqual([bytes.buffer])
    expect(h.ack).toHaveBeenCalledTimes(1)
    expect(h.recover).not.toHaveBeenCalled()
    expect(h.receiver.bufferedBytes).toBe(0)
  })
  it("orders briefly reordered predictive frames without asking for a keyframe", () => {
    const h = harness()
    h.receive(fragments(video(1, true), 1, 1, 1, true))
    h.receive(fragments(video(3), 3, 3), 10)
    expect(h.numbers()).toEqual([1])
    h.receive(fragments(video(2), 2, 2), 20)
    expect(h.numbers()).toEqual([1, 2, 3])
    expect(h.recover).not.toHaveBeenCalled()
  })
  it("keeps deltas that overtake the fragmented recovery keyframe", () => {
    const h = harness(), key = fragments(video(1, true), 1, 1, 1, true)
    h.receive(key.slice(0, 1))
    h.receive(fragments(video(2), 2, 2), 5)
    expect(h.delivered).toEqual([])
    h.receive(key.slice(1), 10)
    expect(h.numbers()).toEqual([1, 2])
    expect(h.recover).not.toHaveBeenCalled()
  })
  it("drops a broken reference chain and resumes only from a fresh keyframe", () => {
    const h = harness()
    h.receive(fragments(video(1, true), 1, 1, 1, true))
    // All datagrams for frame 2 disappear; no retransmission is requested.
    h.receive(fragments(video(3), 3, 3), 10)
    h.receiver.expire(10 + FRAME_LIFETIME_MS)
    expect(h.recover).toHaveBeenCalledWith(1n)
    h.receive(fragments(video(4), 4, 4), 170)
    expect(h.numbers()).toEqual([1])
    h.receive(fragments(video(5, true), 5, 5, 1, true), 180)
    h.receive(fragments(video(2), 2, 2), 190)
    h.receive(fragments(video(6), 6, 6), 200)
    expect(h.numbers()).toEqual([1, 5, 6])
    expect(h.receiver.bufferedBytes).toBe(0)
  })
  it("retires a partially lost keyframe and ignores its late tail", () => {
    const h = harness(), parts = fragments(video(1, true), 1, 1, 1, true)
    h.receive(parts.slice(0, 1))
    h.receiver.expire(FRAME_LIFETIME_MS)
    expect(h.recover).toHaveBeenCalledTimes(1)
    h.receive(parts.slice(1), 200)
    expect(h.delivered).toEqual([])
    expect(h.receiver.bufferedBytes).toBe(0)
    h.receiver.expire(650)
    expect(h.recover).toHaveBeenCalledTimes(2)
    h.receive(fragments(video(2, true), 2, 2, 1, true), 660)
    h.receiver.expire(1200)
    expect(h.numbers()).toEqual([2])
    expect(h.recover).toHaveBeenCalledTimes(2)
  })
  it("does not hold audio or another window behind a lost video frame", () => {
    const h = harness()
    h.receive(fragments(video(1, true), 1, 1, 1, true).slice(0, 1))
    h.receive(fragments(video(2, true, 2), 2, 1, 2, true), 10)
    const sound = audio()
    h.receive(fragments(sound, 3, 3, 0, true), 20)
    expect(h.delivered).toEqual([video(2, true, 2).buffer, sound.buffer])
  })
  it("discards late audio and lets JPEG jump gaps without video recovery", () => {
    const h = harness()
    const sound = audio()
    h.receive(fragments(sound, 2, 2, 0, true))
    h.receive(fragments(sound, 1, 1, 0, true), 10)
    h.receive(fragments(video(1, false, 1, true), 3, 1, 1, true), 20)
    h.receive(fragments(video(3, false, 1, true), 4, 3, 1, true), 30)
    expect(h.delivered.length).toBe(3)
    expect(h.recover).not.toHaveBeenCalled()
  })
  it("rejects malformed or excessive allocations before reserving a frame", () => {
    for (const mutate of [
      (v: DataView) => v.setUint32(32, 0xffffffff),
      (v: DataView) => v.setUint16(36, 0xffff),
      (v: DataView) => v.setUint16(40, 0),
      (v: DataView) => v.setUint16(38, 0),
    ]) {
      const h = harness(), part = fragments(video(1, true), 1, 1, 1, true)[0]!
      mutate(new DataView(part.buffer)); h.receive([part])
      expect(h.receiver.bufferedBytes).toBe(0)
      expect(h.delivered).toEqual([])
    }
  })
  it("rejects routing/codec metadata inconsistent with the assembled packet", () => {
    const h = harness()
    h.receive(fragments(video(1, true, 1), 1, 1, 2, true))
    expect(h.delivered).toEqual([])
    expect(h.recover).toHaveBeenCalledWith(2n)
    expect(h.receiver.bufferedBytes).toBe(0)
  })
  it("bounds aggregate partial-frame memory and releases everything on expiry", () => {
    const h = harness(), size = 3 * 1024 * 1024, stride = 1152
    for (let n = 1; n <= 30; n++) {
      const part = new Uint8Array(DATAGRAM_HEADER + stride)
      part.set([76,87,70,68,1,1,1,0]); const v = new DataView(part.buffer)
      v.setBigUint64(8, BigInt(n)); v.setBigUint64(16, BigInt(n)); v.setBigUint64(24, 1n)
      v.setUint32(32, size); v.setUint16(38, Math.ceil(size / stride)); v.setUint16(40, stride)
      h.receive([part])
      expect(h.receiver.bufferedBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    }
    h.receiver.expire(FRAME_LIFETIME_MS)
    expect(h.receiver.bufferedBytes).toBe(0)
    expect(h.delivered).toEqual([])
    h.receiver.clear()
  })
})
