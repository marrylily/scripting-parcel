/**
 * 小组件后台任务调度（v31）
 *
 * 一次组件重建 = 一个时间片：
 *   1. 每次都做：检查灵动岛是否到期（不联网，纯本地）
 *   2. 若「全量轮转」到点 → 跑到期平台的全量找新单（并同步已有单在菜鸟/丰巢/各平台的最新状态）
 *   3. 若「数据刷新」到点（且时间片还有剩余预算） → 刷新已有单号的物流（+ 菜鸟核销 + 到站通知）
 *
 * 三个节拍各自记在共享目录 cc/widgetTasks.json 里，进程被杀也不丢。
 */
import { Notification } from "scripting"
import { expirePickupActivityIfDue } from "./liveExpire"
import { partialOfTrack, refreshMailNos } from "./widgetRefresh"
import { syncPlatformParcels, platformLastSyncedAt } from "./platformSync"
import { getPickups, getSettings } from "../store"
import { hasLogin } from "./net"
import { jdHasLogin } from "./jd"
import { pddHasLogin } from "./pdd"
import { fcHasLogin } from "./fengchao"
import { dewuHasLogin } from "./dewu"
import { fetchMyPackages as cnFetchMyPackages } from "./cainiao"
import { hasAuth, platformEnabled } from "../platforms"
import { readJsonFile, writeJsonFile, appendOperation } from "./sharedJson"
import { codeKey } from "./codes"

const DIR = () => `${FileManager.appGroupDocumentsDirectory}/cc`
const STATE_FILE = () => `${DIR()}/widgetTasks.json`
const LOCK_FILE = () => `${DIR()}/widgetTasks.lock`
const NEW_PKGS = () => `${DIR()}/newPackages.json`
const SNAP = () => `${DIR()}/widget.json`

const LOCK_MS = 25_000
const LIGHT_BUDGET_MS = 8000
const FULL_BUDGET_MS = 18_000
const PER_PLATFORM_MS = 18_000

const SYNC_TRACK_FIELDS = [
  "trackLatest", "trackNodes", "trackUpdatedAt", "code", "codes",
  "arrivedAt", "mailNo", "itemTitle", "status", "pickedAt",
  "courierStationName", "courierStationUuid", "address", "fcBox", "closed",
] as const

type TaskState = {
  lightAt?: number
  fullAt?: number
  fail?: Record<string, { n: number; until: number }>
}

function readState(): TaskState {
  try {
    if (!FileManager.existsSync(STATE_FILE())) return {}
    return JSON.parse(FileManager.readAsStringSync(STATE_FILE()) || "{}") || {}
  } catch { return {} }
}

function writeState(s: TaskState): void {
  try {
    if (!FileManager.existsSync(DIR())) FileManager.createDirectorySync(DIR(), true)
    writeJsonFile(STATE_FILE(), s)
  } catch { }
}

function fullCandidates(): string[] {
  const s: any = getSettings()
  const out: string[] = []
  if (hasLogin()) {
    if (s.showTaobao !== false) out.push("taobao")
    if (s.showCainiao !== false) out.push("cainiao")
  }
  if (pddHasLogin() && s.showPdd !== false) out.push("pdd")
  if (jdHasLogin()) out.push("jd")
  if (fcHasLogin()) out.push("fengchao")
  if (dewuHasLogin()) out.push("dewu")
  if (hasAuth("vip") && platformEnabled("vip")) out.push("vip")
  return out
}

function stashNewPackages(fresh: any[]): number {
  if (fresh.length === 0) return 0
  try {
    let prev: any[] = []
    if (FileManager.existsSync(NEW_PKGS())) prev = JSON.parse(FileManager.readAsStringSync(NEW_PKGS()) || "[]") || []
    const key = (p: any) => `${p?.source ?? ""}|${p?.orderId ?? p?.mailNo ?? ""}`
    const map = new Map<string, any>()
    for (const p of [...prev, ...fresh]) if (p) map.set(key(p), p)
    const arr = Array.from(map.values()).slice(-200)
    writeJsonFile(NEW_PKGS(), arr)
    for (const p of fresh) try { appendOperation(`${DIR()}/ops/new`, p) } catch { }
    return arr.length
  } catch { return 0 }
}

