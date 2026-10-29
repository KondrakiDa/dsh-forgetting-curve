// 台账与调参页面的 HTTP 处理器，挂在宿主的 webServer 上。
//
// 用宿主的 webServer 而不是自己起 http.createServer：插件自己 listen 端口的话，
// 端口冲突、退出时没关、防火墙弹窗都要自己处理，而且用户还得记住另一个 URL。
// 挂上去之后它和 DSH 的页面同源，访问 /plugins/dsh-memory-curve/ 就能看。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEMORY_ROUTE = '/plugins/dsh-memory-curve';
const PAGE_FILE = path.join(HERE, 'page.html');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function servePage(res) {
  fs.readFile(PAGE_FILE, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('页面文件缺失：lib/page.html');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

/**
 * @param {{engine: ReturnType<import('./engine/index.mjs').createEngine>, root: string}} deps
 */
export function createPageHandler({ engine, root }) {
  return async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'bad url' });
    }

    const full = url.pathname;
    if (!full.startsWith(MEMORY_ROUTE)) return sendJson(res, 404, { error: 'not memory-curve' });

    let sub = full.slice(MEMORY_ROUTE.length);
    // 没有尾斜杠就跳一次：否则页面里的相对路径会解析到上一级去
    if (sub === '') {
      res.writeHead(302, { location: `${MEMORY_ROUTE}/` });
      return res.end();
    }

    if (sub === '/' || sub === '') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      return servePage(res);
    }

    if (!sub.startsWith('/api/')) return sendJson(res, 404, { error: 'no route' });

    try {
      if (req.method === 'GET' && sub === '/api/overview') {
        const key = url.searchParams.get('key') || undefined;
        const meta = engine.getParams();
        return sendJson(res, 200, {
          stats: engine.stats({ key }),
          params: meta.params,
          paramVersion: meta.version,
          paramHash: meta.hash,
          info: engine.info(),
          root,
          keys: [...new Set(engine.list({ includeGone: true }).map((it) => it.key))].sort(),
        });
      }

      if (req.method === 'GET' && sub === '/api/items') {
        const items = engine.list({
          key: url.searchParams.get('key') || undefined,
          state: url.searchParams.get('state') || undefined,
          kind: url.searchParams.get('kind') || undefined,
          sort: url.searchParams.get('sort') || 'nextAt',
          includeGone: url.searchParams.get('all') === '1',
        });
        return sendJson(res, 200, { items, now: Date.now() });
      }

      if (req.method === 'GET' && sub === '/api/due') {
        return sendJson(res, 200, engine.due({ key: url.searchParams.get('key') || undefined }));
      }

      if (req.method === 'POST' && sub === '/api/params/preview') {
        const body = await readBody(req);
        return sendJson(res, 200, engine.previewParams(body.patch || {}));
      }

      if (req.method === 'POST' && sub === '/api/params/save') {
        const body = await readBody(req);
        try {
          const r = engine.setParams(body.patch || {}, { recompute: !!body.recompute });
          return sendJson(res, 200, { ok: true, version: r.params.version, diff: r.diff });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String(err.message || err), details: err.details || [] });
        }
      }

      if (req.method === 'POST' && sub === '/api/item/action') {
        const body = await readBody(req);
        const { id, action, value } = body;
        if (!id || !action) return sendJson(res, 400, { error: '缺少 id 或 action' });
        try {
          let out;
          if (action === 'pin') out = engine.pin(id, value !== false);
          else if (action === 'archive') out = engine.archive(id, value || '');
          else if (action === 'edit') out = engine.editText(id, value);
          else if (action === 'review') out = engine.review(id, value, 'from ledger');
          else return sendJson(res, 400, { error: `未知 action「${action}」` });
          return sendJson(res, 200, { ok: true, item: engine.show(out.id) });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String(err.message || err) });
        }
      }

      if (req.method === 'POST' && sub === '/api/add') {
        const body = await readBody(req);
        try {
          const it = engine.add({
            key: body.key || 'global',
            kind: body.kind,
            text: body.text,
            sources: body.sources || [],
          });
          return sendJson(res, 200, { ok: true, item: engine.show(it.id) });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String(err.message || err) });
        }
      }

      return sendJson(res, 404, { error: 'no route' });
    } catch (err) {
      return sendJson(res, 500, { error: String(err?.message || err) });
    }
  };
}
