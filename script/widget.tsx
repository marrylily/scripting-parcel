import { Button, HStack, Image, Link, Script, Spacer, Text, VStack, Widget } from "scripting"
import { WIDGET_VERSION } from "./widgetVersion"
import { runWidgetTasks, tickLive } from "./utils/widgetTasks"
import { isAwaitingPickup, isTransitPkg } from "./utils/model"
import { WidgetBody, TXT_C, SUB_C } from "./ui/widgetLayout"
import type { CardSize } from "./ui/parcelCard"
import { jdHasLogin } from "./utils/jd"
import { hasLogin } from "./utils/net"
import { pddHasLogin } from "./utils/pdd"
import { operationFiles, readJsonFile } from "./utils/sharedJson"

// 模块加载完成即落一条引导日志；没有 perf 新行时用它区分“没唤醒”和“初始化失败”。
try {
  const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
  if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
  FileManager.writeAsStringSync(`${dir}/widgetBoot.txt`, `${Date.now()}|${WIDGET_VERSION}`)
} catch { }

/** 组件下一次重建的间隔：直接用设置里的「重建」值（与设置页同一个下限 5 分钟） */
function widgetReloadMs(snap?: any): number {
  try {
    const s: any = (snap && snap.settings) || Storage.get<any>("cc.settings") || {}
    const m = Number(s.refreshWidgetMin)
    return Math.max(5, Number.isFinite(m) && m > 0 ? m : 10) * 60_000
  } catch { return 10 * 60_000 }
}

