/**
 * 平台授权：把「快递聚合」里已验证的三平台登录方案搬过来。
 *  - 淘宝：官方登录页 → 存 Cookie（Keychain `taobao.tracking.cookies`，跨脚本共用）
 *  - 京东：登录页（顶部修版）→ 等 pt_key + 回到 my.jd.com → 存 Cookie（`jd.cookies`）
 *  - 拼多多：手机号登录页（居中修版）→ 轮询 Cookie+localStorage → 存 Keychain（`pdd.cookies` / `pdd.ls`）
 * 授权后的「同步包裹」在 sync.ts（复用聚合脚本的解析逻辑，同一套 Keychain key）。
 */
declare const fetch: any
const delay = (ms: number) => new Promise<void>(resolve => (setTimeout as any)(resolve, ms))

// 解除授权用各平台自己的清理函数：它们除了删 Keychain，还会清 WebView 持久 Cookie 仓库，
// 只删 Keychain 的话下次授权会被旧会话自动登录。
import { jdClearLogin } from "./utils/jd"
import { pddClearLogin } from "./utils/pdd"
import { vipClearLogin, vipHasLogin } from "./utils/vip"
import { dewuClearLogin, dewuHasLogin } from "./utils/dewu"
import { clearIdentityCaches } from "./utils/identity"
import { pddAuthMode } from "./utils/pddToken"

// 登录页用 iPhone UA + 手机版 CSS 重画。实测结论：iPad UA 不会避免挤掉手机 App，
// 挤下线是账号级会话替换，与设备端无关；既然无收益就回到已验证可用的手机形态。
const SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

export type PlatformId = "taobao" | "cainiao" | "jd" | "pdd" | "vip" | "dewu" | "fengchao" | "kdniao"

// 快递鸟凭证 key（与 kdniao.ts 一致，避免循环导入）
const CRED_KEY_KD = "kdniao.credential"
const TOKEN_KEY_KD = "kdniao.token"

function loadCredentialSafe(): boolean {
  try { return !!Keychain.get(CRED_KEY_KD) } catch { return false }
}

export interface PlatformMeta {
  id: PlatformId
  name: string
  /** 本地 App 图标路径（assets/identity/ 下） */
  icon: string
}

export const PLATFORMS: PlatformMeta[] = [
  { id: "taobao", name: "淘宝", icon: "identity/taobao.png" },
  // 菜鸟单独列出：登录态就是淘宝会话（复用 TB_KEY），点「授权」弹的也是淘宝登录页；
  // 但它是一个独立平台（有自己的接口/身份码），用户要求它单独显示授权状态
  { id: "cainiao", name: "菜鸟", icon: "identity/cainiao.png" },
  { id: "jd", name: "京东", icon: "identity/jd.png" },
  { id: "pdd", name: "拼多多", icon: "identity/pdd.jpg" },
  // 唯品会：H5 登录（m.vip.com），订单走 mapi 网关直连，不用开网页
  { id: "vip", name: "唯品会", icon: "identity/vip.png" },
  // 得物：接口要原生签名，只能开订单页钩它自己发的请求（详见 utils/dewu.ts）
  { id: "dewu", name: "得物", icon: "identity/dewu.png" },
  // 丰巢：快递柜的真实取件码来源，手机号+短信登录（原生表单，不走 WebView）
  { id: "fengchao", name: "丰巢", icon: "logos64/hive.png" },
]

/* ---------------- 登录态存取（与聚合脚本同 key，可直接互认） ---------------- */

const TB_KEY = "taobao.tracking.cookies"
const JD_KEY = "jd.cookies"
const PDD_KEY = "pdd.cookies"
const PDD_LS_KEY = "pdd.ls"
// 新代码（utils/pdd.ts）读的是这个 key，两份都写，避免「授权成功但身份码页还要登录」
const PDD_LS_KEYS = ["pdd.ls", "pdd.localStorage"]

