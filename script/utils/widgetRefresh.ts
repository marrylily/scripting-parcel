/**
 * 小组件轻量刷新（v25）：
 * - 淘宝 / 拼多多 / 京东 / 唯品会 走各自平台接口；
 *   实测组件扩展里 WebView 可用（ctor/load/title/8 秒后仍可求值），
 *   而这些接口只 loadURL 不开模态，所以组件里能跑。
 * - 其余（得物 / 丰巢 / 手动添加）走「菜鸟免登录查单 → 快递鸟兜底」，
 *   得物的订单页 hook 需要页面停留，留给 App。
 * - 分批并发：每批 15 个，批间隔 300ms，最多 3 批（45 单），总预算默认 8 秒
 */
import { extractPickupCode, pickupCodeInText } from "./pickupCode"
import { codeKey, mergeCodes } from "./codes"
import { queryTracking } from "../kdniao"
import { trackMailNo as cnTrackMailNo } from "./cainiao"
import { vipFetchOrders } from "./vip"
import { platformLastSyncedAt } from "./platformSync"
import { fetchPackage as taobaoFetchPackage } from "./net"
import { jdFetchPackage } from "./jd"
import { pddFetchPackageFast } from "./pdd"
import { arrivalState, matchStation } from "../store"
import { stationHaystack } from "./model"
import { arrivedAtOf } from "./arrive"

/** 快递鸟线路：单号查轨迹，返回变化字段 */
async function refreshViaKdniao(no: string, shipperCode?: string, pkg?: any): Promise<Partial<any> | null> {
  try {
    const r = await queryTracking(no, { shipperCode })
    return partialOfTrack(String(r.latest || ""), r.nodes || [], pkg)
  } catch {
    return null
  }
}

/** 把一份轨迹结果拼成卡片可合并的字段（含到站时间、取件码、驿站匹配、已取件状态） */
export function partialOfTrack(latest: string, nodes: any[], pkg?: any, extra?: { pickupCode?: string; stationName?: string; status?: string; mailNo?: string; itemTitle?: string }): Partial<any> {
  const latestText = String(latest || "").replace(/\s+/g, " ").trim()
  const u: any = {
    trackLatest: latestText || pkg?.trackLatest || "",
    trackUpdatedAt: Date.now(),
  }
  if (nodes && nodes.length > 0) u.trackNodes = nodes.slice(0, 60)
  if (extra?.mailNo || pkg?.mailNo) u.mailNo = extra?.mailNo || pkg?.mailNo
  if (extra?.itemTitle || pkg?.itemTitle) u.itemTitle = extra?.itemTitle || pkg?.itemTitle

  const arrival = arrivalState(latestText)
  const allNodes = (nodes || []).map((n: any) => ({ text: String(n?.text ?? n) }))
  const foundCode = (extra?.pickupCode || "").trim()
    || extractPickupCode(allNodes)
    || pickupCodeInText(latestText)
  const mailId = u.mailNo ?? pkg?.orderId ?? ""
  const validCode = foundCode && codeKey(foundCode) !== codeKey(mailId) ? foundCode : ""
  if (validCode) {
    const baseCodes = (pkg?.codes ?? (pkg?.code ? [pkg.code] : [])).filter((c: string) => {
      const k = codeKey(c)
      return k !== codeKey(pkg?.mailNo ?? "") && k !== codeKey(pkg?.orderId ?? "")
    })
    const merged = mergeCodes(baseCodes, validCode)
    if (merged.length > 0) {
      u.codes = merged
      u.code = merged[0]
    }
  }

  const stName = extra?.stationName || pkg?.courierStationName || ""
  const station = matchStation(stationHaystack({
    courierStationName: stName,
    address: pkg?.address,
    receiverAddress: pkg?.receiverAddress,
    trackLatest: latestText,
  }))
  if (stName) {
    u.courierStationName = stName
    u.address = stName
  }
  if (station) {
    u.courierStationName = station.name
    u.courierStationUuid = station.uuid
    u.address = station.name
  }

  const hasCodeOrStation = !!(validCode || u.code || pkg?.code || stName || station || pkg?.courierStationName)
  if (extra?.status === "cancelled") {
    u.status = 2
    u.closed = "已关闭"
  } else if (arrival === "picked" || (extra?.status === "delivered" && arrival !== "arrived") || (extra?.status === "delivered" && !hasCodeOrStation)) {
    u.status = 2
    u.pickedAt = pkg?.pickedAt ?? arrivedAtOf(nodes) ?? Date.now()
    u.fcBox = undefined
  } else if (arrival === "arrived" || validCode) {
    u.status = (pkg?.status === 2) ? 2 : 1
    u.arrivedAt = pkg?.arrivedAt ?? arrivedAtOf(nodes) ?? Date.now()
  }
  return u
}

/** 菜鸟免登录查轨迹（与主脚本一致）；菜鸟没节点、或时间不够了才走快递鸟 */
async function refreshViaFreeTrack(no: string, shipperCode?: string, timeUp?: () => boolean, pkg?: any): Promise<Partial<any> | null> {
  if (!timeUp || !timeUp()) {
    try {
      const cn = await cnTrackMailNo(no)
      const nodes = cn?.nodes ?? []
      if (nodes.length > 0) return partialOfTrack(String(nodes[0]?.text ?? ""), nodes, pkg)
    } catch { }
  }
  return refreshViaKdniao(no, shipperCode, pkg)
}

