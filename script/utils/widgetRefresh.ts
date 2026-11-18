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

/** 统一补充取件码与到站标记 */
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

/** 快递鸟线路：单号查轨迹，返回变化字段 */
async function refreshViaKdniao(no: string, shipperCode?: string, pkg?: any): Promise<Partial<any> | null> {
  if (!no || no.length < 5) return null
  try {
    const r = await queryTracking(no, { shipperCode })
    if (!r) return null
    const latest = String(r.latest || "").replace(/\s+/g, " ").trim()
    const hasNodes = Array.isArray(r.nodes) && r.nodes.length > 0
    // 如果既没有最新轨迹也没有节点，视为查询未命中，不覆盖旧数据
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

/** 平台线路：查平台包裹最新状态（支持自动纠正 orderId） */
async function refreshViaPlatform(src: string, passedOrderId: string, pkg: any): Promise<Partial<any> | null> {
  try {
    // 修复：widgetTasks 传进来的 passedOrderId 实际上是 pkg.uuid！这里优先取 pkg.orderId
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
    // 若平台接口在后台未拿到有效轨迹，返回 null 以便触发外层的快递鸟降级查询
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
): Promise>> {
  const out = new Map<string, Partial<any>>()
  const deadline = opts?.deadline ?? Date.now() + 8000
  const timeUp = () => Date.now() > deadline
  const BATCH = 15

  for (let i = 0; i < items.length && i < 45; i += BATCH) {
    if (timeUp()) break
    const batch = items.slice(i, i + BATCH)
    await Promise.all(batch.map(async it => {
      if (timeUp()) return
      let u: Partial<any> | null = null
      const pkg = it.pkg || {}
      const src = String(it.source || pkg.source || "").toLowerCase()
      const mailNo = String(it.no || pkg.mailNo || "").trim()
      const shipperCode = it.shipperCode || pkg.shipperCode || ""

      // 1. 平台单优先尝试平台自身接口
      if (src === "taobao" || src === "cainiao" || src === "jd" || src === "pdd") {
        u = await refreshViaPlatform(src, String(it.orderId || ""), pkg)
      }

      // 2. 双保险兜底：如果非平台单，或者平台接口在组件后台因无 WebView/Cookie 失败，只要有运单号就走快递鸟查询！
      if ((!u || !u.trackLatest) && mailNo) {
        const kdUpdate = await refreshViaKdniao(mailNo, shipperCode, pkg)
        if (kdUpdate) {
          u = u ? { ...u, ...kdUpdate } : kdUpdate
        }
      }

      // 注意：key 必须严格对齐 widgetTasks.ts 里的 String(p.mailNo || p.uuid || "")
      const mapKey = String(it.no || it.orderId || pkg.mailNo || pkg.uuid || "")
      if (u && mapKey) {
        out.set(mapKey, u)
      }
    }))
    if (i + BATCH < items.length && !timeUp()) {
      await safeDelay(200)
    }
  }
  return out
}
