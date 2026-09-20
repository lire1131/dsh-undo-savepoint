/**
 * dsh-undo-savepoint: DSH 启动守卫（v0.5.0 处置层）。
 *
 * 装前预检 + 失败处置 + 会话日志捕获。与 doctor 的分工：doctor 是事后诊断
 * （DSH 已经起不来），守卫是事前拦截（启动命令发出之前）。检查逻辑不重写，
 * 直接复用 lib/core.mjs 的 runDoctor（门面 re-export，与局内/局外同源）。
 *
 * 用法：
 *   node tools/guard.mjs [--safe-mode ask|on|off] [--check] [--profile <n>] [--home <dir>] [-- <命令>]
 *   默认命令 = dsh；--check 只预检不启动（退出码 0/1 同 doctor）。
 *   硬失败（err 级）时的处置：ask = 控制台询问（10s 超时默认进安全模式，
 *   非 TTY 视为 on）；on = 自动进安全模式（safeModeSet 自带预快照）；off = 仅告警。
 *
 * 日志：被守卫进程的 stdout/stderr 回显并 tee 到 $DSH_HOME/logs/dsh-<ts>.log，
 * 保留最近 10 份。守卫不修改被守卫进程的任何参数，退出码透传。
 *
 * @module dsh-undo-savepoint/guard
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const guardArgs = sep >= 0 ? argv.slice(0, sep) : argv;
const launchArgs = sep >= 0 ? argv.slice(sep + 1) : ['dsh'];
const flag = (name) => guardArgs.includes(name);
const opt = (name) => { const i = guardArgs.indexOf(name); return i >= 0 && guardArgs[i + 1] ? guardArgs[i + 1] : null; };

const safeModePref = opt('--safe-mode') ?? 'ask';
if (!['ask', 'on', 'off'].includes(safeModePref)) {
  console.error(`guard: --safe-mode 只接受 ask|on|off（收到 ${safeModePref}）`);
  process.exit(2);
}
if (opt('--home')) process.env.DSH_HOME = opt('--home');

// DSH_HOME 是 core.mjs 的加载期常量，--home 必须先落到环境变量，因此这里用动态导入（与 doctor.mjs 同款）。
const { buildConfig, runDoctor, safeModeSet, DSH_HOME } = await import('../lib/core.mjs');

const cfg = buildConfig({ profileName: opt('--profile') ?? undefined });

console.log(`guard: 预检中（profile ${cfg.profileName}）...`);
const report = await runDoctor(cfg);
const hard = report.checks.filter((c) => c.level === 'err');
for (const c of report.checks) {
  const mark = c.level === 'err' ? '❌' : c.level === 'warn' ? '⚠️' : '✅';
  console.log(`  ${mark} ${c.name}: ${c.detail}`);
}

if (hard.length > 0) {
  console.log(`\nguard: 发现 ${hard.length} 项会阻止 DSH 启动的问题。`);
  let enter = safeModePref === 'on';
  if (safeModePref === 'ask') {
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = await Promise.race([
          rl.question('进入安全模式后重启可保证 DSH 启动（已自动存档，可一键退出）。进入？[Y/n] '),
          sleep(10000).then(() => 'y'),
        ]);
        enter = !String(ans).trim().toLowerCase().startsWith('n');
      } finally { rl.close(); }
    } else {
      console.log('guard: 非交互环境，自动进入安全模式。');
      enter = true;
    }
  }
  if (enter) {
    const r = await safeModeSet(cfg, true);
    if (r.ok) console.log(`guard: 已进入安全模式（${r.message ?? '插件集已备份，undo_safe_mode action="off" 一键退出'}）。`);
    else console.log(`guard: 进入安全模式失败：${r.message ?? r.error ?? 'unknown'}（可先用 node tools/doctor.mjs --fix 修复）`);
  } else {
    console.log('guard: 按选择不进安全模式，继续启动。');
  }
} else {
  console.log('guard: 预检通过。');
}

if (flag('--check')) {
  console.log(`guard: --check 结束（${hard.length} 项硬失败）`);
  process.exit(report.ok ? 0 : 1);
}

// 日志捕获：tee 到 $DSH_HOME/logs/dsh-<ts>.log，滚动保留 10 份
const logDir = join(DSH_HOME, 'logs');
await fs.mkdir(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = join(logDir, `dsh-${stamp}.log`);
const out = await fs.open(logFile, 'w');
const olds = (await fs.readdir(logDir).catch(() => [])).filter((n) => n.startsWith('dsh-') && n.endsWith('.log')).sort();
for (const n of olds.slice(0, Math.max(0, olds.length - 9)) ) await fs.rm(join(logDir, n), { force: true }).catch(() => {});

console.log(`guard: 启动 ${launchArgs.join(' ')}（日志 ${logFile}）`);
const child = spawn(launchArgs[0], launchArgs.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
const tee = (chunk) => { process.stdout.write(chunk); out.write(chunk).catch(() => {}); };
child.stdout.on('data', tee);
child.stderr.on('data', (c) => { process.stderr.write(c); out.write(c).catch(() => {}); });
child.on('close', async (code) => {
  await out.close().catch(() => {});
  console.log(`\nguard: 被守卫进程退出（code ${code ?? 'null'}）。`);
  process.exit(code ?? 0);
});
child.on('error', (e) => { console.error(`guard: 无法启动 ${launchArgs[0]}：${e.message}`); process.exit(1); });
