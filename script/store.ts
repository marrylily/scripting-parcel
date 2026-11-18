// 包裹助手 — 数据层
import { Widget } from "scripting"
import { companyName, companyCode, companyCodeInText } from "./theme"
import { syncLogosToShared } from "./utils/widgetLogos"
import { matchStationIn as matchStationInPure } from "./utils/stationMatch"
import { readJsonFile, writeJsonFile, operationFiles } from "./utils/sharedJson"
import { codeKey } from "./utils/codes"
// 数据模型字段与原 Pickup 一一对应（取件码/公司/地址/手机号/备注/状态/短信/驿站）。
// 数据只存本机 Storage，不访问任何自建服务器。

export type PickupStatus = 1 | 2 // 1 待取，2 已取
/** 凭证类型（二进制 PickupType: delivery / meal / movie） */
export type PickupType = "delivery" | "meal" | "movie"

export interface Pickup {
  /** 授权平台同步到的商品名（没有就回落显示快递公司名） */
  itemTitle?: string
  uuid: string
  code: string
  companyName: number
  address: string
  phone: string
  notes: string
  status: PickupStatus
  type?: PickupType
  codeTime: string // "yyyy-MM-dd HH:mm:ss"
  smsContent: string
  courierStationName: string
  courierStationUuid: string
  createdAt: number
  /** 查快递加进来的包裹：运单号（有值时算物流包裹） */
  mailNo?: string
  /** 快递鸟 ShipperCode，如 ZTO / SF / JD */
  shipperCode?: string
  /** 快递公司显示名，如「中通快递」 */
  trackCompany?: string
  /** 最新一条轨迹 */
  trackLatest?: string
  /** 已缓存的轨迹（新的在后） */
  trackNodes?: { time: string; text: string }[]
  trackUpdatedAt?: number
  /** 数据来源：手动查快递走快递鸟；平台授权走对应平台，刷新时各走各的 */
  source?: "kdniao" | "taobao" | "jd" | "pdd" | "fengchao" | "mi" | "cainiao" | "vip" | "dewu"
  /** 收货城市 / 完整收货地址（平台同步或轨迹里解析，用来在地图上画收货点） */
  receiverCity?: string
  receiverAddress?: string
  receiverName?: string
  receiverPhone?: string
  /** 平台订单号（带 tb:/jd:/pdd: 前缀），平台刷新时用它重新拉取 */
  orderId?: string
  /** 用户手动点过「已取件」。置位后任何同步都不再改它的状态，也不再管它的物流 */
  pickedByUser?: boolean
  /** 平台给的预计时间文案，如「预计11月9日发货，11月11日送达」 */
  eta?: string
  /** 从 eta 解析出的到达日期（毫秒）：卡片在途时显示「预计 X月X日」 */
  etaAt?: number
  /** 真正取件的时间（用户点已取，或平台回报已取出）：卡片显示「取件 X月X日」 */
  pickedAt?: number
  /** 用户手动写的备注（当商品名用）：有它就优先显示，没填就按原来的商品名/快递公司 */
  userTitle?: string
  /** 这个包裹是从哪个 App 识别来的（快捷指令截图时取的 CurrentApp）：
   *  卡片第二行的平台图标和平台名用它，不占 source（source 负责选刷新线路） */
  srcApp?: { id?: string; name?: string }
  /** 同一包裹在不同平台识别到的所有取件码（第一个就是 code） */
  codes?: string[]
  /** 到站（进待取）的真实时间：从轨迹节点算，不是 createdAt */
  arrivedAt?: number
  /** 平台已关闭（退款/退货/取消）：终态，卡片取件码位置直接显示这个文字，不再当待取 */
  closed?: string
  /** 丰巢在柜信息：有一键开柜按钮就靠它（柜机、格口、单件） */
  fcBox?: import("./utils/fengchao").FcBoxMeta
}

export interface CourierStation {
  courierStationUuid: string
  courierStationName: string
  phone: string
  address: string
  businessHours: string
  notes: string
  /** 归类关键词：短信/地址里出现任一关键词就归到这个驿站（比名称/地址优先） */
  keywords?: string[]
  /** 手机号可以有多个（同一个驿站可能有好几个联系电话） */
  phones?: string[]
  /** 是否在取件页的驿站标题下面显示营业时间与地址（默认不显示） */
  showOnHome?: boolean
}

export interface BindUser {
  openId: string
  nickName: string
  addedAt: number
}

export interface LocationReminder {
  id: string
  placeName: string
  latitude: number | null
  longitude: number | null
  radius: number
  arriveAtArrival: boolean
  enabled: boolean
  createdAt: number
}

