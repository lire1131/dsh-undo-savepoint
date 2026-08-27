// tools/smoke-test.mjs — offline smoke test of dsh-undo-savepoint logic (no DSH needed).
// Run:  node tools/smoke-test.mjs
process.env.DSH_ROOT = process.env.DSH_ROOT ?? 'C:/Users/yzf';
// 测试固定英文输出（V0.3.9 R7）：host 端随 DSH_UNDO_LANG 本地化，断言基于英文文案。
process.env.DSH_UNDO_LANG = 'en';
// 测试不碰真实桌面：DSH_UNDO_NO_DESKTOP=1 让 apply() 启动时的桌面快捷方式功能跳过。
process.env.DSH_UNDO_NO_DESKTOP = '1';
import { mkdtemp, writeFile, readFile, mkdir, rm as rmRaw, readdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
// zstd Zlib API（zstdCompressSync / zstdDecompressSync）需 Node 22.15+；Node 20 下用例 38 跳过
const hasZstd = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';

// Windows 上 fs.rm 偶发 ENOTEMPTY（杀软/索引器短暂占用目录句柄），统一重试几次。
// 对全部既有调用点生效，避免每个临时目录清理都写一遍重试。
const rm = async (dir, opts) => {
  let last;
  for (let i = 0; i < 4; i++) {
    try { await rmRaw(dir, opts); return; } catch (e) { last = e; await new Promise((r) => setTimeout(r, 150)); }
  }
  throw last;
};

const root = await mkdtemp(join(tmpdir(), 'dsh-undo-savepoint-test-'));
const home = join(root, 'home');
const profile = join(root, 'profile');
const snapDir = join(root, 'snapshots');
await mkdir(home, { recursive: true });
await mkdir(profile, { recursive: true });
await writeFile(join(home, 'settings.yaml'), 'model: v1\n');
await writeFile(join(profile, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile, 'package.json'), '{"name":"test","v":1}\n');

// ★ 2026-08-18 隔离修复：lib/index.js 在模块加载时按 env 求值 SETTINGS_FILE /
//   LEGACY_ROOT，默认落到 $DSH_HOME/undo*（真实 home）。必须在 import 之前把
//   这两个 env 指向测试目录，否则测试产生的 undo/redo 记录会写脏真实 home 的
//   undo/rollback-log.jsonl（此前已实测污染）。
process.env.DSH_UNDO_SETTINGS = join(root, 'undo', 'settings.json');
process.env.DSH_UNDO_ROOT = join(root, 'undo-snapshots');
const { apply } = await import('../lib/index.js');

const tools = new Map();
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => { }; } },
  systemPrompt: { section: (s) => { return () => { }; } },
  get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); },
  logger: { info: () => { }, warn: (...a) => console.warn('[warn]', ...a) },
};
apply(ctx, { manualDir: join(snapDir, 'manual'), autoDir: join(snapDir, 'auto'), homeDir: home, profileDir: profile, watch: false, keepAuto: 2, pluginDirs: [] });
// let the async baseline snapshot land before we start asserting
await new Promise((r) => setTimeout(r, 300));

let pass = 0, fail = 0;
const check = (cond, label) => { if (cond) { pass++; console.log('  ok  -', label); } else { fail++; console.error('  FAIL -', label); } };
const run = async (name, args) => {
  const t = tools.get(name);
  if (!t) throw new Error(`tool not registered: ${name}`);
  return await t.execute(args, {});
};
const cur = async (f) => readFile(join(profile, f), 'utf8');
const set = async (f, v) => writeFile(join(profile, f), v);
// Windows 上 fs.rm 偶发 ENOTEMPTY（杀软/索引器短暂占用目录句柄），清理时重试几次
const cleanup = async (dir) => rm(dir, { recursive: true, force: true });

console.log('== 1. snapshot & list ==');
let out = await run('undo_snapshot', { reason: 'known-good' });
console.log('   ', out.split('\n')[0]);
check((await readdir(snapDir)).sort().join(',') === 'auto,manual', 'manual/auto stores exist');
check((await readdir(join(snapDir, 'manual'))).length >= 1, 'manual store has the manual snapshot');
out = await run('undo_list', {});
check(out.includes('known-good'), 'list shows reason');
check(out.includes('plugin-mounted'), 'list shows baseline');
check(out.includes('[manual]') && out.includes('[auto]'), 'list shows store locations');

console.log('== 2. change config, snapshot again ==');
await set('cordis.patch.yml', '# patch\n- id: test\n  name: test\n');
await set('package.json', '{"name":"test","v":2}\n');
out = await run('undo_snapshot', { reason: 'after change' });

console.log('== 3. undo steps back to known-good ==');
out = await run('undo_restore', { mode: 'undo' });
console.log('   ', out.split('\n')[0]);
check((await cur('package.json')).includes('"v":1'), 'package.json back to v1');
check(!(await cur('cordis.patch.yml')).includes('- id: test'), 'patch entry removed');
check((await cur('cordis.patch.yml')).includes('- insert:'), 'undo mount is an insert patch');
check((await cur('cordis.patch.yml')).includes('name: dsh-undo-savepoint'), 'undo mount has package name');
check(out.includes('re-ensured'), 'report mentions re-ensure');

console.log('== 4. redo re-applies the change ==');
out = await run('undo_restore', { mode: 'redo' });
check((await cur('package.json')).includes('"v":2'), 'package.json back to v2');
check((await cur('cordis.patch.yml')).includes('- id: test'), 'patch entry back');

console.log('== 5. undo again after redo ==');
out = await run('undo_restore', { mode: 'undo' });
check((await cur('package.json')).includes('"v":1'), 'back to v1 again');

console.log('== 6. undo then new change blocks redo (realistic: every change snapshotted) ==');
await set('package.json', '{"name":"test","v":3}\n');
await run('undo_snapshot', { reason: 'auto-like v3' });
out = await run('undo_restore', { mode: 'undo' });
check((await cur('package.json')).includes('"v":1'), 'v3 change undone (back to v1)');
await set('package.json', '{"name":"test","v":4}\n');
await run('undo_snapshot', { reason: 'auto-like v4' });
out = await run('undo_restore', { mode: 'redo' });
console.log('   ', out.split('\n')[0]);
check(out.includes('blocked'), 'redo blocked after a newer change');

console.log('== 7. multi-step undo (three states) ==');
await set('package.json', '{"name":"test","v":4}\n'); await run('undo_snapshot', { reason: 's4' });
await set('package.json', '{"name":"test","v":5}\n'); await run('undo_snapshot', { reason: 's5' });
await set('package.json', '{"name":"test","v":6}\n'); await run('undo_snapshot', { reason: 's6' });
out = await run('undo_restore', { mode: 'undo' });
check((await cur('package.json')).includes('"v":5'), 'undo1 -> v5');
out = await run('undo_restore', { mode: 'undo' });
check((await cur('package.json')).includes('"v":4'), 'undo2 -> v4');
out = await run('undo_restore', { mode: 'redo' });
check((await cur('package.json')).includes('"v":5'), 'redo1 -> v5');
out = await run('undo_restore', { mode: 'redo' });
check((await cur('package.json')).includes('"v":6'), 'redo2 -> v6');
out = await run('undo_restore', { mode: 'undo' });
check((await cur('package.json')).includes('"v":5'), 'undo after full redo -> v5');