function persistTrackOps(ops: Record<string, any>): void {
  if (Object.keys(ops).length === 0) return
  try {
    const f = `${DIR()}/trackUpdates.json`
    const prev = FileManager.existsSync(f) ? JSON.parse(FileManager.readAsStringSync(f) || "{}") || {} : {}
    const cutoff = Date.now() - 7 * 86_400_000
    const merged: Record<string, any> = { ...prev }
    for (const k of Object.keys(merged)) if (Number(merged[k]?.at ?? 0) < cutoff) delete merged[k]
    writeJsonFile(f, { ...merged, ...ops })
    for (const [uuid, update] of Object.entries(ops)) {
      try { appendOperation(`${DIR()}/ops/track`, { uuid, update }) } catch { }
    }
  } catch { }
}

function lastTouchedAt(id: string): number {
  let fail = 0
  try {
    const f = `${DIR()}/syncErr.json`
    if (FileManager.existsSync(f)) {
      const v = JSON.parse(FileManager.readAsStringSync(f) || "{}") || {}
      fail = Number(v?.[id]?.at ?? 0) || 0
    }
  } catch { }
  return Math.max(platformLastSyncedAt(id), fail)
}

function sharedLastRefreshAt(): number {
  try {
    const f = `${DIR()}/lastRefresh.json`
    if (!FileManager.existsSync(f)) return 0
    return Number(JSON.parse(FileManager.readAsStringSync(f) || "{}")?.at ?? 0) || 0
  } catch { return 0 }
}

export function tickLive(): void {
  try { expirePickupActivityIfDue() } catch { }
}

const MAX_PLATFORMS_PER_WAKE = 2

async function runPlatformSync(state: TaskState, rotateMin: number, snap: any, budgetMs?: number): Promise<boolean> {
  const cand = fullCandidates()
  if (cand.length === 0) { state.fullAt = Date.now(); writeState(state); return false }
  const now = Date.now()
  const fail = (state.fail ??= {})
  const coolMs = Math.max(5, Number(getSettings().failCoolMin) || 30) * 60_000
  const overdue = cand
    .filter(id => now >= (fail[id]?.until ?? 0))
    .filter(id => now - lastTouchedAt(id) >= Math.max(10, rotateMin) * 60_000)
    .sort((a, b) => lastTouchedAt(a) - lastTouchedAt(b))
  if (overdue.length === 0) { state.fullAt = now; writeState(state); return false }

  // 先将共享快照中的包裹注入组件进程的 Storage，使 syncPlatformParcels 内部的 upsert 能命中并更新已有包裹
  let snapBackup = ""
  let seedList: any[] = Array.isArray(snap?.pickups) ? snap.pickups : []
  try {
    if (FileManager.existsSync(SNAP())) {
      snapBackup = FileManager.readAsStringSync(SNAP())
      const parsed = JSON.parse(snapBackup || "{}")
      if (Array.isArray(parsed?.pickups)) seedList = parsed.pickups
    }
  } catch { }
  try {
    if (seedList.length > 0) Storage.set("cc.pickups", seedList)
  } catch { }

  const beforeMap = new Map<string, string>()
  for (const p of getPickups()) {
    if (p?.uuid) beforeMap.set(String(p.uuid), JSON.stringify(p))
  }

  const totalDeadline = now + Math.max(800, Number(budgetMs) || FULL_BUDGET_MS)
  const fresh: any[] = []
  const updatedByUuid = new Map<string, Partial<any>>()
  for (const target of overdue.slice(0, MAX_PLATFORMS_PER_WAKE)) {
    if (Date.now() >= totalDeadline) break
    if (target === "dewu" && totalDeadline - Date.now() < 11_000) continue
    const budget = Math.max(2_000, Math.min(PER_PLATFORM_MS, totalDeadline - Date.now()))
    let ran = false
    try {
      const report = await syncPlatformParcels(undefined, {
        only: [target], deadline: Date.now() + budget, silent: true, quietIssues: true, force: true,
      })
      ran = Array.isArray(report?.ran) && report.ran.includes(target)
    } catch { ran = false }
    if (ran) {
      delete fail[target]
    } else {
      const n = (fail[target]?.n ?? 0) + 1
      const backoff = n >= 3 ? 6 * 3_600_000 : Math.min(6 * 3_600_000, coolMs * n)
      fail[target] = { n, until: Date.now() + backoff }
    }
    if (ran) {
      for (const p of getPickups()) {
        if (!p || !p.uuid) continue
        const prevJson = beforeMap.get(String(p.uuid))
        if (prevJson === undefined) {
          if (!fresh.some(x => x.uuid === p.uuid)) fresh.push(p)
        } else if (JSON.stringify(p) !== prevJson) {
          const patch: any = { at: Date.now() }
          for (const k of SYNC_TRACK_FIELDS) {
            if ((p as any)[k] !== undefined) patch[k] = (p as any)[k]
          }
          updatedByUuid.set(String(p.uuid), patch)
        }
      }
    }
  }

  let changed = fresh.length > 0 || updatedByUuid.size > 0
  try {
    const latestRaw = FileManager.existsSync(SNAP()) ? FileManager.readAsStringSync(SNAP()) : snapBackup
    if (latestRaw) {
      let mergedRaw = mergeFreshIntoSnapshot(latestRaw, fresh)
      if (updatedByUuid.size > 0) {
        const parsed = JSON.parse(mergedRaw || "{}") || {}
        const list: any[] = Array.isArray(parsed.pickups) ? parsed.pickups : []
        parsed.pickups = list.map((p: any) => {
          const u = updatedByUuid.get(String(p?.uuid || ""))
          return u ? { ...p, ...u } : p
        })
        parsed.lastSync = Date.now()
        parsed.at = Date.now()
        mergedRaw = JSON.stringify(parsed)
      }
      writeJsonFile(SNAP(), JSON.parse(mergedRaw))
    }
  } catch { }
  if (fresh.length > 0) stashNewPackages(fresh)
  if (updatedByUuid.size > 0) {
    const ops: Record<string, any> = {}
    for (const [uuid, u] of updatedByUuid.entries()) ops[uuid] = u
    persistTrackOps(ops)
  }

  state.fullAt = Date.now()
  writeState(state)
  return changed
}

