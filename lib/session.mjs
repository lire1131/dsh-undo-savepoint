/**
 * dsh-undo-savepoint: session file pipeline (zstd decode chain + walk).
 *
 * 从 core.mjs 外移（0.5.0 模块拆分第二步，W07）；core 保留门面 re-export，
 * 对外 import 面零变化。区间原样搬运，不重排不改写。
 * 区间自包含：只依赖 node:fs / node:path / node:zlib 与 base 的 DSH_HOME；
 * 区间内 t() 调用为 0，故无需 i18n import。
 *
 * @module dsh-undo-savepoint/session
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { DSH_HOME } from './base.mjs';

// ── B6 undo_scan（v0.3.8）：会话文件健康扫描 + 修复 ─────────────────────────
const ZSTD_MAGIC = 4247762216;
const zstdCompressSync = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync : null;
const zstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
const ZSTD_CHECKSUM = { params: { [zlib.constants?.ZSTD_c_checksumFlag ?? 1]: 1 } };
const ZSTD_UNSUPPORTED = 'ZSTD_UNSUPPORTED';
function zstdUnavailable() {
  const e = new Error('This Node version does not ship the zstd Zlib API (zstdCompressSync/zstdDecompressSync); undo_scan requires Node.js >= 22.15.');
  e.code = ZSTD_UNSUPPORTED;
  return e;
}
function assertZstd() {
  if (!zstdCompressSync || !zstdDecompressSync) throw zstdUnavailable();
}
function zstdScanFrames(b) {
  const frames = [];
  let off = 0;
  while (off < b.length) {
    const start = off;
    if (b.length - off < 4) { frames.push({ start, end: off, torn: true }); return frames; }
    if (b.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error('bad frame magic at ' + off);
    off += 4;
    if (off === b.length) { frames.push({ start, end: off, torn: true }); return frames; }
    const d = b.readUInt8(off);
    off += 1;
    if ((d & 24) !== 0) throw new Error('reserved frame-header bit at ' + (off - 1));
    const csf = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df;
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
    const rhb = (ss ? 0 : 1) + db + csb;
    if (b.length - off < rhb) { frames.push({ start, end: off, torn: true }); return frames; }
    off += rhb;
    for (;;) {
      if (b.length - off < 3) { frames.push({ start, end: off, torn: true }); return frames; }
      const bh = b.readUIntLE(off, 3);
      off += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      if (bt === 3) throw new Error('reserved block type at ' + (off - 3));
      const pl = bt === 1 ? 1 : bs;
      if (b.length - off < pl) { frames.push({ start, end: off, torn: true }); return frames; }
      off += pl;
      if (last) break;
    }
    if (ck) {
      if (b.length - off < 4) { frames.push({ start, end: off, torn: true }); return frames; }
      off += 4;
    }
    frames.push({ start, end: off });
  }
  return frames;
}
function zstdDecodeAll(b) {
  assertZstd();
  const frames = zstdScanFrames(b);
  const parts = [];
  for (const f of frames) {
    if (f.torn) throw new Error('torn frame at byte ' + f.start);
    parts.push(zstdDecompressSync(b.subarray(f.start, f.end)));
  }
  return Buffer.concat(parts).toString('utf8');
}
function tryJsonLine(s) { try { JSON.parse(s); return true; } catch { return false; } }
function isSessionHeaderLine(v) {
  return typeof v === 'object' && v !== null && v.type === 'session' &&
    typeof v.version === 'number' && typeof v.id === 'string' &&
    typeof v.createdAt === 'number' && Number.isSafeInteger(v.createdAt) && v.createdAt >= 0 &&
    typeof v.delegationDepth === 'number' && Number.isSafeInteger(v.delegationDepth) && v.delegationDepth >= 0;
}

/**
 * Return the inclusive seq range carried by one storage-record JSON line, a
 * `{ noSeq: true }` marker for a valid JSON record without seq/seq0, or null
 * when the line is not parseable JSON at all.
 */
