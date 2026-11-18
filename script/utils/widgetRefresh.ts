/**
 * 小组件轻量刷新（v22 修复版）：
 * - 修复 widgetTasks 传入 uuid 充当 orderId 导致平台查单 100% 失败的问题
 * - 新增「平台接口失败 -> 自动降级快递鸟 (refreshViaKdniao)」双保险机制，解决组件后台无 WebView/Storage 无法查单的问题
 * - 补全平台线路的取件码提取与到站状态 (arrivedAt) 识别
 * - 分批并发：每批 15 个，批间隔 200ms，最多 3 批（45 单），总预算默认 8 秒
 */
import { extractPickupCode, pickupCodeInText } from "./pickupCode"
import { mergeCodes } from "./codes"
import { queryTracking } from "../kdniao"
import { fetchPackage as taobaoFetchPackage } from "./net"
import { jdFetchPackage } from "./jd"
import { pddFetchPackage } from "./pdd"
import { safeDelay } from "./safeTimer"

const ARRIVED_RE = /待取件|已到站|已到达|已投递|已暂存|已存放|已放入|已代收|请及时取|请及时领取|凭取件码|待领取|快递柜|驿站|代收点/

export type TrackUpdateMap = Map<string, any>

function enrichTrackUpdate(u: any, latestText: string, nodes?: any[], pkg?: any): any {
  const cleanLatest = String(latestText || "").replace(/\s+/g, " ").trim()
  if (cleanLatest) {
    u.trackLatest = cleanLatest
  }
  u.trackUpdatedAt = Date.now()

  const nodeTexts = Array.isArray(nodes)
    ? nodes.map((n: any) => ({ text: String(n?.text ?? n?.context ?? n?.AcceptStation ?? n ?? "") }))
    : []
  const newCode = extractPickupCode(nodeTexts) || pickupCodeInText(cleanLatest)
  if (newCode) {
    u.codes = mergeCodes(Array.isArray(pkg?.codes) ? pkg.codes : [], newCode)
    u.code = newCode
  }
  if (ARRIVED_RE.test(cleanLatest) && !pkg?.arrivedAt) {
    u.arrivedAt = Date.now()
  }
  return u
}

/** 快递鸟纯 HTTP 极速线路：无需 WebView，自带手机号尾号透传，适合小组件后台高频刷新 */
async function refreshViaKdniao(no: string, shipperCode?: string, pkg?: any): Promise<any> {
  if (!no || no.length < 5) return null
  try {
    const phone = String(pkg?.phone || pkg?.mobile || pkg?.receiverPhone || pkg?.tail || "").trim()
    const r = await queryTracking(no, { shipperCode, phone })
    if (!r) return null
    const latest = String(r.latest || "").replace(/\s+/g, " ").trim()
    const hasNodes = Array.isArray(r.nodes) && r.nodes.length > 0
    if (!latest && !hasNodes) return null

    const u: any = {}
    if (hasNodes) u.trackNodes = r.nodes
    if ((r as any).status === "delivered" || /已签收|代签收|妥投|已取件|已取出/.test(latest)) {
      u.status = 2
    }
    return enrichTrackUpdate(u, latest, r.nodes, pkg)
  } catch {
    return null
  }
}

/** 平台线路：仅当包裹还没有运单号、或快递鸟未查出时兜底调用 */
async function refreshViaPlatform(src: string, passedOrderId: string, pkg: any): Promise<any> {
  try {
    const realOrderId = String(pkg?.orderId || pkg?.orderSn || passedOrderId || "")
    if (!realOrderId) return null

    let fresh: any = null
    if (src === "jd") {
      fresh = await jdFetchPackage({
        orderId: realOrderId.replace(/^jd:/, ""),
        itemTitle: pkg?.itemTitle || "",
        shopName: pkg?.shopName || "",
        statusHint: pkg?.trackLatest || pkg?.latest || "",
      })
    } else if (src === "pdd") {
      fresh = await pddFetchPackage({
        orderSn: realOrderId.replace(/^pdd:/, ""),
        itemTitle: pkg?.itemTitle,
        shopName: pkg?.shopName,
        statusHint: pkg?.trackLatest || pkg?.latest,
      })
    } else if (src === "taobao" || src === "cainiao") {
      fresh = await taobaoFetchPackage(realOrderId, pkg)
    }

    if (!fresh) return null
    const latest = String(fresh.latest || fresh.trackLatest || "").replace(/\s+/g, " ").trim()
    if (!latest && !fresh.mailNo && !fresh.status) return null

    const u: any = {
      status: fresh.status === "delivered" ? 2 : (fresh.status === "transit" ? 1 : (pkg?.status ?? 1)),
      mailNo: fresh.mailNo || pkg?.mailNo,
      itemTitle: fresh.itemTitle || pkg?.itemTitle,
    }
    if (Array.isArray(fresh.nodes) && fresh.nodes.length > 0) {
      u.trackNodes = fresh.nodes
    }
    return enrichTrackUpdate(u, latest || pkg?.trackLatest || "", fresh.nodes, pkg)
  } catch {
    return null
  }
}

export async function refreshMailNos(
  items: Array<{ no?: string; orderId?: string; source?: string; shipperCode?: string; pkg?: any }>,
  opts?: { deadline?: number },
): Promise<TrackUpdateMap> {
  const out = new Map<string, any>()
  const deadline = opts?.deadline ?? Date.now() + 8000
  const timeUp = () => Date.now() > deadline
  const BATCH = 15

  for (let i = 0; i < items.length && i < 45; i += BATCH) {
    if (timeUp()) break
    const batch = items.slice(i, i + BATCH)
    await Promise.all(batch.map(async it => {
      if (timeUp()) return
      let u: any = null
      const pkg = it.pkg || {}
      const src = String(it.source || pkg.source || "").toLowerCase()
      const mailNo = String(it.no || pkg.mailNo || "").trim()
      const shipperCode = it.shipperCode || pkg.shipperCode || ""

      // 在小组件后台，只要有运单号 mailNo，100% 优先走快递鸟纯 HTTP 极速接口
      if (mailNo && mailNo.length >= 5) {
        u = await refreshViaKdniao(mailNo, shipperCode, pkg)
      }

      // 只有还没发货出单号（无 mailNo）或快递鸟未查到时，才尝试平台接口
      if ((!u || !u.trackLatest) && (src === "taobao" || src === "cainiao" || src === "jd" || src === "pdd")) {
        const platUpdate = await refreshViaPlatform(src, String(it.orderId || ""), pkg)
        if (platUpdate) {
          u = u ? { ...u, ...platUpdate } : platUpdate
        }
      }

      const mapKey = String(it.no || it.orderId || pkg.mailNo || pkg.uuid || "")
      if (u && mapKey) {
        out.set(mapKey, u)
      }
    }))
    if (i + BATCH < items.length && !timeUp()) {
      await safeDelay(150)
    }
  }
  return out
}
