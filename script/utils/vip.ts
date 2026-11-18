// 唯品会订单：H5 网关直连（GET + Cookie），不需要签名、不用开网页。
//
// 协议来自实测手册（mapi.vip.com/vips-mobile/rest/...），但手册那个账号是 0 单，
// 所以订单里到底叫什么字段没有实证：取值走 utils/orderLoose 的宽松取值器；
// 需要看原文时把 Storage 里的 cc.debugDump 置 true，才会写 cc/vipDump.json。
//
// 已知的坑（手册实测，已照做）：
//   · mars_cid 必须同时出现在 Cookie 和 query 里，只放一边会报 "mars_cid must not be empty"
//   · mobile_platform 必须是数字 2
//   · 只有 VipRUID 不算登录，至少要有 VIP_TANK 或 m_vipruid
import { diag } from "./net"
import { parseLooseOrder, type LooseOrder } from "./orderLoose"

declare const fetch: any

const COOKIE_KEY = "vip.cookies"
/** H5 页面 JS 里写死的公开常量 */
const API_KEY = "8cec5243ade04ed3a02c5972bcda0d3f"
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

export type VipOrder = LooseOrder

/* ---------------- 登录态 ---------------- */

export function vipCookies(): any[] {
  const raw = Keychain.get(COOKIE_KEY)
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

export function vipSaveCookies(list: any[]): void {
  // 只要是指向 vip.com 的 Cookie 都留（含子域）：登录时的设备标识/指纹类 Cookie
  // 少存一个，服务端就会认不出这个会话（“User id not found”）
  const usable = (list || []).filter((c: any) => /vip\.com/i.test(String(c?.domain ?? "")))
  if (usable.length > 0) Keychain.set(COOKIE_KEY, JSON.stringify(usable))
}

export function vipCookieHeader(): string {
  return vipCookies().map((c: any) => `${c.name}=${c.value}`).join("; ")
}

function cookieValue(name: string): string {
  return String(vipCookies().find((c: any) => String(c.name) === name)?.value ?? "")
}

/** 真登录标志：手册实测「只有 VipRUID 时 user/check 仍返回 userId:0」 */
export function vipHasLogin(): boolean {
  return !!cookieValue("VIP_TANK") || !!cookieValue("m_vipruid") || !!cookieValue("WAP[login]")
}

export function vipClearLogin(): void {
  try { Keychain.remove(COOKIE_KEY) } catch { }
}

/* ---------------- 订单列表 ---------------- */

/** 落一份原始响应（含订单原文，默认不写盘，排查时把 cc.debugDump 置 true 才落） */
function dumpRaw(text: string): void {
  try {
    if (!Storage.get<boolean>("cc.debugDump")) return
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(`${dir}/vipDump.json`, text.slice(0, 300_000))
  } catch { }
}

/** 读唯品会订单（时间范围由同步层筛，这里全拿）。 */
export async function vipFetchOrders(): Promise<VipOrder[]> {
  if (!vipHasLogin()) throw new Error("唯品会登录已失效，请重新授权")
  const res = await vipRequestOrders()
  const text = res.text
  let j = res.json
  // code 1 / 200 都算成功（手册见到的两个版本）；其余按服务端文案
  const code = j?.code
  if (code !== 1 && code !== 200) {
    const msg = String(j?.msg || `唯品会返回 ${code ?? res.status}`)
    // 实测：登录态过期时服务端回 “User id not found”（cookie 还在但会话失效）
    diag("vip-orders-fail", {
      code,
      msg,
      cookieNames: vipCookies().map((c: any) => String(c?.name ?? "")).join(","),
    })
    dumpRaw(text)
    if (/user id not found|未登录|not login|login required|请重新登录/i.test(msg)) {
      throw new Error("唯品会登录已失效，请重新授权")
    }
    throw new Error(msg)
  }
  dumpRaw(text)
  const orders = Array.isArray(j?.data?.orders) ? j.data.orders : []
  if (orders.length === 0) diag("vip-orders", { note: "0 单", code })
  return (orders as any[]).map((o: any) => parseLooseOrder(o)).filter(o => !!o.orderSn || !!o.mailNo)
}

/** 低层请求（探针也用它）：extraQuery 用来试“补一个 user_id 能不能认回来” */
export async function vipRequestOrders(extraQuery = ""): Promise<{ status: number; text: string; json: any }> {
  const cid = cookieValue("mars_cid") || cookieValue("vip_cid") || cookieValue("VipCID")
  const list = vipCookies()
  const mars = cid
  // 绝不自己造设备号：唯品会的会话绑在登录时的 mars_cid 上，
  // 随便编一个新值等于告诉服务端“我换手机了”，会话立刻失效。
  if (!mars) throw new Error("唯品会缺少设备标识（mars_cid），请重新授权")
  const q = [
    `api_key=${API_KEY}`,
    `mars_cid=${encodeURIComponent(mars)}`,
    "mobile_platform=2",
    "app_name=shop_wap",
    "client=wap",
    "client_type=wap",
    "source_app=shop_wap",
    "app_version=4.0",
    "format=json",
    "ver=2.0",
    "standby_id=other",
    "union_mark=nature",
    "mobile_channel=nature",
    "sd_tuijian=0",
    "warehouse=VIP_",
    "page=1",
    "page_size=50",
  ].join("&")
  const url = `https://mapi.vip.com/vips-mobile/rest/order/mina_programs/get_union_order_list/v1?${q}${extraQuery}`
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: list.map((c: any) => `${c.name}=${c.value}`).join("; "),
      "User-Agent": UA,
      Referer: "https://m.vip.com/",
      Accept: "application/json, text/plain, */*",
    },
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, text, json }
}
