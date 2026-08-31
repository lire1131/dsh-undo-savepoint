// tools/e2e-watch.mjs — regression test for the undo/redo + auto-watcher
// interplay with REAL timings:
//   1. a config change auto-snapshots (watcher works)
//   2. undo restores and does NOT trigger its own auto snapshot (suppression)
//   3. redo then succeeds (would have been blocked before the fix)
// Run:  node tools/e2e-watch.mjs
process.env.DSH_ROOT = process.env.DSH_ROOT ?? 'C:/Users/yzf';
// 测试固定英文输出（V0.3.9 R7）：host 端随 DSH_UNDO_LANG 本地化，断言基于英文文案。
process.env.DSH_UNDO_LANG = 'en';
import { mkdtemp, writeFile, readFile, mkdir, rm as rmRaw } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Windows 上 fs.rm 偶发 ENOTEMPTY（杀软/索引器短暂占用目录句柄），统一重试几次
const rm = async (dir, opts) => {
  let last;
  for (let i = 0; i < 4; i++) {
    try { await rmRaw(dir, opts); return; } catch (e) { last = e; await new Promise((r) => setTimeout(r, 150)); }
  }
  throw last;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = await mkdtemp(join(tmpdir(), 'dsh-undo-e2e-'));
const home = join(root, 'home');
const profile = join(root, 'profile');
const snapDir = join(root, 'snapshots');
const pluginDir = join(root, 'plugin-x'); // 模拟插件代码目录（v0.2）
await mkdir(home, { recursive: true });
await mkdir(profile, { recursive: true });
await mkdir(join(pluginDir, 'lib'), { recursive: true });
await writeFile(join(home, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(pluginDir, 'lib', 'index.js'), 'export const a = 1;\n');

// ★ 2026-08-18 隔离修复（与 smoke-test.mjs 相同）：lib/index.js 在模块加载时
//   按 env 求值 SETTINGS_FILE / LEGACY_ROOT，默认落到 $DSH_HOME/undo*（真实
//   home）。必须在 import 之前把这两个 env 指向测试目录，防止测试写脏真实 home。
process.env.DSH_UNDO_SETTINGS = join(root, 'undo', 'settings.json');
process.env.DSH_UNDO_ROOT = join(root, 'undo-snapshots');
const { apply } = await import('../lib/index.js');

const tools = new Map();
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } },
  get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); },
  logger: { info: () => { }, warn: (...a) => console.warn('[warn]', ...a) },
};
apply(ctx, { manualDir: join(snapDir, 'manual'), autoDir: join(snapDir, 'auto'), homeDir: home, profileDir: profile, watch: true, watchDebounceMs: 300, keepAuto: 10, pluginDirs: [pluginDir] });
await sleep(600); // baseline lands

let pass = 0, fail = 0;
const check = (cond, label) => { if (cond) { pass++; console.log('  ok  -', label); } else { fail++; console.error('  FAIL -', label); } };
const run = async (name, args) => (await tools.get(name).execute(args, {}));
const curSettings = async () => readFile(join(home, 'settings.yaml'), 'utf8');
const autoCount = async () => {
  const out = await run('undo_list', {});
  return (out.match(/(config|settings|plugin|patch)-change/g) || []).length;
};

console.log('== 1. config change auto-snapshots ==');
await writeFile(join(home, 'settings.yaml'), 'model: y\n');
await sleep(1200);
const before = await autoCount();
check(before >= 1, `auto snapshot appeared (${before})`);

console.log('== 2. undo restores and suppresses its own auto snapshot ==');
const out = await run('undo_restore', { mode: 'undo' });
console.log('   ', out.split('\n')[0]);
check((await curSettings()) === 'model: x\n', 'settings.yaml restored to x');
await sleep(1200); // if suppression failed, an auto snapshot would appear here
const after = await autoCount();
check(after === before, `no auto snapshot from the undo itself (${before} -> ${after})`);

