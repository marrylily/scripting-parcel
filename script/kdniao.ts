/**
 * 快递鸟（kdniao.com）：
 *  1) 支持 Keychain + App Group (cc/kdniao_shared.json) 双重共享持久化，确保桌面小组件后台 100% 读到密钥；
 *  2) 自动提取账号/设置中的手机号后 4 位填充 CustomerName，彻底解决中通/顺丰/京东在后台因“手机尾号不能为空”静默失败的问题。
 */
const CRED_KEY = "kdniao.credential"
const TOKEN_KEY = "kdniao.token"
const USER_KEY = "kdniao.user"
const BIZ_LOGIN_URL = "https://biz.kdniao.com/login"
const API_BASE = "https://coporate.kdniao.com"
const QUERY_URL = "https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx"
const KD100_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

import { Notification } from "scripting"
import { arrivalState, getPickups, getSettings, matchStation, updatePickup } from "./store"
import { markWidgetSynced } from "./widgetData"
import { etaInText } from "./utils/eta"
import { extractPickupCode as pickupCodeOf } from "./utils/pickupCode"
import { mergeCodes, codeKey } from "./utils/codes"
import { detectCompany as cnDetectCompany } from "./utils/cainiao"
import { notifyArrived } from "./utils/reminders"
import { arrivedAtOf } from "./utils/arrive"
import { refreshPlatformParcels } from "./platforms"
import { notify } from "./ui/notify"
import { safeDelay } from "./utils/safeTimer"

declare const fetch: any

export interface KdniaoUser {
  nickName: string
  mobile?: string
  companyName?: string
}

export interface KdniaoCredential {
  eBusinessId: string
  appKey: string
  userId?: string
  savedAt?: number
}

export interface TrackNode { time: string; text: string }

export interface TrackResult {
  shipperCode: string
  company: string
  state: string
  status: "none" | "transit" | "delivered"
  latest: string
  nodes: TrackNode[]
  source?: string
  pickupCode?: string
  receiverCity?: string
  receiverAddress?: string
}

/* ---------------- App Group 共享镜像（供小组件后台读取） ---------------- */

const SHARED_KD_FILE = () => `${FileManager.appGroupDocumentsDirectory}/cc/kdniao_shared.json`

function readSharedKd(): {
  cred?: KdniaoCredential
  user?: KdniaoUser
  token?: string
  phones?: Record<string, string>
  codes?: Record<string, string>
  defaultTail?: string
} {
  try {
    const f = SHARED_KD_FILE()
    if (!FileManager.existsSync(f)) return {}
    return JSON.parse(FileManager.readAsStringSync(f) || "{}") || {}
  } catch { return {} }
}

function writeSharedKd(patch: Record<string, any>): void {
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    const prev = readSharedKd()
    FileManager.writeAsStringSync(SHARED_KD_FILE(), JSON.stringify({ ...prev, ...patch }))
  } catch { }
}

/** 提取任意手机号字符串的后 4 位数字 */
function tail4(raw?: string): string {
  if (!raw) return ""
  const digits = String(raw).replace(/\D+/g, "")
  return digits.length >= 4 ? digits.slice(-4) : ""
}

/* ---------------- 凭证 / 登录态 / 资料存取 ---------------- */

export function loadUser(): KdniaoUser | null {
  try {
    const raw = Keychain.get(USER_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      if (v && typeof v.nickName === "string") {
        // 顺手同步到共享文件，方便小组件后台读取手机号后 4 位
        writeSharedKd({ user: v, ...(tail4(v.mobile) ? { defaultTail: tail4(v.mobile) } : {}) })
        return v
      }
    }
  } catch { }
  const shared = readSharedKd().user
  return shared && typeof shared.nickName === "string" ? shared : null
}

function saveUser(u: KdniaoUser) {
  try { Keychain.set(USER_KEY, JSON.stringify(u)) } catch { }
  writeSharedKd({ user: u, ...(tail4(u.mobile) ? { defaultTail: tail4(u.mobile) } : {}) })
}

