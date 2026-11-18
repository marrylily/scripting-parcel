// 平台登录页（唯品会 / 得物 / 拼多多 / 淘宝 / 京东）。
//
// 为什么不用 WebViewController.present()：它弹出的导航栏是半透明浮层，会盖住网页最上面
// ~116pt（CSS 修补对固定定位的登录弹层不生效，唯品会那种全屏浮层尤其明显）。
// 改成脚本自己的子页面 + <WebView>：导航栏是真正占位的，内容从栏下面开始，天然不会被遮。
//
// 参考：ui/kdLogin.tsx 一直是这么做的（快递鸟登录从没出现遮挡）。
import { Button, Navigation, Text, Toolbar, ToolbarItem, VStack, WebView, useEffect, useState } from "scripting"
import { C } from "../theme"
import { VIP_AUTO_STEP } from "../utils/loginFix"
import {
  PDD_LOGIN_FIX, jdSessionLogin, markPlatform, pddSessionReady, savePddSession, setPlatformEnabled, taobaoSessionLogin,
} from "../platforms"
import { syncPlatformParcels } from "../utils/platformSync"
import { vipSaveCookies } from "../utils/vip"
import { dewuSaveCookies } from "../utils/dewu"

/** 与 platforms.ts 相同的 Safari 移动版 UA（有些站点按 UA 分支渲染） */
const SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

export type WebLoginId = "vip" | "dewu" | "pdd" | "taobao" | "jd"

interface Cfg {
  title: string
  url: string
  hint: string
  /** 首帧前注入的脚本（可选） */
  script?: string
  /** App 侧每 800ms 调一次的“一步”脚本，返回值是状态字符串（唯品会专用） */
  step?: string
  /** 每轮轮询问一次：拿到真凭证就返回 true（顺带把 Cookie 落盘） */
  done: (wv: WebViewController) => Promise<boolean>
}

/** 认某个 Cookie 名就算登录了，同时把全部 Cookie 存下来 */
async function cookieLogin(wv: WebViewController, keys: string[], save: (list: any[]) => void): Promise<boolean> {
  const cs = await wv.getAllCookies().catch(() => [])
  const ok = (cs || []).some((c: any) => keys.includes(String(c.name)) && !!c.value)
  if (ok) save(cs || [])
  return ok
}

const CONFIG: Record<WebLoginId, Cfg> = {
  vip: {
    title: "登录唯品会",
    // 唯品会没有可直开的登录页，只能进站后把登录浮层点出来。
    // 不用 addUserScript（真机上没生效），改成 App 每隔 800ms 调一次 VIP_AUTO_STEP；
    // 它每次返回一句状态，底栏直接显示卡在哪一步。
    // 实测：直达个人中心这个 hash 路由（首页的新人券弹窗不会出现），
    // 页面上只剩一个「登录/注册」，点一次就弹手机号登录框。
    url: "https://m.vip.com/v3/index.html#/pages/userCenter/userCenter",
    hint: "正在打开登录…",
    step: VIP_AUTO_STEP,
    done: (wv) => cookieLogin(wv, ["VIP_TANK", "m_vipruid"], vipSaveCookies),
  },
  dewu: {
    title: "登录得物",
    url: "https://m.dewu.com/router/order/buyer/orderList",
    hint: "登录成功后本页自动关闭",
    done: (wv) => cookieLogin(wv, ["X-Auth-Token", "xAuthToken", "duToken"], dewuSaveCookies),
  },
  pdd: {
    title: "登录拼多多",
    url: "https://mobile.yangkeduo.com/login.html",
    hint: "输完验证码后本页自动关闭",
    // 登录表单居中重排 + 自动切「手机登录」；必须在首帧前注入，避免裸渲染一遍再重绘
    script: PDD_LOGIN_FIX,
    done: async (wv) => {
      const ok = await pddSessionReady(wv).catch(() => false)
      if (ok) { try { await savePddSession(wv) } catch { } }
      return ok
    },
  },
  taobao: {
    title: "登录淘宝",
    url: "https://login.taobao.com/member/login.jhtml",
    hint: "登录成功后本页自动关闭（菜鸟共用这个登录态）",
    done: (wv) => taobaoSessionLogin(wv).catch(() => false),
  },
  jd: {
    title: "登录京东",
    url: "https://plogin.m.jd.com/login/login?appid=0&returnurl=https%3A%2F%2Fhome.m.jd.com%2FmyJd%2Fnewhome.action",
    hint: "新设备可能要滑块或短信验证，登录成功后本页自动关闭",
    // 不再注入 JD_LOGIN_FIX：那份脚本是给「弹窗式」导航栏把网页下推的，
    // 咱们这页的导航栏是占位的，再推一次就会在顶部留一大块空白
    done: (wv) => jdSessionLogin(wv).catch(() => false),
  },
}

