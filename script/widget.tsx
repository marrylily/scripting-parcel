import { Button, HStack, Image, Link, Script, Spacer, Text, VStack, Widget } from "scripting"
import { WIDGET_VERSION } from "./widgetVersion"
import { runWidgetTasks, tickLive } from "./utils/widgetTasks"
import { isAwaitingPickup, isTransitPkg } from "./utils/model"
import { WidgetBody, TXT_C, SUB_C } from "./ui/widgetLayout"
import type { CardSize } from "./ui/parcelCard"
import { jdHasLogin } from "./utils/jd"
import { hasLogin } from "./utils/net"
import { pddHasLogin } from "./utils/pdd"
import { operationFiles, readJsonFile, writeJsonFile } from "./utils/sharedJson"
import { codeKey } from "./utils/codes"

// 模块加载完成即落一条引导日志；没有 perf 新行时用它区分“没唤醒”和“初始化失败”。
try {
  const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
  if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
  FileManager.writeAsStringSync(`${dir}/widgetBoot.txt`, `${Date.now()}|${WIDGET_VERSION}`)
} catch { }

function widgetReloadMs(snap?: any): number {
  try {
    const s: any = (snap && snap.settings) || Storage.get<any>("cc.settings") || {}
    const m = Number(s.refreshWidgetMin)
    return Math.max(5, Number.isFinite(m) && m > 0 ? m : 10) * 60_000
  } catch { return 10 * 60_000 }
}

function WidgetView({ snapshot }: { snapshot: any }) {
  const all: any[] = Array.isArray(snapshot.pickups) ? snapshot.pickups : []
  const st: any = snapshot.settings || {}
  const active = all.filter(p => (p.status ?? 1) < 2 && !p.pickedByUser && !p.closed)
  const sortBy = (l: any[]) => [...l].sort((a, b) => (b.trackUpdatedAt ?? b.createdAt ?? 0) - (a.trackUpdatedAt ?? a.createdAt ?? 0))
  const pending = sortBy(active.filter(p => isAwaitingPickup(p)))
  const transit = (st.widgetShowTransit === false ? [] : sortBy(active.filter(p => isTransitPkg(p))))

  const avatarEmoji: string = st.avatarMode === "emoji" ? String(st.avatarEmoji || "") : ""
  const avatarFile = st.avatarMode === "photo" ? `${FileManager.appGroupDocumentsDirectory}/cc/avatar.png` : ""

  const family = Widget.family
  const size: CardSize = family === "systemLarge" || family === "systemExtraLarge" || family === "systemExtraLargePortrait" ? "large" : family === "systemMedium" ? "medium" : "small"
  const lastSync = (snapshot as any).syncedAt || (snapshot as any).lastSync || 0

  return <WidgetBody
    pending={pending}
    transit={transit}
    lastSync={lastSync}
    avatarEmoji={avatarEmoji}
    avatarFile={avatarFile}
    size={size}
  />
}

const OVERLAY_TRACK_KEYS = [
  "trackLatest", "trackNodes", "trackUpdatedAt", "code", "codes",
  "arrivedAt", "mailNo", "itemTitle", "status", "pickedAt",
  "courierStationName", "courierStationUuid", "address", "fcBox", "closed",
] as const

