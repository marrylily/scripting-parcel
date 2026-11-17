import { APP_VERSION } from "./version"
/**
 * 同步辅助：手动同步顺序、脱敏结论文案、预算判断。
 * 不要在这里用 setTimeout 做 Promise 超时竞速。
 * 原包 utils/widgetTasks.ts 已说明：Timer 会报
 * “Timer requires its active script on the main JS execution queue”。
 */

export { APP_VERSION }

export const MANUAL_SYNC_MS = 120_000
export const HUMAN_VERIFY_MIN_MS = 15_000

/** 失败文案带版本和时间，便于区分旧版残留与本轮新失败。 */
export function tagSyncError(msg: string, at = Date.now()): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, "0")
  const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  const body = String(msg ?? "").replace(/\s+/g, " ").trim() || "同步失败"
  return `${APP_VERSION} ${stamp}：${body}`
}

export function remainingMs(deadline: number, now = Date.now()): number {
  if (!Number.isFinite(deadline)) return Number.POSITIVE_INFINITY
  return Math.max(0, deadline - now)
}

export function deadlineReached(deadline?: number, now = Date.now()): boolean {
  return !!deadline && Number.isFinite(deadline) && now > deadline
}

/** 把已有等待上限收束到剩余预算，不用新的 setTimeout。 */
export function waitCap(deadline: number | undefined, cap: number, now = Date.now()): number {
  if (!deadline || !Number.isFinite(deadline)) return cap
  return Math.max(0, Math.min(cap, deadline - now))
}

/** 剩余预算太短时不打开人机验证页（不是跳过验证，只是把原因留给界面，避免挡住后续平台）。 */
export function shouldStartHumanVerify(deadline: number, minMs = HUMAN_VERIFY_MIN_MS, now = Date.now()): boolean {
  return remainingMs(deadline, now) >= minMs
}

/** 手动全量：菜鸟（无 WebView）先行。自动/组件同步仍用原轮换顺序。 */
export function orderForManualSync(ids: string[]): string[] {
  const cn = ids.filter(id => id === "cainiao")
  const rest = ids.filter(id => id !== "cainiao")
  return [...cn, ...rest]
}

/** 去掉 Cookie/Token/带查询的链接后再给界面看。 */
export function sanitizeSyncMessage(raw: string, max = 48): string {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim()
  t = t.replace(/(cookie|token|authorization|passwd|password|sign|_m_h5_tk|appkey|ebusinessid)[=:：]\s*[^\s,;，]+/ig, "$1=***")
  t = t.replace(/https?:\/\/[^\s]+/ig, (u) => {
    try {
      const x = new URL(u)
      return x.origin + x.pathname
    } catch {
      return "[链接]"
    }
  })
  if (t.length <= max) return t
  return t.slice(0, Math.max(0, max - 1)) + "…"
}

export type SyncOutcome = { name?: string; outcome?: string; message?: string }

export function summarizeReport(results: Record<string, SyncOutcome> | undefined): string {
  const values = Object.values(results ?? {})
  const failed = values.filter(r => r.outcome === "failed")
  const skipped = values.filter(r => r.outcome === "skipped")
  const ok = values.filter(r => r.outcome === "ok")
  if (failed.length === 0 && skipped.length === 0) return ""
  const parts: string[] = []
  if (ok.length && failed.length) parts.push(`${ok.map(o => o.name || "平台").join("、")}已完成`)
  for (const f of failed) parts.push(`${f.name || "平台"}：${sanitizeSyncMessage(f.message || "失败", 20)}`)
  for (const s of skipped) parts.push(`${s.name || "平台"}：${sanitizeSyncMessage(s.message || "已跳过", 16)}`)
  return sanitizeSyncMessage(parts.join("；"), 80)
}
