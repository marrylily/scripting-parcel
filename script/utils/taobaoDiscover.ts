/**
 * 淘宝发现订单的阶段决策。
 * H5 导航超时不是整轮失败：先看已经提交的文档，没有真实订单且不是登录/验证页时，预算还够就继续 PC 页。
 * 空文档不算同步成功。登录页和验证页在这里停止，不再往下试。
 */

export type SalvageClass = "orders" | "auth" | "empty-ready" | "empty-dom"

export type SalvageInput = {
  ids: string[]
  auth: boolean
  verify: boolean
  readyState: string
  htmlLen: number
  emptyConfirmed: boolean
}

export function classifySalvage(input: SalvageInput): SalvageClass {
  const ids = (input.ids || []).map(id => String(id).trim()).filter(id => /^\d{10,}$/.test(id))
  if (input.auth || input.verify) return "auth"
  if (ids.length > 0) return "orders"
  const ready = input.readyState === "interactive" || input.readyState === "complete"
  if (input.emptyConfirmed && ready && input.htmlLen > 0) return "empty-ready"
  return "empty-dom"
}

export type StageHit =
  | { type: "orders"; ids: string[]; detail: string }
  | { type: "empty-ready"; detail: string }
  | { type: "stop"; reason: "auth" | "budget" | "capability"; detail: string }
  | { type: "miss"; detail: string }

export type ChainResult =
  | { ok: true; ids: string[]; pageReady: boolean; details: string[] }
  | { ok: false; message: string; details: string[] }

export function formatDiscoveryFailure(stages: string[]): string {
  const parts = stages.map(s => String(s ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
  const body = parts.join("；") || "订单页未就绪"
  const text = body.startsWith("淘宝") ? body : `淘宝·${body}`
  return text.length > 180 ? text.slice(0, 179) + "…" : text
}

/** 按顺序跑已有发现路径。下一步预算不够就停，不再把同一步加长。 */
export async function runStageChain(
  stages: { name: string; run: () => Promise<StageHit> }[],
  opts: { remainingMs: () => number; minMs: number; budgetDetail: () => string },
): Promise<ChainResult> {
  const details: string[] = []
  for (let i = 0; i < stages.length; i++) {
    if (i > 0 && opts.remainingMs() < opts.minMs) {
      details.push(opts.budgetDetail())
      return { ok: false, message: formatDiscoveryFailure(details), details }
    }
    const hit = await stages[i].run()
    details.push(hit.detail)
    if (hit.type === "orders") {
      return { ok: true, ids: hit.ids.filter(id => /^\d{10,}$/.test(id)), pageReady: true, details }
    }
    if (hit.type === "empty-ready") return { ok: true, ids: [], pageReady: true, details }
    if (hit.type === "stop") return { ok: false, message: hit.detail, details }
  }
  return { ok: false, message: formatDiscoveryFailure(details), details }
}