export interface Settings {
  // 取件提醒
  reminderEnabled: boolean
  reminderAfterHours: number
  reminderMaxTimes: number
  quietStart: number
  quietEnd: number
  // 外观
  appearanceMode: "system" | "light" | "dark"
  homeColor: string
  simpleMode: boolean
  // 刷新频率
  refreshAppMin: number
  refreshWidgetMin: number
  /** 组件重建时，距上次刷新「已有单号」多久才真的联网（分钟） */
  refreshExistingMin: number
  /** 全量同步间隔（小时）：App 与组件的全量轮转都用它 */
  fullSyncHours: number
  failCoolMin: number
  // 身份码
  showTaobao: boolean
  showCainiao: boolean
  showPdd: boolean
  // 灵动岛 / 实时活动
  liveActivityEnabled: boolean
  liveStyle: string
  liveExpiryCourier: string
  // 快捷指令
  /** 物流到站/签收时发本地通知（默认开） */
  trackNotify?: boolean
  /** 同步失败时发系统通知（默认开；含人机验证提醒，可关） */
  syncFailNotify?: boolean
  // 账户
  nickName: string
  /** 头像：none 无头像占位 / emoji 系统卡通表情 / photo 相册图片 */
  avatarMode?: "none" | "emoji" | "photo"
  avatarEmoji?: string
  /** 相册头像的本地文件路径 */
  avatarPhoto?: string
  // 小组件
  /** 小组件里是否显示在途包裹（默认显示） */
  widgetShowTransit?: boolean
  /** 每行第二行优先显示什么：item 商品名 / track 物流最新动态 */
  widgetSubtitle?: "item" | "track"
  /** 后台刷新：借小组件刷新顺带拉物流（没加小组件就不会发生） */
  bgRefresh?: boolean
}

/* 正式版不写任何初始化/演示数据：新装设备从空列表开始。 */

const K = {
  pickups: "cc.pickups",
  stations: "cc.stations",
  binds: "cc.binds",
  locations: "cc.locations",
  settings: "cc.settings",
}

export function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ---------- 取件 ----------
export function getPickups(): Pickup[] {
  const v = Storage.get<Pickup[]>(K.pickups)
  if (!Array.isArray(v)) return []
  // 旧数据没有 type 字段，统一按快递处理
  return v.map(p => ({ ...p, type: p.type ?? "delivery" }))
}

export function savePickups(list: Pickup[]) {
  // 累计口径：导入数只增不减；已取数只统计“从未取变成已取”的那一次
  try {
    const prevList = Storage.get<Pickup[]>(K.pickups) ?? []
    const prev = new Map(prevList.map(p => [p.uuid, p]))
    let added = 0
    let picked = 0
    const isPicked = (p: any) => p.status === 2 || p.pickedByUser === true
    for (const p of list) {
      const old = prev.get(p.uuid)
      if (!old) added += 1
      if (isPicked(p) && !(old && isPicked(old))) picked += 1
    }
    if (added > 0) Storage.set(IMPORTED_KEY, importedPackages() + added)
    if (picked > 0) Storage.set(PICKED_KEY, pickedPackages() + picked)
  } catch { }
  Storage.set(K.pickups, list)
  // 小组件可能跑在另一个脚本的沙盒里，读不到本脚本 Storage，需要同步一份快照
  writeWidgetSnapshot()
  // 任何增删改都让桌面小组件重画一次（合并到 600ms，避免同步循环里连着刷十几次）
  syncWidget()
}

/** 累计导入过的包裹数：删除/清历史都不减，只有“清除缓存”会重置为当前剩余数 */
const IMPORTED_KEY = "cc.stat.imported"
const PICKED_KEY = "cc.stat.picked"
export function importedPackages(): number {
  const n = Number(Storage.get<number>(IMPORTED_KEY) ?? 0)
  const cur = (Storage.get<Pickup[]>(K.pickups) ?? []).length
  return Math.max(Number.isFinite(n) ? n : 0, cur)
}
export function pickedPackages(): number {
  const n = Number(Storage.get<number>(PICKED_KEY) ?? 0)
  const cur = (Storage.get<Pickup[]>(K.pickups) ?? []).filter(p => p.status === 2 || p.pickedByUser).length
  return Math.max(Number.isFinite(n) ? n : 0, cur)
}
export function resetImportedPackages(to = 0) {
  Storage.set(IMPORTED_KEY, Math.max(0, Math.floor(to)))
}
export function resetPickedPackages(to = 0) {
  Storage.set(PICKED_KEY, Math.max(0, Math.floor(to)))
}

/** 共享快照：小组件跑在独立沙盒里读不到 Storage，统一从 App Group 读文件。 */
const SHARED_DIR = `${FileManager.appGroupDocumentsDirectory}/cc`
const SHARED_WIDGET = `${SHARED_DIR}/widget.json`

export function writeWidgetSnapshot() {
  try {
    if (!FileManager.existsSync(SHARED_DIR)) FileManager.createDirectorySync(SHARED_DIR, true)
    syncLogosToShared()
    const settings = Storage.get<Partial<Settings>>(K.settings) ?? null
    writeJsonFile(SHARED_WIDGET, {
      at: Date.now(),
      lastSync: Storage.get<number>("cc.widget.lastSync") ?? null,
      pickups: getPickups(),
      settings,
    })
    syncWidgetAvatar(settings)
  } catch { }
}

/** 头像存在 App 私有目录，小组件访问不到，另存一张 128px 小图到共享目录 */
function syncWidgetAvatar(s: Partial<Settings> | null) {
  try {
    if (!s || s.avatarMode !== "photo" || !s.avatarPhoto) return
    const dst = `${SHARED_DIR}/avatar.png`
    if (Storage.get<string>("cc.widget.avatarSrc") === s.avatarPhoto && FileManager.existsSync(dst)) return
    if (!FileManager.existsSync(s.avatarPhoto)) return
    const img = UIImage.fromFile(s.avatarPhoto)
    if (!img) return
    const thumb = img.preparingThumbnail({ width: 128, height: 128 }) ?? img
    const data = thumb.toPNGData()
    if (!data) return
    FileManager.writeAsDataSync(dst, data)
    Storage.set("cc.widget.avatarSrc", s.avatarPhoto)
  } catch { }
}

