#!/usr/bin/env node
/**
 * Start an isolated headless engine and wl_shm client, then exercise the real
 * window protocol, JPEG delivery and reconnection beyond the session grace.
 * Requires LWFA_TEST_ENGINE and LWFA_TEST_SHM_CLIENT; see docs/headless.md.
 * Keeps artifacts for diagnosis and never attaches to an existing engine.
 */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { FrameFormat, decodeFrame, decodeToShell, encode } from "../packages/proto/src/index.ts"

const hdrOutput = !!process.env.LWFA_TEST_HDR && !process.env.LWFA_TEST_HDR_FALLBACK
const enginePath = process.env.LWFA_TEST_ENGINE
const clientPath = process.env.LWFA_TEST_SHM_CLIENT
assert(enginePath && clientPath, "set LWFA_TEST_ENGINE and LWFA_TEST_SHM_CLIENT to built binaries")
const base = resolve(process.env.LWFA_TEST_OUTPUT ?? fileURLToPath(new URL("../target/headless-test/", import.meta.url)))
mkdirSync(base, { recursive: true })
const directory = mkdtempSync(join(base, "lwfa-headless-"))
const token = randomBytes(24).toString("hex")
const children = []
const sockets = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const logs = { engine: "", client: "" }
const env = { ...process.env, AUTH_PASS: token, LWFA_BACKEND: "headless", LWFA_SHELL_ADDR: "127.0.0.1:0" }
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key]
for (const [key, leaf] of Object.entries({ XDG_RUNTIME_DIR: "runtime", XDG_CONFIG_HOME: "config", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache" })) {
  env[key] = join(directory, leaf)
  mkdirSync(env[key], { mode: 0o700 })
}
env.LWFA_CONFIG = join(directory, "config.toml")
env.LWFA_NO_AUTOSTART = "1"
env.LWFA_NO_XWAYLAND = "1"
writeFileSync(env.LWFA_CONFIG, `
[backend]
mode = "headless"
width = 1280
height = 800
[session]
autostart_terminal = false
xwayland = false
[gamepad]
persistent = false
[clipboard]
desktop = false
[stream]
gpu_direct = ${process.env.LWFA_TEST_GPU_DIRECT ? "true" : "false"}
${process.env.LWFA_TEST_HDR_FALLBACK ? "max_h264_sessions = 0" : ""}
`)

function start(name, binary, overrides = {}) {
  const child = spawn(resolve(binary), [], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...env, ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
    logs[name] += data.toString().replaceAll(token, "<test-token>")
  })
  child.on("error", (error) => { logs[name] += `${error.message}\n` })
  return child
}

async function until(predicate, description, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(20)
  }
  throw new Error(`timed out: ${description}`)
}