function mergeFreshIntoSnapshot(raw: string, fresh: any[]): string {
  if (fresh.length === 0) return raw
  try {
    const snap = JSON.parse(raw || "{}") || {}
    const list: any[] = Array.isArray(snap.pickups) ? snap.pickups : []
    const key = (p: any) => `${p?.source ?? ""}|${String(p?.orderId ?? "") || String(p?.mailNo ?? "")}`
    const mailKey = (p: any) => codeKey(String(p?.mailNo ?? ""))
    const have = new Set(list.map(key))
    const mails = new Set(list.map(mailKey).filter(Boolean))
    const uuids = new Set(list.map(p => String(p?.uuid ?? "")))
    const added = fresh.filter(p => p && !have.has(key(p)) && !(p.mailNo && mails.has(mailKey(p))) && !uuids.has(String(p.uuid ?? "")))
    if (added.length === 0) return raw
    snap.pickups = [...added, ...list]
    snap.lastSync = Date.now()
    snap.at = Date.now()
    return JSON.stringify(snap)
  } catch { return raw }
}

function mergeUpdatesIntoSnapshot(updates: Map<string, Partial<any>>): void {
  try {
    const latest = readJsonFile<any>(SNAP(), {})
    const base = Array.isArray(latest.pickups) ? latest.pickups : []
    const picked = new Set(Object.keys(readJsonFile<Record<string, number>>(`${DIR()}/picked.json`, {})))
    latest.pickups = base.map((p: any) => {
      const u = updates.get(String(p.mailNo || p.orderId || p.uuid || ""))
        ?? (p.mailNo ? updates.get(codeKey(String(p.mailNo))) : undefined)
      const merged = u ? { ...p, ...u } : p
      return picked.has(String(p.uuid)) ? { ...merged, status: 2, pickedByUser: true } : merged
    })
    latest.lastSync = Date.now()
    latest.at = Date.now()
    writeJsonFile(SNAP(), latest)
  } catch { }
}