export function loadToken(): string {
  try {
    const t = Keychain.get(TOKEN_KEY) ?? ""
    if (t) {
      writeSharedKd({ token: t })
      return t
    }
  } catch { }
  return readSharedKd().token ?? ""
}

export function clearToken() {
  try { Keychain.remove(TOKEN_KEY); Keychain.remove(USER_KEY) } catch { }
  writeSharedKd({ token: "", user: undefined })
}

export function loadCredential(): KdniaoCredential | null {
  try {
    const raw = Keychain.get(CRED_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      if (v && typeof v.eBusinessId === "string" && typeof v.appKey === "string") {
        writeSharedKd({ cred: v })
        return v
      }
    }
  } catch { }
  const shared = readSharedKd().cred
  if (shared && typeof shared.eBusinessId === "string" && typeof shared.appKey === "string") {
    return shared
  }
  return null
}

export function saveCredential(cred: KdniaoCredential) {
  const c = { ...cred, savedAt: Date.now() }
  try { Keychain.set(CRED_KEY, JSON.stringify(c)) } catch { }
  writeSharedKd({ cred: c })
}

export function clearCredential() {
  try { Keychain.remove(CRED_KEY) } catch { }
  writeSharedKd({ cred: undefined })
}

/* ---------------- 登录页 → 自动取 EBusinessID / AppKey ---------------- */

const SAVE_BUTTON_JS = `
(function () {
  var mk = function () {
    if (document.getElementById('__kd_save')) return;
    if (!document.body) return;
    var b = document.createElement('div');
    b.id = '__kd_save';
    b.textContent = '保存并返回';
    b.style.cssText = 'position:fixed;right:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 22px);' +
      'z-index:2147483647;padding:12px 22px;border-radius:24px;background:#2D7BFF;color:#fff;' +
      'font:600 16px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 20px rgba(0,0,0,.28);' +
      'user-select:none;-webkit-user-select:none;text-align:center;';
    b.addEventListener('click', function () {
      var raw = '';
      try { raw = localStorage.getItem('app-sso') || ''; } catch (e) { }
      try { window.webkit.messageHandlers.kdSave.postMessage(raw); } catch (e) { }
    }, false);
    document.body.appendChild(b);
  };
  mk();
  setInterval(mk, 1000);
  return 'ok';
})()
`

export async function readLocalStorage(wv: WebViewController): Promise<Record<string, string>> {
  try {
    const dump = String(await wv.evaluateJavaScript(
      "return (function(){try{var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k)}return JSON.stringify(o)}catch(e){return ''}})()"
    ) ?? "")
    if (!dump) return {}
    const obj = JSON.parse(dump)
    return obj && typeof obj === "object" ? obj : {}
  } catch { return {} }
}

function cleanToken(v: any): string {
  let s = typeof v === "string" ? v.trim() : ""
  if (!s) return ""
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1)
  return s.trim()
}

export function tokenFromLocalStorage(ls: Record<string, string>): string {
  const direct = cleanToken(ls["token"])
  if (direct && direct.length >= 12) return direct

  const sso = cleanToken(ls["app-sso"])
  if (sso) {
    try {
      const obj = JSON.parse(sso)
      const t = cleanToken(obj?.state?.accessToken ?? obj?.accessToken)
      if (t) return t
    } catch { }
  }

  for (const k of Object.keys(ls)) {
    if (/flush|refresh/i.test(k)) continue
    if (!/token/i.test(k)) continue
    const t = cleanToken(ls[k])
    if (t.length >= 12) return t
  }
  return ""
}