const SHARED_PICKED = `${SHARED_DIR}/picked.json`

/**
 * 消费小组件里点的「已取」。
 * 桌面扩展和 App 是两个进程，私有 Storage 不互通；扩展只能把操作写进共享目录，
 * 所以 App 启动（以及每次回前台）时调一次，把标记合进自己的列表。
 * 返回本次改动的条数。
 */
export function applyWidgetPicked(): number {
  try {
    const ops: Record<string, number> = {}
    if (FileManager.existsSync(SHARED_PICKED)) {
      const raw = FileManager.readAsStringSync(SHARED_PICKED) || "{}"
      const parsed = JSON.parse(raw) || {}
      for (const k of Object.keys(parsed)) ops[k] = Number(parsed[k]) || Date.now()
    }
    // 快照里也写着 pickedByUser：操作文件丢了也能兑底（App 自己写的快照与本地一致，不会误改）
    try {
      if (FileManager.existsSync(SHARED_WIDGET)) {
        const snap = JSON.parse(FileManager.readAsStringSync(SHARED_WIDGET) || "null")
        if (snap && Array.isArray(snap.pickups)) {
          for (const p of snap.pickups) {
            if (p && p.uuid && p.pickedByUser && p.status === 2) ops[p.uuid] = ops[p.uuid] ?? Date.now()
          }
        }
      }
    } catch { }
    const pendingOps = operationFiles(`${SHARED_DIR}/ops/picked`)
    for (const file of pendingOps) {
      const op = readJsonFile<{ uuid?: string; at?: number }>(file, {})
      if (op.uuid) ops[op.uuid] = Number(op.at) || Date.now()
    }
    const ids = Object.keys(ops)
    if (ids.length === 0) {
      for (const file of pendingOps) try { FileManager.removeSync(file) } catch { }
      return 0
    }
    const marked = new Set(ids)
    const list = getPickups()
    let n = 0
    const next = list.map(p => {
      if (marked.has(p.uuid) && !(p.status === 2 && p.pickedByUser)) {
        n++
        // ops 里的值是用户在桌面点圈的时间，用它当取件时间
        return { ...p, status: 2 as const, pickedByUser: true, pickedAt: ops[p.uuid] || Date.now() }
      }
      return p
    })
    // 旧版残留一次性消费后清除；新版使用不可覆盖的独立事件文件。
    try { writeJsonFile(SHARED_PICKED, {}) } catch { }
    if (n > 0) {
      savePickups(next)
      // 组件上点的圈：进 App 后补一次最终物流，之后不再更新
      const hit = next.filter(p => marked.has(p.uuid) && p.pickedByUser).map(p => p.uuid)
      void import("./utils/platformSync").then(async m => {
        let i = 0
        const worker = async () => { while (i < hit.length) await m.finalRefreshForPickup(hit[i++]) }
        await Promise.all([worker(), worker()])
      }).catch(() => { })
    }
    for (const file of pendingOps) try { FileManager.removeSync(file) } catch { }
    return n
  } catch { return 0 }
}

const SHARED_NEW = `${SHARED_DIR}/newPackages.json`

/**
 * 消费小组件全量轮转发现的新包裹。
 * 组件进程与 App 的 Storage 不互通，只能写共享文件；去重键 = source+orderId，
 * 再退一步看 mailNo，避免同一件被两边各建一张卡。
 */
export function applyWidgetNewPackages(): number {
  const files = operationFiles(`${SHARED_DIR}/ops/new`)
  if (files.length === 0) return applyWidgetNewPackagesLegacy()
  const list = getPickups()
  const keyOf = (p: any) => `${p?.source ?? ""}|${String(p?.orderId ?? "") || String(p?.mailNo ?? "")}`
  // 运单号必须归一化比较：平台和组件两边的写法可能差大小写/空格，直接 === 会各建一张卡
  const mailKeyOf = (p: any) => codeKey(String(p?.mailNo ?? ""))
  const keys = new Set(list.map(keyOf))
  const mails = new Set(list.map(mailKeyOf).filter(Boolean))
  const next = [...list]
  const done: string[] = []
  for (const file of files) {
    const raw = readJsonFile<any>(file, null)
    if (!raw || typeof raw !== "object") { done.push(file); continue }
    const k = keyOf(raw)
    if (keys.has(k) || (raw.mailNo && mails.has(mailKeyOf(raw)))) { done.push(file); continue }
    // 用户删过的单：组件不知道，但这里不能再加回去
    if (isPickupRemoved(raw)) { done.push(file); continue }
    const item: Pickup = { ...raw, uuid: raw.uuid || uuid(), type: raw.type ?? "delivery", createdAt: Number(raw.createdAt) || Date.now(), codeTime: raw.codeTime ?? nowText() }
    keys.add(k)
    const mk = mailKeyOf(item)
    if (mk) mails.add(mk)
    next.unshift(item)
    done.push(file)
  }
  if (done.length > 0) savePickups(next)
  for (const file of done) try { FileManager.removeSync(file) } catch { }
  return done.length
}

