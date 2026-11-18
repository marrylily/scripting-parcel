/**
 * 小组件后台任务调度（v31 修复版：解决后台不刷新物流进度 & 平台空转饿死问题）
 *
 * 一次组件重建 = 一个时间片，只做一件联网的事，避免并发抢网络/风控：
 *   1. 每次都给：检查灵动岛是否到期（不联网，纯本地）
 *   2. 优先保障「数据刷新」：若已有单号物流刷新到点 → 优先刷新已有单号的物流（+ 到站通知）
 *   3. 否则若「全量轮转」到点 → 跑一个平台的全量找新单（自动跳过需 WebView 的平台并冷却）
 *
 * 三个节拍各自记在共享目录 cc/widgetTasks.json 里，进程被杀也不丢。
 */
import { Notification } from "scripting"
import { expirePickupActivityIfDue } from "./liveExpire"
import { refreshMailNos } from "./widgetRefresh"
import { syncPlatformParcels, platformLastSyncedAt } from "./platformSync"
import { getPickups, getSettings } from "../store"
import { hasLogin } from "./net"
import { jdHasLogin } from "./jd"
import { pddHasLogin } from "./pdd"
import { fcHasLogin } from "./fengchao"
import { miHasLogin } from "./mi"
import { readJsonFile, writeJsonFile, appendOperation } from "./sharedJson"

const DIR = () => `${FileManager.appGroupDocumentsDirectory}/cc`
const STATE_FILE = () => `${DIR()}/widgetTasks.json`
const LOCK_FILE = () => `${DIR()}/widgetTasks.lock`
const NEW_PKGS = () => `${DIR()}/newPackages.json`
const SNAP = () => `${DIR()}/widget.json`

const LOCK_MS = 45_000
const LIGHT_BUDGET_MS = 8000
const FULL_BUDGET_MS = 12_000
const PER_PLATFORM_MS = 8_000
const MAX_PLATFORMS_PER_WAKE = 2

type FailEntry = { n: number; until: number }

