import { Button, HStack, Image, Link, Script, Spacer, Text, VStack, Widget } from "scripting"
import { WIDGET_VERSION } from "./widgetVersion"
import { runWidgetTasks, tickLive } from "./utils/widgetTasks"
import { isAwaitingPickup, isTransitPkg } from "./utils/model"
import { WidgetBody, TXT_C, SUB_C } from "./ui/widgetLayout"
import type { CardSize } from "./ui/parcelCard"
import { operationFiles, readJsonFile } from "./utils/sharedJson"

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

function mergeSharedOverlays(snap: any): void {
  if (!snap || typeof snap !== "object") return
  const ccDir = `${FileManager.appGroupDocumentsDirectory}/cc`
  if (!Array.isArray(snap.pickups)) snap.pickups = []

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

  try {
    const tuFile = `${ccDir}/trackUpdates.json`
    if (FileManager.existsSync(tuFile)) {
      const updates: Record<string, any> = JSON.parse(FileManager.readAsStringSync(tuFile) || "{}") || {}
      if (Object.keys(updates).length > 0) {
        snap.pickups = snap.pickups.map((p: any) => {
          const u = p?.uuid ? updates[String(p.uuid)] : undefined
          if (!u) return p
          if ((u.trackUpdatedAt ?? u.at ?? 0) >= (p.trackUpdatedAt ?? 0)) {
            return { ...p, ...u }
          }
          return p
        })
      }
    }
  } catch { }

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
      const op = readJsonFile<any>(file, {})
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
  if (!Array.isArray(snap.pickups)) { try { snap.pickups = Storage.get<any>("cc.pickups") ?? [] } catch { } }
  if (!snap.settings || typeof snap.settings !== "object") { try { snap.settings = Storage.get<any>("cc.settings") ?? {} } catch { } }

  mergeSharedOverlays(snap)

  const quiet = Number((snap as any).quietUntil || 0) > Date.now()

  let firstOfBuild = false
  try {
    const vf = `${ccDir}/widgetBuiltVersion.txt`
    const seen = FileManager.existsSync(vf) ? (FileManager.readAsStringSync(vf) || "").trim() : ""
    firstOfBuild = seen !== WIDGET_VERSION
    if (firstOfBuild) FileManager.writeAsStringSync(vf, WIDGET_VERSION)
  } catch { }

  if (!quiet && !firstOfBuild) {
    const tSync = Date.now()
    try {
      await backgroundSync(snap)
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

async function backgroundSync(snap: any) {
  const s: any = (snap && snap.settings) || {}
  if (s.bgRefresh === false) { try { tickLive() } catch { } return }
  await runWidgetTasks(snap, {
    rebuildMin: Number(s.refreshWidgetMin ?? 5),
    lightMin: Number(s.refreshExistingMin ?? 10),
    fullMin: Number(s.fullRotateMin ?? 15),
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