function applyWidgetNewPackagesLegacy(): number {
  try {
    if (!FileManager.existsSync(SHARED_NEW)) return 0
    const arr = JSON.parse(FileManager.readAsStringSync(SHARED_NEW) || "[]")
    if (!Array.isArray(arr) || arr.length === 0) return 0
    const list = getPickups()
    const keyOf = (p: any) => `${p?.source ?? ""}|${String(p?.orderId ?? "") || String(p?.mailNo ?? "")}`
    const mailKeyOf = (p: any) => codeKey(String(p?.mailNo ?? ""))
    const keys = new Set(list.map(keyOf))
    const mails = new Set(list.map(mailKeyOf).filter(Boolean))
    const next = [...list]
    let n = 0
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue
      const k = keyOf(raw)
      if (keys.has(k)) continue
      if (raw.mailNo && mails.has(mailKeyOf(raw))) continue
      if (isPickupRemoved(raw)) continue
      const item: Pickup = {
        ...raw,
        uuid: raw.uuid || uuid(),
        type: raw.type ?? "delivery",
        createdAt: Number(raw.createdAt) || Date.now(),
        codeTime: raw.codeTime ?? nowText(),
      }
      keys.add(k)
      const mk = mailKeyOf(item)
      if (mk) mails.add(mk)
      next.unshift(item)
      n++
    }
    try { writeJsonFile(SHARED_NEW, []) } catch { }
    if (n > 0) savePickups(next)
    return n
  } catch { return 0 }
}

const SHARED_TRACK = `${SHARED_DIR}/trackUpdates.json`

/**
 * 消费小组件刷到的物流字段。
 * 组件进程写不到 App 的 Storage，只能把结果写进共享文件；不合并的话，
 * 组件每轮刷新的结果会被 App 下一次写快照直接覆盖（用户看到的就是“刷了没变”）。
 * 返回应用的条数。
 */
function applyWidgetTrackUpdatesLegacy(): number {
  try {
    if (!FileManager.existsSync(SHARED_TRACK)) return 0
    const parsed = JSON.parse(FileManager.readAsStringSync(SHARED_TRACK) || "{}") || {}
    // 只允许组件写物流字段：归属、已取、用户备注这类不能让它改
    const allowed = ["trackLatest", "trackNodes", "trackUpdatedAt", "code", "codes", "arrivedAt", "mailNo", "itemTitle", "status", "pickedAt", "courierStationName", "courierStationUuid", "address", "fcBox", "closed"] as const
    let n = 0
    const next = getPickups().map(p => {
      const u = (parsed as any)[p.uuid]
      if (!u) return p
      const at = Number(u.trackUpdatedAt || u.at || 0)
      // 比本地旧的结果不回写，避免把 App 刚拉到的新轨迹盖回去
      if (at > 0 && (p.trackUpdatedAt ?? 0) > at) return p
      const patch: any = {}
      for (const k of allowed) if (u[k] !== undefined) patch[k] = u[k]
      if (Object.keys(patch).length === 0) return p
      n++
      return { ...p, ...patch }
    })
    // 先清操作文件再落盘，避免下次启动重复应用
    try { writeJsonFile(SHARED_TRACK, {}) } catch { }
    if (n > 0) savePickups(next)
    return n
  } catch { return 0 }
}

export function applyWidgetTrackUpdates(): number {
  const files = operationFiles(`${SHARED_DIR}/ops/track`)
  if (files.length === 0) return applyWidgetTrackUpdatesLegacy()
  const allowed = ["trackLatest", "trackNodes", "trackUpdatedAt", "code", "codes", "arrivedAt", "mailNo", "itemTitle", "status", "pickedAt", "courierStationName", "courierStationUuid", "address", "fcBox", "closed"] as const
  let next = getPickups(), n = 0
  const done: string[] = []
  for (const file of files) {
    const event = readJsonFile<any>(file, null)
    if (!event?.uuid) { done.push(file); continue }
    const u = event.update || {}
    next = next.map(p => {
      if (p.uuid !== event.uuid) return p
      const at = Number(u.trackUpdatedAt || u.at || 0)
      if (at > 0 && (p.trackUpdatedAt ?? 0) > at) return p
      const patch: any = {}
      for (const k of allowed) if (u[k] !== undefined) patch[k] = u[k]
      if (Object.keys(patch).length) n++
      return { ...p, ...patch }
    })
    done.push(file)
  }
  if (n > 0) savePickups(next)
  for (const file of done) try { FileManager.removeSync(file) } catch { }
  return n
}

export function addPickup(input: Omit<Pickup, "uuid" | "createdAt" | "codeTime"> & { codeTime?: string }): Pickup {
  const list = getPickups()
  // 同一运单号 / 订单号绝不建第二张卡：平台同步、手动添加、快捷指令、小组件合并全走这里，
  // 任何一处漏判都只能在入库前拦，不能事后靠清理。
  const dup = findDuplicatePickup(list, input)
  if (dup) return dup
  // 用户主动加回来的单：撤销「删除记忆」，否则它下一轮同步还是进不来
  unmarkPickupRemoved(input)
  const item: Pickup = {
    ...input,
    uuid: uuid(),
    codeTime: input.codeTime ?? nowText(),
    createdAt: Date.now(),
  }
  list.unshift(item)
  savePickups(list)
  return item
}

/** 判断这条输入是不是已经在列表里了。运单号按 codeKey 归一化比较
 *  （大小写/空格/连字符各不相同：SF123 vs sf-123），再看平台订单号。 */
