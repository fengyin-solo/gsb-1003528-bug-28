import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  COMPILATION_KEY,
  listCompilation,
  startCompilation,
  submitForReview,
} from './compilation-workflow'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const DEFAULT_OPERATOR = '值班管理员'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  // 整编成果统一经过 presentRow：修正待办脏标记、补齐已刊印记录的审核时间/包号/复核意见。
  const source = key === COMPILATION_KEY ? listCompilation() : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  operator: string = DEFAULT_OPERATOR,
): ActionResult {
  // 整编成果走专属工作流：源状态受守卫保护，已刊印终态既不能驳回也不能重复刊印。
  if (key === COMPILATION_KEY) {
    try {
      if (action === '开始整编') {
        startCompilation(id, operator)
      } else if (action === '提交审核') {
        submitForReview(id, operator)
      } else if (action === '驳回整编' || action === '复核刊印') {
        return { ok: false, message: `「${action}」请在成果复核入口处理，并填写复核意见` }
      } else {
        return { ok: false, message: `整编成果没有登记「${action}」这个动作` }
      }
      return { ok: true, message: `整编成果已${action}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '整编操作失败' }
    }
  }

  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  // 复核意见里可能带逗号、引号、换行，不做转义会把清单列冲散。
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  // 整编清单与列表同一取数口径：已刊印记录的复核意见、审核时间、刊印包号都来自刊印结果。
  const rows = key === COMPILATION_KEY ? listCompilation() : listRows(key)
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => csvCell(row[field] ?? '')), csvCell(row.status)].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const source = meta.key === COMPILATION_KEY ? listCompilation() : rows[meta.key] ?? []
    return {
      name: meta.name,
      created: source.length,
      pending: source.filter((row) => row.pending).length,
      abnormal: source.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
