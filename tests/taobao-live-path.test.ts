import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { discoverOrderIds } from "../script/utils/net.ts"
import { beginTaobaoDiag, finishTaobaoDiag, resetTaobaoDiagForTests } from "../script/utils/taobaoTrace.ts"
import { resetSyncGateForTests } from "../script/utils/syncGate.ts"

const SECRET_QUERY = "sekret-query-value"
const SECRET_COOKIE = "secret-cookie-value"
const SECRET_NAME = "secret-cookie-name"
const ORDER_DIGITS = "1234567890123"

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  delete (globalThis as { WebViewController?: unknown }).WebViewController
  delete (globalThis as { Keychain?: unknown }).Keychain
  delete (globalThis as { FileManager?: unknown }).FileManager
  resetTaobaoDiagForTests()
  resetSyncGateForTests()
})

function fastTimers() {
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout
}

function installFs() {
  const files = new Map<string, string>()
  ;(globalThis as { FileManager?: unknown }).FileManager = {
    appGroupDocumentsDirectory: "/app",
    existsSync: (path: string) => files.has(path) || path.endsWith("/cc"),
    readAsStringSync: (path: string) => files.get(path) ?? "",
    writeAsStringSync: (path: string, text: string) => { files.set(path, text) },
    createDirectorySync: () => {},
    removeSync: (path: string) => { files.delete(path) },
  }
  return files
}

function assertNoSecrets(text: string) {
  assert.equal(text.includes(SECRET_QUERY), false)
  assert.equal(text.includes(SECRET_COOKIE), false)
  assert.equal(text.includes(SECRET_NAME), false)
  assert.equal(text.includes(ORDER_DIGITS), false)
}

type Mode = "timeout-pc" | "login" | "app" | "timer-fail" | "late" | "budget"

function installPage(mode: Mode) {
  const loads: string[] = []
  const removed: string[] = []
  let added = 0
  let resolveLate: (value: boolean) => void = () => {}
  const listeners = new Map<string, Array<(event: any) => void>>()
  const emit = (type: string, url: string, navigationId: string) => {
    for (const fn of listeners.get(type) ?? []) {
      fn({ type, navigationId, isMainFrame: true, state: { url } })
    }
  }
  class WebViewController {
    async addEventListener(type: string, fn: (event: any) => void) {
      added++
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    }
    async removeEventListener(type: string, fn: (event: any) => void) {
      removed.push(type)
      const list = (listeners.get(type) ?? []).filter(item => item !== fn)
      listeners.set(type, list)
    }
    stopLoading() {}
    dispose() {}
    async setCookie() { return true }
    async loadRequest(req: { url: string; timeoutInterval?: number }) {
      loads.push(req.url)
      if (mode === "login" && req.url.includes("olist")) {
        emit("redirect", `https://login.m.taobao.com/login/login.htm?cookie=${SECRET_QUERY}#frag`, "nav-login")
        return false
      }
      if (mode === "app" && req.url.includes("olist")) {
        emit("redirect", `tbopen://m.taobao.com/open?cookie=${SECRET_QUERY}`, "nav-app")
        return false
      }
      if (mode === "timeout-pc" && req.url.includes("olist") && loads.filter(u => u.includes("olist")).length === 1) {
        emit("redirect", `https://www.taobao.com/markets/sale?cookie=${SECRET_QUERY}`, "nav-other")
        return new Promise<boolean>(() => {})
      }
      if (mode === "late" && req.url.includes("olist") && loads.filter(u => u.includes("olist")).length === 1) {
        emit("redirect", `https://h5.m.taobao.com/item/${ORDER_DIGITS}?cookie=${SECRET_QUERY}`, "nav-late")
        return new Promise<boolean>((resolve) => { resolveLate = resolve })
      }
      if (mode === "timer-fail" || mode === "budget") return false
      return true
    }
    async evaluateJavaScript(js: string) {
      if (js.includes("htmlLen")) {
        return JSON.stringify({
          href: "https://h5.m.taobao.com/mlapp/olist.html",
          host: "h5.m.taobao.com",
          ready: "complete",
          htmlLen: 4000,
          ids: "",
          emp: true,
          verify: false,
        })
      }
      if (js.includes("return location.href")) return "https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm"
      if (js.includes("return location.host")) return "buyertrade.taobao.com"
      if (js.includes("没有找到")) return JSON.stringify({ ids: ORDER_DIGITS, emp: false, a: 1, cnt: 1, len: 20, t: "已买到的宝贝" })
      if (js.includes("document.title")) return JSON.stringify({ title: "已买到的宝贝", len: 50000, hasOrder: true, text: "" })
      if (js.includes("bizOrderId[=:")) return 1
      if (js.includes("待收货")) return "no"
      if (js.includes("__ppReq")) return "[]"
      return "0"
    }
  }
  ;(globalThis as { WebViewController?: unknown }).WebViewController = WebViewController
  ;(globalThis as { Keychain?: unknown }).Keychain = {
    get: () => JSON.stringify([{ name: SECRET_NAME, value: SECRET_COOKIE, domain: ".taobao.com" }]),
  }
  return { loads, removed, added: () => added, resolveLate: () => resolveLate(true) }
}

