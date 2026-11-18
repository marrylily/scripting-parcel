/**
 * 拼多多 Token 登录（移植自「快递聚合4.0」的 pddSaveToken，逻辑保持一致）。
 *
 * 为什么不走登录页：网页登录会新开一个设备端会话，把对方 App 里的登录挤下线
 * （拼多多是账号级会话替换，跟 UA 无关）。直接吃 Cookie 就不碰登录流程。
 *
 * 输入三种都认：
 *   1. 完整 Cookie 串：`PDDAccessToken=xxx; pdd_vds=xxx; …`
 *   2. 单个 name=value：`PDDAccessToken=xxx`
 *   3. 裸 token（≥8 位、不含空格）：当成 PDDAccessToken
 *
 * 存的位置和网页登录完全一样（钥匙串 pdd.cookies，cookie 对象数组，域名统一 .yangkeduo.com），
 * 所以 pddHasLogin / 订单同步 / 驿站取件码三条链路都不用改。
 */
import { pddClearLogin, pddCookies, pddHasLogin, pddOrderListDirect } from "./pdd"

const PDD_COOKIE_KEY = "pdd.cookies"

export type PddTokenResult = { ok: boolean; message: string; count: number }

/* ---------------- 授权方式（网页登录 / Token） ---------------- */

/** 两种方式的登录态存在同一个钥匙串槽里，所以切换前必须先清干净，免得旧会话被当成新的。 */
export type PddAuthMode = "web" | "token"
const MODE_KEY = "pdd.auth.mode"

export function pddAuthMode(): PddAuthMode {
  try { return Storage.get(MODE_KEY) === "token" ? "token" : "web" } catch { return "web" }
}

export function setPddAuthMode(mode: PddAuthMode): void {
  try { Storage.set(MODE_KEY, mode) } catch { }
}

export async function pddSaveToken(input: string): Promise<PddTokenResult> {
  const raw = String(input ?? "").trim()
  if (!raw) return { ok: false, message: "请先粘贴 Token / Cookie", count: 0 }

  // 保留已有的匿名 cookie（_nano_fp 之类），只覆盖/追加粘贴进来的
  const base: any[] = pddCookies()
  const upsert = (name: string, value: string) => {
    const i = base.findIndex((c: any) => String(c?.name) === name)
    const obj = { name, value, domain: ".yangkeduo.com", path: "/" }
    if (i >= 0) base[i] = obj
    else base.push(obj)
  }

  let count = 0
  if (/;/.test(raw) && /=/.test(raw)) {
    for (const part of raw.split(/[;\n\r]+/)) {
      const eq = part.indexOf("=")
      if (eq <= 0) continue
      const name = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim()
      if (!name || !value) continue
      upsert(name, value)
      count++
    }
  } else if (/=/.test(raw)) {
    const eq = raw.indexOf("=")
    const name = raw.slice(0, eq).trim()
    const value = raw.slice(eq + 1).trim()
    if (!name || !value) return { ok: false, message: "看不出是 Token 还是 Cookie 串，请检查粘贴的内容", count: 0 }
    upsert(name, value)
    count = 1
  } else if (raw.length >= 8 && !/\s/.test(raw)) {
    upsert("PDDAccessToken", raw)
    count = 1
  } else {
    return { ok: false, message: "看不出是 Token 还是 Cookie 串，请检查粘贴的内容", count: 0 }
  }

  try { Keychain.set(PDD_COOKIE_KEY, JSON.stringify(base)) } catch {
    return { ok: false, message: "写入钥匙串失败", count: 0 }
  }
  if (!pddHasLogin()) {
    return { ok: false, message: "已保存，但没有识别到有效的 PDDAccessToken，请检查粘贴的内容", count }
  }
  // 写盘后真拉一次订单列表验活：粘贴任意字符串也不能算“授权成功”
  try {
    await pddOrderListDirect("0")
    return { ok: true, message: `已保存 ${count} 项，Token 可用`, count }
  } catch (e: any) {
    const m = String(e?.message ?? e)
    if (/登录态无效|40001/.test(m)) {
      pddClearLogin()
      return { ok: false, message: "拼多多返回登录态无效，已回滚，请重新复制 Token", count }
    }
    // 网络/风控类失败不足以否定 Token 本身，保留并如实说明
    return { ok: true, message: `已保存 ${count} 项（未验证：${m.slice(0, 24)}）`, count }
  }
}
