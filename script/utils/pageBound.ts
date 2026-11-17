/**
 * 给淘宝页面操作加真正的上限。
 *
 * 官方 WebView（https://scriptingapp.github.io/guide/Device%20Capabilities/WebViewController）：
 * - loadRequest({ timeoutInterval }) 的单位是秒，成功解析 true，失败/取消/被替换解析 false。这是一次加载等待。
 * - waitForLoad({ timeout, cancelOnTimeout:true }) 超时拒绝（code: "timeout"），并停止当前导航。
 * - stopLoading() 让加载等待以 false 结束。
 * - 文档被替换、进程退出或 dispose() 时，未完成的 evaluateJavaScript 会被拒绝。
 *
 * 不要在 loadURL 已经等过加载事件之后再 waitForLoad。单页应用里第二次加载事件可能永远不来。
 * 计时器抛错时不再无限等待原 Promise；没有官方超时、又排不上计时器，就报能力错误。
 */
import { formatStepTimeout } from "./syncSafety"

export type TimerSchedule = (fn: () => void, ms: number) => { id: unknown; scheduled: boolean }
export type TimerClear = (id: unknown) => void

export type PageSurface = {
  loadRequest?: (request: { url: string; timeoutInterval?: number }) => Promise<boolean>
  loadURL?: (url: string) => Promise<boolean>
  waitForLoad?: (options?: { timeout?: number; cancelOnTimeout?: boolean }) => Promise<boolean>
  stopLoading?: () => Promise<void> | void
  evaluateJavaScript?: <T = unknown>(code: string) => Promise<T>
  dispose?: () => void
}

export class PageTimeoutError extends Error {
  readonly code = "page-timeout"
  readonly step: string
  constructor(step: string) {
    super(step)
    this.name = "PageTimeoutError"
    this.step = step
  }
}

export class PageCapabilityError extends Error {
  readonly code = "page-capability"
  constructor() {
    super("淘宝·页面计时不可用，已停止本次同步")
    this.name = "PageCapabilityError"
  }
}

export function isPageTimeout(e: unknown): e is PageTimeoutError {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "page-timeout"
}

export function isPageCapability(e: unknown): e is PageCapabilityError {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "page-capability"
}

type SettleOpts = {
  schedule: TimerSchedule
  clear: TimerClear
  /** start() 自己带官方超时（loadRequest / waitForLoad timeout）时为 true。 */
  nativeBound: boolean
  onTimeout?: () => void
}

function silence(p: unknown): void {
  if (p && typeof (p as Promise<unknown>).then === "function") {
    void (p as Promise<unknown>).then(() => {}, () => {})
  }
}

/**
 * 先尝试排程。排不上且操作本身没有官方超时时，不调用 start。
 * 超时后 start 的迟到成功不会变成返回值。
 */
export async function settleWithin<T>(start: () => Promise<T>, ms: number, opts: SettleOpts): Promise<
  { ok: true; value: T } | { ok: false; reason: "timeout" | "capability" }
> {
  if (!(ms > 0) || !Number.isFinite(ms)) return { ok: false, reason: "timeout" }

  let timedOut = false
  let rejectTimer: ((e: Error) => void) | undefined
  const timerPromise = new Promise<never>((_, reject) => { rejectTimer = reject })
  void timerPromise.then(() => {}, () => {})

  let scheduled = false
  let timerId: unknown
  try {
    const armed = opts.schedule(() => {
      if (timedOut) return
      timedOut = true
      try { opts.onTimeout?.() } catch { /* 清理失败也要结束等待 */ }
      rejectTimer?.(new Error("timeout"))
    }, ms)
    timerId = armed?.id
    scheduled = !!armed?.scheduled
  } catch {
    scheduled = false
  }

  if (!scheduled && !opts.nativeBound) return { ok: false, reason: "capability" }

  const op = Promise.resolve().then(start)
  void op.then(() => {}, () => {})

  if (!scheduled) {
    const value = await op
    return { ok: true, value }
  }

  try {
    const value = await Promise.race([op, timerPromise])
    try { opts.clear(timerId) } catch { /* 取消计时失败不影响结果 */ }
    if (timedOut) return { ok: false, reason: "timeout" }
    return { ok: true, value }
  } catch (e) {
    try { opts.clear(timerId) } catch { /* 同上 */ }
    if (timedOut) return { ok: false, reason: "timeout" }
    throw e
  }
}