/** 把共享目录里的 trackUpdates / newPackages / picked 叠加进内存 snap，确保桌面永远渲染最新状态 */
function mergeSharedOverlays(snap: any): void {
  if (!snap || typeof snap !== "object") return
  const ccDir = `${FileManager.appGroupDocumentsDirectory}/cc`
  if (!Array.isArray(snap.pickups)) snap.pickups = []

  // 1. 合并后台发现的新包裹 (newPackages.json)
  try {
    const npFile = `${ccDir}/newPackages.json`
    if (FileManager.existsSync(npFile)) {
      const freshList: any[] = JSON.parse(FileManager.readAsStringSync(npFile) || "[]") || []
      if (freshList.length > 0) {
        const key = (p: any) => `${p?.source ?? ""}|${String(p?.orderId ?? "") || String(p?.mailNo ?? "")}`
        const have = new Set(snap.pickups.map(key))
        const uuids = new Set(snap.pickups.map((p: any) => String(p?.uuid ?? "")))
        const added = freshList.filter(p => p && !have.has(key(p)) && !uuids.has(String(p.uuid ?? "")))
        if (added.length > 0) snap.pickups = [...added, ...snap.pickups]
      }
    }
  } catch { }

  // 2. 合并后台刷到的最新物流轨迹 (trackUpdates.json)
  try {
    const tuFile = `${ccDir}/trackUpdates.json`
    if (FileManager.existsSync(tuFile)) {
      const updates: Record<string, any> = JSON.parse(FileManager.readAsStringSync(tuFile) || "{}") || {}
      if (Object.keys(updates).length > 0) {
        snap.pickups = snap.pickups.map((p: any) => {
          const u = p?.uuid ? updates[String(p.uuid)] : undefined
          if (!u) return p
          // 仅当增量更新比快照里的新时才覆盖
          if ((u.trackUpdatedAt ?? u.at ?? 0) >= (p.trackUpdatedAt ?? 0)) {
            return { ...p, ...u }
          }
          return p
        })
      }
    }
  } catch { }

  // 3. 合并已取件状态 (picked.json & ops/picked)
  try {
    const pf = `${ccDir}/picked.json`
    if (FileManager.existsSync(pf)) {
      const ops = JSON.parse(FileManager.readAsStringSync(pf) || "{}") || {}
      const ids = Object.keys(ops)
      if (ids.length > 0) {
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
      if (!op.uuid) continue
      snap.pickups = snap.pickups.map((p: any) => p?.uuid === op.uuid ? { ...p, status: 2, pickedByUser: true } : p)
    }
  } catch { }
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
  if (!Array.isArray(snap.pickups)) { try { snap.pickups = Storage.get<any[]>("cc.pickups") ?? [] } catch { } }
  if (!snap.settings || typeof snap.settings !== "object") { try { snap.settings = Storage.get<any>("cc.settings") ?? {} } catch { } }

  // 先叠一次增量与已取状态
  mergeSharedOverlays(snap)

  // quietUntil：刚刚在组件上点过圈，本地已改数据，这次重建只出图，不跑联网。
  const quiet = Number((snap as any).quietUntil || 0) > Date.now()

  // 新构建后的「第一帧」不联网，先把图打出来防灰屏；后续每次后台唤醒先联网刷新再 present！
  let firstOfBuild = false
  try {
    const vf = `${ccDir}/widgetBuiltVersion.txt`
    const seen = FileManager.existsSync(vf) ? (FileManager.readAsStringSync(vf) || "").trim() : ""
    firstOfBuild = seen !== WIDGET_VERSION
    if (firstOfBuild) FileManager.writeAsStringSync(vf, WIDGET_VERSION)
  } catch { }

  // 核心修复：必须在 Widget.present 之前执行 await backgroundSync(snap)！
  // 这样刷出来的最新物流才能直接渲染到本次组件视图上，且不会被系统提前挂起回收。
  if (!quiet && !firstOfBuild) {
    const tSync = Date.now()
    try {
      await backgroundSync(snap)
      // 同步完成后重新从磁盘读取最新快照并叠加增量，确保内存 snap 100% 是最新数据
      if (FileManager.existsSync(snapFile)) {
        const freshSnap = JSON.parse(FileManager.readAsStringSync(snapFile) || "{}")
        if (Array.isArray(freshSnap.pickups) && freshSnap.pickups.length > 0) {
          snap = freshSnap
        }
      }
      mergeSharedOverlays(snap)
    } catch { }
    try {
      const pf = `${ccDir}/perf.log`
      const prev = FileManager.existsSync(pf) ? FileManager.readAsStringSync(pf) : ""
      const line = `${new Date().toISOString()} bg=${Date.now() - tSync}ms n=${(snap.pickups || []).length}\n`
      FileManager.writeAsStringSync(pf, (line + prev).split("\n").slice(0, 40).join("\n"))
    } catch { }
  } else {
    try { tickLive() } catch { }
  }

  try { Storage.set("cc.widget.render", `${Date.now()}|n=${(snap.pickups || []).length}|v=31`, { shared: true }) } catch { }

  const present = (view: any) => Widget.present(view, {
    reloadPolicy: { policy: "after", date: new Date(Date.now() + widgetReloadMs(snap)) },
  })

  try {
    present(<WidgetView snapshot={snap as any} />)
  } catch {
    present(<VStack widgetURL={Script.createRunURLScheme(Script.name)} padding={14} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <Text font={14} fontWeight="semibold" foregroundStyle={TXT_C}>包裹助手</Text>
      <Spacer />
      <Text font={11} foregroundStyle={SUB_C}>打开 App 查看包裹</Text>
    </VStack>)
  }

  try {
    const pf = `${ccDir}/widgetPresent.log`
    FileManager.writeAsStringSync(pf, `${new Date().toISOString()} ${WIDGET_VERSION} presented total=${Date.now() - T0}ms\n`)
  } catch { }

  try { Script.exit() } catch { }
}

/** 出图前的联网任务：一个时间片只做一件联网的事（优先已有单物流刷新，其次全量轮转），外加灵动岛到期检查 */
async function backgroundSync(snap: any) {
  const s: any = (snap && snap.settings) || {}
  if (s.bgRefresh === false) { try { tickLive() } catch { } return }
  await runWidgetTasks(snap, {
    rebuildMin: Number(s.refreshWidgetMin ?? 5),
    lightMin: Number(s.refreshExistingMin ?? 10),
    fullMin: Number(s.fullRotateMin ?? 15),
    // 给足 6.5 秒预算（原 3 秒太短极易超时中断，6.5 秒足够跑完轻量刷新且远低于 iOS 15 秒强杀线）
    budgetMs: 6500,
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
