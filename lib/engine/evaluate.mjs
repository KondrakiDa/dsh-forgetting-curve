// 隐式评估：判断注入的记忆到底有没有被接住。
//
// 这是整套东西里最容易被做坏的一半。模型自评不可信（它会礼貌地给 5 分），
// 所以这里只用两个外部信号：
//   · 注入之后，用户（不是 AI 自己）发的话和这条记忆相关的程度；
//   · 这句话里有没有「你记错了 / 我没说过」这类否定词。
//
// 相关度用中文 2-gram 覆盖率，不引分词器。它很粗，但方向是对的——
// 而且错了的代价被前面「SS 单次最多 ×2 / ÷2」的上限兜住了。

import fs from 'node:fs';
import path from 'node:path';

const PUNCT = /[\s，。！？,.!?、；;：:「」“”"'`()（）\[\]【】~～\-—_+*=…]/g;

/** 中文按 2-gram 切。不处理英文词边界，够用。 */
export function bigramsOf(text) {
  const s = String(text || '').replace(PUNCT, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

// 这些 gram 几乎出现在任何句子里，留着会让所有记忆都"被接住"。
const STOP_GRAMS = new Set([
  '主人', '我的', '你的', '他们', '我们', '这个', '那个', '什么', '怎么',
  '可以', '就是', '不是', '没有', '还是', '因为', '所以', '如果', '现在',
  '一个', '一下', '知道', '觉得', '真的', '可能', '应该', '不要', '有点',
]);

/**
 * 记忆有多少比例的 gram 出现在这句消息里。
 * 用「记忆覆盖率」而不是 Jaccard：消息通常比记忆长得多，
 * 用 Jaccard 会被消息里的无关内容稀释，永远达不到阈值。
 */
export function coverage(memGrams, text) {
  const msgGrams = bigramsOf(text);
  let hit = 0;
  let total = 0;
  for (const g of memGrams) {
    if (STOP_GRAMS.has(g)) continue;
    total += 1;
    if (msgGrams.has(g)) hit += 1;
  }
  return total ? hit / total : 0;
}

export const RELATED_THRESHOLD = 0.34;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 跑一轮评估。
 *
 * @returns {{checked:number, actions:Array<{id:string,outcome:string,why:string}>}}
 */
export function evaluateOnce({
  root,
  bridgeStatePath,
  params,
  engine,
  now = Date.now(),
  threshold = RELATED_THRESHOLD,
}) {
  const envFile = path.join(root, 'env.json');
  const env = readJson(envFile, {});
  const obs = Array.isArray(env.observations) ? env.observations : [];
  if (!obs.length) return { checked: 0, actions: [] };

  const raw = readJson(bridgeStatePath, null);
  if (!raw || !raw.conversations) return { checked: obs.length, actions: [] };

  const msgs = [];
  for (const [key, conv] of Object.entries(raw.conversations)) {
    for (const m of conv?.recentMessages || []) {
      const t = Number(m.time);
      if (!Number.isFinite(t) || t <= 0) continue;
      msgs.push({
        key,
        time: t,
        isSelf: !!m.isSelf,
        text: String(m.text || m.plain || '').trim(),
      });
    }
  }
  msgs.sort((a, b) => a.time - b.time);

  const patterns = params?.eval?.correctionPatterns || [];
  const keep = [];
  const actions = [];

  for (const o of obs) {
    const memGrams = new Set(o.bigrams || []);
    const since = msgs.filter((m) => m.time > o.at && m.key === o.key);

    let used = false;
    let corrected = false;
    let why = '';

    for (const m of since) {
      // AI 自己说的话不算"用户接住了"——否则模型一提这条记忆就自动算成功，
      // 那评估就退化成了"注入即成功"。
      if (m.isSelf) continue;
      if (coverage(memGrams, m.text) < threshold) continue;
      if (patterns.some((p) => p && m.text.includes(p))) {
        corrected = true;
        why = m.text.slice(0, 40);
        break;
      }
      used = true;
      why = m.text.slice(0, 40);
      break;
    }

    if (corrected) actions.push({ id: o.id, outcome: 'corrected', why });
    else if (used) actions.push({ id: o.id, outcome: 'used', why });
    else if (now > o.expiresAt) actions.push({ id: o.id, outcome: 'miss', why: '窗口内没人接' });
    else keep.push(o);
  }

  let applied = 0;
  for (const a of actions) {
    try {
      engine.review(a.id, a.outcome, a.why);
      applied += 1;
    } catch {
      // 条目可能被手动归档/删掉了，跳过即可，不该让评估中断
    }
  }

  try {
    fs.writeFileSync(envFile, JSON.stringify({ ...env, observations: keep }, null, 2), 'utf8');
  } catch {}

  return { checked: obs.length, applied, actions };
}

/** inject 时调用：登记一条待观察。 */
export function recordObservation({ root, item, now, windowMinutes = 45 }) {
  const envFile = path.join(root, 'env.json');
  const env = readJson(envFile, {});
  const obs = Array.isArray(env.observations) ? env.observations : [];
  obs.push({
    id: item.id,
    key: item.key,
    at: now,
    expiresAt: now + windowMinutes * 60000,
    text: item.text,
    bigrams: [...bigramsOf(item.text)],
  });
  // 上限 80 条：注入很频繁时不能让 env.json 无限长大
  fs.writeFileSync(envFile, JSON.stringify({ ...env, observations: obs.slice(-80) }, null, 2), 'utf8');
}
