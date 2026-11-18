// 新平台（唯品会 / 得物）订单的「宽松取值器」。
//
// 这两家的订单字段名我们还没有真实样本（手册里那两个账号都是 0 单），
// 所以先按键名正则拍平找值，等真机跑出真数据再按实际字段收紧。
// 只做「找得到就用」，判断不了就返回空串，绝不瞎猜业务含义。

export type LooseOrder = {
  orderSn: string
  itemTitle: string
  statusHint: string
  mailNo: string
  company: string
  orderTime?: number
}

function s(v: any): string {
  return typeof v === "string" ? v.trim() : (typeof v === "number" ? String(v) : "")
}

/** 拍平成 键(小写) → 值；同名键保留先出现的那个（层级越浅越可信） */
export function flatMapOf(o: any, out: Map<string, string> = new Map(), depth = 0): Map<string, string> {
  if (depth > 5 || o == null || typeof o !== "object") return out
  for (const k of Object.keys(o)) {
    const v = (o as any)[k]
    if (v && typeof v === "object") { flatMapOf(v, out, depth + 1); continue }
    const val = s(v)
    if (!val) continue
    const key = k.toLowerCase()
    if (!out.has(key)) out.set(key, val)
  }
  return out
}

const ORDER_ID_KEYS = /^(order_?sn|order_?id|order_?no|order_?code|ordersn|orderid|order_?num)$/
const MAIL_KEYS = /((express|waybill|tracking|logistic|delivery|transport)[_a-z]*?(no|num|code|id|sn))|^mail_?no$/
const TITLE_KEYS = /(goods|product|ware|item|sku)[_a-z]*?name$|^(goods_?title|title|subject|sku_?title)$/
const STATUS_KEYS = /order_?status_?name|status_?name|status_?desc|status_?str|order_?state_?name|status_?text/
const COMPANY_KEYS = /(express|shipping|logistics|carrier)[_a-z]*?name/
const TIME_KEYS = /(order_?time|create_?time|add_?time|order_?date|create_?date|pay_?time)/

export function msOf(raw: string): number | undefined {
  if (!raw) return undefined
  if (/^\d{13}$/.test(raw)) return Number(raw)
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000
  const m = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime()
}

function first(map: Map<string, string>, re: RegExp, accept?: (v: string) => boolean): string {
  for (const [k, v] of map) {
    if (!re.test(k)) continue
    if (accept && !accept(v)) continue
    return v
  }
  return ""
}

/** 从任意订单对象里尽量取出我们需要的几项 */
export function parseLooseOrder(raw: any): LooseOrder {
  const f = flatMapOf(raw)
  return {
    orderSn: first(f, ORDER_ID_KEYS, v => v.length >= 6 && /^[A-Za-z0-9-]+$/.test(v)),
    // 运单号：8 位以上字母数字（可带横杠），键名必须像运单号，不能用订单号顶替
    mailNo: first(f, MAIL_KEYS, v => /^[A-Za-z0-9-]{8,}$/.test(v)),
    itemTitle: first(f, TITLE_KEYS, v => v.length > 1 && v.length < 120),
    statusHint: first(f, STATUS_KEYS),
    company: first(f, COMPANY_KEYS),
    orderTime: msOf(first(f, TIME_KEYS)),
  }
}