async function runDiscover(deadlineMs: number) {
  installFs()
  const diagId = beginTaobaoDiag()
  let result: string[] | null = null
  let error: unknown = null
  try {
    result = await discoverOrderIds({
      diagId,
      syncId: null,
      roundStart: Date.now(),
      deadline: Date.now() + deadlineMs,
    })
  } catch (e) {
    error = e
  }
  const diag = finishTaobaoDiag(false, error instanceof Error ? error.message : "", diagId)
  return { result, error, diag }
}

test("H5 timeout with 暂无订单 still opens the PC page and can return real orders", async () => {
  fastTimers()
  const page = installPage("timeout-pc")
  const out = await runDiscover(180_000)
  assert.ok(page.loads.some(url => url.includes("buyertrade.taobao.com")))
  assert.deepEqual(out.result, [ORDER_DIGITS])
  const text = JSON.stringify(out.diag)
  assert.match(text, /请求 h5\.m\.taobao\.com\/mlapp\/olist\.html 观察到 www\.taobao\.com\/markets\/sale/)
  assert.equal(text.includes("当前 h5.m.taobao.com"), false)
  assertNoSecrets(text)
  assert.ok(page.removed.length >= 4)
  assert.equal(page.added(), page.removed.length)
})

test("login redirect is recognized before load success and does not open PC", async () => {
  fastTimers()
  const page = installPage("login")
  const out = await runDiscover(180_000)
  assert.equal(out.result, null)
  assert.match(String((out.error as Error)?.message ?? ""), /需重新登录/)
  assert.match(String((out.error as Error)?.message ?? ""), /login\.m\.taobao\.com/)
  assert.equal(page.loads.some(url => url.includes("buyertrade.taobao.com")), false)
  assertNoSecrets(JSON.stringify(out.diag) + String((out.error as Error)?.message ?? ""))
  assert.equal(page.added(), page.removed.length)
})

test("app launch scheme stops for foreground auth and drops the rest of the url", async () => {
  fastTimers()
  const page = installPage("app")
  const out = await runDiscover(180_000)
  const message = String((out.error as Error)?.message ?? "")
  assert.match(message, /前台完成登录或 App 授权/)
  assert.match(message, /tbopen:/)
  assert.equal(page.loads.some(url => url.includes("buyertrade")), false)
  assertNoSecrets(message + JSON.stringify(out.diag))
})

test("salvage timer failure still continues to PC when loadRequest can bound it", async () => {
  globalThis.setTimeout = (() => {
    throw new Error("Timer requires its active script on the main JS execution queue")
  }) as typeof setTimeout
  const page = installPage("timer-fail")
  const out = await runDiscover(180_000)
  assert.ok(page.loads.filter(url => url.includes("olist")).length >= 1)
  assert.ok(page.loads.some(url => url.includes("buyertrade.taobao.com")))
  assert.equal(String((out.error as Error)?.message ?? "").includes("页面计时不可用"), false)
  assertNoSecrets(JSON.stringify(out.diag))
})

test("late load success after timeout does not replace the PC result", async () => {
  fastTimers()
  const page = installPage("late")
  const out = await runDiscover(180_000)
  page.resolveLate()
  await new Promise(resolve => realSetTimeout(resolve, 20))
  assert.deepEqual(out.result, [ORDER_DIGITS])
  assert.ok(page.loads.some(url => url.includes("buyertrade.taobao.com")))
  assertNoSecrets(JSON.stringify(out.diag))
})

test("budget exhaustion after H5 does not start PC", async () => {
  fastTimers()
  const page = installPage("budget")
  const out = await runDiscover(500)
  assert.equal(page.loads.some(url => url.includes("buyertrade")), false)
  assert.match(String((out.error as Error)?.message ?? ""), /预算用尽/)
  assertNoSecrets(JSON.stringify(out.diag))
})