async function runLightRefresh(state: TaskState, snap: any, budgetMs?: number): Promise<boolean> {
  const allPk: any[] = Array.isArray(snap.pickups) ? snap.pickups : []
  const active = allPk.filter((p: any) => (p.status ?? 1) < 2 && !p.pickedByUser)
  const targets = active
    .sort((a: any, b: any) => (a.trackUpdatedAt ?? a.createdAt ?? 0) - (b.trackUpdatedAt ?? b.createdAt ?? 0))
    .slice(0, 45)
  if (targets.length === 0) {
    state.lightAt = Date.now()
    writeState(state)
    return false
  }

  const deadline = Date.now() + Math.max(800, Number(budgetMs) || LIGHT_BUDGET_MS)
  const updates = await refreshMailNos(
    targets.map((p: any) => ({
      no: String(p.mailNo || ""),
      orderId: String(p.orderId || ""),
      source: String(p.source || ""),
      shipperCode: p.shipperCode || "",
      pkg: p,
    })),
    {
      deadline,
      onBatch: mergeUpdatesIntoSnapshot,
    },
  )

  // 顺带用菜鸟 MTOP（纯 HTTP，约 0.3s）补齐取件码并核销已出库包裹（SIGN -> 已取）
  if (hasLogin() && (snap?.settings?.showCainiao !== false) && platformEnabled("cainiao") && deadline - Date.now() > 1200) {
    try {
      const cnList = await cnFetchMyPackages({ recentDays: 15, maxPages: 2 })
      if (Array.isArray(cnList)) {
        const byMail = new Map<string, any>()
        for (const p of active) {
          if (p?.mailNo) byMail.set(codeKey(String(p.mailNo)), p)
        }
        for (const c of cnList) {
          if (!c.mailNo) continue
          const hit = byMail.get(codeKey(c.mailNo))
          if (!hit) continue
          const st = String(c.status || "").toUpperCase()
          if (!/SIGN/.test(st) && !c.done && !c.pickupCode) continue
          const latest = /SIGN/.test(st) ? "已取件（菜鸟已签收）"
            : /CANCEL|REJECT/.test(st) ? "已取消"
              : /RETURN/.test(st) ? "已退货"
                : /LOST/.test(st) ? "快递丢失"
                  : c.pickupCode ? "快件已到站，可取件"
                    : "运输中"
          const key = String(hit.mailNo || hit.orderId || hit.uuid || "")
          const prevU = updates.get(key) || {}
          const cnPatch = partialOfTrack(latest, prevU.trackNodes || hit.trackNodes || [], { ...hit, ...prevU }, {
            pickupCode: c.pickupCode || undefined,
            stationName: c.station || undefined,
            status: /CANCEL|REJECT|RETURN|LOST/.test(st) ? "cancelled" : c.done ? "delivered" : "transit",
            mailNo: c.mailNo,
            itemTitle: hit.itemTitle || c.title,
          })
          updates.set(key, { ...prevU, ...cnPatch })
        }
      }
    } catch { }
  }

  state.lightAt = Date.now()
  writeState(state)
  if (updates.size === 0) return false

  const arrivedFile = `${DIR()}/arrivedNotif.json`
  let notified: string[] = []
  try {
    if (FileManager.existsSync(arrivedFile)) notified = JSON.parse(FileManager.readAsStringSync(arrivedFile) || "[]") || []
  } catch { notified = [] }
  const seen = new Set(notified)
  const allowNotify = !(snap.settings && snap.settings.trackNotify === false)
  const ops: Record<string, any> = {}
  snap.pickups = allPk.map((p: any) => {
    const key = String(p.mailNo || p.orderId || p.uuid || "")
    const u = updates.get(key) ?? (p.mailNo ? updates.get(codeKey(String(p.mailNo))) : undefined)
    if (!u) return p
    if (allowNotify && u.arrivedAt && !p.arrivedAt && u.status !== 2 && p.uuid && !seen.has(String(p.mailNo || p.code || p.uuid))) {
      const nkey = String(p.mailNo || p.code || p.uuid)
      seen.add(nkey)
      try {
        Notification.schedule({
          title: "包裹到站",
          subtitle: p.itemTitle || "",
          body: (u.code || p.code) ? `取件码 ${u.code || p.code}` : "可以去取了",
          threadIdentifier: `cc-arrived:${p.uuid}`,
          userInfo: { uuid: p.uuid },
        })
      } catch { }
    }
    if (p.uuid) ops[String(p.uuid)] = { ...(ops[String(p.uuid)] || {}), ...u, at: Date.now() }
    return { ...p, ...u }
  })
  try {
    FileManager.createDirectorySync(DIR(), true)
    writeJsonFile(arrivedFile, Array.from(seen).slice(-120))
  } catch { }
  persistTrackOps(ops)
  snap.lastSync = Date.now()
  try { writeJsonFile(`${DIR()}/lastRefresh.json`, { at: Date.now() }) } catch { }
  mergeUpdatesIntoSnapshot(updates)
  return true
}

