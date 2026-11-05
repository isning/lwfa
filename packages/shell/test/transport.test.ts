import { afterEach, describe, expect, it, vi } from "vitest"
import { PacketReader, packet, sessionSocket, type QuicConstructor } from "../src/lib/transport"

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } })
}
afterEach(() => vi.unstubAllGlobals())

describe("QUIC packet framing", () => {
  it("handles fragmented headers, fragmented payloads, and coalesced packets", async () => {
    const a = packet(new Uint8Array([1, 2, 3]))
    const b = packet(new Uint8Array([4, 5]))
    const joined = new Uint8Array([...a, ...b])
    const reader = new PacketReader(stream(Array.from(joined, (byte) => new Uint8Array([byte]))).getReader())
    expect(await reader.packet(10)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await reader.packet(10)).toEqual(new Uint8Array([4, 5]))
    const coalesced = new PacketReader(stream([joined]).getReader())
    expect(await coalesced.packet(10)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await coalesced.packet(10)).toEqual(new Uint8Array([4, 5]))
  })
  it("rejects oversized and empty packets before allocating their payload", async () => {
    for (const size of [0, 11, 0xffffffff]) {
      const header = new Uint8Array(4)
      new DataView(header.buffer).setUint32(0, size)
      const reader = new PacketReader(stream([header]).getReader())
      await expect(reader.packet(10)).rejects.toThrow("invalid transport packet size")
    }
  })
  it("rejects truncated payloads", async () => {
    const reader = new PacketReader(stream([packet(new Uint8Array([1, 2])).subarray(0, 5)]).getReader())
    await expect(reader.packet(10)).rejects.toThrow("truncated")
  })
})

it("negotiates QUIC, preserves control/media independence and acknowledges media", async () => {
  const writes: Uint8Array[] = []
  let control!: ReadableStreamDefaultController<Uint8Array>
  let lanes!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>
  const close = vi.fn()
  const ctor = vi.fn(function (_url: string) {
    return {
      ready: Promise.resolve(), closed: new Promise(() => {}), close,
      createBidirectionalStream: async () => ({
        readable: new ReadableStream({ start(c) { control = c } }),
        writable: new WritableStream({ write(bytes) { writes.push(bytes) } }),
      }),
      incomingUnidirectionalStreams: new ReadableStream({ start(c) { lanes = c } }),
    }
  })
  vi.stubGlobal("WebTransport", ctor as unknown as QuicConstructor)
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ webtransport: { version: 1, port: 6734, certificateHash: Array(32).fill(4) } }) })))
  const socket = sessionSocket("wss://desktop.test:6743/?token=secret&client=stable")
  const messages: unknown[] = []
  socket.onmessage = ({ data }) => messages.push(data)
  await new Promise<void>((resolve) => { socket.onopen = resolve })
  expect(socket.transport).toBe("webtransport")
  expect(ctor.mock.calls[0]?.[0]).toBe("https://desktop.test:6734/session?token=secret&client=stable")
  expect(writes[0]).toEqual(packet(new Uint8Array([2, 1])))
  let stalled!: ReadableStreamDefaultController<Uint8Array>
  lanes.enqueue(new ReadableStream({ start(c) { stalled = c; c.enqueue(new Uint8Array([1])) } }))
  // A window with no complete packet must not hold up a second window or Hello.
  const media = new Uint8Array(9)
  media[7] = 7; media[8] = 42
  let active!: ReadableStreamDefaultController<Uint8Array>
  lanes.enqueue(new ReadableStream({ start(c) { active = c; c.enqueue(new Uint8Array([1, ...packet(media)])) } }))
  control.enqueue(packet(new TextEncoder().encode('{"type":"hello"}')))
  await vi.waitFor(() => expect(messages.length).toBe(2))
  expect(messages).toContain('{"type":"hello"}')
  expect(messages.some((m) => m instanceof ArrayBuffer && new Uint8Array(m)[0] === 42)).toBe(true)
  await vi.waitFor(() => expect(writes.length).toBe(2))
  expect(writes[1]).toEqual(packet(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 7])))
  socket.send('{"type":"ping"}')
  await vi.waitFor(() => expect(writes.length).toBe(3))
  expect(writes[2]).toEqual(packet(new Uint8Array([0, ...new TextEncoder().encode('{"type":"ping"}') ])))
  socket.close()
  control.close(); stalled.close(); active.close(); lanes.close()
  expect(close).toHaveBeenCalled()
})

it("keeps legacy engines usable when discovery is absent or blocked by CORS", async () => {
  let opened = 0
  class Legacy {
    readyState = 0
    binaryType = "blob"
    onopen: (() => void) | null = null
    onmessage = null
    onclose = null
    onerror = null
    constructor() { opened++ }
    send() {}
    close() {}
  }
  vi.stubGlobal("WebSocket", Legacy)
  vi.stubGlobal("WebTransport", vi.fn())
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
  const socket = sessionSocket("wss://old-engine.test/engine")
  await vi.waitFor(() => expect(opened).toBe(1))
  expect(socket.transport).toBe("websocket")
  socket.close()
})

it("does not conceal advertised QUIC failures behind a TCP fallback", async () => {
  const legacy = vi.fn()
  vi.stubGlobal("WebSocket", legacy)
  vi.stubGlobal("WebTransport", vi.fn(function () { throw new Error("UDP blocked") }))
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ webtransport: { version: 1, port: 6734, certificateHash: null } }) })))
  const socket = sessionSocket("wss://desktop.test/engine")
  const closed = vi.fn()
  socket.onclose = closed
  await vi.waitFor(() => expect(closed).toHaveBeenCalled())
  expect(socket.readyState).toBe(3)
  expect(legacy).not.toHaveBeenCalled()
})
