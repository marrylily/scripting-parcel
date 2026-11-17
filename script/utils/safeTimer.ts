/**
 * Scripting 定时器必须在当前脚本的主 JS 执行队列上调度。
 * 官方：定时器跑在 script queue，Script.exit 时取消
 *   https://scriptingapp.github.io/TestFlight/guide/Changelog/3.2.2/Script%20Timers%20and%20Scheduling
 * 官方 Thread.runInMain：回调不在主线程时，把注册放回主线程同步执行
 *   https://scriptingapp.github.io/guide/Utilities/Thread
 * 原包 utils/widgetTasks.ts 已写明：扩展进程里用 setTimeout 包同步会抛
 * “Timer requires its active script on the main JS execution queue”。
 * 调度失败时不再无限等待原 Promise。页面加载优先用 WebView 自己的超时，见 pageBound.ts。
 */

export class TimerUnavailableError extends Error {
  readonly code = "timer-unavailable"
  constructor() {
    super("计时器无法在主脚本队列调度，已停止等待")
    this.name = "TimerUnavailableError"
  }
}

export function isTimerUnavailable(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "timer-unavailable"
}

type ThreadApi = {
  isMainThread: boolean
  runInMain: (fn: () => void) => void
}

function threadApi(): ThreadApi | undefined {
  try {
    const t = (globalThis as any).Thread
    if (t && typeof t.runInMain === "function") return t as ThreadApi
  } catch { }
  return undefined
}

function runOnMain(fn: () => void): boolean {
  const th = threadApi()
  if (!th) return false
  let ran = false
  try {
    th.runInMain(() => {
      ran = true
      fn()
    })
  } catch {
    return false
  }
  return ran
}

/** 在主线程注册定时器。当前队列失败时再试一次 runInMain，仍失败就返回 scheduled=false。 */
function scheduleOnScriptQueue(register: () => void): boolean {
  const th = threadApi()
  const attempt = () => {
    register()
  }
  try {
    if (th && th.isMainThread === false) return runOnMain(attempt)
    attempt()
    return true
  } catch {
    return runOnMain(attempt)
  }
}

/** 尝试调度超时回调。scheduled=false 表示 Timer 不可用，调用方不能再无限等待。 */
export function tryScheduleTimeout(fn: () => void, ms: number): { id: any; scheduled: boolean } {
  let id: any
  let scheduled = false
  const ok = scheduleOnScriptQueue(() => {
    id = (setTimeout as any)(fn, ms)
    scheduled = true
  })
  if (!ok) scheduled = false
  return { id, scheduled }
}

export function tryScheduleInterval(fn: () => void, ms: number): { id: any; scheduled: boolean } {
  let id: any
  let scheduled = false
  const ok = scheduleOnScriptQueue(() => {
    id = (setInterval as any)(fn, ms)
    scheduled = true
  })
  if (!ok) scheduled = false
  return { id, scheduled }
}

export function safeClearTimeout(id: any): void {
  try { if (id != null) clearTimeout(id) } catch { }
}

export function safeClearInterval(id: any): void {
  try { if (id != null) clearInterval(id) } catch { }
}

/** 可调度则等待；否则立即结束，不抛 Timer 错误。 */
export function safeDelay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const { scheduled } = tryScheduleTimeout(resolve, ms)
    if (!scheduled) resolve()
  })
}

/**
 * 可调度 Timer 时做超时竞速。
 * 调度失败时立刻拒绝，不再挂在原 Promise 上。原 Promise 的迟到成功或失败都忽略。
 */
export function safeTimeoutRace<T>(p: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const { id, scheduled } = tryScheduleTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(timeoutMessage))
    }, ms)
    if (!scheduled) {
      void Promise.resolve(p).then(() => {}, () => {})
      reject(new TimerUnavailableError())
      return
    }
    p.then(
      v => {
        if (settled) return
        settled = true
        safeClearTimeout(id)
        resolve(v)
      },
      e => {
        if (settled) return
        settled = true
        safeClearTimeout(id)
        reject(e)
      },
    )
  })
}

export function pageTimeout<T>(p: Promise<T>, ms: number, timeoutMessage = "页面超时"): Promise<T> {
  return safeTimeoutRace(p, ms, timeoutMessage)
}
