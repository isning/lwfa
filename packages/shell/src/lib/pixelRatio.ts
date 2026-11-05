/** Browser pixel density can change without changing the CSS viewport size. */
export function devicePixelRatio(): number {
  const ratio = globalThis.devicePixelRatio
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
}

/** Rearm the resolution query after each screen/zoom change, not just once. */
export function watchPixelRatio(changed: () => void): () => void {
  if (typeof globalThis.matchMedia !== "function") return () => {}
  let query: MediaQueryList | null = null
  let stopped = false
  const rearm = () => {
    query?.removeEventListener("change", onChange)
    query = globalThis.matchMedia(`(resolution: ${devicePixelRatio()}dppx)`)
    query.addEventListener("change", onChange)
  }
  const onChange = () => {
    if (stopped) return
    rearm()
    changed()
  }
  rearm()
  return () => {
    stopped = true
    query?.removeEventListener("change", onChange)
  }
}
