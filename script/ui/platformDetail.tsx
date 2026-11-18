// 平台详情页：从「账号授权」里点某个平台的图标/名字进来。
// 这里放这个平台专属的东西：授权状态、专属设置（拼多多取件手机号、丰巢手机号…）、
// 同步记录、解除授权。授权页本身只保留一行摘要，避免把所有设置堆在一页。
import { Button, HStack, Image, Navigation, NavigationStack, Text, Toggle, VStack, useState } from "scripting"
import { C, RR } from "../theme"
import { Icon, Section, SubPage } from "./kit"
import { assetImage } from "./assets"
import { notify } from "./notify"
import {
  PLATFORMS, authNeedsPage, authorize, clearAuth, hasAuth, markPlatform, needsReauth,
  platformEnabled, platformState, setPlatformEnabled, type PlatformId,
} from "../platforms"
import { platformLastError, platformLastSyncedAt, syncPlatformParcels } from "../utils/platformSync"
import { PddAuthSection, PddMobileSection } from "./pddMobiles"
import { FengchaoLoginPushed } from "./fengchaoLogin"
import { WebLoginPushed, type WebLoginId } from "./webLogin"
import { fcMobile } from "../utils/fengchao"
import { pddAuthMode, setPddAuthMode, type PddAuthMode } from "../utils/pddToken"
import { pddAuthorize } from "../utils/pddAuth"
import { readTaobaoDiag } from "../utils/taobaoTrace"