async function run() {
  const T0 = Date.now()
  const ccDir = `${FileManager.appGroupDocumentsDirectory}/cc`
  const snapFile = `${ccDir}/widget.json`
  let snap: any = {}
  try {
    if (FileManager.existsSync(snapFile)) {
      snap = JSON.parse(FileManager.readAsStringSync(snapFile) || "{}")
    }
  } catch { }
  if (!Array.isArray(snap.pickups)) { try { snap.pickups = Storage.get<any[]>("cc.pickups") ?? [] } catch { snap.pickups = [] } }
  if (!snap.settings || typeof snap.settings !== "object") { try { snap.settings = Storage.get<any>("cc.settings") ?? {} } catch { snap.settings = {} } }

  // 叠加小组件后台发现但尚未被 App 消费的新包裹（cc/newPackages.json）
  try {
    const nf = `${ccDir}/newPackages.json`
    if (FileManager.existsSync(nf)) {
      const freshArr = JSON.parse(FileManager.readAsStringSync(nf) || "[]")
      if (Array.isArray(freshArr) && freshArr.length > 0 && Array.isArray(snap.pickups)) {
        const keyOf = (p: any) => `${p?.source ?? ""}|${String(p?.orderId ?? "") || String(p?.mailNo ?? "")}`
        const mailKey = (p: any) => codeKey(String(p?.mailNo ?? ""))
        const have = new Set(snap.pickups.map(keyOf))
        const mails = new Set(snap.pickups.map(mailKey).filter(Boolean))
        const uuids = new Set(snap.pickups.map((p: any) => String(p?.uuid ?? "")))
        const added = freshArr.filter((p: any) => p && !have.has(keyOf(p)) && !(p.mailNo && mails.has(mailKey(p))) && !uuids.has(String(p.uuid ?? "")))
        if (added.length > 0) snap.pickups = [...added, ...snap.pickups]
      }
    }
  } catch { }

  // 叠加小组件后台刷新的物流与状态（cc/trackUpdates.json），防止快照没跟上
  try {
    const tf = `${ccDir}/trackUpdates.json`
    if (FileManager.existsSync(tf)) {
      const trackMap = JSON.parse(FileManager.readAsStringSync(tf) || "{}") || {}
      if (Array.isArray(snap.pickups) && Object.keys(trackMap).length > 0) {
        snap.pickups = snap.pickups.map((p: any) => {
          const u = trackMap[p?.uuid]
          if (!u) return p
          const at = Number(u.trackUpdatedAt || u.at || 0)
          if (at > 0 && (p.trackUpdatedAt ?? 0) > at) return p
          const patch: any = {}
          for (const k of OVERLAY_TRACK_KEYS) if (u[k] !== undefined) patch[k] = u[k]
          return { ...p, ...patch }
        })
      }
    }
  } catch { }

  // 叠加「已取」操作文件（cc/picked.json 与 cc/ops/picked）
  try {
    const pf = `${ccDir}/picked.json`
    if (FileManager.existsSync(pf)) {
      const ops = JSON.parse(FileManager.readAsStringSync(pf) || "{}") || {}
      const ids = Object.keys(ops)
      if (ids.length > 0 && Array.isArray(snap.pickups)) {
        const set = new Set(ids)
        snap.pickups = snap.pickups.map((p: any) =>
          p && set.has(p.uuid) ? { ...p, status: 2, pickedByUser: true } : p)
      }
    }
  } catch { }
  try {
    const dir = `${ccDir}/ops/picked`
    for (const file of operationFiles(dir)) {
      const op = readJsonFile<{ uuid?: string }>(file, {})
      if (!op.uuid || !Array.isArray(snap.pickups)) continue
      snap.pickups = snap.pickups.map((p: any) => p?.uuid === op.uuid ? { ...p, status: 2, pickedByUser: true } : p)
    }
  } catch { }

  const quiet = Number((snap as any).quietUntil || 0) > Date.now()
  try { Storage.set("cc.widget.render", `${Date.now()}|n=${(snap.pickups || []).length}|v=31`, { shared: true }) } catch { }
  try {
    const pf = `${ccDir}/perf.log`
    const prev = FileManager.existsSync(pf) ? FileManager.readAsStringSync(pf) : ""
    const line = `${new Date().toISOString()} ${Date.now() - T0}ms quiet=${quiet ? 1 : 0} n=${(snap.pickups || []).length}\n`
    FileManager.writeAsStringSync(pf, (line + prev).split("\n").slice(0, 40).join("\n"))
  } catch { }

  try {
    const pf = `${ccDir}/perf.log`
    const prev = FileManager.existsSync(pf) ? FileManager.readAsStringSync(pf) : ""
    const line = `${new Date().toISOString()} auth taobao=${hasLogin()} jd=${jdHasLogin()} pdd=${pddHasLogin()}\n`
    FileManager.writeAsStringSync(pf, (line + prev).split("\n").slice(0, 40).join("\n"))
  } catch { }

  let firstOfBuild = false
  try {
    const vf = `${ccDir}/widgetBuiltVersion.txt`
    const seen = FileManager.existsSync(vf) ? (FileManager.readAsStringSync(vf) || "").trim() : ""
    firstOfBuild = seen !== WIDGET_VERSION
    if (firstOfBuild) FileManager.writeAsStringSync(vf, WIDGET_VERSION)
  } catch { }

  const present = (view: any) => Widget.present(view, {
    reloadPolicy: { policy: "after", date: new Date(Date.now() + widgetReloadMs(snap)) },
  })
  try { present(<WidgetView snapshot={snap as any} />) }
  catch {
    present(<VStack widgetURL={Script.createRunURLScheme(Script.name)} padding={14} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <Text font={14} fontWeight="semibold" foregroundStyle={TXT_C}>包裹助手</Text>
      <Spacer />
      <Text font={11} foregroundStyle={SUB_C}>打开 App 查看包裹</Text>
    </VStack>)
  }

  try {
    const pf = `${ccDir}/widgetPresent.log`
    FileManager.writeAsStringSync(pf, `${new Date().toISOString()} ${WIDGET_VERSION} presented\n`)
  } catch { }

  // 首帧已提交，接着跑后台同步；若本轮确实拉到了新包裹或新物流状态（changed===true），
  // 写入 25 秒 quietUntil 后调用一次 Widget.reloadAll()，让桌面立刻刷新出最新包裹信息且不产生循环重载！
  if (!quiet && !firstOfBuild) {
    const tSync = Date.now()
    let changed = false
    try { changed = await backgroundSync(snap) } catch { }
    if (changed) {
      try {
        const latest = readJsonFile<any>(snapFile, null)
        if (latest && typeof latest === "object") {
          latest.quietUntil = Date.now() + 25_000
          writeJsonFile(snapFile, latest)
        }
        Widget.reloadAll()
      } catch { }
    }
    try {
      const pf = `${ccDir}/perf.log`
      const prev = FileManager.existsSync(pf) ? FileManager.readAsStringSync(pf) : ""
      const line = `${new Date().toISOString()} bg ${Date.now() - tSync}ms changed=${changed ? 1 : 0}\n`
      FileManager.writeAsStringSync(pf, (line + prev).split("\n").slice(0, 40).join("\n"))
    } catch { }
  }
  try { Script.exit() } catch { }
}