function recordSeqRange(line) {
  let v = null;
  try { v = JSON.parse(line); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  if (Number.isSafeInteger(v.seq0)) {
    const texts = Array.isArray(v.data?.texts) ? v.data.texts : null;
    const args = Array.isArray(v.data?.args) ? v.data.args : null;
    const payload = texts ?? args;
    if (payload && payload.length > 0) {
      return { first: v.seq0, last: v.seq0 + payload.length - 1, type: v.type };
    }
    return { first: v.seq0, last: v.seq0, type: v.type };
  }
  if (Number.isSafeInteger(v.seq)) return { first: v.seq, last: v.seq, type: v.type };
  // 合法 JSON 但无 seq/seq0（心跳/未来格式扩展等）：合法记录，跳过 seq 连续性校验
  return { noSeq: true, type: v.type };
}

/** Parse one zstd frame into storage records without materializing the whole log. */
function frameRecords(b, frames, i) {
  const f = frames[i];
  const text = zstdDecompressSync(b.subarray(f.start, f.end)).toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const records = [];
  for (const line of lines) {
    const r = recordSeqRange(line);
    if (!r) return { records: null, badLine: line };
    records.push({ line, ...r });
  }
  return { records };
}

function analyzeSessionBytes(b) {
  try {
    assertZstd();
    const frames = zstdScanFrames(b);
    if (frames.some((f) => f.torn)) return { status: 'corrupt', reason: 'torn frame' };
    if (frames.length === 0) return { status: 'corrupt', reason: 'empty or header-less' };

    const headerText = zstdDecompressSync(b.subarray(frames[0].start, frames[0].end)).toString('utf8');
    const nl = headerText.indexOf('\n');
    if (nl === -1) return { status: 'corrupt', reason: 'no newline in decoded text' };
    const headerLine = headerText.slice(0, nl);
    let parsed = null;
    try { parsed = JSON.parse(headerLine); } catch { /* 首行非 JSON */ }
    if (!isSessionHeaderLine(parsed)) return { status: 'corrupt', reason: 'first line is not a valid session header' };

    if (frames.length < 2) {
      const text = zstdDecodeAll(b);
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      // DSH 0.1.2（materializeHeader）：空会话合法落盘为单帧且仅含 header 行
      // （0 事件）。首行已通过 isSessionHeaderLine 校验，此处 0 事件即判 ok，
      // 不再误报 fixable 导致每次扫描都把合法空会话标成待隔离。
      if (lines.length <= 1) {
        return { status: 'ok', events: 0, frames: frames.length };
      }
      return {
        status: 'fixable',
        reason: 'single-frame layout violation',
        events: Math.max(0, lines.length - 1),
        frames: frames.length,
      };
    }

    const metas = [];
    // seq 连续性起点锚定（v0.4.7）：v0 会话首事件 seq=0；v2/v3 原生会话同样从 0 起，
    // 但「恢复历史会话生成的新版日志」（seeded 迁移）首行 session/end-seed 的 seq =
    // inheritedEventCount，不从 0 起。首条带 seq 记录锚定基准，其后才要求严格连续。
    let expected = null;
    let seqIssue = null;
    let events = 0;
    let badJson = null;
    for (let i = 1; i < frames.length; i++) {
      const { records, badLine } = frameRecords(b, frames, i);
      if (!records) {
        badJson ??= { frame: i, line: badLine };
        continue;
      }
      const expectedBefore = expected;
      const firstSeq = records[0]?.first;
      const lastSeq = records.at(-1)?.last;
      const types = records.map((r) => r.type);
      const isCloserPair = records.length === 2 && types[0] === 'step/end' && types[1] === 'turn/end'
        && records[1].first === records[0].first + 1;
      let frameEvents = 0;
      for (const rec of records) {
        if (rec.noSeq) { frameEvents += 1; continue; } // 无 seq 行：计入事件但不参与连续性校验
        frameEvents += rec.last - rec.first + 1;
        if (expected === null) expected = rec.first;
        else if (rec.first !== expected) seqIssue ??= { frame: i, expected, got: rec.first };
        expected = rec.last + 1;
      }
      events += frameEvents;
      metas.push({
        i,
        start: frames[i].start,
        end: frames[i].end,
        firstSeq,
        lastSeq,
        isCloserPair,
        expectedBefore,
      });
    }

    if (badJson) return { status: 'corrupt', reason: `bad JSON line in frame ${badJson.frame}` };

    // Synthetic-closer overlap: a frame containing only step/end + turn/end is
    // followed by a frame that restarts at the pre-closer seq. Removing the
    // closer frame restores the contiguous tail (the interrupted turn resumes
    // without the synthetic boundary).
    let candidate = null;
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i];
      if (!m.isCloserPair) continue;
      for (let j = i + 1; j < metas.length; j++) {
        if (metas[j].firstSeq === m.expectedBefore) {
          candidate = { start: m.start, end: m.end, expectedBefore: m.expectedBefore };
          break;
        }
      }
      if (candidate) break;
    }
    if (candidate) {
      return {
        status: 'fixable',
        reason: 'synthetic-closer overlap',
        events,
        frames: frames.length,
        repairStart: candidate.start,
        repairEnd: candidate.end,
      };
    }
    if (seqIssue) {
      return {
        status: 'corrupt',
        reason: `seq gap in committed region at frame ${seqIssue.frame} (expected ${seqIssue.expected}, got ${seqIssue.got})`,
      };
    }

    return { status: 'ok', events, frames: frames.length };
  } catch (error) {
    if (error?.code === ZSTD_UNSUPPORTED) throw error;
    return { status: 'corrupt', reason: String(error?.message ?? error) };
  }
}

