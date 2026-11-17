import assert from "node:assert/strict"
import { test } from "node:test"
import { classifySalvage, formatDiscoveryFailure, runStageChain, type StageHit } from "../script/utils/taobaoDiscover.ts"
import { loadPageBounded } from "../script/utils/pageBound.ts"

const h5Timeout = "淘宝·加载H5订单页超时 20.1s h5.m.taobao.com/mlapp/olist.html"
const pcTimeout = "淘宝·加载PC订单页超时 25.0s buyertrade.taobao.com/trade/itemlist/list_bought_items.htm"
const auth = "淘宝需重新登录或完成验证 h5.m.taobao.com/mlapp/olist.html"

test("H5 navigation timeout still allows the PC path to return real orders", async () => {
  const called: string[] = []
  const result = await runStageChain([
    { name: "H5", run: async () => { called.push("h5"); return { type: "miss", detail: h5Timeout } } },
    { name: "PC", run: async () => { called.push("pc"); return { type: "orders", ids: ["1234567890123"], detail: "PC订单 1 单" } } },
    { name: "兜底", run: async () => { called.push("fallback"); return { type: "miss", detail: "不应执行" } } },
  ], { remainingMs: () => 120_000, minMs: 1000, budgetDetail: () => "淘宝·整轮时间预算用尽超时 40.0s" })
  assert.deepEqual(called, ["h5", "pc"])
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.ids, ["1234567890123"])
    assert.equal(result.pageReady, true)
    assert.equal(result.details[0], h5Timeout)
  }
})

test("H5 and PC navigation failures stay unfinished and name both stages", async () => {
  const result = await runStageChain([
    { name: "H5", run: async (): Promise<StageHit> => ({ type: "miss", detail: h5Timeout }) },
    { name: "PC", run: async (): Promise<StageHit> => ({ type: "miss", detail: pcTimeout }) },
  ], { remainingMs: () => 80_000, minMs: 1000, budgetDetail: () => "淘宝·整轮时间预算用尽超时 45.0s" })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.message, /加载H5订单页超时 20\.1s/)
    assert.match(result.message, /加载PC订单页超时 25\.0s/)
  }
})

test("an auth or challenge page stops before the next discovery path", async () => {
  let pc = 0
  const result = await runStageChain([
    { name: "H5", run: async (): Promise<StageHit> => ({ type: "stop", reason: "auth", detail: auth }) },
    { name: "PC", run: async () => { pc += 1; return { type: "orders", ids: ["1234567890123"], detail: "PC" } } },
  ], { remainingMs: () => 120_000, minMs: 1000, budgetDetail: () => "淘宝·整轮时间预算用尽超时 20.0s" })
  assert.equal(pc, 0)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.message, auth)
})

test("budget exhaustion does not start the next page", async () => {
  let pc = 0
  const result = await runStageChain([
    { name: "H5", run: async (): Promise<StageHit> => ({ type: "miss", detail: h5Timeout }) },
    { name: "PC", run: async () => { pc += 1; return { type: "orders", ids: ["1234567890123"], detail: "PC" } } },
  ], { remainingMs: () => 400, minMs: 1000, budgetDetail: () => "淘宝·整轮时间预算用尽超时 40.3s" })
  assert.equal(pc, 0)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /预算用尽超时 40\.3s/)
})

test("real order ids are usable data and an empty document is not a successful sync", () => {
  assert.equal(classifySalvage({
    ids: ["1234567890123"], auth: false, verify: false, readyState: "interactive", htmlLen: 2000, emptyConfirmed: false,
  }), "orders")
  assert.equal(classifySalvage({
    ids: [], auth: false, verify: false, readyState: "loading", htmlLen: 0, emptyConfirmed: false,
  }), "empty-dom")
  assert.equal(classifySalvage({
    ids: [], auth: false, verify: false, readyState: "complete", htmlLen: 8000, emptyConfirmed: true,
  }), "empty-ready")
  assert.equal(classifySalvage({
    ids: ["1234567890123"], auth: false, verify: true, readyState: "complete", htmlLen: 8000, emptyConfirmed: false,
  }), "auth")
  const failure = formatDiscoveryFailure([h5Timeout, "淘宝·超时后读取H5无订单数据"])
  assert.match(failure, /无订单数据/)
  assert.doesNotMatch(failure, /cookie|token/i)
})

test("navigation timeout can leave the document in place for a later read", async () => {
  let stopped = 0
  let resolveLoad: (value: boolean) => void = () => {}
  const pending = new Promise<boolean>((resolve) => { resolveLoad = resolve })
  const error = await loadPageBounded({
    loadRequest: () => pending,
    stopLoading: () => { stopped += 1 },
  }, "https://h5.m.taobao.com/mlapp/olist.html", 30, "加载H5订单页",
    (fn, ms) => ({ id: setTimeout(fn, ms), scheduled: true }),
    (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    false).then(() => null, (reason) => reason)
  assert.equal(error?.code, "page-timeout")
  assert.equal(stopped, 0)
  resolveLoad(true)
})
