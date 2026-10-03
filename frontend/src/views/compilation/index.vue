<template>
  <section class="page" data-module="compilation">
    <header class="page-head">
      <div>
        <h2>数据整编管理</h2>
        <p class="page-desc">维护整编成果，围绕成果编号、整编年份、站点编号、整编类型做登记、筛选与状态流转；复核结论与刊印包一次落库。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整编成果</button>
        <button class="btn" type="button" @click="exportRows">导出整编清单</button>
        <button class="btn" type="button" :disabled="!packages.length" @click="exportPackages">
          导出刊印包清单{{ packages.length ? `（${packages.length}）` : '' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 复核处理入口：只列待审核成果；与下方成果列表取同一份数据，结论和列表严格一致。 -->
    <section class="review-panel">
      <h3>复核处理（{{ pendingRows.length }} 条待审核）</h3>
      <p v-if="!pendingRows.length" class="empty-inline">当前没有待审核成果</p>
      <div v-for="row in pendingRows" :key="`review-${String(row.id)}`" class="review-item">
        <div class="review-meta">
          <strong>{{ row['成果编号'] }}</strong>
          <span>站点 {{ row['站点编号'] }}</span>
          <span>整编人 {{ row['整编人'] }}</span>
          <span>提交时间 {{ row['提交时间'] || '—' }}</span>
        </div>
        <div class="review-operate">
          <input
            v-model="comments[row.id]"
            placeholder="填写复核意见（驳回必填，通过可留空）"
            @keyup.enter="decide(row, true)"
          />
          <button class="btn primary" type="button" :disabled="busyId === row.id" @click="decide(row, true)">
            审核通过并刊印
          </button>
          <button class="btn danger" type="button" :disabled="busyId === row.id" @click="decide(row, false)">
            驳回
          </button>
        </div>
      </div>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>提交/审核时间</th>
          <th>复核意见</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td class="time-cell">
            <span>提交：{{ row['提交时间'] || '—' }}</span>
            <span>审核：{{ row['审核时间'] || '—' }}</span>
          </td>
          <td>{{ row['复核意见'] || '—' }}</td>
          <td>
            <span :class="['status-tag', statusClass(row.status)]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!actionsFor(row).length" class="empty-inline">无可用动作</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无数据整编数据，可先登记整编成果</td>
        </tr>
      </tbody>
    </table>

    <section class="review-panel">
      <h3>刊印包（{{ packages.length }} 份，一成果一包）</h3>
      <table v-if="packages.length" class="data-table">
        <thead>
          <tr>
            <th>刊印编号</th><th>成果编号</th><th>站点编号</th><th>审核人</th>
            <th>复核意见</th><th>刊印时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pkg in packages" :key="pkg.刊印编号">
            <td>{{ pkg.刊印编号 }}</td>
            <td>{{ pkg.成果编号 }}</td>
            <td>{{ pkg.站点编号 }}</td>
            <td>{{ pkg.审核人 }}</td>
            <td>{{ pkg.复核意见 }}</td>
            <td>{{ pkg.刊印时间 }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-inline">尚无刊印包，审核通过后自动生成</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条整编记录 · {{ packages.length }} 份刊印包</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  downloadPublications,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  listPublicationPackages,
  runCompilationAction,
  STATUS_COMPILING,
  STATUS_PENDING_COMPILE,
  STATUS_PENDING_REVIEW,
  STATUS_PUBLISHED,
  STATUS_REJECTED,
} from '@/data/compilation-service'
import { useSessionStore } from '@/stores/session'
import type { CompilationRow, EntryRow, PublicationPackage } from '@/data/types'

const meta = moduleMeta('compilation')
const store = useSessionStore()
// 列表只展示业务字段；提交/审核时间、复核意见单独成列，避免重复。
const columns = ['成果编号', '整编年份', '站点编号', '整编类型', '原始记录数', '整编人', '审核人']

const rows = ref<CompilationRow[]>([])
const packages = ref<PublicationPackage[]>([])
const total = ref(0)
const errorMessage = ref('')
const busyId = ref<number | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = ['成果编号', '整编年份', '站点编号']
const comments = reactive<Record<number, string>>({})

const statuses = [
  STATUS_PENDING_COMPILE,
  STATUS_COMPILING,
  STATUS_PENDING_REVIEW,
  STATUS_PUBLISHED,
  STATUS_REJECTED,
]
const pendingRows = computed(() =>
  rows.value.filter((row) => row.status === STATUS_PENDING_REVIEW),
)
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)
const stats = computed(() => [
  { label: '待整编/驳回待修订', value: rows.value.filter((row) =>
    [STATUS_PENDING_COMPILE, STATUS_REJECTED].includes(row.status)).length },
  { label: '整编中', value: rows.value.filter((row) => row.status === STATUS_COMPILING).length },
  { label: '待审核', value: pendingRows.value.length },
  { label: '已刊印成果', value: rows.value.filter((row) => row.status === STATUS_PUBLISHED).length },
])

// 状态机门控：已刊印不出任何动作（含驳回）；待审核只在复核区处理，列表上只保留驳回入口以外的一致性。
function actionsFor(row: EntryRow): string[] {
  switch (row.status) {
    case STATUS_PENDING_COMPILE:
      return ['开始整编']
    case STATUS_COMPILING:
      return ['提交审核']
    case STATUS_PENDING_REVIEW:
      return ['驳回整编']
    case STATUS_REJECTED:
      return ['修订重报']
    case STATUS_PUBLISHED:
    default:
      return []
  }
}

function statusClass(status: string): string {
  if (status === STATUS_PUBLISHED) return 'tag-done'
  if (status === STATUS_REJECTED) return 'tag-bad'
  if (status === STATUS_PENDING_REVIEW) return 'tag-wait'
  return ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportPackages() {
  downloadPublications()
}

function openCreate() {
  errorMessage.value = '整编成果登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const comment = (comments[row.id] ?? '').trim()
  if (action === '驳回整编' && !comment) {
    errorMessage.value = '驳回必须填写复核意见'
    return
  }
  const result = runCompilationAction(Number(row.id), action, {
    reviewer: store.operator,
    comment,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  comments[row.id] = ''
  reload()
}

function decide(row: EntryRow, approved: boolean) {
  errorMessage.value = ''
  const comment = (comments[row.id] ?? '').trim()
  if (!approved && !comment) {
    errorMessage.value = `成果 ${row['成果编号']} 驳回必须填写复核意见`
    return
  }
  busyId.value = row.id
  try {
    const result = runCompilationAction(Number(row.id), approved ? '审核通过' : '驳回整编', {
      reviewer: store.operator,
      comment,
    })
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    comments[row.id] = ''
    reload()
  } finally {
    busyId.value = null
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items as CompilationRow[]
    total.value = payload.total
    packages.value = listPublicationPackages()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据整编列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.review-panel {
  margin: 12px 0;
  padding: 12px 16px;
  border: 1px solid var(--border-color, #d8dee8);
  border-radius: 8px;
  background: #fafbfd;
}
.review-panel h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.review-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px dashed #d8dee8;
  flex-wrap: wrap;
}
.review-meta {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 13px;
}
.review-operate {
  display: flex;
  gap: 8px;
  align-items: center;
}
.review-operate input {
  min-width: 260px;
  padding: 6px 8px;
}
.btn.danger {
  background: #d94c4c;
  color: #fff;
  border-color: #d94c4c;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.status-tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
}
.tag-done {
  background: #e2f5e6;
  color: #1f8a3b;
}
.tag-bad {
  background: #fde7e7;
  color: #c23b3b;
}
.tag-wait {
  background: #fff4d6;
  color: #a07400;
}
.time-cell span {
  display: block;
  font-size: 12px;
  color: #5a6472;
}
.empty-inline {
  color: #8a93a2;
  font-size: 13px;
}
</style>
