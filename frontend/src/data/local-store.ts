import { SEED_ROWS } from './seed'
import type { EntryRow, PublicationPackage } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
const PACKAGE_KEY = 'hydrology-monitor-station:publication-packages'
// 每次整体提交都自改版本号：后提交的人若带着旧版本号，说明期间已被别人改过，必须整笔回退。
const VERSION_KEY = 'hydrology-monitor-station:version'

export type StoredData = {
  entries: Record<string, EntryRow[]>
  packages: PublicationPackage[]
  version: number
}

export type CommitPatch = {
  entries?: Record<string, EntryRow[]>
  packages?: PublicationPackage[]
}

// 测试用：置为非空函数时，事务在状态算完、落库之前被调用并抛错，模拟「刊印包生成失败」。
let faultInjector: (() => void) | null = null
export function __setFaultInjector(fn: (() => void) | null): void {
  faultInjector = fn
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function emptyState(): StoredData {
  return { entries: clone(SEED_ROWS), packages: [], version: 1 }
}

function readStorage(): StoredData {
  const fallback = emptyState()
  if (!hasStorage()) {
    return fallback
  }
  const rawEntries = window.localStorage.getItem(STORAGE_KEY)
  const rawPackages = window.localStorage.getItem(PACKAGE_KEY)
  const rawVersion = window.localStorage.getItem(VERSION_KEY)
  if (!rawEntries && !rawPackages) {
    writeStorage(fallback)
    return fallback
  }
  try {
    const parsedEntries = rawEntries
      ? (JSON.parse(rawEntries) as Record<string, EntryRow[]>)
      : {}
    const parsedPackages = rawPackages ? (JSON.parse(rawPackages) as PublicationPackage[]) : []
    // 旧版本只存了 entries：以种子为底合并，保证后来新增模块的示例数据不丢。
    return {
      entries: { ...clone(SEED_ROWS), ...parsedEntries },
      packages: parsedPackages,
      version: rawVersion ? Number(rawVersion) || 1 : 1,
    }
  } catch {
    writeStorage(fallback)
    return fallback
  }
}

function writeStorage(state: StoredData): void {
  if (!hasStorage()) {
    cache = state
    return
  }
  // 先写临时键再切换：setItem 抛错（如配额超限）时正式键保持原值，事务不留半截数据。
  window.localStorage.setItem(`${STORAGE_KEY}:tmp`, JSON.stringify(state.entries))
  window.localStorage.setItem(`${PACKAGE_KEY}:tmp`, JSON.stringify(state.packages))
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries))
  window.localStorage.setItem(PACKAGE_KEY, JSON.stringify(state.packages))
  window.localStorage.setItem(VERSION_KEY, String(state.version))
  window.localStorage.removeItem(`${STORAGE_KEY}:tmp`)
  window.localStorage.removeItem(`${PACKAGE_KEY}:tmp`)
}

let cache: StoredData | null = null

function state(): StoredData {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return state().entries
}

export function listRows(key: string): EntryRow[] {
  return state().entries[key] ?? []
}

export function listPackages(): PublicationPackage[] {
  return state().packages
}

export function currentVersion(): number {
  return state().version
}

/**
 * 事务提交：在一份快照上改完再整体落库。
 * - expectedVersion 用于并发控制，提交时版本对不上直接拒绝（乐观锁）。
 * - mutate 在落库前抛错（含故障注入）则整笔回退，列表、包体、清单都不会留下半成品。
 * 返回 false 表示版本冲突，调用方应提示「已被他人处理」而不是重试覆盖。
 */
export function commit(
  mutate: (draft: {
    entries: Record<string, EntryRow[]>
    packages: PublicationPackage[]
  }) => void,
  expectedVersion?: number,
): boolean {
  const before = state()
  if (expectedVersion !== undefined && before.version !== expectedVersion) {
    return false
  }
  const nextEntries = clone(before.entries)
  const nextPackages = clone(before.packages)
  try {
    mutate({ entries: nextEntries, packages: nextPackages })
    if (faultInjector) {
      faultInjector()
    }
    const next: StoredData = {
      entries: nextEntries,
      packages: nextPackages,
      version: before.version + 1,
    }
    writeStorage(next)
    cache = next
    return true
  } catch (error) {
    // 内存与 localStorage 都保持事务前快照
    cache = before
    throw error
  }
}

// 单模块便捷写入，仍走同一事务，保证状态与包体之外的普通动作也有版本号。
export function saveRows(key: string, rows: EntryRow[]): void {
  commit((draft) => {
    draft.entries[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 测试用：清空内存缓存，下次读取重新从 localStorage 装载。
export function __resetCache(): void {
  cache = null
}