export function findDuplicatePickup(
  list: Pickup[],
  input: { mailNo?: string; orderId?: string },
): Pickup | undefined {
  const mail = codeKey(input.mailNo ?? "")
  if (mail) {
    const hit = list.find(p => p.mailNo && codeKey(p.mailNo) === mail)
    if (hit) return hit
  }
  const oid = String(input.orderId ?? "")
  if (oid) return list.find(p => p.orderId && String(p.orderId) === oid)
  return undefined
}

/* ---------------- 删除记忆（墓磑） ----------------
 * 用户手动删掉的包裹，平台下一轮同步不能又导回来（否则删除没意义）。
 * 按运单号 + 订单号记一份黑名单；只有「清除缓存」会清空它。
 * 用户主动重新加入同一单时，addPickup 会把对应的 key 撤掉。 */
const K_REMOVED = "cc.removed"

type RemovedMap = Record<string, number>

function removedMap(): RemovedMap {
  try {
    const v = Storage.get<RemovedMap>(K_REMOVED)
    return v && typeof v === "object" ? v : {}
  } catch { return {} }
}

function removedKeysOf(p: { mailNo?: string; orderId?: string }): string[] {
  const out: string[] = []
  const mail = codeKey(String(p?.mailNo ?? ""))
  if (mail) out.push(`m:${mail}`)
  const oid = String(p?.orderId ?? "")
  if (oid) out.push(`o:${oid}`)
  return out
}

/** 删除时记一笔；不无上限涨，只留最近 2000 条 */
export function markPickupRemoved(p: { mailNo?: string; orderId?: string }): void {
  const keys = removedKeysOf(p)
  if (keys.length === 0) return
  const map = removedMap()
  const at = Date.now()
  for (const k of keys) map[k] = at
  const kept = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 2000)
  try { Storage.set(K_REMOVED, Object.fromEntries(kept)) } catch { }
}

/** 这一单是不是被用户删过（平台同步/组件合并都要先问一句） */
export function isPickupRemoved(p: { mailNo?: string; orderId?: string }): boolean {
  const keys = removedKeysOf(p)
  if (keys.length === 0) return false
  const map = removedMap()
  return keys.some(k => (map[k] ?? 0) > 0)
}

/** 用户主动把同一单加回来了：撤销删除记忆 */
export function unmarkPickupRemoved(p: { mailNo?: string; orderId?: string }): void {
  const keys = removedKeysOf(p)
  if (keys.length === 0) return
  const map = removedMap()
  let changed = false
  for (const k of keys) {
    if (k in map) { delete map[k]; changed = true }
  }
  if (changed) { try { Storage.set(K_REMOVED, map) } catch { } }
}

/** 清除缓存时把这份名单清空（用户要求：只有清缓存才忘） */
export function clearRemovedPickups(): number {
  const n = removedPickupCount()
  try { Storage.remove(K_REMOVED) } catch { }
  return n
}

/** 黑名单里现在记了多少条（清除缓存的预览/文案用） */
export function removedPickupCount(): number {
  return Object.keys(removedMap()).length
}

export function updatePickup(uuid: string, patch: Partial<Pickup>) {
  savePickups(getPickups().map((p) => (p.uuid === uuid ? { ...p, ...patch } : p)))
}

export function deletePickup(uuid: string) {
  const gone = getPickups().find((p) => p.uuid === uuid)
  savePickups(getPickups().filter((p) => p.uuid !== uuid))
  // 记住「用户删过它」：否则下一轮平台同步会把同一单又导进来，删除等于白删
  if (gone) markPickupRemoved(gone)
  // 删掉的包裹不能继续弹「已放置 N 小时」：把它的到站记录与待投递提醒一并清掉。
  // 常态刷新也能清，但要等下一轮（限频 20 分钟），中间到点就会弹出来。
  void import("./utils/reminders").then((m) => {
    try { m.forgetArrived(gone ?? { uuid, mailNo: "", code: "" } as any) } catch { }
    return m.reschedulePickupReminders(true)
  }).catch(() => { })
}

import { arrivedAtOf } from "./utils/arrive"
import { isAwaitingPickup } from "./utils/model"
import { hasStationJunk } from "./utils/smsParse"

/** 老数据里把客服话术当驿站名/地址存进去了（短信里的「如遇问题请联系代理点」）。
 *  卡片右上角就是显示 address/courierStationName，不清掉会一直显示那串。
 *  只过滤话术，不限长度——真地址可能很长。 */
export function cleanStations(): number {
  let changed = 0
  const next = getPickups().map(p => {
    const a = (p.address ?? "").trim()
    const s = (p.courierStationName ?? "").trim()
    const badA = !!a && hasStationJunk(a)
    const badS = !!s && hasStationJunk(s)
    if (!badA && !badS) return p
    changed++
    return { ...p, ...(badA ? { address: "" } : {}), ...(badS ? { courierStationName: "" } : {}) }
  })
  if (changed) savePickups(next)
  return changed
}

/** 修历史数据：取件码与到站时间都按新规则补一遍。
 *  1) 禁止用运单号当取件码（清空，卡片改显示「暂无取件码」）
 *  2) 补上 arrivedAt，否则「已到站 N 小时」会把授收时间当成到站时间
 */