type TaskState = {
  lightAt?: number
  fullAt?: number
  fail?: Record<string, FailEntry>
  skipUntil?: Record<string, number>
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
  if (miHasLogin()) out.push("mi")
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

function getOverduePlatforms(state: TaskState, rotateMin: number, now: number): string[] {
  const cand = fullCandidates()
  if (cand.length === 0) return []
  const fail = state.fail ?? {}
  const skipUntil = state.skipUntil ?? {}
  const intervalMs = Math.max(10, rotateMin) * 60_000
  return cand
    .filter(id => now >= (fail[id]?.until ?? 0))
    .filter(id => now >= (skipUntil[id] ?? 0))
    .filter(id => now - lastTouchedAt(id) >= intervalMs)
    .sort((a, b) => lastTouchedAt(a) - lastTouchedAt(b))
}

async function runPlatformSync(state: TaskState, rotateMin: number, snap: any, budgetMs?: number): Promise<void> {
  const now = Date.now()
  const fail = (state.fail ??= {})
  const skipUntil = (state.skipUntil ??= {})
  const coolMs = Math.max(5, Number(getSettings().failCoolMin) || 30) * 60_000
  const overdue = getOverduePlatforms(state, rotateMin, now)
  if (overdue.length === 0) {
    state.fullAt = now
    writeState(state)
    return
  }

  const before = new Set(getPickups().map(p => p.uuid))
  let snapBackup = ""
  try { if (FileManager.existsSync(SNAP())) snapBackup = FileManager.readAsStringSync(SNAP()) } catch { }

  const totalDeadline = now + Math.max(2000, Number(budgetMs) || FULL_BUDGET_MS)
  const fresh: any[] = []
  for (const target of overdue.slice(0, MAX_PLATFORMS_PER_WAKE)) {
    if (Date.now() >= totalDeadline) break
    const budget = Math.max(2_000, Math.min(PER_PLATFORM_MS, totalDeadline - Date.now()))
    let ran = false
    try {
      const report = await syncPlatformParcels(undefined, {
        only: [target], deadline: Date.now() + budget, silent: true, quietIssues: true, force: true,
      })
      const outcome = report?.results?.[target]?.outcome
      ran = Array.isArray(report?.ran) && report.ran.includes(target)
      if (outcome === "ok") {
        delete fail[target]
        delete skipUntil[target]
      } else if (outcome === "skipped" || report?.busy) {
        delete fail[target]
        skipUntil[target] = Date.now() + 60 * 60_000
        ran = false
      } else {
        ran = false
        const n = (fail[target]?.n ?? 0) + 1
        const backoff = n >= 3 ? 6 * 3_600_000 : Math.min(6 * 3_600_000, coolMs * n)
        fail[target] = { n, until: Date.now() + backoff }
      }
    } catch {
      ran = false
      const n = (fail[target]?.n ?? 0) + 1
      const backoff = n >= 3 ? 6 * 3_600_000 : Math.min(6 * 3_600_000, coolMs * n)
      fail[target] = { n, until: Date.now() + backoff }
    }
    if (ran) {
      for (const p of getPickups()) {
        if (!p || before.has(p.uuid)) continue
        if (!fresh.some(x => x.uuid === p.uuid)) fresh.push(p)
      }
    }
  }

  try {
    const latestRaw = FileManager.existsSync(SNAP()) ? FileManager.readAsStringSync(SNAP()) : snapBackup
    if (latestRaw) {
      const mergedObj = JSON.parse(mergeFreshIntoSnapshot(latestRaw, fresh))
      writeJsonFile(SNAP(), mergedObj)
      if (snap && Array.isArray(mergedObj.pickups)) {
        snap.pickups = mergedObj.pickups
        snap.at = mergedObj.at
      }
    }
  } catch { }
  if (fresh.length > 0) stashNewPackages(fresh)

  state.fullAt = Date.now()
  writeState(state)
}

function mergeFreshIntoSnapshot(raw: string, fresh: any[]): string {
  if (fresh.length === 0) return raw
  try {
    const snap = JSON.parse(raw || "{}") || {}
    const list: any[] = Array.isArray(snap.pickups) ? snap.pickups : []
    const key = (p: any) => `${p?.source ?? ""}|${String(p?.orderId ?? "") || String(p?.mailNo ?? "")}`
    const have = new Set(list.map(key))
    const uuids = new Set(list.map(p => String(p?.uuid ?? "")))
    const added = fresh.filter(p => p && !have.has(key(p)) && !uuids.has(String(p.uuid ?? "")))
    if (added.length === 0) return raw
    snap.pickups = [...added, ...list]
    snap.at = Date.now()
    return JSON.stringify(snap)
  } catch { return raw }
}

async function runLightRefresh(state: TaskState, snap: any, budgetMs?: number): Promise<void> {
  const diskSnap = readJsonFile<any>(SNAP(), {})
  const allPk: any[] = Array.isArray(snap?.pickups) && snap.pickups.length > 0
    ? snap.pickups
    : (Array.isArray(diskSnap.pickups) ? diskSnap.pickups : [])

  const active = allPk.filter((p: any) => (p.status ?? 1) < 2 && !p.pickedByUser)
  const targets = active
    .sort((a: any, b: any) => (a.trackUpdatedAt ?? a.createdAt ?? 0) - (b.trackUpdatedAt ?? b.createdAt ?? 0))
    .slice(0, 45)

  state.lightAt = Date.now()
  writeState(state)
  if (targets.length === 0) return

  const updates = await refreshMailNos(
    targets.map((p: any) => ({
      no: String(p.mailNo || ""),
      orderId: String(p.uuid || ""),
      source: String(p.source || ""),
      shipperCode: p.shipperCode || "",
      pkg: p,
    })),
    { deadline: Date.now() + Math.max(2000, Number(budgetMs) || LIGHT_BUDGET_MS) },
  )

  const now = Date.now()
  state.lightAt = now
  writeState(state)
  try { writeJsonFile(`${DIR()}/lastRefresh.json`, { at: now }) } catch { }
  if (updates.size === 0) return

  const arrivedFile = `${DIR()}/arrivedNotif.json`
  let notified: string[] = []
  try {
    if (FileManager.existsSync(arrivedFile)) notified = JSON.parse(FileManager.readAsStringSync(arrivedFile) || "[]") || []
  } catch { notified = [] }
  const seen = new Set(notified)
  const allowNotify = !(snap?.settings && snap.settings.trackNotify === false)
  const ops: Record<string, any> = {}

  const updatedPk = allPk.map((p: any) => {
    const key = String(p.mailNo || p.uuid || "")
    const u = updates.get(key)
    if (!u) return p
    if (allowNotify && u.arrivedAt && !p.arrivedAt && p.uuid && !seen.has(String(p.mailNo || p.code || p.uuid))) {
      const nkey = String(p.mailNo || p.code || p.uuid)
      seen.add(nkey)
      try {
        Notification.schedule({
          title: "包裹到站",
          subtitle: p.itemTitle || "",
          body: p.code ? `取件码 ${p.code}` : "可以去取了",
          threadIdentifier: `cc-arrived:${p.uuid}`,
          userInfo: { uuid: p.uuid },
        })
      } catch { }
    }
    if (p.uuid) ops[String(p.uuid)] = { ...(ops[String(p.uuid)] || {}), ...u, at: now }
    return { ...p, ...u }
  })

  if (snap) {
    snap.pickups = updatedPk
    snap.lastSync = now
    snap.at = now
  }

  try {
    FileManager.createDirectorySync(DIR(), true)
    writeJsonFile(arrivedFile, Array.from(seen).slice(-120))
  } catch { }
  try {
    const f = `${DIR()}/trackUpdates.json`
    const prev = FileManager.existsSync(f) ? JSON.parse(FileManager.readAsStringSync(f) || "{}") || {} : {}
    const cutoff = now - 7 * 86_400_000
    const merged: Record<string, any> = { ...prev }
    for (const k of Object.keys(merged)) if (Number(merged[k]?.at ?? 0) < cutoff) delete merged[k]
    writeJsonFile(f, { ...merged, ...ops })
    for (const [uuid, update] of Object.entries(ops)) {
      try { appendOperation(`${DIR()}/ops/track`, { uuid, update }) } catch { }
    }
  } catch { }

  try {
    const latest = readJsonFile<any>(SNAP(), {})
    const base = Array.isArray(latest.pickups) && latest.pickups.length > 0 ? latest.pickups : updatedPk
    const changes = new Map(
      allPk
        .filter((p: any) => updates.has(String(p.mailNo || p.uuid || "")))
        .map((p: any) => [String(p.uuid), updates.get(String(p.mailNo || p.uuid || ""))])
    )
    const pickedObj = readJsonFile<any>(`${DIR()}/picked.json`, {})
    const picked = new Set(Object.keys(pickedObj || {}))
    latest.pickups = base.map((p: any) => {
      const u = changes.get(String(p.uuid))
      const merged = u ? { ...p, ...u } : p
      return picked.has(String(p.uuid)) ? { ...merged, status: 2, pickedByUser: true } : merged
    })
    latest.lastSync = now
    latest.at = now
    writeJsonFile(SNAP(), latest)
    if (snap) snap.pickups = latest.pickups
  } catch { }
}

export async function runWidgetTasks(snap: any, opts: { rebuildMin: number; lightMin: number; fullMin: number; budgetMs?: number }): Promise<void> {
  const budget = Math.max(2000, Number(opts.budgetMs) || LIGHT_BUDGET_MS)
  await runWidgetTasksInner(snap, { ...opts, budgetMs: budget })
}

async function runWidgetTasksInner(snap: any, opts: { rebuildMin: number; lightMin: number; fullMin: number; budgetMs?: number }): Promise<void> {
  tickLive()
  const rebuild = Math.max(5, Math.min(180, Number(opts.rebuildMin) || 5))
  const lightMin = Math.max(5, Math.min(120, Number(opts.lightMin) || rebuild))
  let fullMin = Math.max(rebuild * 2, Math.min(240, Number(opts.fullMin) || rebuild * 3))
  if (fullMin <= lightMin) fullMin = lightMin * 2

  const now = Date.now()
  const token = `${now}-${Math.random().toString(36).slice(2)}`
  try {
    if (FileManager.existsSync(LOCK_FILE())) {
      const until = Number((FileManager.readAsStringSync(LOCK_FILE()) || "0").split("|")[0]) || 0
      if (now < until) return
    }
    if (!FileManager.existsSync(DIR())) FileManager.createDirectorySync(DIR(), true)
    FileManager.writeAsStringSync(LOCK_FILE(), `${now + LOCK_MS}|${token}`)
  } catch { return }

  const state = readState()
  const lastLight = Math.max(Number(state.lightAt ?? 0), sharedLastRefreshAt())
  const lightOverdue = (now - lastLight) / (lightMin * 60_000)
  const fullOverdue = (now - Number(state.fullAt ?? 0)) / (fullMin * 60_000)

  const overduePlatforms = getOverduePlatforms(state, fullMin, now)
  const lightDue = lightOverdue >= 1
  const fullDue = (fullOverdue >= 1 || overduePlatforms.length > 0) && overduePlatforms.length > 0

  const release = () => {
    try {
      const current = FileManager.existsSync(LOCK_FILE()) ? FileManager.readAsStringSync(LOCK_FILE()) : ""
      if (current.endsWith(`|${token}`)) FileManager.removeSync(LOCK_FILE())
    } catch { }
  }

  try {
    if (lightDue) {
      await runLightRefresh(state, snap, opts.budgetMs)
    } else if (fullDue) {
      await runPlatformSync(state, fullMin, snap, opts.budgetMs)
    }
  } catch {
  } finally {
    release()
  }
}
