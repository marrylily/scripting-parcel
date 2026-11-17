import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { formatBudgetExhausted, pageUrlOf } from "../script/utils/syncSafety.ts"
import {
  evaluateBounded,
  loadPageBounded,
  type TimerSchedule,
} from "../script/utils/pageBound.ts"
import {
  acquireSyncRun,
  bindRunCleanup,
  detachSyncMemoryForTests,
  readSyncLock,
  releaseSyncRun,
  resetSyncGateForTests,
  runIsCurrent,
  type LockRecord,
  type LockStore,
} from "../script/utils/syncGate.ts"
import {
  abandonTaobaoDiag,
  beginTaobaoDiag,
  finishTaobaoDiag,
  readTaobaoDiag,
  recordTaobaoStep,
  resetTaobaoDiagForTests,
} from "../script/utils/taobaoTrace.ts"
import { safeTimeoutRace, tryScheduleTimeout } from "../script/utils/safeTimer.ts"

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  delete (globalThis as { Thread?: unknown }).Thread
  resetSyncGateForTests()
  resetTaobaoDiagForTests()
})

function memStore(): LockStore & { rec: LockRecord | null } {
  const box: LockStore & { rec: LockRecord | null } = {
    rec: null,
    read: () => box.rec,
    write: (rec) => { box.rec = rec },
  }
  return box
}

function arm(msFire = true): { schedule: TimerSchedule; clear: (id: unknown) => void; fire: () => void } {
  let fn: (() => void) | null = null
  let id: ReturnType<typeof setTimeout> | null = null
  return {
    schedule(cb, ms) {
      if (msFire) id = realSetTimeout(cb, ms)
      else fn = cb
      return { id: id ?? 1, scheduled: true }
    },
    clear(timerId) {
      fn = null
      if (timerId != null) realClearTimeout(timerId as ReturnType<typeof setTimeout>)
    },
    fire() { fn?.() },
  }
}

test("manual sync supersedes auto and the old release keeps the new lock", () => {
  const store = memStore()
  resetSyncGateForTests(store)
  const now = Date.now()
  let disposed = 0
  const auto = acquireSyncRun("auto", now + 10_000, now)
  assert.equal(auto.ok, true)
  if (!auto.ok) return
  bindRunCleanup(auto.id, () => { disposed += 1 })
  const manual = acquireSyncRun("manual", now + 10_000, now + 1)
  assert.equal(manual.ok, true)
  if (!manual.ok) return
  assert.equal(manual.supersededId, auto.id)
  assert.equal(disposed, 1)
  assert.equal(runIsCurrent(auto.id), false)
  assert.equal(runIsCurrent(manual.id), true)
  releaseSyncRun(auto.id)
  assert.equal(runIsCurrent(manual.id), true)
  assert.equal(readSyncLock()?.id, manual.id)
  releaseSyncRun(manual.id)
  assert.equal(readSyncLock(), null)
})

test("auto sync does not start while a live lock is held", () => {
  const store = memStore()
  resetSyncGateForTests(store)
  const now = Date.now()
  const first = acquireSyncRun("auto", now + 10_000, now)
  assert.equal(first.ok, true)
  const second = acquireSyncRun("auto", now + 10_000, now + 5)
  assert.deepEqual(second, { ok: false, reason: "busy" })
  if (first.ok) releaseSyncRun(first.id)
})

test("a stale lock can be replaced and a thrown run still clears its own lock", () => {
  const store = memStore()
  resetSyncGateForTests(store)
  const now = Date.now()
  const stale = acquireSyncRun("auto", now - 1, now - 20_000)
  assert.equal(stale.ok, true)
  const next = acquireSyncRun("auto", now + 5_000, now)
  assert.equal(next.ok, true)
  if (!next.ok || !stale.ok) return
  assert.equal(next.supersededId, stale.id)
  try {
    throw new Error("boom")
  } catch {
    releaseSyncRun(next.id)
  }
  const again = acquireSyncRun("manual", now + 5_000, now + 1)
  assert.equal(again.ok, true)
  if (again.ok) releaseSyncRun(again.id)
  assert.equal(store.rec, null)
})