export function normalizeCodes(): number {
  const k = (s: any) => String(s ?? "").replace(/[\s-]/g, "").toLowerCase()
  let changed = 0
  const next = getPickups().map(p => {
    const no = k(p.mailNo)
    const codes = (p.codes ?? []).filter(c => !no || k(c) !== no)
    const bad = !!no && k(p.code) === no
    const shrank = codes.length !== (p.codes?.length ?? 0)
    const at = p.arrivedAt ?? (p.status === 1 ? arrivedAtOf(p.trackNodes) : undefined)
    const needAt = !p.arrivedAt && !!at
    if (!bad && !shrank && !needAt) return p
    changed++
    const first = codes[0] ?? (bad ? "" : p.code)
    return { ...p, code: first, codes: codes.length > 0 ? codes : undefined, ...(needAt ? { arrivedAt: at } : {}) }
  })
  if (changed > 0) savePickups(next)
  return changed
}

/** 这条包裹是自动导入的（平台同步 / 快捷指令），不是用户手选的 */
function autoImported(p: Pickup): boolean {
  // 快递鸟那条路的公司名来自 ShipperCode，可靠，不动
  if (p.source && p.source !== "kdniao") return true
  return /^(tb|jd|pdd|cn|fc|mi|manual):/i.test(p.orderId ?? "")
}

/** 一次性修「所有包裹都被写成中通」的老数据：
 *  以前平台同步新单用 `idx || 1`（认不出公司就写 1）、快捷指令导入直接写 1，
 *  而 1 就是中通快递——于是全部包裹都顶着中通图标。
 *  修法：能从文案/轨迹/公司名里认出就用认出的；认不出且原来记的就是中通、
 *  文案里也没提中通 → 那是当初兜底写进去的，改回 0（其他快递）。
 *  已经认得出公司的（非 0/1）一律不信文案，避免驿站名把快递公司改错。 */
export function repairCompanyCodes(): number {
  if (Storage.get<boolean>("cc.company.fix1")) return 0
  try { Storage.set("cc.company.fix1", true) } catch { }
  let changed = 0
  const next = getPickups().map(p => {
    const code = Number(p.companyName ?? 0) || 0
    if (code !== 0 && code !== 1) return p
    const text = [p.smsContent, p.notes, p.trackLatest, p.itemTitle,
      ...(p.trackNodes ?? []).map(n => n.text)].filter(Boolean).join("\n")
    const fromText = companyCodeInText(text)
    let want = code
    if (fromText && fromText !== code) want = fromText
    else if (code === 1 && !fromText && companyCode(p.trackCompany ?? "") !== 1 && autoImported(p)) want = 0
    if (want === code) return p
    changed++
    return { ...p, companyName: want }
  })
  if (changed > 0) savePickups(next)
  return changed
}

export function setPickupStatus(uuid: string, status: PickupStatus) {
  // 手动标记状态时记下用户意图：已取件的包裹后续同步不再被物流状态拉回待取。
  // 同时记下取件时间：卡片/历史要显示「取件 X月X日」，不能拿入库时间充数。
  updatePickup(uuid, status === 2
    ? { status, pickedByUser: true, pickedAt: Date.now() }
    : { status, pickedByUser: false, pickedAt: undefined })
  // 取走了就允许以后再次到站提醒，并立刻撤掉这条包裹还没到点的超时提醒
  if (status === 2) {
    const gone = getPickups().find((p) => p.uuid === uuid)
    void import("./utils/reminders").then((m) => {
      try { if (gone) m.forgetArrived(gone) } catch { }
      return m.reschedulePickupReminders(true)
    }).catch(() => { })
  }
  syncWidget()
  // 点取件时最后拉一次物流，把最终轨迹存下来（之后不再更新）
  if (status === 2) void import("./utils/platformSync").then(m => m.finalRefreshForPickup(uuid)).catch(() => { })
}

/** 取件页/小组件改完状态都要让对面立刻重画，保证两边永远同源同结果 */
let widgetSyncTimer: ReturnType<typeof setTimeout> | null = null
function syncWidget(delay = 600) {
  if (widgetSyncTimer) return
  widgetSyncTimer = setTimeout(() => {
    widgetSyncTimer = null
    try { Widget.reloadAll() } catch { }
  }, delay)
}

// ---------- 驿站 ----------
export function getStations(): CourierStation[] {
  const v = Storage.get<CourierStation[]>(K.stations)
  if (!Array.isArray(v)) return []
  // 旧数据没有 keywords / phones，读出来补上，避免各处判空
  const split = (x: any): string[] => {
    if (Array.isArray(x)) return x.map(s => String(s).trim()).filter(Boolean)
    if (typeof x === "string") return x.split(/[,，、;；\s]+/).map(s => s.trim()).filter(Boolean)
    return []
  }
  return v.map(s => ({
    ...s,
    keywords: split(s.keywords),
    phones: split(s.phones ?? s.phone),
  }))
}

export function addStation(input: Omit<CourierStation, "courierStationUuid">): CourierStation {
  const s: CourierStation = { ...input, courierStationUuid: uuid() }
  const list = getStations()
  list.push(s)
  Storage.set(K.stations, list)
  return s
}

export function updateStation(uuid: string, patch: Partial<CourierStation>) {
  Storage.set(K.stations, getStations().map((s) => (s.courierStationUuid === uuid ? { ...s, ...patch } : s)))
}

