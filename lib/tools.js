// 暴露给模型的四个工具。
//
// 设计上只给四个，而且每个都对应一个明确的时机（写 / 查 / 复习 / 更正）。
// 工具太少模型不会用，太多它会乱用——尤其是"删除记忆"这种，v0.1 刻意不给，
// 只在台账页面里留人工入口。

import { bigramsOf, coverage } from './engine/evaluate.mjs';

const KINDS = ['fact', 'preference', 'event', 'relation', 'slang', 'vow'];

const KIND_HINT = {
  fact: '可判真假的事实：住哪、做什么、叫什么',
  preference: '稳定的喜好：不吃什么、喜欢什么',
  event: '带时间的事件：几月几号发生了什么',
  relation: '人际关系：谁和谁是什么关系',
  slang: '黑话/梗及其含义',
  vow: '约定或承诺：答应过什么',
};

function textOut(value) {
  return {
    schema: { type: 'string', description: '给模型看的纯文本结果。' },
    render(_args, v) {
      return [{ type: 'text', text: String(v) }];
    },
  };
}

function days(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1) return `${Math.round(n * 24)} 小时`;
  return `${n.toFixed(1)} 天`;
}

function createNoteTool(engine) {
  return {
    name: 'memory_note',
    description:
      '把一条值得长期保留的事实写进记忆库。只记能被一次反例单独推翻的最小陈述（「不吃香菜」而不是「不喜欢吃蔬菜」）。寒暄、玩笑、一次性情绪不要记。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一条最小事实，例如「主人不吃香菜」' },
        kind: {
          type: 'string',
          enum: KINDS,
          description: KINDS.map((k) => `${k}: ${KIND_HINT[k]}`).join('；'),
        },
        scope: {
          type: 'string',
          description: '可选：记忆归属，例如某个群或私聊的标识。默认 global。',
        },
      },
      required: ['text'],
    },
    output: textOut(),
    async execute(args) {
      const text = String(args?.text || '').trim();
      if (!text) return '没写内容，未记录。';
      const kind = KINDS.includes(args?.kind) ? args.kind : 'fact';
      const it = engine.add({ key: args?.scope || 'global', kind, text });
      return `已记下 ${it.id}（${it.kind}）：${it.text}。首次复习在 ${days(it.ss)} 后。`;
    },
  };
}

function createRecallTool(engine) {
  return {
    name: 'memory_recall',
    description:
      '在记忆库里按话题查找旧事。当对方提到「你还记得」「上次说的那个」，或你不确定某件事以前聊过没有时使用，不要凭印象编。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的话题或关键词' },
        limit: { type: 'integer', description: '最多返回几条，默认 5' },
      },
      required: ['query'],
    },
    output: textOut(),
    async execute(args) {
      const q = String(args?.query || '').trim();
      if (!q) return '没给查询词。';
      const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 20);
      const qGrams = bigramsOf(q);
      const rows = engine
        .list({ includeGone: false })
        .map((it) => ({ it, score: coverage(bigramsOf(it.text), q) }))
        .filter((x) => x.score >= 0.2)
        .sort((a, b) => b.score - a.score || a.it.rs - b.it.rs)
        .slice(0, limit);
      if (!rows.length) return `记忆库里没有和「${q}」相关的内容。`;
      return [
        `和「${q}」相关的记忆（按相关度排序，rs 越低越容易被忘）：`,
        ...rows.map(({ it }) => `- #${it.id} ${it.text}  [${it.kind} · rs=${it.rs.toFixed(2)} · ${it.state}]`),
      ].join('\n');
    },
  };
}

function createDueTool(engine) {
  return {
    name: 'memory_due',
    description:
      '列出此刻该复习的旧记忆——它们已经衰减到快被忘掉的区间。话题转到生活类内容时可以不定期看一眼。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '最多返回几条，默认 3' } },
    },
    output: textOut(),
    async execute(args) {
      const limit = Math.min(Math.max(Number(args?.limit) || 3, 1), 10);
      const r = engine.due({ max: limit });
      if (!r.items.length) return '现在没有到期的记忆。';
      return [
        `该复习的 ${r.items.length} 条（只在跟当前话题确实相关时自然带出，不要说「我记得你说过」）：`,
        ...r.items.map((it) => `- #${it.id} [${it.kind}] ${it.text}（${it.ageDays} 天前记的）`),
      ].join('\n');
    },
  };
}

function createReviewTool(engine) {
  return {
    name: 'memory_review',
    description:
      '更正一条记忆。只有对方明确否定时才调用（「你记错了」「我没说过」），不要自己猜。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆的 id，形如 m_1a2b3c4d5e' },
        outcome: {
          type: 'string',
          enum: ['used', 'miss', 'corrected'],
          description: 'used=用上了；miss=提了但没人接；corrected=内容被否定',
        },
      },
      required: ['id', 'outcome'],
    },
    output: textOut(),
    async execute(args) {
      const id = String(args?.id || '').trim();
      const outcome = String(args?.outcome || '').trim();
      if (!id) return '缺少 id。';
      if (!['used', 'miss', 'corrected'].includes(outcome)) return 'outcome 只能是 used / miss / corrected。';
      try {
        const it = engine.review(id, outcome, 'via memory_review');
        return `已更新 ${it.id}：状态 ${it.state}，强度 ${days(it.ss)}，下次复习约 ${days(it.nextAt ? (it.nextAt - Date.now()) / 86400000 : NaN)} 后。`;
      } catch (err) {
        return `更新失败：${err.message}`;
      }
    },
  };
}

export function createMemoryTools({ engine }) {
  return [
    createNoteTool(engine),
    createRecallTool(engine),
    createDueTool(engine),
    createReviewTool(engine),
  ];
}