async function connect(port, client = "headless-smoke") {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&client=${client}`)
  sockets.push(socket)
  socket.binaryType = "arraybuffer"
  const messages = [], frames = []
  let failure
  socket.addEventListener("error", () => { failure = new Error("test WebSocket failed") })
  socket.addEventListener("message", ({ data }) => {
    try {
      if (typeof data === "string") messages.push(decodeToShell(data))
      else {
        const frame = decodeFrame(data)
        if (frame && frames.length < 64) frames.push(frame)
      }
    } catch (error) { failure = error }
  })
  const wait = (predicate, description) => until(() => {
    if (failure) throw failure
    return predicate()
  }, description)
  const hello = await wait(() => messages.find((message) => message.type === "hello"), "hello")
  return { socket, messages, frames, hello, wait, send: (message) => socket.send(encode(message)) }
}

async function close(socket) {
  if (socket.readyState === WebSocket.CLOSED) return
  socket.close()
  await until(() => socket.readyState === WebSocket.CLOSED, "WebSocket close", 5_000)
}

async function verifyStream(connection, id, filename, expectedHdr = hdrOutput, codecs = process.env.LWFA_TEST_HDR ? ["hevcHdr"] : []) {
  connection.frames.length = 0
  connection.send({ type: "setViewport", width: 800, height: 600, scale: 1 })
  await connection.wait(() => (connection.hello.output.width === 800 && connection.hello.output.height === 600) || connection.messages.find((message) => message.type === "outputChanged" && message.output.width === 800 && message.output.height === 600), "headless viewport resize")
  connection.send({ type: "setLayout", windows: [{ id, rect: { x: 0, y: 0, width: 320, height: 240 }, z: 0 }], animate: null })
  connection.send({ type: "setStreams", windows: [id], codecs })
  const frame = await connection.wait(() => connection.frames.find((frame) => frame.header.window === id && frame.header.format === (expectedHdr ? FrameFormat.HevcHdr : FrameFormat.Jpeg) && frame.header.keyframe), "self-contained window frame")
  assert.equal(frame.header.format, expectedHdr ? FrameFormat.HevcHdr : FrameFormat.Jpeg)
  assert.equal(frame.header.width, 320)
  assert.equal(frame.header.height, 240)
  const path = join(directory, expectedHdr ? `${filename}.hevc` : filename)
  writeFileSync(path, frame.payload)
  if (expectedHdr) {
    const probe = spawnSync(process.env.LWFA_TEST_FFPROBE ?? "ffprobe", ["-v", "error", "-show_streams", "-show_frames", "-of", "json", path])
    assert.equal(probe.status, 0, probe.stderr?.toString())
    const stream = JSON.parse(probe.stdout.toString()).streams[0]
    assert.equal(stream.profile, "Main 10")
    const metadata = JSON.parse(probe.stdout.toString()).frames[0].side_data_list ?? []
    assert(metadata.some((entry) => entry.side_data_type === "Mastering display metadata"), "HDR10 mastering SEI required")
    assert(metadata.some((entry) => entry.side_data_type === "Content light level metadata"), "HDR10 content-light SEI required")
    assert.equal(stream.pix_fmt, "yuv420p10le")
    assert.equal(stream.color_primaries, "bt2020")
    assert.equal(stream.color_transfer, "smpte2084")
    assert.equal(stream.color_space, "bt2020nc")
    assert.equal(stream.color_range, "tv")
  }
  const decoded = spawnSync(process.env.LWFA_TEST_FFMPEG ?? "ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 2 * 1024 * 1024 })
  assert.equal(decoded.status, 0, decoded.stderr?.toString())
  assert.equal(decoded.stdout.length, 320 * 240 * 4)
  const center = (120 * 320 + 160) * 4
  for (const [channel, expected] of (expectedHdr ? [130,130,130,255] : process.env.LWFA_TEST_COLOR ? [158,158,158,255] : [204,51,34,255]).entries()) {
    assert(Math.abs(decoded.stdout[center + channel] - expected) <= 8, "decoded pixels must belong to the test client")
  }
}

try {
  const engine = start("engine", enginePath)
  const port = await until(() => {
    assert.equal(engine.exitCode, null, "engine exited during startup")
    return logs.engine.match(/open the shell at:\s+http:\/\/127\.0\.0\.1:(\d+)/)?.[1]
  }, "isolated engine listener")
  if (process.env.LWFA_TEST_COLOR) {
    const response = await fetch(`http://127.0.0.1:${port}/engine/capabilities.json`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert((await response.json()).codecs.includes("hevcHdr"), "engine must expose the additive HDR feature probe")
  }
  const display = await until(() => readdirSync(env.XDG_RUNTIME_DIR).find((file) => /^wayland-\d+$/.test(file)), "Wayland socket")
  if (process.env.LWFA_TEST_COLOR) {
    for (const invalid of ["unsupported", "duplicate", "incomplete"]) {
      const probe = start("client", clientPath, { WAYLAND_DISPLAY: display, LWFA_TEST_COLOR_INVALID: invalid })
      await until(() => probe.exitCode !== null || probe.signalCode !== null, `protocol rejection: ${invalid}`)
      assert.equal(probe.exitCode, 0, `wrong protocol error for ${invalid}`)
    }
  }
  const client = start("client", clientPath, { WAYLAND_DISPLAY: display })
  const frameCount = () => [...logs.client.matchAll(/^frame \d+$/gm)].length
  await until(() => frameCount() >= 2, "frame callbacks before a browser connects")
  const first = await connect(port)
  const window = first.hello.windows.find((window) => window.appId === "lwfa-headless-smoke")
  assert(window, "the native Wayland application must be in the session")
  await verifyStream(first, window.id, "first.jpg")
  if (hdrOutput) {
    const sdr = await connect(port, "headless-smoke-sdr")
    await verifyStream(sdr, window.id, "mixed-sdr.jpg", false, [])
    await first.wait(() => first.frames.some((frame) => frame.header.format === FrameFormat.Jpeg), "SDR viewer must downgrade the shared rendition")
    await close(sdr.socket)
    await verifyStream(first, window.id, "restored-hdr.jpg")
  }
  await close(first.socket)
  const disconnectedMs = Number(process.env.LWFA_TEST_DISCONNECT_MS ?? 46_000)
  assert(Number.isFinite(disconnectedMs) && disconnectedMs >= 0, "invalid disconnect duration")
  await sleep(disconnectedMs)
  assert.equal(engine.exitCode, null, "engine must survive browser disconnection")
  assert.equal(client.exitCode, null, "application must survive browser disconnection")
  const afterGrace = frameCount()
  await until(() => frameCount() > afterGrace, "background frame callbacks after disconnect grace")
  const second = await connect(port)
  assert(second.hello.windows.some((candidate) => candidate.id === window.id), "reconnect must restore the same window")
  await verifyStream(second, window.id, "reconnected.jpg")
  assert(!logs.engine.includes("undecodable message from shell"), "test protocol messages must be accepted by the engine")
  console.log(`PASS: no-host EGL, ${logs.client.includes("DMA-BUF imported") ? "DMA-BUF" : "wl_shm"}, viewport, decoded ${hdrOutput ? "Main10/PQ" : "JPEG"} pixels, ${disconnectedMs}ms disconnect and same-window reconnect`)
} finally {
  for (const socket of sockets) await close(socket).catch(() => {})
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await until(() => child.exitCode !== null || child.signalCode !== null, "owned child shutdown", 5_000)
  }
  for (const [name, text] of Object.entries(logs)) writeFileSync(join(directory, `${name}.log`), text.replaceAll(token, "<test-token>"))
  console.log(`Artifacts: ${directory}`)
}
