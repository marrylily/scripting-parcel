import { COOKIE_KEY, Pkg, Snapshot, classify, closedOrderStatus, timeOfTrack, isHistoricalPkg, statusFromCode } from "./model"
import { deadlineReached, waitCap, formatStepTimeout, formatAuthNeeded, formatBudgetExhausted, remainingMs } from "./syncSafety"
import { safeTimeoutRace, tryScheduleTimeout, safeClearTimeout, isTimerUnavailable } from "./safeTimer"
import { beginTaobaoDiag, recordTaobaoStep, finishTaobaoDiag, abandonTaobaoDiag } from "./taobaoTrace"
import { evaluateBounded, isPageCapability, isPageTimeout, loadPageBounded, settleWithin, PageCapabilityError } from "./pageBound"
import { SyncSuperseded, bindRunCleanup, isSupersededError, runIsCurrent } from "./syncGate"
import { classifySalvage, formatDiscoveryFailure, type StageHit } from "./taobaoDiscover"

/** 运行时全局 fetch（类型声明里没导出，跟 Response 情况一样） */
declare const fetch: any

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

const LOGISTICS_URL = (orderId: string) =>
  `https://pages-g.m.taobao.com/wow/z/app/mtb/logisticsV2/h5-detail?x-ssr=true&bizOrderId=${orderId}&viewLogisticDetail=true&skipEnterAnimation=true&forceThemis=true&disableNav=YES`

const ODETAIL_URL = (orderId: string) =>
  `https://m.m.taobao.com/wow/z/app/tb-trade/odetail/h5-home?x-ssr=true&orderId=${orderId}&forceThemis=true&disableNav=YES&status_bar_transparent=true&openFrom=taoBoughtList`

/* ---------------- 登录态 ---------------- */

export function getCookies(): any[] {
  const raw = Keychain.get(COOKIE_KEY)
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export function hasLogin(): boolean {
  // 只认真正的登录凭证：登录页本身就会下发 _tb_token_/cookie2 这类匿名 cookie，
  // 拿「有 cookie」当已登录会让 mtop 一路 FAIL_SYS_SESSION_EXPIRED
  return getCookies().some((c: any) => ["unb", "tracknick"].includes(String(c.name)) && !!c.value)
}


export function cookieHeader(): string {
  return getCookies().map((c: any) => `${c.name}=${c.value}`).join("; ")
}

/** 打开淘宝官方登录页（账号密码 / 短信），登录后把 Cookie 存进钥匙串。扫码登录见 utils/qrlogin.ts */
export async function loginTaobao(): Promise<boolean> {
  const controller = new WebViewController()
  try {
    await controller.loadURL("https://login.taobao.com/member/login.jhtml")
    await controller.present({ fullscreen: true, navigationTitle: "登录淘宝（登录后点完成）" })
    const cookies = await controller.getAllCookies()
    const usable = (cookies || []).filter((c: any) => /taobao|tmall|alibaba/.test(String(c.domain || "")))
    const logged = (cookies || []).some((c: any) => ["unb", "tracknick"].includes(String(c.name)) && !!c.value)
    if (!logged || usable.length === 0) return false
    Keychain.set(COOKIE_KEY, JSON.stringify(usable))
    return true
  } finally {
    try { controller.dispose() } catch { }
  }
}

/* ---------------- 解析 ---------------- */

function unescapeJson(value: string): string {
  try { return JSON.parse(`"${value}"`) } catch { return value }
}

function firstMatch(html: string, re: RegExp): string {
  const m = html.match(re)
  return m ? unescapeJson(m[1]) : ""
}

/** 订单详情页 → 商品标题 / 店铺名 / 订单状态 */
export function parseOrder(html: string): { itemTitle: string; shopName: string; orderStatus: string } {
  const titles = [...html.matchAll(/"itemTitle":"([^"]{4,140})"/g)]
    .map(m => unescapeJson(m[1]))
    .filter(t => !/如发生争议/.test(t) && !/^\s*$/.test(t))
    .sort((a, b) => b.length - a.length)
  return {
    itemTitle: titles[0] || "",
    shopName: firstMatch(html, /"shopName":"([^"]{1,60})"/),
    orderStatus: parseOrderStatus(html),
  }
}

/** 只读明确的订单状态字段，避开「申请退款 / 取消订单」这类操作按钮文案 */
export function parseOrderStatus(html: string): string {
  const values = [...html.matchAll(/"(?:statusText|statusDesc|statusTitle|orderStatusText|orderStatusDesc|tradeStatusText|mainStatusText)"\s*:\s*"((?:\\.|[^"\\])*)"/g)]
    .map(m => unescapeJson(m[1]))
  // 订单详情头部常把主状态放在 statusInfo 的 text/title 字段里
  const blocks = [...html.matchAll(/"(?:statusInfo|orderStatusInfo|tradeStatusInfo)"\s*:\s*\{([^{}]{0,1500})\}/g)]
  for (const block of blocks) {
    const text = firstMatch(block[1], /"(?:text|title|value)"\s*:\s*"((?:\\.|[^"\\])*)"/)
    if (text) values.push(text)
  }
  return values.find(v => closedOrderStatus(v)) || values.find(v => !/^\d+$/.test(v)) || ""
}

/** 物流详情页 → 运单号 / 快递公司 / 官方状态 / 完整节点 */

/** 「08-07 18:59」→ 毫秒（实现在 model.ts，三个平台共用） */

