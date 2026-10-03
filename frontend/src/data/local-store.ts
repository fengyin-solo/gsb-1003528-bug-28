import { SEED_ROWS } from './seed'
import type { AppState, EntryRow, PrintPackage } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
export const PRINT_PACKAGE_BUCKET = 'printPackages'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshState(): AppState {
  return { entries: clone(SEED_ROWS), printPackages: [] }
}

/**
 * 始终从 localStorage 现读：两个标签页/两个处理人同时提交时，
 * 后提交的一方能看到对方刚落库的刊印包，从而避免同成果生成两份包。
 */
function readState(): AppState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = freshState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AppState>
    // 兼容旧版本只存了 entries 整张表的情况
    const entries = { ...freshState().entries, ...(parsed.entries ?? (parsed as Record<string, EntryRow[]>)) }
    return { entries, printPackages: Array.isArray(parsed.printPackages) ? parsed.printPackages : [] }
  } catch {
    const seeded = freshState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: AppState | null = null

export function appState(): AppState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

/** 丢弃内存缓存并重新读取存储：多标签页场景下相当于刷新页面，看到其它处理人已提交的结果。 */
export function syncState(): AppState {
  cache = readState()
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return appState().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listPrintPackages(): PrintPackage[] {
  return appState().printPackages
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitState((draft) => {
    draft.entries[key] = rows
  })
}

/**
 * 在一次提交里同时改成果状态与刊印包表：只有全部成功才一次性写回 localStorage，
 * 任一步失败抛出错误，存储保持原状（列表、包体、清单一起回退）。
 */
export function commitState(mutate: (draft: AppState) => void): AppState {
  const next = readState()
  try {
    mutate(next)
  } catch (error) {
    // 事务中途失败：丢弃已被改动的草稿，缓存回到存储现状（整体回退）。
    cache = readState()
    throw error
  }
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
  return next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
