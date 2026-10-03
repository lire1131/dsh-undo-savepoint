// redact-existing.mjs — 存量快照脱敏止血（v0.4.10, issue #39）
//
// 背景：0.4.9 及更早版本把 home/profile 两级 cordis.patch.yml 与 profile/cordis.yml
// 抓进快照但不在脱敏清单里，MCP Authorization 头（config.headers.Authorization
// Bearer …）等敏感值曾原样落盘。0.4.10 修复后「新快照」不再泄露，但「已存在的
// 旧快照」里还躺着明文——本工具用当前脱敏器把旧快照内的敏感文件副本就地重脱敏。
//
// 范围与边界：
//   - 只改快照目录里的「敏感文件副本」（envVaultRefs 的 vault 存的是本机真值，设计如此，不动）；
//   - 判据是「副本内容不含占位符」：已是脱敏形态的跳过（幂等）；
//   - manifest.json 不改（files 列表与文件名不变，size 字段允许漂移，不影响读取）；
//   - --dry-run 只报告不写盘。
//
// 用法: node redact-existing.mjs [--dry-run] [<home>]
//   <home> 默认 = $env:DSH_HOME 或 ~/.dsh；快照根 = $env:DSH_UNDO_ROOT 或 <home>/undo-snapshots
// 退出码: 0 = 无需处理或已全部处理；1 = 有文件待处理（--dry-run 时）或处理失败；2 = 用法错误

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const rest = args.filter((a) => a !== '--dry-run');
if (rest.length > 1) {
  console.error('usage: node redact-existing.mjs [--dry-run] [<home>]');
  process.exit(2);
}
const home = rest[0] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
// DSH_HOME 是 core.mjs 的加载期常量，--home 必须先落到环境变量（doctor.mjs 同款惯例）。
if (rest[0]) process.env.DSH_HOME = rest[0];

const { redactByDest, SENSITIVE_DESTS, REDACTED_PLACEHOLDER } = await import('../lib/core.mjs');
const root = process.env.DSH_UNDO_ROOT ?? join(home, 'undo-snapshots');

let scanned = 0, touched = 0, errors = 0;
const touchedFiles = [];

for (const kind of ['auto', 'manual']) {
  const kindDir = join(root, kind);
  let entries;
  try { entries = await readdir(kindDir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const snapDir = join(kindDir, e.name);
    try { await readFile(join(snapDir, 'manifest.json'), 'utf8'); } catch { continue; }
    scanned++;
    let names;
    try {
      const dirFiles = await readdir(snapDir);
      names = dirFiles.filter((n) => SENSITIVE_DESTS.has(n));
    } catch (err) { errors++; console.error(`  ! ${snapDir}: ${err.message}`); continue; }
    for (const name of names) {
      const p = join(snapDir, name);
      try {
        const text = await readFile(p, 'utf8');
        if (text.includes(REDACTED_PLACEHOLDER)) continue; // 已脱敏（幂等）
        const redacted = redactByDest(name, text);
        if (dry) { touched++; touchedFiles.push(p); continue; }
        await writeFile(p, redacted, 'utf8');
        touched++; touchedFiles.push(p);
      } catch (err) { errors++; console.error(`  ! ${p}: ${err.message}`); }
    }
  }
}

console.log(`snapshots scanned: ${scanned}`);
console.log(`sensitive copies ${dry ? 'to fix' : 'redacted'}: ${touched}${errors ? ` (errors: ${errors})` : ''}`);
for (const f of touchedFiles.slice(0, 20)) console.log('  ', f);
if (touchedFiles.length > 20) console.log(`   … and ${touchedFiles.length - 20} more`);

if (touched > 0) {
  console.log('');
  console.log('⚠  这些快照里的敏感值此前是明文。若任何快照曾被导出/分享过，请视为已泄露并轮换相关令牌');
  console.log('   （MCP Authorization 头、API key 等）。本工具只修本机副本，管不了已经离开本机的内容。');
}
process.exit((dry && touched > 0) || errors > 0 ? 1 : 0);
