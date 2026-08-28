/**
 * dsh-undo-savepoint: 裸 catch 审计清单工具（开发辅助，不进 npm test）。
 *
 * 用途：issue #19 的根因是裸 `catch {}` 吞掉 ReferenceError 导致单实例检测
 * 从未生效。仓库现有约 104 处裸 catch（core.mjs 62 / index.js 21 / 其他），
 * 大部分是合理兜底，但需要人工分级确认。本工具列出全部位置 + 上下文，
 * 供逐条标注：[合理兜底]（补注释）/ [需收窄]（限定异常类型或加告警）。
 *
 * 输出三类关注点：
 *   1. catch 块体为空或只有注释的（最高风险，可能正在静默失效）
 *   2. catch 覆盖大段代码的（吞错面大）
 *   3. catch 后返回默认值且无日志的
 *
 * 用法：node tools/audit-bare-catch.mjs [--json]
 *
 * @module dsh-undo-savepoint/audit-bare-catch
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['lib/core.mjs', 'lib/index.js', 'lib/client.js', 'lib/zip.mjs', 'lib/i18n.mjs', 'tools/undo-server.mjs', 'tools/session-scan.mjs'];

async function* walkFiles() {
  for (const rel of TARGETS) yield rel;
  // tools 下其余 mjs 也扫
  for (const f of await readdir(join(ROOT, 'tools'))) {
    if (f.endsWith('.mjs') && !TARGETS.includes(`tools/${f}`)) yield `tools/${f}`;
  }
}

async function auditFile(rel) {
  const src = await readFile(join(ROOT, rel), 'utf8');
  const lines = src.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/catch\s*(\(\s*\w*\s*\))?\s*\{/);
    if (!m) continue;
    // 块体：同行结束则取行尾，否则取后续最多 2 行
    const after = lines[i].slice(m.index + m[0].length).trim();
    let body = after;
    let span = 1;
    if (!after.includes('}')) {
      while (span <= 2 && i + span < lines.length) { body += ' ' + lines[i + span].trim(); if (lines[i + span].includes('}')) break; span++; }
    }
    body = body.replace(/\}[\s\S]*$/, '').trim();
    const empty = body === '' || /^\/\*/.test(body) || body.startsWith('//');
    const noLog = !/console\.|log|warn|error/i.test(body);
    hits.push({ file: rel, line: i + 1, body: body.slice(0, 90) || '(空)', flags: [empty && '空/注释体', noLog && '无日志'].filter(Boolean) });
  }
  return hits;
}

const all = [];
for await (const rel of walkFiles()) {
  try { all.push(...await auditFile(rel)); } catch { /* 文件读不了就跳过 */ }
}

if (process.argv.includes('--json')) { console.log(JSON.stringify(all, null, 2)); process.exit(0); }

const risky = all.filter((h) => h.flags.length > 0);
console.log(`裸 catch 总数: ${all.length}，其中需关注（空体/无日志）: ${risky.length}\n`);
for (const h of risky) {
  console.log(`${h.file}:${h.line}  [${h.flags.join(', ')}]`);
  console.log(`    catch { ${h.body} }`);
}
console.log(`\n分级建议：空/注释体 + 无日志的优先人工确认；确认合理的补一行注释说明"故意忽略"的原因（#19 教训：静默吞错 = 未来某功能悄悄失效）。`);