test("another process keeps the lock file until its own release", () => {
  const store = memStore()
  resetSyncGateForTests(store)
  const now = Date.now()
  const first = acquireSyncRun("auto", now + 10_000, now)
  assert.equal(first.ok, true)
  detachSyncMemoryForTests()
  const busy = acquireSyncRun("auto", now + 10_000, now + 1)
  assert.equal(busy.ok, false)
  const manual = acquireSyncRun("manual", now + 10_000, now + 2)
  assert.equal(manual.ok, true)
  if (!manual.ok || !first.ok) return
  releaseSyncRun(first.id)
  assert.equal(runIsCurrent(manual.id), true)
  assert.equal(store.rec?.id, manual.id)
  releaseSyncRun(manual.id)
  assert.equal(store.rec, null)
})

test("timer throw does not wait for the original promise", async () => {
  globalThis.setTimeout = (() => {
    throw new Error("Timer requires its active script on the main JS execution queue")
  }) as typeof setTimeout
  let adopted = false
  let resolveLater: (value: string) => void = () => {}
  const pending = new Promise<string>((resolve) => { resolveLater = resolve })
  const raced = safeTimeoutRace(pending, 5_000, "淘宝·拉物流页超时 5.0s")
  const error = await raced.then(
    (value) => { adopted = true; return value },
    (reason) => reason,
  )
  assert.equal(adopted, false)
  assert.equal(error?.code, "timer-unavailable")
  globalThis.setTimeout = realSetTimeout
  resolveLater("late")
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  assert.equal(adopted, false)
})

test("setTimeout is retried on the main thread after the script queue rejects it", () => {
  let calls = 0
  globalThis.setTimeout = ((fn: () => void) => {
    calls += 1
    if (calls === 1) throw new Error("Timer requires its active script on the main JS execution queue")
    void fn
    return 41
  }) as typeof setTimeout
  ;(globalThis as { Thread?: unknown }).Thread = {
    isMainThread: true,
    runInMain(fn: () => void) { fn() },
  }
  const armed = tryScheduleTimeout(() => {}, 10)
  assert.equal(armed.scheduled, true)
  assert.equal(armed.id, 41)
  assert.equal(calls, 2)
})

test("stalled loadRequest times out, does not wait for a second load, and ignores late success", async () => {
  let resolveLoad: (value: boolean) => void = () => {}
  const pending = new Promise<boolean>((resolve) => { resolveLoad = resolve })
  let stopped = 0
  let secondWait = 0
  let succeeded = false
  const clock = arm()
  const error = await loadPageBounded({
    loadRequest: (request) => {
      assert.equal(request.url, "https://h5.m.taobao.com/mlapp/olist.html")
      assert.equal(request.timeoutInterval, 0.05)
      return pending
    },
    waitForLoad: async () => { secondWait += 1; return true },
    stopLoading: () => { stopped += 1 },
  }, "https://h5.m.taobao.com/mlapp/olist.html", 40, "加载H5订单页", clock.schedule, clock.clear)
    .then((value) => { succeeded = true; return value }, (reason) => reason)
  assert.equal(succeeded, false)
  assert.equal(error?.code, "page-timeout")
  assert.equal(error?.step, "加载H5订单页")
  assert.equal(secondWait, 0)
  assert.equal(stopped, 1)
  resolveLoad(true)
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  assert.equal(succeeded, false)
})

test("missing official timeout and a thrown timer do not start loadURL", async () => {
  let started = 0
  await assert.rejects(
    () => loadPageBounded({
      loadURL: async () => { started += 1; return true },
    }, "https://h5.m.taobao.com/mlapp/olist.html", 1_000, "加载H5订单页", () => {
      throw new Error("Timer requires its active script on the main JS execution queue")
    }, () => {}),
    (error: any) => error?.code === "page-capability" && started === 0,
  )
})

test("waitForLoad is the only load wait when loadRequest is absent", async () => {
  let sawTimeout = false
  const result = loadPageBounded({
    loadURL: () => new Promise<boolean>(() => {}),
    waitForLoad: async (options) => {
      sawTimeout = options?.timeout === 0.05 && options?.cancelOnTimeout === true
      return true
    },
  }, "https://h5.m.taobao.com/mlapp/olist.html", 50, "加载H5订单页", (fn, ms) => ({ id: realSetTimeout(fn, ms), scheduled: true }), (id) => realClearTimeout(id as ReturnType<typeof setTimeout>))
  await result
  assert.equal(sawTimeout, true)
})

