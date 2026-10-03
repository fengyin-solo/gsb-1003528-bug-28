<template>
  <section class="page" data-module="stationhouse">
    <header class="page-head">
      <div>
        <h2>站房维护管理</h2>
        <p class="page-desc">维护站房维护记录，围绕记录编号、站点编号、维护类型、维护内容做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记站房维护记录</button>
        <button class="btn" type="button" @click="exportRows">导出站房维护清单</button>
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

    <!-- 站房待办直接读取整编刊印结果：按站点关联刊印包，包到了才安排后续维护。 -->
    <section class="publication-panel">
      <h3>整编刊印待办（来自数据整编刊印结果，共 {{ publications.length }} 份）</h3>
      <div class="publication-filter">
        <label>
          <span>按站点编号检索</span>
          <input v-model="stationKeyword" placeholder="如 STAT-0001" />
        </label>
      </div>
      <table v-if="filteredPublications.length" class="data-table">
        <thead>
          <tr>
            <th>刊印编号</th>
            <th>成果编号</th>
            <th>站点编号</th>
            <th>整编类型</th>
            <th>审核人</th>
            <th>复核意见</th>
            <th>刊印时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pkg in filteredPublications" :key="pkg.刊印编号">
            <td>{{ pkg.刊印编号 }}</td>
            <td>{{ pkg.成果编号 }}</td>
            <td>{{ pkg.站点编号 }}</td>
            <td>{{ pkg.整编类型 }}</td>
            <td>{{ pkg.审核人 }}</td>
            <td>{{ pkg.复核意见 }}</td>
            <td>{{ pkg.刊印时间 }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-inline">暂无匹配的刊印结果，整编成果审核通过并刊印后会出现在这里</p>
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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无站房维护数据，可先登记站房维护记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条站房维护记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { publicationsByStation, listPublicationPackages } from '@/data/compilation-service'
import type { EntryRow, PublicationPackage } from '@/data/types'

const meta = moduleMeta('stationhouse')
const columns = ["记录编号", "站点编号", "维护类型", "维护内容", "维护单位", "维护日期", "费用支出", "维护状态"]
const actions = ["安排维护", "确认完工", "通过验收"]
const statuses = ["待安排", "已安排", "施工中", "已完成", "已验收"]
const stats = [{"label": "待维护项数", "value": 0}, {"label": "施工中项数", "value": 0}, {"label": "本月已验收", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 站房待办只认刊印包：空关键词时展示全部已刊印成果，输入站点后按站点过滤。
const stationKeyword = ref('')
const publications = ref<PublicationPackage[]>([])
const filteredPublications = computed(() =>
  stationKeyword.value.trim()
    ? publicationsByStation(stationKeyword.value)
    : publications.value,
)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '站房维护记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    publications.value = listPublicationPackages()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '站房维护列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.publication-panel {
  margin: 12px 0;
  padding: 12px 16px;
  border: 1px solid var(--border-color, #d8dee8);
  border-radius: 8px;
  background: #fafbfd;
}
.publication-panel h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.publication-filter {
  margin-bottom: 8px;
}
.publication-filter input {
  min-width: 220px;
  padding: 6px 8px;
}
.empty-inline {
  color: #8a93a2;
  font-size: 13px;
}
</style>
