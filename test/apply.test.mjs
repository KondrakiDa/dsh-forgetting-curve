// 插件的装配测试：用假 ctx 验证 apply 不炸、注册了什么、工具能不能用。
// 不需要真实 DSH —— 这正是把 host 半写成纯函数的好处。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, resolveDataDir } from '../lib/index.js';

function mockCtx(sink, { withWeb = false } = {}) {
  return {
    systemPrompt: {
      section(o) {
        sink.sections.push(o);
      },
      getSectionOrder(key) {
        if (key === 'STRUCTURED_OUTPUT') return 42;
        throw new Error(`no section ${key}`);
      },
    },
    inject(deps, cb) {
      sink.injected.push(deps.join('+'));
      if (deps.includes('tools')) {
        cb({
          effect(fn, label) {
            sink.effects.push(label);
            for (const _ of fn()) {
              // 生成器体在 register 时执行
            }
          },
          tools: {
            async register(tool) {
              sink.tools.push(tool);
              return () => {};
            },
          },
        });
      }
      if (deps.includes('webServer')) {
        cb({
          reflect: {
            get: () => (withWeb ? { register: () => () => {} } : undefined),
          },
          effect(fn, label) {
            sink.effects.push(label);
            fn();
          },
        });
      }
    },
  };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
}

test('数据目录默认跟随 DSH_HOME', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = 'X:/fake-home';
  try {
    assert.ok(resolveDataDir({}).replace(/\\/g, '/').endsWith('X:/fake-home/memory-curve'));
    assert.equal(resolveDataDir({ dataDir: 'X:/custom' }), 'X:/custom');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('apply 注册一个 section 和四个工具', () => {
  const dir = tmp();
  const sink = { sections: [], tools: [], injected: [], effects: [] };
  apply(mockCtx(sink), { dataDir: dir });

  assert.equal(sink.sections.length, 1);
  assert.equal(sink.sections[0].name, 'memory-curve');
  assert.equal(sink.sections[0].order, 42, 'order 应该取自 STRUCTURED_OUTPUT 的回落值');
  assert.ok(sink.sections[0].text.includes('memory_note'));

  const names = sink.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['memory_due', 'memory_note', 'memory_recall', 'memory_review']);

  // 每个工具都得有参数 schema 和输出声明，否则宿主会拒注册
  for (const t of sink.tools) {
    assert.equal(t.parameters.type, 'object', `${t.name} 缺 parameters`);
    assert.ok(t.output && typeof t.output.render === 'function', `${t.name} 缺 output.render`);
    assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`);
  }
});

test('没有 webServer 的宿主上静默跳过页面', () => {
  const dir = tmp();
  const sink = { sections: [], tools: [], injected: [], effects: [] };
  apply(mockCtx(sink, { withWeb: false }), { dataDir: dir });
  assert.equal(sink.sections.length, 1, 'section 仍然要注册');
});

test('memory_note 入库、memory_recall 查得到、memory_due 初始为空', async () => {
  const dir = tmp();
  const sink = { sections: [], tools: [], injected: [], effects: [] };
  apply(mockCtx(sink), { dataDir: dir });
  const byName = Object.fromEntries(sink.tools.map((t) => [t.name, t]));

  const noted = await byName.memory_note.execute({ text: '主人不吃香菜', kind: 'preference' });
  assert.match(noted, /已记下/);
  assert.match(noted, /preference/);

  const recalled = await byName.memory_recall.execute({ query: '不吃香菜' });
  assert.match(recalled, /主人不吃香菜/);

  const missed = await byName.memory_recall.execute({ query: '服务器宕机' });
  assert.match(missed, /没有/);

  const due = await byName.memory_due.execute({});
  assert.match(due, /没有到期的记忆/, '刚记下的条目 10 分钟后才到期');

  // 空文本不该入库
  const empty = await byName.memory_note.execute({ text: '   ' });
  assert.match(empty, /未记录/);
});

test('memory_review 能改状态，非法 outcome 被拒', async () => {
  const dir = tmp();
  const sink = { sections: [], tools: [], injected: [], effects: [] };
  apply(mockCtx(sink), { dataDir: dir });
  const byName = Object.fromEntries(sink.tools.map((t) => [t.name, t]));

  await byName.memory_note.execute({ text: '主人养了只猫', kind: 'fact' });
  const list = await byName.memory_recall.execute({ query: '主人养了只猫' });
  const id = /m_[0-9a-f]{10}/.exec(list)?.[0];
  assert.ok(id, 'recall 结果里应该带 id');

  const bad = await byName.memory_review.execute({ id, outcome: 'delete' });
  assert.match(bad, /只能是/);

  const good = await byName.memory_review.execute({ id, outcome: 'corrected' });
  assert.match(good, /已更新/);
});
