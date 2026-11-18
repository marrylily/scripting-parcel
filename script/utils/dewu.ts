// 得物订单：只能走 H5 页面。
//
// 手册实测（`agg` 那套）的结论是：`buyerOrderList` 要 16 个请求头，其中 `hsn` 是 body 签名，
// 改一个字节就 401；而 `hsn/sk/ltk/shumeiid` 在得物 H5 的静态 JS 里搜不到，属原生 SDK 注入。
// 所以「纯脚本直连」在我们这儿没戏，只能打开订单页、钩页面自己发的那个请求：
//   · 页面签得出来 → 我们拿到 200 的订单 JSON
//   · 签不出来（401 签名认证失败）→ 如实报错，不做假数据
// 原始响应仅在 cc.debugDump=true 时落一份到 cc/dewuDump.json，方便按真实字段收紧解析。
import { diag } from "./net"
import { parseLooseOrder, type LooseOrder } from "./orderLoose"

const COOKIE_KEY = "dewu.cookies"
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
const ORDERS_URL = "https://m.dewu.com/router/order/buyer/orderList"

export type DewuOrder = LooseOrder

const delay = (ms: number) => new Promise<void>(resolve => (setTimeout as any)(resolve, ms))

/* ---------------- 登录态 ---------------- */

export function dewuCookies(): any[] {
  const raw = Keychain.get(COOKIE_KEY)
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

export function dewuSaveCookies(list: any[]): void {
  const usable = (list || []).filter((c: any) => /dewu\.com$/.test(String(c?.domain ?? "").replace(/^\./, "")))
  if (usable.length > 0) Keychain.set(COOKIE_KEY, JSON.stringify(usable))
}

/** 登录凭证在 Cookie 里（X-Auth-Token / duToken），localStorage 只有 userInfo */
export function dewuHasLogin(): boolean {
  return dewuCookies().some((c: any) => ["X-Auth-Token", "xAuthToken", "duToken"].includes(String(c.name)) && !!c.value)
}

export function dewuClearLogin(): void {
  try { Keychain.remove(COOKIE_KEY) } catch { }
}

/* ---------------- 订单列表 ---------------- */

/** 钩住页面自己发的 XHR：只留 buyerOrderList 的响应 */
const XHR_HOOK = `(function(){
  window.__dw = [];
  var oO = XMLHttpRequest.prototype.open, oS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ this.__u = u; this.__m = m; return oO.apply(this, arguments) };
  XMLHttpRequest.prototype.send = function(b){
    var s = this;
    s.addEventListener('load', function(){
      try {
        if (/buyerOrderList/i.test(s.__u || '')) {
          window.__dw.push({ u: s.__u, m: s.__m, st: s.status, body: (s.responseText || '').slice(0, 200000) });
        }
      } catch(e) {}
    });
    return oS.apply(this, arguments)
  };
})()`

function dumpRaw(text: string): void {
  try {
    if (!Storage.get<boolean>("cc.debugDump")) return
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(`${dir}/dewuDump.json`, text.slice(0, 300_000))
  } catch { }
}

/** 读得物订单。必须在有 WebView 的进程里跑（小组件里会直接抛错）。 */
export async function dewuFetchOrders(): Promise<DewuOrder[]> {
  if (!dewuHasLogin()) throw new Error("得物登录已失效，请重新授权")
  const c = new WebViewController()
  try {
    try { await c.setCustomUserAgent(UA) } catch { }
    for (const ck of dewuCookies()) { try { await c.setCookie(ck) } catch { } }
    try { await c.addUserScript({ source: XHR_HOOK, injectionTime: "documentStart" }) } catch { }
    await c.loadURL(ORDERS_URL)
    await c.waitForLoad().catch(() => { })
    await delay(7000)
    const raw = String(await c.evaluateJavaScript("return JSON.stringify(window.__dw||[])") || "[]")
    let hits: any[] = []
    try { hits = JSON.parse(raw) } catch { hits = [] }
    const ok = hits.filter(h => h && Number(h.st) === 200 && typeof h.body === "string" && h.body.length > 20)
    if (ok.length === 0) {
      const bad = hits.find(h => Number(h.st) === 401)
      dumpRaw(JSON.stringify(hits.map(h => ({ st: h.st, u: h.u, head: String(h.body || "").slice(0, 200) }))))
      diag("dewu-orders", { captured: hits.length, unauthorized: !!bad })
      if (bad) throw new Error("得物接口要求原生签名，网页里签不出来（401）")
      throw new Error("没抓到得物订单请求，可能页面没加载出来")
    }
    const body = String(ok[ok.length - 1].body)
    dumpRaw(body)
    let j: any = null
    try { j = JSON.parse(body) } catch { throw new Error("得物订单响应不是 JSON") }
    const list = Array.isArray(j?.data?.orderList) ? j.data.orderList : []
    return (list as any[]).map((o: any) => parseLooseOrder(o)).filter(o => !!o.orderSn || !!o.mailNo)
  } finally {
    try { c.dispose() } catch { }
  }
}