function hmText(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function PlatformDetailPage({ id, close, bump, open, closeLabel }: {
  id: PlatformId
  close: () => void
  bump: () => void
  open: (kind: string, props?: any) => void
  closeLabel?: string
}) {
  const p = PLATFORMS.find(x => x.id === id)
  const [rev, setRev] = useState(0)
  const [busy, setBusy] = useState(false)
  // 拼多多专属：授权方式（网页登录 / Token），存在本地，下次进来还是这个
  const [authMode, setAuthMode] = useState<PddAuthMode>(() => pddAuthMode())
  const [mobBusy, setMobBusy] = useState(false)
  const [syncText, setSyncText] = useState("")
  // 登录页用全屏模态打开：关闭就回到当前这一页（不会动页面栈）
  async function presentLoginPage(pid: PlatformId) {
    try {
      await Navigation.present({
        modalPresentationStyle: "fullScreen",
        element: (
          <NavigationStack>
            {pid === "fengchao"
              ? <FengchaoLoginPushed bump={bump} />
              : <WebLoginPushed key={pid} id={pid as WebLoginId | "cainiao"} bump={bump} />}
          </NavigationStack>
        ),
      } as any)
    } catch { }
    setRev(r => r + 1)
  }

  const authed = hasAuth(id)
  const expired = needsReauth(id)
  const st = platformState(id)
  const lastAt = platformLastSyncedAt(id)
  const err = platformLastError(id)
  const name = p?.name ?? id

  /* ---- 各平台专属设置都是内嵌 Section 组件，避免多开一层页面 ---- */

  async function doSync() {
    if (busy) return
    setBusy(true)
    setSyncText("准备中…")
    try {
      // 只认平台结论（与授权页、通知同一份），不再拿平台名字去 errors 里模糊匹配：
      // 平台名与 PLAT_LABEL 必须一个字不差，否则会把真实原因吐成「同步未完成」。
      const report = await syncPlatformParcels((t) => setSyncText(t || "同步中…"),
        { force: true, quietIssues: true, deadline: Date.now() + 90_000, only: [id] })
      const res = report?.results?.[id]
      if (res?.outcome === "ok") notify(`${name}已同步`)
      else if (!res) notify(`${name}未启用，请先授权或打开开关`, "warn")
      else notify(res.message, res.outcome === "failed" ? "warn" : "info")
    } catch (e: any) {
      notify(String(e?.message ?? e).slice(0, 30), "error")
    } finally {
      setBusy(false)
      setSyncText("")
      setRev(r => r + 1)
    }
  }

  async function doAuth() {
    if (busy) return
    // 需要登录页的平台：全屏模态打开（关闭回到本页，不碰页面栈）
    if (authNeedsPage(id) && !(id === "pdd" && pddAuthMode() === "token")) {
      await presentLoginPage(id)
      return
    }
    // 拼多多：按授权方式分发（网页 / Token 弹窗），与账号授权列表共用一个入口
    if (id === "pdd") {
      setBusy(true)
      try {
        const r = await pddAuthorize()
        if (r.ok) { markPlatform("pdd", true); notify("拼多多授权成功"); bump() }
        else if (!r.canceled) notify(r.message, "warn")
      } catch (e: any) {
        notify(String(e?.message ?? e), "error")
      } finally {
        setBusy(false)
        setRev(v => v + 1)
      }
      return
    }
    setBusy(true)
    try {
      const e = await authorize(id)
      if (e) notify(e, "warn")
      else {
        markPlatform(id, true)
        notify(`${name}授权成功`)
        bump()
      }
    } catch (e: any) {
      notify(String(e?.message ?? e), "error")
    } finally {
      setBusy(false)
      setRev(r => r + 1)
    }
  }

  /** 换授权方式：两套会话存在同一个钥匙串槽，不清就会把旧身份当成新方式的登录态 */
  async function switchPddMode(next: PddAuthMode) {
    if (next === authMode) return
    if (authed) {
      const ok = await Dialog.confirm({
        title: "切换授权方式",
        message: "会清除当前保存的登录状态，需要用新方式重新授权。",
        confirmLabel: "切换", cancelLabel: "取消",
      })
      if (!ok) return
      clearAuth("pdd")
      notify("已清除原有授权")
    }
    setPddAuthMode(next)
    setAuthMode(next)
    bump()
    setRev(r => r + 1)
  }

  return (
    <SubPage title={name} onClose={close} closeLabel={closeLabel}>
      <Section>
        <HStack spacing={14} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <VStack frame={{ width: 46, height: 46 }} clipShape={RR(23)}>
            <Image image={assetImage(p?.icon ?? "logos64/hive.png")} resizable antialiased
              interpolation="high" frame={{ width: 46, height: 46 }} />
          </VStack>
          <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={17} fontWeight="semibold" foregroundStyle={C.text}>{name}</Text>
            <Text font={13} foregroundStyle={expired ? C.orange : authed ? C.accent : C.tertiary}>
              {expired ? "登录已失效，需要重新授权"
                : !authed ? "未授权"
                  : "已授权"}
            </Text>
          </VStack>
          {authed ? (
            <Button title="解除授权" buttonStyle="bordered" tint={C.red} controlSize="small" disabled={busy} action={() => {
              clearAuth(id)
              notify(`${name}已解除授权`)
              bump()
              close()
            }} />
          ) : (
            <Button title={busy ? "处理中…" : "授权"} buttonStyle="borderedProminent" controlSize="small"
              disabled={busy} action={doAuth} />
          )}
        </HStack>
      </Section>

      {/* 得物要开订单页 + 钩 XHR + 固定等 7 秒，整步约 9 秒；实测组件扩展里能跑完，
          但预算不够时会跳过，所以写“可能延后”而不是“儿不刷新” */}
      {id === "dewu" ? (
        <Section title="同步方式"
          footer="得物要开订单页取数，较慢；App 每次同步都会跑，小组件预算够时会跑、不够就下次再补。">
          <Text font={14} foregroundStyle={C.tertiary} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            App 与小组件都会同步（组件可能延后）
          </Text>
        </Section>
      ) : null}

      {id === "pdd" ? (
        <>
          <PddAuthSection mode={authMode} onSwitch={(m) => void switchPddMode(m)} />
          <PddMobileSection authed={authed} bump={bump} />
        </>
      ) : null}

      {id === "taobao" || id === "cainiao" ? (
        <Section title="数据来源" footer="两个平台共用一次淘宝登录，但可以各自停用：关掉淘宝就不再拉订单，关掉菜鸟就不再读驿站取件码。">
          <Toggle title="读取淘宝订单" systemImage="bag"
            value={platformEnabled("taobao")}
            onChanged={(v) => { setPlatformEnabled("taobao", v); setRev(r => r + 1); bump() }} />
          <Toggle title="读取菜鸟驿站取件码" systemImage="shippingbox"
            value={platformEnabled("cainiao")}
            onChanged={(v) => { setPlatformEnabled("cainiao", v); setRev(r => r + 1); bump() }} />
        </Section>
      ) : null}

      {id === "fengchao" ? (
        <Section title="账号"
          footer="丰巢的取件码来自柜机接口。在「物流详情」页里，带柜机信息的包裹会多一个「一键开柜」按钮。">
          <HStack spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Icon name="iphone" size={18} color={C.accent} />
            <Text font={16} foregroundStyle={C.text}>登录手机号</Text>
            <VStack frame={{ maxWidth: "infinity" }} />
            <Text font={15} foregroundStyle={C.secondary}>{fcMobile() || "未登录"}</Text>
          </HStack>
        </Section>
      ) : null}

      <Section title="同步"
        footer={err && Date.now() - err.at < 3 * 3_600_000 ? `最近一次失败：${err.msg}` : undefined}>
        <HStack spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Icon name="clock.arrow.circlepath" size={18} color={C.accent} />
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={16} foregroundStyle={C.text}>上次同步</Text>
            <Text font={12} foregroundStyle={C.tertiary} lineLimit={1}>
              {busy && syncText ? syncText : (lastAt > 0 ? hmText(lastAt) : st ? `无成功记录` : "从未同步")}
            </Text>
          </VStack>
          <Button buttonStyle="bordered" disabled={busy || !authed} action={doSync}>
            <Text font={15} lineLimit={1} frame={{ minWidth: 80 }}>{busy ? "同步中…" : "立即同步"}</Text>
          </Button>
        </HStack>
      </Section>

      {id === "taobao" ? <TaobaoDiagSection rev={rev} /> : null}
    </SubPage>
  )
}

/** 丰巢 / 唯品会 / 得物 / 拼多多 / 淘宝 / 京东：登录页都是三级页，必须真 push */


function sec(ms: number): string {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}秒`
}

function TaobaoDiagSection({ rev }: { rev: number }) {
  void rev
  const d = readTaobaoDiag()
  if (!d || !d.steps.length) return null
  const when = (() => {
    const x = new Date(d.at)
    const p = (n: number) => String(n).padStart(2, "0")
    return `${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`
  })()
  return (
    <Section title="诊断" footer="最近一次淘宝同步各步耗时，仅本机保存，不含 Cookie 和查询参数。">
      <VStack alignment="leading" spacing={4} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={13} foregroundStyle={C.secondary}>
          {`${d.version} ${when} · 共 ${sec(d.totalMs)} · ${d.ok ? "成功" : "未完成"}`}
        </Text>
        {d.error ? <Text font={12} foregroundStyle={C.orange} multilineTextAlignment="leading">{d.error}</Text> : null}
        {d.steps.map((s, i) => (
          <Text key={`${s.name}-${i}`} font={12} foregroundStyle={s.ok ? C.tertiary : C.orange} multilineTextAlignment="leading">
            {`${s.ok ? "完成" : "失败"} ${s.name} ${sec(s.ms)}${s.url ? `  ${s.url}` : ""}`}
          </Text>
        ))}
      </VStack>
    </Section>
  )
}
