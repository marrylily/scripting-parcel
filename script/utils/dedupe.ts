/**
 * 跨平台去重。
 *
 * 淘宝 / 京东 / 拼多多 都绑了同一个手机号时，同一张运单会被两个平台各同步一条。
 * 这里按「运单号（归一化）」和「平台订单号」把它们并成一条：
 * 码合并、轨迹取更新的那条、状态取「已取优先」。
 *
 * 每次启动都跑（列表只有几百条，纯内存 Map，删除时才写盘）。
 * 新增入库的去重靠 store.addPickup 的那道闸，这里只兜底历史数据 + 漏网的情况。
 */
import { getPickups, savePickups, type Pickup } from "../store"
import { codeKey, mergeCodes } from "./codes"

function keysOf(p: Pickup): string[] {
  const out: string[] = []
  const mail = codeKey(String(p.mailNo ?? ""))
  if (mail) out.push(`m:${mail}`)
  const oid = String(p.orderId ?? "")
  if (oid) {
    // 平台订单号自带前缀（tb:/jd:/pdd:/fc:），不再拼 source：老数据可能没存 source
    out.push(/^(tb|jd|pdd|fc):/.test(oid) ? `o:${oid}` : `o:${p.source ?? ""}:${oid}`)
  }
  return out
}

function mergeTwo(prev: Pickup, p: Pickup): Pickup {
  // 谁更新就把轨迹/时间当基底，另一条只贡献码、商品名、驿站、状态
  const fresher = (p.trackUpdatedAt ?? p.createdAt) > (prev.trackUpdatedAt ?? prev.createdAt) ? p : prev
  const older = fresher === p ? prev : p
  const merged: Pickup = {
    ...fresher,
    // 已取件/用户手动标记优先，别因为合并又变回待取
    status: prev.status === 2 || p.status === 2 ? 2 : fresher.status,
    pickedByUser: prev.pickedByUser || p.pickedByUser,
    pickedAt: prev.pickedAt || p.pickedAt,
    itemTitle: fresher.itemTitle || older.itemTitle,
    courierStationName: fresher.courierStationName || older.courierStationName,
    courierStationUuid: fresher.courierStationUuid || older.courierStationUuid,
    address: fresher.address || older.address,
    phone: fresher.phone || older.phone,
    eta: fresher.eta || older.eta,
    etaAt: fresher.etaAt || older.etaAt,
    mailNo: fresher.mailNo || older.mailNo,
  }
  const codes = mergeCodes([
    ...(prev.codes ?? (prev.code ? [prev.code] : [])),
    ...(p.codes ?? (p.code ? [p.code] : [])),
  ])
  if (codes.length) {
    merged.codes = codes
    merged.code = codes[0]
  }
  return merged
}

export function dedupePickups(): number {
  const list = getPickups()
  if (list.length < 2) return 0

  const out: Pickup[] = []
  const indexOf = new Map<string, number>()  // 任一 key → out 下标
  let removed = 0

  for (const p of list) {
    const keys = keysOf(p)
    if (keys.length === 0) { out.push(p); continue }
    let at: number | undefined
    for (const k of keys) {
      const i = indexOf.get(k)
      if (i !== undefined) { at = i; break }
    }
    if (at === undefined) {
      const idx = out.length
      out.push(p)
      for (const k of keys) indexOf.set(k, idx)
      continue
    }
    // 命中已有条目：合并（合并后的 key 可能多出新的一批，全部指回同一条）
    out[at] = mergeTwo(out[at], p)
    for (const k of keysOf(out[at])) indexOf.set(k, at)
    removed++
  }

  if (removed > 0) savePickups(out)
  return removed
}
