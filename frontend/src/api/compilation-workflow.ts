import { commitState, listRows, listPrintPackages } from '@/data/local-store'
import { COMPILATION_STATUS, type EntryRow, type PrintPackage } from '@/data/types'

// 整编成果字段名集中存放，列表、复核入口、导出取数都从这里走，避免各取各的导致丢列。
export const COMPILATION_KEY = 'compilation'
export const FIELD = {
  code: '成果编号',
  year: '整编年份',
  station: '站点编号',
  category: '整编类型',
  recordCount: '原始记录数',
  compiler: '整编人',
  reviewer: '审核人',
  submittedAt: '提交时间',
  reviewedAt: '审核时间',
  opinion: '复核意见',
  packageNo: '刊印包号',
} as const

const { TODO, IN_PROGRESS, PENDING_REVIEW, PUBLISHED, REJECTED } = COMPILATION_STATUS

// 已刊印是终态；待审核标记只对流转中的三个状态有效。
const OPEN_STATUSES = new Set<string>([TODO, IN_PROGRESS, PENDING_REVIEW])

function isPending(status: string): boolean {
  return OPEN_STATUSES.has(status)
}

function text(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function nowStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 刊印包体指纹：包内任一关键字段被改动都会对不上。 */
export function packageChecksum(input: {
  resultCode: string
  year: string
  stationCode: string
  category: string
  recordCount: string
  submittedBy: string
  submittedAt: string
  reviewer: string
  reviewedAt: string
  opinion: string
}): string {
  const basis = [
    input.resultCode,
    input.year,
    input.stationCode,
    input.category,
    input.recordCount,
    input.submittedBy,
    input.submittedAt,
    input.reviewer,
    input.reviewedAt,
    input.opinion,
  ].join('|')
  let hash = 0x811c9dc5
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function legacyPackageNo(row: EntryRow): string {
  const suffix = text(row, FIELD.code).replace(/[^A-Za-z0-9]/g, '') || `ID-${row.id}`
  return `PK-${suffix}`
}

/**
 * 旧版已刊印成果没有刊印包记录：读时按成果快照补一份虚拟包。
 * 旧成果缺少审核时间时以提交时间兜底（两者都没有才留空），刊印结果仍可被站房待办读取。
 */
export function legacyPackageFor(row: EntryRow): PrintPackage {
  const reviewedAt = text(row, FIELD.reviewedAt) || text(row, FIELD.submittedAt)
  return {
    id: -row.id,
    resultId: row.id,
    resultCode: text(row, FIELD.code),
    packageNo: text(row, FIELD.packageNo) || legacyPackageNo(row),
    stationCode: text(row, FIELD.station),
    year: text(row, FIELD.year),
    category: text(row, FIELD.category),
    submittedBy: text(row, FIELD.compiler),
    submittedAt: text(row, FIELD.submittedAt),
    reviewer: text(row, FIELD.reviewer),
    reviewedAt,
    reviewOpinion: text(row, FIELD.opinion),
    checksum: packageChecksum({
      resultCode: text(row, FIELD.code),
      year: text(row, FIELD.year),
      stationCode: text(row, FIELD.station),
      category: text(row, FIELD.category),
      recordCount: text(row, FIELD.recordCount),
      submittedBy: text(row, FIELD.compiler),
      submittedAt: text(row, FIELD.submittedAt),
      reviewer: text(row, FIELD.reviewer),
      reviewedAt,
      opinion: text(row, FIELD.opinion),
    }),
    createdAt: reviewedAt,
    legacy: true,
  }
}

const packageByResult = new Map<number, PrintPackage>()
function refreshPackageIndex(): void {
  packageByResult.clear()
  for (const pkg of listPrintPackages()) {
    packageByResult.set(pkg.resultId, pkg)
  }
}

/**
 * 刊印结果清单：已落库的包 + 旧版已刊印成果的兼容虚拟包，一成果最多一条。
 * 站房待办等其它入口统一从这里读刊印结果。
 */
export function listPrintResultPackages(): PrintPackage[] {
  refreshPackageIndex()
  const virtual: PrintPackage[] = []
  for (const row of listRows(COMPILATION_KEY)) {
    if (String(row.status) === PUBLISHED && !packageByResult.has(row.id)) {
      virtual.push(legacyPackageFor(row))
    }
  }
  return [...listPrintPackages(), ...virtual].sort((a, b) => a.resultId - b.resultId)
}

/**
 * 列表/导出取数前的统一修正：
 * - 按状态重算待办与异常标记，修掉旧数据里「已刊印仍待审核」的脏标记；
 * - 已刊印成果补齐审核时间（旧记录取提交时间）、刊印包号、复核意见，保证导出不丢列。
 */
export function presentRow(row: EntryRow): EntryRow {
  refreshPackageIndex()
  const status = String(row.status)
  const presented: EntryRow = {
    ...row,
    pending: isPending(status),
    abnormal: status === REJECTED,
  }
  if (status === PUBLISHED) {
    const pkg = packageByResult.get(row.id) ?? legacyPackageFor(row)
    if (!text(presented, FIELD.reviewedAt)) {
      presented[FIELD.reviewedAt] = pkg.reviewedAt
    }
    if (!text(presented, FIELD.packageNo)) {
      presented[FIELD.packageNo] = pkg.packageNo
    }
    if (!text(presented, FIELD.opinion)) {
      presented[FIELD.opinion] = pkg.reviewOpinion
    }
    if (!text(presented, FIELD.reviewer)) {
      presented[FIELD.reviewer] = pkg.reviewer
    }
  }
  return presented
}

export function listCompilation(): EntryRow[] {
  return listRows(COMPILATION_KEY).map(presentRow)
}

/** 复核处理入口：只有待审核成果进队列，已刊印成果不可能出现在这里被驳回。 */
export function listReviewQueue(): EntryRow[] {
  return listRows(COMPILATION_KEY)
    .filter((row) => String(row.status) === PENDING_REVIEW)
    .map(presentRow)
}

export function stationhousePrintTodos(): PrintPackage[] {
  // 站房只关心本系统已刊印的成果，按站点+年份读取最新刊印结果。
  const latest = new Map<string, PrintPackage>()
  for (const pkg of listPrintResultPackages()) {
    const key = `${pkg.stationCode}@${pkg.year}`
    const previous = latest.get(key)
    if (!previous || pkg.resultId > previous.resultId) {
      latest.set(key, pkg)
    }
  }
  return [...latest.values()].sort((a, b) =>
    a.stationCode === b.stationCode
      ? b.year.localeCompare(a.year)
      : a.stationCode.localeCompare(b.stationCode),
  )
}

// 同页面两个处理人几乎同时点「复核刊印」时的进程内互斥（跨标签页由 commitState 现读兜底）。
const publishing = new Set<number>()

export class WorkflowError extends Error {}

function requireRow(id: number): EntryRow {
  const row = listRows(COMPILATION_KEY).find((item) => item.id === id)
  if (!row) {
    throw new WorkflowError(`没有找到编号为 ${id} 的整编成果`)
  }
  return row
}

/** 开始整编：待整编或被驳回后返工的成果可进入整编中；已刊印终态不可动。 */
export function startCompilation(id: number, operator: string): void {
  const current = requireRow(id)
  const status = String(current.status)
  if (status === PUBLISHED) {
    throw new WorkflowError('成果已刊印归档，不能重新整编')
  }
  if (status === IN_PROGRESS) {
    throw new WorkflowError('成果正在整编中，不用重复操作')
  }
  if (status === PENDING_REVIEW) {
    throw new WorkflowError('成果已提交审核，请在复核入口处理')
  }
  commitState((draft) => {
    const rows = draft.entries[COMPILATION_KEY]
    const index = rows.findIndex((row) => row.id === id)
    rows[index] = {
      ...rows[index],
      status: IN_PROGRESS,
      pending: true,
      abnormal: false,
      [FIELD.compiler]: text(rows[index], FIELD.compiler) || operator,
    }
  })
}

/** 提交审核：整编中的成果进入待审核，并落下提交时间。 */
export function submitForReview(id: number, operator: string): PrintPackage | null {
  const current = requireRow(id)
  const status = String(current.status)
  if (status === PUBLISHED) {
    throw new WorkflowError('成果已刊印归档，不能再次提交')
  }
  if (status === PENDING_REVIEW) {
    throw new WorkflowError('成果已在待审核队列，等待复核处理')
  }
  if (status !== IN_PROGRESS) {
    throw new WorkflowError('只有整编中的成果可以提交审核')
  }
  const stamp = nowStamp()
  commitState((draft) => {
    const rows = draft.entries[COMPILATION_KEY]
    const index = rows.findIndex((row) => row.id === id)
    rows[index] = {
      ...rows[index],
      status: PENDING_REVIEW,
      pending: true,
      abnormal: false,
      [FIELD.compiler]: operator,
      [FIELD.submittedAt]: text(rows[index], FIELD.submittedAt) || stamp,
    }
  })
  return null
}

/** 驳回：只允许对待审核成果执行；已刊印成果在此被挡下，驳回意见一并落库。 */
export function rejectReview(id: number, reviewer: string, opinion: string): void {
  const opinionTrimmed = opinion.trim()
  if (!opinionTrimmed) {
    throw new WorkflowError('驳回成果必须填写复核意见')
  }
  const current = requireRow(id)
  const status = String(current.status)
  if (status === PUBLISHED) {
    throw new WorkflowError('成果已刊印归档，不能驳回')
  }
  if (status !== PENDING_REVIEW) {
    throw new WorkflowError('只有待审核成果可以驳回')
  }
  const stamp = nowStamp()
  commitState((draft) => {
    const rows = draft.entries[COMPILATION_KEY]
    const index = rows.findIndex((row) => row.id === id)
    rows[index] = {
      ...rows[index],
      status: REJECTED,
      pending: false,
      abnormal: true,
      [FIELD.reviewer]: reviewer,
      [FIELD.reviewedAt]: stamp,
      [FIELD.opinion]: opinionTrimmed,
    }
  })
}

/**
 * 复核通过并刊印：状态与刊印包在同一次 commitState 里落库。
 * - 同成果已在刊印中：直接拒绝第二个处理人；
 * - 现读存储发现已落过包：判为重复提交并整体回退；
 * - 任一校验失败都不写存储，列表状态、包体、导出清单保持一致。
 */
export function approveAndPublish(id: number, reviewer: string, opinion: string): PrintPackage {
  if (publishing.has(id)) {
    throw new WorkflowError('该成果正在刊印处理中，请勿重复提交，系统只会生成一份刊印包')
  }
  const current = requireRow(id)
  const status = String(current.status)
  if (status === PUBLISHED) {
    throw new WorkflowError('成果已刊印，不能重复刊印')
  }
  if (status !== PENDING_REVIEW) {
    throw new WorkflowError('只有待审核成果可以复核刊印')
  }
  publishing.add(id)
  try {
    let created: PrintPackage | null = null
    commitState((draft) => {
      const rows = draft.entries[COMPILATION_KEY]
      const index = rows.findIndex((row) => row.id === id)
      const row = rows[index]
      if (String(row.status) !== PENDING_REVIEW) {
        // 并发下状态已被另一处理人改掉
        throw new WorkflowError('成果状态已变化，请刷新后重试，本次刊印已回退')
      }
      if (draft.printPackages.some((pkg) => pkg.resultId === id)) {
        throw new WorkflowError('该成果已存在刊印包，重复提交已回退')
      }
      const stamp = nowStamp()
      const submittedAt = text(row, FIELD.submittedAt) || stamp
      const reviewOpinion = opinion.trim() || '复核通过，同意刊印'
      const packageNo = legacyPackageNo(row)
      const pkg: PrintPackage = {
        id: draft.printPackages.reduce((max, item) => Math.max(max, item.id), 0) + 1,
        resultId: row.id,
        resultCode: text(row, FIELD.code),
        packageNo,
        stationCode: text(row, FIELD.station),
        year: text(row, FIELD.year),
        category: text(row, FIELD.category),
        submittedBy: text(row, FIELD.compiler),
        submittedAt,
        reviewer,
        reviewedAt: stamp,
        reviewOpinion,
        checksum: packageChecksum({
          resultCode: text(row, FIELD.code),
          year: text(row, FIELD.year),
          stationCode: text(row, FIELD.station),
          category: text(row, FIELD.category),
          recordCount: text(row, FIELD.recordCount),
          submittedBy: text(row, FIELD.compiler),
          submittedAt,
          reviewer,
          reviewedAt: stamp,
          opinion: reviewOpinion,
        }),
        createdAt: stamp,
      }
      rows[index] = {
        ...row,
        status: PUBLISHED,
        pending: false,
        abnormal: false,
        [FIELD.reviewer]: reviewer,
        [FIELD.reviewedAt]: stamp,
        [FIELD.opinion]: reviewOpinion,
        [FIELD.packageNo]: packageNo,
      }
      draft.printPackages.push(pkg)
      created = pkg
    })
    if (!created) {
      throw new WorkflowError('刊印包生成失败，成果状态与清单已一并回退')
    }
    return created
  } finally {
    publishing.delete(id)
  }
}
