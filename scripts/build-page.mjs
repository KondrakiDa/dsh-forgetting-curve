// 开发期一次性脚本：把独立页面改造成插件内嵌页面。
//
// 只做两件事：把 API 基址改成相对于挂载路径，避免硬编码 /api。
// 生成后 lib/page.html 就是源文件，发布包里不再需要这个脚本。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || path.join(HERE, '..', '..', 'qq-memory', 'public', 'index.html');
const DST = path.join(HERE, '..', 'lib', 'page.html');

let s = fs.readFileSync(SRC, 'utf8');

const before = s;
s = s.replace(
  'const api = async (path, opts = {}) => {',
  () => "const API_BASE = location.pathname.replace(/\\/$/, '') + '/';\nconst api = async (path, opts = {}) => {"
);
if (s === before) throw new Error('没找到 api 函数定义，页面结构可能变了');

const before2 = s;
s = s.replace(
  'const res = await fetch(path, {',
  () => "const res = await fetch(API_BASE + String(path).replace(/^\\/+/, ''), {"
);
if (s === before2) throw new Error('没找到 fetch 调用，页面结构可能变了');

s = s.replace('<title>记忆台账 · QQ 艾宾浩斯</title>', '<title>遗忘曲线记忆 · 台账</title>');
s = s.replace('<h1>记忆台账</h1>', '<h1>遗忘曲线记忆</h1>');

fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, s, 'utf8');
console.log(`✓ 生成 ${path.relative(process.cwd(), DST)}（${s.length} 字节）`);
