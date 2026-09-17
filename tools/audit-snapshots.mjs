/**
 * dsh-undo-savepoint: 快照敏感文件明文审计 CLI（v0.5.0，T-07 工具化）。
 *
 * 用途：0.4.9 之前的历史快照可能把 home 级 settings.yaml 等敏感文件以明文
 * 存档（当时尚未纳入脱敏）。本工具逐快照检查敏感文件内容里的秘密形态
 * （API key / token / password），只报计数与位置，绝不打印内容本身。
 * 检查与 lib/core.mjs 的 auditSnapshots 同源，局内局外不漂移。
 *
 * 用法：node tools/audit-snapshots.mjs [--json] [--profile <name>] [--home <dir>] [--lang zh|en]
 * 退出码：0 = 未发现疑似明文；1 = 有发现（建议清理旧快照后重建基线）。
 *
 * @module dsh-undo-savepoint/audit-snapshots
 */
function parseArg(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    json: argv.includes('--json'),
    profile: get('--profile'),
    home: get('--home'),
    lang: get('--lang'),
  };
}
const args = parseArg(process.argv.slice(2));
if (args.home) process.env.DSH_HOME = args.home;
if (args.lang) process.env.DSH_UNDO_LANG = args.lang;
const { buildConfig, auditSnapshots, DSH_HOME } = await import('../lib/core.mjs');
const cfg = buildConfig(args.profile ? { profileName: args.profile } : {});
const report = await auditSnapshots(cfg);
if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
console.log('== dsh-undo snapshot audit ==');
console.log(`profile: ${cfg.profileName}   home: ${DSH_HOME}`);
console.log(`scanned: ${report.scanned} snapshot(s)`);
for (const f of report.findings) {
  console.log(`  ⚠️  ${f.snapshot}  ${f.file}  ${f.kind} × ${f.count}  (${f.time.slice(0, 10)})`);
}
if (report.ok) {
  console.log('clean: 敏感文件中未发现疑似明文密钥。');
} else {
  console.log(`发现 ${report.findings.length} 项疑似明文残留。建议：删除上述旧快照后重建基线快照（undo_snapshot）。`);
}
process.exit(report.ok ? 0 : 1);
