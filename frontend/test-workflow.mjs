// 整编复核工作流端到端验证：用 esbuild 把 @ 别名打包后在 node 里跑 localStorage 模拟。
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

const ENTRY = '.cache-workflow-test-entry.ts'
writeFileSync(
  ENTRY,
  `
export {
  approveAndPublish,
  rejectReview,
  startCompilation,
  submitForReview,
  listCompilation,
  listReviewQueue,
  listPrintResultPackages,
  stationhousePrintTodos,
  WorkflowError,
} from './src/api/compilation-workflow'
export { exportEntries, loadOverview } from './src/api/local-service'
export { appState, syncState } from './src/data/local-store'
`,
)

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: '.cache-workflow-test-bundle.mjs',
  alias: { '@': new URL('./src', import.meta.url).pathname },
})

// 浏览器环境：localStorage
const mem = new Map()
class FakeLocalStorage {
  getItem(k) { return mem.has(k) ? mem.get(k) : null }
  setItem(k, v) { mem.set(k, String(v)) }
  removeItem(k) { mem.delete(k) }
}
globalThis.window = { localStorage: new FakeLocalStorage() }

const wf = await import(new URL('.cache-workflow-test-bundle.mjs', import.meta.url).href)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log('  PASS', name) }
  else { failed += 1; console.error('  FAIL', name, detail) }
}
function expectThrow(name, fn, fragment) {
  try {
    fn()
    check(name, false, '未抛出错误')
  } catch (e) {
    check(name, e.message.includes(fragment), `期望包含「${fragment}」，实际「${e.message}」`)
  }
}

// ---------- 1. 旧版已刊印成果兼容（id=4，无审核时间、无刊印包） ----------
console.log('1. 旧成果兼容')
let rows = wf.listCompilation()
const legacy = rows.find((r) => r.id === 4)
check('旧已刊印成果仍存在', legacy && legacy.status === '已刊印')
check('旧成果缺审核时间时用提交时间兜底', legacy['审核时间'] === '2025-01-15 09:00:00', legacy['审核时间'])
check('旧成果补出刊印包号', !!legacy['刊印包号'], legacy['刊印包号'])
check('旧成果待办标记已清除', legacy.pending === false)
check('旧成果不被当异常', legacy.abnormal === false)
const pkgs = wf.listPrintResultPackages()
check('刊印结果清单含旧成果虚拟包', pkgs.some((p) => p.resultId === 4 && p.legacy === true))
check('一成果最多一条刊印结果', pkgs.filter((p) => p.resultId === 4).length === 1)
const todos = wf.stationhousePrintTodos()
check('站房待办读取到旧刊印结果', todos.some((p) => p.resultId === 4))

// ---------- 2. 待审核 -> 正常刊印 ----------
console.log('2. 复核刊印主流程（id=3）')
wf.approveAndPublish(3, '赵复核', '数据齐全')
rows = wf.listCompilation()
const r3 = rows.find((r) => r.id === 3)
check('刊印后状态为已刊印', r3.status === '已刊印')
check('待审核标记消失', r3.pending === false)
check('审核人/时间/意见/包号落库', r3['审核人'] === '赵复核' && !!r3['审核时间'] && r3['复核意见'] === '数据齐全' && !!r3['刊印包号'])
check('刊印结果清单仍只有一条该成果', wf.listPrintResultPackages().filter((p) => p.resultId === 3).length === 1)
const csv = wf.exportEntries('compilation').content
check('导出清单含复核意见', csv.includes('数据齐全'))
check('导出清单含审核时间', csv.includes(r3['审核时间']))
check('导出清单含刊印包号', csv.includes(r3['刊印包号']))
check('导出清单含旧成果包号', csv.includes(legacy['刊印包号']))
const overview = wf.loadOverview()
const comp = overview.modules.find((m) => m.name === '数据整编')
const pendingCount = wf.listCompilation().filter((r) => r.pending).length
check('看板待处理数与列表一致（已刊印不计）', comp.pending === pendingCount && pendingCount === 2, `看板 ${comp.pending}，列表 ${pendingCount}`)

// ---------- 3. 已刊印不能驳回 ----------
console.log('3. 已刊印终态保护')
expectThrow('列表工作流不能驳回已刊印', () => wf.rejectReview(3, '赵复核', '想驳回'), '不能驳回')
expectThrow('旧已刊印也不能驳回', () => wf.rejectReview(4, '赵复核', '想驳回'), '不能驳回')
expectThrow('已刊印不能重复刊印', () => wf.approveAndPublish(3, '赵复核', ''), '不能重复刊印')
expectThrow('驳回必须填意见', () => wf.rejectReview(2, '赵复核', '   '), '复核意见')
check('已刊印仍只有一个包', wf.listPrintResultPackages().filter((p) => p.resultId === 3).length === 1)

