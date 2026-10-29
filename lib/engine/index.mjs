// 引擎门面：把 store / model / schedule / clock 拼成一个对象。
//
// 对外只暴露 JSON 可序列化的数据和 Promise-free 的同步方法，
// 这样 sidecar、CLI、页面三者可以共享同一套语义。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { Store } from './store.mjs';
import { createRealClock } from './clock.mjs';
import {
  DEFAULT_PARAMS,
  cloneParams,
  mergeParams,
  validateParams,
  paramHash,
  diffParams,
  DAY_MS,
} from './params.mjs';
import { emptyState, replay, newItem, allItems, applyEvent } from './model.mjs';
import { recordObservation } from './evaluate.mjs';
import {
  applyOutcome,
  pickDue,
  rsAt,
  riskOf,
  isDue,
  learningNextAt,
  reviewNextAt,
} from './schedule.mjs';

function genId() {
  return `m_${crypto.randomBytes(5).toString('hex')}`;
}

/** 粗估 token：中文约 1.5 字/token，英文更省。宁可高估，别撑爆预算。 */
function estTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) if (/[\u4e00-\u9fff]/.test(ch)) cjk += 1;
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

export function createEngine({
  root,
  clock = createRealClock(),
  params: paramsOverride,
} = {}) {
  if (!root) throw new Error('createEngine: 需要 root');
  const store = new Store(root);
  store.ensure();

  let params = paramsOverride
    ? cloneParams(paramsOverride)
    : (store.readParams() || cloneParams(DEFAULT_PARAMS));

  const paramErrs = validateParams(params);
  if (paramErrs.length) throw new Error(`参数不合法：${paramErrs.join('；')}`);

  let state = loadState();

  function loadState() {
    const { events } = store.readEvents();
    const snap = store.readSnapshot();
    const st = snap && snap.items
      ? { items: snap.items, lastSeq: snap.lastSeq || 0 }
      : emptyState();
    const out = replay(st, events);
    store.seq = Math.max(store.seq, out.lastSeq);
    return out;
  }

  function persist() {
    store.writeSnapshot({ lastSeq: state.lastSeq, items: state.items, savedAt: Date.now() });
  }

  function commit(ev) {
    const rec = store.appendEvent(ev);
    applyEvent(state, rec);
    persist();
    return rec;
  }

  // ---------- 写入 ----------

  function add({ key, kind, text, sources = [], id } = {}) {
    if (!key) throw new Error('add: 缺少 key（如 private:3439395109 / group:1003685866）');
    if (!params.kinds[kind]) throw new Error(`add: 未知 kind「${kind}」`);
    const clean = String(text || '').trim();
    if (!clean) throw new Error('add: text 不能为空');
    const now = clock.now();
    const item = newItem({ id: id || genId(), key, kind, text: clean, sources, params, nowMs: now });
    commit({ type: 'created', item });
    return state.items[item.id];
  }

  function review(id, outcome, note = '') {
    const it = state.items[id];
    if (!it) throw new Error(`review: 找不到条目 ${id}`);
    if (!['used', 'miss', 'corrected', 'recalled'].includes(outcome)) {
      throw new Error(`review: outcome 必须是 used/miss/corrected/recalled，收到「${outcome}」`);
    }
    const now = clock.now();
    const next = applyOutcome(it, outcome, params, now);
    const patch = {};
    for (const k of ['state', 'ss', 'n', 'misses', 'injectCount', 'lastInjectAt', 'lastReviewAt', 'nextAt']) {
      patch[k] = next[k] === undefined ? null : next[k];
    }
    commit({ type: 'reviewed', id, at: now, outcome, note, patch });
    return state.items[id];
  }

  function pin(id, value = true) {
    if (!state.items[id]) throw new Error(`pin: 找不到条目 ${id}`);
    commit({ type: 'pinned', id, value: !!value });
    return state.items[id];
  }

  function archive(id, reason = '') {
    if (!state.items[id]) throw new Error(`archive: 找不到条目 ${id}`);
    commit({ type: 'archived', id, reason });
    return state.items[id];
  }

  function supersede(id, byId) {
    if (!state.items[id] || !state.items[byId]) throw new Error('supersede: 两个 id 都必须存在');
    if (id === byId) throw new Error('supersede: 不能取代自己');
    commit({ type: 'superseded', id, byId });
    return state.items[id];
  }

  function editText(id, text) {
    if (!state.items[id]) throw new Error(`editText: 找不到条目 ${id}`);
    const clean = String(text || '').trim();
    if (!clean) throw new Error('editText: 内容不能为空');
    commit({ type: 'text_edited', id, at: clock.now(), text: clean });
    return state.items[id];
  }

  // ---------- 读取 ----------

  function list({ key, state: st, kind, sort = 'nextAt', includeGone = false } = {}) {
    let rows = allItems(state);
    if (!includeGone) rows = rows.filter((it) => it.state !== 'archived' && it.state !== 'superseded');
    if (key) rows = rows.filter((it) => it.key === key);
    if (st) rows = rows.filter((it) => it.state === st);
    if (kind) rows = rows.filter((it) => it.kind === kind);
    const now = clock.now();
    const withView = rows.map((it) => view(it, now));
    if (sort === 'rs') withView.sort((a, b) => a.rs - b.rs);
    else if (sort === 'kind') withView.sort((a, b) => a.kind.localeCompare(b.kind) || a.nextAt - b.nextAt);
    else if (sort === 'state') withView.sort((a, b) => a.state.localeCompare(b.state) || a.nextAt - b.nextAt);
    else withView.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
    return withView;
  }

  /** 对外视图：带上算出来的 rs / risk / 剩余时间，页面直接用。 */
  function view(it, now = clock.now()) {
    const rs = rsAt(it, now);
    return {
      ...it,
      rs: Number(rs.toFixed(4)),
      risk: riskOf(it, params, now),
      dueNow: isDue(it, now),
      nextInMs: it.nextAt ? it.nextAt - now : null,
      ageDays: Number(((now - it.createdAt) / DAY_MS).toFixed(2)),
      ssDays: Number((it.ss || 0).toFixed(2)),
      tokens: estTokens(it.text),
    };
  }

  function show(id) {
    const it = state.items[id];
    return it ? view(it) : null;
  }

  /** 待注入候选（不写事件、不改状态），给页面预览和 sidecar 渲染用。 */
  function due({ key, max } = {}) {
    const now = clock.now();
    const picked = pickDue(allItems(state), params, now, (it) => !key || it.key === key);
    const limit = max ?? params.budget.maxPerTurn;
    const out = [];
    let tokens = 0;
    for (const it of picked) {
      const t = estTokens(it.text);
      if (out.length >= limit) break;
      if (out.length > 0 && tokens + t > params.budget.maxTokens) break;
      tokens += t;
      out.push(view(it, now));
    }
    return { items: out, tokens, now };
  }

  /** 真正"这一轮注入了什么"：记事件 + 刷新 due.json。 */
  function inject({ key, max } = {}) {
    const now = clock.now();
    const { items } = due({ key, max });
    for (const it of items) {
      commit({ type: 'injected', id: it.id, at: now, key: it.key, rs: it.rs });
      // 登记待观察：evaluate.mjs 之后会拿它和真实回复比对，判定 used/miss/corrected
      recordObservation({
        root,
        item: it,
        now,
        windowMinutes: params.eval?.windowMinutes ?? 45,
      });
    }
    const payload = writeDue();
    return { injected: items, payload };
  }

  /** 生成 bridge 读取的 due.json。这是唯一被桥接消费的文件。 */
  function writeDue() {
    const now = clock.now();
    const keys = {};
    for (const it of allItems(state)) {
      if (it.state !== 'learning' && it.state !== 'review') continue;
      if (!isDue(it, now)) continue;
      if (it.pinned) continue;
      const arr = keys[it.key] || (keys[it.key] = []);
      arr.push({ it, rs: rsAt(it, now) });
    }
    const payload = {
      generatedAt: now,
      paramVersion: params.version,
      budget: { maxPerTurn: params.budget.maxPerTurn, maxTokens: params.budget.maxTokens },
      keys: {},
    };
    for (const [k, arr] of Object.entries(keys)) {
      arr.sort((a, b) => a.rs - b.rs);
      let used = 0;
      const picked = [];
      for (const { it, rs } of arr) {
        if (picked.length >= params.budget.maxPerTurn) break;
        const t = estTokens(it.text);
        if (picked.length > 0 && used + t > params.budget.maxTokens) break;
        used += t;
        picked.push({
          id: it.id,
          kind: it.kind,
          text: it.text,
          rs: Number(rs.toFixed(3)),
          ageDays: Number(((now - it.createdAt) / DAY_MS).toFixed(1)),
        });
      }
      if (picked.length) payload.keys[k] = { items: picked, tokens: used };
    }
    fs.writeFileSync(path.join(root, 'due.json'), JSON.stringify(payload, null, 2), 'utf8');
    return payload;
  }

  function stats({ key } = {}) {
    const now = clock.now();
    const rows = list({ key, includeGone: true });
    const byState = {};
    const byKind = {};
    for (const it of rows) {
      byState[it.state] = (byState[it.state] || 0) + 1;
      byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    }
    const active = rows.filter((it) => it.state === 'learning' || it.state === 'review');
    const avgRs = active.length
      ? active.reduce((s, it) => s + it.rs, 0) / active.length
      : 0;
    return {
      total: rows.length,
      byState,
      byKind,
      dueNow: active.filter((it) => it.dueNow).length,
      dormant: byState.dormant || 0,
      avgRs: Number(avgRs.toFixed(3)),
      paramVersion: params.version,
      paramHash: paramHash(params),
      lastSeq: state.lastSeq,
    };
  }

  // ---------- 参数 ----------

  function getParams() {
    return {
      params,
      hash: paramHash(params),
      version: params.version,
      history: store.readParamHistory().slice(-20),
    };
  }

  /**
   * 改参数。默认**不重算**已有条目（决策：只见效于新条目），
   * recompute=true 时才按新参数把 nextAt 全部重排——那会一次性推出一批到期记忆，
   * 所以页面里要配"试算"，让人先看到会发生什么。
   */
  function setParams(patch, { recompute = false } = {}) {
    const merged = mergeParams(params, patch);
    merged.version = (params.version || 1) + 1;
    const errs = validateParams(merged);
    if (errs.length) {
      const e = new Error(`参数不合法：${errs.join('；')}`);
      e.details = errs;
      throw e;
    }
    const diff = diffParams(params, merged);
    store.appendParamHistory({
      at: clock.now(),
      from: params.version,
      to: merged.version,
      hash: paramHash(merged),
      diff,
    });
    store.writeParams(merged);
    params = merged;
    if (recompute) recomputeAll();
    return { params, diff };
  }

  /** 试算：不改任何状态，只报告"如果现在按新参数重算，会多出多少到期"。 */
  function previewParams(patch) {
    const merged = mergeParams(params, patch);
    merged.version = (params.version || 1) + 1;
    const errs = validateParams(merged);
    if (errs.length) return { ok: false, errors: errs };
    const now = clock.now();
    let newlyDue = 0;
    let pushedAway = 0;
    const samples = [];
    for (const it of allItems(state)) {
      if (it.state !== 'learning' && it.state !== 'review') continue;
      const from = it.lastReviewAt ?? it.createdAt;
      const nextAt = it.state === 'learning'
        ? learningNextAt(it, merged, from)
        : reviewNextAt(it, merged, from);
      const wasDue = isDue(it, now);
      const willBeDue = nextAt <= now;
      if (!wasDue && willBeDue) {
        newlyDue += 1;
        if (samples.length < 5) samples.push({ id: it.id, text: it.text, kind: it.kind });
      }
      if (wasDue && !willBeDue) pushedAway += 1;
    }
    return { ok: true, newlyDue, pushedAway, samples, diff: diffParams(params, merged) };
  }

  function recomputeAll() {
    const now = clock.now();
    for (const it of allItems(state)) {
      if (it.state === 'learning') {
        it.nextAt = learningNextAt(it, params, it.lastReviewAt ?? it.createdAt);
      } else if (it.state === 'review') {
        it.nextAt = reviewNextAt(it, params, it.lastReviewAt ?? it.createdAt);
      }
    }
    persist();
    return true;
  }

  // ---------- 维护 ----------

  /** 从 items.jsonl 完全重建 snapshot（snapshot 坏掉或怀疑不一致时用）。 */
  function rebuild() {
    const { events, corrupt } = store.readEvents();
    state = replay(emptyState(), events);
    store.seq = state.lastSeq;
    persist();
    return { items: Object.keys(state.items).length, events: events.length, corrupt };
  }

  function info() {
    return { ...store.info(), clock: clock.kind, paramVersion: params.version };
  }

  return {
    // 读
    list,
    show,
    due,
    stats,
    info,
    getParams,
    previewParams,
    // 写
    add,
    review,
    inject,
    pin,
    archive,
    supersede,
    editText,
    writeDue,
    setParams,
    recomputeAll,
    rebuild,
    // 调试
    _state: () => state,
    _params: () => params,
  };
}