function stopQuiet(page: PageSurface): void {
  try { silence(page.stopLoading?.()) } catch { /* 页面可能已经关掉 */ }
}

/** 只等一次加载。有 loadRequest 时不再调用 waitForLoad。 */
export async function loadPageBounded(
  page: PageSurface,
  url: string,
  ms: number,
  step: string,
  schedule: TimerSchedule,
  clear: TimerClear,
): Promise<void> {
  const seconds = Math.max(0.05, ms / 1000)
  const fail = (reason: "timeout" | "capability") => {
    if (reason === "capability") throw new PageCapabilityError()
    throw new PageTimeoutError(step)
  }

  if (typeof page.loadRequest === "function") {
    const result = await settleWithin(
      () => page.loadRequest!({ url, timeoutInterval: seconds }),
      ms,
      { schedule, clear, nativeBound: true, onTimeout: () => stopQuiet(page) },
    )
    if (!result.ok) fail(result.reason)
    if (result.value !== true) throw new PageTimeoutError(step)
    return
  }

  if (typeof page.waitForLoad === "function" && typeof page.loadURL === "function") {
    const result = await settleWithin(
      () => {
        silence(page.loadURL!(url))
        return page.waitForLoad!({ timeout: seconds, cancelOnTimeout: true })
      },
      ms,
      { schedule, clear, nativeBound: true, onTimeout: () => stopQuiet(page) },
    )
    if (!result.ok) fail(result.reason)
    if (result.value !== true) throw new PageTimeoutError(step)
    return
  }

  if (typeof page.loadURL !== "function") throw new PageCapabilityError()
  const result = await settleWithin(
    () => page.loadURL!(url),
    ms,
    {
      schedule,
      clear,
      nativeBound: false,
      onTimeout() {
        stopQuiet(page)
        try { page.dispose?.() } catch { /* dispose 是官方用来结束未完成加载的办法 */ }
      },
    },
  )
  if (!result.ok) fail(result.reason)
  if (result.value !== true) throw new PageTimeoutError(step)
}

/** evaluateJavaScript 没有官方超时参数。排不上计时器就不调用它。 */
export async function evaluateBounded<T>(
  page: PageSurface,
  script: string,
  ms: number,
  step: string,
  schedule: TimerSchedule,
  clear: TimerClear,
): Promise<T> {
  if (typeof page.evaluateJavaScript !== "function") throw new PageCapabilityError()
  const result = await settleWithin(
    () => page.evaluateJavaScript!<T>(script),
    ms,
    {
      schedule,
      clear,
      nativeBound: false,
      onTimeout() {
        stopQuiet(page)
        // 官方：文档被替换或 dispose 时，未完成的脚本会拒绝。不把这次替换当成第二次等加载事件。
        if (typeof page.loadURL === "function") silence(page.loadURL("about:blank"))
        else {
          try { page.dispose?.() } catch { /* 没有加载接口时只能释放控制器 */ }
        }
      },
    },
  )
  if (!result.ok && result.reason === "capability") throw new PageCapabilityError()
  if (!result.ok) throw new PageTimeoutError(step)
  return result.value as T
}

/** 给调用方把页面超时收成带真实耗时的文案。elapsedMs 用调用方自己的时钟，不用 0。 */
export function pageTimeoutMessage(step: string, elapsedMs: number, pageUrl?: string): string {
  return formatStepTimeout(step, elapsedMs, pageUrl)
}
