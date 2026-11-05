import {
  performanceStats,
  observe,
  count,
  resetFrameTimings,
  bufferedMediaKiB,
} from "./performance"
import { statsNow, subscribe as subscribeStreamStats } from "./streamStats"
import { diagnostics as audioDiagnostics } from "./audio"

/** Recording lifetime belongs to the session, not the panel displaying it. */
export function recordPerformance(): () => void {
  performanceStats.setEnabled(true)
  const stopStreamStats = subscribeStreamStats(() => {})
  let previousRaf: number | null = null,
    previousUnderruns: number | null = null
  let raf = 0
  const frame = (now: number) => {
    if (document.visibilityState !== "hidden") {
      if (previousRaf !== null) observe("rafGap", now - previousRaf)
      previousRaf = now
    } else previousRaf = null
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  let observer: PerformanceObserver | null = null
  if (
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    observer = new PerformanceObserver((list) => {
      if (document.visibilityState !== "hidden")
        for (const entry of list.getEntries())
          observe("longTask", entry.duration)
    })
    observer.observe({ type: "longtask" })
  }
  const visibility = () => {
    previousRaf = null
    resetFrameTimings()
  }
  document.addEventListener("visibilitychange", visibility)
  const timer = setInterval(() => {
    const stream = statsNow(),
      audio = audioDiagnostics()
    if (audio.contextState === "running" && audio.bufferedMs >= 0)
      observe("audioBuffer", audio.bufferedMs)
    if (previousUnderruns !== null && audio.underruns >= previousUnderruns)
      count("audioUnderruns", audio.underruns - previousUnderruns)
    previousUnderruns = audio.underruns
    performanceStats.tick(performance.now(), {
      fps: stream.fps,
      kbits: stream.kbits,
      bufferedKiB: bufferedMediaKiB(),
    })
  }, 1000)
  return () => {
    clearInterval(timer)
    stopStreamStats()
    cancelAnimationFrame(raf)
    observer?.disconnect()
    document.removeEventListener("visibilitychange", visibility)
    resetFrameTimings()
    performanceStats.setEnabled(false)
  }
}
