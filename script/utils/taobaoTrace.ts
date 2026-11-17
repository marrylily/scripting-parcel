/**
 * 淘宝同步各步耗时（本机 App Group，脱敏：只有步骤名和 host+path）。
 * 每一轮有自己的 id。后一轮开始后，前一轮的补记和收尾不能再改这份诊断。
 */
import { APP_VERSION } from "./version"
import { pageUrlOf, sanitizeSyncMessage } from "./syncSafety"

export type TaobaoStep = { name: string; ms: number; ok: boolean; url?: string; note?: string }
export type TaobaoDiag = {
  at: number
  version: string
  runId: number
  totalMs: number
  ok: boolean
  error?: string
  steps: TaobaoStep[]
}

const FILE = () => `${FileManager.appGroupDocumentsDirectory}/cc/taobaoDiag.json`

type OpenRun = { id: number; start: number; steps: TaobaoStep[]; finished: boolean }

let seq = 0
let cur: OpenRun | null = null

export function beginTaobaoDiag(now = Date.now()): number {
  const id = ++seq
  cur = { id, start: now, steps: [], finished: false }
  return id
}

export function recordTaobaoStep(name: string, ms: number, ok: boolean, url?: string, note?: string, runId?: number): void {
  if (!cur || cur.finished) return
  if (runId == null || runId !== cur.id) return
  const step: TaobaoStep = { name, ms: Math.max(0, Math.round(ms)), ok }
  const loc = url ? pageUrlOf(url) : ""
  if (loc) step.url = loc
  if (note) step.note = sanitizeSyncMessage(String(note), 80)
  cur.steps.push(step)
}

/** 当 H5 订单页因静态子资源/埋点未结束触发超时，但已提交文档成功读出真实订单时，将对应加载步骤修正为完成。 */
export function resolveTaobaoStep(name: string, url?: string, note?: string, runId?: number): void {
  if (!cur || cur.finished) return
  if (runId == null || runId !== cur.id) return
  for (let i = cur.steps.length - 1; i >= 0; i--) {
    if (cur.steps[i].name === name) {
      cur.steps[i].ok = true
      const loc = url ? pageUrlOf(url) : ""
      if (loc) cur.steps[i].url = loc
      if (note !== undefined) {
        if (note) cur.steps[i].note = sanitizeSyncMessage(String(note), 80)
        else delete cur.steps[i].note
      }
      return
    }
  }
}

export function abandonTaobaoDiag(runId: number): void {
  if (!cur || cur.id !== runId) return
  cur.finished = true
  cur = null
}

export function finishTaobaoDiag(ok: boolean, error?: string, runId?: number, now = Date.now()): TaobaoDiag | null {
  if (!cur || cur.finished) return null
  if (runId == null || runId !== cur.id) return null
  const run = cur
  run.finished = true
  const d: TaobaoDiag = {
    at: now,
    version: APP_VERSION,
    runId: run.id,
    totalMs: Math.max(0, now - run.start),
    ok,
    steps: run.steps,
  }
  if (error) d.error = sanitizeSyncMessage(String(error), 120)
  if (cur === run) cur = null
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(FILE(), JSON.stringify(d))
  } catch { /* 界面读不到文件时就当没有诊断 */ }
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

export function resetTaobaoDiagForTests(): void {
  seq = 0
  cur = null
}
