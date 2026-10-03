/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 整编成果状态：与 modules 元数据保持一致，流转规则见 compilation-workflow.ts。 */
export const COMPILATION_STATUS = {
  TODO: '待整编',
  IN_PROGRESS: '整编中',
  PENDING_REVIEW: '待审核',
  PUBLISHED: '已刊印',
  REJECTED: '已驳回',
} as const

/**
 * 刊印包：成果复核通过后生成，一成果最多一份。
 * reviewedAt 缺失的旧成果以提交时间兜底（effectiveReviewedAt），保证已刊印记录仍可展示与导出。
 */
export type PrintPackage = {
  id: number
  resultId: number
  resultCode: string
  packageNo: string
  stationCode: string
  year: string
  category: string
  submittedBy: string
  submittedAt: string
  reviewer: string
  reviewedAt: string
  reviewOpinion: string
  checksum: string
  createdAt: string
  legacy?: boolean
}

/** localStorage 整库：整编成果与刊印包在同一存储桶内一次性提交，模拟后端事务。 */
export type AppState = {
  entries: Record<string, EntryRow[]>
  printPackages: PrintPackage[]
}
