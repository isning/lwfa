import { MediaDatagrams, FRAME_LIFETIME_MS } from "./mediaDatagrams"
/** Session transport. The compositor protocol is identical on either adapter. */
export interface SessionSocket {
  readonly readyState: number
  readonly transport?: "websocket" | "webtransport"
  readonly media?: "stream" | "datagram"
  binaryType: BinaryType
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { reason: string; code: number }) => void) | null
  onerror: (() => void) | null
  setWindows?(windows: readonly number[]): void
  send(data: string): void
  close(): void
}

interface QuicSession {
  ready: Promise<void>
  closed: Promise<{ closeCode: number; reason: string }>
  createBidirectionalStream(): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>
  incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>
  datagrams?: {
    readable: ReadableStream<Uint8Array>
    incomingMaxAge: number
    incomingHighWaterMark: number
  }
  close(): void
}
export type QuicConstructor = new (url: string, options?: {
  serverCertificateHashes?: { algorithm: string; value: Uint8Array }[]
  congestionControl?: string
  requireUnreliable?: boolean
}) => QuicSession

const MAX_CONTROL = 4 * 1024 * 1024
const MAX_MEDIA = 32 * 1024 * 1024 + 8
const MAX_LANES = 128

/** Read exactly-sized packets without assuming network read boundaries. */
export class PacketReader {
  #chunk: Uint8Array = new Uint8Array(0)
  #offset = 0
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}
  async exact(size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size)
    let offset = 0
    while (offset < size) {
      if (this.#offset === this.#chunk.length) {
        const next = await this.reader.read()
        if (next.done) throw new Error("truncated transport stream")
        this.#chunk = next.value
        this.#offset = 0
      }
      const count = Math.min(size - offset, this.#chunk.length - this.#offset)
      out.set(this.#chunk.subarray(this.#offset, this.#offset + count), offset)
      offset += count
      this.#offset += count
    }
    return out
  }
  async length(max: number): Promise<number> {
    const size = new DataView((await this.exact(4)).buffer).getUint32(0)
    if (size === 0 || size > max) throw new Error("invalid transport packet size")
    return size
  }
  async packet(max: number): Promise<Uint8Array> {
    return this.exact(await this.length(max))
  }
}

export function packet(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 4)
  new DataView(out.buffer).setUint32(0, bytes.length)
  out.set(bytes, 4)
  return out
}

/** Unsupported browsers and old engines retain the existing WebSocket path. */
export function sessionSocket(url: string): SessionSocket {
  const ctor = (globalThis as unknown as { WebTransport?: QuicConstructor }).WebTransport
  if (!ctor || !url.startsWith("wss:")) return new LegacySocket(url)
  return new QuicSocket(url, ctor)
}

