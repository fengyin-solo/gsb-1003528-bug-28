import { MODULE_BY_KEY } from '@/data/modules'
import {
  normalizeCompilation,
  listPublicationPackages,
} from '@/data/compilation-service'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 各模块的终态：进入终态即不再挂待办。以前用「状态数组最后一个」判断，
// 整编模块最后一个是「已驳回」，会把已刊印误挂待办、待审核反而消掉。
const DONE_STATUSES: Record<string, string[]> = {
  station: ['正常运行', '汛期加强', '暂停运行', '已撤销'],
  waterlevel: ['已通过', '异常值'],
  discharge: ['已通过', '异常值'],
  rainfall: ['已通过', '异常值'],
  waterquality: ['已出报告', '超标', '已复核'],
  crosssection: ['已校核', '需重测'],
  telemetry: ['正常运行', '已停用'],
  warning: ['已生效', '已调整', '已停用'],
  groundwater: ['已通过', '异常值'],
  evaporation: ['已通过', '异常值'],
  cableway: ['正常运行', '已停用'],
  sediment: ['已通过', '异常值'],
  communication: ['通讯正常', '待更换'],
  stationhouse: ['已完成', '已验收'],
  calibration: ['已合格', '已停用'],
  inspection: ['已巡检', '已处置'],
  plan: ['已批准', '已废止'],
}

function isPending(key: string, status: string): boolean {
  const done = DONE_STATUSES[key]
  return done ? !done.includes(status) : true
}

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
  const source = key === 'compilation' ? listRows(key).map(normalizeCompilation) : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
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
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isPending(key, target),
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
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  // 整编模块必须走归一化：旧记录的审核时间回退提交时间、复核意见缺失补空串，
  // 保证导出清单与列表/复核入口取数完全一致，意见不再在导出里丢失。
  const rows = key === 'compilation' ? listRows(key).map(normalizeCompilation) : listRows(key)
  for (const row of rows) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

// 刊印包导出：包体字段即成果落库字段，其它入口（站房待办）也是从同一份包取数。
export function exportPublications(): { filename: string; content: string } {
  const header = [
    '刊印编号',
    '成果编号',
    '站点编号',
    '整编年份',
    '整编类型',
    '审核人',
    '提交时间',
    '审核时间',
    '复核意见',
    '刊印时间',
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const pkg of listPublicationPackages()) {
    lines.push(header.map((field) => csvCell(pkg[field as keyof typeof pkg] ?? '')).join(','))
  }
  return { filename: '整编成果刊印包清单.csv', content: `\uFEFF${lines.join('\n')}` }
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

export function downloadPublications(): void {
  const { filename, content } = exportPublications()
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
    // 整编模块的旧数据 pending/abnormal 不可信，统一归一化后再统计。
    const entries =
      meta.key === 'compilation'
        ? (rows[meta.key] ?? []).map(normalizeCompilation)
        : rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
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
