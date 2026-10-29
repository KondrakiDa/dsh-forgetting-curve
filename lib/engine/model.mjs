// 条目模型 + 事件重放。
//
// 设计要点：**事件里存结果，不存规则。**
// reviewed 事件直接带 ss_after / nextAt_after / state_after 的快照，而不是只写
// "outcome=used"，让重放时用当时的参数去重算。原因：参数是会被改的，
// 如果重放依赖"当前参数"，同一份历史在调参后会重放出不同的库，
// 台账上的数字就会随时间漂移，而这种漂移没有任何日志能解释。

import { MINUTE_MS } from './params.mjs';

export function emptyState() {
  return { items: {}, lastSeq: 0 };
}

export function cloneState(s) {
  return JSON.parse(JSON.stringify(s));
}

/** 新建条目：nextAt 在创建时就按当前参数算好并落库（改参数不影响老条目）。 */
export function newItem({ id, key, kind, text, sources, params, nowMs }) {
  const ssInit = params.kinds[kind]?.ssInitDays ?? 1;
  const firstWaitMin = params.curve.learning.minutes[0] ?? 10;
  return {
    id,
    key,
    kind,
    text: String(text || '').trim(),
    sources: Array.isArray(sources) ? sources : [],
    createdAt: nowMs,
    updatedAt: nowMs,
    state: 'learning',
    ss: ssInit,
    n: 0,
    misses: 0,
    injectCount: 0,
    lastInjectAt: null,
    lastReviewAt: null,
    nextAt: Math.round(nowMs + firstWaitMin * MINUTE_MS),
    paramVersion: params.version ?? 1,
    pinned: false,
    supersedes: [],
    supersededBy: null,
    lastRs: 1,
  };
}

export function applyEvent(state, ev) {
  if (!state.items) state.items = {};
  const items = state.items;
  switch (ev.type) {
    case 'created': {
      const it = ev.item;
      if (it && it.id) items[it.id] = { ...it, sources: [...(it.sources || [])] };
      break;
    }

    case 'injected': {
      const it = items[ev.id];
      if (!it) break;
      it.injectCount = (it.injectCount || 0) + 1;
      it.lastInjectAt = ev.at ?? ev.t;
      if (typeof ev.rs === 'number') it.lastRs = ev.rs;
      break;
    }

    case 'reviewed': {
      const it = items[ev.id];
      if (!it) break;
      // patch 是算好的结果快照，不是规则。重放不需要 params。
      Object.assign(it, ev.patch || {});
      it.updatedAt = ev.at ?? ev.t;
      break;
    }

    case 'pinned': {
      const it = items[ev.id];
      if (it) it.pinned = !!ev.value;
      break;
    }

    case 'superseded': {
      const it = items[ev.id];
      if (!it) break;
      it.state = 'superseded';
      it.supersededBy = ev.byId || null;
      it.nextAt = null;
      const nw = items[ev.byId];
      if (nw && Array.isArray(nw.supersedes) && !nw.supersedes.includes(ev.id)) {
        nw.supersedes.push(ev.id);
      }
      break;
    }

    case 'archived': {
      const it = items[ev.id];
      if (!it) break;
      it.state = 'archived';
      it.archivedReason = ev.reason || '';
      it.nextAt = null;
      break;
    }

    case 'text_edited': {
      const it = items[ev.id];
      if (!it) break;
      it.text = ev.text;
      it.editedAt = ev.at ?? ev.t;
      break;
    }

    default:
      break;
  }
  if (typeof ev.seq === 'number') state.lastSeq = Math.max(state.lastSeq, ev.seq);
  return state;
}

/**
 * 把事件流回放到 state。只应用 seq > lastSeq 的部分，所以可以
 * "从 snapshot 起 + 追加增量"，不用每次从头重放。
 */
export function replay(state, events) {
  const out = state || emptyState();
  for (const ev of events) {
    if (typeof ev.seq === 'number' && ev.seq <= out.lastSeq) continue;
    applyEvent(out, ev);
  }
  return out;
}

export function allItems(state) {
  return Object.values(state.items || {}).filter(Boolean);
}

/** 给 injected 事件用的轻量摘要，避免把整条记忆塞进事件流。 */
export function briefOf(item) {
  return { id: item.id, kind: item.kind, text: item.text };
}
