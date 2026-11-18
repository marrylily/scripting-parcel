/**
 * 拼多多授权入口（唯一一处）：按「授权方式」分发。
 *
 * 以前两个地方各自调 `authorize("pdd")`——账号授权列表和平台详情页的授权按钮，
 * 结果选了 Token 也照样弹网页登录。现在两边都走这里，行为只剩一份。
 */
import { authorize } from "../platforms"
import { pddAuthMode, pddSaveToken } from "./pddToken"

export interface PddAuthResult {
  ok: boolean
  message: string
  /** 用户在弹窗里点了取消：调用方不要弹错误提示 */
  canceled?: boolean
}

export async function pddAuthorize(): Promise<PddAuthResult> {
  if (pddAuthMode() !== "token") {
    const err = await authorize("pdd")
    return err ? { ok: false, message: err } : { ok: true, message: "" }
  }

  let input: string | null = null
  try {
    input = await Dialog.prompt({
      title: "拼多多 Token",
      message: "粘贴 PDDAccessToken 或完整 Cookie 串",
      placeholder: "PDDAccessToken=…",
      confirmLabel: "保存",
      cancelLabel: "取消",
    })
  } catch { return { ok: false, message: "打不开输入框", canceled: true } }
  if (!input || !input.trim()) return { ok: false, message: "已取消", canceled: true }

  const r = await pddSaveToken(input)
  return { ok: r.ok, message: r.message }
}
