/**
 * Scripting 定时器必须在当前脚本的主 JS 执行队列上调度。
 * 官方：定时器跑在 script queue，Script.exit 时取消
 *   https://scriptingapp.github.io/TestFlight/guide/Changelog/3.2.2/Script%20Timers%20and%20Scheduling
 * 官方 Thread：部分系统/异步回调可能不在主线程
 *   https://scriptingapp.github.io/guide/Utilities/Thread
 * 原包 utils/widgetTasks.ts 已写明：扩展进程里用 setTimeout 包同步会抛
 * “Timer requires its active script on the main JS execution queue”。
 * 淘宝发现订单在 await WebView 之后调用 setTimeout（pageTimeout/delay）也会踩到。
 * 本模块：尽量在主线程调度；调度失败则降级，绝不把该错误抛给同步流程。
 */

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

function onScriptQueue(fn: () => void): void {
  const th = threadApi()
  try {
    if (th && th.isMainThread === false) {
      th.runInMain(fn)
      return
    }
  } catch { }
  fn()
}

/** 尝试调度超时回调。scheduled=false 表示 Timer 不可用，调用方应降级而不是把 fn 当超时触发。 */
export function tryScheduleTimeout(fn: () => void, ms: number): { id: any; scheduled: boolean } {
  let id: any
  let scheduled = false
  try {
    onScriptQueue(() => {
      try {
        id = (setTimeout as any)(fn, ms)
        scheduled = true
      } catch { }
    })
  } catch { }
  return { id, scheduled }
}

export function tryScheduleInterval(fn: () => void, ms: number): { id: any; scheduled: boolean } {
  let id: any
  let scheduled = false
  try {
    onScriptQueue(() => {
      try {
        id = (setInterval as any)(fn, ms)
        scheduled = true
      } catch { }
    })
  } catch { }
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
 * 可调度 Timer 时做超时竞速；否则只等待原 Promise，不加硬超时。
 * 用于页面加载/请求，避免在 WebView 回调上下文里抛 Timer 错误。
 */
export function safeTimeoutRace<T>(p: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const { id, scheduled } = tryScheduleTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error(timeoutMessage))
      }
    }, ms)
    p.then(
      v => { if (!settled) { settled = true; if (scheduled) safeClearTimeout(id); resolve(v) } },
      e => { if (!settled) { settled = true; if (scheduled) safeClearTimeout(id); reject(e) } },
    )
  })
}

export function pageTimeout<T>(p: Promise<T>, ms: number, timeoutMessage = "页面超时"): Promise<T> {
  return safeTimeoutRace(p, ms, timeoutMessage)
}
