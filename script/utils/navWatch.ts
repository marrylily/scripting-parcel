/**
 * 官方导航事件：https://scriptingapp.github.io/guide/Device%20Capabilities/WebViewController
 * addEventListener / removeEventListener，事件名 redirect、commit、loadFinish、loadError。
 * 每个事件有 type、可空 navigationId、state.url。用同一函数引用移除。监听异常不能影响其它监听。
 * 只保留脱敏后的 host 和路径。查询、片段、Cookie、账号和订单内容不进入诊断。
 */

export const NAV_EVENT_TYPES = ["redirect", "commit", "loadFinish", "loadError"] as const
export type NavEventType = (typeof NAV_EVENT_TYPES)[number]
export type NavKind = "auth" | "app-launch" | "other" | "empty"

export type NavObservation = {
  type: NavEventType
  atMs: number
  navigationId: string
  location: string
  kind: NavKind
}

export type NavPage = {
  addEventListener?: (type: string, listener: (event: any) => void) => Promise<void> | void
  removeEventListener?: (type: string, listener: (event: any) => void) => Promise<void> | void
  stopLoading?: () => Promise<void> | void
}

const AUTH_HOST = /^(?:login(?:\.m)?|passport|havana|havanaone)\.(?:taobao|tmall|alibaba)\.com$/i
const AUTH_PATH = /\/(?:member\/login|login\/login)(?:\/|$)/i
const APP_SCHEME = /^(?:tbopen|taobao|tmall|itaobao)$/i

export function classifyLocation(raw: string): NavKind {
  const s = String(raw ?? "").trim()
  if (!s) return "empty"
  const scheme = s.split(":")[0]?.toLowerCase() ?? ""
  if (scheme && !/^https?$/i.test(scheme) && APP_SCHEME.test(scheme)) return "app-launch"
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`)
    if (AUTH_HOST.test(u.hostname) || AUTH_PATH.test(u.pathname)) return "auth"
    return "other"
  } catch {
    return "other"
  }
}

/** 去掉查询和片段，并把路径里的长数字或长令牌收成占位。 */
export function redactLocation(raw: string): string {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  const scheme = s.split(":")[0]?.toLowerCase() ?? ""
  if (scheme && !/^https?$/i.test(scheme) && APP_SCHEME.test(scheme)) return `${scheme}:`
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`)
    const path = u.pathname
      .split("/")
      .map(seg => {
        if (!seg) return ""
        if (/\d{6,}/.test(seg) || seg.length > 24) return "{id}"
        return seg
      })
      .join("/")
      .replace(/\/+$/, "")
    return `${u.hostname}${path === "/" ? "" : path}`
  } catch {
    return ""
  }
}

export function safeNavigationId(raw: unknown): string {
  const s = String(raw ?? "")
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : (s ? "有" : "无")
}

export function formatObservedTimeout(step: string, elapsedMs: number, requested: string, observed: string): string {
  const sec = (Math.max(0, Number(elapsedMs) || 0) / 1000).toFixed(1)
  const req = redactLocation(requested) || "无"
  const obs = observed || "无"
  return `淘宝·${step}超时 ${sec}s 请求 ${req} 观察到 ${obs}`
}

export function authStopMessage(kind: NavKind, location: string): string {
  const loc = location ? ` ${location}` : ""
  if (kind === "app-launch") return `淘宝需要在前台完成登录或 App 授权，同步不能自动跳过验证${loc}`
  return `淘宝需重新登录或完成验证${loc}`
}

export type NavWatch = {
  events: NavObservation[]
  authDetail: string | null
  lastLocation: string
  stop: () => Promise<void>
}

export async function attachNavWatch(page: NavPage, startedAt = Date.now(), onCommit?: () => void): Promise<NavWatch> {
  const events: NavObservation[] = []
  const watch: NavWatch = {
    events,
    authDetail: null,
    lastLocation: "",
    stop: async () => {},
  }
  let closed = false
  const bound: { type: NavEventType; fn: (event: any) => void }[] = []
  const onEvent = (type: NavEventType) => (event: any) => {
    if (closed) return
    try {
      const raw = String(event?.state?.url ?? "")
      const location = redactLocation(raw)
      const kind = classifyLocation(raw)
      const obs: NavObservation = {
        type,
        atMs: Math.max(0, Date.now() - startedAt),
        navigationId: safeNavigationId(event?.navigationId),
        location,
        kind,
      }
      events.push(obs)
      if (location) watch.lastLocation = location
      if ((kind === "auth" || kind === "app-launch") && !watch.authDetail) {
        watch.authDetail = authStopMessage(kind, location)
        try { void page.stopLoading?.() } catch { /* 停导航失败也要结束本轮 */ }
      } else if (type === "commit" && kind === "other" && !watch.authDetail) {
        try { onCommit?.() } catch { /* commit 回调异常不影响导航监听 */ }
      }
    } catch { /* 单个监听异常不向外抛 */ }
  }
  try {
    if (typeof page.addEventListener === "function") {
      for (const type of NAV_EVENT_TYPES) {
        const fn = onEvent(type)
        try {
          await page.addEventListener(type, fn)
          bound.push({ type, fn })
        } catch { /* 这个事件不可用时继续登记其它事件 */ }
      }
    }
  } catch { /* 没有监听接口时仍按加载结果判断 */ }
  watch.stop = async () => {
    closed = true
    if (typeof page.removeEventListener !== "function") return
    for (const item of bound) {
      try { await page.removeEventListener(item.type, item.fn) } catch { /* 移除失败不掩盖同步结果 */ }
    }
  }
  return watch
}
