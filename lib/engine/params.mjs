// 参数定义与校验。
//
// 三条硬规则，写在最前面免得后人踩：
// 1. 参数**只影响新条目**——nextAt 在写入/复习时就算好存进条目里，改参数不会
//    让已有条目的 nextAt 漂移。要全量重算必须显式调用 recomputeAll()。
// 2. 每次参数变更记一条 param_changed 事件，条目上存 paramVersion。
//    否则调参后老数据按旧公式算、新数据按新公式算，台账上的数字会自相矛盾。
// 3. 默认值刻意保守：宁可就少注入一次，也不要注入一条已经过时的记忆。

export const DAY_MS = 86400000;
export const MINUTE_MS = 60000;

export const DEFAULT_PARAMS = {
  version: 1,
  enabled: true,

  // 曲线：RS(t) = exp(-(t - lastReviewAt) / SS)
  curve: {
    // RS 落进 [lo, hi] 视为"该复习了"。默认 hi = 1/e ≈ 0.368，正好让
    // 下次唤起时间 = 当前 SS，行为直观、好调。
    window: { hi: 0.368, lo: 0.15 },
    // 每次成功复习 SS 乘以这个倍数（封顶见 ssCapDays）。
    ssGrowth: 2.6,
    // SS 上限：防止一条记忆被复习到"一万年后再见"，那等于永远不会再被提起。
    ssCapDays: 180,
    // dormant 的判定：连续 missRounds 次到期注入都没被用上，且 RS 已低于 rsBelow。
    dormant: { rsBelow: 0.05, missRounds: 3 },
    // learning 阶段的密集巩固间隔（分钟）。三档走完进 review。
    learning: { minutes: [10, 60, 540] },
  },

  // 注入预算：每轮最多几条、多少 token、以及同一条记忆的冷却时间。
  // 冷却用时间而不是"轮次"：桥接是拉模式，没有全局轮次计数，
  // 用时间至少语义确定——6 小时内同一件事不会被提第二次。
  budget: {
    maxPerTurn: 2,
    maxTokens: 120,
    cooldownMinutes: 360,
  },

  // 抽取：每积累多少条消息触发一次批量抽取，单批最多产出几条候选。
  extract: {
    everyMessages: 30,
    maxPerBatch: 8,
  },

  // 评估：单次更新幅度上限（防止一次误判把 SS 推飞），以及"用户在纠正"的线索。
  eval: {
    maxFactorPerUpdate: 3,
    // 注入后观察多久。太短会把"晚点才回"误判成 miss，太长会让 SS 更新滞后。
    windowMinutes: 45,
    correctionPatterns: [
      '你记错',
      '记错了',
      '我没说过',
      '没有这回事',
      '不是这样',
      '你搞错',
      '谁跟你说的',
    ],
  },

  // 六类记忆的初始 SS（天）。衰减快慢的差异全部体现在这里。
  kinds: {
    fact: { ssInitDays: 1 },
    preference: { ssInitDays: 2 },
    event: { ssInitDays: 3 },
    relation: { ssInitDays: 4 },
    slang: { ssInitDays: 1 },
    vow: { ssInitDays: 7 },
  },
};

export const KIND_NAMES = Object.keys(DEFAULT_PARAMS.kinds);

export function cloneParams(p = DEFAULT_PARAMS) {
  return JSON.parse(JSON.stringify(p));
}