/** localStorage 里有没有像登录 token 的项（匿名页面也有 localStorage，不能只看非空） */
function hasPddTokenLS(): boolean {
  for (const key of PDD_LS_KEYS) {
    const raw = Keychain.get(key)
    if (!raw) continue
    try {
      const v = JSON.parse(String(raw))
      if (!v || typeof v !== "object") continue
      for (const k of Object.keys(v)) {
        const val = (v as any)[k]
        if (/token|access/i.test(k) && typeof val === "string" && val.length >= 8) return true
      }
    } catch { }
  }
  return false
}

function readCookies(key: string): any[] {
  const raw = Keychain.get(key)
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

/** 已存的淘宝 Cookie 里是否真的登录过（unb / tracknick） */
export function taobaoCookiesLoggedIn(): boolean {
  return readCookies(TB_KEY).some((c: any) => ["unb", "tracknick"].includes(String(c.name)) && !!c.value)
}

import { fcClearLogin, fcHasLogin } from "./utils/fengchao"

/* ---------------- 淘宝 / 菜鸟的独立启停 -------------
 * 登录可以复用（同一个淘宝会话），但「解除授权」要各自独立：
 * 解菜鸟只是不再拉菜鸟驿站数据，淘宝订单照旧；反过来也一样。
 * 两个都解除时才删 Cookie（否则下次还要重新登录）。 */
const EN_KEY = "cc.platform.enabled"

function readEnabled(): Record<string, boolean> {
  // 共享域优先：开关状态影响后台同步，小组件进程必须读到跟 App 一样的一份
  let raw = ""
  try { raw = String(Storage.get<string>(EN_KEY, { shared: true }) ?? "") } catch { }
  if (!raw) { try { raw = String(Storage.get<string>(EN_KEY) ?? "") } catch { } }
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {} } catch { return {} }
}

/** 默认开启：只记录「被显式关掉」的平台 */
export function platformEnabled(id: PlatformId): boolean {
  if (id !== "taobao" && id !== "cainiao") return true
  return readEnabled()[id] !== false
}

export function setPlatformEnabled(id: PlatformId, on: boolean) {
  const m = readEnabled()
  m[id] = on
  const raw = JSON.stringify(m)
  try { Storage.set(EN_KEY, raw, { shared: true }) } catch { }
  try { Storage.set(EN_KEY, raw) } catch { }
}

/** 自愈：登录页的匿名 cookie 曾被当成登录态存下来（重新授权时直接关掉弹窗就会这样），
 *  没有 unb/tracknick 的一律清掉，避免「显示已授权、接口全 SESSION_EXPIRED」。 */
export function sanitizeTaobaoAuth(): void {
  try {
    if (!Keychain.get(TB_KEY)) return
    if (taobaoCookiesLoggedIn()) return
    Keychain.remove(TB_KEY)
  } catch { }
}

export function hasAuth(id: PlatformId): boolean {
  if (id === "kdniao") return !!loadCredentialSafe()
  if (id === "fengchao") return fcHasLogin()
  // 菜鸟与淘宝共用淘宝登录态（同一套 Cookie 调 mtop）；淘宝已登录且没被单独关掉才算已授权
  // 光有 cookie 不算：登录页的匿名 cookie 会让人以为已授权，实际接口全是 SESSION_EXPIRED
  if (id === "cainiao") return taobaoCookiesLoggedIn() && platformEnabled("cainiao")
  if (id === "taobao") return taobaoCookiesLoggedIn() && platformEnabled("taobao")
  if (id === "jd") return readCookies(JD_KEY).some((c: any) => c.name === "pt_key" && !!c.value)
  if (id === "vip") return vipHasLogin()
  if (id === "dewu") return dewuHasLogin()
  if (id === "pdd") {
    // Token 模式只认 PDDAccessToken：匿名 cookie 一堆但没 token 就是没授权，
    // 以前“只要有 cookie 就算已授权”会让 Token 填错也显示成功
    if (pddAuthMode() === "token") {
      return readCookies(PDD_KEY).some((c: any) => c.name === "PDDAccessToken" && !!c.value)
    }
    return readCookies(PDD_KEY).length > 0 || hasPddTokenLS()
  }
  return false
}

