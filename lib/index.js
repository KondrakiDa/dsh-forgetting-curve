// 插件入口。
//
// 三个挂载点：
//   1. systemPrompt.section —— 告诉模型这个记忆系统存在、什么时候用；
//   2. tools.register       —— 四个工具（写/查/复习/更正）；
//   3. webServer.register   —— 台账与调参页面，托管在 /plugins/dsh-memory-curve/。
//
// 这里刻意不碰 bridge.js、不起后台进程。插件装进 DSH 之后对**所有会话**生效，
// QQ 桥接的会话也是 DSH 会话，所以它自动就吃到了——不需要任何渠道专用代码。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEngine } from './engine/index.mjs';
import { createMemoryTools } from './tools.js';
import { SECTION_NAME, SECTION_TEXT, resolveOrder } from './inject.js';
import { createPageHandler, MEMORY_ROUTE } from './server.js';

export const name = 'dsh-forgetting-curve';
// 用了 systemPrompt 和 tools 两个 seam；webServer 是可选注入（inject 里不写死，
// 用 ctx.inject 按需取），这样在没有 web 服务的宿主上也能装。
export const inject = ['systemPrompt', 'tools'];

/**
 * 数据目录：默认跟 DSH_HOME 走，和 DSH 其他状态放一起。
 * 插件被卸载重装时数据不该跟着没，所以不放插件自己的目录里。
 */
export function resolveDataDir(config = {}) {
  if (config?.dataDir) return config.dataDir;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'memory-curve');
}

export function apply(ctx, config = {}) {
  const root = resolveDataDir(config);
  fs.mkdirSync(root, { recursive: true });

  const engine = createEngine({ root });

  // 1. 行为规则
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolveOrder(ctx.systemPrompt),
    text: SECTION_TEXT,
  });

  // 2. 模型工具
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(
      function* () {
        for (const tool of createMemoryTools({ engine })) {
          yield toolsCtx.tools.register(tool);
        }
      },
      'dsh-memory-curve: model tools'
    );
  });

  // 3. 台账页面（宿主没有 webServer 时静默跳过）
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.reflect.get('webServer');
    if (!webServer) return;
    webCtx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: MEMORY_ROUTE,
          handler: createPageHandler({ engine, root }),
        }),
      'dsh-memory-curve: ledger page'
    );
  });
}
