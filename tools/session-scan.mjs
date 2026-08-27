// session-scan.mjs — 离线会话文件扫描/修复（v0.3.8, B6 的 PS 端载体）
// 与 dsh-undo-savepoint 插件的 undo_scan 工具同规则：区分
//   ok      合规多帧布局（frame 1 = header 行，frame 2..n = 事件行）
//   fixable 单帧布局违规（8/18 崩溃根因）或 synthetic-closer seq 重叠——--fix 时备份 + 修复 + 三重校验后替换
//   corrupt 无法解码 / 首行非法 header / 坏 JSON 行——--fix 时仅隔离复制，绝不动原件
//
// 用法: node session-scan.mjs [--fix] [<home>]
//   <home> 默认 = $env:DSH_HOME 或 ~/.dsh；会话文件在 <home>/sessions/**/session.jsonl.zstd
// 退出码: 0 = 全部 ok（或 fix 全部成功），1 = 存在 corrupt/fixable 未处理，2 = 用法错误

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
// zstd Zlib API 需 Node 22.15+；Node 20 下属性为 undefined，脚本给出明确提示后退出（不崩）。
import * as zlib from 'node:zlib';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const rest = args.filter((a) => a !== '--fix');
if (rest.length > 1) {
  console.error('usage: node session-scan.mjs [--fix] [<home>]');
  process.exit(2);
}
const home = rest[0] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');

const zstdCompressSync = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync : null;
const zstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
if (!zstdCompressSync || !zstdDecompressSync) {
  console.error('session-scan requires Node.js >= 22.15 (node:zlib zstd API not available on this Node version).');
  process.exit(2);
}

const ZSTD_MAGIC = 4247762216;
const ZSTD_CHECKSUM = { params: { [zlib.constants?.ZSTD_c_checksumFlag]: 1 } };

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
 * Return the inclusive seq range carried by one storage-record JSON line, or
 * null when the line is not a parseable DSH session record.
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
  return null;
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
      return {
        status: 'fixable',
        reason: 'single-frame layout violation',
        events: Math.max(0, lines.length - 1),
        frames: frames.length,
      };
    }

    const metas = [];
    let expected = 0;
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
        frameEvents += rec.last - rec.first + 1;
        if (rec.first !== expected) seqIssue ??= { frame: i, expected, got: rec.first };
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
    return { status: 'corrupt', reason: String(error?.message ?? error) };
  }
}

function recodeSessionBytes(b, repair) {
  if (repair?.repairStart !== undefined && repair?.repairEnd !== undefined) {
    const out = Buffer.concat([
      b.subarray(0, repair.repairStart),
      b.subarray(repair.repairEnd),
    ]);
    const check = analyzeSessionBytes(out);
    if (check.status !== 'ok') throw new Error(`seq-overlap repair re-analysis failed: ${check.reason}`);
    return out;
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

async function walkSessionFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase() === 'session.jsonl.zstd') out.push(p);
    }
  }
  return out;
}

const sessionsRoot = join(home, 'sessions');
const files = await walkSessionFiles(sessionsRoot);
// 与插件 undo_scan 一致：隔离目录 = <undo 根>/corrupt-quarantine（undo 根 =
// $env:DSH_UNDO_ROOT 或 <home>/undo-snapshots；autoDir 在 <根>/auto 下）。
const undoRoot = process.env.DSH_UNDO_ROOT ?? join(home, 'undo-snapshots');
const quarantineDir = join(undoRoot, 'corrupt-quarantine');
const lines = [];
let ok = 0, fixed = 0, needsFix = 0, isolated = 0, corrupt = 0;
for (const p of files) {
  let raw;
  try { raw = await readFile(p); } catch (error) {
    lines.push(`  unreadable ${p} (${String(error?.message ?? error)})`);
    corrupt++;
    continue;
  }
  const a = analyzeSessionBytes(raw);
  if (a.status === 'ok') {
    lines.push(`  ok       ${p} (${a.events} events, ${a.frames} frames)`);
    ok++;
    continue;
  }
  if (a.status === 'fixable') {
    if (fix) {
      try {
        const fixedBytes = recodeSessionBytes(raw, a);
        await mkdir(quarantineDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await writeFile(join(quarantineDir, `${basename(dirname(p))}-${stamp}.jsonl.zstd`), raw);
        await writeFile(p + '.bak', raw);
        await writeFile(p, fixedBytes);
        const label = a.reason === 'synthetic-closer overlap'
          ? `synthetic-closer overlap, removed ${a.repairEnd - a.repairStart} bytes -> contiguous tail`
          : 'single-frame violation, header frame + event frame';
        lines.push(`  fixed    ${p} (${label}; original -> .bak)`);
        fixed++;
      } catch (error) {
        lines.push(`  failed   ${p} (${String(error?.message ?? error)})`);
        corrupt++;
      }
    } else {
      const label = a.reason === 'synthetic-closer overlap'
        ? `synthetic-closer overlap, ${a.events} events; rerun with --fix to repair`
        : `single-frame violation, ${a.events} events; rerun with --fix to repair`;
      lines.push(`  fixable  ${p} (${label})`);
      needsFix++;
    }
    continue;
  }
  let didIsolate = false;
  if (fix) {
    try {
      await mkdir(quarantineDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(join(quarantineDir, `${basename(dirname(p))}-${stamp}-corrupt.jsonl.zstd`), raw);
      didIsolate = true;
      isolated++;
    } catch { /* 隔离失败不阻断扫描 */ }
  }
  lines.push(`  corrupt  ${p} (${a.reason})${didIsolate ? ' -> isolated' : ''}`);
  corrupt++;
}

console.log(`undo_scan: scanned ${files.length} session file(s) in ${sessionsRoot}${fix ? ' (--fix mode)' : ''}`);
for (const l of lines) console.log(l);
console.log(`summary: ${ok} ok, ${fixed} fixed, ${needsFix} fixable, ${isolated} isolated, ${corrupt} corrupt`);
process.exit(needsFix > 0 || corrupt > 0 ? 1 : 0);
