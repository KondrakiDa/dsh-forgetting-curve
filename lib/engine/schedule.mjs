// 调度的纯函数层：算 RS、算下次唤醒、应用一次复习结果。
//
// 这里是整个插件的核心，只有四个量在动：
//   ss（存储强度，天）、lastReviewAt、nextAt、misses。
//
// 一条铁律：**这些函数不读时钟、不写存储**。nowMs 一律由调用方传进来。
// 这不是洁癖，是因为所有测试都靠"把 now 往前拨 30 天"来验证行为，
// 一旦函数内部藏了 Date.now()，测试就只能等真实时间过去。

import { DAY_MS, MINUTE_MS } from './params.mjs';

/** 保持率：RS(t) = exp(-(t - lastReviewAt) / SS)，SS 单位是天。 */
export function rsAt(item, nowMs) {
  if (!item) return 0;
  if (item.state === 'archived' || item.state === 'superseded') return 0;
  const ss = Math.max(Number(item.ss) || 0, 1e-6);
  const from = Number(item.lastReviewAt ?? item.createdAt) || 0;
  const dt = Math.max(0, nowMs - from);
  return Math.exp(-dt / (ss * DAY_MS));
}

/** 到期 = 到了 nextAt。learning 和 review 都参与，dormant 不参与（只等线索唤醒）。 */
export function isDue(item, nowMs) {
  if (!item) return false;
  if (item.state !== 'learning' && item.state !== 'review') return false;
  return Number(item.nextAt) <= nowMs;
}

/** learning 阶段用固定密集间隔：10 分钟 → 1 小时 → 9 小时。 */
export function learningNextAt(item, params, fromMs) {
  const seq = params.curve.learning.minutes;
  const idx = Math.min(Math.max(item.n, 0), seq.length - 1);
  return fromMs + seq[idx] * MINUTE_MS;
}

/**
 * review 阶段：下次唤醒 = 现在 + (-ln(hi)) * SS 天。
 * hi 默认 0.368 = 1/e，于是 -ln(hi) ≈ 1，即"下次唤醒 = 当前 SS 天"，
 * 到那一刻 RS 正好落到 0.368——还在"想得起来但有点费劲"的区间，
 * 也就是合意困难最划算的位置。
 */
export function reviewNextAt(item, params, fromMs) {
  const hi = params.curve.window.hi;
  const spanDays = Math.max(item.ss, 1e-6) * -Math.log(hi);
  return Math.round(fromMs + spanDays * DAY_MS);
}

/** 单次 SS 变化的硬上限，防止把 ssGrowth 设成 100 后一次复习把记忆锁死。 */
function clampFactor(factor, params) {
  const cap = params.eval?.maxFactorPerUpdate ?? 3;
  return Math.min(Math.max(factor, 1), cap);
}

/**
 * 应用一次注入结果，返回**新的**条目（不改原对象）。
 *
 * outcome:
 *   used      —— 注入后，模型在随后的回复里用上了这条（或用户接了这个话题）
 *   miss      —— 注入了但完全没被接住
 *   corrected —— 用上了，但被用户否定（"我没说过"/"你记错了"）
 *   recalled  —— 由线索触发从 dormant 里捞回来，并且用上了
 */
export function applyOutcome(item, outcome, params, nowMs) {
  const next = { ...item, updatedAt: nowMs };
  const cap = params.curve.ssCapDays;
  const ssInit = params.kinds[item.kind]?.ssInitDays ?? 1;

  if (outcome === 'used' || outcome === 'recalled') {
    next.misses = 0;
    next.injectCount = (item.injectCount || 0) + 1;
    next.lastInjectAt = nowMs;
    next.lastReviewAt = nowMs;
    next.n = (item.n || 0) + 1;

    // 从 dormant 捞回来的，SS 打对折起步——它证明了自己还有价值，
    // 但脱离检索太久，不该直接按满额继续。
    if (outcome === 'recalled' || item.state === 'dormant') {
      next.ss = Math.max(ssInit, Math.min(item.ss * 0.5, cap));
    } else {
      next.ss = Math.min(item.ss * clampFactor(params.curve.ssGrowth, params), cap);
    }

    const learningLen = params.curve.learning.minutes.length;
    if (item.state === 'learning' && next.n < learningLen) {
      next.state = 'learning';
      next.nextAt = learningNextAt(next, params, nowMs);
    } else {
      next.state = 'review';
      next.nextAt = reviewNextAt(next, params, nowMs);
    }
    return next;
  }

  if (outcome === 'corrected') {
    // 内容被否定：SS 砍半、计数清零、退回 learning 的第一档重学。
    // 不删除——它仍是"曾经记过什么"的证据，页面上要看得到。
    next.misses = 0;
    next.injectCount = (item.injectCount || 0) + 1;
    next.lastInjectAt = nowMs;
    next.lastReviewAt = nowMs;
    next.n = 0;
    next.ss = Math.max(ssInit * 0.5, item.ss * 0.5);
    next.state = 'learning';
    next.nextAt = learningNextAt(next, params, nowMs);
    return next;
  }

  // miss：到了期、给了机会、没接住。
  next.misses = (item.misses || 0) + 1;
  next.injectCount = (item.injectCount || 0) + 1;
  next.lastInjectAt = nowMs;
  if (item.state === 'learning') {
    // learning 阶段 miss 不惩罚，只把下一次机会往后推一档。
    next.n = Math.max(0, (item.n || 0) - 1);
    next.nextAt = learningNextAt(next, params, nowMs);
  } else {
    next.nextAt = reviewNextAt(next, params, nowMs);
  }
  if (next.misses >= (params.curve.dormant?.missRounds ?? 3)) {
    next.state = 'dormant';
    // dormant 不设 nextAt：它不再按时间注入，只等线索。
    next.nextAt = null;
  }
  return next;
}

/** 遗忘风险分档，页面标记用。不做状态转移。 */
export function riskOf(item, params, nowMs) {
  const rs = rsAt(item, nowMs);
  const lo = params.curve.dormant?.rsBelow ?? 0.05;
  if (item.state === 'archived' || item.state === 'superseded') return 'gone';
  if (item.state === 'dormant') return 'dormant';
  if (item.pinned) return 'pinned';
  if (rs <= lo) return 'critical';
  if (rs <= params.curve.window.lo) return 'overdue';
  if (rs <= params.curve.window.hi) return 'due';
  return 'fresh';
}

/**
 * 从候选里挑要注入的条目：先按到期，再按 RS 从低到高。
 * 冷却中的、钉住的（钉住表示"别自动提"）、dormant 的一律不进候选。
 */
export function pickDue(items, params, nowMs, filter = () => true) {
  const cooldownMs = (params.budget.cooldownMinutes ?? 0) * MINUTE_MS;
  return items
    .filter((it) => filter(it))
    .filter((it) => it.state === 'learning' || it.state === 'review')
    .filter((it) => !it.pinned)
    .filter((it) => isDue(it, nowMs))
    .filter((it) => !it.lastInjectAt || nowMs - it.lastInjectAt >= cooldownMs)
    .map((it) => ({ item: it, rs: rsAt(it, nowMs) }))
    .sort((a, b) => a.rs - b.rs)
    .map((x) => x.item);
}