export function parseLogistics(html: string): {
  mailNo: string
  company: string
  latest: string
  tracks: { time: string; text: string }[]
  statusCode: string
  statusDesc: string
  city: string
  station: string
  /** 官方取件码（淘宝物流页实测没有这个字段，留接口；有就直接用） */
  pickupCode: string
  /** 收货地（淘宝 END_TRACE_CODING，最后一段路的终点就是收货地址） */
  receiverCity: string
  receiverAddress: string
  /** 收货人姓名 + 掩码手机号（淘宝「号码保护中」节点里的） */
  receiverName: string
  receiverPhone: string
} {
  const mailNo = firstMatch(html, /"mailNo":"(\d{6,})"/)
  const company = firstMatch(html, /"logisticCompany":\{[^}]*?"name":"([^"]+)"/)
  // 官方状态：logisticsPackageStatus.statusCode，SIGN = 已签收（权威于节点文案）
  const statusCode = firstMatch(html, /"logisticsPackageStatus":\{"statusCode":"([A-Za-z_]+)"/)
  const statusDesc = firstMatch(html, /"logisticsPackageStatus":\{"statusCode":"[A-Za-z_]+","statusDesc":"([^"]+)"/)

  // 节点全在 multiStage[] 里：每个 stage 有 labelDesc.text 和 subtitle（MM-DD HH:mm），新→旧
  const stages = parseMultiStages(html)
  const tracks: { time: string; text: string }[] = []
  for (const st of stages) {
    // richContent 是分段的：labelDesc.text 有时只给第一段（「快件已由快递员【柳长华：」），
    // 把 richContent 里所有 text 拼起来才是完整文案，两个取长的那个。
    const parts: string[] = (Array.isArray(st?.labelDesc?.richContent) ? st.labelDesc.richContent : [])
      .map((x: any) => String(x?.text ?? ""))
    const joined = parts.join("").trim()
    const official = String(st?.labelDesc?.text ?? "").trim()
    const text = (joined.length > official.length ? joined : official).trim()
    const time = String(st?.subtitle ?? "")
    if (text && !tracks.some(t => t.text === text && t.time === time)) {
      // 「号码保护中」是收货人信息、「商家选择无需物流发货」是无物流占位节点，都不是真实轨迹
      const tag = String(st?.labelDesc?.mainTag ?? "")
      if (tag.includes("号码保护") || text.includes("无需物流")) continue
      tracks.push({ time, text })
    }
  }

  // 收货人：淘宝把收货人与脱敏手机号放在收货节点的 labelDesc.text 里（mainTag=号码保护中），
  // 收货地址在同一个节点的 title：「送至 XX路2号某公寓」。
  let receiverName = ""
  let receiverPhone = ""
  let receiverFromTitle = ""
  for (const st of stages) {
    const tag = String(st?.labelDesc?.mainTag ?? "")
    const txt = String(st?.labelDesc?.text ?? "").replace(/\s+/g, " ").trim()
    const title = String(st?.title ?? "").trim()
    if (!receiverName && (tag.includes("号码保护") || /^[\u4e00-\u9fa5]{1,4}\s*(?:\+?86-?)?\d{3}\*{4}\d{4}$/.test(txt))) {
      const m = /^([\u4e00-\u9fa5]{1,4})\s*(?:\+?86-?)?(\d{3}\*{4}\d{4})$/.exec(txt)
      if (m) { receiverName = m[1]; receiverPhone = m[2] } else receiverName = txt
    }
    if (!receiverFromTitle && /^送至/.test(title)) receiverFromTitle = title.replace(/^送至\s*/, "")
  }
  const first = tracks[0]?.text
    || firstMatch(html, /"labelDesc":\{"richContent":\[\{[^}]*?"text":"([^"]+)"/)
  // 收货地：物流页的 END_TRACE_CODING 就是最后一段路的终点（收货地址），
  // 不能拿 LASTONE_TRACE_CODING（那是驿站代收点地址）。
  const endTrace = (() => {
    const at = html.indexOf('"END_TRACE_CODING":')
    if (at < 0) return { address: "", city: "" }
    const seg = html.slice(at, at + 600)
    return {
      address: /"address":"([^"]+)"/.exec(seg)?.[1] ?? "",
      city: /"cityName":"([^"]+)"/.exec(seg)?.[1] ?? "",
    }
  })()
  // 代收点：优先 LASTONE_TRACE_CODING（最后一段路的终点＝驿站/柜机）；
  // END_TRACE_CODING 是收货地址，两者不能混用。取不到时才用首个 address，
  // 而且必须长得像代收点，否则会把家里的收货地址当成驿站显示在卡片上。
  const lastOne = (() => {
    const at = html.indexOf('"LASTONE_TRACE_CODING":')
    if (at < 0) return { address: "", name: "" }
    const seg = html.slice(at, at + 900)
    return {
      address: /"address":"([^"]+)"/.exec(seg)?.[1] ?? "",
      name: /"(?:stationName|storeName|name)":"([^"]{2,40})"/.exec(seg)?.[1] ?? "",
    }
  })()
  const hasProxy = /"typeDesc":"(代收点|驿站|快递柜|自提点)"/.test(html)
  const guessed = hasProxy ? (firstMatch(html, /"address":"([^"]{4,60})"/) || "") : ""
  const station = lastOne.name || lastOne.address
    || (/驿站|代收|快递柜|自提|菜鸟|丰巢/.test(guessed) ? guessed : "")
  return {
    mailNo, company, tracks, statusCode, statusDesc,    // 官方字段优先：城市与驿站直接取页面里的结构化值，不再从文案里猜
    city: firstMatch(html, /"cityName":"([^"]+)"/),
    receiverCity: endTrace.city,
    receiverAddress: endTrace.address || receiverFromTitle,
    receiverName,
    receiverPhone,
    // 取件码：淘宝这页目前不返回（只有 facilityCode=柜机编号），有就取，没有交给关键词兜底
    pickupCode: firstMatch(html, /"(?:pickupCode|takeCode|pickup_code|take_code)":"([A-Za-z0-9-]{3,20})"/),
    station,
    // 官方说签收就直接用官方文案，不管节点停在哪儿（驿站不回传新节点就会卡在「到达代收点」）
    latest: statusFromCode(statusCode) === "delivered" ? (statusDesc || "已签收") : first,
  }
}

/** 从 HTML 里把 "multiStage":[...] 这段 JSON 完整括出来并解析（括号计数，跳过字符串内的括号） */
function parseMultiStages(html: string): any[] {
  const key = '"multiStage":['
  const at = html.indexOf(key)
  if (at < 0) return []
  const start = at + key.length - 1
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === "\\") { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === "[" || ch === "{") depth++
    else if (ch === "]" || ch === "}") {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) return []
  try {
    const arr = JSON.parse(html.slice(start, end))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}