export async function credentialFromWebView(wv: WebViewController): Promise<KdniaoCredential> {
  const ls = await readLocalStorage(wv)
  const token = tokenFromLocalStorage(ls)
  if (!token) throw new Error("还没有登录成功，先在页面里完成登录或注册")
  try { Keychain.set(TOKEN_KEY, token) } catch { }
  writeSharedKd({ token })
  const cred = await fetchCredentialByToken(token)
  saveCredential(cred)
  try { saveUser(await fetchUserInfo(token)) } catch { }
  return cred
}

export async function fetchCredentialByToken(token: string): Promise<KdniaoCredential> {
  const res = await fetch(`${API_BASE}/user-api/user/queryApiSecretKey`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Authorization: token,
      Origin: "https://biz.kdniao.com",
      Referer: "https://biz.kdniao.com/",
      "User-Agent": KD100_UA,
    },
    body: JSON.stringify({ pageIndex: 1, pageSize: 10 }),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error("快递鸟返回了无法解析的数据") }
  const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  const first = list.find((x: any) => x && (x.secretId || x.appKey))
  if (!first) throw new Error(json?.message || "账号下还没有 API 密钥，请到「用户后台 → 快递鸟集成」创建")
  const eBusinessId = String(first.userId ?? first.eBusinessId ?? "")
  const appKey = String(first.secretId ?? first.appKey ?? "")
  if (!eBusinessId || !appKey) throw new Error("没有读到 EBusinessID / AppKey")
  return { eBusinessId, appKey, userId: String(first.userId ?? ""), savedAt: Date.now() }
}