console.log('== 3. redo succeeds (was blocked before the fix) ==');
const redo = await run('undo_restore', { mode: 'redo' });
console.log('   ', redo.split('\n')[0]);
check(!redo.includes('blocked') && !redo.includes('failed'), 'redo not blocked');
check((await curSettings()) === 'model: y\n', 'settings.yaml re-applied to y');

console.log('== 4. real new change still blocks redo (correct semantics) ==');
await writeFile(join(home, 'settings.yaml'), 'model: z\n');
await sleep(1200); // auto snapshot of the new change
await run('undo_restore', { mode: 'undo' }); // undo it
await writeFile(join(home, 'settings.yaml'), 'model: w\n');
await sleep(1200); // ANOTHER real change after the undo
const blocked = await run('undo_restore', { mode: 'redo' });
check(blocked.includes('blocked'), 'redo blocked when a real new change exists');

console.log('== 5. plugin code change auto-snapshots; undo restores without echo snapshot (v0.2) ==');
await writeFile(join(pluginDir, 'lib', 'index.js'), 'export const a = 2;\n');
await sleep(1500); // plugin watcher + debounce
let out5 = await run('undo_list', {});
const cBefore = (out5.match(/plugin-code-change/g) || []).length;
check(cBefore >= 1, `plugin code change auto-snapshotted as plugin-code-change (${cBefore})`);
check(out5.includes('plugin file(s)'), 'list shows plugin file count');
out5 = await run('undo_restore', { mode: 'undo' });
console.log('   ', out5.split('\n')[0]);
check((await readFile(join(pluginDir, 'lib', 'index.js'), 'utf8')).includes('a = 1'), 'plugin code file restored by undo');
await sleep(1500); // if the restore echo was not suppressed, an extra auto snapshot appears
out5 = await run('undo_list', {});
const cAfter = (out5.match(/plugin-code-change/g) || []).length;
check(cAfter === cBefore, `no auto snapshot from the plugin restore itself (${cBefore} -> ${cAfter})`);

// ── #33：profile 根下被 cordis.patch.yml 引用的代码文件触发自动快照 ──────────
// 场景覆盖：引用落地（首次创建）、再次修改、undo 恢复、恢复写入不触发快照（echo）。
console.log('== 6. profile-root code file referenced by cordis.patch.yml auto-snapshots (#33) ==');
const profileCodeCount = async () => {
  const out = await run('undo_list', {});
  return (out.match(/profile-code-change/g) || []).length;
};
// 引用 + 文件落地（patch.yml 本身是 watched 配置，同一 flush 里 profile 优先级更高）
await writeFile(join(profile, 'cordis.patch.yml'), "# patch\n- insert:\n    - id: profile-local\n      name: './router-global.mjs'\n");
await writeFile(join(profile, 'router-global.mjs'), 'export const routes = 1;\n');
await sleep(1500);
const pcBefore = await profileCodeCount();
check(pcBefore >= 1, `profile code change auto-snapshotted as profile-code-change (${pcBefore})`);
// 再次修改：新内容入快照
await writeFile(join(profile, 'router-global.mjs'), 'export const routes = 2;\n');
await sleep(1500);
const pcMid = await profileCodeCount();
check(pcMid > pcBefore, `second modification snapshotted (${pcBefore} -> ${pcMid})`);
// undo：恢复到上一版内容
const out6 = await run('undo_restore', { mode: 'undo' });
console.log('   ', out6.split('\n')[0]);
check((await readFile(join(profile, 'router-global.mjs'), 'utf8')).includes('routes = 1'), 'profile code file restored by undo');
// 恢复写入（patch.yml 与 router-global.mjs）不触发新快照
await sleep(1500);
const pcAfter = await profileCodeCount();
check(pcAfter === pcMid, `no auto snapshot from the restore itself (${pcMid} -> ${pcAfter})`);

await rm(root, { recursive: true, force: true });
console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail > 0 ? 1 : 0);