async function refreshViaPlatform(src: string, orderId: string, pkg: any, vipOrders?: any[] | null, deadline = Number.POSITIVE_INFINITY): Promise<Partial<any> | null> {
  try {
    // 唯品会：一次订单列表就能对所有单，命中就拿到平台自己的状态文案
    if (src === "vip") {
      const sn = orderId.replace(/^vip:/, "")
      const mailNo = String(pkg.mailNo || "")
      const hit = (vipOrders || []).find((o: any) =>
        (sn && String(o?.orderSn || "") === sn) || (mailNo && String(o?.mailNo || "") === mailNo))
      const hint = String(hit?.statusHint || "").trim()
      if (!hint) return null
      return partialOfTrack(hint, [], pkg)
    }
    if (src === "jd") {
      // 京东没有免页接口，但运单号能走菜鸟（纯 HTTP）；菜鸟有节点就先不开跟踪页，
      // 拿不到（新单/菜鸟没收录）才回落平台跟踪页。
      const no = String(pkg.mailNo || "")
      if (no) {
        const quick = await refreshViaFreeTrack(no, undefined, () => deadline - Date.now() < 3000, pkg)
        if (quick && quick.trackLatest) return quick
      }
      const fresh = await jdFetchPackage({
        orderId: orderId.replace(/^jd:/, ""),
        itemTitle: pkg.itemTitle || "",
        shopName: pkg.shopName || "",
        statusHint: pkg.trackLatest || pkg.latest || "",
      })
      return fresh ? partialOfTrack(fresh.latest, fresh.tracks || [], pkg, {
        pickupCode: fresh.pickupCode,
        stationName: fresh.stationName,
        status: fresh.status,
        mailNo: fresh.mailNo || pkg.mailNo,
        itemTitle: fresh.itemTitle || pkg.itemTitle,
      }) : null
    }
    if (src === "pdd") {
      // 拼多多有直连（mtop，按 order_sn），直连拿不到节点才开物流页
      const fresh = await pddFetchPackageFast({
        orderSn: orderId.replace(/^pdd:/, ""),
        itemTitle: pkg.itemTitle,
        shopName: pkg.shopName,
        statusHint: pkg.trackLatest || pkg.latest,
        trackingNumber: String(pkg.mailNo || "") || undefined,
      })
      return fresh ? partialOfTrack(fresh.latest, fresh.tracks || [], pkg, {
        pickupCode: fresh.pickupCode,
        stationName: fresh.stationName,
        status: fresh.status,
        mailNo: fresh.mailNo || pkg.mailNo,
        itemTitle: fresh.itemTitle || pkg.itemTitle,
      }) : null
    }
    // 淘宝：必须去掉 tb: 前缀再查物流页
    const rawTbId = orderId.replace(/^tb:/, "")
    if (!rawTbId) return null
    const fresh = await taobaoFetchPackage(rawTbId, pkg)
    return fresh ? partialOfTrack(fresh.latest, fresh.tracks || [], pkg, {
      pickupCode: fresh.pickupCode,
      stationName: fresh.stationName,
      status: fresh.status,
      mailNo: fresh.mailNo || pkg.mailNo,
      itemTitle: fresh.itemTitle || pkg.itemTitle,
    }) : null
  } catch {
    return null
  }
}

export async function refreshMailNos(
  items: Array<{ no?: string; orderId?: string; source?: string; shipperCode?: string; pkg?: any }>,
  opts?: { deadline?: number; onBatch?: (got: Map<string, Partial<any>>) => void },
): Promise<Map<string, Partial<any>>> {
  const out = new Map<string, Partial<any>>()
  const deadline = opts?.deadline ?? Date.now() + 8000
  const timeUp = () => Date.now() > deadline
  const BATCH = 15
  // 开网页的源（京东/拼多多）要单独限并发
  const SLOW_SRC = new Set(["jd", "pdd"])
  const SLOW_LIMIT = 3
  let vipOrders: any[] | null = null
  if (items.some(it => String(it.source || "") === "vip")) {
    try { vipOrders = await vipFetchOrders() } catch { vipOrders = [] }
  }

  const one = async (it: any): Promise<void> => {
    let u: Partial<any> | null = null
    const src = String(it.source || "")
    // 刚全量同步过的平台 2 分钟内不再逐条重复刷
    const graceMs = 2 * 60_000
    if ((src === "taobao" || src === "jd" || src === "pdd" || src === "vip")
      && Date.now() - platformLastSyncedAt(src) < graceMs) {
      return
    }
    if (SLOW_SRC.has(src) && deadline - Date.now() < 6000) return
    if (src === "taobao" || src === "jd" || src === "pdd" || src === "vip") {
      u = await refreshViaPlatform(src, String(it.orderId || ""), it.pkg || {}, vipOrders, deadline)
      if (src === "vip" && it.no) {
        const tr = await refreshViaFreeTrack(it.no, it.shipperCode, timeUp, it.pkg)
        if (tr) u = { ...(u || {}), ...tr }
      }
    } else if (it.no) {
      u = await refreshViaFreeTrack(it.no, it.shipperCode, timeUp, it.pkg)
    }
    if (u) out.set(String(it.no || it.orderId || it.pkg?.uuid || ""), u)
  }

  const runLimited = async (list: any[], limit: number): Promise<void> => {
    for (let k = 0; k < list.length; k += limit) {
      if (timeUp()) return
      await Promise.all(list.slice(k, k + limit).map(one))
    }
  }

  for (let i = 0; i < items.length && i < 45; i += BATCH) {
    if (timeUp()) break
    const batch = items.slice(i, i + BATCH)
    const fast = batch.filter(it => !SLOW_SRC.has(String(it.source || "")))
    const slow = batch.filter(it => SLOW_SRC.has(String(it.source || "")))
    await Promise.all([runLimited(fast, fast.length || 1), runLimited(slow, SLOW_LIMIT)])
    if (out.size > 0) { try { opts?.onBatch?.(out) } catch { } }
    if (i + BATCH < items.length && !timeUp()) {
      await new Promise<void>(res => setTimeout(() => res(), 300))
    }
  }
  return out
}
