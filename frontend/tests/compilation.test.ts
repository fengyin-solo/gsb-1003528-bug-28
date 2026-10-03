import {
  __resetCache,
  __setFaultInjector,
  currentVersion,
  listPackages,
} from '../src/data/local-store'
import {
  listCompilation,
  normalizeCompilation,
  pendingReviews,
  publicationsByStation,
  runCompilationAction,
  STATUS_PENDING_REVIEW,
  STATUS_PUBLISHED,
  STATUS_REJECTED,
} from '../src/data/compilation-service'
import { exportEntries } from '../src/api/local-service'

let passed = 0
let failed = 0
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function findById(id: number) {
  return listCompilation().find((row) => Number(row.id) === id)!
}

// 种子里 COMP-0003 是「待审核」且 pending 被错误地标成 false
const waitRow = findById(3)
assert('旧数据兼容：待审核行归一化后 pending=true', waitRow.pending === true)
assert('旧数据兼容：状态未被改写', waitRow.status === STATUS_PENDING_REVIEW)
assert('旧数据兼容：缺失复核意见补为空串', waitRow['复核意见'] === '')

// 场景1：成果列表与复核入口结果一致
assert('复核入口只列待审核', pendingReviews().every((r) => r.status === STATUS_PENDING_REVIEW))
assert('复核入口数量与列表一致', pendingReviews().length === listCompilation().filter((r) => r.status === STATUS_PENDING_REVIEW).length)

// 场景2：已刊印成果不能被驳回
const approve = runCompilationAction(3, '审核通过', { reviewer: '张三', comment: '数据准确，同意刊印' })
assert('审核通过成功', approve.ok, approve.message)
const published = findById(3)
assert('通过后状态=已刊印', published.status === STATUS_PUBLISHED)
assert('通过后待办标记消失 pending=false', published.pending === false)
assert('通过后异常标记=false', published.abnormal === false)
assert('审核时间已落库', String(published['审核时间']).length > 0)
assert('复核意见已落库', published['复核意见'] === '数据准确，同意刊印')
assert('刊印包恰好生成 1 份', listPackages().length === 1, `实际 ${listPackages().length}`)

const rejectPublished = runCompilationAction(3, '驳回整编', { reviewer: '李四', comment: '想驳回已刊印' })
assert('已刊印成果不能被驳回', !rejectPublished.ok && listPackages().length === 1)
assert('已刊印状态保持不变', findById(3).status === STATUS_PUBLISHED)

// 场景3：复核意见出现在导出清单里
const csv = exportEntries('compilation').content
assert('导出清单包含复核意见列', csv.includes('复核意见'))
assert('导出清单含具体意见内容', csv.includes('数据准确，同意刊印'))
assert('导出清单包含审核时间列', csv.includes('审核时间'))

// 场景4：同一成果重复提交（幂等），只生成一个包
const approveAgain = runCompilationAction(3, '审核通过', { reviewer: '王五' })
assert('重复审核返回幂等成功', approveAgain.ok)
assert('重复审核不产生第二个包', listPackages().length === 1)

// 场景5：两个处理人并发提交（乐观锁版本冲突）
runCompilationAction(1, '开始整编', {})
runCompilationAction(1, '提交审核', {})
const v1 = currentVersion()
// 处理人A先提交成功
const a = runCompilationAction(1, '审核通过', { reviewer: '处理人A', expectedVersion: v1 })
assert('并发：处理人A提交成功', a.ok, a.message)
// 处理人B拿着旧版本号同时提交
const b = runCompilationAction(1, '审核通过', { reviewer: '处理人B', expectedVersion: v1 })
assert('并发：处理人B被版本锁拒绝', !b.ok)
assert('并发：只有一个刊印包', listPackages().length === 2) // COMP-0003 + COMP-0001
assert('并发：审核人保留先提交者', findById(1)['审核人'] === '处理人A')

// 场景6：失败时列表、包体、清单整体回退
runCompilationAction(2, '开始整编', {})
runCompilationAction(2, '提交审核', {})
__setFaultInjector(() => {
  throw new Error('磁盘写入失败（模拟）')
})
const beforeVersion = currentVersion()
const beforeCount = listPackages().length
const fail = runCompilationAction(2, '审核通过', { reviewer: '张三', comment: '应当回退' })
__setFaultInjector(null)
assert('故障：提交返回失败', !fail.ok, fail.message)
assert('故障：成果状态回退为待审核', findById(2).status === STATUS_PENDING_REVIEW)
assert('故障：刊印包数量不变', listPackages().length === beforeCount)
assert('故障：版本号不变（未落库）', currentVersion() === beforeVersion)
const csv2 = exportEntries('compilation').content
assert('故障：导出清单里没有失败意见', !csv2.includes('应当回退'))

// 驳回正常路径：意见必填由 UI 保证；服务端无意见时给默认意见
const reject = runCompilationAction(2, '驳回整编', { reviewer: '审核员', comment: '第3栏数据缺失' })
assert('驳回成功', reject.ok)
const rejected = findById(2)
assert('驳回后状态=已驳回', rejected.status === STATUS_REJECTED)
assert('驳回后仍挂待办 pending=true', rejected.pending === true)
assert('驳回后异常标记=true', rejected.abnormal === true)
assert('驳回意见已落库', rejected['复核意见'] === '第3栏数据缺失')
assert('驳回不产生刊印包', listPackages().length === beforeCount)

// 已驳回不能再驳回，只能修订重报
const rejectAgain = runCompilationAction(2, '驳回整编', { comment: 'x' })
assert('已驳回不能再次驳回', !rejectAgain.ok)
const resubmit = runCompilationAction(2, '修订重报', {})
assert('修订重报回到整编中', resubmit.ok && findById(2).status === '整编中')

// 场景7：站房待办按站点读取刊印结果
const stationPkgs = publicationsByStation('COMP-0001')
assert('站房待办能按站点读到刊印包', stationPkgs.length === 1 && stationPkgs[0].成果编号 === 'COMP-0001')
assert('未刊印站点读不到待办', publicationsByStation('COMP-0002').length === 0)

// 场景8：旧的已刊印记录（缺失审核时间/刊印编号）兼容
const legacy = normalizeCompilation({
  id: 99,
  status: STATUS_PUBLISHED,
  pending: true, // 旧脏数据
  abnormal: true,
  成果编号: 'OLD-1',
  提交时间: '2025-01-01 10:00:00',
} as any)
assert('旧刊印记录状态保持已刊印', legacy.status === STATUS_PUBLISHED)
assert('旧刊印记录 pending 被修正为 false', legacy.pending === false)
assert('旧刊印记录 abnormal 被修正为 false', legacy.abnormal === false)
assert('旧刊印记录审核时间回退提交时间', legacy['审核时间'] === '2025-01-01 10:00:00')

const legacyNoTime = normalizeCompilation({
  id: 100,
  status: STATUS_PUBLISHED,
  pending: true,
  abnormal: false,
  成果编号: 'OLD-2',
} as any)
assert('旧刊印记录无提交时间时审核时间留空', legacyNoTime['审核时间'] === '')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