class LegacySocket implements SessionSocket {
  readonly transport = "websocket" as const
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { reason: string; code: number }) => void) | null = null
  onerror: (() => void) | null = null
  #socket: WebSocket
  constructor(url: string) {
    this.#socket = new WebSocket(url)
    this.#socket.onopen = () => this.onopen?.()
    this.#socket.onmessage = (event) => this.onmessage?.(event)
    this.#socket.onclose = (event) => this.onclose?.(event)
    this.#socket.onerror = () => this.onerror?.()
  }
  get readyState(): number { return this.#socket.readyState }
  get binaryType(): BinaryType { return this.#socket.binaryType }
  set binaryType(value: BinaryType) { this.#socket.binaryType = value }
  send(data: string): void { this.#socket.send(data) }
  close(): void { this.#socket.close() }
}

class QuicSocket implements SessionSocket {
  readyState = 0
  transport: "webtransport" | "websocket" = "webtransport"
  binaryType: BinaryType = "arraybuffer"
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { reason: string; code: number }) => void) | null = null
  onerror: (() => void) | null = null
  #session: QuicSession | null = null
  #legacy: SessionSocket | null = null
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  #writes: Promise<void> = Promise.resolve()
  #queued = 0
  #lanes = 0
  media: "stream" | "datagram" = "stream"
  #packets: MediaDatagrams | null = null
  #expiry: ReturnType<typeof setInterval> | null = null
  #abort = new AbortController()
  #endpointPort = "unknown"

  #failure(error: unknown): void {
    if (this.readyState === 3) return
    // Native errors may contain the credential-bearing URL. Only retain a
    // recognized network error code, never the raw message or exception.
    const message = error instanceof Error ? error.message : ""
    const code = message.match(/\bERR_[A-Z_]+\b/)?.[0]
    const timeout = message === "QUIC handshake timed out"
    const reason = `WebTransport ${timeout ? "handshake timed out" : "connection failed"}${code ? ` (${code})` : ""}; check browser proxy bypass, UDP ${this.#endpointPort}, TLS and login password`
    console.warn("LWFA WebTransport failed:", reason)
    this.onerror?.()
    this.#end(reason, 1006)
  }
  constructor(private url: string, private ctor: QuicConstructor) { void this.#start() }

  async #start(): Promise<void> {
    let advertised = false
    try {
      const origin = new URL(this.url)
      origin.protocol = "https:"
      origin.pathname = origin.pathname.replace(/\/$/, "") + "/capabilities.json"
      origin.search = ""
      const response = await fetch(origin, { cache: "no-store", credentials: "omit", signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(5000)]) })
      const body: unknown = response.ok ? await response.json() : null
      if (this.readyState === 3) return
      const info = body && typeof body === "object" && "webtransport" in body ? body.webtransport : null
      if (!info || typeof info !== "object" || !("version" in info) || (info.version !== 1 && info.version !== 2)) { this.#fallback(); return }
      advertised = true
      if (!("port" in info) || typeof info.port !== "number" || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw new Error("invalid QUIC discovery port")
      const hash = "certificateHash" in info ? info.certificateHash : null
      if (hash !== null && (!Array.isArray(hash) || hash.length !== 32 || !hash.every((v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255))) throw new Error("invalid QUIC certificate hash")
      const endpoint = new URL(this.url)
      endpoint.protocol = "https:"
      endpoint.port = String(info.port)
      this.#endpointPort = endpoint.port
      endpoint.pathname = "/session"
      const session = new this.ctor(endpoint.toString(), {
        ...(Array.isArray(hash) ? { serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(hash) }] } : {}),
        congestionControl: "low-latency",
        requireUnreliable: info.version === 2,
      })
      this.#session = session
      // Attach rejection handling immediately, including handshake failures.
      void session.closed.then((info) => this.#end(info.reason, info.closeCode), (error: unknown) => this.#failure(error))
      await Promise.race([session.ready, new Promise<never>((_, reject) => {
        const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(8000)])
        signal.addEventListener("abort", () => reject(new Error("QUIC handshake timed out")), { once: true })
      })])
      if (this.readyState === 3) { session.close(); return }
      const stream = await session.createBidirectionalStream()
      this.#writer = stream.writable.getWriter()
      // Opening a QUIC stream alone need not send it: write a version preface
      // so the engine can accept it and send Hello before any app messages.
      this.media = info.version === 2 ? "datagram" : "stream"
      if (this.media === "datagram") {
        if (!session.datagrams) throw new Error("browser has no unreliable datagrams")
        session.datagrams.incomingMaxAge = FRAME_LIFETIME_MS
        session.datagrams.incomingHighWaterMark = 2048
      }
      await this.#writer.write(packet(new Uint8Array([2, info.version])))
      if (this.readyState === 3) return
      this.readyState = 1
      console.info(`LWFA transport: WebTransport / QUIC ${this.media === "datagram" ? "datagrams" : "streams"} (UDP)`)
      this.onopen?.()
      void this.#control(stream.readable).catch(() => this.#end("control stream failed", 1006))
      if (this.media === "datagram") {
        this.#packets = new MediaDatagrams(
          (data) => { if (this.readyState === 1) this.onmessage?.({ data }) },
          (sequence) => this.#feedback(1, sequence),
          (window) => this.#feedback(3, window),
        )
        this.#expiry = setInterval(() => this.#packets?.expire(performance.now()), 25)
        void this.#datagrams(session.datagrams!.readable).catch(() => this.#end("media datagrams failed", 1006))
      } else {
        void this.#media(session.incomingUnidirectionalStreams).catch(() => this.#end("media stream failed", 1006))
      }
    } catch (error) {
      if (this.readyState === 3) return
      if (!advertised) {
        // Old/cross-origin engines may not serve a readable discovery route.
        // Preserve their existing WebSocket support without masking failures
        // of an endpoint the engine explicitly advertised.
        this.#fallback()
        return
      }
      // An advertised endpoint failing must be visible, not quietly return
      // to TCP and pretend the requested QUIC transport is working.
      this.#failure(error)
    }
  }

  #fallback(): void {
    if (this.readyState === 3) return
    this.transport = "websocket"
    console.info("LWFA transport: WebSocket (WebTransport discovery unavailable)")
    const socket = new LegacySocket(this.url)
    this.#legacy = socket
    socket.binaryType = this.binaryType
    socket.onopen = () => { this.readyState = 1; this.onopen?.() }
    socket.onmessage = (event) => this.onmessage?.(event)
    socket.onclose = (event) => this.#end(event.reason, event.code)
    socket.onerror = () => this.onerror?.()
  }

  async #control(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = new PacketReader(readable.getReader())
    const decoder = new TextDecoder("utf-8", { fatal: true })
    while (this.readyState === 1) {
      const data = await reader.packet(MAX_CONTROL)
      if (this.readyState === 1) this.onmessage?.({ data: decoder.decode(data) })
    }
  }

  async #media(streams: ReadableStream<ReadableStream<Uint8Array>>): Promise<void> {
    const reader = streams.getReader()
    while (this.readyState === 1) {
      const next = await reader.read()
      if (next.done) return
      if (++this.#lanes > MAX_LANES) throw new Error("too many QUIC media streams")
      void this.#lane(next.value).catch(() => this.#end("media lane failed", 1006))
    }
  }

  async #lane(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = new PacketReader(readable.getReader())
    const kind = (await reader.exact(1))[0]
    if (kind !== 1 && kind !== 2) throw new Error("unknown media stream kind")
    while (this.readyState === 1) {
      const length = await reader.length(MAX_MEDIA)
      if (length < 9) throw new Error("short media packet")
      const sequence = await reader.exact(8)
      // Allocate the payload once, with no sequence prefix to strip/copy.
      const data = await reader.exact(length - 8)
      if (this.readyState !== 1) return
      // The ack releases only this packet's server-side byte budget. The
      // server validates the sequence; clients never supply byte counts.
      const ack = new Uint8Array(9)
      ack[0] = 1
      ack.set(sequence, 1)
      this.#write(ack)
      this.onmessage?.({ data: data.buffer })
    }
  }

  async #datagrams(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader()
    while (this.readyState === 1) {
      const next = await reader.read()
      if (next.done) return
      if (this.readyState === 1) this.#packets?.receive(next.value, performance.now())
    }
  }
  setWindows(windows: readonly number[]): void {
    this.#packets?.setWindows(windows.map((id) => BigInt(id)), performance.now())
  }
  #feedback(kind: number, value: bigint): void {
    const bytes = new Uint8Array(9)
    bytes[0] = kind
    new DataView(bytes.buffer).setBigUint64(1, value)
    this.#write(bytes)
  }

  #write(bytes: Uint8Array): void {
    if (this.readyState !== 1) return
    if (bytes.length > MAX_CONTROL || this.#queued + bytes.length > MAX_CONTROL) { this.#end("control queue overflow", 1006); return }
    this.#queued += bytes.length
    this.#writes = this.#writes.then(async () => {
      if (this.readyState === 1) await this.#writer!.write(packet(bytes))
    }).catch(() => this.#end("control write failed", 1006)).finally(() => { this.#queued -= bytes.length })
  }

  send(data: string): void {
    if (this.#legacy) { this.#legacy.send(data); return }
    const text = new TextEncoder().encode(data)
    const out = new Uint8Array(text.length + 1)
    out.set(text, 1)
    this.#write(out)
  }
  #end(reason: string, code: number): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.#abort.abort()
    if (this.#expiry !== null) clearInterval(this.#expiry)
    this.#packets?.clear()
    this.#session?.close()
    this.#legacy?.close()
    this.onclose?.({ reason, code })
  }
  close(): void { this.#end("", 1000) }
}
