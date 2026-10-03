import {
  commit,
  currentVersion,
  listPackages,
  listRows,
} from '@/data/local-store'
import type {
  CompilationResult,
  CompilationRow,
  EntryRow,
  PublicationPackage,
} from '@/data/types'

// 整编状态机：只有「待审核」能进入审批结论，已刊印是终态，任何「往回走」动作一律拒绝。
export const COMPILATION_KEY = 'compilation'
export const STATUS_PENDING_COMPILE = '待整编'
export const STATUS_COMPILING = '整编中'
export const STATUS_PENDING_REVIEW = '待审核'
export const STATUS_PUBLISHED = '已刊印'
export const STATUS_REJECTED = '已驳回'

// 待办语义只由状态决定，不再用「是不是状态数组最后一个」这种位置判断。
const PENDING_STATUSES = new Set([
  STATUS_PENDING_COMPILE,
  STATUS_COMPILING,
  STATUS_PENDING_REVIEW,
  STATUS_REJECTED,
])

type Transition = {
  from: string[]
  to: string
}

// 动作 -> 允许的源状态。不在表里的动作直接拒绝；已刊印不在任何源状态里，天然不可驳回。
const TRANSITIONS: Record<string, Transition> = {
  开始整编: { from: [STATUS_PENDING_COMPILE], to: STATUS_COMPILING },
  提交审核: { from: [STATUS_COMPILING], to: STATUS_PENDING_REVIEW },
  审核通过: { from: [STATUS_PENDING_REVIEW], to: STATUS_PUBLISHED },
  驳回整编: { from: [STATUS_PENDING_REVIEW], to: STATUS_REJECTED },
  修订重报: { from: [STATUS_REJECTED], to: STATUS_COMPILING },
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function isPendingStatus(status: string): boolean {
  return PENDING_STATUSES.has(status)
}

function text(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 旧数据兼容：老记录没有 pending/审核时间/复核意见等字段，读取时统一补齐而不改写历史状态。
 * 已刊印记录无论缺什么都原样保留状态（必须兼容）；审核时间缺失时回退到提交时间，
 * 两者都没有才留空，绝不为了填字段而伪造刊印时间。
 */
export function normalizeCompilation(row: EntryRow): CompilationRow {
  const status = String(row.status)
  const normalized: CompilationRow = { ...row, status }
  normalized.pending = isPendingStatus(status)
  // 已刊印的旧记录不该被打成异常；被驳回才是异常态。
  if (status === STATUS_PUBLISHED) {
    normalized.abnormal = false
  } else if (status === STATUS_REJECTED) {
    normalized.abnormal = true
  }
  if (normalized.提交时间 === undefined) {
    normalized.提交时间 = ''
  }
  if (normalized.审核时间 === undefined) {
    normalized.审核时间 = status === STATUS_PUBLISHED ? normalized.提交时间 : ''
  }
  if (normalized.复核意见 === undefined) {
    normalized.复核意见 = ''
  }
  return normalized
}

export function listCompilation(): CompilationRow[] {
  return listRows(COMPILATION_KEY).map(normalizeCompilation)
}

export function pendingReviews(): CompilationRow[] {
  return listCompilation().filter((row) => row.status === STATUS_PENDING_REVIEW)
}

export function listPublicationPackages(): PublicationPackage[] {
  return listPackages()
}

function findPackage(
  packages: PublicationPackage[],
  resultCode: string,
): PublicationPackage | undefined {
  return packages.find((item) => item.成果编号 === resultCode)
}

// 其它入口（站房待办）按站点读取刊印结果，一律从刊印包取数，而不是去猜成果状态。
export function publicationsByStation(stationCode: string): PublicationPackage[] {
  const keyword = stationCode.trim()
  if (!keyword) {
    return []
  }
  return listPackages().filter((item) => item.站点编号.includes(keyword))
}

export function recentPublications(limit = 5): PublicationPackage[] {
  return [...listPackages()]
    .sort((a, b) => (a.刊印时间 < b.刊印时间 ? 1 : -1))
    .slice(0, limit)
}

function buildPackage(row: CompilationRow, reviewer: string): PublicationPackage {
  const resultCode = text(row, '成果编号')
  const stationCode = text(row, '站点编号')
  if (!resultCode || !stationCode) {
    throw new Error('成果编号、站点编号缺失，无法生成刊印包')
  }
  const yearValue = row['整编年份']
  return {
    刊印编号: text(row, '刊印编号') || `PUB-${resultCode}`,
    成果编号: resultCode,
    站点编号: stationCode,
    整编年份: typeof yearValue === 'number' ? yearValue : text(row, '整编年份'),
    整编类型: text(row, '整编类型'),
    审核人: reviewer,
    提交时间: text(row, '提交时间'),
    审核时间: text(row, '审核时间'),
    复核意见: text(row, '复核意见'),
    刊印时间: nowText(),
  }
}

function locate(entries: EntryRow[], id: number): number {
  return entries.findIndex((row) => Number(row.id) === id)
}

/**
 * 执行整编动作。审核通过是复合操作：状态、复核意见、刊印包在同一事务里一次落库。
 * options.expectedVersion 是调用方读到的版本号，两个处理人同时提交时后者会拿到冲突，
 * 从而只生成一个刊印包；事务中任一步失败，列表状态、刊印包、导出清单全部回退。
 */
export function runCompilationAction(
  id: number,
  action: string,
  options: { reviewer?: string; comment?: string; expectedVersion?: number } = {},
): CompilationResult {
  const transition = TRANSITIONS[action]
  if (!transition) {
    return { ok: false, message: `整编成果没有登记「${action}」这个动作` }
  }

  // 先在当前快照上做校验并算好新值，事务体内只做纯赋值，避免「校验通过、落库失败」的中间态。
  const entries = listRows(COMPILATION_KEY)
  const index = locate(entries, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的整编成果` }
  }
  const current = normalizeCompilation(entries[index])

  // 并发控制先于一切：调用方带着旧版本号（两个处理人同时提交）时直接报冲突，
  // 不能让后来者误拿到「幂等成功」，否则界面会以为自己也提交了一遍。
  if (options.expectedVersion !== undefined && options.expectedVersion !== currentVersion()) {
    return {
      ok: false,
      message: '该成果刚被其他处理人提交，刊印包已生成，本次提交未重复落库',
    }
  }

  // 幂等：同一成果已刊印时重放「审核通过」直接返回既有包，不报错、不造第二个包；
  // 但对已刊印成果做其它任何动作（含驳回）仍然拒绝。
  if (current.status === STATUS_PUBLISHED) {
    if (action === '审核通过') {
      const existing = findPackage(listPackages(), text(current, '成果编号'))
      if (existing) {
        return { ok: true, message: '该成果已刊印，无需重复提交', entry: current, package: existing }
      }
    }
    return { ok: false, message: '成果已刊印，终态记录不能再驳回或修改' }
  }

  if (!transition.from.includes(current.status)) {
    return {
      ok: false,
      message: `成果当前为「${current.status}」，不能执行「${action}」`,
    }
  }

  const reviewer = (options.reviewer ?? '').trim() || '值班管理员'
  const comment = (options.comment ?? '').trim()
  const stamp = nowText()

  const updated: CompilationRow = {
    ...current,
    status: transition.to,
    pending: isPendingStatus(transition.to),
    abnormal: transition.to === STATUS_REJECTED,
    审核人: reviewer,
  }

  if (action === '提交审核') {
    updated.提交时间 = current.提交时间 || stamp
  }
  if (action === '审核通过' || action === '驳回整编') {
    updated.审核时间 = stamp
    updated.复核意见 =
      comment || (action === '审核通过' ? '审核通过，准予刊印' : '复核不通过，退回修订')
  }

  let packageSnapshot: PublicationPackage | undefined
  let preparedPackage: PublicationPackage | null = null
  if (action === '审核通过') {
    // 幂等：包已存在（重复点击/重放）就直接复用，不再造第二个。
    packageSnapshot = findPackage(listPackages(), text(current, '成果编号'))
    if (packageSnapshot) {
      return {
        ok: true,
        message: '该成果已刊印，无需重复提交',
        entry: current,
        package: packageSnapshot,
      }
    }
    preparedPackage = buildPackage(updated, reviewer)
  }

  const expectedVersion =
    options.expectedVersion === undefined ? currentVersion() : options.expectedVersion

  let committed = false
  try {
    committed = commit((draft) => {
      // 事务体内再次确认：同一份快照被并发改过（行已不存在/状态已变）就中止整笔事务。
      const draftIndex = locate(draft.entries[COMPILATION_KEY] ?? [], id)
      if (draftIndex < 0) {
        throw new Error(`没有找到编号为 ${id} 的整编成果`)
      }
      const draftCurrent = String(draft.entries[COMPILATION_KEY][draftIndex].status)
      if (!transition.from.includes(draftCurrent)) {
        throw new Error('成果状态已被其他处理人改变')
      }
      if (action === '审核通过') {
        const resultCode = text(updated, '成果编号')
        if (findPackage(draft.packages, resultCode)) {
          throw new Error('刊印包已存在，禁止重复生成')
        }
        draft.packages.push(preparedPackage as PublicationPackage)
      }
      draft.entries[COMPILATION_KEY][draftIndex] = updated
    }, expectedVersion)
  } catch (error) {
    // commit 已保证内存/存储回到事务前快照
    return {
      ok: false,
      message: `${action}失败，状态与刊印包已整体回退：${
        error instanceof Error ? error.message : '未知错误'
      }`,
    }
  }

  if (!committed) {
    return {
      ok: false,
      message: '该成果刚被其他处理人提交，刊印包已生成，本次提交未重复落库',
    }
  }

  const finalEntry =
    listCompilation().find((row) => Number(row.id) === id) ?? updated
  return {
    ok: true,
    message:
      action === '审核通过'
        ? '审核通过，成果状态、复核意见与刊印包已一并落库'
        : `已${action}，当前状态「${transition.to}」`,
    entry: finalEntry,
    package: preparedPackage ?? undefined,
  }
}
