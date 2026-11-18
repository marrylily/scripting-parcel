// 网页接管：撞上滑块/登录墙时，把「已带登录态的页面」弹给用户，人处理完再把网页收回。
//
// 做法照 Tencent/BrowserSkill 的 request-help + command-deadline：
//   1. 显式超时——到点一定收手，不留一个卡在半截的 WebView；
//   2. 单次探测也有截止时间——页面跳转时 evaluateJavaScript 会一直挂着，
//      只给整个循环设超时没用，轮询根本走不到下一轮；
//   3. 用户关掉页面 = 立刻中止，不等下一次轮询（浏览器里「借出的标签被关掉」同理）；
//   4. 只有真的过了验证才回收会话，失败一律不动原有凭证，避免把半登录态存成已授权；
//   5. 自动接管失败后记冷却：短时间内不再自动弹，免得越撞越严。
//
// 各平台只需要描述三件事：从哪儿进、怎么算「过了」、怎么把新会话存回去。

const delay = (ms: number) => new Promise<void>(r => (setTimeout as any)(r, ms))

export type CookieLike = {
  name: string; value: string; domain?: string; path?: string
  isSecure?: boolean; isHTTPOnly?: boolean; isSessionOnly?: boolean; expiresDate?: Date
}

export type TakeoverResult = {
  ok: boolean
  reason: "done" | "timeout" | "closed" | "cooling" | "error"
  /** 耗时（毫秒） */
  ms: number
  /** 探测次数，排查「一直不结束」用 */
  polls: number
}

export type TakeoverSpec = {
  /** 冷却与诊断用的键，一般就是平台 id */
  key: string
  title: string
  url: string
  /** 直接给 Cookie：逐条塞进 WebView */
  cookies?: () => CookieLike[]
  /** 需要更多准备（UA、localStorage、修版脚本）时自定义 */
  seed?: (c: WebViewController) => Promise<void>
  /** 页面已经恢复正常：真值即收手 */
  done: (c: WebViewController) => Promise<boolean>
  /** 成功后的会话回收（存钥匙串）。抛错不影响 ok */
  collect?: (c: WebViewController) => Promise<void> | void
  /** 最多等多久，默认 3 分钟 */
  minutes?: number
  /** 轮询间隔，默认 1200ms */
  pollMs?: number
  /** 首次加载预算，默认 15s */
  loadMs?: number
}

const LAST_KEY = "cc.verify.last"
const COOL_KEY = "cc.verify.cool"
/** 自动接管失败后的静默时长：风控只会越撞越严，先让页面凉一会儿 */
const DEFAULT_COOL_MS = 10 * 60_000

/** 给一个可能永远不 resolve 的 Promise 加预算：超时就先往下走 */
export function withBudget<T>(p: Promise<T> | T, ms: number, fallback: T): Promise<T> {
  const promise = Promise.resolve(p).catch(() => fallback)
  return new Promise<T>(resolve => {
    let done = false
    const t = (setTimeout as any)(() => { if (!done) { done = true; resolve(fallback) } }, ms)
    promise.then(v => { if (!done) { done = true; clearTimeout(t); resolve(v) } })
  })
}

function readMap(key: string): Record<string, any> {
  try {
    const raw = Storage.get<string>(key)
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === "object" ? v : {}
  } catch { return {} }
}

function writeMap(key: string, v: Record<string, any>) {
  try { Storage.set(key, JSON.stringify(v)) } catch { }
}

/** 还剩多久才允许自动接管（0 = 现在就可以） */
export function cooldownLeft(key: string): number {
  const until = Number(readMap(COOL_KEY)[key] ?? 0)
  return Math.max(0, until - Date.now())
}

export function markCooldown(key: string, ms = DEFAULT_COOL_MS): void {
  const all = readMap(COOL_KEY)
  all[key] = Date.now() + Math.max(0, ms)
  writeMap(COOL_KEY, all)
}

export function clearCooldown(key: string): void {
  const all = readMap(COOL_KEY)
  delete all[key]
  writeMap(COOL_KEY, all)
}