/** 把注入脚本自己报的状态翻成人话（底栏显示） */
function vipNoteText(note: string): string {
  const n = note.replace(/\d+$/, "")
  switch (n) {
    case "init": return "正在进入唯品会"
    case "login-open": return "已弹出登录框，请输入手机号"
    case "doc-loading": case "body-empty": case "page-loading": return "页面加载中"
    case "throttle-wait": case "throttle-retry": return "唯品会限流，正在重试"
    case "reload": return "限流未恢复，正在刷新页面"
    case "throttle-giveup": return "限流没恢复，稍后再点授权"
    case "throttle-no-btn": return "限流页没找到「重试」按钮"
    case "popup-wait": case "popup-closed": case "popup-stuck": return "正在关掉活动弹窗"
    case "no-tabbar": return "找不到底部导航栏"
    case "tab-clicked": case "tab-settling": return "正在切到个人中心"
    case "entry-wait": case "entry-clicked": return "正在点登录"
    case "entry-missing": return "个人中心里没找到登录入口"
    case "entry-giveup": return "没能自动弹出登录框，请手动点登录"
    default: return note.startsWith("ERR") ? note : (note || "等待页面")
  }
}

export function WebLoginPage({ id, close, bump, onDone }: {
  /** cainiao 没有自己的登录页，直接用淘宝的 */
  id: WebLoginId | "cainiao"
  close: () => void
  bump: () => void
  onDone?: () => void
}) {
  const cfg = CONFIG[id === "cainiao" ? "taobao" : id] ?? CONFIG.vip
  const [wv] = useState(() => new WebViewController({ ephemeral: true, preferredContentMode: "mobile" }))
  const [msg, setMsg] = useState(cfg.hint)

  useEffect(() => {
    let alive = true
    void (async () => {
      try { wv.setCustomUserAgent(SAFARI_UA) } catch { }
      if (cfg.script) {
        // documentStart：首帧前就生效，用户看不到“裸页面 → 重排”的跳动
        try { await wv.addUserScript({ source: cfg.script, injectionTime: "documentStart" }) } catch { }
      }
      try { await wv.loadURL(cfg.url) } catch (e: any) {
        if (alive) setMsg("页面加载失败：" + String(e?.message ?? e))
      }
    })()

    const timer = setInterval(async () => {
      if (!alive) return
      let ok = false
      try { ok = await cfg.done(wv) } catch { ok = false }
      if (!ok) return
      alive = false
      clearInterval(timer)
      try { onDone?.() } catch { }
      bump()
      close()
    }, 900)

    // 唯品会：App 主动驱动一步，返回的状态直接显示在底栏。
    // 不走 addUserScript，真机上注入没生效又看不到错，只能盲猜；这样一有问题立刻能在底栏看到。
    const stepTimer = cfg.step ? setInterval(async () => {
      if (!alive) return
      try {
        // 注意：evaluateJavaScript 把字符串当“函数体”执行，表达式不写 return 就拿不到值（实测返回 null）
        const note = await wv.evaluateJavaScript("return " + (cfg.step as string))
        if (alive) setMsg("自动登录：" + vipNoteText(String(note ?? "")))
      } catch (e: any) {
        if (alive) setMsg("自动登录出错：" + String(e?.message ?? e))
      }
    }, 800) : null

    return () => {
      alive = false
      clearInterval(timer)
      if (stepTimer) clearInterval(stepTimer)
      try { wv.dispose() } catch { }
    }
  }, [])

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background={C.bg}
      navigationTitle={cfg.title} navigationBarTitleDisplayMode="inline"
      navigationBarBackButtonHidden={true}
      toolbar={
        <Toolbar>
          <ToolbarItem placement="cancellationAction">
            <Button title="" systemImage="chevron.left" action={close} />
          </ToolbarItem>
        </Toolbar>
      }>
      <WebView controller={wv} />
      <Text font={12} foregroundStyle={C.secondary} padding={{ horizontal: 16, vertical: 8 }}
        frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {msg}
      </Text>
    </VStack>
  )
}

/**
 * 作为三级页 push 进来时的外壳：登录成功后真的弹栈（页面自己的 close 是 no-op 的话会留在原地），
 * 并标记授权 + 只同步这一个平台。
 */
export function WebLoginPushed({ id, bump }: { id: WebLoginId | "cainiao"; bump: () => void }) {
  const dismiss = Navigation.useDismiss()
  return <WebLoginPage id={id} bump={bump} close={() => { try { dismiss() } catch { } }}
    onDone={() => {
      markPlatform(id, true)
      // 登录成功就把该平台数据源打开（之前 authorize() 里做的事）
      setPlatformEnabled(id, true)
      void syncPlatformParcels(undefined, { only: [id], force: true }).catch(() => { })
    }} />
}