export async function fetchUserInfo(token: string): Promise<KdniaoUser> {
  const res = await fetch(`${API_BASE}/user-api/user/getInfo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Authorization: token,
      Origin: "https://biz.kdniao.com",
      Referer: "https://biz.kdniao.com/",
      "User-Agent": KD100_UA,
    },
    body: "{}",
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error("快递鸟返回了无法解析的数据") }
  const u = json?.user ?? json?.data?.user ?? json?.data ?? {}
  const nickName = String(u.nickName ?? u.userName ?? "").trim()
  if (!nickName) throw new Error(json?.message || "没有读到账号资料")
  const out: KdniaoUser = { nickName }
  const mobile = String(u.mobile ?? u.mobilePhone ?? u.phone ?? u.tel ?? "").trim()
  if (mobile) out.mobile = mobile
  if (u.companyName) out.companyName = String(u.companyName)
  return out
}

export function companyIndex(shipperCode: string): number {
  switch ((shipperCode || "").toUpperCase()) {
    case "ZTO": return 1
    case "SF": return 2
    case "YTO": return 3
    case "YUNDA": return 4
    case "STO": return 5
    case "JT": return 6
    case "YZPY": case "EMS": return 7
    case "JD": return 8
    case "DBWL": return 9
    case "HTKY": return 12
    case "TTKDEX": return 13
    case "ZJS": return 14
    default: return 0
  }
}

export function statusLabel(s: TrackResult["status"]): string {
  return s === "delivered" ? "已签收" : s === "transit" ? "运输中" : "待揽收"
}

export interface TrackHistoryItem {
  mailNo: string
  phone?: string
  shipperCode?: string
  company?: string
  at: number
}

const HISTORY_KEY = "cc.track.history"

export function loadTrackHistory(): TrackHistoryItem[] {
  const v = Storage.get<any>(HISTORY_KEY)
  return Array.isArray(v) ? v.filter((x: any) => x && typeof x.mailNo === "string").slice(0, 30) : []
}

export function pushTrackHistory(item: TrackHistoryItem) {
  const list = loadTrackHistory().filter(x => x.mailNo !== item.mailNo)
  list.unshift(item)
  try { Storage.set(HISTORY_KEY, list.slice(0, 30)) } catch { }
}

export function removeTrackHistory(mailNo: string) {
  try { Storage.set(HISTORY_KEY, loadTrackHistory().filter(x => x.mailNo !== mailNo)) } catch { }
}

export function clearTrackHistory() {
  try { Storage.set(HISTORY_KEY, []) } catch { }
}

export { extractPickupCode } from "./utils/pickupCode"

export async function claimTrialPackage(): Promise<boolean> {
  const call = async (t: string) => {
    const r = await fetch(`${API_BASE}/champion-api/user/guide/receiveTrial`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Authorization: t, Origin: "https://biz.kdniao.com", Referer: "https://biz.kdniao.com/", "User-Agent": KD100_UA,
      },
      body: "{}",
    })
    return { status: r.status, text: await r.text() }
  }
  let t = loadToken()
  if (!t) t = await refreshTokenFromWebView()
  if (!t) return false
  let res = await call(t)
  if (res.status === 401) {
    const t2 = await refreshTokenFromWebView()
    if (!t2) return false
    res = await call(t2)
  }
  return res.status === 200 && res.text.includes("\"code\":200")
}

export async function refreshTokenFromWebView(): Promise<string> {
  const wv = new WebViewController()
  try {
    await wv.loadURL(BIZ_LOGIN_URL)
    await safeDelay(3000)
    const raw = String(await wv.evaluateJavaScript("return localStorage.getItem('app-sso') || ''") ?? "")
    let token = ""
    try { token = JSON.parse(raw || "{}")?.state?.accessToken || "" } catch { }
    if (token) {
      try { Keychain.set(TOKEN_KEY, token) } catch { }
      writeSharedKd({ token })
    }
    return token
  } catch { return "" } finally { try { wv.dispose() } catch { } }
}

export async function refreshTrackedPackages(opts?: {
  platforms?: boolean
  minGapMs?: number
  force?: boolean
  only?: string[]
  max?: number
}): Promise<number> {
  // 每次在主 App 触发刷新时，顺便把凭证和用户信息同步到共享目录
  try { loadCredential(); loadUser() } catch { }

  const LAST = "cc.track.lastRefresh"
  const minGap = opts?.minGapMs ?? 20 * 60 * 1000
  const last = Number(Storage.get<number>(LAST) ?? 0)
  if (!opts?.force && Date.now() - last < minGap) return 0
  try { Storage.set(LAST, Date.now()) } catch { }

  let platformChanged = 0
  if (opts?.platforms !== false) {
    try {
      platformChanged = await refreshPlatformParcels(20)
    } catch { }
  }

  let list = getPickups().filter(p => !!p.mailNo && (p.source ?? "kdniao") === "kdniao")
  if (opts?.only?.length) {
    const want = new Set(opts.only.map(x => String(x).replace(/[\s-]/g, "").toLowerCase()))
    list = list.filter(p => want.has(String(p.mailNo).replace(/[\s-]/g, "").toLowerCase()))
  }
  let changed = 0
  for (const p of list.slice(0, opts?.max ?? 20)) {
    if (p.pickedByUser) continue
    const no = p.mailNo as string
    try {
      const r = await queryTracking(no, { shipperCode: p.shipperCode })
      if (r.nodes.length === 0) continue
      if (r.latest === p.trackLatest && p.status === 1) continue
      const station = matchStation([r.latest, p.itemTitle ?? ""].filter(Boolean).join("\n"))
      const arrival = arrivalState(r.latest)
      if (arrival === "arrived") {
        await notifyArrived({
          ...p,
          trackLatest: r.latest,
          courierStationName: station?.name ?? p.courierStationName ?? "",
        })
      }
      const eta = etaInText(r.latest)
      const newCode = pickupCodeOf(r.nodes) || pickupCodeOf([{ text: r.latest }])
      const merged = mergeCodes(p.codes ?? (p.code ? [p.code] : []), newCode)
      const gained = merged.length > (p.codes?.length ?? (p.code ? 1 : 0))
      updatePickup(p.uuid, {
        trackLatest: r.latest,
        trackNodes: r.nodes,
        trackUpdatedAt: Date.now(),
        trackCompany: r.company || p.trackCompany,
        notes: r.latest,
        ...(eta ? { eta } : {}),
        ...(gained ? { codes: merged, code: codeKey(p.code) === codeKey(merged[0]) ? p.code : merged[0] } : {}),
        status: arrival === "picked" ? 2 : arrival === "arrived" ? 1 : p.status,
        ...(arrival === "picked" ? { pickedAt: p.pickedAt ?? arrivedAtOf(r.nodes) ?? Date.now() } : {}),
        ...(arrival === "arrived" ? { arrivedAt: p.arrivedAt ?? arrivedAtOf(r.nodes) ?? Date.now() } : {}),
        ...(station ? { courierStationName: station.name, courierStationUuid: station.uuid } : {}),
      })
      changed++
    } catch (e: any) {
      const t = String(e?.message ?? e)
      if (/密钥|无效|未授权|EBusinessID|AppKey|额度|余额/.test(t)) notify("快递鸟凭证异常，请重新登录", "warn")
    }
  }
  markWidgetSynced()
  return changed + platformChanged
}

export function maskPhone(p?: string): string {
  const s = (p ?? "").replace(/\s+/g, "")
  if (s.length < 7) return s
  return s.slice(0, 3) + "****" + s.slice(-4)
}

export async function refreshUser(): Promise<KdniaoUser | null> {
  const t = loadToken()
  if (!t) return null
  try {
    const u = await fetchUserInfo(t)
    saveUser(u)
    return u
  } catch { return null }
}

/* ---------------- 快递公司识别（菜鸟优先，快递100 兜底） ---------------- */

const COM2SHIPPER: Record<string, string> = {
  zhongtong: "ZTO", zto: "ZTO",
  yunda: "YUNDA",
  yto: "YTO", yuantong: "YTO",
  sto: "STO", shentong: "STO",
  shunfeng: "SF", sf: "SF",
  jd: "JD",
  jtexpress: "JT", jt: "JT",
  youzhengguonei: "YZPY",
  ems: "EMS",
  youshu: "YS",
  debang: "DBWL",
  bestex: "HTKY", bestexpress: "HTKY",
  zhaijisong: "ZJS",
  tiantian: "TTKDEX",
  guotong: "GTO",
}

export async function detectShipper(mailNo: string): Promise<{ shipperCode: string; company: string; type: string }> {
  const cn = await cnDetectCompany(mailNo).catch(() => null)
  if (cn) {
    const key = cn.cpCode.toLowerCase()
    return { shipperCode: COM2SHIPPER[key] || cn.cpCode.toUpperCase(), company: cn.cpName, type: cn.cpCode }
  }

  const res = await fetch(`https://www.kuaidi100.com/autonumber/autoComNum?resultv2=1&text=${encodeURIComponent(mailNo)}`, {
    headers: { "User-Agent": KD100_UA, Referer: "https://www.kuaidi100.com/", Accept: "application/json, text/plain, */*" },
  })
  if (!res.ok) throw new Error(`快递公司识别失败（HTTP ${res.status}）`)
  const body = await res.text()
  let json: any
  try { json = JSON.parse(body) } catch { throw new Error("快递公司识别失败：返回无法解析") }
  const first = json && Array.isArray(json.auto) ? json.auto[0] : null
  const comCode = first && first.comCode ? String(first.comCode) : ""
  if (!comCode) throw new Error("无法自动识别快递公司，请手动填写快递公司代码")
  return { shipperCode: COM2SHIPPER[comCode] || comCode.toUpperCase(), company: first.name || "", type: comCode }
}

