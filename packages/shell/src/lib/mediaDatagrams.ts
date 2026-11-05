import { decodeAudio, decodeFrame, FrameFormat } from "@lwfa/proto"

export const DATAGRAM_HEADER = 48
export const FRAME_LIFETIME_MS = 150
const MAX_FRAME = 32 * 1024 * 1024
const MAX_BUFFERED = 64 * 1024 * 1024
const MAX_PARTIALS = 32
const MAX_LANES = 128

interface Header {
  packet: bigint; lane: bigint; frame: bigint; audio: boolean; key: boolean
  size: number; index: number; count: number; stride: number
}
interface Assembly {
  header: Header; data: Uint8Array<ArrayBuffer>; seen: Uint8Array; received: number
  created: number; complete: boolean
}
interface Lane { next: bigint | null; broken: boolean; last: bigint; activity: number; recovery: number }

/** Unreliable media: bounded reassembly, brief reordering, and codec recovery.
 * Timers are supplied by the adapter; tests run the real state machine on a
 * deterministic clock. No packet or compressed frame is retransmitted here.
 */
export class MediaDatagrams {
  #frames = new Map<bigint, Assembly>()
  #lanes = new Map<bigint, Lane>()
  #retired = new Set<bigint>()
  #lastSweep = -Infinity
  #allowed: Set<bigint> | null = null
  #bytes = 0
  constructor(
    private deliver: (data: ArrayBuffer) => void,
    private acknowledge: (sequence: bigint) => void,
    private recover: (window: bigint) => void,
  ) {}