async function fetchText(url: string, ms = 25_000): Promise<string> {
  const run = async () => {
    const res = await fetch(url, {
      headers: {
        Cookie: cookieHeader(),
        "User-Agent": UA,
        Referer: "https://h5.m.taobao.com/mlapp/olist.html",
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  }
  return safeTimeoutRace(run(), ms, formatStepTimeout("拉物流页", ms, url))
}

/** 用登录态拉一条订单的物流（不依赖 WebView，小组件里也能跑） */
export async function fetchPackage(orderId: string, prev?: Pkg, run?: { diagId?: number }): Promise<Pkg> {
  const t0 = Date.now()
  let logisticsHtml = ""
  let lastErr: any
  for (let i = 0; i < 2; i++) {
    try {
      logisticsHtml = await fetchText(LOGISTICS_URL(orderId))
      lastErr = null
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (lastErr) {
    recordTaobaoStep("拉物流页", Date.now() - t0, false, LOGISTICS_URL(orderId), String(lastErr?.message ?? lastErr), run?.diagId)
    throw lastErr
  }
  const info = parseLogistics(logisticsHtml)

  let itemTitle = prev?.itemTitle || ""
  let shopName = prev?.shopName || ""
  let orderStatus = ""
  // 退款后的物流页仍会显示原发货节点，所以每次都要回订单详情页核交易状态
  try {
    const orderHtml = await fetchText(ODETAIL_URL(orderId))
    const meta = parseOrder(orderHtml)
    itemTitle = itemTitle || meta.itemTitle
    shopName = shopName || meta.shopName
    orderStatus = meta.orderStatus
  } catch { }
  const closed = closedOrderStatus(orderStatus)

  return {
    orderId,
    source: "taobao",
    itemTitle,
    shopName,
    company: info.company || prev?.company || "",
    mailNo: info.mailNo || prev?.mailNo || "",
    latest: closed ? orderStatus : (info.latest || prev?.latest || ""),
    // 订单关闭优先：退款成功的单不能再按物流节点当在途
    status: closed ?? statusFromCode(info.statusCode) ?? classify(info.latest || prev?.latest || ""),
    tracks: info.tracks.length > 0 ? info.tracks : prev?.tracks,
    lastTrackAt: timeOfTrack(info.tracks[0]?.time || "") || prev?.lastTrackAt,
    city: info.city || prev?.city,
    stationName: info.station || prev?.stationName,
    pickupCode: info.pickupCode || prev?.pickupCode,
    receiverCity: info.receiverCity || prev?.receiverCity,
    receiverAddress: info.receiverAddress || prev?.receiverAddress,
    receiverName: info.receiverName || prev?.receiverName,
    receiverPhone: info.receiverPhone || prev?.receiverPhone,
    updatedAt: Date.now(),
  }
}

// 淘宝订单页经常被登录引导/领券弹层、“请选择”页头盖住，DOM 里就抓不到订单号。
// 这里把 fixed/absolute 的遮罩类元素隐藏掉、把滚动恢复，再读内容（不点任何业务按钮，只清遮挡）。
/** 淘宝拦截页词表：只有真滑块/验证才值得弹页给人，限流类等一下自己就过 */
const TB_VERIFY_RE = /滑动验证|请完成验证|安全验证|人机验证|滑块验证|验证码|captcha/i



type TaobaoRun = {
  diagId: number
  syncId: string | null
  roundStart: number
  deadline?: number
  dispose?: () => void
}

function throwIfStopped(ctx: TaobaoRun): void {
  if (ctx.syncId != null && !runIsCurrent(ctx.syncId)) {
    try { ctx.dispose?.() } catch { /* 控制器可能已经释放 */ }
    throw new SyncSuperseded()
  }
}

function budgetError(ctx: TaobaoRun, url?: string): Error {
  return new Error(formatBudgetExhausted(Date.now() - ctx.roundStart, url))
}

function markPage(ctx: TaobaoRun, ok: boolean): void {
  if (ctx.syncId != null && !runIsCurrent(ctx.syncId)) return
  lastTaobaoPageOk = ok
}

/** 间隔等待。排不上计时器就报能力错误，避免空转把页面脚本打满。 */
async function pause(ms: number, ctx: TaobaoRun): Promise<void> {
  throwIfStopped(ctx)
  const cap = waitCap(ctx.deadline, ms)
  if (cap <= 0) throw budgetError(ctx)
  await new Promise<void>((resolve, reject) => {
    const { scheduled } = tryScheduleTimeout(() => resolve(), cap)
    if (!scheduled) reject(new PageCapabilityError())
  })
}

async function evalPage<T>(controller: WebViewController, js: string, ms: number, step: string, ctx: TaobaoRun): Promise<T> {
  throwIfStopped(ctx)
  const cap = waitCap(ctx.deadline, ms)
  if (cap < 200) throw budgetError(ctx)
  const t0 = Date.now()
  try {
    return await evaluateBounded<T>(controller as any, js, cap, step, tryScheduleTimeout, safeClearTimeout)
  } catch (e) {
    if (ctx.syncId != null && !runIsCurrent(ctx.syncId)) {
      try { ctx.dispose?.() } catch { /* 同上 */ }
      throw new SyncSuperseded()
    }
    if (isPageTimeout(e)) throw new Error(formatStepTimeout(step, Date.now() - t0))
    throw e
  }
}

function openTaobaoPage(ctx: TaobaoRun): WebViewController {
  const controller = new WebViewController()
  let closed = false
  const dispose = () => {
    if (closed) return
    closed = true
    try { void (controller as any).stopLoading?.() } catch { /* 没有这个方法时直接释放 */ }
    try { controller.dispose() } catch { /* 重复释放忽略 */ }
  }
  ctx.dispose = dispose
  if (ctx.syncId != null) bindRunCleanup(ctx.syncId, dispose)
  return controller
}

async function seedCookies(controller: WebViewController, ctx: TaobaoRun): Promise<void> {
  for (const cookie of getCookies()) {
    throwIfStopped(ctx)
    const cap = waitCap(ctx.deadline, 5_000)
    if (cap < 200) throw budgetError(ctx)
    try {
      const result = await settleWithin(
        () => Promise.resolve(controller.setCookie(cookie)).then(() => true, () => false),
        cap,
        { schedule: tryScheduleTimeout, clear: safeClearTimeout, nativeBound: false },
      )
      if (!result.ok && result.reason === "capability") throw new PageCapabilityError()
    } catch (e) {
      if (isSupersededError(e) || isPageCapability(e) || /预算用尽/.test(String((e as any)?.message ?? e))) throw e
    }
  }
}

/**
 * 淘宝人机验证：和京东 humanVerify 同构——把页面弹给用户过滑块，
 * 过了（Ultron 数据里重新出现订单）自动收起并返回 true。
 * 加载和每次读页面都有上限，不再无限等 loadURL / evaluateJavaScript。
 */
export async function taobaoHumanVerify(deadline?: number, syncId: string | null = null): Promise<boolean> {
  const ctx: TaobaoRun = { diagId: 0, syncId, roundStart: Date.now(), deadline }
  const controller = openTaobaoPage(ctx)
  try {
    await seedCookies(controller, ctx)
    const cap = waitCap(deadline, 25_000)
    if (cap < 1000) return false
    try {
      await loadPageBounded(controller as any, "https://h5.m.taobao.com/mlapp/olist.html", cap, "验证页加载", tryScheduleTimeout, safeClearTimeout)
    } catch (e) {
      if (isSupersededError(e) || (ctx.syncId != null && !runIsCurrent(ctx.syncId))) throw new SyncSuperseded()
      return false
    }
    let presented = true
    const p = controller.present({ fullscreen: true, navigationTitle: "淘宝需要验证" })
      .then(() => { presented = false })
      .catch(() => { presented = false })
    const end = Math.min(Date.now() + 3 * 60_000, deadline ?? Number.POSITIVE_INFINITY)
    let ok = false
    while (presented && Date.now() < end) {
      await pause(1500, ctx)
      if (!presented) break
      const raw = String(await evalPage<string>(controller, `return (function(){
        try{
          var s = window.currentUltronData ? JSON.stringify(window.currentUltronData) : ''
          var t = document.body ? document.body.innerText.slice(0, 500) : ''
          return JSON.stringify({
            has: /bizOrderId|\\"orderId\\"/.test(s),
            bad: /滑动验证|请完成验证|安全验证|人机验证|滑块验证|验证码|captcha/i.test(t)
          })
        }catch(e){ return '{}' }
      })()`, 4_000, "读取验证页", ctx) || "{}")
      let info: any = {}
      try { info = JSON.parse(raw) } catch { }
      if (info.has && !info.bad) { ok = true; break }
    }
    if (presented) { try { await controller.dismiss() } catch { } }
    void p
    try { await pause(400, ctx) } catch (e) {
      if (isSupersededError(e)) throw e
    }
    return ok
  } finally {
    try { ctx.dispose?.() } catch { /* 验证页用完就释放 */ }
  }
}

/** 页面内正则，只回订单号列表（逗号分隔）。整页 HTML 过 JS 桥会失败，绝不能取 outerHTML 回来 */
const IDS_ONLY = `return (function(){
  try{
    var d = document.documentElement ? document.documentElement.outerHTML : ''
    var re = /bizOrderId/g, m, cnt = 0, s = []
    while ((m = re.exec(d))) { cnt++; if (s.length < 3) s.push(d.substr(m.index, 36)) }
    var ids = []
    try {
      var as = document.querySelectorAll('a[href*="bizOrderId"]')
      for (var i = 0; i < as.length; i++) {
        var mm = /(\\d{10,})/.exec(as[i].getAttribute('href') || '')
        if (mm && ids.indexOf(mm[1]) < 0) ids.push(mm[1])
      }
    } catch (x) { }
    var emp = false
    try {
      var it = document.body ? document.body.innerText : ''
      emp = /没有找到|暂无订单|还没有订单|无相关订单|没有相关订单/.test(it)
    } catch (e) { }
    return JSON.stringify({ len: d.length, t: (document.title||'').slice(0,20), cnt: cnt, s: s, a: ids.length, emp: emp, ids: ids.slice(0, 60).join(',') })
  } catch (e) { return JSON.stringify({ err: String((e && e.message) || e) }) }
})()`

/** 抓页面自己发出去的请求：点 tab 时列表是异步拉的，把 URL 记下来就能拿到真接口。*/
const HOOK_XHR = `return (function(){
  try{
    if (window.__ppHooked) return 1
    window.__ppHooked = 1
    window.__ppReq = []
    var XO = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function(m,u){
      try{ window.__ppReq.push(String(m)+' '+String(u).slice(0,240)) }catch(e){}
      return XO.apply(this, arguments)
    }
    if (window.fetch) {
      var of = window.fetch
      window.fetch = function(u){
        try{ window.__ppReq.push('FETCH '+String(u).slice(0,240)) }catch(e){}
        return of.apply(this, arguments)
      }
    }
    return 1
  }catch(e){ return 0 }
})()`

const CLEAR_OVERLAYS = `return (function(){
  try{
    var sels=['[class*="mask"]','[class*="Mask"]','[class*="modal"]','[class*="Modal"]','[class*="popup"]','[class*="Popup"]','[class*="dialog"]','[id*="J_MIDDLEWARE"]','.ks-overlay','.tb-ext-mask'];
    var n=0;
    sels.forEach(function(sel){
      try{ [].slice.call(document.querySelectorAll(sel)).forEach(function(e){
        try{ var st=getComputedStyle(e); if(st.position==='fixed'||st.position==='absolute'){ e.style.display='none'; n++ } }catch(x){}
      }) }catch(x){}
    });
    try{ if(document.documentElement) document.documentElement.style.overflow='auto' }catch(x){}
    try{ if(document.body) document.body.style.overflow='auto' }catch(x){}
    return n
  }catch(e){ return -1 }
})()`

/**
 * 等订单列表真的渲染出来：每 700ms 看一眼 DOM，没列表就顺手清一次遮挡并滚到底。
 * 每次读页面都有上限，不再另等一次加载事件。
 */
async function waitForOrders(controller: WebViewController, maxMs: number, ctx: TaobaoRun): Promise<boolean> {
  const end = Date.now() + waitCap(ctx.deadline, maxMs)
  while (Date.now() < end) {
    throwIfStopped(ctx)
    try {
      const rv: any = await evalPage(
        controller,
        "return (function(){try{var h=document.documentElement?document.documentElement.outerHTML:'';return /bizOrderId[=:\\\"%]+\\d{10,}/.test(h)?1:0}catch(e){return -1}})()",
        3_000,
        "等待订单列表",
        ctx,
      )
      const ok = rv === 1 || rv === true || String(rv) === "1" || String(rv) === "true"
      if (ok) { diag("taobao-wait", { ok: true }); return true }
    } catch (e) {
      if (isSupersededError(e) || isPageCapability(e) || /预算用尽|页面计时不可用/.test(String((e as any)?.message ?? e))) throw e
    }
    try { await evalPage(controller, CLEAR_OVERLAYS, 3_000, "清理遮挡", ctx) } catch (e) {
      if (isSupersededError(e) || isPageCapability(e)) throw e
    }
    try { await evalPage(controller, "return (function(){try{window.scrollTo(0, document.body.scrollHeight);return 1}catch(e){return 0}})()", 2_000, "滚动订单列表", ctx) } catch (e) {
      if (isSupersededError(e) || isPageCapability(e)) throw e
    }
    await pause(700, ctx)
  }
  diag("taobao-wait", { ok: false })
  return false
}

/** 诊断：把网页实际返回的线索写进 cc/syncDiag.log，用户跑一次同步就能回看 */
export function diag(tag: string, obj: any): void {
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    const p = `${dir}/syncDiag.log`
    const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(obj).slice(0, 900)}\n`
    const prev = FileManager.existsSync(p) ? FileManager.readAsStringSync(p) : ""
    FileManager.writeAsStringSync(p, (prev + line).slice(-20000))
  } catch { }
}

/** 当前页面是不是被踢回登录页了 */
async function atLoginPage(controller: WebViewController, ctx: TaobaoRun): Promise<boolean> {
  try {
    const href = String(await evalPage<string>(controller, "return location.href", 2_000, "读取当前页", ctx) || "")
    const host = String(await evalPage<string>(controller, "return location.host", 2_000, "读取当前页", ctx) || "")
    return /^login[\d.]*\.(taobao|tmall)\.com$/i.test(host)
      || /login\.m\.taobao\.com/i.test(host)
      || /(passport|havanaone|havana)\.(taobao|tmall)\.com/i.test(host)
      || /\/(member\/login|login\/login)/i.test(href)
  } catch (e) {
    if (isSupersededError(e) || isPageCapability(e) || /预算用尽|页面计时不可用|淘宝·/.test(String((e as any)?.message ?? e))) throw e
    return false
  }
}

async function currentPageUrl(controller: WebViewController, ctx: TaobaoRun): Promise<string> {
  try { return String(await evalPage(controller, "return location.href", 2_000, "读取当前页", ctx) || "") } catch (e) {
    if (isSupersededError(e) || isPageCapability(e)) throw e
    return ""
  }
}

async function inspectAuthOrVerify(controller: WebViewController, ctx: TaobaoRun): Promise<string | null> {
  const href = await currentPageUrl(controller, ctx)
  let text = ""
  try { text = String(await evalPage(controller, "return document.body ? document.body.innerText.slice(0, 800) : ''", 3_000, "读取页面正文", ctx) || "") } catch (e) {
    if (isSupersededError(e) || isPageCapability(e)) throw e
  }
  if (await atLoginPage(controller, ctx) || /(passport|havana)\.(taobao|tmall)\.com/i.test(href)) return formatAuthNeeded(href)
  if (TB_VERIFY_RE.test(text) || /punish|_____tmd_____|\/error\/captcha/i.test(href)) return formatAuthNeeded(href)
  return null
}

/** 登录、验证、预算和计时能力会停掉整轮。导航超时不是，后面的已有路径还要继续。 */
function stopsDiscovery(e: any): boolean {
  if (isSupersededError(e) || isPageCapability(e)) return true
  const msg = String(e?.message ?? e)
  return /需重新登录或完成验证|登录已失效|预算用尽|页面计时不可用/.test(msg)
}

function hitFromError(e: any): StageHit {
  if (isSupersededError(e)) throw e
  const detail = String(e?.message ?? e)
  if (isPageCapability(e) || /页面计时不可用/.test(detail)) return { type: "stop", reason: "capability", detail }
  if (/预算用尽/.test(detail)) return { type: "stop", reason: "budget", detail }
  if (/需重新登录|登录已失效/.test(detail)) return { type: "stop", reason: "auth", detail }
  return { type: "miss", detail }
}

/**
 * 只等一次官方加载。
 * loadRequest 的 timeoutInterval（秒）或 waitForLoad({ timeout, cancelOnTimeout }) 负责上限。
 * 加载成功后不再调用 waitForLoad，避免单页应用第二次加载事件一直不来。
 */
async function loadAndWait(controller: WebViewController, url: string, ms: number, step: string, ctx: TaobaoRun, retries = 0, stopOnTimeout = true): Promise<void> {
  let last: Error | null = null
  for (let i = 0; i <= retries; i++) {
    throwIfStopped(ctx)
    const t0 = Date.now()
    const label = i ? `${step}（重试）` : step
    let recorded = false
    try {
      if (deadlineReached(ctx.deadline)) throw budgetError(ctx, url)
      const cap = waitCap(ctx.deadline, ms)
      if (cap < 1000) throw budgetError(ctx, url)
      try {
        await loadPageBounded(controller as any, url, cap, step, tryScheduleTimeout, safeClearTimeout, stopOnTimeout)
      } catch (e) {
        if (ctx.syncId != null && !runIsCurrent(ctx.syncId)) throw new SyncSuperseded()
        if (isPageCapability(e)) throw e
        if (isPageTimeout(e)) throw new Error(formatStepTimeout(step, Date.now() - t0, url))
        throw e
      }
      throwIfStopped(ctx)
      const auth = await inspectAuthOrVerify(controller, ctx)
      recordTaobaoStep(label, Date.now() - t0, !auth, url, auth || undefined, ctx.diagId)
      recorded = true
      if (auth) throw new Error(auth)
      return
    } catch (e: any) {
      if (isSupersededError(e)) throw e
      const err = e instanceof Error ? e : new Error(String(e?.message ?? e))
      last = err
      if (!recorded) recordTaobaoStep(label, Date.now() - t0, false, url, String(err.message || "").slice(0, 80), ctx.diagId)
      const msg = String(err.message || "")
      if (stopsDiscovery(e) || /需重新登录或完成验证|登录已失效|预算用尽|页面计时不可用/.test(msg)) throw err
    }
  }
  throw last || new Error(formatStepTimeout(step, ms, url))
}

/**
 * 发现账号下的订单号。
 * 主线路：H5 Ultron。快递聚合 3.0 实测稳定。
 * 兜底：PC 版「已买到的宝贝」，DOM 里直接带 bizOrderId。
 */
const H5_SALVAGE_JS = `return (function(){
  try {
    var ids = []
    function push(v){ if (v && /^\\d{10,}$/.test(v) && ids.indexOf(v)<0 && ids.length<40) ids.push(v) }
    var blob = ''
    try { blob = window.currentUltronData ? JSON.stringify(window.currentUltronData) : '' } catch (e0) {}
    var m, re1 = /bizOrderId=(\\d{10,})/g
    while ((m = re1.exec(blob))) push(m[1])
    var re2 = /"orderId":"(\\d{10,})"/g
    while ((m = re2.exec(blob))) push(m[1])
    var text = ''
    try { text = document.body ? document.body.innerText.slice(0, 500) : '' } catch (e1) {}
    var href = String(location.href || '').split('?')[0].split('#')[0]
    return JSON.stringify({
      href: href,
      host: location.host || '',
      ready: document.readyState || '',
      htmlLen: document.documentElement ? document.documentElement.outerHTML.length : 0,
      ids: ids.join(','),
      emp: /没有找到|暂无订单|还没有订单|无相关订单|没有相关订单/.test(text),
      verify: /滑动验证|请完成验证|安全验证|人机验证|滑块验证|验证码|captcha/i.test(text)
    })
  } catch (e2) { return '{}' }
})()`

function salvageLooksLikeAuth(host: string, href: string): boolean {
  return /^login[\d.]*\.(taobao|tmall)\.com$/i.test(host)
    || /login\.m\.taobao\.com/i.test(host)
    || /(passport|havanaone|havana)\.(taobao|tmall)\.com/i.test(host)
    || /\/(member\/login|login\/login)/i.test(href)
}

/** 导航超时后只读已经提交的文档。不把空文档当成同步成功。 */
async function salvageH5(controller: WebViewController, ctx: TaobaoRun): Promise<StageHit> {
  const t0 = Date.now()
  try {
    const raw = String(await evalPage(controller, H5_SALVAGE_JS, 4_000, "超时后读取H5", ctx) || "{}")
    let info: any = {}
    try { info = JSON.parse(raw) } catch { info = {} }
    const ids = String(info.ids || "").split(",").map((id: string) => id.trim()).filter(Boolean)
    const href = String(info.href || "")
    const verify = !!info.verify
    const auth = verify || salvageLooksLikeAuth(String(info.host || ""), href)
    const cls = classifySalvage({
      ids,
      auth,
      verify,
      readyState: String(info.ready || ""),
      htmlLen: Number(info.htmlLen) || 0,
      emptyConfirmed: !!info.emp,
    })
    if (cls === "orders") {
      recordTaobaoStep("超时后读取H5", Date.now() - t0, true, href, `${ids.length} 单`, ctx.diagId)
      return { type: "orders", ids, detail: `超时后读取到 ${ids.length} 单` }
    }
    if (cls === "auth") {
      const detail = formatAuthNeeded(href)
      recordTaobaoStep("超时后读取H5", Date.now() - t0, false, href, "登录或验证", ctx.diagId)
      return { type: "stop", reason: "auth", detail }
    }
    if (cls === "empty-ready") {
      recordTaobaoStep("超时后读取H5", Date.now() - t0, true, href, "页面确认没有订单", ctx.diagId)
      return { type: "empty-ready", detail: "淘宝·H5页面确认没有订单" }
    }
    recordTaobaoStep("超时后读取H5", Date.now() - t0, false, href, "无订单数据", ctx.diagId)
    return { type: "miss", detail: "淘宝·超时后读取H5无订单数据" }
  } catch (e) {
    if (isSupersededError(e)) throw e
    const hit = hitFromError(e)
    if (hit.type === "stop") return hit
    recordTaobaoStep("超时后读取H5", Date.now() - t0, false, undefined, "未能读取", ctx.diagId)
    return { type: "miss", detail: "淘宝·超时后读取H5无订单数据" }
  }
}

function budgetStop(ctx: TaobaoRun, stages: string[]): Error {
  return new Error(formatDiscoveryFailure([...stages, formatBudgetExhausted(Date.now() - ctx.roundStart)]))
}

/** 上一轮淘宝订单页是否真的渲染出来了。
 *  订单为 0 有两种可能：页面没加载（故障）和用户确实没买东西（正常）。
 *  只有页面没就绪才算失败，否则会把“空订单”永远报成错误。*/
let lastTaobaoPageOk = false

export async function discoverOrderIds(ctx: TaobaoRun): Promise<string[]> {
  markPage(ctx, false)
  if (deadlineReached(ctx.deadline)) throw budgetError(ctx)
  const controller = openTaobaoPage(ctx)
  try {
    await seedCookies(controller, ctx)
    const stages: string[] = []

    let needVerify = false
    let h5Noted = false
    try {
      if (deadlineReached(ctx.deadline)) throw budgetError(ctx)
      await loadAndWait(controller, "https://h5.m.taobao.com/mlapp/olist.html", 20_000, "加载H5订单页", ctx, 0, false)
      if (await atLoginPage(controller, ctx)) throw new Error(formatAuthNeeded(await currentPageUrl(controller, ctx)))
      {
        let blob = ""
        for (let i = 0; i < 15; i++) {
          if (deadlineReached(ctx.deadline)) break
          throwIfStopped(ctx)
          blob = String(await evalPage<string>(
            controller,
            "return window.currentUltronData ? JSON.stringify(window.currentUltronData) : ''",
            4_000,
            "读取H5订单",
            ctx,
          ) || "")
          if (blob.includes("bizOrderId") || blob.includes("orderId")) break
          try { await evalPage(controller, "return (function(){try{window.scrollTo(0, document.body.scrollHeight);return 1}catch(e){return 0}})()", 2_000, "滚动H5订单", ctx) } catch (e) {
            if (isSupersededError(e) || isPageCapability(e)) throw e
          }
          await pause(600, ctx)
        }
        const h5Ids: string[] = []
        const pushH5 = (v: string) => { if (v && !h5Ids.includes(v)) h5Ids.push(v) }
        for (const m of blob.matchAll(/bizOrderId=(\d{10,})/g)) pushH5(m[1])
        for (const m of blob.matchAll(/"orderId":"(\d{10,})"/g)) pushH5(m[1])
        diag("taobao-h5", { len: blob.length, n: h5Ids.length })
        if (h5Ids.length > 0) {
          markPage(ctx, true)
          return h5Ids.slice(0, 40)
        }
        const vt = String(await evalPage(
          controller,
          "return document.body ? document.body.innerText.slice(0,500) : ''",
          3_000,
          "读取H5正文",
          ctx,
        ) || "")
        if (TB_VERIFY_RE.test(vt)) needVerify = true
      }
    } catch (e: any) {
      const hit = hitFromError(e)
      if (hit.type === "stop") throw new Error(hit.detail)
      if (/超时/.test(hit.detail)) {
        const salvage = await salvageH5(controller, ctx)
        if (salvage.type === "orders") { markPage(ctx, true); return salvage.ids }
        if (salvage.type === "empty-ready") { markPage(ctx, true); return [] }
        if (salvage.type === "stop") throw new Error(salvage.detail)
      }
      stages.push(hit.detail)
      h5Noted = true
    }
    if (needVerify) throw new Error(formatAuthNeeded(await currentPageUrl(controller, ctx)))
    if (!h5Noted) stages.push("淘宝·H5订单页未发现订单")
    if (remainingMs(ctx.deadline) < 1000) throw budgetStop(ctx, stages)

    if (deadlineReached(ctx.deadline)) throw budgetError(ctx)
    const pcIds: string[] = []
    const pushPc = (v: string) => { if (v && !pcIds.includes(v)) pcIds.push(v) }
    let needLogin = false
    let pageOk = false
    let pcNoted = false
    try {
      await loadAndWait(controller, "https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm", 25_000, "加载PC订单页", ctx)
      try { await evalPage(controller, CLEAR_OVERLAYS, 3_000, "清理遮挡", ctx) } catch (e) {
        if (isSupersededError(e) || isPageCapability(e)) throw e
      }
      try { await evalPage(controller, HOOK_XHR, 3_000, "挂钩请求", ctx) } catch (e) {
        if (isSupersededError(e) || isPageCapability(e)) throw e
      }
      if (await atLoginPage(controller, ctx)) needLogin = true
      try {
        const raw = String(await evalPage(controller, `return JSON.stringify({href:location.href,title:document.title,len:(document.documentElement?document.documentElement.outerHTML.length:0),hasOrder:/bizOrderId[=":%]+\\d{10,}/.test(document.documentElement?document.documentElement.outerHTML:''),text:(document.body?document.body.innerText.slice(0,200):'')})`, 4_000, "读取PC订单页", ctx) || "")
        const pinfo: any = JSON.parse(raw || "{}")
        pageOk = String(pinfo.title || "").includes("已买到的宝贝") && Number(pinfo.len || 0) > 40000
        diag("taobao-pc", { title: pinfo.title, len: pinfo.len, has: pinfo.hasOrder, ok: pageOk })
      } catch (e) {
        if (isSupersededError(e) || isPageCapability(e)) throw e
      }
      if (!needLogin && !await waitForOrders(controller, 15_000, ctx)) {
        try {
          await loadAndWait(controller, "https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm", 25_000, "重载PC订单页", ctx)
          await evalPage(controller, CLEAR_OVERLAYS, 3_000, "清理遮挡", ctx)
          if (await atLoginPage(controller, ctx)) needLogin = true
        } catch (e) {
          if (isSupersededError(e) || stopsDiscovery(e)) throw e
        }
        if (!needLogin) await waitForOrders(controller, 12_000, ctx)
      }
      let clickedPending = false
      try {
        const hit = String(await evalPage(controller, `return (function(){
          var t=[].slice.call(document.querySelectorAll('a,span,div,li')).find(function(e){
            var s=(e.textContent||'').trim(); return (s==='待收货'||s==='待收货订单')&&e.children.length<3 });
          if(t){ t.click(); return 'clicked'; } return 'no';
        })()`, 4_000, "点待收货", ctx) || "")
        clickedPending = hit.indexOf("clicked") >= 0
        if (clickedPending) await waitForOrders(controller, 12_000, ctx)
        else await pause(1500, ctx)
      } catch (e) {
        if (isSupersededError(e) || isPageCapability(e)) throw e
      }
      const cap = clickedPending ? 40 : 20
      let stable = 0
      let emptyConfirmed = false
      for (let i = 0; i < 10 && stable < 3 && pcIds.length < cap; i++) {
        if (deadlineReached(ctx.deadline)) break
        throwIfStopped(ctx)
        const raw = String(await evalPage<string>(controller, IDS_ONLY, 4_000, "读取PC订单号", ctx) || "")
        let info: any = {}
        try { info = JSON.parse(raw) } catch { }
        diag("taobao-ids", { cnt: info.cnt, a: info.a, len: info.len, t: info.t, emp: info.emp })
        if (info.emp && pcIds.length === 0) { emptyConfirmed = true; break }
        const got = String(info.ids || "")
        const beforeN = pcIds.length
        for (const v of got.split(",")) if (v) pushPc(v)
        stable = pcIds.length === beforeN ? stable + 1 : 0
        try { await evalPage(controller, "return (function(){try{window.scrollTo(0, document.body.scrollHeight);return 1}catch(e){return 0}})()", 2_000, "滚动PC订单", ctx) } catch (e) {
          if (isSupersededError(e) || isPageCapability(e)) throw e
        }
        await pause(700, ctx)
      }
      if (emptyConfirmed) pageOk = true
      try {
        const reqs = String(await evalPage<string>(
          controller,
          "return JSON.stringify((window.__ppReq||[]).slice(-14))",
          3_000,
          "读取页面请求",
          ctx,
        ) || "[]")
        const list = JSON.parse(reqs)
        diag("taobao-xhr", { n: Array.isArray(list) ? list.length : 0 })
      } catch (e) {
        if (isSupersededError(e) || isPageCapability(e)) throw e
      }
    } catch (e: any) {
      const hit = hitFromError(e)
      if (hit.type === "stop") throw new Error(hit.detail)
      if (pcIds.length > 0) { markPage(ctx, true); return pcIds }
      stages.push(hit.detail)
      pcNoted = true
    }
    if (needLogin) throw new Error(formatAuthNeeded(await currentPageUrl(controller, ctx)))
    if (pcIds.length > 0) { markPage(ctx, true); return pcIds }
    if (pageOk) { markPage(ctx, true); return [] }
    if (!pcNoted) stages.push("淘宝·PC订单页未发现订单")
    if (remainingMs(ctx.deadline) < 1000) throw budgetStop(ctx, stages)
    let fallbackMiss = ""
    try {
      await loadAndWait(controller, "https://h5.m.taobao.com/mlapp/olist.html", 20_000, "兜底加载H5订单页", ctx, 0, false)
    } catch (e: any) {
      const hit = hitFromError(e)
      if (hit.type === "stop") throw new Error(hit.detail)
      fallbackMiss = hit.detail
      stages.push(hit.detail)
    }
    if (!fallbackMiss) {
    try { await evalPage(controller, CLEAR_OVERLAYS, 3_000, "清理遮挡", ctx) } catch (e) {
      if (isSupersededError(e) || isPageCapability(e)) throw e
    }
    if (await atLoginPage(controller, ctx)) throw new Error(formatAuthNeeded(await currentPageUrl(controller, ctx)))

    let blob = ""
    for (let i = 0; i < 15; i++) {
      if (deadlineReached(ctx.deadline)) break
      throwIfStopped(ctx)
      blob = String(await evalPage<string>(
        controller,
        "return window.currentUltronData ? JSON.stringify(window.currentUltronData) : ''",
        4_000,
        "读取兜底H5订单",
        ctx,
      ) || "")
      if (blob.includes("bizOrderId")) break
      try { await evalPage(controller, "return (function(){try{window.scrollTo(0, document.body.scrollHeight);return 1}catch(e){return 0}})()", 2_000, "滚动兜底H5", ctx) } catch (e) {
        if (isSupersededError(e) || isPageCapability(e)) throw e
      }
      await pause(600, ctx)
    }

    const ids: string[] = []
    const push = (v: string) => { if (v && !ids.includes(v)) ids.push(v) }
    for (const m of blob.matchAll(/bizOrderId=(\d{10,})/g)) push(m[1])
    for (const m of blob.matchAll(/"orderId":"(\d{10,})"/g)) push(m[1])
    if (ids.length === 0) {
      try {
        const raw = String(await evalPage<string>(controller, IDS_ONLY, 4_000, "读取兜底订单号", ctx) || "")
        let info: any = {}
        try { info = JSON.parse(raw) } catch { }
        for (const v of String(info.ids || "").split(",")) if (v) push(v)
      } catch (e) {
        if (isSupersededError(e) || isPageCapability(e)) throw e
      }
    }
    if (ids.length > 0) { markPage(ctx, true); return ids }
    }
    throw new Error(formatDiscoveryFailure(stages))
  } finally {
    try { ctx.dispose?.() } catch { /* 发现订单结束就释放页面 */ }
  }
}

/* ---------------- 同步 ---------------- */

/** 历史已签收的判定在 model.ts（isHistoricalPkg），三个平台共用 */
export async function syncAll(onProgress?: (done: number, total: number) => void, deadline?: number, skipOrderIds?: Set<string>, syncId: string | null = null): Promise<Snapshot> {
  if (!hasLogin()) throw new Error("请先登录淘宝")
  const diagId = beginTaobaoDiag()
  const roundStart = Date.now()
  const ctx: TaobaoRun = { diagId, syncId, roundStart, deadline }
  try {
    throwIfStopped(ctx)
    if (deadlineReached(deadline)) throw budgetError(ctx)
    const discovered = await discoverOrderIds(ctx)
    recordTaobaoStep("发现订单", Date.now() - roundStart, true, undefined, `${discovered.length} 单`, diagId)
    const ids = skipOrderIds ? discovered.filter(id => !skipOrderIds.has(id)) : discovered
    if (ids.length === 0) {
      if (lastTaobaoPageOk) {
        finishTaobaoDiag(true, undefined, diagId)
        return { packages: [], syncedAt: Date.now() }
      }
      throw new Error("淘宝订单页未就绪，本轮跳过")
    }
    const packages: Pkg[] = []
    let next = 0
    let done = 0
    let blocked: unknown = null
    const worker = async () => {
      try {
        while (next < ids.length && !blocked) {
          if (deadlineReached(deadline)) return
          throwIfStopped(ctx)
          const i = next++
          let pkg: Pkg | null = null
          try { pkg = await fetchPackage(ids[i], undefined, { diagId }) } catch (e) {
            if (isSupersededError(e) || isTimerUnavailable(e) || isPageCapability(e)) {
              blocked = e
              return
            }
            pkg = null
          }
          if (pkg && !isHistoricalPkg(pkg)) packages.push(pkg)
          done++
          onProgress?.(done, ids.length)
        }
      } catch (e) {
        blocked = blocked ?? e
      }
    }
    const t1 = Date.now()
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()])
    if (isSupersededError(blocked) || (ctx.syncId != null && !runIsCurrent(ctx.syncId))) throw new SyncSuperseded()
    if (packages.length === 0 && blocked) throw blocked
    recordTaobaoStep("拉物流", Date.now() - t1, true, undefined, `${packages.length}/${ids.length}`, diagId)
    const snapshot: Snapshot = { packages, syncedAt: Date.now() }
    finishTaobaoDiag(true, undefined, diagId)
    return snapshot
  } catch (e: any) {
    if (isSupersededError(e)) abandonTaobaoDiag(diagId)
    else finishTaobaoDiag(false, String(e?.message ?? e), diagId)
    throw e
  }
}