/** 上一次接管的结果，给设置页显示「上次验证：失败（超时）」 */
export function lastTakeover(key: string): (TakeoverResult & { at: number }) | null {
  const v = readMap(LAST_KEY)[key]
  return v && typeof v === "object" ? v as any : null
}

/** 通用拦截词表：滑块/人机/限流都算，调用方再按需要收紧 */
const CHALLENGE_RE = /滑动验证|滑块验证|请完成验证|安全验证|安全校验|人机验证|验证码|captcha|访问过于频繁|请求过于频繁|操作太频繁|异常访问|请先完成验证/i

export function looksChallenged(text: string): boolean {
  return CHALLENGE_RE.test(String(text || "").slice(0, 800))
}

/** 只有真需要人动手的才值得弹页：限流类等一会儿自己就过 */
export function needsHuman(text: string): boolean {
  return /滑动验证|滑块验证|请完成验证|安全验证|人机验证|验证码|captcha|请先完成验证/i.test(String(text || "").slice(0, 800))
}

/**
 * 把页面弹给用户，等人处理完再收回。
 * @param opts.auto 同步流程里的自动接管：冷却期内直接放弃，不打扰用户
 * @param opts.force 用户主动点的「去验证」：无视冷却
 */
export async function takeover(spec: TakeoverSpec, opts: { auto?: boolean; force?: boolean } = {}): Promise<TakeoverResult> {
  const start = Date.now()
  if (opts.auto && !opts.force) {
    const left = cooldownLeft(spec.key)
    if (left > 0) return { ok: false, reason: "cooling", ms: 0, polls: 0 }
  }
  const controller = new WebViewController()
  let presented = false
  let polls = 0
  try {
    if (spec.seed) {
      try { await withBudget(spec.seed(controller), 8000, undefined as any) } catch { }
    } else {
      for (const c of (spec.cookies?.() ?? [])) {
        try { await withBudget(controller.setCookie(c as any), 1500, false) } catch { }
      }
    }
    try { await withBudget(controller.loadURL(spec.url), spec.loadMs ?? 15000, false) } catch { }
    try { await withBudget(controller.waitForLoad(), 8000, false) } catch { }

    presented = true
    const closed = controller.present({ fullscreen: true, navigationTitle: spec.title })
      .then(() => { presented = false })
      .catch(() => { presented = false })

    const deadline = start + (spec.minutes ?? 3) * 60_000
    let ok = false
    let reason: TakeoverResult["reason"] = "timeout"
    while (presented && Date.now() < deadline) {
      await delay(spec.pollMs ?? 1200)
      if (!presented) break
      polls++
      // 单次探测也要有预算：页面正在跳转时这一步可能挂住
      if (await withBudget(Promise.resolve().then(() => spec.done(controller)), 6000, false)) {
        ok = true
        reason = "done"
        break
      }
    }
    if (!ok) reason = presented ? "timeout" : "closed"
    if (ok && spec.collect) {
      try { await withBudget(Promise.resolve().then(() => spec.collect!(controller)), 8000, undefined as any) } catch { }
    }
    if (presented) { try { controller.dismiss() } catch { } }
    try { await closed } catch { }
    await delay(400)
    const result: TakeoverResult = { ok, reason, ms: Date.now() - start, polls }
    const all = readMap(LAST_KEY)
    all[spec.key] = { ...result, at: Date.now() }
    writeMap(LAST_KEY, all)
    // 只有「人没处理完」才冷却；用户主动关掉是他自己的选择，不该被拦下一次
    if (!ok && reason === "timeout") markCooldown(spec.key)
    return result
  } catch {
    const result: TakeoverResult = { ok: false, reason: "error", ms: Date.now() - start, polls }
    const all = readMap(LAST_KEY)
    all[spec.key] = { ...result, at: Date.now() }
    writeMap(LAST_KEY, all)
    return result
  } finally {
    try { controller.dispose() } catch { }
  }
}
