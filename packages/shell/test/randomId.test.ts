import { afterEach, expect, it, vi } from "vitest"
import { randomId } from "../src/lib/randomId"

afterEach(() => vi.unstubAllGlobals())

it("creates unique UUIDs on HTTP where randomUUID is unavailable", () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  vi.stubGlobal("crypto", { getRandomValues })
  const ids = Array.from({ length: 100 }, () => randomId())
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  }
})

it("uses the native UUID generator when available", () => {
  const randomUUID = vi.fn(() => "native-id")
  vi.stubGlobal("crypto", { randomUUID })
  expect(randomId()).toBe("native-id")
  expect(randomUUID).toHaveBeenCalledOnce()
})
