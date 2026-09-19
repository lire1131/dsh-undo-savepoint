/**
 * dsh-undo-savepoint: 一键卸载与残留清理 CLI（v0.5.0，W32）。
 *
 * 用途：插件落盘六处（npm 包目录 / profile junction × N / stateDir /
 * 快照库 / 桌面快捷方式 / patch 与 bundle 挂载声明），0.4.9 及以前没有卸载
 * 章节，用户只能全量搜索手删，在 Windows MAX_PATH + junction 跟随递归下
 * 必然翻车。本命令按「六处落盘位置」逐个摘除，junction 只删链接本体不跟随。
 *
 * 逻辑本体在 lib/core.mjs 的 planUninstall / applyUninstall（局内工具可复用、
 * 可单测），本文件只做参数解析、计划打印与确认交互。
 *
 * 用法：node tools/uninstall.mjs [--purge] [--yes] [--home <dir>]
 *                                [--profile <n>] [--desktop <dir>] [--json]
 * 退出码：0 = 清理完成（或用户取消）；1 = 出错 / 非交互环境缺 --yes。
 *
 * @module dsh-undo-savepoint/uninstall
 */
import { createInterface } from 'node:readline';

function parseArg(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    purge: argv.includes('--purge'),
    yes: argv.includes('--yes'),
    json: argv.includes('--json'),
    help: argv.includes('--help') || argv.includes('-h'),
    profile: get('--profile'),
    home: get('--home'),
    desktop: get('--desktop'),
  };
}

const USAGE = `dsh-undo-savepoint uninstall

用法: node tools/uninstall.mjs [选项]

  --purge          连带删除状态目录与快照库（默认保留，可重装恢复）
  --yes            跳过确认（非交互环境必须显式给出）
  --home <dir>     覆盖 DSH 主目录
  --profile <n>    只处理指定 profile（默认全部）
  --desktop <dir>  覆盖桌面目录
  --json           机器可读输出
  -h, --help       显示本帮助

落盘六处与清理方式:
  1. npm 包目录               本工具不删，交给 npm uninstall / dsh plugin remove
  2. profile junction × N     删链接本体（不跟随目标）
  3. stateDir (<home>/undo)   --purge
  4. 快照库 (<home>/undo-snapshots)  --purge（默认保留）
  5. 桌面快捷方式             删除
  6. patch / bundle 挂载声明   摘除条目；文件变空则删除
`;

const args = parseArg(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
// DSH_HOME 必须在 import core 之前落到 env：core 的 DSH_HOME / LEGACY_ROOT /
// SETTINGS_FILE 是 import 时求值的模块常量。
if (args.home) process.env.DSH_HOME = args.home;

const { buildConfig, planUninstall, applyUninstall } = await import('../lib/core.mjs');
const cfg = buildConfig(args.profile ? { profileName: args.profile } : {});
const { home, plan, notes } = await planUninstall(cfg, {
  purge: args.purge,
  profile: args.profile ?? null,
  desktopDir: args.desktop ?? null,
});

if (args.json) {
  console.log(JSON.stringify({ home, profile: cfg.profileName, purge: args.purge, plan, notes }, null, 2));
  process.exit(0);
}

console.log('== dsh-undo-savepoint uninstall ==');
console.log(`profile: ${cfg.profileName}   home: ${home}`);
if (plan.length === 0) {
  console.log('nothing to remove: 未发现本插件的挂载声明、junction 或快捷方式。');
  for (const n of notes) console.log(n);
  console.log('最后一步：npm uninstall dsh-undo-savepoint（或 dsh plugin remove）');
  process.exit(0);
}
console.log('will remove:');
for (const p of plan) console.log(`  - ${p.what}: ${p.path}${p.target ? `  -> ${p.target}` : ''}`);
for (const n of notes) console.log(n);

const interactive = typeof process.stdin?.isTTY === 'boolean' && process.stdin.isTTY;
if (!args.yes) {
  if (!interactive) {
    console.error('refused: 非交互环境需显式 --yes（防脚本误删）。');
    process.exit(1);
  }
  const answer = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`确认删除以上 ${plan.length} 项？[y/N] `, (a) => { rl.close(); resolve(String(a ?? '').trim().toLowerCase()); });
  });
  if (answer !== 'y' && answer !== 'yes') {
    console.log('cancelled: 未做任何改动。');
    process.exit(0);
  }
}

const r = await applyUninstall(plan);
console.log(`removed mount declaration: ${r.removedMount}`);
console.log(`removed junction: ${r.removedJunction}`);
console.log(`removed shortcut: ${r.removedShortcut}`);
if (args.purge) console.log(`removed state/library: ${r.removedOther}`);
else console.log('kept: undo-snapshots (use --purge)');
// notes 在上面的计划预览里已打印过，此处只补执行期新产生的（如摘空后被删的 patch 文件）
for (const n of r.notes) console.log(n);
for (const e of r.errors) console.error(`  failed: ${e.what} ${e.path}: ${e.error}`);
console.log('最后一步：npm uninstall dsh-undo-savepoint（或 dsh plugin remove）');
process.exit(r.failed > 0 ? 1 : 0);