// ---------- 4. 驳回意见落库 + 导出可见 ----------
console.log('4. 驳回链路')
// id=2 当前整编中，先提交再驳回
expectThrow('整编中才能提交：id=1 待整编不能直接驳回', () => wf.rejectReview(1, '赵复核', 'x'), '只有待审核')
wf.startCompilation(1, '王整编')
wf.submitForReview(1, '王整编')
const queue = wf.listReviewQueue()
check('复核队列只含待审核', queue.every((r) => r.status === '待审核') && queue.some((r) => r.id === 1))
wf.rejectReview(1, '赵复核', '缺测次说明，退回补充')
const r1 = wf.listCompilation().find((r) => r.id === 1)
check('驳回后状态已驳回', r1.status === '已驳回')
check('驳回标记异常且不再待办', r1.abnormal === true && r1.pending === false)
check('驳回意见进入导出清单', wf.exportEntries('compilation').content.includes('缺测次说明，退回补充'))
// 驳回后可返工
wf.startCompilation(1, '王整编')
check('驳回后可重新整编', wf.listCompilation().find((r) => r.id === 1).status === '整编中')

// ---------- 5. 并发双提交只生成一个包，失败整体回退 ----------
console.log('5. 并发与回退')
wf.submitForReview(1, '王整编')
// 5a. 先成功刊印一次，第二处理人立刻再提交必须被拒绝，且不产生第二个包
wf.approveAndPublish(1, '赵复核', '通过')
expectThrow('第二处理人重复刊印被整体拒绝', () => wf.approveAndPublish(1, '钱复核', '我也通过'), '不能重复刊印')
check('只生成一个刊印包', wf.listPrintResultPackages().filter((p) => p.resultId === 1).length === 1)
const r1After = wf.listCompilation().find((r) => r.id === 1)
check('包体只保留第一处理人', r1After['审核人'] === '赵复核')

// 5b. 存储层竞态：另一处理人已在本标签页之外完成刊印，本次提交必须整体回退
// id=2 种子即「整编中」，先提交审核
wf.submitForReview(2, '王整编')
// 模拟另一标签页：状态与包体一次落库（完整事务）
const peerRaw = JSON.parse(mem.get('hydrology-monitor-station:entries'))
const peerRow = peerRaw.entries.compilation.find((r) => r.id === 2)
Object.assign(peerRow, {
  status: '已刊印',
  pending: false,
  abnormal: false,
  '审核人': '钱复核',
  '审核时间': '2026-10-01 09:00:00',
  '复核意见': '另一处理人已刊印',
  '刊印包号': 'PK-COMP2025002',
})
peerRaw.printPackages.push({
  id: 999, resultId: 2, resultCode: 'COMP-2025-002', packageNo: 'PK-COMP2025002',
  stationCode: 'STAT-0002', year: '2025', category: '特征值统计',
  submittedBy: '王整编', submittedAt: '2026-10-01 08:00:00', reviewer: '钱复核',
  reviewedAt: '2026-10-01 09:00:00', reviewOpinion: '另一处理人已刊印', checksum: 'abcd',
  createdAt: '2026-10-01 09:00:00',
})
mem.set('hydrology-monitor-station:entries', JSON.stringify(peerRaw))
expectThrow('发现对端已刊印，本次提交整体回退', () => wf.approveAndPublish(2, '赵复核', '通过'), '成果状态已变化')
// 回退后以存储为真相：本标签页不允许再补写第二份包
wf.syncState()
const afterRaw = JSON.parse(mem.get('hydrology-monitor-station:entries'))
const storedR2 = afterRaw.entries.compilation.find((r) => r.id === 2)
check('回退后成果保持对端刊印结果（已刊印）', storedR2.status === '已刊印', storedR2.status)
check('只有对端那一份刊印包', afterRaw.printPackages.filter((p) => p.resultId === 2).length === 1)
check('审核人是对端处理人，第二处理人未覆盖', storedR2['审核人'] === '钱复核')
check('包号与清单一致', storedR2['刊印包号'] === 'PK-COMP2025002')

// ---------- 6. 站房待办始终读刊印结果 ----------
console.log('6. 站房待办')
const t = wf.stationhousePrintTodos()
check('站房待办全部来自已刊印成果', t.length >= 3 && ['STAT-0001', 'STAT-0002', 'STAT-0003'].every((s) => t.some((p) => p.stationCode === s)))
check('同站点同年份取最新成果', t.filter((p) => p.stationCode === 'STAT-0001').length === 1)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
