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

// 整编成果在通用 EntryRow 之外携带的审批流字段（旧数据可能缺失，读取时统一走 normalize）。
export type CompilationFields = {
  提交时间?: string
  审核时间?: string
  复核意见?: string
  刊印编号?: string
  刊印时间?: string
}

export type CompilationRow = EntryRow & CompilationFields

// 刊印包是独立实体：一份成果最多一份，以成果编号为唯一键，包体与成果状态在同一事务落库。
export type PublicationPackage = {
  刊印编号: string
  成果编号: string
  站点编号: string
  整编年份: string | number
  整编类型: string
  审核人: string
  提交时间: string
  审核时间: string
  复核意见: string
  刊印时间: string
}

export type CompilationResult = ActionResult & {
  entry?: CompilationRow
  package?: PublicationPackage
}

export type CompilationDraft = {
  entries: CompilationRow[]
  packages: PublicationPackage[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