async function backgroundSync(snap: any): Promise<boolean> {
  const s: any = (snap && snap.settings) || {}
  if (s.bgRefresh === false) { try { tickLive() } catch { } return false }
  const logf = (line: string) => {
    try {
      const pf = `${FileManager.appGroupDocumentsDirectory}/cc/perf.log`
      const prev = FileManager.existsSync(pf) ? FileManager.readAsStringSync(pf) : ""
      FileManager.writeAsStringSync(pf, (line + "\n" + prev).split("\n").slice(0, 40).join("\n"))
    } catch { }
  }
  logf(`${new Date().toISOString()} bgStart`)
  return await runWidgetTasks(snap, {
    rebuildMin: Number(s.refreshWidgetMin ?? 5),
    lightMin: Number(s.refreshExistingMin ?? 10),
    fullMin: Math.max(15, Number(s.fullRotateMin ?? 30)),
  })
}

run().catch(() => {
  try {
    Widget.present(<VStack widgetURL={Script.createRunURLScheme(Script.name)} padding={14}>
      <Text font={13} foregroundStyle={TXT_C}>包裹助手</Text>
      <Text font={10} foregroundStyle={SUB_C}>打开 App 查看包裹</Text>
    </VStack>, { reloadPolicy: { policy: "after", date: new Date(Date.now() + widgetReloadMs()) } })
  } catch { }
  try { Script.exit() } catch { }
})
