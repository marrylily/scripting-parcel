/**
 * 同一时间只允许一轮全量同步持有淘宝页面。
 * 手动同步取代进行中的自动同步；自动同步遇到未过期的锁则跳过，避免两轮 WebView 互相改诊断。
 * 释放时只清自己的锁，被取代的那轮不能把新锁删掉。
 */

export type SyncKind = "manual" | "auto"

export type LockRecord = {
  id: string
  kind: SyncKind
  deadline: number
}

export type LockStore = {
  read: () => LockRecord | null
  write: (rec: LockRecord | null) => void
}

export class SyncSuperseded extends Error {
  readonly code = "sync-superseded"
  constructor() {
    super("淘宝同步已被新的一次同步取代")
    this.name = "SyncSuperseded"
  }
}

export function isSupersededError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "sync-superseded"
}

export type AcquireResult =
  | { ok: true; id: string; supersededId: string | null }
  | { ok: false; reason: "busy" }

let memory: LockRecord | null = null
let seq = 1
const cleanups = new Map<string, () => void>()
let storeOverride: LockStore | null = null

function defaultStore(): LockStore {
  return {
    read() {
      try {
        if (typeof FileManager === "undefined") return null
        const file = `${FileManager.appGroupDocumentsDirectory}/cc/syncRunLock.json`
        if (!FileManager.existsSync(file)) return null
        const v = JSON.parse(FileManager.readAsStringSync(file) || "null")
        if (!v || typeof v.id !== "string" || !v.id) return null
        const kind: SyncKind = v.kind === "manual" ? "manual" : "auto"
        return { id: v.id, kind, deadline: Number(v.deadline) || 0 }
      } catch {
        return null
      }
    },
    write(rec) {
      try {
        if (typeof FileManager === "undefined") return
        const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
        const file = `${dir}/syncRunLock.json`
        if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
        if (!rec) {
          try { FileManager.removeSync(file) } catch { /* 文件可能已经没了 */ }
          return
        }
        FileManager.writeAsStringSync(file, JSON.stringify(rec))
      } catch { /* 进程内锁仍然有效 */ }
    },
  }
}

function store(): LockStore {
  return storeOverride ?? defaultStore()
}

function disk(): LockRecord | null {
  try { return store().read() } catch { return null }
}

/** 进程内锁优先；磁盘上的 id 变了说明另一个进程已经取代本轮。 */
export function readSyncLock(): LockRecord | null {
  const onDisk = disk()
  if (memory && onDisk && onDisk.id !== memory.id) return onDisk
  return memory ?? onDisk
}

function remember(rec: LockRecord | null): void {
  memory = rec
  try { store().write(rec) } catch { /* 调用方仍以进程内锁为准 */ }
}

function nextLockId(): string {
  seq += 1
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function cancelHolder(id: string): void {
  const fn = cleanups.get(id)
  cleanups.delete(id)
  if (memory?.id === id) memory = null
  try { fn?.() } catch { /* 页面可能已经释放 */ }
}

export function acquireSyncRun(kind: SyncKind, deadline: number, now = Date.now()): AcquireResult {
  const current = readSyncLock()
  const live = !!current && current.deadline > now
  if (live && current && kind === "auto") return { ok: false, reason: "busy" }
  const supersededId = current ? current.id : null
  if (memory && (!current || memory.id !== current.id)) cancelHolder(memory.id)
  if (current) cancelHolder(current.id)
  const id = nextLockId()
  remember({ id, kind, deadline })
  return { ok: true, id, supersededId }
}

export function bindRunCleanup(id: string, fn: () => void): void {
  if (!runIsCurrent(id)) {
    try { fn() } catch { /* 这轮已经不是当前轮 */ }
    return
  }
  cleanups.set(id, fn)
}

export function runIsCurrent(id: string | null): boolean {
  const current = readSyncLock()
  if (id == null) return !current
  return !!current && current.id === id
}

export function releaseSyncRun(id: string): void {
  cleanups.delete(id)
  if (memory?.id === id) memory = null
  const onDisk = disk()
  if (!onDisk || onDisk.id === id) {
    try { store().write(null) } catch { /* 下次过期后仍可被新轮取代 */ }
  }
}

/** 测试用：清空进程内状态。传入的 store 模拟跨进程锁文件。 */
export function resetSyncGateForTests(storeForTests?: LockStore): void {
  memory = null
  cleanups.clear()
  seq = 1
  storeOverride = storeForTests ?? null
}

/** 测试用：假装当前进程看不到内存锁，只看 store（另一个进程）。 */
export function detachSyncMemoryForTests(): void {
  memory = null
  cleanups.clear()
}