test("evaluateJavaScript is not called when the timer cannot be scheduled", async () => {
  let called = 0
  await assert.rejects(
    () => evaluateBounded({
      evaluateJavaScript: async () => { called += 1; return "secret-cookie" },
    }, "return document.cookie", 1_000, "读取H5订单", () => ({ id: 1, scheduled: false }), () => {}),
    (error: any) => error?.code === "page-capability",
  )
  assert.equal(called, 0)
})

test("late evaluateJavaScript success after timeout is not adopted", async () => {
  let resolveEval: (value: string) => void = () => {}
  const pending = new Promise<string>((resolve) => { resolveEval = resolve })
  let adopted = false
  let replaced = 0
  const error = await evaluateBounded({
    evaluateJavaScript: () => pending,
    stopLoading() {},
    loadURL: async (url) => { if (url === "about:blank") replaced += 1; return true },
  }, "return 1", 30, "读取H5订单", (fn, ms) => ({ id: realSetTimeout(fn, ms), scheduled: true }), (id) => realClearTimeout(id as ReturnType<typeof setTimeout>))
    .then((value) => { adopted = value === "orders"; return value }, (reason) => reason)
  assert.equal(adopted, false)
  assert.equal(error?.code, "page-timeout")
  assert.equal(replaced, 1)
  resolveEval("orders")
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  assert.equal(adopted, false)
})

test("stale diagnostics cannot overwrite the current run", () => {
  const files = new Map<string, string>()
  ;(globalThis as { FileManager?: unknown }).FileManager = {
    appGroupDocumentsDirectory: "/app",
    existsSync: (path: string) => files.has(path) || path.endsWith("/cc"),
    readAsStringSync: (path: string) => files.get(path) ?? "",
    writeAsStringSync: (path: string, text: string) => { files.set(path, text) },
    createDirectorySync: () => {},
  }
  resetTaobaoDiagForTests()
  const older = beginTaobaoDiag(1_000)
  recordTaobaoStep("加载H5订单页", 377_700, true, "https://h5.m.taobao.com/mlapp/olist.html?cookie=secret", undefined, older)
  const newer = beginTaobaoDiag(20_000)
  recordTaobaoStep("加载H5订单页", 621_500, true, "https://h5.m.taobao.com/mlapp/olist.html?token=secret", undefined, older)
  recordTaobaoStep("加载H5订单页", 20_000, false, "https://h5.m.taobao.com/mlapp/olist.html?cookie=secret", "cookie=secret", newer)
  assert.equal(finishTaobaoDiag(false, "淘宝·整轮时间预算用尽超时 0.0s", older, 21_000), null)
  const saved = finishTaobaoDiag(false, "淘宝·整轮时间预算用尽超时 138.3s", newer, 21_383)
  assert.ok(saved)
  assert.equal(saved?.runId, newer)
  assert.equal(saved?.totalMs, 1_383)
  assert.equal(saved?.steps.length, 1)
  assert.equal(saved?.steps[0].ms, 20_000)
  assert.equal(saved?.steps[0].ok, false)
  assert.equal(saved?.steps[0].url, "h5.m.taobao.com/mlapp/olist.html")
  assert.equal(saved?.steps[0].note, "cookie=***")
  recordTaobaoStep("加载H5订单页", 400_000, true, "https://h5.m.taobao.com/mlapp/olist.html", undefined, newer)
  abandonTaobaoDiag(older)
  const disk = readTaobaoDiag()
  assert.equal(disk?.runId, newer)
  assert.equal(disk?.steps.length, 1)
  assert.ok((disk?.totalMs ?? 0) < 377_700)
  delete (globalThis as { FileManager?: unknown }).FileManager
})

test("budget text uses the real elapsed time and page urls drop queries", () => {
  assert.equal(formatBudgetExhausted(138_300, "https://h5.m.taobao.com/mlapp/olist.html?cookie=1"), "淘宝·整轮时间预算用尽超时 138.3s h5.m.taobao.com/mlapp/olist.html")
  assert.equal(pageUrlOf("https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?token=abc"), "buyertrade.taobao.com/trade/itemlist/list_bought_items.htm")
})
