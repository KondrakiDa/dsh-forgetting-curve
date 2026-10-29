// 存储层：items.jsonl（append-only 事件流）+ snapshot.json（物化索引）。
//
// 为什么不是直接读写一个 items.json：
//   · append-only 让"这条记忆被改过几次、为什么变成现在这样"可回溯；
//   · 单文件整写在大库上会有写坏风险（写到一半进程被杀 = 全库损坏），
//     事件流最多丢最后一行，前面永远是完整的；
//   · snapshot 只是缓存，删了能从 jsonl 完整重建。
//
// 原子写靠 tmp + rename；Windows 上 rename 覆盖已存在目标是允许的，
// 但仍加了回退，避免个别文件系统/杀软占用导致 EPERM。

import fs from 'node:fs';
import path from 'node:path';

export const EVENT_VERSION = 1;

const SNAPSHOT_TMP = '.snapshot.json.tmp';

export class Store {
  constructor(rootDir) {
    if (!rootDir) throw new Error('Store: 需要根目录');
    this.root = path.resolve(rootDir);
    this.itemsFile = path.join(this.root, 'items.jsonl');
    this.snapshotFile = path.join(this.root, 'snapshot.json');
    this.paramsFile = path.join(this.root, 'params.json');
    this.paramsHistoryFile = path.join(this.root, 'params-history.jsonl');
    this.envFile = path.join(this.root, 'env.json');
    this.seq = 0;
    this._snapshot = null;
  }

  ensure() {
    fs.mkdirSync(this.root, { recursive: true });
    if (!fs.existsSync(this.itemsFile)) fs.writeFileSync(this.itemsFile, '', 'utf8');
    if (!fs.existsSync(this.paramsHistoryFile)) fs.writeFileSync(this.paramsHistoryFile, '', 'utf8');
  }

  exists() {
    return fs.existsSync(this.itemsFile);
  }

  // ---------- 事件流 ----------

  /** 追加一个事件。seq 由 Store 维护，从 snapshot.lastSeq 接着数。 */
  appendEvent(ev) {
    this.ensure();
    const seq = this.seq + 1;
    const rec = { v: EVENT_VERSION, seq, t: Date.now(), ...ev };
    fs.appendFileSync(this.itemsFile, `${JSON.stringify(rec)}\n`, 'utf8');
    this.seq = seq;
    return rec;
  }

  /**
   * 读全部事件。坏行（通常是进程被杀时写了一半的最后一行）直接跳过并计数，
   * 不抛异常——一条坏行不该让整个记忆库打不开。
   */
  readEvents() {
    if (!fs.existsSync(this.itemsFile)) return { events: [], corrupt: 0 };
    const raw = fs.readFileSync(this.itemsFile, 'utf8');
    const events = [];
    let corrupt = 0;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const ev = JSON.parse(s);
        if (ev && typeof ev === 'object' && typeof ev.seq === 'number') events.push(ev);
        else corrupt += 1;
      } catch {
        corrupt += 1;
      }
    }
    return { events, corrupt };
  }

  // ---------- snapshot ----------

  readSnapshot() {
    if (this._snapshot) return this._snapshot;
    if (!fs.existsSync(this.snapshotFile)) return null;
    try {
      const snap = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
      this._snapshot = snap;
      if (typeof snap.lastSeq === 'number') this.seq = snap.lastSeq;
      return snap;
    } catch {
      // snapshot 坏了不算致命：上层会从 jsonl 重建。
      return null;
    }
  }

  writeSnapshot(snap) {
    this.ensure();
    const body = JSON.stringify(snap);
    const tmp = path.join(this.root, SNAPSHOT_TMP);
    fs.writeFileSync(tmp, body, 'utf8');
    try {
      fs.renameSync(tmp, this.snapshotFile);
    } catch {
      // 回退：先删再搬。窗口很窄，且 snapshot 本来就是可重建的缓存。
      try {
        fs.rmSync(this.snapshotFile, { force: true });
      } catch {}
      fs.renameSync(tmp, this.snapshotFile);
    }
    this._snapshot = snap;
    this.seq = Math.max(this.seq, snap.lastSeq || 0);
    return snap;
  }

  /** 不经过内存缓存，强制按文件重读（页面/CLI 外部改了文件时用）。 */
  invalidate() {
    this._snapshot = null;
    return this;
  }

  // ---------- 参数 ----------

  readParams() {
    if (!fs.existsSync(this.paramsFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.paramsFile, 'utf8'));
    } catch {
      return null;
    }
  }

  writeParams(p) {
    this.ensure();
    const tmp = path.join(this.root, '.params.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, this.paramsFile);
    } catch {
      fs.rmSync(this.paramsFile, { force: true });
      fs.renameSync(tmp, this.paramsFile);
    }
  }

  appendParamHistory(rec) {
    this.ensure();
    fs.appendFileSync(this.paramsHistoryFile, `${JSON.stringify(rec)}\n`, 'utf8');
  }

  readParamHistory() {
    if (!fs.existsSync(this.paramsHistoryFile)) return [];
    const out = [];
    for (const line of fs.readFileSync(this.paramsHistoryFile, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {}
    }
    return out;
  }

  // ---------- 杂项 ----------

  readEnv() {
    if (!fs.existsSync(this.envFile)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.envFile, 'utf8'));
    } catch {
      return {};
    }
  }

  writeEnv(env) {
    this.ensure();
    fs.writeFileSync(this.envFile, JSON.stringify(env, null, 2), 'utf8');
  }

  /** 台账页面要用的文件统计，纯诊断用途。 */
  info() {
    const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
    return {
      root: this.root,
      itemsBytes: size(this.itemsFile),
      snapshotBytes: size(this.snapshotFile),
      lastSeq: this.seq,
    };
  }
}