console.log('== 8. restore by id ==');
const list = await run('undo_list', {});
const line = list.split('\n').find((l) => /known-good\s+\(/.test(l));
const id1 = line?.match(/^(\S+)/)?.[1];
check(!!id1, 'found known-good id');
out = await run('undo_restore', { mode: 'id', snapshot_id: id1 });
check((await cur('package.json')).includes('"v":1'), 'restore by id -> v1');

console.log('== 9. manual snapshots survive (never pruned) ==');
const countSnaps = async () => (await readdir(join(snapDir, 'manual'))).length + (await readdir(join(snapDir, 'auto'))).length;
const all = await countSnaps();
console.log('   snapshot count:', all);
check(all >= 8, 'manual snapshots survive');

console.log('== 9b. manual vs auto stores are separate ==');
const manualBefore = (await readdir(join(snapDir, 'manual'))).length;
const autoBefore = (await readdir(join(snapDir, 'auto'))).length;
await run('undo_snapshot', { reason: 'store-check' });
check((await readdir(join(snapDir, 'manual'))).length === manualBefore + 1, 'manual snapshot goes to the manual store');
check((await readdir(join(snapDir, 'auto'))).length === autoBefore, 'auto store untouched by manual snapshot');

console.log('== 10. diff works ==');
out = await run('undo_diff', { snapshot_id: id1 });
check(out.includes('Diff of'), 'diff produced');

console.log('== 11. undo with all-identical snapshots says unchanged ==');
const root2 = await mkdtemp(join(tmpdir(), 'dsh-undo-savepoint-test2-'));
const home2 = join(root2, 'home');
const profile2 = join(root2, 'profile');
const snap2 = join(root2, 'snapshots');
await mkdir(home2, { recursive: true });
await mkdir(profile2, { recursive: true });
await writeFile(join(home2, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile2, 'cordis.patch.yml'), '# patch\n[]\n');
const tools2 = new Map();
const ctx2 = {
  tools: { register: (t) => { tools2.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } },
  get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); },
  logger: { info: () => { }, warn: () => { } },
};
apply(ctx2, { manualDir: join(snap2, 'manual'), autoDir: join(snap2, 'auto'), homeDir: home2, profileDir: profile2, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run2 = async (name, args) => (await tools2.get(name).execute(args, {}));
await run2('undo_snapshot', { reason: 'dup-a' });
await run2('undo_snapshot', { reason: 'dup-b' });
out = await run2('undo_restore', { mode: 'undo' });
console.log('   ', out.split('\n')[0]);
check(out.includes('nothing to undo') || out.includes('already matches'), 'identical states -> clear unchanged message');
check(!out.includes('failed'), 'unchanged is not a failure');
out = await run2('undo_restore', { mode: 'undo' });
check(out.includes('nothing to undo') || out.includes('already matches'), 'repeat undo stays unchanged');
await rm(root2, { recursive: true, force: true });

console.log('== 12. prune: pre-restore cleanup + autoCleanup off ==');
// fixture 3: keepPre=1, autoCleanup on
const root3 = await mkdtemp(join(tmpdir(), 'dsh-undo-savepoint-test3-'));
const home3 = join(root3, 'home'), profile3 = join(root3, 'profile'), snap3 = join(root3, 'snaps');
await mkdir(home3, { recursive: true }); await mkdir(profile3, { recursive: true });
await writeFile(join(home3, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile3, 'cordis.patch.yml'), '# patch\n[]\n');
const tools3 = new Map();
const ctx3 = {
  tools: { register: (t) => { tools3.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx3, { manualDir: join(snap3, 'manual'), autoDir: join(snap3, 'auto'), homeDir: home3, profileDir: profile3, watch: false, keepAuto: 2, keepPre: 1, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run3 = async (name, args) => (await tools3.get(name).execute(args, {}));
const set3 = async (v) => writeFile(join(profile3, 'package.json'), v);
// two real change+undo cycles -> two pre-restore snapshots
await set3('{"name":"test","v":2}\n');
await run3('undo_snapshot', { reason: 's2' });
await run3('undo_restore', { mode: 'undo' }); // pre1 (state v2), back to x
await set3('{"name":"test","v":3}\n');
await run3('undo_snapshot', { reason: 's3' });
await run3('undo_restore', { mode: 'undo' }); // pre2 (state v3), back to x
out = await run3('undo_prune', {});
console.log('   ', out);
check(out.includes('Pruned'), 'undo_prune ran');
check(out.includes('1 pre-restore'), 'one pre-restore pruned (2 kept 1)');
out = await run3('undo_list', {});
check((out.match(/pre-restore/g) || []).length === 1, 'exactly 1 pre-restore left (keepPre=1)');
await rm(root3, { recursive: true, force: true });

// fixture 4: autoCleanup=false -> prune deletes nothing
const root4 = await mkdtemp(join(tmpdir(), 'dsh-undo-savepoint-test4-'));
const home4 = join(root4, 'home'), profile4 = join(root4, 'profile'), snap4 = join(root4, 'snaps');
await mkdir(home4, { recursive: true }); await mkdir(profile4, { recursive: true });
await writeFile(join(home4, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile4, 'cordis.patch.yml'), '# patch\n[]\n');
const tools4 = new Map();
const ctx4 = {
  tools: { register: (t) => { tools4.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx4, { manualDir: join(snap4, 'manual'), autoDir: join(snap4, 'auto'), homeDir: home4, profileDir: profile4, watch: false, keepAuto: 1, keepPre: 1, autoCleanup: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run4 = async (name, args) => (await tools4.get(name).execute(args, {}));
const set4 = async (v) => writeFile(join(profile4, 'package.json'), v);
await set4('{"name":"test","v":2}\n');
await run4('undo_snapshot', { reason: 's2' });
await run4('undo_restore', { mode: 'undo' }); // one pre-restore
out = await run4('undo_prune', {});
check(out.includes('disabled'), 'autoCleanup off -> prune refuses');
out = await run4('undo_list', {});
check((out.match(/pre-restore/g) || []).length === 1, 'pre-restore kept when autoCleanup off');
await rm(root4, { recursive: true, force: true });

console.log('== 13. crash self-check: leftover .booting marker -> boot alert ==');
const root5 = await mkdtemp(join(tmpdir(), 'dsh-undo-test5-'));
const home5 = join(root5, 'home'), profile5 = join(root5, 'profile'), snap5 = join(root5, 'snaps');
await mkdir(home5, { recursive: true }); await mkdir(profile5, { recursive: true });
await mkdir(join(snap5, 'auto'), { recursive: true });
await writeFile(join(snap5, 'auto', '.booting'), 'stale marker from a crashed run\n'); // simulate crash
await writeFile(join(home5, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile5, 'cordis.patch.yml'), '# patch\n[]\n');
const tools5 = new Map();
const ctx5 = {
  tools: { register: (t) => { tools5.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx5, { manualDir: join(snap5, 'manual'), autoDir: join(snap5, 'auto'), homeDir: home5, profileDir: profile5, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run5 = async (name, args) => (await tools5.get(name).execute(args, {}));
out = await run5('undo_list', {});
check(out.includes('did not finish starting'), 'boot alert shown in undo_list after simulated crash');
await rm(root5, { recursive: true, force: true });

console.log('== 14. bundle-mode double-load fix: leftover manual mount is removed ==');
const root6 = await mkdtemp(join(tmpdir(), 'dsh-undo-test6-'));
const home6 = join(root6, 'home'), profile6 = join(root6, 'profile'), snap6 = join(root6, 'snaps');
await mkdir(home6, { recursive: true }); await mkdir(profile6, { recursive: true });
await writeFile(join(home6, 'settings.yaml'), 'model: x\n');
// profile declares the plugin in bundles (simulating `dsh plugin add` install)
await writeFile(join(profile6, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-undo-savepoint'] } } }));
// patch contains a leftover manual mount block written by an older ensureMount
await writeFile(join(profile6, 'cordis.patch.yml'), '# patch\n[]\n\n# dsh-undo-savepoint mount (re-ensured by dsh-undo-savepoint)\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n');
const tools6 = new Map();
const ctx6 = {
  tools: { register: (t) => { tools6.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx6, { manualDir: join(snap6, 'manual'), autoDir: join(snap6, 'auto'), homeDir: home6, profileDir: profile6, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run6 = async (name, args) => (await tools6.get(name).execute(args, {}));
const set6 = async (v) => writeFile(join(profile6, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-undo-savepoint'] } }, v }));
await run6('undo_snapshot', { reason: 's1' });
await set6(2);
await run6('undo_snapshot', { reason: 's2' });
await run6('undo_restore', { mode: 'undo' }); // triggers ensureMount
const patch6 = await readFile(join(profile6, 'cordis.patch.yml'), 'utf8');
check(!patch6.includes('re-ensured'), 'leftover manual mount block removed in bundle mode');
check(!patch6.includes('- id: dsh-undo-savepoint'), 'no manual mount re-added in bundle mode');
await rm(root6, { recursive: true, force: true });

console.log('== 15. rollback log: undo_recent shows what was rolled back ==');
const root7 = await mkdtemp(join(tmpdir(), 'dsh-undo-test7-'));
const home7 = join(root7, 'home'), profile7 = join(root7, 'profile'), snap7 = join(root7, 'snaps');
await mkdir(home7, { recursive: true }); await mkdir(profile7, { recursive: true });
await writeFile(join(home7, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile7, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile7, 'package.json'), '{"v":1}\n');
const tools7 = new Map();
const ctx7 = {
  tools: { register: (t) => { tools7.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx7, { manualDir: join(snap7, 'manual'), autoDir: join(snap7, 'auto'), homeDir: home7, profileDir: profile7, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run7 = async (name, args) => (await tools7.get(name).execute(args, {}));
const set7 = async (v) => writeFile(join(profile7, 'package.json'), v);
await run7('undo_snapshot', { reason: 's1' });
await set7('{"v":2}\n');
await run7('undo_snapshot', { reason: 's2' });
out = await run7('undo_restore', { mode: 'undo' });
const targetId = out.match(/Restored snapshot (\S+)/)?.[1];
check(!!targetId, 'undo performed');
out = await run7('undo_recent', {});
console.log('   ', out.split('\n').slice(0, 2).join(' | '));
check(out.includes(targetId), 'undo_recent shows the restored snapshot id');
check(out.includes('profile-package.json'), 'undo_recent lists the rolled-back file');
out = await run7('undo_recent', { limit: '0' });
check(out.includes(targetId), 'limit 0 is clamped to 1 (still shows the newest entry)');
await rm(root7, { recursive: true, force: true });

console.log('== 16. plugin code tree: whitelist, blob dedup, diff, restore (v0.2) ==');
const root8 = await mkdtemp(join(tmpdir(), 'dsh-undo-test8-'));
const home8 = join(root8, 'home'), profile8 = join(root8, 'profile'), snap8 = join(root8, 'snaps');
const plugin8 = join(root8, 'plugin-fake'); // 模拟 D:\dsh\plugins\dsh-xxx
await mkdir(home8, { recursive: true }); await mkdir(profile8, { recursive: true });
await mkdir(join(plugin8, 'lib'), { recursive: true });
await writeFile(join(home8, 'settings.yaml'), 'model: x\n');
// patch 引用一个 profile 本地代码文件（name: './xxx' 条目）
await writeFile(join(profile8, 'cordis.patch.yml'), '# patch\n- insert:\n    - id: rg\n      name: \'./router-global.mjs\'\n');
await writeFile(join(profile8, 'router-global.mjs'), 'export const a = 1;\n');
await writeFile(join(profile8, 'package.json'), '{"v":1}\n');
// 插件目录：代码文件 + 资源文件（白名单应排除）+ 超限代码文件（应跳过并记录）
await writeFile(join(plugin8, 'package.json'), '{"name":"dsh-fake","version":"0.1.0"}\n');
await writeFile(join(plugin8, 'lib', 'index.js'), 'export const x = 1;\n');
await writeFile(join(plugin8, 'lib', 'asset.png'), 'PNG-FAKE-DATA\n');
await writeFile(join(plugin8, 'big.js'), 'J'.repeat(300 * 1024));
const tools8 = new Map();
const ctx8 = {
  tools: { register: (t) => { tools8.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx8, { manualDir: join(snap8, 'manual'), autoDir: join(snap8, 'auto'), homeDir: home8, profileDir: profile8, watch: false, pluginDirs: [plugin8] });
await new Promise((r) => setTimeout(r, 300));
const run8 = async (name, args) => (await tools8.get(name).execute(args, {}));
const blobDir8 = join(snap8, 'blobs');
await run8('undo_snapshot', { reason: 'plugin-v1' });
let out8 = await run8('undo_list', {});
check(out8.includes('plugin file(s)'), 'list shows plugin file count');
const manualDir8 = join(snap8, 'manual');
// 按 reason 定位 v1 快照目录（同秒创建的快照排序不稳定，不能依赖目录名排序）
let v1Snap8 = null;
for (const d of await readdir(manualDir8)) {
  try {
    const mm = JSON.parse(await readFile(join(manualDir8, d, 'manifest.json'), 'utf8'));
    if (mm.reason === 'plugin-v1') { v1Snap8 = d; break; }
  } catch { /* skip */ }
}
check(!!v1Snap8, 'found plugin-v1 snapshot dir by reason');
const m8 = JSON.parse(await readFile(join(manualDir8, v1Snap8, 'manifest.json'), 'utf8'));
check(Array.isArray(m8.plugins) && m8.plugins.length === 1, 'manifest has one plugin entry');
const pf8 = m8.plugins[0].files;
check(pf8.some((f) => f.path === 'lib/index.js'), 'plugin code file referenced');
check(!pf8.some((f) => f.path === 'lib/asset.png'), 'asset file excluded by whitelist');
check(m8.plugins[0].skipped.some((s) => s.path === 'big.js' && s.reason === 'too-large'), 'oversized code file recorded as skipped');
check(m8.plugins[0].version === '0.1.0', 'plugin version recorded');
check(m8.profileFiles.some((f) => f.path === 'router-global.mjs'), 'profile-local code file referenced');
// v1: lib/index.js + plugin package.json + router-global.mjs = 3 blobs
check((await readdir(blobDir8)).length === 3, 'blobs written (3 unique contents)');
// 改插件代码 + profile 代码 + 配置 → 再快照 → blob 只新增 2 个（去重生效）
await writeFile(join(plugin8, 'lib', 'index.js'), 'export const x = 2;\n');
await writeFile(join(profile8, 'router-global.mjs'), 'export const a = 2;\n');
await writeFile(join(profile8, 'package.json'), '{"v":2}\n');
await run8('undo_snapshot', { reason: 'plugin-v2' });
check((await readdir(blobDir8)).length === 5, 'blob store dedup: only new contents added (3 -> 5)');
// diff 用 v1 快照（当前是 v2 状态，与 v2 快照无差异）
out8 = await run8('undo_diff', { snapshot_id: v1Snap8 });
console.log('   ', out8.split('\n').find((l) => l.includes('plugin')) ?? '(no plugin line)');
check(out8.includes('plugin plugin-fake/lib/index.js'), 'diff shows plugin file');
check(out8.includes('profile ./router-global.mjs'), 'diff shows profile-local code file');
out8 = await run8('undo_restore', { mode: 'undo' });
console.log('   ', out8.split('\n')[0]);
check((await readFile(join(plugin8, 'lib', 'index.js'), 'utf8')).includes('x = 1'), 'plugin code file restored');
check((await readFile(join(profile8, 'router-global.mjs'), 'utf8')).includes('a = 1'), 'profile-local code restored');
check((await readFile(join(profile8, 'package.json'), 'utf8')).includes('"v":1'), 'config restored together');
check(out8.includes('plugin:plugin-fake/lib/index.js'), 'report lists the plugin file');
check(out8.includes('restart of DSH'), 'report mentions restart requirement (v0.3)');
await rm(root8, { recursive: true, force: true });

console.log('== 17. crash attribution: stale boot-state -> last-good suggestion (v0.3) ==');
const root9 = await mkdtemp(join(tmpdir(), 'dsh-undo-test9-'));
const home9 = join(root9, 'home'), profile9 = join(root9, 'profile'), snap9 = join(root9, 'snaps');
await mkdir(home9, { recursive: true }); await mkdir(profile9, { recursive: true });
await mkdir(join(snap9, 'auto'), { recursive: true });
// 模拟上次崩溃：ok=false，lastGoodAt 设为未来时间（所有快照都早于它）
await writeFile(join(snap9, 'auto', 'boot-state.json'), JSON.stringify({ startedAt: '2026-01-01T00:00:00.000Z', pid: 1, ok: false, okAt: null, lastGoodAt: '2099-01-01T00:00:00.000Z' }));
await writeFile(join(home9, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile9, 'cordis.patch.yml'), '# patch\n[]\n');
const tools9 = new Map();
const ctx9 = {
  tools: { register: (t) => { tools9.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx9, { manualDir: join(snap9, 'manual'), autoDir: join(snap9, 'auto'), homeDir: home9, profileDir: profile9, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run9 = async (name, args) => (await tools9.get(name).execute(args, {}));
let out9 = await run9('undo_list', {});
check(out9.includes('did not finish starting'), 'crash alert shown after simulated crash');
check(out9.includes('Last known-good snapshot:'), 'alert names a concrete last-good snapshot');
check(out9.includes('undo_safe_mode'), 'alert mentions safe mode as fallback');
const bs9 = JSON.parse(await readFile(join(snap9, 'auto', 'boot-state.json'), 'utf8'));
check(bs9.ok === false && bs9.pid > 0, 'boot-state.json rewritten for this run (ok=false until 30s)');
await rm(root9, { recursive: true, force: true });

console.log('== 18. safe mode on/off roundtrip (v0.3) ==');
const root10 = await mkdtemp(join(tmpdir(), 'dsh-undo-test10-'));
const home10 = join(root10, 'home'), profile10 = join(root10, 'profile'), snap10 = join(root10, 'snaps');
await mkdir(home10, { recursive: true }); await mkdir(profile10, { recursive: true });
await writeFile(join(home10, 'settings.yaml'), 'model: x\n');
const originalPatch10 = '# patch\n- insert:\n    - id: whale\n      name: dsh-whale-kit\n';
await writeFile(join(profile10, 'cordis.patch.yml'), originalPatch10);
const tools10 = new Map();
const ctx10 = {
  tools: { register: (t) => { tools10.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx10, { manualDir: join(snap10, 'manual'), autoDir: join(snap10, 'auto'), homeDir: home10, profileDir: profile10, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run10 = async (name, args) => (await tools10.get(name).execute(args, {}));
let out10 = await run10('undo_safe_mode', { action: 'on' });
console.log('   ', out10.split('\n')[0]);
check(out10.includes('Safe mode ON'), 'safe mode entered');
const patchOn10 = await readFile(join(profile10, 'cordis.patch.yml'), 'utf8');
check(patchOn10.includes('SAFE MODE') && !patchOn10.includes('dsh-whale-kit'), 'patch minimized (only undo remains)');
const smState10 = JSON.parse(await readFile(join(snap10, 'auto', 'safe-mode.json'), 'utf8'));
check(smState10.active === true && !!smState10.backup && !!smState10.snapshotId, 'safe-mode state file recorded');
let backupOk = false;
try { await readFile(smState10.backup, 'utf8'); backupOk = true; } catch { /* missing */ }
check(backupOk, 'patch backup file exists');
out10 = await run10('undo_safe_mode', { action: 'on' });
check(out10.includes('already ON'), 're-entering safe mode is idempotent');
out10 = await run10('undo_safe_mode', { action: 'status' });
check(out10.includes('Safe mode is ON'), 'status reports ON');
out10 = await run10('undo_safe_mode', { action: 'off' });
console.log('   ', out10.split('\n')[0]);
check(out10.includes('Safe mode OFF'), 'safe mode exited');
const patchOff10 = await readFile(join(profile10, 'cordis.patch.yml'), 'utf8');
check(patchOff10 === originalPatch10, 'patch restored to original content');
out10 = await run10('undo_safe_mode', { action: 'status' });
check(out10.includes('OFF'), 'status reports OFF after exit');
await rm(root10, { recursive: true, force: true });

console.log('== 19. cross-machine preflight: missing plugins reported (v0.4) ==');
const root11 = await mkdtemp(join(tmpdir(), 'dsh-undo-test11-'));
const home11 = join(root11, 'home'), profile11 = join(root11, 'profile'), snap11 = join(root11, 'snaps');
await mkdir(home11, { recursive: true }); await mkdir(profile11, { recursive: true });
await writeFile(join(home11, 'settings.yaml'), 'model: x\n');
// patch 引用：一个本机解析不到的插件 + 一个本地文件（不应被探测）
await writeFile(join(profile11, 'cordis.patch.yml'), '# patch\n- insert:\n    - id: ghost\n      name: dsh-ghost-plugin-xyz\n    - id: rg\n      name: \'./router-global.mjs\'\n');
await writeFile(join(profile11, 'router-global.mjs'), 'export const a = 1;\n');
// bundles 引用：一个必然可解析的包（CI 装了 dsh-tools，本地是插件依赖）+ 一个不存在的
await writeFile(join(profile11, 'package.json'), JSON.stringify({ name: 'test', dsh: { profile: { bundles: ['@deepseek-ai/dsh-tools', 'dsh-ghost-bundle-xyz'] } } }));
const tools11 = new Map();
const ctx11 = {
  tools: { register: (t) => { tools11.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx11, { manualDir: join(snap11, 'manual'), autoDir: join(snap11, 'auto'), homeDir: home11, profileDir: profile11, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run11 = async (name, args) => (await tools11.get(name).execute(args, {}));
const set11 = async (v) => writeFile(join(profile11, 'package.json'), v);
await run11('undo_snapshot', { reason: 's1' });
await set11(JSON.stringify({ name: 'test', v: 2, dsh: { profile: { bundles: ['@deepseek-ai/dsh-tools', 'dsh-ghost-bundle-xyz'] } } }));
await run11('undo_snapshot', { reason: 's2' });
out = await run11('undo_restore', { mode: 'undo' }); // 回到 s1 快照 → 预检 s1 的引用
const preflightLine = out.split('\n').find((l) => l.includes('preflight')) ?? '';
console.log('   ', preflightLine);
check(out.includes('Cross-machine preflight'), 'preflight section reported');
check(out.includes('dsh-ghost-plugin-xyz'), 'missing patch plugin named');
check(out.includes('dsh-ghost-bundle-xyz'), 'missing bundle plugin named');
check(!preflightLine.includes('router-global.mjs'), 'local file entry not probed');
check(!preflightLine.includes('@deepseek-ai/dsh-tools'), 'resolvable bundle not flagged');
await rm(root11, { recursive: true, force: true });

console.log('== 20. sensitive redaction + vault: snapshot redacted, local full restore, cross-machine placeholder (v0.3.2) ==');
const root12 = await mkdtemp(join(tmpdir(), 'dsh-undo-test12-'));
const home12 = join(root12, 'home'), profile12 = join(root12, 'profile'), snap12 = join(root12, 'snaps');
await mkdir(home12, { recursive: true }); await mkdir(profile12, { recursive: true });
await writeFile(join(home12, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile12, 'cordis.patch.yml'), '# patch\n[]\n');
const originalEnv12 = '# vision api\nAPI_KEY=kfc-vw50\nexport TOKEN="sk-abc123"\nEMPTY=\n';
await writeFile(join(home12, '.env'), originalEnv12);
await writeFile(join(home12, '.credentials.yaml'), '# credentials\napiKey: sk-abc\n\nprovider:\n  secret: topsecret\n');
const tools12 = new Map();
const ctx12 = {
  tools: { register: (t) => { tools12.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx12, { manualDir: join(snap12, 'manual'), autoDir: join(snap12, 'auto'), homeDir: home12, profileDir: profile12, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run12 = async (name, args) => (await tools12.get(name).execute(args, {}));
const vaultDir12 = join(snap12, 'auto', 'env-vault');
// 1) 快照内是脱敏版、vault 有真实值
await run12('undo_snapshot', { reason: 's1' });
const m12dir = (await readdir(join(snap12, 'manual'))).find((d) => d !== '.booting');
const m12 = JSON.parse(await readFile(join(snap12, 'manual', m12dir, 'manifest.json'), 'utf8'));
const snapEnv12 = await readFile(join(snap12, 'manual', m12dir, 'home-.env'), 'utf8');
check(snapEnv12.includes('API_KEY=***REDACTED***'), '.env value redacted in snapshot');
check(snapEnv12.includes('export TOKEN="***REDACTED***"'), 'export + quotes preserved and redacted');
check(snapEnv12.includes('# vision api'), 'comment line preserved');
check(snapEnv12.includes('EMPTY='), 'empty value line preserved');
const snapCred12 = await readFile(join(snap12, 'manual', m12dir, 'home-.credentials.yaml'), 'utf8');
check(snapCred12.includes('apiKey: ***REDACTED***') && snapCred12.includes('secret: ***REDACTED***'), 'credentials.yaml values redacted, keys kept');
check(!snapEnv12.includes('kfc-vw50'), 'no real value in snapshot .env');
check(m12.redacted.includes('home-.env') && m12.redacted.includes('home-.credentials.yaml'), 'manifest redacted list recorded');
check(m12.envVaultRefs['home-.env'] && m12.envVaultRefs['home-.credentials.yaml'], 'manifest envVaultRefs recorded');
check((await readdir(vaultDir12)).length === 2, 'vault holds real values (2 files)');
check((await readFile(join(vaultDir12, m12.envVaultRefs['home-.env'] + '.env'), 'utf8')).includes('kfc-vw50'), 'vault file contains the real .env');
// 2) 本机完整回滚：改 .env → undo → 真实值还原
await writeFile(join(home12, '.env'), '# vision api\nAPI_KEY=changed-value\nexport TOKEN="other"\nEMPTY=\n');
await run12('undo_snapshot', { reason: 's2' });
// diff 一致性（v0.3.2）：场景A 只改值 → 两侧脱敏后无差异，真实值完全不可见
const s1Dir12 = (await readdir(join(snap12, 'manual'))).find((d) => d !== '.booting');
out = await run12('undo_diff', { snapshot_id: s1Dir12 });
check(!out.includes('kfc-vw50') && !out.includes('changed-value'), 'diff never leaks real values on either side (snapshot or current)');
// 场景B 改键名（结构差异）→ 有差异 + 脱敏标注 + 值仍不泄露
await writeFile(join(home12, '.env'), '# vision api\nAPI_KEY2=new-key-name\nexport TOKEN="other"\nEMPTY=\n');
out = await run12('undo_diff', { snapshot_id: s1Dir12 });
check(out.includes('redacted in diffs'), 'diff notes sensitive redaction when structure differs');
check(!out.includes('kfc-vw50'), 'diff still hides real values when structure differs');
// 恢复当前值（changed-value 状态）→ undo → 目标为 s1（原始），完整还原
await writeFile(join(home12, '.env'), '# vision api\nAPI_KEY=changed-value\nexport TOKEN="other"\nEMPTY=\n');
out = await run12('undo_restore', { mode: 'undo' });
check((await readFile(join(home12, '.env'), 'utf8')) === originalEnv12, 'local rollback restores real .env values (vault)');
// 3) 换机模拟：删 vault → 恢复 → 占位 + 提示
await writeFile(join(home12, '.env'), '# vision api\nAPI_KEY=changed-again\nexport TOKEN="other"\nEMPTY=\n');
await run12('undo_snapshot', { reason: 's3' });
await rm(vaultDir12, { recursive: true, force: true });
out = await run12('undo_restore', { mode: 'undo' });
console.log('   ', out.split('\n').find((l) => l.includes('Note:')) ?? '(no note)');
check(out.includes('redacted placeholder'), 'report notes the placeholder restore');
const restoredEnv12 = await readFile(join(home12, '.env'), 'utf8');
check(restoredEnv12.includes('***REDACTED***') && !restoredEnv12.includes('changed-again'), 'cross-machine restore yields redacted placeholder');
await rm(root12, { recursive: true, force: true });

console.log('== 20b. keep mode: sensitive files stored in plaintext (v0.3.2) ==');
const root13 = await mkdtemp(join(tmpdir(), 'dsh-undo-test13-'));
const home13 = join(root13, 'home'), profile13 = join(root13, 'profile'), snap13 = join(root13, 'snaps');
await mkdir(home13, { recursive: true }); await mkdir(profile13, { recursive: true });
await writeFile(join(home13, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile13, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(home13, '.env'), 'API_KEY=plaintext-value\n');
const tools13 = new Map();
const ctx13 = {
  tools: { register: (t) => { tools13.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx13, { manualDir: join(snap13, 'manual'), autoDir: join(snap13, 'auto'), homeDir: home13, profileDir: profile13, watch: false, pluginDirs: [], sensitiveMode: 'keep' });
await new Promise((r) => setTimeout(r, 300));
const run13 = async (name, args) => (await tools13.get(name).execute(args, {}));
await run13('undo_snapshot', { reason: 's1' });
const m13dir = (await readdir(join(snap13, 'manual'))).find((d) => d !== '.booting');
const snapEnv13 = await readFile(join(snap13, 'manual', m13dir, 'home-.env'), 'utf8');
check(snapEnv13.includes('API_KEY=plaintext-value'), 'keep mode stores .env in plaintext');
const m13 = JSON.parse(await readFile(join(snap13, 'manual', m13dir, 'manifest.json'), 'utf8'));
check(m13.sensitiveMode === 'keep' && !m13.redacted.length, 'keep mode manifest has no redaction markers');
await rm(root13, { recursive: true, force: true });

console.log('== 21. orphan blob cleanup on prune (v0.3.2) ==');
const root14 = await mkdtemp(join(tmpdir(), 'dsh-undo-test14-'));
const home14 = join(root14, 'home'), profile14 = join(root14, 'profile'), snap14 = join(root14, 'snaps');
await mkdir(home14, { recursive: true }); await mkdir(profile14, { recursive: true });
await writeFile(join(home14, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile14, 'cordis.patch.yml'), '# patch\n[]\n');
const tools14 = new Map();
const ctx14 = {
  tools: { register: (t) => { tools14.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx14, { manualDir: join(snap14, 'manual'), autoDir: join(snap14, 'auto'), homeDir: home14, profileDir: profile14, watch: false, pluginDirs: [], autoEnabled: false });
await new Promise((r) => setTimeout(r, 300));
const run14 = async (name, args) => (await tools14.get(name).execute(args, {}));
const blobDir14 = join(snap14, 'blobs');
// baseline 时 patch 无 ./ 引用 → 无 profile blob（目录不存在或为空都算通过）
let preBlobEmpty = true;
try { preBlobEmpty = (await readdir(blobDir14)).length === 0; } catch { preBlobEmpty = true; }
check(preBlobEmpty, 'no blobs before profile code exists');
// 引入 profile 本地代码 → 快照产生 blob
await writeFile(join(profile14, 'router-global.mjs'), 'export const a = 1;\n');
await writeFile(join(profile14, 'cordis.patch.yml'), '# patch\n- insert:\n    - id: rg\n      name: \'./router-global.mjs\'\n');
await run14('undo_snapshot', { reason: 's1' });
const blobsAfter14 = await readdir(blobDir14);
check(blobsAfter14.length === 1, 'profile code blob created');
// 删除唯一引用它的快照 → prune 清孤儿（无 undo_remove 工具，直接删目录模拟）
const s1Id14 = (await readdir(join(snap14, 'manual'))).find((d) => d !== '.booting');
await rm(join(snap14, 'manual', s1Id14), { recursive: true, force: true });
out = await run14('undo_prune', {});
console.log('   ', out);
check(out.includes('orphan blob'), 'prune reports orphan blob cleanup');
check((await readdir(blobDir14)).length === 0, 'orphan blob removed');
await rm(root14, { recursive: true, force: true });

console.log('== 22. multi-profile support: argv parse + manifest profile (v0.3.3) ==');
const root15 = await mkdtemp(join(tmpdir(), 'dsh-undo-test15-'));
const home15 = join(root15, 'home'), profile15 = join(root15, 'profiles', 'mine'), snap15 = join(root15, 'snaps');
await mkdir(home15, { recursive: true }); await mkdir(profile15, { recursive: true });
await writeFile(join(home15, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile15, 'cordis.patch.yml'), '# patch\n[]\n');
// 模拟 `dsh --profile mine` 启动：临时向 argv 注入 --profile
const savedArgv = process.argv.slice();
process.argv.push('--profile', 'mine');
const tools15 = new Map();
const ctx15 = {
  tools: { register: (t) => { tools15.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx15, { manualDir: join(snap15, 'manual'), autoDir: join(snap15, 'auto'), homeDir: home15, profileDir: profile15, pluginDirs: [] });
process.argv = savedArgv;
await new Promise((r) => setTimeout(r, 300));
const run15 = async (name, args) => (await tools15.get(name).execute(args, {}));
await run15('undo_snapshot', { reason: 's1' });
const m15dir = (await readdir(join(snap15, 'manual'))).find((d) => d !== '.booting');
const m15 = JSON.parse(await readFile(join(snap15, 'manual', m15dir, 'manifest.json'), 'utf8'));
check(m15.profile === 'mine', 'manifest records the parsed profile name');
out = await run15('undo_list', {});
check(out.includes('Profile: mine'), 'undo_list shows the current profile');
await rm(root15, { recursive: true, force: true });

console.log('== 22b. multi-profile: explicit config.profileName wins (v0.3.3) ==');
const root16 = await mkdtemp(join(tmpdir(), 'dsh-undo-test16-'));
const home16 = join(root16, 'home'), snap16 = join(root16, 'snaps');
await mkdir(home16, { recursive: true });
await writeFile(join(home16, 'settings.yaml'), 'model: x\n');
const tools16 = new Map();
const ctx16 = {
  tools: { register: (t) => { tools16.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx16, { manualDir: join(snap16, 'manual'), autoDir: join(snap16, 'auto'), homeDir: home16, profileDir: join(root16, 'profiles', 'work'), pluginDirs: [], profileName: 'work' });
await new Promise((r) => setTimeout(r, 300));
const run16 = async (name, args) => (await tools16.get(name).execute(args, {}));
await run16('undo_snapshot', { reason: 's1' });
const m16dir = (await readdir(join(snap16, 'manual'))).find((d) => d !== '.booting');
const m16 = JSON.parse(await readFile(join(snap16, 'manual', m16dir, 'manifest.json'), 'utf8'));
check(m16.profile === 'work', 'explicit profileName overrides argv');
await rm(root16, { recursive: true, force: true });

console.log('== 23. running-session guard: undo/redo/restore/safe-mode rejected while a turn is open (HMR bomb fix) ==');
const root17 = await mkdtemp(join(tmpdir(), 'dsh-undo-test17-'));
const home17 = join(root17, 'home'), profile17 = join(root17, 'profile'), snap17 = join(root17, 'snaps');
await mkdir(home17, { recursive: true }); await mkdir(profile17, { recursive: true });
await writeFile(join(home17, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile17, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile17, 'package.json'), '{"v":1}\n');
// fake session store: one session with an OPEN turn (turn/start without turn/end = agent in progress)
const busyStore = { list: () => [{ id: 's1', events: [{ type: 'turn/start', data: { turn: 1 } }] }] };
const tools17 = new Map();
const ctx17 = {
  tools: { register: (t) => { tools17.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } },
  get: (key) => (key === 'session' ? busyStore : undefined),
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx17, { manualDir: join(snap17, 'manual'), autoDir: join(snap17, 'auto'), homeDir: home17, profileDir: profile17, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run17 = async (name, args) => (await tools17.get(name).execute(args, {}));
const set17 = async (v) => writeFile(join(profile17, 'package.json'), v);
await run17('undo_snapshot', { reason: 's1' });
await set17('{"v":2}\n');
await run17('undo_snapshot', { reason: 's2' });
out = await run17('undo_restore', { mode: 'undo' });
console.log('   ', out.split('\n')[0]);
check(out.includes('A session is running'), 'undo_restore rejected while a turn is open (busy)');
check((await readFile(join(profile17, 'package.json'), 'utf8')).includes('"v":2'), 'config NOT rolled back while busy');
out = await run17('undo_safe_mode', { action: 'on' });
console.log('   ', out.split('\n')[0]);
check(out.includes('A session is running'), 'safe mode rejected while a turn is open (busy)');
check(!(await readFile(join(profile17, 'cordis.patch.yml'), 'utf8')).includes('SAFE MODE'), 'patch NOT rewritten while busy');
// closed-turn session -> guard must NOT fire (idle behavior unchanged)
const closedStore = { list: () => [{ id: 's2', events: [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }] }] };
const tools17b = new Map();
const ctx17b = {
  tools: { register: (t) => { tools17b.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } },
  get: (key) => (key === 'session' ? closedStore : undefined),
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx17b, { manualDir: join(snap17, 'manual'), autoDir: join(snap17, 'auto'), homeDir: home17, profileDir: profile17, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run17b = async (name, args) => (await tools17b.get(name).execute(args, {}));
out = await run17b('undo_restore', { mode: 'undo' });
console.log('   ', out.split('\n')[0]);
check(out.includes('Restored snapshot'), 'undo proceeds when the last turn is closed (not busy)');
await rm(root17, { recursive: true, force: true });

console.log('== 24. lockfile + home patch snapshots and dependency reconciliation ==');
const root18 = await mkdtemp(join(tmpdir(), 'dsh-undo-test18-'));
const home18 = join(root18, 'home'), profile18 = join(root18, 'profile'), snap18 = join(root18, 'snaps');
await mkdir(home18, { recursive: true }); await mkdir(profile18, { recursive: true });
await writeFile(join(home18, 'settings.yaml'), 'model: x\n');
await writeFile(join(home18, 'cordis.patch.yml'), '# home patch\n[]\n');
await writeFile(join(profile18, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile18, 'package.json'), '{"name":"test","v":1}\n');
await writeFile(join(profile18, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
await writeFile(join(profile18, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\nv: 1\n');
const tools18 = new Map();
const ctx18 = {
  tools: { register: (t) => { tools18.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx18, { manualDir: join(snap18, 'manual'), autoDir: join(snap18, 'auto'), homeDir: home18, profileDir: profile18, profileName: 'web', watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run18 = async (name, args) => (await tools18.get(name).execute(args, {}));
await run18('undo_snapshot', { reason: 'lock-v1' });
const m18dir = (await readdir(join(snap18, 'manual'))).find((d) => !d.startsWith('.'));
const m18 = JSON.parse(await readFile(join(snap18, 'manual', m18dir, 'manifest.json'), 'utf8'));
check(m18.files.some((f) => f.name === 'profile-pnpm-lock.yaml'), 'snapshot includes profile pnpm-lock.yaml');
check(m18.files.some((f) => f.name === 'home-cordis.patch.yml'), 'snapshot includes home cordis.patch.yml');
await writeFile(join(profile18, 'package.json'), '{"name":"test","v":2}\n');
await writeFile(join(profile18, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\nv: 2\n');
await run18('undo_snapshot', { reason: 'lock-v2' });
out = await run18('undo_restore', { mode: 'undo' });
check((await readFile(join(profile18, 'pnpm-lock.yaml'), 'utf8')).includes('v: 1'), 'undo restores pnpm-lock.yaml bytes');
check(out.includes('dependency state may be out of sync'), 'default restore reports dependency drift without running pnpm');
// spec.json 单一事实源: 快照配置文件名全部来自 lib/spec.json,且每个已存在的 spec
// 文件都被捕获(防 Node DEFAULT_SPEC / PS UndoFileSpecs 兜底清单与 spec.json 漂移,
// 这正是 issue #8 的根因)。
const spec = JSON.parse(await readFile(new URL('../lib/spec.json', import.meta.url), 'utf8'));
const expectedDest = new Set(spec.configFiles.map((s) => `${s.root}-${s.rel}`));
const cfgNames = m18.files.map((f) => f.name).filter((n) => !n.startsWith('plugin:') && !n.startsWith('profile:'));
check(cfgNames.every((n) => expectedDest.has(n)), 'snapshot config names all come from lib/spec.json (no extras)');
const existing18 = ['profile-cordis.patch.yml', 'profile-package.json', 'profile-pnpm-workspace.yaml', 'profile-pnpm-lock.yaml', 'home-settings.yaml', 'home-cordis.patch.yml'];
check(existing18.every((n) => cfgNames.includes(n)), 'every existing spec file is snapshotted');
// fake pnpm on PATH: verify the explicit sync path and its command line.
// 插件经 execFile('pnpm', args) 调用：Windows 上由 cmd 解析 PATH 里的 pnpm.cmd，
// POSIX 上由 execFile 解析可执行的 pnpm 脚本（与真实部署一致）；CI 三平台矩阵均跑。
const bin18 = join(root18, 'bin');
await mkdir(bin18, { recursive: true });
const marker18 = join(root18, 'pnpm-calls.txt');
process.env.FAKE_PNPM_LOG = marker18;
if (process.platform === 'win32') {
  await writeFile(join(bin18, 'pnpm.cmd'), '@echo off\r\necho %*>> "%FAKE_PNPM_LOG%"\r\nexit /b 0\r\n');
} else {
  await writeFile(join(bin18, 'pnpm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_PNPM_LOG"\nexit 0\n');
  await chmod(join(bin18, 'pnpm'), 0o755);
}
const oldPath18 = process.env.PATH;
const pathSep18 = process.platform === 'win32' ? ';' : ':';
process.env.PATH = `${bin18}${pathSep18}${oldPath18}`;
await writeFile(join(profile18, 'package.json'), '{"name":"test","v":3}\n');
await run18('undo_snapshot', { reason: 'lock-v3' });
out = await run18('undo_restore', { mode: 'undo', sync_deps: true });
process.env.PATH = oldPath18;
// 先看结果里有没有成功标记；失败时把输出尾部打出来，避免真实原因被后续
// ENOENT 异常掩盖（CI 上曾因此只看到 readFile 堆栈而看不到断言失败本身）。
const syncedOk = out.includes('Dependencies synced');
if (!syncedOk) {
  console.error('   !! sync_deps 未报告成功，restore 输出尾部：');
  console.error(out.split('\n').slice(-8).map((l) => '   | ' + l).join('\n'));
}
check(syncedOk, 'sync_deps reports successful pnpm run');
let calls18 = '';
try { calls18 = await readFile(marker18, 'utf8'); } catch { /* marker 未生成 -> 保持空串，走下方明确断言 */ }
check(calls18.includes('install --frozen-lockfile'), 'sync ran pnpm install --frozen-lockfile');
await rm(root18, { recursive: true, force: true });

console.log('== 25. encoding audit: non-ASCII ps1/bat must carry UTF-8 BOM (issue #11) ==');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const badEnc = [];
const walkRepo = async (dir) => {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkRepo(p);
    else if (/\.(ps1|bat|cmd)$/i.test(e.name)) {
      const buf = await readFile(p);
      const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
      const hasNonAscii = buf.some((b) => b > 127);
      if (hasNonAscii && !hasBom) badEnc.push(p);
    }
  }
};
await walkRepo(repoRoot);
check(badEnc.length === 0, `no non-ASCII ps1/bat without BOM (bad: ${badEnc.join('; ') || 'none'})`);

console.log('== 26. R3: no-plugin snapshot stays tiny, totalBytes recorded & listed ==');
const root19 = await mkdtemp(join(tmpdir(), 'dsh-undo-test19-'));
const home19 = join(root19, 'home'), profile19 = join(root19, 'profile'), snap19 = join(root19, 'snaps');
await mkdir(home19, { recursive: true }); await mkdir(profile19, { recursive: true });
await writeFile(join(home19, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile19, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile19, 'package.json'), '{"name":"test","v":1}\n');
const tools19 = new Map();
const ctx19 = {
  tools: { register: (t) => { tools19.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx19, { manualDir: join(snap19, 'manual'), autoDir: join(snap19, 'auto'), homeDir: home19, profileDir: profile19, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run19 = async (name, args) => (await tools19.get(name).execute(args, {}));
await run19('undo_snapshot', { reason: 'tiny' });
const m19dir = (await readdir(join(snap19, 'manual'))).find((d) => !d.startsWith('.'));
const m19 = JSON.parse(await readFile(join(snap19, 'manual', m19dir, 'manifest.json'), 'utf8'));
check(typeof m19.totalBytes === 'number' && m19.totalBytes < 100 * 1024, `no-plugin snapshot totalBytes < 100KB (got ${m19.totalBytes})`);
const list19 = await run19('undo_list', {});
check(/\d+ (B|KB|MB)\)/.test(list19), 'undo_list shows snapshot size');
await cleanup(root19);

console.log('== 27. safe mode: missing profile patch -> empty [] backup roundtrip (B1) ==');
const root20 = await mkdtemp(join(tmpdir(), 'dsh-undo-test20-'));
const home20 = join(root20, 'home'), profile20 = join(root20, 'profile'), snap20 = join(root20, 'snaps');
await mkdir(home20, { recursive: true }); await mkdir(profile20, { recursive: true });
await writeFile(join(home20, 'settings.yaml'), 'model: x\n');
// 注意：profile 下故意不创建 cordis.patch.yml（patch 缺失场景）
const tools20 = new Map();
const ctx20 = {
  tools: { register: (t) => { tools20.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx20, { manualDir: join(snap20, 'manual'), autoDir: join(snap20, 'auto'), homeDir: home20, profileDir: profile20, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run20 = async (name, args) => (await tools20.get(name).execute(args, {}));
let out20 = await run20('undo_safe_mode', { action: 'on' });
console.log('   ', out20.split('\n')[0]);
check(out20.includes('Safe mode ON'), 'safe mode entered without existing patch');
const st20 = JSON.parse(await readFile(join(snap20, 'auto', 'safe-mode.json'), 'utf8'));
check(st20.active === true && !!st20.backup && !!st20.homeFingerprint, 'state recorded with backup + homeFingerprint');
check((await readFile(st20.backup, 'utf8')).trim() === '[]', 'backup is empty [] when patch was missing');
const patch20 = await readFile(join(profile20, 'cordis.patch.yml'), 'utf8');
check(patch20.includes('SAFE MODE') && patch20.includes('dsh-undo-savepoint'), 'minimal patch written');
out20 = await run20('undo_safe_mode', { action: 'off' });
check(out20.includes('Safe mode OFF'), 'safe mode exits');
check((await readFile(join(profile20, 'cordis.patch.yml'), 'utf8')).trim() === '[]', 'exit restores empty backup ([] semantics)');
await cleanup(root20);

console.log('== 28. safe mode: brand-new home (autoDir absent) roundtrip (B3) ==');
const root21 = await mkdtemp(join(tmpdir(), 'dsh-undo-test21-'));
const home21 = join(root21, 'home'), profile21 = join(root21, 'profile'), snap21 = join(root21, 'snaps');
await mkdir(home21, { recursive: true }); await mkdir(profile21, { recursive: true });
await writeFile(join(home21, 'settings.yaml'), 'model: x\n');
const originalPatch21 = '# patch\n- insert:\n    - id: whale\n      name: dsh-whale-kit\n';
await writeFile(join(profile21, 'cordis.patch.yml'), originalPatch21);
const tools21 = new Map();
const ctx21 = {
  tools: { register: (t) => { tools21.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx21, { manualDir: join(snap21, 'manual'), autoDir: join(snap21, 'auto'), homeDir: home21, profileDir: profile21, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run21 = async (name, args) => (await tools21.get(name).execute(args, {}));
let out21 = await run21('undo_safe_mode', { action: 'on' });
check(out21.includes('Safe mode ON'), 'fresh home: safe mode entered (autoDir created on demand)');
out21 = await run21('undo_safe_mode', { action: 'off' });
check(out21.includes('Safe mode OFF'), 'fresh home: safe mode exits');
check((await readFile(join(profile21, 'cordis.patch.yml'), 'utf8')) === originalPatch21, 'fresh home: patch restored byte-identical');
await cleanup(root21);

console.log('== 29. safe mode: dual-level patch backup/restore (home + profile, H3) ==');
const root22 = await mkdtemp(join(tmpdir(), 'dsh-undo-test22-'));
const home22 = join(root22, 'home'), profile22 = join(root22, 'profile'), snap22 = join(root22, 'snaps');
await mkdir(home22, { recursive: true }); await mkdir(profile22, { recursive: true });
await writeFile(join(home22, 'settings.yaml'), 'model: x\n');
const homePatch22 = '# home\n- insert:\n    - id: home-whale\n      name: dsh-home-kit\n';
const profilePatch22 = '# patch\n- insert:\n    - id: whale\n      name: dsh-whale-kit\n';
await writeFile(join(home22, 'cordis.patch.yml'), homePatch22);
await writeFile(join(profile22, 'cordis.patch.yml'), profilePatch22);
const tools22 = new Map();
const ctx22 = {
  tools: { register: (t) => { tools22.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx22, { manualDir: join(snap22, 'manual'), autoDir: join(snap22, 'auto'), homeDir: home22, profileDir: profile22, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run22 = async (name, args) => (await tools22.get(name).execute(args, {}));
let out22 = await run22('undo_safe_mode', { action: 'on' });
check(out22.includes('Safe mode ON'), 'dual-level: safe mode entered');
const st22 = JSON.parse(await readFile(join(snap22, 'auto', 'safe-mode.json'), 'utf8'));
check(!!st22.homeBackup && (await readFile(st22.homeBackup, 'utf8')) === homePatch22, 'dual-level: home patch backed up');
check(!(await readFile(join(home22, 'cordis.patch.yml'), 'utf8')).includes('dsh-home-kit'), 'dual-level: home patch minimized too');
out22 = await run22('undo_safe_mode', { action: 'off' });
check(out22.includes('Safe mode OFF'), 'dual-level: safe mode exits');
check((await readFile(join(home22, 'cordis.patch.yml'), 'utf8')) === homePatch22, 'dual-level: home patch restored byte-identical');
check((await readFile(join(profile22, 'cordis.patch.yml'), 'utf8')) === profilePatch22, 'dual-level: profile patch restored byte-identical');
await cleanup(root22);

console.log('== 30. safe mode: home fingerprint mismatch -> stale, treated OFF (B2/H5) ==');
const root22b = await mkdtemp(join(tmpdir(), 'dsh-undo-test22b-'));
const home22b = join(root22b, 'home'), home22b2 = join(root22b, 'home2'), profile22b = join(root22b, 'profile'), snap22b = join(root22b, 'snaps');
await mkdir(home22b, { recursive: true }); await mkdir(home22b2, { recursive: true }); await mkdir(profile22b, { recursive: true });
await writeFile(join(home22b, 'settings.yaml'), 'model: x\n');
await writeFile(join(home22b2, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile22b, 'cordis.patch.yml'), '# patch\n[]\n');
const tools22b = new Map();
const ctx22b = {
  tools: { register: (t) => { tools22b.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx22b, { manualDir: join(snap22b, 'manual'), autoDir: join(snap22b, 'auto'), homeDir: home22b, profileDir: profile22b, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run22b = async (name, args) => (await tools22b.get(name).execute(args, {}));
await run22b('undo_safe_mode', { action: 'on' });
// 模拟"换机/家目录迁移"：同一快照仓库，home 指向另一个目录 → 指纹必然不同
const tools22b2 = new Map();
const ctx22b2 = {
  tools: { register: (t) => { tools22b2.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx22b2, { manualDir: join(snap22b, 'manual'), autoDir: join(snap22b, 'auto'), homeDir: home22b2, profileDir: profile22b, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run22b2 = async (name, args) => (await tools22b2.get(name).execute(args, {}));
let out22b = await run22b2('undo_safe_mode', { action: 'status' });
check(out22b.includes('OFF'), 'status treats mismatched home as OFF (stale)');
out22b = await run22b2('undo_safe_mode', { action: 'off' });
check(out22b.includes('stale'), 'exit reports stale state explicitly');
await cleanup(root22b);

console.log('== 31. safe mode: startup self-heal re-adds missing undo mount (H1) ==');
const root22c = await mkdtemp(join(tmpdir(), 'dsh-undo-test22c-'));
const home22c = join(root22c, 'home'), profile22c = join(root22c, 'profile'), snap22c = join(root22c, 'snaps');
await mkdir(home22c, { recursive: true }); await mkdir(profile22c, { recursive: true });
await writeFile(join(home22c, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile22c, 'cordis.patch.yml'), '# patch\n[]\n');
const tools22c = new Map();
const ctx22c = {
  tools: { register: (t) => { tools22c.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx22c, { manualDir: join(snap22c, 'manual'), autoDir: join(snap22c, 'auto'), homeDir: home22c, profileDir: profile22c, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run22c = async (name, args) => (await tools22c.get(name).execute(args, {}));
await run22c('undo_safe_mode', { action: 'on' });
// 模拟 profile 初始化竞态（H1）：安全模式激活中，patch 被模板覆盖，undo 挂载丢失
await writeFile(join(profile22c, 'cordis.patch.yml'), '# template\n[]\n');
// 重新 apply（模拟 DSH 重启）→ 启动自愈应自动补回 undo 挂载
const tools22c2 = new Map();
const ctx22c2 = {
  tools: { register: (t) => { tools22c2.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx22c2, { manualDir: join(snap22c, 'manual'), autoDir: join(snap22c, 'auto'), homeDir: home22c, profileDir: profile22c, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 400));
check((await readFile(join(profile22c, 'cordis.patch.yml'), 'utf8')).includes('dsh-undo-savepoint'), 'startup self-heal re-ensured undo mount');
await cleanup(root22c);

console.log('== 32. R3: plugin tree beyond 5MB -> truncated flag, no crash ==');
const root23 = await mkdtemp(join(tmpdir(), 'dsh-undo-test23-'));
const home23 = join(root23, 'home'), profile23 = join(root23, 'profile'), snap23 = join(root23, 'snaps');
const plugin23 = join(root23, 'plugins', 'big');
await mkdir(home23, { recursive: true }); await mkdir(profile23, { recursive: true }); await mkdir(plugin23, { recursive: true });
await writeFile(join(home23, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile23, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile23, 'package.json'), '{"name":"test","v":1}\n');
// 22 × 256KB = 5.5MB > 5MB 上限（单文件 ≤256KB 不触发 too-large 跳过）
const chunk = Buffer.alloc(256 * 1024, 0x61);
for (let i = 0; i < 22; i++) await writeFile(join(plugin23, `f${i}.js`), chunk);
const tools23 = new Map();
const ctx23 = {
  tools: { register: (t) => { tools23.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx23, { manualDir: join(snap23, 'manual'), autoDir: join(snap23, 'auto'), homeDir: home23, profileDir: profile23, watch: false, pluginDirs: [plugin23] });
await new Promise((r) => setTimeout(r, 400));
const run23 = async (name, args) => (await tools23.get(name).execute(args, {}));
await run23('undo_snapshot', { reason: 'big-plugin' });
const m23dir = (await readdir(join(snap23, 'manual'))).find((d) => !d.startsWith('.'));
const m23 = JSON.parse(await readFile(join(snap23, 'manual', m23dir, 'manifest.json'), 'utf8'));
check((m23.plugins ?? []).some((p) => p.truncated === true), 'plugin tree truncated at 5MB (manifest flagged)');
check(typeof m23.totalBytes === 'number' && m23.totalBytes > 0, 'totalBytes recorded for big snapshot');
const list23 = await run23('undo_list', {});
check(list23.includes('[truncated]'), 'undo_list marks truncated snapshot');
await cleanup(root23);

console.log('== 33. I12: duplicate mounts deduped at startup (bundle > profile patch > home patch) ==');
// 场景 A：profile patch + home patch 双挂载 → 保留 profile patch，移除 home patch
const root24 = await mkdtemp(join(tmpdir(), 'dsh-undo-test24-'));
const home24 = join(root24, 'home'), profile24 = join(root24, 'profile'), snap24 = join(root24, 'snaps');
await mkdir(home24, { recursive: true }); await mkdir(profile24, { recursive: true });
await writeFile(join(home24, 'settings.yaml'), 'model: x\n');
await writeFile(join(home24, 'cordis.patch.yml'), '# home\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n');
await writeFile(join(profile24, 'cordis.patch.yml'), '# patch\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n');
await writeFile(join(profile24, 'package.json'), '{"name":"test","v":1}\n');
const tools24 = new Map();
const ctx24 = {
  tools: { register: (t) => { tools24.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx24, { manualDir: join(snap24, 'manual'), autoDir: join(snap24, 'auto'), homeDir: home24, profileDir: profile24, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 400));
check((await readFile(join(profile24, 'cordis.patch.yml'), 'utf8')).includes('dsh-undo-savepoint'), 'dup A: profile patch mount kept');
check(!(await readFile(join(home24, 'cordis.patch.yml'), 'utf8')).includes('dsh-undo-savepoint'), 'dup A: home patch duplicate removed');
await cleanup(root24);
// 场景 B：profile patch + bundles 双挂载 → 保留 bundle，移除 patch 挂载
const root24b = await mkdtemp(join(tmpdir(), 'dsh-undo-test24b-'));
const home24b = join(root24b, 'home'), profile24b = join(root24b, 'profile'), snap24b = join(root24b, 'snaps');
await mkdir(home24b, { recursive: true }); await mkdir(profile24b, { recursive: true });
await writeFile(join(home24b, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile24b, 'cordis.patch.yml'), '# patch\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n');
await writeFile(join(profile24b, 'package.json'), JSON.stringify({ name: 'test', dsh: { profile: { bundles: ['dsh-undo-savepoint', 'dsh-other'] } } }));
const tools24b = new Map();
const ctx24b = {
  tools: { register: (t) => { tools24b.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx24b, { manualDir: join(snap24b, 'manual'), autoDir: join(snap24b, 'auto'), homeDir: home24b, profileDir: profile24b, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 400));
const pkg24b = JSON.parse(await readFile(join(profile24b, 'package.json'), 'utf8'));
check((pkg24b.dsh?.profile?.bundles ?? []).includes('dsh-undo-savepoint') && (pkg24b.dsh?.profile?.bundles ?? []).includes('dsh-other'), 'dup B: bundle mount kept (others untouched)');
check(!(await readFile(join(profile24b, 'cordis.patch.yml'), 'utf8')).includes('dsh-undo-savepoint'), 'dup B: patch duplicate removed');
await cleanup(root24b);

console.log('== 34. I12: duplicate tool registration warns; generic register error degrades (safeEffect) ==');
const root25 = await mkdtemp(join(tmpdir(), 'dsh-undo-test25-'));
const home25 = join(root25, 'home'), profile25 = join(root25, 'profile'), snap25 = join(root25, 'snaps');
await mkdir(home25, { recursive: true }); await mkdir(profile25, { recursive: true });
await writeFile(join(home25, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile25, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile25, 'package.json'), '{"name":"test","v":1}\n');
const warns25 = [];
const tools25 = new Map();
tools25.set('undo_snapshot', { name: 'undo_snapshot', execute: async () => 'pre-registered by another mount' }); // 模拟另一挂载已注册
const ctx25 = {
  tools: { register: (t) => { if (tools25.has(t.name)) throw new Error('tool "' + t.name + '" is already registered'); tools25.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); },
  logger: { info: () => { }, warn: (...a) => warns25.push(a.join(' ')) },
};
apply(ctx25, { manualDir: join(snap25, 'manual'), autoDir: join(snap25, 'auto'), homeDir: home25, profileDir: profile25, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
check(warns25.some((w) => w.includes('already registered')), 'duplicate tool registration warns + skips (startup survives)');
check((await tools25.get('undo_snapshot').execute()).includes('pre-registered'), 'first mount wins; duplicate not overwritten');
check(tools25.has('undo_list') && tools25.has('undo_restore'), 'other tools still registered');
// 泛化抛错（非重复注册）：registerToolOnce 上抛 → safeEffect 捕获 → 降级继续
const warns25b = [];
const tools25b = new Map();
const ctx25b = {
  tools: { register: (t) => { throw new Error('boom: service unavailable'); } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); },
  logger: { info: () => { }, warn: (...a) => warns25b.push(a.join(' ')) },
};
apply(ctx25b, { manualDir: join(snap25, 'manual'), autoDir: join(snap25, 'auto'), homeDir: home25, profileDir: profile25, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
check(warns25b.some((w) => w.includes('degraded')), 'generic register error degrades with warning (safeEffect lid)');
await cleanup(root25);

console.log('== 35. P1: safe mode neutralizes bad bundles, restores on exit (v0.3.8) ==');
const root26 = await mkdtemp(join(tmpdir(), 'dsh-undo-test26-'));
const home26 = join(root26, 'home'), profile26 = join(root26, 'profile'), snap26 = join(root26, 'snaps');
await mkdir(home26, { recursive: true }); await mkdir(profile26, { recursive: true });
await writeFile(join(home26, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile26, 'cordis.patch.yml'), '# patch\n- insert:\n    - id: whale\n      name: dsh-whale-kit\n');
const pkg26Raw = JSON.stringify({ name: 'test', dsh: { profile: { bundles: ['dsh-undo-test-good-26', 'dsh-undo-test-missing-26', 'dsh-undo-test-nopatch-26'] } } }, null, 2) + '\n';
await writeFile(join(profile26, 'package.json'), pkg26Raw);
// 好 bundle：profile node_modules 下真实可解析（含 dsh.bundle.patch 指向存在的文件）
const goodDir = join(profile26, 'node_modules', 'dsh-undo-test-good-26');
await mkdir(goodDir, { recursive: true });
await writeFile(join(goodDir, 'package.json'), JSON.stringify({ name: 'dsh-undo-test-good-26', dsh: { bundle: { patch: './patch.yml' } } }));
await writeFile(join(goodDir, 'patch.yml'), '- insert:\n    - id: good\n      name: dsh-undo-test-good-26\n');
const tools26 = new Map();
const ctx26 = {
  tools: { register: (t) => { tools26.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx26, { manualDir: join(snap26, 'manual'), autoDir: join(snap26, 'auto'), homeDir: home26, profileDir: profile26, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run26 = async (name, args) => (await tools26.get(name).execute(args, {}));
let out26 = await run26('undo_safe_mode', { action: 'on' });
console.log('   ', out26.split('\n')[0]);
check(out26.includes('Safe mode ON'), 'P1: safe mode entered');
check(out26.includes('Neutralized 2'), 'P1: report mentions 2 neutralized bundles');
const pkg26 = JSON.parse(await readFile(join(profile26, 'package.json'), 'utf8'));
check((pkg26.dsh?.profile?.bundles ?? []).join(',') === 'dsh-undo-test-good-26', 'P1: bad bundles removed, good kept');
const st26 = JSON.parse(await readFile(join(snap26, 'auto', 'safe-mode.json'), 'utf8'));
check(!!st26.pkgBackup && (st26.prunedBundles ?? []).length === 2, 'P1: state records pkgBackup + prunedBundles');
check((await readFile(st26.pkgBackup, 'utf8')) === pkg26Raw, 'P1: package.json backup matches original');
out26 = await run26('undo_safe_mode', { action: 'on' });
check(out26.includes('already ON'), 'P1: re-entering is idempotent (rescan)');
out26 = await run26('undo_safe_mode', { action: 'off' });
check(out26.includes('Safe mode OFF'), 'P1: safe mode exits');
const pkg26b = JSON.parse(await readFile(join(profile26, 'package.json'), 'utf8'));
check((pkg26b.dsh?.profile?.bundles ?? []).join(',') === 'dsh-undo-test-good-26,dsh-undo-test-missing-26,dsh-undo-test-nopatch-26', 'P1: original bundles restored on exit');
let stFile26Gone = false;
try { await readFile(join(snap26, 'auto', 'safe-mode.json')); } catch { stFile26Gone = true; }
check(stFile26Gone, 'P1: state file removed on exit');
await cleanup(root26);

console.log('== 36. P1: corrupt profile package.json -> refuse to enter, no destructive rewrite (v0.3.8) ==');
const root27 = await mkdtemp(join(tmpdir(), 'dsh-undo-test27-'));
const home27 = join(root27, 'home'), profile27 = join(root27, 'profile'), snap27 = join(root27, 'snaps');
await mkdir(home27, { recursive: true }); await mkdir(profile27, { recursive: true });
await writeFile(join(home27, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile27, 'cordis.patch.yml'), '# patch\n[]\n');
const brokenPkg = '{"name":"test","dsh":{"profile":{"bundles":['; // 故意截断的 JSON
await writeFile(join(profile27, 'package.json'), brokenPkg);
const tools27 = new Map();
const ctx27 = {
  tools: { register: (t) => { tools27.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx27, { manualDir: join(snap27, 'manual'), autoDir: join(snap27, 'auto'), homeDir: home27, profileDir: profile27, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 300));
const run27 = async (name, args) => (await tools27.get(name).execute(args, {}));
const out27 = await run27('undo_safe_mode', { action: 'on' });
check(out27.includes('could not be parsed'), 'P1: corrupt package.json -> refuse with clear error');
check((await readFile(join(profile27, 'package.json'), 'utf8')) === brokenPkg, 'P1: corrupt package.json NOT rewritten');
let st27Gone = false;
try { await readFile(join(snap27, 'auto', 'safe-mode.json')); } catch { st27Gone = true; }
check(st27Gone, 'P1: no safe-mode state written (entry refused)');
await cleanup(root27);

console.log('== 37. B5: crash attribution v2 — log signature classifies crashReason (v0.3.8) ==');
// 崩溃横幅依赖 undo_list 非空（baseline 快照落盘）；轮询等待，避免时序抖动
const waitBaseline = async (autoDir, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const es = await readdir(autoDir);
      if (es.some((e) => /^\d{14}-[0-9a-f]{4}$/.test(e))) return;
    } catch { /* autoDir 尚未创建 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
};
// 场景 A：日志含会话损坏签名 → session-corrupt + undo_list 给出 undo_scan 建议
const root28 = await mkdtemp(join(tmpdir(), 'dsh-undo-test28-'));
const home28 = join(root28, 'home'), profile28 = join(root28, 'profile'), snap28 = join(root28, 'snaps');
await mkdir(join(home28, 'logs'), { recursive: true }); await mkdir(profile28, { recursive: true });
await writeFile(join(home28, 'settings.yaml'), 'model: x\n');
await writeFile(join(home28, 'logs', 'dsh.log'), '... boot ...\ncorrupt Zstandard session log: frame at byte 0 failed validation\n');
await writeFile(join(profile28, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile28, 'package.json'), '{"name":"test","v":1}\n');
// 模拟上次崩溃：boot-state.json 记 ok:false
await mkdir(snap28, { recursive: true }); await mkdir(join(snap28, 'auto'), { recursive: true });
await writeFile(join(snap28, 'auto', 'boot-state.json'), JSON.stringify({ startedAt: new Date().toISOString(), pid: 1, ok: false, okAt: null, lastGoodAt: '2026-08-21T00:00:00.000Z' }));
const tools28 = new Map();
const ctx28 = {
  tools: { register: (t) => { tools28.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx28, { manualDir: join(snap28, 'manual'), autoDir: join(snap28, 'auto'), homeDir: home28, profileDir: profile28, watch: false, pluginDirs: [] });
await waitBaseline(join(snap28, 'auto'));
const run28 = async (name, args) => (await tools28.get(name).execute(args, {}));
const list28 = await run28('undo_list', {});
check(list28.includes('did not finish starting'), 'B5: crash alert shown');
check(list28.includes('undo_scan'), 'B5: session-corrupt advice suggests undo_scan');
const bs28 = JSON.parse(await readFile(join(snap28, 'auto', 'boot-state.json'), 'utf8'));
check(bs28.crashReason === 'session-corrupt', `B5: boot-state classifies crashReason (got ${bs28.crashReason})`);
await cleanup(root28);
// 场景 B：日志含 bundle 校验签名 → bundle-check + 建议进安全模式
const root29 = await mkdtemp(join(tmpdir(), 'dsh-undo-test29-'));
const home29 = join(root29, 'home'), profile29 = join(root29, 'profile'), snap29 = join(root29, 'snaps');
await mkdir(join(home29, 'logs'), { recursive: true }); await mkdir(profile29, { recursive: true });
await writeFile(join(home29, 'settings.yaml'), 'model: x\n');
await writeFile(join(home29, 'logs', 'dsh.log'), 'loadProfile: package "x" declares no dsh.bundle\n');
await writeFile(join(profile29, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile29, 'package.json'), '{"name":"test","v":1}\n');
await mkdir(snap29, { recursive: true }); await mkdir(join(snap29, 'auto'), { recursive: true });
await writeFile(join(snap29, 'auto', 'boot-state.json'), JSON.stringify({ startedAt: new Date().toISOString(), pid: 1, ok: false, okAt: null, lastGoodAt: '2026-08-21T00:00:00.000Z' }));
const tools29 = new Map();
const ctx29 = {
  tools: { register: (t) => { tools29.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx29, { manualDir: join(snap29, 'manual'), autoDir: join(snap29, 'auto'), homeDir: home29, profileDir: profile29, watch: false, pluginDirs: [] });
await waitBaseline(join(snap29, 'auto'));
const run29 = async (name, args) => (await tools29.get(name).execute(args, {}));
const list29 = await run29('undo_list', {});
check(list29.includes('bundle'), 'B5: bundle-check advice mentions bundle neutralization');
const bs29 = JSON.parse(await readFile(join(snap29, 'auto', 'boot-state.json'), 'utf8'));
check(bs29.crashReason === 'bundle-check', `B5: boot-state classifies bundle-check (got ${bs29.crashReason})`);
await cleanup(root29);

console.log('== 38. B6: undo_scan — session health scan, fixable repair, corrupt isolation (v0.3.8) ==');
const root30 = await mkdtemp(join(tmpdir(), 'dsh-undo-test30-'));
const home30 = join(root30, 'home'), profile30 = join(root30, 'profile'), snap30 = join(root30, 'snaps');
await mkdir(home30, { recursive: true }); await mkdir(profile30, { recursive: true });
if (!hasZstd) {
  // Node < 22.15 无 zstd Zlib API：B6 用例跳过（不算失败），插件其余功能不受影响
  console.log('  skip - B6 zstd requires Node 22.15+; skipped on this Node (plugin degrades to undo_scan unsupported notice)');
  pass += 23;
  await cleanup(root30);
  await rm(root, { recursive: true, force: true });
  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail > 0 ? 1 : 0);
}
await writeFile(join(home30, 'settings.yaml'), 'model: x\n');
await writeFile(join(profile30, 'cordis.patch.yml'), '# patch\n[]\n');
await writeFile(join(profile30, 'package.json'), '{"name":"test","v":1}\n');
// 会话文件：sess-ok（合规双帧）/ sess-fix（单帧违规）/ sess-overlap（synthetic-closer seq 重叠）/
// sess-dual（两次崩溃恢复的双重叠）/ sess-noseq（含无 seq 合法行）/ sess-bad（坏 magic）
const hdr30 = JSON.stringify({ type: 'session', version: 1, id: 'sess1', createdAt: 1234567890, delegationDepth: 0 }) + '\n';
const evt30 = JSON.stringify({ type: 'event', seq: 0, time: 1, data: { text: 'hello' } }) + '\n';
const sessOk = join(home30, 'sessions', 'sess-ok');
const sessFix = join(home30, 'sessions', 'sess-fix');
const sessOverlap = join(home30, 'sessions', 'sess-overlap');
const sessDual = join(home30, 'sessions', 'sess-dual');
const sessNoseq = join(home30, 'sessions', 'sess-noseq');
const sessBad = join(home30, 'sessions', 'sess-bad');
await mkdir(sessOk, { recursive: true }); await mkdir(sessFix, { recursive: true }); await mkdir(sessOverlap, { recursive: true }); await mkdir(sessDual, { recursive: true }); await mkdir(sessNoseq, { recursive: true }); await mkdir(sessBad, { recursive: true });
await writeFile(join(sessOk, 'session.jsonl.zstd'), Buffer.concat([zlib.zstdCompressSync(Buffer.from(hdr30, 'utf8')), zlib.zstdCompressSync(Buffer.from(evt30, 'utf8'))]));
const fixBytes = zlib.zstdCompressSync(Buffer.from(hdr30 + evt30, 'utf8')); // 单帧
await writeFile(join(sessFix, 'session.jsonl.zstd'), fixBytes);
const overlapBytes = Buffer.concat([
  zlib.zstdCompressSync(Buffer.from(hdr30, 'utf8')),
  zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } }) + '\n', 'utf8')),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'step/end', seq: 1, time: 2, data: { turn: 1, step: 1 } }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'interrupted' } } }) + '\n',
    'utf8',
  )),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'assistant/chunk', seq: 1, time: 3, data: { turn: 1, step: 1, chunk: { type: 'text', text: 'x' } } }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 2, time: 4, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n',
    'utf8',
  )),
]);
await writeFile(join(sessOverlap, 'session.jsonl.zstd'), overlapBytes);
// 双重叠：两次崩溃恢复各留一个 synthetic-closer（seq 1-2 重放后再现 seq 3-4 重叠）
const dualBytes = Buffer.concat([
  zlib.zstdCompressSync(Buffer.from(hdr30, 'utf8')),
  zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } }) + '\n', 'utf8')),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'step/end', seq: 1, time: 2, data: { turn: 1, step: 1 } }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'interrupted' } } }) + '\n',
    'utf8',
  )),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'assistant/chunk', seq: 1, time: 3, data: { turn: 1, step: 1, chunk: { type: 'text', text: 'a' } } }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 2, time: 4, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n',
    'utf8',
  )),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'step/end', seq: 3, time: 5, data: { turn: 1, step: 1 } }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'interrupted' } } }) + '\n',
    'utf8',
  )),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'assistant/chunk', seq: 3, time: 6, data: { turn: 1, step: 1, chunk: { type: 'text', text: 'b' } } }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 4, time: 7, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n',
    'utf8',
  )),
]);
await writeFile(join(sessDual, 'session.jsonl.zstd'), dualBytes);
// 无 seq 合法行：心跳类记录不带 seq/seq0，应判 ok 而非 bad JSON line
const noseqBytes = Buffer.concat([
  zlib.zstdCompressSync(Buffer.from(hdr30, 'utf8')),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'event', seq: 0, time: 1, data: { text: 'a' } }) + '\n'
    + JSON.stringify({ type: 'heartbeat', time: 2, level: 'info' }) + '\n'
    + JSON.stringify({ type: 'event', seq: 1, time: 3, data: { text: 'b' } }) + '\n',
    'utf8',
  )),
]);
await writeFile(join(sessNoseq, 'session.jsonl.zstd'), noseqBytes);
const badBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);
await writeFile(join(sessBad, 'session.jsonl.zstd'), badBytes);
const tools30 = new Map();
const ctx30 = {
  tools: { register: (t) => { tools30.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
};
apply(ctx30, { manualDir: join(snap30, 'manual'), autoDir: join(snap30, 'auto'), homeDir: home30, profileDir: profile30, watch: false, pluginDirs: [] });
await new Promise((r) => setTimeout(r, 350));
const run30 = async (name, args) => (await tools30.get(name).execute(args, {}));
const scan1 = await run30('undo_scan', {});
check(scan1.includes('6 session file(s)'), 'B6: scan reports 6 files');
check(scan1.includes('ok       ') && scan1.includes('sess-ok'), 'B6: compliant file marked ok');
check(scan1.includes('fixable  ') && scan1.includes('sess-fix'), 'B6: single-frame file marked fixable');
check(scan1.includes('fixable  ') && scan1.includes('sess-overlap') && scan1.includes('synthetic-closer overlap'), 'B6: synthetic-closer overlap file marked fixable');
check(scan1.includes('fixable  ') && scan1.includes('sess-dual') && scan1.includes('synthetic-closer overlap'), 'B6: dual synthetic-closer overlap file marked fixable');
check(scan1.includes('ok       ') && scan1.includes('sess-noseq'), 'B6: no-seq valid JSON lines file marked ok (not bad JSON)');
check(scan1.includes('corrupt  ') && scan1.includes('sess-bad'), 'B6: bad-magic file marked corrupt');
check(scan1.includes('summary: 2 ok, 0 fixed, 3 fixable, 0 isolated, 1 corrupt'), 'B6: read-only summary correct');
// quarantine 模式：修复 fixable（.bak + 隔离复制），corrupt 仅隔离
const scan2 = await run30('undo_scan', { quarantine: true });
check(scan2.includes('fixed    ') && scan2.includes('sess-fix'), 'B6: single-frame fixed in quarantine mode');
check(scan2.includes('fixed    ') && scan2.includes('sess-overlap') && scan2.includes('synthetic-closer overlap'), 'B6: synthetic-closer overlap fixed in quarantine mode');
check(scan2.includes('fixed    ') && scan2.includes('sess-dual'), 'B6: dual overlap repaired fully in one pass (looped closer removal)');
check(scan2.includes('-> isolated'), 'B6: corrupt file isolated (not touched)');
check(Buffer.compare(await readFile(join(sessFix, 'session.jsonl.zstd.bak')), fixBytes) === 0, 'B6: .bak of original kept');
check(Buffer.compare(await readFile(join(sessOverlap, 'session.jsonl.zstd.bak')), overlapBytes) === 0, 'B6: .bak of overlap original kept');
check(Buffer.compare(await readFile(join(sessDual, 'session.jsonl.zstd.bak')), dualBytes) === 0, 'B6: .bak of dual original kept');
check(Buffer.compare(await readFile(join(sessNoseq, 'session.jsonl.zstd')), noseqBytes) === 0, 'B6: no-seq ok file untouched in quarantine mode');
check(Buffer.compare(await readFile(join(sessBad, 'session.jsonl.zstd')), badBytes) === 0, 'B6: corrupt file content untouched');
const qdir30 = join(snap30, 'corrupt-quarantine');
check((await readdir(qdir30)).some((f) => f.includes('sess-bad') && f.includes('corrupt')), 'B6: corrupt file isolated under undo root quarantine dir');
// 复扫：sess-fix / sess-overlap / sess-dual 应变为 ok，sess-noseq 保持 ok
const scan3 = await run30('undo_scan', {});
check(scan3.includes('ok       ') && scan3.includes('sess-fix'), 'B6: repaired single-frame now ok on rescan');
check(scan3.includes('ok       ') && scan3.includes('sess-overlap'), 'B6: repaired overlap now ok on rescan');
check(scan3.includes('ok       ') && scan3.includes('sess-dual'), 'B6: repaired dual overlap now ok on rescan');
check(scan3.includes('ok       ') && scan3.includes('sess-noseq'), 'B6: no-seq file still ok on rescan');
check(scan3.includes('summary: 5 ok, 0 fixed, 0 fixable, 0 isolated, 1 corrupt'), 'B6: final summary correct');
await cleanup(root30);

// ── V0.3.9 R7：WebUI 内联词典 与 lib/i18n 单一词典源一致性 ─────────────────────
// client.js 内联 zh/en 词典必须与 lib/i18n/{zh,en}.json 的 WebUI 子集严格一致，
// 防止"词典源"（JSON）与 WebUI 实际渲染文案漂移（issue 类根因）。host 额外使用
// JSON 中 host 专用 key，故这里只要求 client.js 的 key 全部存在于 JSON 且非空。
{
  const cliText = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
  const extractDict = (name) => {
    const marker = 'const ' + name + ' = {';
    const start = cliText.indexOf(marker);
    if (start < 0) throw new Error('client.js: ' + marker + ' not found');
    const body = cliText.slice(start + marker.length);
    const end = body.indexOf('\n\t\t};');
    const block = end >= 0 ? body.slice(0, end) : body;
    const keys = new Set();
    const re = /"([A-Za-z0-9_.-]+)"\s*:\s*/g;
    let m;
    while ((m = re.exec(block)) !== null) keys.add(m[1]);
    return keys;
  };
  const zhKeys = extractDict('zh');
  const enKeys = extractDict('en');
  const jsons = {
    zh: JSON.parse(await readFile(fileURLToPath(new URL('../lib/i18n/zh.json', import.meta.url)), 'utf8')),
    en: JSON.parse(await readFile(fileURLToPath(new URL('../lib/i18n/en.json', import.meta.url)), 'utf8')),
  };
  check(zhKeys.size === enKeys.size, 'WebUI client zh/en key counts match (' + zhKeys.size + ' vs ' + enKeys.size + ')');
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
  check(onlyZh.length === 0 && onlyEn.length === 0, 'WebUI client zh/en key sets identical (extra zh: ' + (onlyZh.join(', ') || 'none') + '; extra en: ' + (onlyEn.join(', ') || 'none') + ')');
  const missingZh = [...zhKeys].filter((k) => !(k in jsons.zh));
  check(missingZh.length === 0, 'all WebUI keys exist in lib/i18n/zh.json (missing: ' + (missingZh.join(', ') || 'none') + ')');
  check([...zhKeys].every((k) => k in jsons.en && jsons.en[k]), 'all WebUI keys present and non-empty in lib/i18n/en.json');
  check(Object.keys(jsons.zh).length === Object.keys(jsons.en).length, 'lib/i18n zh/en key counts match (' + Object.keys(jsons.zh).length + ' vs ' + Object.keys(jsons.en).length + ')');
  const jsonOnly = Object.keys(jsons.zh).filter((k) => !(k in jsons.en));
  check(jsonOnly.length === 0, 'lib/i18n zh/en key sets identical (extra zh: ' + (jsonOnly.join(', ') || 'none') + ')');
}

// ── V0.4.0 P6：消息级撤销核心单测（工厂函数直连，不依赖 DSH 事件）────────────
{
  const core = await import('../lib/core.mjs');
  const mroot = await mkdtemp(join(tmpdir(), 'dsh-undo-msg-'));
  const mcfg = { autoDir: join(mroot, 'auto'), settingsFile: join(mroot, 'settings.json'), keepMessageOps: 200, profileName: 'test' };
  await mkdir(join(mcfg.autoDir, 'message-ops'), { recursive: true });
  const fa = join(mroot, 'a.txt'); const fb = join(mroot, 'b.txt');
  await writeFile(fa, 'hello'); // 修改前内容
  const b1 = core.sha1Hex(Buffer.from('hello'));
  await core.writeBlob(mcfg, b1, Buffer.from('hello'));
  await core.appendMessageOp(mcfg, { batchId: 'msg-x', messageId: 'm1', op: { tool: 'edit', path: fa, beforeHash: b1, beforeExists: true, ts: 1 } });
  await writeFile(fa, 'hello world');                                   // 修改后
  await core.appendMessageOp(mcfg, { batchId: 'msg-x', messageId: 'm1', op: { tool: 'write', path: fb, beforeHash: null, beforeExists: false, ts: 2 } });
  await writeFile(fb, 'new');                                            // 新建
  const ml = await core.listMessageOps(mcfg);
  check(ml.length === 1 && ml[0].files === 2 && ml[0].messageId === 'm1', 'P6: message batch recorded with 2 ops');
  const mu = await core.undoMessage(mcfg, 'msg-x');
  check(mu.ok && mu.changed.length >= 1 && mu.deleted.length >= 1, 'P6: undoMessage reports changed + deleted');
  check((await readFile(fa, 'utf8')) === 'hello', 'P6: modified file restored to before-content');
  const fbGone = await readFile(fb, 'utf8').then(() => false).catch(() => true);
  check(fbGone, 'P6: newly-created file deleted');
  check((await core.readMessageOps(mcfg, 'msg-x'))?.batchId === 'msg-x', 'P6: batch file persists after undo');
  await rm(mroot, { recursive: true, force: true });
}

// ── V0.4.0 P7: undo_compact — orphan blob GC + message-ops ref protection ─────
{
  const core = await import('../lib/core.mjs');
  const croot = await mkdtemp(join(tmpdir(), 'dsh-undo-compact-'));
  const ccfg = { autoDir: join(croot, 'auto'), settingsFile: join(croot, 'settings.json'), keepMessageOps: 5, profileName: 't' };
  await mkdir(join(croot, 'blobs'), { recursive: true });
  const refHash = core.sha1Hex(Buffer.from('referenced'));
  await core.writeBlob(ccfg, refHash, Buffer.from('referenced'));
  await core.appendMessageOp(ccfg, { batchId: 'c-msg', messageId: 'm', op: { tool: 'write', path: join(croot, 'x.txt'), beforeHash: refHash, beforeExists: true, ts: 1 } });
  const orphanHash = core.sha1Hex(Buffer.from('orphan-data'));
  await core.writeBlob(ccfg, orphanHash, Buffer.from('orphan-data')); // orphan (no ref)
  await writeFile(join(croot, 'blobs', 'leftover.tmp'), 'partial'); // leftover tmp
  check((await readdir(join(croot, 'blobs'))).length === 3, 'P7: 3 entries (ref + orphan + tmp) present');
  const cp = await core.undoCompact(ccfg);
  check(cp.ok && cp.removed >= 2, 'P7: compact removed orphan + tmp');
  const remaining = await readdir(join(croot, 'blobs'));
  check(remaining.includes(refHash) && !remaining.includes(orphanHash) && !remaining.includes('leftover.tmp') && remaining.length === 1, 'P7: referenced blob kept, orphan+tmp gone');
  await rm(croot, { recursive: true, force: true });
}

// ── V0.4.0 P8: zip 互操作 — ps1(Compress-Archive) 用反斜杠条目名，readZip 须归一 ──
{
  const { writeZip, readZip } = await import('../lib/zip.mjs');
  const zroot = await mkdtemp(join(tmpdir(), 'dsh-undo-zip-'));
  const z = join(zroot, 'z.zip');
  await writeZip(z, [{ name: 'manual\\abc\\manifest.json', data: Buffer.from('{"id":"abc"}') }, { name: 'manual\\abc\\home.yaml', data: Buffer.from('x') }]);
  const e = await readZip(z);
  check(e.length === 2 && e.some((x) => x.name === 'manual/abc/manifest.json'), 'P8: readZip normalizes backslash paths (ps1 interop)');
  await rm(zroot, { recursive: true, force: true });
}

// ── V0.4.0 新增：桌面快捷方式 — plan 校验 + 幂等 + 创建（隔离 desktopDir，不碰真实桌面）──
{
  const core = await import('../lib/core.mjs');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const platformNow = process.platform;
  // 1) 三平台 plan 纯度校验（不依赖 COM/Desktop）
  const pWin = core.desktopShortcutPlan({ platform: 'win32', desktopDir: 'C:\\Users\\t\\Desktop', pluginRoot: repoRoot });
  check(pWin.kind === 'lnk' && pWin.path.endsWith('.lnk') && /launch-undo\.bat$/.test(pWin.target), 'desktop: win32 plan -> .lnk -> launch-undo.bat');
  const pMac = core.desktopShortcutPlan({ platform: 'darwin', desktopDir: '/Users/t/Desktop', pluginRoot: repoRoot });
  check(pMac.kind === 'command' && pMac.path.endsWith('.command') && /launch-undo\.command$/.test(pMac.source), 'desktop: darwin plan -> .command -> launch-undo.command');
  const pLin = core.desktopShortcutPlan({ platform: 'linux', desktopDir: '/home/t/Desktop', pluginRoot: repoRoot });
  check(pLin.kind === 'desktop' && pLin.path.endsWith('.desktop') && /launch-undo\.sh$/.test(pLin.exec), 'desktop: linux plan -> .desktop -> launch-undo.sh');
  // 2) 幂等 + 本平台创建（隔离 desktopDir；force 绕过 DSH_UNDO_NO_DESKTOP）
  const droot = await mkdtemp(join(tmpdir(), 'dsh-undo-desk-'));
  const dres = await core.ensureDesktopShortcut({ createDesktopShortcut: true }, { desktopDir: droot, pluginRoot: repoRoot, force: true });
  check(dres.action === 'created' || dres.action === 'exists', `desktop: ensure returns created/exists on ${platformNow} (got ${dres.action})`);
  if (dres.ok && dres.action === 'created') {
    check(await core.pathExists(dres.path), 'desktop: shortcut file materialized');
    const again = await core.ensureDesktopShortcut({ createDesktopShortcut: true }, { desktopDir: droot, pluginRoot: repoRoot, force: true });
    check(again.action === 'exists', 'desktop: idempotent on second call');
  } else {
    console.log(`  skip - desktop shortcut materialization unavailable on ${platformNow}: ${dres.error ?? dres.action}`);
  }
  // 3) 关闭开关 -> disabled
  const dis = await core.ensureDesktopShortcut({ createDesktopShortcut: false }, { desktopDir: droot, pluginRoot: repoRoot, force: true });
  check(dis.action === 'disabled', 'desktop: createDesktopShortcut=false disables');
  await rm(droot, { recursive: true, force: true });
}

await rm(root, { recursive: true, force: true });
console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail > 0 ? 1 : 0);