  receive(bytes: Uint8Array, now: number): void {
    if (now - this.#lastSweep >= 10) this.expire(now)
    const h = header(bytes)
    if (!h || this.#retired.has(h.packet) || (!h.audio && this.#allowed !== null && !this.#allowed.has(h.lane))) return
    let lane = this.#lanes.get(h.lane)
    if (!lane) {
      if (this.#lanes.size >= MAX_LANES) {
        const oldest = [...this.#lanes].sort((a, b) => a[1].activity - b[1].activity)[0]!
        this.#forget(oldest[0], now)
      }
      lane = { next: null, broken: true, last: 0n, activity: now, recovery: -Infinity }
      this.#lanes.set(h.lane, lane)
    }
    lane.activity = now
    if (h.frame <= lane.last) return // reordered/duplicated data already retired
    let frame = this.#frames.get(h.packet)
    if (!frame) {
      while (this.#frames.size >= MAX_PARTIALS || this.#bytes + h.size > MAX_BUFFERED) {
        const oldest = this.#frames.values().next().value as Assembly | undefined
        if (!oldest) return
        this.#drop(oldest, now, true)
      }
      frame = { header: h, data: new Uint8Array(h.size), seen: new Uint8Array(h.count), received: 0, created: now, complete: false }
      this.#frames.set(h.packet, frame)
      this.#bytes += h.size
    }
    const old = frame.header
    if (old.lane !== h.lane || old.frame !== h.frame || old.size !== h.size || old.count !== h.count || old.stride !== h.stride || old.key !== h.key || old.audio !== h.audio) {
      this.#drop(frame, now, true)
      return
    }
    if (frame.seen[h.index]) return
    frame.seen[h.index] = 1
    frame.data.set(bytes.subarray(DATAGRAM_HEADER), h.index * h.stride)
    if (++frame.received !== h.count) return
    if (now - frame.created >= (h.audio ? 60 : FRAME_LIFETIME_MS)) {
      this.#drop(frame, now, true)
      return
    }
    frame.complete = true
    this.acknowledge(h.packet)
    // Cross-check routing/recovery metadata against the actual codec packet.
    const video = h.audio ? null : decodeFrame(frame.data.buffer)
    if (h.audio ? !decodeAudio(frame.data.buffer) : !video || BigInt(video.header.window) !== h.lane || ((video.header.keyframe || video.header.format === FrameFormat.Jpeg) !== h.key)) {
      this.#drop(frame, now, true)
      return
    }
    if (h.audio || h.key) {
      // Opus/PCM chunks and self-contained video may advance past missing data.
      this.#emit(frame, lane, now)
      this.#drain(h.lane, lane, now)
    } else if (!lane.broken && lane.next === h.frame) {
      this.#emit(frame, lane, now)
      this.#drain(h.lane, lane, now)
    } else if (lane.broken) {
      // Small deltas can overtake a fragmented IDR on the unordered path.
      // Keep them until that keyframe completes or its deadline expires.
      const keyOnTheWay = [...this.#frames.values()].some((pending) => pending.header.lane === h.lane && pending.header.key && pending.header.frame < h.frame)
      if (!keyOnTheWay) {
        this.#drop(frame, now, false)
        this.#request(h.lane, lane, now)
      }
    }
    // A future delta waits only for the short reordering deadline, never a retransmission.
  }

  expire(now: number): void {
    this.#lastSweep = now
    for (const frame of [...this.#frames.values()]) {
      const age = now - frame.created
      if (age >= (frame.header.audio ? 60 : FRAME_LIFETIME_MS)) this.#drop(frame, now, true)
    }
    // Retries cover a lost recovery keyframe and completely missing packets.
    for (const [id, lane] of this.#lanes) {
      if (id !== 0n && lane.broken && lane.recovery !== -Infinity && now - lane.recovery >= 500) this.#request(id, lane, now)
    }
  }

  setWindows(windows: Iterable<bigint>, now: number): void {
    this.#allowed = new Set(windows)
    for (const id of this.#lanes.keys()) {
      if (id !== 0n && !this.#allowed.has(id)) this.#forget(id, now)
    }
  }

  clear(): void { this.#frames.clear(); this.#lanes.clear(); this.#retired.clear(); this.#lastSweep = -Infinity; this.#allowed = null; this.#bytes = 0 }
  get bufferedBytes(): number { return this.#bytes }

  #request(id: bigint, lane: Lane, now: number): void {
    if (id === 0n || now - lane.recovery < 500) return
    lane.recovery = now
    this.recover(id)
  }
  #forget(id: bigint, now: number): void {
    for (const frame of [...this.#frames.values()]) if (frame.header.lane === id) this.#drop(frame, now, false)
    this.#lanes.delete(id)
  }
  #remove(frame: Assembly): void {
    if (this.#frames.delete(frame.header.packet)) {
      this.#bytes -= frame.header.size
      this.#retired.add(frame.header.packet)
      if (this.#retired.size > 256) this.#retired.delete(this.#retired.values().next().value!)
    }
  }
  #drop(frame: Assembly, now: number, loss: boolean): void {
    if (!this.#frames.has(frame.header.packet)) return
    this.#remove(frame)
    if (!frame.complete) this.acknowledge(frame.header.packet) // release telemetry budget, not a delivery guarantee
    const h = frame.header
    const lane = this.#lanes.get(h.lane)
    if (!lane || !loss || h.audio || h.frame <= lane.last) return
    lane.broken = true
    lane.next = null
    // Incomplete or withheld deltas cannot safely feed a predictive decoder.
    for (const pending of [...this.#frames.values()]) {
      if (pending.header.lane === h.lane && !pending.header.key) this.#drop(pending, now, false)
    }
    this.#request(h.lane, lane, now)
  }
  #emit(frame: Assembly, lane: Lane, now: number): void {
    this.#remove(frame)
    lane.last = frame.header.frame
    lane.next = lane.last + 1n
    lane.broken = false
    lane.activity = now
    // Retire older partials after an IDR; their late fragments cannot revive them.
    for (const pending of [...this.#frames.values()]) {
      if (pending.header.lane === frame.header.lane && pending.header.frame <= lane.last) this.#drop(pending, now, false)
    }
    this.deliver(frame.data.buffer)
  }
  #drain(id: bigint, lane: Lane, now: number): void {
    while (!lane.broken) {
      const next = [...this.#frames.values()].find((frame) => frame.header.lane === id && frame.complete && frame.header.frame === lane.next)
      if (!next) return
      this.#emit(next, lane, now)
    }
  }
}

function header(bytes: Uint8Array): Header | null {
  if (bytes.length <= DATAGRAM_HEADER || bytes[0] !== 76 || bytes[1] !== 87 || bytes[2] !== 70 || bytes[3] !== 68 || bytes[4] !== 1 || (bytes[5] !== 1 && bytes[5] !== 2) || bytes[6]! > 1 || bytes[7] !== 0 || bytes.subarray(42, 48).some((v) => v !== 0)) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const h: Header = { packet: v.getBigUint64(8), lane: v.getBigUint64(16), frame: v.getBigUint64(24), size: v.getUint32(32), index: v.getUint16(36), count: v.getUint16(38), stride: v.getUint16(40), audio: bytes[5] === 2, key: bytes[6] === 1 }
  if (h.packet === 0n || h.frame === 0n || h.size === 0 || h.size > MAX_FRAME || h.count === 0 || h.stride === 0 || h.index >= h.count || h.count !== Math.ceil(h.size / h.stride) || (h.audio ? h.lane !== 0n : h.lane === 0n) || bytes.length !== DATAGRAM_HEADER + Math.min(h.stride, h.size - h.index * h.stride)) return null
  return h
}