export async function runWidgetTasks(snap: any, opts: { rebuildMin: number; lightMin: number; fullMin: number; budgetMs?: number }): Promise<boolean> {
  const budget = Math.max(5_000, Number(opts.budgetMs) || 24_000)
  let timer: any = null
  try {
    return await Promise.race([
      runWidgetTasksInner(snap, opts),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), budget) }),
    ])
  } finally { if (timer != null) clearTimeout(timer) }
}

async function runWidgetTasksInner(snap: any, opts: { rebuildMin: number; lightMin: number; fullMin: number; budgetMs?: number }): Promise<boolean> {
  tickLive()
  const rebuild = Math.max(5, Math.min(180, Number(opts.rebuildMin) || 5))
  const lightMin = Math.max(rebuild * 2, Math.min(120, Number(opts.lightMin) || rebuild * 2))
  let fullMin = Math.max(rebuild * 3, Math.min(1440, Number(opts.fullMin) || rebuild * 3))
  if (fullMin <= lightMin) fullMin = lightMin * 2

  const now = Date.now()
  const token = `${now}-${Math.random().toString(36).slice(2)}`
  try {
    if (FileManager.existsSync(LOCK_FILE())) {
      const until = Number((FileManager.readAsStringSync(LOCK_FILE()) || "0").split("|")[0]) || 0
      if (now < until) return false
    }
    if (!FileManager.existsSync(DIR())) FileManager.createDirectorySync(DIR(), true)
    FileManager.writeAsStringSync(LOCK_FILE(), `${now + LOCK_MS}|${token}`)
  } catch { return false }

  const state = readState()
  const lastLight = Math.max(Number(state.lightAt ?? 0), sharedLastRefreshAt())
  const lightOverdue = (now - lastLight) / (lightMin * 60_000)
  const fullOverdue = (now - Number(state.fullAt ?? 0)) / (fullMin * 60_000)
  const anyPlatformOverdue = fullCandidates().some(
    id => now - lastTouchedAt(id) >= fullMin * 60_000)
  const lightDue = lightOverdue >= 1
  const fullDue = fullOverdue >= 1 || anyPlatformOverdue
  const release = () => {
    try {
      const current = FileManager.existsSync(LOCK_FILE()) ? FileManager.readAsStringSync(LOCK_FILE()) : ""
      if (current.endsWith(`|${token}`)) FileManager.removeSync(LOCK_FILE())
    } catch { }
  }

  let changed = false
  try {
    if (fullDue && (!lightDue || fullOverdue >= lightOverdue)) {
      changed = await runPlatformSync(state, fullMin, snap, opts.budgetMs)
      // 若全量轮转只跑了菜鸟/丰巢等快平台，且数据刷新也已到期、剩余预算还充足，顺手把已有包裹物流也刷一遍
      const elapsed = Date.now() - now
      if (lightDue && elapsed < 10_000) {
        const lightChanged = await runLightRefresh(state, snap, Math.max(4_000, 18_000 - elapsed))
        if (lightChanged) changed = true
      }
    } else if (lightDue) {
      changed = await runLightRefresh(state, snap, opts.budgetMs)
    }
  } catch {
  } finally {
    release()
  }
  return changed
}