export function clearAuth(id: PlatformId) {
  // 解除授权 / 重新授权前先把组件侧连败退避清掉：否则刚重新登录成功，组件还会按旧退避停着
  clearWidgetBackoff(id)
  if (id === "kdniao") { try { Keychain.remove(CRED_KEY_KD); Keychain.remove(TOKEN_KEY_KD) } catch { } return }
  if (id === "fengchao") { fcClearLogin(); return }
  // 淘宝 / 菜鸟：只关掉自己那路，不删 Cookie（另一路还要用）。
  // 两个都被关掉时才清 Cookie，避免残留登录态。
  if (id === "taobao" || id === "cainiao") {
    setPlatformEnabled(id, false)
    const other = id === "taobao" ? "cainiao" : "taobao"
    if (!platformEnabled(other)) {
      Keychain.remove(TB_KEY)
      // Cookie 没了，缓存里的身份码（带真实姓名与证件号）也就不能留着
      clearIdentityCaches()
    }
    return
  }
  if (id === "jd") { jdClearLogin(); return }
  if (id === "vip") { vipClearLogin(); return }
  if (id === "dewu") { dewuClearLogin(); return }
  if (id === "pdd") { pddClearLogin(); return }
}

function saveCookies(key: string, cookies: any[]) {
  Keychain.set(key, JSON.stringify(cookies))
}

