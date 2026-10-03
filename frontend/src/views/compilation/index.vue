<template>
  <section class="page" data-module="compilation">
    <header class="page-head">
      <div>
        <h2>数据整编管理</h2>
        <p class="page-desc">整编成果提交后进入复核入口，复核通过一次性生成刊印包；已刊印成果归档，列表、包体与导出清单保持一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整编成果</button>
        <button class="btn" type="button" @click="exportRows">导出数据整编清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待整编年度</span>
        <strong class="stat-value">{{ statCount('待整编') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">整编中年度</span>
        <strong class="stat-value">{{ statCount('整编中') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已刊印成果</span>
        <strong class="stat-value">{{ statCount('已刊印') }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="tab-bar" role="tablist">
      <button
        class="tab"
        :class="{ active: tab === 'list' }"
        type="button"
        role="tab"
        @click="switchTab('list')"
      >
        成果列表
      </button>
      <button
        class="tab"
        :class="{ active: tab === 'review' }"
        type="button"
        role="tab"
        @click="switchTab('review')"
      >
        复核处理（{{ reviewRows.length }}）
      </button>
    </div>

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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.pending" class="tag tag-pending">待办</span>
          </td>
          <td class="row-actions">
            <template v-if="tab === 'review'">
              <button class="link" type="button" @click="openReview(row)">复核处理</button>
            </template>
            <template v-else-if="row.status === '待整编' || row.status === '已驳回'">
              <button class="link" type="button" @click="runAction('开始整编', row)">开始整编</button>
            </template>
            <template v-else-if="row.status === '整编中'">
              <button class="link" type="button" @click="runAction('提交审核', row)">提交审核</button>
            </template>
            <template v-else-if="row.status === '待审核'">
              <button class="link" type="button" @click="switchTab('review')">前往复核</button>
            </template>
            <template v-else-if="row.status === '已刊印'">
              <span class="muted">已归档，不可驳回</span>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            {{ tab === 'review' ? '复核队列暂无待审核成果' : '暂无数据整编数据，可先登记整编成果' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="reviewTarget" class="modal-mask" @click.self="closeReview">
      <div class="modal-card" role="dialog" aria-modal="true">
        <h3>成果复核 · {{ reviewTarget['成果编号'] }}</h3>
        <dl class="review-summary">
          <div><dt>站点/年份</dt><dd>{{ reviewTarget['站点编号'] }} · {{ reviewTarget['整编年份'] }}</dd></div>
          <div><dt>整编类型</dt><dd>{{ reviewTarget['整编类型'] }}</dd></div>
          <div><dt>整编人</dt><dd>{{ reviewTarget['整编人'] || '—' }}</dd></div>
          <div><dt>提交时间</dt><dd>{{ reviewTarget['提交时间'] || '—' }}</dd></div>
        </dl>
        <label class="filter-item review-field">
          <span>复核人</span>
          <input v-model="reviewer" placeholder="请输入复核人" />
        </label>
        <label class="filter-item review-field">
          <span>复核意见</span>
          <textarea v-model="reviewOpinion" rows="3" placeholder="通过可留空；驳回必须填写意见"></textarea>
        </label>
        <p v-if="reviewError" class="error-text">{{ reviewError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeReview">取消</button>
          <button class="btn danger" type="button" :disabled="submitting" @click="confirmReject">驳回</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="confirmApprove">
            {{ submitting ? '刊印提交中…' : '复核通过并刊印' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  approveAndPublish,
  FIELD,
  listCompilation,
  listReviewQueue,
  rejectReview,
} from '@/api/compilation-workflow'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('compilation')
const store = useSessionStore()
const columns = [
  FIELD.code,
  FIELD.year,
  FIELD.station,
  FIELD.category,
  FIELD.recordCount,
  FIELD.compiler,
  FIELD.reviewer,
  FIELD.submittedAt,
  FIELD.reviewedAt,
  FIELD.opinion,
  FIELD.packageNo,
]
const statuses = ['待整编', '整编中', '待审核', '已刊印', '已驳回']

const tab = ref<'list' | 'review'>('list')
const rows = ref<EntryRow[]>([])
const allRowsView = ref<EntryRow[]>([])
const reviewRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = [FIELD.code, FIELD.year, FIELD.station]

// 统计与图例从全部成果派生，状态/刊印包落库后随 reload 一起刷新。
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: allRowsView.value.filter((row) => String(row.status) === status).length,
  })),
)

function statCount(status: string): number {
  return statusSummary.value.find((item) => item.status === status)?.count ?? 0
}

function resetFilters() {
  filters.value = {}
  reload()
}

function switchTab(next: 'list' | 'review') {
  tab.value = next
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '整编成果登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

// ---- 复核处理入口 ----
const reviewTarget = ref<EntryRow | null>(null)
const reviewer = ref(store.operator)
const reviewOpinion = ref('')
const reviewError = ref('')
const submitting = ref(false)

function openReview(row: EntryRow) {
  reviewTarget.value = row
  reviewer.value = store.operator
  reviewOpinion.value = ''
  reviewError.value = ''
}

function closeReview() {
  if (submitting.value) {
    return
  }
  reviewTarget.value = null
}

function confirmReject() {
  if (!reviewTarget.value) {
    return
  }
  reviewError.value = ''
  try {
    rejectReview(Number(reviewTarget.value.id), reviewer.value.trim() || store.operator, reviewOpinion.value)
    reviewTarget.value = null
    reload()
  } catch (error) {
    reviewError.value = error instanceof Error ? error.message : '驳回失败'
  }
}

function confirmApprove() {
  if (!reviewTarget.value) {
    return
  }
  reviewError.value = ''
  submitting.value = true
  // 让出一帧展示「刊印提交中」，也便于模拟两个处理人同时提交的互斥。
  window.setTimeout(() => {
    try {
      approveAndPublish(
        Number(reviewTarget.value?.id),
        reviewer.value.trim() || store.operator,
        reviewOpinion.value,
      )
      reviewTarget.value = null
      reload()
    } catch (error) {
      reviewError.value = error instanceof Error ? error.message : '刊印失败，状态与清单已回退'
    } finally {
      submitting.value = false
    }
  }, 0)
}

function reload() {
  errorMessage.value = ''
  try {
    allRowsView.value = listCompilation()
    reviewRows.value = listReviewQueue()
    if (tab.value === 'review') {
      rows.value = filterReviewRows(reviewRows.value, filters.value)
    } else {
      rows.value = filterReviewRows(allRowsView.value, filters.value)
    }
    total.value = rows.value.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据整编列表读取失败'
  }
}

function filterReviewRows(source: EntryRow[], query: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(query).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return source
  }
  return source.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 复核队列行渲染「复核处理」按钮，直接调用 openReview。

onMounted(reload)
</script>