/* ---------------- 8001 即时查询 ---------------- */

function sign(requestData: string, appKey: string): string {
  const raw = Data.fromRawString(requestData + appKey)
  if (!raw) throw new Error("签名失败")
  const md5hex = Crypto.md5(raw).toHexString().toLowerCase()
  const hexData = Data.fromRawString(md5hex)
  if (!hexData) throw new Error("签名失败")
  return encodeURIComponent(hexData.toBase64String())
}

function statusOf(state: any, latest: string): "none" | "transit" | "delivered" {
  if (!latest) return "none"
  if (String(state) === "3" || /签收|已签收|已送达|已取件|已领取|已投递/.test(latest)) return "delivered"
  return "transit"
}

const PHONE_KEY = "cc.track.phone"

function phoneMap(): Record<string, string> {
  try {
    const v = Storage.get<any>(PHONE_KEY)
    if (v && typeof v === "object") {
      writeSharedKd({ phones: v })
      return v
    }
  } catch { }
  return readSharedKd().phones ?? {}
}

export function getPhoneFor(mailNo: string): string {
  const key = mailNo.replace(/\s+/g, "")
  const m = phoneMap()
  if (m[key]) return m[key]
  // 兜底：自动取快递鸟账号手机号后 4 位或共享默认尾号（解决中通/顺丰/京东后台查单缺尾号报错）
  const shared = readSharedKd()
  if (shared.defaultTail) return shared.defaultTail
  const u = loadUser()
  const uTail = tail4(u?.mobile)
  if (uTail) return uTail
  try {
    // 尝试从共享快照 widget.json 或拼多多/小米手机号里找默认后 4 位
    const snapFile = `${FileManager.appGroupDocumentsDirectory}/cc/widget.json`
    if (FileManager.existsSync(snapFile)) {
      const snap = JSON.parse(FileManager.readAsStringSync(snapFile) || "{}")
      const sPhone = tail4(snap?.settings?.defaultPhone || snap?.settings?.phone || snap?.settings?.mobile)
      if (sPhone) return sPhone
    }
  } catch { }
  return ""
}