/** 当前页面主机名（拿不到返回空串） */
function hostOf(u: any): string {
  const s = String(u || "")
  if (!s) return ""
  try { return new URL(s).host.toLowerCase() } catch { }
  const m = s.match(/^https?:\/\/([^/?#]+)/i)
  return m ? m[1].toLowerCase() : ""
}

/* ---------------- 登录页修版脚本（照搬聚合脚本的已验证版） ---------------- */

/** 京东：顶部导航栏盖住 116pt，把整页推下去（实现在 utils/jd.ts，两处不要各写一套） */

/** 拼多多：表单贴顶被导航栏盖住，改成垂直居中卡片 */
// 用户实测结论（2026-11-14）：iPad UA / 平板指纹并不能避免挤掉手机 App——
// 挤下线是账号级会话替换（网页登录 = 新会话，旧会话作废），与设备端无关。
// 所以登录页只保留这一套已验证可用的手机版重画，不再区分形态。
export const PDD_LOGIN_FIX = `(function(){
  var CSS = [
    'html,body{height:100%!important;overflow:hidden!important;background:#fff!important;}',
    '#login{background:#fff!important;}',
    '#login .main{display:none!important;}',
    '#login .container{position:fixed!important;top:0!important;bottom:0!important;left:0!important;right:0!important;',
    'height:auto!important;width:auto!important;max-width:none!important;overflow:visible!important;padding:0 0 110px!important;',
    'z-index:2!important;transform:none!important;opacity:1!important;display:flex!important;flex-direction:column!important;',
    'align-items:center!important;justify-content:center!important;background:#fff!important;}',
    '#login .container .login-ui-form{width:100%!important;max-width:430px!important;margin:0!important;padding:0!important;background:transparent!important;}',
    '#login .container .login-ui-form::before{content:"手机号登录";display:block;text-align:center;font-size:20px;font-weight:700;color:#151516;margin:0 16px 18px;}',
    '#login .container .login-ui-form .login-input{background:transparent!important;}',
    '#login .container .login-ui-form .login-input .input-group{background:#f5f5f5!important;border-radius:12px!important;margin:0 16px 12px!important;height:54px!important;padding:0 14px!important;width:auto!important;}',
    '#login .container .login-ui-form .login-input .input-group input{margin-left:28px!important;height:54px!important;font-size:17px!important;color:#151516!important;-webkit-text-fill-color:#151516!important;}',
    '#login .container .login-ui-form .login-input .input-group input::placeholder{color:#b8b8b8!important;-webkit-text-fill-color:#b8b8b8!important;}',
    '#login .container .login-ui-form .login-input .input-group #code-button{width:104px!important;height:34px!important;border-radius:17px!important;font-size:14px!important;}',
    '#login .container .login-ui-form .login-input hr{display:none!important;}',
    '#login .container .login-ui-form .footer-buttons-wrap{padding:6px 16px 0!important;}',
    '#login .container .login-ui-form #submit-button{width:100%!important;height:48px!important;border-radius:24px!important;font-size:17px!important;font-weight:600!important;}',
    '#login .container .login-ui-form .submit-button-login{display:none!important;}',
    '#login .container .login-ui-form .agreement-wrap{margin-top:14px!important;font-size:12px!important;}'
  ].join('');
  function apply(){
    if(!document.documentElement) return;
    var st = document.getElementById('agent-pdd-fix');
    if(!st){ st = document.createElement('style'); st.id='agent-pdd-fix'; (document.head||document.documentElement).appendChild(st); }
    if(st.textContent !== CSS) st.textContent = CSS;
    if(!window.__pddFixClicked){
      var all = [].slice.call(document.querySelectorAll('button,div,span,a'));
      var b = all.filter(function(e){ var t=(e.textContent||'').trim(); return /^(手机登录|手机号登录)$/.test(t) && e.children.length<3 })[0];
      if(b){ window.__pddFixClicked = 1; try{ b.click() }catch(e){} }
    }
  }
  apply();
  if(!window.__pddFixObserver){
    window.__pddFixObserver = new MutationObserver(function(){ if(!window.__pddFixTimer) window.__pddFixTimer=setTimeout(function(){ window.__pddFixTimer=0; apply() }, 100) });
    try{ window.__pddFixObserver.observe(document.documentElement || document, { childList:true, subtree:true }) }catch(e){}
  }
  var n = 0, iv = setInterval(function(){ apply(); if(++n > 80) clearInterval(iv) }, 250);
})()`

/* ---------------- 三平台登录 ---------------- */


export async function pddSessionReady(controller: WebViewController): Promise<boolean> {
  // 只认真正的登录凭证：PDDAccessToken 或 localStorage 里的用户 token。
  // 不能拿「域是 pinduoduo|yangkeduo 的任意 Cookie」当登录成功——匿名页面也有一堆（api_uid 等），
  // 那样一进登录页就判成功，弹窗会立刻关掉。
  try {
    const js = "return (function(){try{var ks=['pdd_user_token','token','PDDAccessToken','access_token'];for(var i=0;i<ks.length;i++){var v=localStorage.getItem(ks[i]);if(v&&v.length>8)return v}return ''}catch(e){return ''}})()"
    const r = String(await controller.evaluateJavaScript<string>(js) || "")
    if (r) return true
  } catch { }
  const cookies = await controller.getAllCookies().catch(() => [])
  return (cookies || []).some((c: any) => c && c.name === "PDDAccessToken" && !!c.value)
}

export async function savePddSession(controller: WebViewController): Promise<number> {
  const cookies = await controller.getAllCookies().catch(() => [])
  const usable = cookies.filter((c: any) => /pinduoduo|yangkeduo|pdd/.test(String(c.domain || "")))
  if (usable.length > 0) saveCookies(PDD_KEY, usable)
  try {
    const json = String(await controller.evaluateJavaScript<string>(
      "return (function(){try{var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k)}return JSON.stringify(o)}catch(e){return ''}})()"
    ) || "")
    if (json) for (const key of PDD_LS_KEYS) Keychain.set(key, json)
  } catch { }
  return usable.length
}


/* ---------------- 登录态保存（内嵌登录页共用） ---------------- */

/** 淘宝：有 unb/tracknick 就是登录了；同时把淘宝/天猫域名的 Cookie 存下来 */
export async function taobaoSessionLogin(wv: WebViewController): Promise<boolean> {
  const cookies = await wv.getAllCookies().catch(() => [])
  const logged = (cookies || []).some((c: any) => ["unb", "tracknick"].includes(String(c.name)) && !!c.value)
  if (!logged) return false
  const usable = (cookies || []).filter((c: any) => /taobao|tmall|alibaba/.test(String(c.domain || "")))
  if (usable.length > 0) saveCookies(TB_KEY, usable)
  return true
}

/** 京东：pt_key 就是登录凭证（同账号重登录值不变，不能拿“值变了”当条件） */
export async function jdSessionLogin(wv: WebViewController): Promise<boolean> {
  const cookies = await wv.getAllCookies().catch(() => [])
  const logged = (cookies || []).some((c: any) => String(c.name) === "pt_key" && !!c.value)
  if (logged) saveCookies(JD_KEY, cookies)
  return logged
}

/**
 * 哪些平台的授权需要在登录页里完成（对应 ui/webLogin.tsx 的那几个 id）。
 * 菜鸟是个例外：淘宝已登录时它只是“开关”，不需要再登一次。
 */
export function authNeedsPage(id: PlatformId): boolean {
  if (id === "taobao" || id === "cainiao") return !(taobaoCookiesLoggedIn() && platformState(id)?.ok !== false)
  // 拼多多 Token 模式走输入框，不进网页
  if (id === "pdd") return true
  return true
}

/** 不用登录页、直接当开关打开的情况（目前只有菜鸟复用淘宝身份） */
export async function authorize(id: PlatformId): Promise<string> {
  if ((id === "taobao" || id === "cainiao") && taobaoCookiesLoggedIn() && platformState(id)?.ok !== false) {
    setPlatformEnabled(id, true)
    return ""
  }
  // 其余都应该走 ui/webLogin.tsx 的登录页
  return "请在登录页完成授权"
}


/* ---------------- 授权有效性状态 ---------------- */

const STATE_KEY = "cc.platform.state"

export interface PlatformState {
  ok: boolean
  /** 最近一次验证时间 */
  at: number
  reason?: string
}

function readStates(): Record<string, PlatformState> {
  const raw = Storage.get<string>(STATE_KEY)
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {} } catch { return {} }
}

/** 最近一次同步时这个平台的登录态是否还活着；没有记录返回 null */
export function platformState(id: PlatformId): PlatformState | null {
  return readStates()[id] ?? null
}

/** 同步成功/失败后记一笔，授权列表据此显示「已失效」 */
export function markPlatform(id: PlatformId, ok: boolean, reason?: string) {
  const all = readStates()
  all[id] = { ok, at: Date.now(), reason: ok ? undefined : reason }
  try { Storage.set(STATE_KEY, JSON.stringify(all)) } catch { }
  if (ok) clearWidgetBackoff(id)
}

/**
 * 组件侧的“连败退避”存在 cc/widgetTasks.json 的 fail 里。
 * 用户重新授权或本轮同步成功时把它清掉，否则重新登录后组件还会按旧退避停着不动。
 * 这里直接改文件，不 import widgetTasks，避开循环依赖。
 */
function clearWidgetBackoff(id: PlatformId) {
  try {
    const f = `${FileManager.appGroupDocumentsDirectory}/cc/widgetTasks.json`
    if (!FileManager.existsSync(f)) return
    const s = JSON.parse(FileManager.readAsStringSync(f) || "{}") || {}
    if (s.fail && s.fail[id]) {
      delete s.fail[id]
      FileManager.writeAsStringSync(f, JSON.stringify(s))
    }
  } catch { }
}

/** 有 Cookie 但上次同步报登录失效 */
export function needsReauth(id: PlatformId): boolean {
  if (!hasAuth(id)) return false
  const s = platformState(id)
  return !!s && s.ok === false
}

/**
 * 拉取平台包裹的实现在 utils/platformSync.ts（后台刷新 = refreshPlatformParcels，
 * 全量发现新单 = syncPlatformParcels）。这里只重新导出，保持调用方不变。
 */
export { refreshPlatformParcels, syncPlatformParcels } from "./utils/platformSync"
export type { PlatformSyncReport } from "./utils/platformSync"