/** 键排序后的稳定序列化，用于算 hash 与做 diff。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** 非加密哈希，只用来判断"参数是不是变了"，不用于安全场景。 */
export function paramHash(p) {
  const s = stableStringify(p);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * 校验参数，返回错误数组（空数组 = 合法）。
 * 这些约束不是洁癖：window.lo >= window.hi 会让"到期窗口"变成空集，
 * 表现是记忆永远不注入，而且日志里一句报错都没有，非常难查。
 */
export function validateParams(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['参数必须是对象'];

  const c = p.curve || {};
  const w = c.window || {};
  if (!isNum(w.hi) || w.hi <= 0 || w.hi >= 1) errs.push('curve.window.hi 必须在 (0,1) 之间');
  if (!isNum(w.lo) || w.lo <= 0 || w.lo >= 1) errs.push('curve.window.lo 必须在 (0,1) 之间');
  if (isNum(w.hi) && isNum(w.lo) && w.lo >= w.hi) errs.push('curve.window.lo 必须小于 hi，否则永远不会到期');
  if (!isNum(c.ssGrowth) || c.ssGrowth <= 1) errs.push('curve.ssGrowth 必须 > 1（等于 1 表示复习不增长）');
  if (!isNum(c.ssCapDays) || c.ssCapDays <= 0) errs.push('curve.ssCapDays 必须 > 0');
  if (!Array.isArray(c.learning?.minutes) || c.learning.minutes.length === 0) {
    errs.push('curve.learning.minutes 必须是非空数组');
  } else if (c.learning.minutes.some((m) => !isNum(m) || m <= 0)) {
    errs.push('curve.learning.minutes 的每一项都必须是正数');
  }
  if (!isNum(c.dormant?.missRounds) || c.dormant.missRounds < 1) errs.push('curve.dormant.missRounds 必须 >= 1');
  if (!isNum(c.dormant?.rsBelow) || c.dormant.rsBelow < 0) errs.push('curve.dormant.rsBelow 必须 >= 0');

  const b = p.budget || {};
  if (!Number.isInteger(b.maxPerTurn) || b.maxPerTurn < 0) errs.push('budget.maxPerTurn 必须是非负整数');
  if (!isNum(b.maxTokens) || b.maxTokens <= 0) errs.push('budget.maxTokens 必须 > 0');
  if (!isNum(b.cooldownMinutes) || b.cooldownMinutes < 0) errs.push('budget.cooldownMinutes 必须 >= 0');

  const e = p.extract || {};
  if (!Number.isInteger(e.everyMessages) || e.everyMessages < 1) errs.push('extract.everyMessages 必须是正整数');
  if (!Number.isInteger(e.maxPerBatch) || e.maxPerBatch < 1) errs.push('extract.maxPerBatch 必须是正整数');

  const ev = p.eval || {};
  if (!isNum(ev.maxFactorPerUpdate) || ev.maxFactorPerUpdate < 1) errs.push('eval.maxFactorPerUpdate 必须 >= 1');
  if (!Array.isArray(ev.correctionPatterns)) errs.push('eval.correctionPatterns 必须是数组');
  if (!isNum(ev.windowMinutes) || ev.windowMinutes <= 0) errs.push('eval.windowMinutes 必须 > 0');

  for (const kind of KIND_NAMES) {
    const k = p.kinds?.[kind];
    if (!k) errs.push(`kinds.${kind} 缺失`);
    else if (!isNum(k.ssInitDays) || k.ssInitDays <= 0) errs.push(`kinds.${kind}.ssInitDays 必须 > 0`);
  }

  return errs;
}

/** 浅合并补齐：页面只提交被改动的分支时，其余字段仍取默认值。 */
export function mergeParams(base, patch, depth = 0) {
  if (depth > 6) return patch; // 防御：参数树不该有这么深
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = base?.[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)
      ? mergeParams(cur, v, depth + 1)
      : v;
  }
  return out;
}

/** 列出两份参数的差异，给"变更记录"和页面的 diff 视图用。 */
export function diffParams(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const va = a?.[k];
    const vb = b?.[k];
    const objA = va && typeof va === 'object' && !Array.isArray(va);
    const objB = vb && typeof vb === 'object' && !Array.isArray(vb);
    if (objA && objB) {
      out.push(...diffParams(va, vb, path));
      continue;
    }
    if (stableStringify(va) !== stableStringify(vb)) {
      out.push({ path, from: va, to: vb });
    }
  }
  return out;
}
