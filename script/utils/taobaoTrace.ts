/**
 * 淘宝同步各步耗时（本机 App Group，脱敏：只有步骤名和 host+path）。
 */
import { APP_VERSION } from "./version"
import { pageUrlOf, sanitizeSyncMessage } from "./syncSafety"

export type TaobaoStep = { name: string; ms: number; ok: boolean; url?: string; note?: string }
export type TaobaoDiag = {
  at: number
  version: string
  totalMs: number
  ok: boolean
  error?: string
  steps: TaobaoStep[]
}

const FILE = () => `${FileManager.appGroupDocumentsDirectory}/cc/taobaoDiag.json`

let cur: { start: number; steps: TaobaoStep[] } | null = null

export function beginTaobaoDiag(): void {
  cur = { start: Date.now(), steps: [] }
}

export function recordTaobaoStep(name: string, ms: number, ok: boolean, url?: string, note?: string): void {
  if (!cur) return
  const step: TaobaoStep = { name, ms: Math.max(0, Math.round(ms)), ok }
  const loc = url ? pageUrlOf(url) : ""
  if (loc) step.url = loc
  if (note) step.note = String(note).slice(0, 80)
  cur.steps.push(step)
}

export function finishTaobaoDiag(ok: boolean, error?: string): TaobaoDiag {
  const started = cur?.start ?? Date.now()
  const d: TaobaoDiag = {
    at: Date.now(),
    version: APP_VERSION,
    totalMs: Math.max(0, Date.now() - started),
    ok,
    steps: cur?.steps ?? [],
  }
  if (error) d.error = sanitizeSyncMessage(String(error), 80)
  cur = null
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(FILE(), JSON.stringify(d))
  } catch { }
  return d
}

export function readTaobaoDiag(): TaobaoDiag | null {
  try {
    const f = FILE()
    if (!FileManager.existsSync(f)) return null
    const v = JSON.parse(FileManager.readAsStringSync(f) || "null")
    if (!v || !Array.isArray(v.steps)) return null
    return v as TaobaoDiag
  } catch { return null }
}