function recodeSessionBytes(b, repair) {
  assertZstd();
  if (repair?.repairStart !== undefined && repair?.repairEnd !== undefined) {
    // 多次崩溃恢复可能留下多个 synthetic-closer 重叠帧：循环删除直到重分析 ok，
    // 而非只删第一个（否则双重叠文件每次 --fix 都选同一个 closer，永远修不完）。
    let out = Buffer.concat([
      b.subarray(0, repair.repairStart),
      b.subarray(repair.repairEnd),
    ]);
    for (let removed = 1; ; removed++) {
      const check = analyzeSessionBytes(out);
      if (check.status === 'ok') return out;
      if (check.status !== 'fixable' || check.reason !== 'synthetic-closer overlap'
        || check.repairStart === undefined || check.repairEnd === undefined) {
        throw new Error(`seq-overlap repair re-analysis failed: ${check.reason}`);
      }
      if (removed >= 1024) throw new Error('seq-overlap repair exceeded safe iteration limit (1024)');
      out = Buffer.concat([out.subarray(0, check.repairStart), out.subarray(check.repairEnd)]);
    }
  }
  const text = zstdDecodeAll(b);
  const nl = text.indexOf('\n');
  if (nl === -1) throw new Error('no newline in decoded text');
  const headerLine = text.slice(0, nl);
  const rest = text.slice(nl + 1);
  let parsed = null;
  try { parsed = JSON.parse(headerLine); } catch { /* 下抛 */ }
  if (!isSessionHeaderLine(parsed)) throw new Error('first line is not a valid session header');
  const frames = [zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), ZSTD_CHECKSUM)];
  if (rest.length > 0) frames.push(zstdCompressSync(Buffer.from(rest, 'utf8'), ZSTD_CHECKSUM));
  const out = Buffer.concat(frames);
  const check = zstdDecodeAll(out);
  if (check !== text) throw new Error('round-trip text mismatch');
  for (const l of check.split('\n')) { if (l.trim() && !tryJsonLine(l)) throw new Error('bad JSON line after recode'); }
  const re = analyzeSessionBytes(out);
  if (re.status !== 'ok') throw new Error(`recode re-analysis failed: ${re.reason}`);
  return out;
}
// ── 会话日志名识别（v0.4.7）：DSH 0.1.3+ 的 generation 命名 ────────────────
// canonical 名：v0 = session.jsonl[.zstd]；vN（N>=2）= session.vN.jsonl[.zstd]。
// 官方语义：一个 session 目录的当前代日志唯一，恢复历史会话会生成更高代的新文件
// （旧代 immutable 保留）。同目录多代并存时取数值最高代，与官方
// resolveGenerationInDirectory 的选择一致。无压缩变体（session.jsonl 无 .zstd）
// 本版暂不收录，与既有行为一致（DSH 默认 zstd）。
function parseSessionLogZstdName(name) {
  const lower = name.toLowerCase();
  if (lower === 'session.jsonl.zstd') return { generation: 0 };
  const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(lower);
  if (m) return { generation: Number(m[1]) };
  return null;
}

async function walkSessionFiles(cfg) {
  const root = join(cfg.homeDir ?? DSH_HOME, 'sessions');
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    let best = null; // { name, generation }：本目录最高 canonical generation 的日志
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      const info = parseSessionLogZstdName(e.name);
      if (!info) continue;
      if (best === null || info.generation > best.generation) best = { name: e.name, generation: info.generation };
    }
    if (best !== null) out.push(join(dir, best.name));
  }
  return out;
}

export {
  zstdUnavailable,
  assertZstd,
  zstdScanFrames,
  zstdDecodeAll,
  analyzeSessionBytes,
  recodeSessionBytes,
  parseSessionLogZstdName,
  walkSessionFiles,
};
