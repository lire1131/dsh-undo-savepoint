/**
 * dsh-undo-savepoint: 局外启动体检 CLI（v0.4.8）。
 *
 * 用途：DSH 起不来时先用它判明是哪一类硬失败，再用 --fix 做定点修复。检查项与
 * 局内 undo_doctor、局外 WebUI 诊断面板同源（lib/core.mjs 的 runDoctor /
 * runDoctorFix），三端不会漂移。
 *
 * 为什么需要它：profile 清单 / bundles / junction / loader id 这几类硬失败都发生在
 * 任何插件挂载之前，进程内的启动自愈够不着（隔离实例破坏式实验结论）。
 *
 * 用法：
 *   node tools/doctor.mjs [--fix] [--json] [--profile <name>] [--home <dir>] [--lang zh|en]
 *
 * 退出码：0 = 无错误项；1 = 有错误项（即会让 DSH 起不来的问题仍然存在）。
 *
 * 环境变量：DSH_HOME 与 DSH_UNDO_LANG 的含义与插件一致，--home 等价于设置 DSH_HOME。
 *
 * @module dsh-undo-savepoint/doctor
 */
function parseArg(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    fix: argv.includes('--fix'),
    json: argv.includes('--json'),
    profile: get('--profile') ?? get('-p'),
    home: get('--home'),
    lang: get('--lang'),
  };
}

const args = parseArg(process.argv.slice(2));
if (args.lang) process.env.DSH_UNDO_LANG = args.lang;
if (args.home) process.env.DSH_HOME = args.home;

// DSH_HOME 是 core.mjs 的加载期常量，--home 必须先落到环境变量，因此这里用动态导入。
const { buildConfig, runDoctor, runDoctorFix, t, DSH_HOME } = await import('../lib/core.mjs');

const mark = (level) => (level === 'err' ? '❌' : level === 'warn' ? '⚠️' : '✅');

function printReport(report) {
  console.log(t('doctor.head', { level: report.summary.level, ok: report.summary.ok, warn: report.summary.warn, err: report.summary.err }));
  for (const c of report.checks) {
    console.log(`${mark(c.level)} ${c.name}: ${c.detail}`);
    if (c.fix) console.log(`   → ${c.fix}`);
  }
  if (report.fixable > 0) console.log(`\n${report.fixable} check(s) can be repaired: node tools/doctor.mjs --fix`);
}

const cfg = buildConfig({ profileName: args.profile ?? undefined, bootAlert: null });

if (args.fix) {
  const r = await runDoctorFix(cfg);
  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.report.ok ? 0 : 1);
  }
  console.log('== dsh-undo doctor --fix ==');
  console.log(`profile: ${cfg.profileName}   home: ${DSH_HOME}`);
  if (r.snapshotId) console.log(`pre-fix snapshot: ${r.snapshotId}`);
  if (r.applied.length === 0) console.log('nothing to repair.');
  for (const a of r.applied) {
    console.log(`${a.ok ? '✅' : '❌'} ${a.code}  ${a.target}`);
    console.log(`   ${a.action}${a.error ? `\n   error: ${a.error}` : ''}`);
  }
  console.log(`fixed: ${r.fixed}  failed: ${r.failed}\n`);
  console.log('== re-check after repair ==');
  printReport(r.report);
  process.exit(r.report.ok ? 0 : 1);
}

const report = await runDoctor(cfg);
if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
console.log('== dsh-undo doctor ==');
console.log(`profile: ${cfg.profileName}   home: ${DSH_HOME}`);
printReport(report);
process.exit(report.ok ? 0 : 1);