export function savePhoneFor(mailNo: string, phone: string) {
  const m = phoneMap()
  const clean = tail4(phone) || phone.trim()
  m[mailNo.replace(/\s+/g, "")] = clean
  try { Storage.set(PHONE_KEY, m) } catch { }
  writeSharedKd({ phones: m, ...(clean.length === 4 ? { defaultTail: clean } : {}) })
}

const CODE_KEY = "cc.track.code"

function codeMap(): Record<string, string> {
  try {
    const v = Storage.get<any>(CODE_KEY)
    if (v && typeof v === "object") {
      writeSharedKd({ codes: v })
      return v
    }
  } catch { }
  return readSharedKd().codes ?? {}
}

export function getCodeFor(mailNo: string): string {
  return codeMap()[mailNo.replace(/\s+/g, "")] ?? ""
}

export function saveCodeFor(mailNo: string, code: string) {
  const m = codeMap()
  m[mailNo.replace(/\s+/g, "")] = code.trim()
  try { Storage.set(CODE_KEY, m) } catch { }
  writeSharedKd({ codes: m })
}

function needPhoneError(msg: string) {
  const e: any = new Error(msg)
  e.needPhone = true
  e.wrongPhone = msg.includes("不正确")
  return e
}

/** 快递鸟 8001 即时查询（主通道） */
async function queryKdniao8001(
  no: string, shipperCode: string, company: string, phone: string,
): Promise<TrackResult> {
  const cred = loadCredential()
  if (!cred) throw new Error("还没有连接快递鸟账号")

  const rd: any = { LogisticCode: no, ShipperCode: shipperCode }
  const cleanTail = tail4(phone) || phone.trim()
  if (cleanTail) rd.CustomerName = cleanTail
  const requestData = JSON.stringify(rd)
  const body =
    `RequestData=${encodeURIComponent(requestData)}` +
    `&EBusinessID=${encodeURIComponent(cred.eBusinessId)}` +
    `&RequestType=8001` +
    `&DataSign=${sign(requestData, cred.appKey)}` +
    `&DataType=2`

  const post = async (): Promise<any> => {
    const res = await fetch(QUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": KD100_UA,
        Referer: QUERY_URL,
        Accept: "application/json, text/plain, */*",
      },
      body,
    })
    if (!res.ok) throw new Error(`快递鸟 HTTP ${res.status}`)
    const text = await res.text()
    try { return JSON.parse(text) } catch { throw new Error("快递鸟返回了无法解析的数据") }
  }

  let json = await post()
  if (!json.Success && String(json.Reason ?? "").includes("套餐")) {
    if (await claimTrialPackage()) json = await post()
  }
  if (!json.Success) {
    const reason = String(json.Reason ?? "")
    if (reason.includes("手机尾号不能为空")) throw needPhoneError("这个单号需要收件人手机号后四位")
    if (reason.includes("手机尾号不正确")) throw needPhoneError("手机号后四位不正确")
    if (reason.includes("套餐")) throw new Error("快递鸟账号没有可用套餐，自动领取失败")
    if (reason.includes("非法参数")) throw new Error("快递鸟拒绝了请求，请重新登录账号刷新密钥")
    throw new Error("快递鸟：" + (reason || "查询失败"))
  }

  const traces: any[] = (json.Traces || []).filter((t: any) => t && t.AcceptStation)
  traces.sort((a, b) => String(a.AcceptTime || "").localeCompare(String(b.AcceptTime || "")))
  const flatten = (v: any, depth = 0): string => {
    if (v == null || depth > 4) return ""
    if (typeof v === "string") return v
    if (typeof v === "number") return String(v)
    if (Array.isArray(v)) return v.map(x => flatten(x, depth + 1)).filter(Boolean).join(" ")
    if (typeof v === "object") {
      const keys = ["Desc", "AcceptStation", "Station", "Content", "Text", "Description", "Remark"]
      const parts: string[] = []
      for (const k of keys) { const s = flatten(v[k], depth + 1); if (s) parts.push(s) }
      if (parts.length > 0) return parts.join(" ")
      for (const k of Object.keys(v)) { const s = flatten(v[k], depth + 1); if (s) parts.push(s) }
      if (parts.length > 0) return parts.join(" ")
      try { const s = JSON.stringify(v); return s && s !== "{}" ? s : "" } catch { return "" }
    }
    return ""
  }
  const nodes: TrackNode[] = traces.map(t => ({
    time: String(t.AcceptTime || ""),
    text: flatten(t.AcceptStation).replace(/\s+/g, " ").trim(),
  })).filter(n => n.text)
  const latest = nodes.length > 0 ? nodes[nodes.length - 1].text : ""
  const rc = json.Receiver ?? null
  const receiverCity = rc ? String(rc.CityName ?? "").trim() : ""
  const receiverAddress = rc
    ? [rc.ProvinceName, rc.CityName, rc.ExpAreaName, rc.Address].map((v: any) => String(v ?? "").trim()).filter(Boolean).join("")
    : ""
  return {
    shipperCode,
    company: company || shipperCode,
    state: String(json.State ?? ""),
    status: statusOf(json.State, latest),
    latest,
    nodes,
    source: "快递鸟",
    receiverCity: receiverCity || undefined,
    receiverAddress: receiverAddress || undefined,
  }
}

export async function queryTracking(
  mailNo: string,
  opts?: { shipperCode?: string; phone?: string },
): Promise<TrackResult> {
  const no = mailNo.replace(/\s+/g, "")
  if (!no) throw new Error("请输入运单号")
  if (!loadCredential()) throw new Error("快递鸟未授权，请到 设置 → 账户 登录授权后再查")

  let shipperCode = (opts?.shipperCode || "").trim().toUpperCase()
  let company = ""
  if (!shipperCode) {
    const det = await detectShipper(no)
    shipperCode = det.shipperCode
    company = det.company
  }

  const phone = (opts?.phone || getPhoneFor(no) || "").trim()

  return { ...(await queryKdniao8001(no, shipperCode, company, phone)), pickupCode: getCodeFor(no) }
}