export function deleteStation(uuid: string) {
  Storage.set(K.stations, getStations().filter((s) => s.courierStationUuid !== uuid))
}

/** 驿站匹配的打分规则只有一份：utils/stationMatch.ts（不含存储依赖，桌面小组件也用它）。
 *  这里保留同名导出，现有调用点不用改。 */
export const matchStationIn = matchStationInPure

/** 用已保存的驿站列表做匹配 */
export function matchStation(text: string): { name: string; uuid: string } | null {
  return matchStationInPure(getStations(), text)
}

/* ---------------- 物流文案 → 取件页归属 ----------------
 * 现在没有短信导入，包裹全靠物流信息识别：
 *  - picked：已取走，直接置为已取
 *  - arrived：到站可取（含「已签收」，驿站件常是投递到柜/站后签收），进取件页
 *  - transit：还在路上，不进
 */
const PICKED_TXT = /已领取|已取出|已取件|用户已取|已出库|出库成功|取件完成|已拿走|凭取件码签收|凭码签收|提货码签收|客户已签收|本人签收|已由本人|拍照签收|已从.{0,12}(?:驿站|代收|柜|自提点).{0,6}取出/
const STILL_WAITING_TXT = /待取件|请及时取|请及时领取|请凭.{0,8}取|待领取|暂存|已存放|已放入/
const ARRIVED_TXT = /待取件|已到站|已到达|已投递|已暂存|已存放|已放入|已代收|请及时取|请及时领取|凭取件码|待领取|已签收|已妥收|快递柜|驿站|代收点/

export type ArrivalState = "picked" | "arrived" | "transit"

export function arrivalState(latest: string): ArrivalState {
  const t = (latest || "").trim()
  if (!t) return "transit"
  if (PICKED_TXT.test(t) && !STILL_WAITING_TXT.test(t)) return "picked"
  if (ARRIVED_TXT.test(t)) return "arrived"
  return "transit"
}

// ---------- 亲友 ----------
export function getBinds(): BindUser[] {
  const v = Storage.get<BindUser[]>(K.binds)
  return Array.isArray(v) ? v : []
}

export function addBind(nickName: string): BindUser {
  const u: BindUser = { openId: uuid(), nickName, addedAt: Date.now() }
  const list = getBinds()
  list.push(u)
  Storage.set(K.binds, list)
  return u
}

export function removeBind(openId: string) {
  Storage.set(K.binds, getBinds().filter((u) => u.openId !== openId))
}

// ---------- 身份码 ----------
/** 身份码品牌：源码里三个快捷入口各自对应一个身份码，不是一个码加三个开关 */
export type IdentityBrand = "taobao" | "cainiao" | "pdd"
export interface IdentityCode {
  id: IdentityBrand
  name: string
  code: string
  enabled: boolean
}

const IDENTITY_META: { id: IdentityBrand; name: string }[] = [
  { id: "taobao", name: "淘宝身份码" },
  { id: "cainiao", name: "菜鸟出库码" },
  { id: "pdd", name: "拼多多身份码" },
]

/** 旧的单码数据迁移成第一条，其余两条留空（不伪造）；只迁一次 */
export function getIdentityCodes(): IdentityCode[] {
  const v = Storage.get<IdentityCode[]>("cc.identityCodes")
  if (Array.isArray(v) && v.length > 0) {
    // v2：旧版默认全开；v3：默认全关，需要用户在设置里手动打开
    if (Storage.get<boolean>("cc.identityV3") !== true) {
      const off = v.map(c => ({ ...c, enabled: false }))
      Storage.set("cc.identityCodes", off)
      Storage.set("cc.identityV3", true)
      Storage.set("cc.identityV2", true)
      return off
    }
    return v
  }
  const legacy = identityCode()
  // 默认全部关闭：开启前要先在账号页完成对应平台授权
  const list = IDENTITY_META.map((m, i) => ({
    ...m,
    code: i === 0 ? legacy : "",
    enabled: false,
  }))
  Storage.set("cc.identityCodes", list)
  Storage.set("cc.identityV3", true)
  return list
}

function saveIdentityCodes(list: IdentityCode[]) {
  Storage.set("cc.identityCodes", list)
}

export function setIdentityEnabled(id: IdentityBrand, enabled: boolean) {
  saveIdentityCodes(getIdentityCodes().map(c => c.id === id ? { ...c, enabled } : c))
  // 同步旧设置，保证从旧入口进来看到的状态一致
  const key = id === "taobao" ? "showTaobao" : id === "cainiao" ? "showCainiao" : "showPdd"
  saveSettings({ [key]: enabled } as any)
}

/** 兼容旧调用：返回已保存的第一条身份码；没有就是空串，不伪造。 */
export function identityCode(): string {
  return Storage.get<string>("cc.identity") ?? ""
}

// ---------- 位置提醒 ----------
export function getLocations(): LocationReminder[] {
  const v = Storage.get<LocationReminder[]>(K.locations)
  return Array.isArray(v) ? v : []
}

export function addLocation(input: Omit<LocationReminder, "id" | "createdAt">): LocationReminder {
  const item: LocationReminder = { ...input, id: uuid(), createdAt: Date.now() }
  const list = getLocations()
  list.push(item)
  Storage.set(K.locations, list)
  return item
}

export function updateLocation(id: string, patch: Partial<LocationReminder>) {
  Storage.set(K.locations, getLocations().map((l) => (l.id === id ? { ...l, ...patch } : l)))
}

export function deleteLocation(id: string) {
  Storage.set(K.locations, getLocations().filter((l) => l.id !== id))
}

// ---------- 设置 ----------
const DEFAULT_SETTINGS: Settings = {
  reminderEnabled: false,
  reminderAfterHours: 24,
  reminderMaxTimes: 3,
  quietStart: 22,
  quietEnd: 8,
  appearanceMode: "system",
  homeColor: "星辉紫",
  simpleMode: false,
  refreshAppMin: 20,
  refreshWidgetMin: 5,
  // 组件补单与 App 前台补单同节拍：20 分钟
  refreshExistingMin: 20,
  fullSyncHours: 3,
  failCoolMin: 30,
  showTaobao: true,
  showCainiao: true,
  showPdd: false,
  liveActivityEnabled: true,
  liveStyle: "液态玻璃",
  liveExpiryCourier: "10分钟",
  nickName: "包裹助手",
  avatarMode: "none",
  avatarEmoji: "",
  avatarPhoto: "",
  widgetShowTransit: true,
  widgetSubtitle: "item",
  bgRefresh: true,
}

export function getSettings(): Settings {
  const v = Storage.get<Partial<Settings>>(K.settings)
  const merged = { ...DEFAULT_SETTINGS, ...(v ?? {}) }
  // 旧版本允许选「5 分钟 / 30 秒」，现在最短 10 分钟（与组件重建间隔同起点）
  if (!LIVE_EXPIRY_OPTIONS.includes(merged.liveExpiryCourier)) merged.liveExpiryCourier = "10分钟"
  // 小组件跟随 App 节拍：补单 = App 补单间隔，全量轮转 = fullSyncHours
  try {
    if (!Storage.get<boolean>("cc.schedule.v3")) {
      merged.refreshExistingMin = 20
      Storage.set("cc.schedule.v3", true)
    }
  } catch { }
  // 倍数约束：数据刷新 ≥ 2×重建
  const r = Math.max(5, Math.min(180, Number(merged.refreshWidgetMin) || 5))
  const e = Math.max(Math.max(5, Math.min(120, Number(merged.refreshExistingMin) || r * 2)), r * 2)
  merged.refreshWidgetMin = r
  merged.refreshExistingMin = e
  return merged
}

/** 与 ui/sheets.tsx 的 Picker 选项保持一致 */
export const LIVE_EXPIRY_OPTIONS = ["24小时", "12小时", "8小时", "4小时", "2小时", "1小时", "30分钟", "15分钟", "10分钟", "永不"]

export function saveSettings(patch: Partial<Settings>) {
  Storage.set(K.settings, { ...getSettings(), ...patch })
  writeWidgetSnapshot()
  // 头像或小组件选项一变就重画小组件，避免桌面上还是旧头像
  if (patch.avatarMode !== undefined || patch.avatarEmoji !== undefined || patch.avatarPhoto !== undefined
    || patch.widgetShowTransit !== undefined || patch.widgetSubtitle !== undefined) {
    syncWidget(100)
  }
}

export type StationLayout = "grid" | "list"
export function getStationLayout(): StationLayout {
  return Storage.get<string>("cc.stationLayout") === "list" ? "list" : "grid"
}
export function setStationLayout(v: StationLayout) {
  Storage.set("cc.stationLayout", v)
}

// ---------- 统计 ----------
export interface Stats {
  pending: number
  picked: number
  total: number
  thisMonth: number
  thisWeek: number
  byCompany: { name: string; count: number }[]
  pickupWeekday: number[]
  avgSmsHour: string
  trendDays: { label: string; count: number }[]
}

export function getStats(): Stats {
  const list = getPickups()
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const weekStart = dayStart - ((now.getDay() + 6) % 7) * 86400000

  const pending = list.filter((p) => isAwaitingPickup(p)).length
  const picked = list.filter((p) => p.status === 2).length
  const thisMonth = list.filter((p) => p.createdAt >= monthStart).length
  const thisWeek = list.filter((p) => p.createdAt >= weekStart).length

  const byC = new Map<number, number>()
  for (const p of list) byC.set(p.companyName, (byC.get(p.companyName) ?? 0) + 1)
  const byCompany = [...byC.entries()]
    .map(([code, count]) => ({ name: companyName(code), count }))
    .sort((a, b) => b.count - a.count)

  const pickupWeekday = [0, 0, 0, 0, 0, 0, 0]
  const hourCount = new Array(24).fill(0)
  let hourTotal = 0
  for (const p of list) {
    const d = new Date(p.createdAt)
    pickupWeekday[d.getDay()]++
    hourCount[d.getHours()]++
    hourTotal++
  }
  const peakHour = hourCount.indexOf(Math.max(...hourCount))
  const avgSmsHour = hourTotal ? `${String(peakHour).padStart(2, "0")}:00 前后` : "暂无"

  const trendDays: Stats["trendDays"] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(dayStart - i * 86400000)
    const start = d.getTime()
    const end = start + 86400000
    trendDays.push({
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      count: list.filter((p) => p.createdAt >= start && p.createdAt < end).length,
    })
  }

  return { pending, picked, total: list.length, thisMonth, thisWeek, byCompany, pickupWeekday, avgSmsHour, trendDays }
}
