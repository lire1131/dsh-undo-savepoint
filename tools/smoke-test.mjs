// tools/smoke-test.mjs — offline smoke test of dsh-undo-savepoint logic (no DSH needed).
// Run:  node tools/smoke-test.mjs
process.env.DSH_ROOT = process.env.DSH_ROOT ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
// 测试固定英文输出（V0.3.9 R7）：host 端随 DSH_UNDO_LANG 本地化，断言基于英文文案。
process.env.DSH_UNDO_LANG = 'en';
// 测试不碰真实桌面：DSH_UNDO_NO_DESKTOP=1 让 apply() 启动时的桌面快捷方式功能跳过。
process.env.DSH_UNDO_NO_DESKTOP = '1';
import { mkdtemp, writeFile, readFile, mkdir, rm as rmRaw, readdir, chmod, symlink, rmdir, realpath } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// M1 回归：全部文档化工具必须通过真实 defineTool 注册成功（dsh-tools 拒绝
// { type:'object', properties } 包装时这里会先抓到，不再静默降级）。
check(tools.has('undo_doctor'), 'M1: undo_doctor registered (parameters schema compatible)');
check(tools.has('undo_message'), 'M1: undo_message registered (parameters schema compatible)');
check(tools.has('undo_compact'), 'M1: undo_compact registered (parameters schema compatible)');
check(tools.has('undo_message_list') && tools.has('undo_scan') && tools.has('undo_safe_mode'), 'M1: undo_message_list / undo_scan / undo_safe_mode registered');
const cur = async (f) => readFile(join(profile, f), 'utf8');
const set = async (f, v) => writeFile(join(profile, f), v);
// Windows 上 fs.rm 偶发 ENOTEMPTY（杀软/索引器短暂占用目录句柄），清理时重试几次
const cleanup = async (dir) => rm(dir, { recursive: true, force: true });
// apply() 的启动流程是异步 IIFE，baseline 快照是它最后一步。断言启动期状态（挂载
// 自愈、重复挂载去重、崩溃横幅、boot-state）之前必须等它真正落地：固定 sleep 在
// 慢机器上是拿时序赌运气（2026-09-15 实测 prune 与 self-heal 因此常年假红）。
const waitBaseline = async (autoDir, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      for (const e of await readdir(autoDir)) {
        if (!/^\d{14}-[0-9a-f]{4}$/.test(e)) continue;
        try { await readFile(join(autoDir, e, 'manifest.json'), 'utf8'); return true; } catch { /* 目录已建、清单未落 */ }
      }
    } catch { /* autoDir 尚未创建 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
// 轮询直到条件成立：启动期会改文件的断言一律用它，别再用固定 sleep。
const waitUntil = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch { /* 条件还不成立 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

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
// 崩溃横幅由启动流程异步写进 cfg.bootAlert：等 boot-state.json 记上本次 pid 再断言
await waitUntil(async () => (JSON.parse(await readFile(join(snap9, 'auto', 'boot-state.json'), 'utf8')).pid === process.pid));
// 横幅还要求 undo_list 非空：快照列表为空时 undo_list 直接返回“暂无快照”，
// 根本走不到横幅那段（2026-09-15 定位）。等 baseline 落盘再断言。
await waitBaseline(join(snap9, 'auto'));
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
// W49（#39）：补丁层文件进脱敏清单后，快照内是脱敏副本、还原侧由守卫二拒写占位符候选，
// 因此本步的 cordis.patch.yml 保持还原前内容（挂载块被再确保），预检读不到 dsh-ghost-plugin-xyz。
// 这不是退步：预检保护的对象是 bundle 引用（下面一条仍被点名），而补丁层凭据此前是明文入库的。
check(!out.includes('dsh-ghost-plugin-xyz'), 'W49: patch-layer redaction keeps the placeholder out of the live patch (ghost not probed)');
check(!out.includes('Undo failed'), 'W49: restore still reports success (skip is not an error)');
check(out.includes('dsh-ghost-bundle-xyz'), 'missing bundle plugin named');
check(!preflightLine.includes('router-global.mjs'), 'local file entry not probed');
check(!preflightLine.includes('@deepseek-ai/dsh-tools'), 'resolvable bundle not flagged');
await rm(root11, { recursive: true, force: true });

console.log('== 20. sensitive redaction + vault: snapshot redacted, local full restore, cross-machine placeholder (v0.3.2) ==');
const root12 = await mkdtemp(join(tmpdir(), 'dsh-undo-test12-'));
const home12 = join(root12, 'home'), profile12 = join(root12, 'profile'), snap12 = join(root12, 'snaps');
await mkdir(home12, { recursive: true }); await mkdir(profile12, { recursive: true });
await writeFile(join(home12, 'settings.yaml'), 'model: x\napiKey: sk-live-token12\n');
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
check(snapCred12.includes('apiKey: "***REDACTED***"') && snapCred12.includes('secret: "***REDACTED***"'), 'credentials.yaml values redacted, keys kept');
const snapSet12 = await readFile(join(snap12, 'manual', m12dir, 'home-settings.yaml'), 'utf8');
check(snapSet12.includes('model: "***REDACTED***"') && snapSet12.includes('apiKey: "***REDACTED***"'), 'home settings.yaml values redacted in snapshot (keys kept)');
check(!snapSet12.includes('sk-live-token12'), 'no real token in snapshot settings.yaml');
check(!snapEnv12.includes('kfc-vw50'), 'no real value in snapshot .env');
check(m12.redacted.includes('home-.env') && m12.redacted.includes('home-.credentials.yaml') && m12.redacted.includes('home-settings.yaml'), 'manifest redacted list recorded');
check(m12.envVaultRefs['home-.env'] && m12.envVaultRefs['home-.credentials.yaml'] && m12.envVaultRefs['home-settings.yaml'], 'manifest envVaultRefs recorded');
// W49（#39）：补丁层 cordis.patch.yml 也进脱敏清单，故 vault 多一条（4 = .env +
// .credentials.yaml + settings.yaml + cordis.patch.yml），其 ref 与内容单独钉下面两条。
check((await readdir(vaultDir12)).length === 4, 'vault holds real values (4 files, incl. the patch layer since W49)');
check(!!m12.envVaultRefs['profile-cordis.patch.yml'], 'W49: manifest envVaultRefs records the patch-layer dest name');
check((await readFile(join(vaultDir12, m12.envVaultRefs['home-.env'] + '.env'), 'utf8')).includes('kfc-vw50'), 'vault file contains the real .env');
// 2) 本机完整回滚：改 .env → undo → 真实值还原
await writeFile(join(home12, '.env'), '# vision api\nAPI_KEY=changed-value\nexport TOKEN="other"\nEMPTY=\n');
await writeFile(join(home12, 'settings.yaml'), 'model: y\napiKey: sk-rotated-token12\n');
await run12('undo_snapshot', { reason: 's2' });
// diff 一致性（v0.3.2）：场景A 只改值 → 两侧脱敏后无差异，真实值完全不可见
const s1Dir12 = (await readdir(join(snap12, 'manual'))).find((d) => d !== '.booting');
out = await run12('undo_diff', { snapshot_id: s1Dir12 });
check(!out.includes('kfc-vw50') && !out.includes('changed-value') && !out.includes('sk-live-token12'), 'diff never leaks real values on either side (snapshot or current)');
// 场景B 改键名（结构差异）→ 有差异 + 脱敏标注 + 值仍不泄露
await writeFile(join(home12, '.env'), '# vision api\nAPI_KEY2=new-key-name\nexport TOKEN="other"\nEMPTY=\n');
out = await run12('undo_diff', { snapshot_id: s1Dir12 });
check(out.includes('redacted in diffs'), 'diff notes sensitive redaction when structure differs');
check(!out.includes('kfc-vw50'), 'diff still hides real values when structure differs');
// 恢复当前值（changed-value 状态）→ undo → 目标为 s1（原始），完整还原
await writeFile(join(home12, '.env'), '# vision api\nAPI_KEY=changed-value\nexport TOKEN="other"\nEMPTY=\n');
out = await run12('undo_restore', { mode: 'undo' });
check((await readFile(join(home12, '.env'), 'utf8')) === originalEnv12, 'local rollback restores real .env values (vault)');
check((await readFile(join(home12, 'settings.yaml'), 'utf8')).includes('sk-live-token12'), 'local rollback restores real settings.yaml values (vault)');
// 3) 换机模拟：删 vault → 恢复 → 占位 + 提示
await writeFile(join(home12, '.env'), '# vision api\nAPI_KEY=changed-again\nexport TOKEN="other"\nEMPTY=\n');
await run12('undo_snapshot', { reason: 's3' });
await rm(vaultDir12, { recursive: true, force: true });
out = await run12('undo_restore', { mode: 'undo' });
console.log('   ', out.split('\n').find((l) => l.includes('Note:')) ?? '(no note)');
check(out.includes('redacted placeholder'), 'report notes the placeholder restore');
const restoredEnv12 = await readFile(join(home12, '.env'), 'utf8');
check(restoredEnv12.includes('***REDACTED***') && !restoredEnv12.includes('changed-again'), 'cross-machine restore yields redacted placeholder');
// W37 守卫二（#41）：同一时刻的 yaml 敏感文件不能再降级写回占位符版（旧行为会把非法
// YAML 写进 settings.yaml）。本步的 vault 丢失由 W37 段落的场景 B/C 精确复现（这里
// undo 起手拍的 pre-restore 快照会按当前内容重建 vault，命中即真实值，不构成丢失）。
check((await readFile(join(home12, 'settings.yaml'), 'utf8')).includes('sk-live-token12'), 'W37 守卫二：yaml 敏感文件在本步仍拿到真实值（未被占位符版覆盖）');
await rm(root12, { recursive: true, force: true });

console.log('== W37. #41 triple guard: vault ingest + restore refusal + post-write verify ==');
{
  const core = await import('../lib/core.mjs');
  const root37 = await mkdtemp(join(tmpdir(), 'dsh-undo-test37-'));
  const home37 = join(root37, 'home'), profile37 = join(root37, 'profile'), snap37 = join(root37, 'snaps');
  await mkdir(home37, { recursive: true }); await mkdir(profile37, { recursive: true });
  await writeFile(join(profile37, 'cordis.patch.yml'), '# patch\n[]\n');
  const vault37 = join(snap37, 'auto', 'env-vault');
  const manual37 = join(snap37, 'manual');
  const tools37 = new Map();
  const ctx37 = {
    tools: { register: (t) => { tools37.set(t.name, t); return () => { }; } },
    systemPrompt: { section: () => () => { } }, get: () => undefined,
    effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
  };
  apply(ctx37, { manualDir: manual37, autoDir: join(snap37, 'auto'), homeDir: home37, profileDir: profile37, watch: false, pluginDirs: [] });
  await new Promise((r) => setTimeout(r, 300));
  const run37 = async (name, args) => (await tools37.get(name).execute(args, {}));
  const newest37 = async () => (await readdir(manual37)).filter((d) => d !== '.booting').sort().pop();
  const manifest37 = async (d) => JSON.parse(await readFile(join(manual37, d, 'manifest.json'), 'utf8'));
  // 目录名同秒时字典序不可靠（pre-restore 也会进 manual store），按 reason 精确定位。
  const dirByReason37 = async (reason) => {
    for (const d of (await readdir(manual37)).filter((x) => x !== '.booting')) {
      const m = await manifest37(d).catch(() => null);
      if (m && m.reason === reason) return d;
    }
    return null;
  };

  // 场景 A（守卫一·入库）：活 settings.yaml 已被先前脱敏文本污染 → 拒绝把污染文本
  // 入库为「真值」，快照仍记脱敏副本，manifest 记 redactedPreexisting。
  await writeFile(join(home37, 'settings.yaml'), 'model: "***REDACTED***"\napiKey: "***REDACTED***"\n');
  await writeFile(join(home37, '.env'), 'API_KEY=real-value-37\n');
  await run37('undo_snapshot', { reason: 'polluted-live' });
  const m37a = await manifest37(await newest37());
  const vault37a = await readdir(vault37).catch(() => []);
  check(!m37a.envVaultRefs['home-settings.yaml'] && Array.isArray(m37a.redactedPreexisting) && m37a.redactedPreexisting.includes('home-settings.yaml'), 'W37 守卫一：活文件含占位符时拒绝入 vault，manifest 记 redactedPreexisting');
  // W49（#39）：场景 A 夹具的 profile/cordis.patch.yml 也是 SensitiveDest，故 vault 为两条
// （未污染的 .env + .env 之外的补丁层），被污染的 settings.yaml 仍不入库。
check(vault37a.length === 2 && !!m37a.envVaultRefs['home-.env'] && !!m37a.envVaultRefs['profile-cordis.patch.yml'], 'W37 守卫一：只有未污染的文件入库（vault 为 .env 与补丁层两条）');

  // 场景 B（守卫二·降级）：vault 整体丢失 → yaml 拒写、活文件保持还原前内容；
  // .env 不拦，占位符降级行为不变。
  const liveYaml37 = 'model: live-model-37\napiKey: live-key-37\n';
  await writeFile(join(home37, 'settings.yaml'), liveYaml37);
  await writeFile(join(home37, '.env'), 'API_KEY=second-real-37\n');
  await run37('undo_snapshot', { reason: 'before-vault-loss' });
  const snapB37 = await newest37();
  await rm(vault37, { recursive: true, force: true });
  const preRestore37 = 'model: changed-after-37\n';
  await writeFile(join(home37, 'settings.yaml'), preRestore37);
  // .env 也要改内容：undo 起手会按当前内容重建 vault，若内容与快照同 sha 会命中真值，
  // 那样根本走不到降级分支（.env 的占位符降级是文档化行为，必须单独钉住）。
  await writeFile(join(home37, '.env'), 'API_KEY=changed-before-b-37\n');
  const outB37 = await run37('undo_restore', { mode: 'id', snapshot_id: snapB37 });
  const yamlB37 = await readFile(join(home37, 'settings.yaml'), 'utf8');
  check(yamlB37 === preRestore37 && !yamlB37.includes('REDACTED'), 'W37 守卫二：vault 缺失时 yaml 拒写，活文件保持还原前内容（未变占位符版）');
  check(outB37.includes('file skipped') && outB37.includes('Skipped'), 'W37 守卫二：跳过原因在工具输出里明示（file skipped）');
  check((await readFile(join(home37, '.env'), 'utf8')).includes('***REDACTED***'), 'W37 守卫二：.env 不拦，占位符降级行为不变');

  // 场景 C（守卫二·污染条目）：vault 条目本身是历史版本固化的占位符文本 → 同样拒写。
  // vault 条目按内容 sha 定位（不依赖 manifest 反查，避免受同秒目录名排序影响）。
  const cleanC37 = 'model: real-before-pollution-37\n';
  await writeFile(join(home37, 'settings.yaml'), cleanC37);
  await run37('undo_snapshot', { reason: 'then-pollute-vault' });
  const snapC37 = (await dirByReason37('then-pollute-vault')) ?? (await newest37());
  await writeFile(join(vault37, `${core.sha1Hex(Buffer.from(cleanC37))}.env`), 'model: "***REDACTED***"\n');
  const preC37 = 'model: live-before-c-37\n';
  await writeFile(join(home37, 'settings.yaml'), preC37);
  const outC37 = await run37('undo_restore', { mode: 'id', snapshot_id: snapC37 });
  check((await readFile(join(home37, 'settings.yaml'), 'utf8')) === preC37 && outC37.includes('file skipped'), 'W37 守卫二：vault 条目被污染时同样拒写并明示');
  await rm(root37, { recursive: true, force: true });
}

console.log('== W38. #41 doctor vault contamination check ==');
{
  const core = await import('../lib/core.mjs');
  const root38 = await mkdtemp(join(tmpdir(), 'dsh-undo-test38-'));
  const home38 = join(root38, 'home'), profile38 = join(root38, 'profile');
  const auto38 = join(root38, 'snaps', 'auto');
  await mkdir(home38, { recursive: true }); await mkdir(profile38, { recursive: true });
  const vault38 = join(auto38, 'env-vault');
  await mkdir(vault38, { recursive: true });
  const cfg38 = { manualDir: join(root38, 'snaps', 'manual'), autoDir: auto38, homeDir: home38, profileDir: profile38, sensitiveMode: 'redact' };
  const hits38 = (r) => r.checks.filter((c) => c.code === 'pre-vault-contamination');
  check(hits38(await core.runDoctor(cfg38)).length === 0, 'W38: 清洁 vault 不报污染（无 pre-vault-contamination 行）');
  const dirtyName = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.env';
  await writeFile(join(vault38, dirtyName), 'API_KEY=***REDACTED***\n');
  const dirty38 = hits38(await core.runDoctor(cfg38));
  check(dirty38.length === 1 && dirty38[0].level === 'warn' && JSON.stringify(dirty38[0]).includes(dirtyName), `W38: 污染 vault 条目报 warn 且点名条目（实得 ${JSON.stringify(dirty38)}）`);
  await rm(root38, { recursive: true, force: true });
}

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
const logs14 = [];
const ctx14 = {
  tools: { register: (t) => { tools14.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } }, get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: (...a) => logs14.push(a.join(' ')), warn: () => { } },
};
apply(ctx14, { manualDir: join(snap14, 'manual'), autoDir: join(snap14, 'auto'), homeDir: home14, profileDir: profile14, watch: false, pluginDirs: [], autoEnabled: false });
// 启动流程是异步 IIFE：baseline 快照只是它倒数第二步，最后一步 pruneAuto 会把还没
// 被任何快照引用的 blob 一并清掉（计数落在那次调用里，不进 undo_prune 的返回值）。
// 因此必须等整段跑完（末尾那条 baseline 日志）再往 profile 里写代码文件，否则
// 这个 blob 会被启动期抢先回收，断言永远看不到 orphan 计数（2026-09-15 定位）。
await waitUntil(async () => logs14.some((l) => l.includes('baseline snapshot')));
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
await waitUntil(async () => (await readFile(join(profile22c, 'cordis.patch.yml'), 'utf8')).includes('dsh-undo-savepoint'));
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
await waitUntil(async () => !(await readFile(join(home24, 'cordis.patch.yml'), 'utf8')).includes('dsh-undo-savepoint'));
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
await waitUntil(async () => !(await readFile(join(profile24b, 'cordis.patch.yml'), 'utf8')).includes('dsh-undo-savepoint'));
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

console.log('== B4b. patch manifest: multi-version substrings + client declaration (v0.4.5; v0.4.7 增 0.1.5 形态) ==');
{
  const { matchPatchesInText } = await import('../lib/core.mjs');
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../tools/dsh-patches.json', import.meta.url)), 'utf8'));
  const selfheal = manifest.patches.find((p) => p.id === 'appendBatch-selfheal');
  const tolerate = manifest.patches.find((p) => p.id === 'readFirstZstdLine-tolerant');
  const isolate = manifest.patches.find((p) => p.id === 'listArtifacts-isolate');
  // 清单健全性（v0.4.7 起三补丁均为双形态 variants）：子串非空且互异
  for (const p of manifest.patches) {
    check(p.variants?.length === 2, `B4b: ${p.id} carries 2 version variants`);
    check(p.variants.every((v) => typeof v.old === 'string' && typeof v.new === 'string' && v.old && v.new && v.old !== v.new), `B4b: ${p.id} variants non-empty and old != new`);
  }
  // 0.1.2 产物形态（selfheal alpha 变体 + isolate/tolerate 首变体）：missing=3 unmatched=0
  const a2Text = [selfheal.variants[0].old, isolate.variants[0].old, tolerate.variants[0].old].join('\n');
  const rA2 = matchPatchesInText(a2Text, manifest.patches, '0.1.2-rc.1');
  check(rA2.unmatched.length === 0 && rA2.missing.length === 3, 'B4b: 0.1.2-form product resolves (missing=3, unmatched=0)');
  // 0.1.5 产物形态：isolate/tolerate 命中新变体（tolerate 两变体锚点同形态），selfheal 无锚点。
  // 传版本 → selfheal 判 obsoleted（官方 appendBatch 重写已消解，属预期）；不传版本 → 保持 unmatched 保守语义
  const a5Text = [isolate.variants[1].old, tolerate.variants[0].old].join('\n');
  const rA5 = matchPatchesInText(a5Text, manifest.patches, '0.1.5-rc.2');
  check(rA5.missing.length === 2 && rA5.unmatched.length === 0 && rA5.obsoleted.length === 1 && rA5.obsoleted[0] === 'appendBatch-selfheal', 'B4b: 0.1.5-form product resolves (missing=2, selfheal obsoleted)');
  const rA5NoVer = matchPatchesInText(a5Text, manifest.patches);
  check(rA5NoVer.unmatched.length === 1 && rA5NoVer.obsoleted.length === 0, 'B4b: without a version an anchor-less patch stays unmatched (conservative)');
  const rA5AsOld = matchPatchesInText(a5Text, manifest.patches, '0.1.2-rc.1');
  check(rA5AsOld.obsoleted.length === 0 && rA5AsOld.unmatched.length === 1, 'B4b: obsoletedOn applies only to the declared version line');
  check(Array.isArray(selfheal.obsoletedOn) && selfheal.obsoletedOn.includes('0.1.5'), 'B4b: manifest declares appendBatch-selfheal obsoleted on 0.1.5');
  // 已应用形态（任一形态 new 命中即 applied；含 0.1.2 旧 tolerate 补丁的 parseHeaderMeta 形态兼容检测）
  const appliedText = [selfheal.variants[1].new, isolate.variants[0].new, tolerate.variants[1].new].join('\n');
  const rApplied = matchPatchesInText(appliedText, manifest.patches);
  check(rApplied.missing.length === 0 && rApplied.unmatched.length === 0, 'B4b: applied product reports ok (incl. 0.1.2 legacy tolerate form)');
  const mixedText = [selfheal.variants[0].new, isolate.variants[1].new, tolerate.variants[0].new].join('\n');
  const rMixed = matchPatchesInText(mixedText, manifest.patches);
  check(rMixed.missing.length === 0 && rMixed.unmatched.length === 0, 'B4b: any-variant applied counts as applied (cross-version upgrade)');
  // 全不命中 → unmatched（驱动启动告警）；带 0.1.5 版本时清单声明消解的补丁归入 obsoleted
  const rJunk = matchPatchesInText('const x = 1;', manifest.patches);
  check(rJunk.unmatched.length === manifest.patches.length, 'B4b: unrelated text reports all unmatched');
  const rJunk15 = matchPatchesInText('const x = 1;', manifest.patches, '0.1.5-rc.2');
  check(rJunk15.unmatched.length === 2 && rJunk15.obsoleted.length === 1, 'B4b: unrelated text on 0.1.5 reports the obsoleted selfheal');
  // 真实产物锚点验证（环境有产物树时执行）：0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.2 形态的精确子串级确认。
  // 0.1.5-rc.2 与 rc.1 的目标文件逐字节相同，判定应完全一致；三个路径均可用环境变量指向本地产物树。
  for (const [label, version, prodPath, expect] of [
    ['0.1.5-rc.1', '0.1.5-rc.1', process.env.DSH_PRODUCT_TREE_RC1 ?? '/tmp/dsh-fake15/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js', { missing: 2, obsoleted: 1 }],
    ['0.1.5-rc.2', '0.1.5-rc.2', process.env.DSH_PRODUCT_TREE_RC2 ?? '/tmp/dsh-fake15-rc2/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js', { missing: 2, obsoleted: 1 }],
    ['0.1.2-form', '0.1.2-rc.1', process.env.DSH_PRODUCT_TREE_012 ?? '/tmp/ps1-test/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js', { missing: 3, obsoleted: 0 }],
  ]) {
    try {
      const prodText = await readFile(prodPath, 'utf8');
      const r = matchPatchesInText(prodText, manifest.patches, version);
      check(r.missing.length === expect.missing && r.unmatched.length === 0 && r.obsoleted.length === expect.obsoleted, `B4b: real ${label} product anchors match (${expect.missing} missing / ${expect.obsoleted} obsoleted)`);
    } catch { /* 本机无该产物树时跳过（CI 产物树由 DSH_ROOT 场景另行覆盖） */ }
  }
  // 声明回归守卫：package.json 用全包名（模块图层）+ engines 覆盖 rc.1 与 0.1.5-rc.1 + client.js 用短服务名（cordis 服务层，与 apply 实际 ctx.locale/ctx.slots 对齐；两层语义不同，有意不一致）
  // 0.2.1 增 inject plugin-manager：插件页的 bundle 配置入口排在插件页之后激活，inject 只排序不加载。
  const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const fullNames = ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager'];
  check(JSON.stringify(pkg.dsh.client.inject) === JSON.stringify(fullNames), 'B4b: dsh.client.inject uses full package names');
  check(pkg.engines.dsh.includes('0.1.2-rc.1') && pkg.engines.dsh.includes('0.1.5-rc.1') && pkg.engines.dsh.includes('0.1.5-rc.2'), 'B4b: engines.dsh covers 0.1.2-rc.1, 0.1.5-rc.1 and 0.1.5-rc.2');
  // W42：engines 追加 0.2.0-rc.2 段（维持 OR 串风格，不重构）。
  const dshSegs = String(pkg.engines.dsh).split('||').map((s) => s.trim());
  const w42Base = ['>=0.0.1-0', '>=0.1.0-rc.2', '>=0.1.1-rc.1', '>=0.1.2-alpha.2', '>=0.1.2-rc.1', '>=0.1.5-rc.1', '>=0.1.5-rc.2'];
  check(
    typeof pkg.engines.dsh === 'string' && dshSegs[dshSegs.length - 1] === '>=0.2.0-rc.2' && JSON.stringify(dshSegs.slice(0, -1)) === JSON.stringify(w42Base),
    'W42: engines.dsh 末段为 >=0.2.0-rc.2 且原有七段逐字保留（OR 串未重构）',
  );
  check(pkg.version === '0.4.9', 'W42: package.json version 仍为 0.4.9（canary 批次不改版本号）');
  const readmes42 = [
    ['README.md', '桌面端'],
    ['README.en.md', 'Desktop'],
  ];
  for (const [rmFile, rmHeading] of readmes42) {
    const rm = await readFile(fileURLToPath(new URL('../' + rmFile, import.meta.url)), 'utf8');
    const ok42 = rm.includes('desktop profile') && rm.includes('0.2.0-rc.2') && rm.includes(rmHeading) && /safe/i.test(rm) && rm.includes('cordis.patch.yml.bak-');
    check(ok42, 'W42: ' + rmFile + ' 含 desktop profile、0.2.0-rc.2、桌面小节标题、safe-mode 警示与恢复弹窗痕迹');
  }
  const clientText = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
  check(clientText.includes('const inject = ["locale", "slots"];'), 'B4b: client.js inject uses short service names');
  // 本机绝对路径守卫：#47 与 PR #48 都踩过把作者本机目录写进解析锚点的坑，锚点只许走 DSH_ROOT / DSH_HOME。
  const indexText = await readFile(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
  check(
    !/\b[A-Za-z]:(?:[\\/])Users[\\/]/i.test(indexText) && !/\b[A-Za-z]:(?:[\\/])Users[\\/]/i.test(clientText),
    'B4b: lib 下不含本机用户目录绝对路径（解析锚点只认 DSH_ROOT 与 DSH_HOME）',
  );
}

console.log('== 38. B6: undo_scan — session health scan, fixable repair, corrupt isolation (v0.3.8) ==');
const root30 = await mkdtemp(join(tmpdir(), 'dsh-undo-test30-'));
const home30 = join(root30, 'home'), profile30 = join(root30, 'profile'), snap30 = join(root30, 'snaps');
await mkdir(home30, { recursive: true }); await mkdir(profile30, { recursive: true });
if (!hasZstd) {
  // Node < 22.15 无 zstd Zlib API：B6 用例跳过（不算失败），插件其余功能不受影响
  console.log('  skip - B6 zstd requires Node 22.15+; skipped on this Node (plugin degrades to undo_scan unsupported notice)');
  pass += 26;
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
// DSH 0.1.2 空会话（materializeHeader）：单帧仅含合法 header 行，0 事件 → 应判 ok（v0.4.5 修复）
const sessEmpty = join(home30, 'sessions', 'sess-empty');
await mkdir(sessEmpty, { recursive: true });
const emptyBytes = zlib.zstdCompressSync(Buffer.from(hdr30, 'utf8'));
await writeFile(join(sessEmpty, 'session.jsonl.zstd'), emptyBytes);
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
check(scan1.includes('7 session file(s)'), 'B6: scan reports 7 files');
check(scan1.includes('ok       ') && scan1.includes('sess-ok'), 'B6: compliant file marked ok');
check(scan1.includes('ok       ') && scan1.includes('sess-empty'), 'B6: header-only empty session (0.1.2 materializeHeader) marked ok, not fixable');
check(scan1.includes('fixable  ') && scan1.includes('sess-fix'), 'B6: single-frame file with events marked fixable');
check(scan1.includes('fixable  ') && scan1.includes('sess-overlap') && scan1.includes('synthetic-closer overlap'), 'B6: synthetic-closer overlap file marked fixable');
check(scan1.includes('fixable  ') && scan1.includes('sess-dual') && scan1.includes('synthetic-closer overlap'), 'B6: dual synthetic-closer overlap file marked fixable');
check(scan1.includes('ok       ') && scan1.includes('sess-noseq'), 'B6: no-seq valid JSON lines file marked ok (not bad JSON)');
check(scan1.includes('corrupt  ') && scan1.includes('sess-bad'), 'B6: bad-magic file marked corrupt');
check(scan1.includes('summary: 3 ok, 0 fixed, 3 fixable, 0 isolated, 1 corrupt'), 'B6: read-only summary correct');
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
check(Buffer.compare(await readFile(join(sessEmpty, 'session.jsonl.zstd')), emptyBytes) === 0, 'B6: header-only ok file untouched in quarantine mode');
check(Buffer.compare(await readFile(join(sessBad, 'session.jsonl.zstd')), badBytes) === 0, 'B6: corrupt file content untouched');
const qdir30 = join(snap30, 'corrupt-quarantine');
check((await readdir(qdir30)).some((f) => f.includes('sess-bad') && f.includes('corrupt')), 'B6: corrupt file isolated under undo root quarantine dir');
// 复扫：sess-fix / sess-overlap / sess-dual 应变为 ok，sess-noseq 保持 ok
const scan3 = await run30('undo_scan', {});
check(scan3.includes('ok       ') && scan3.includes('sess-fix'), 'B6: repaired single-frame now ok on rescan');
check(scan3.includes('ok       ') && scan3.includes('sess-empty'), 'B6: header-only file still ok on rescan');
check(scan3.includes('ok       ') && scan3.includes('sess-overlap'), 'B6: repaired overlap now ok on rescan');
check(scan3.includes('ok       ') && scan3.includes('sess-dual'), 'B6: repaired dual overlap now ok on rescan');
check(scan3.includes('ok       ') && scan3.includes('sess-noseq'), 'B6: no-seq file still ok on rescan');
check(scan3.includes('summary: 6 ok, 0 fixed, 0 fixable, 0 isolated, 1 corrupt'), 'B6: final summary correct');

console.log('== B7. undo_scan — session format v0/v2/v3 generation discovery + v3 事件表 (v0.4.7) ==');
{
  // v3 原生会话：header version=3 + 每行 {type, seq, time, data} 单事件，seq 从 0 起
  const hdrV3 = JSON.stringify({ type: 'session', version: 3, id: 'sess-v3', createdAt: 1757500000, isSeeded: false, delegationDepth: 0 }) + '\n';
  const v3Events = JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) + '\n'
    + JSON.stringify({ type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, content: [{ type: 'text', text: 'hi' }] } }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n';
  const sessV3 = join(home30, 'sessions', 'sess-v3');
  await mkdir(sessV3, { recursive: true });
  await writeFile(join(sessV3, 'session.v3.jsonl.zstd'), Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(hdrV3, 'utf8')),
    zlib.zstdCompressSync(Buffer.from(v3Events, 'utf8')),
  ]));
  // v3 迁移型（seeded）日志：恢复历史会话生成的新代文件，首行 session/end-seed 的
  // seq = inheritedEventCount（不从 0 起），其后连续。旧行为（expected=0）会误报
  // seq 断裂，v0.4.7 锚定起点后应判 ok。
  const hdrV3m = JSON.stringify({ type: 'session', version: 3, id: 'sess-v3-seeded', createdAt: 1757500001, isSeeded: true, delegationDepth: 0 }) + '\n';
  const v3Migrated = JSON.stringify({ type: 'session/end-seed', seq: 5, time: 10, data: { inherited: true } }) + '\n'
    + JSON.stringify({ type: 'turn/start', seq: 6, time: 11, data: { turn: 2 } }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 7, time: 12, data: { turn: 2, reason: { kind: 'completed' } } }) + '\n';
  const sessV3m = join(home30, 'sessions', 'sess-v3-seeded');
  await mkdir(sessV3m, { recursive: true });
  await writeFile(join(sessV3m, 'session.v3.jsonl.zstd'), Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(hdrV3m, 'utf8')),
    zlib.zstdCompressSync(Buffer.from(v3Migrated, 'utf8')),
  ]));
  // 同目录多代并存（官方迁移语义）：v0 旧文件 immutable 保留 + v3 新文件生效，
  // walkSessionFiles 按官方 resolveGenerationInDirectory 语义取最高代
  const sessMix = join(home30, 'sessions', 'sess-gen-mix');
  await mkdir(sessMix, { recursive: true });
  await writeFile(join(sessMix, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(hdr30 + evt30, 'utf8')));
  const mixHdr = JSON.stringify({ type: 'session', version: 3, id: 'sess-gen-mix', createdAt: 1757500002, isSeeded: false, delegationDepth: 0 }) + '\n';
  const mixEvents = JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n';
  await writeFile(join(sessMix, 'session.v3.jsonl.zstd'), Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(mixHdr, 'utf8')),
    zlib.zstdCompressSync(Buffer.from(mixEvents, 'utf8')),
  ]));
  // v2 会话（0.1.3/0.1.4 线产物）：version=2，物理行结构与 v3 相同
  const hdrV2 = JSON.stringify({ type: 'session', version: 2, id: 'sess-v2', createdAt: 1757500003, isSeeded: false, delegationDepth: 0 }) + '\n';
  const v2Events = JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) + '\n';
  const sessV2 = join(home30, 'sessions', 'sess-v2');
  await mkdir(sessV2, { recursive: true });
  await writeFile(join(sessV2, 'session.v2.jsonl.zstd'), Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(hdrV2, 'utf8')),
    zlib.zstdCompressSync(Buffer.from(v2Events, 'utf8')),
  ]));
  // 非代数命名不收录（行为保持：.bak 与非 canonical 名不进扫描）
  const sessJunk = join(home30, 'sessions', 'sess-junkname');
  await mkdir(sessJunk, { recursive: true });
  await writeFile(join(sessJunk, 'session.jsonl.zstd.bak'), zlib.zstdCompressSync(Buffer.from(hdrV3, 'utf8')));

  const scan4 = await run30('undo_scan', {});
  check(scan4.includes('11 session file(s)'), 'B7: generation naming discovered (11 files incl. v0/v2/v3, sess-bad remains corrupt in place)');
  check(scan4.includes('ok       ') && scan4.includes('sess-v3'), 'B7: native v3 session (per-row seq events) marked ok');
  check(scan4.includes('ok       ') && scan4.includes('sess-v3-seeded'), 'B7: seeded/migrated v3 log (end-seed seq=5, anchored start) marked ok, not seq-broken');
  check(scan4.includes('ok       ') && scan4.includes('sess-gen-mix'), 'B7: mixed-generation dir resolves to highest generation (v3 wins over v0)');
  check(!scan4.includes('sess-junkname'), 'B7: non-canonical names (e.g. .bak) not scanned');
  check(scan4.includes('ok       ') && scan4.includes('sess-v2'), 'B7: v2 session file discovered and ok');
  check(scan4.includes('summary: 10 ok, 0 fixed, 0 fixable, 0 isolated, 1 corrupt'), 'B7: v0/v2/v3 all healthy in final summary');
  // v3 事件计数：sess-v3 = 3 事件 2 帧（turn/start + assistant/message + turn/end）
  check(/sess-v3[\\\/]session\.v3\.jsonl\.zstd \(3 events, 2 frames\)/.test(scan4), 'B7: v3 per-row event counting correct (3 events, 2 frames)');
  check(/sess-v3-seeded[\\\/]session\.v3\.jsonl\.zstd \(3 events, 2 frames\)/.test(scan4), 'B7: migrated v3 event counting correct (end-seed + 2 events)');
}
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

// ── 0.5.0 修复：pre-execute 钩子吞掉瀑布返回值（write/edit 反斜杠路径必崩）──
// 背景：tools/pre-execute 是瀑布事件，返回的是最外层监听器的返回值；钩子只
// await next() 不返回时，工具层读 gate.kind 报 Cannot read properties of
// undefined (reading 'kind')（已核对 cordis waterfall 与 dsh-tools prepareExecution）。
{
  const core = await import('../lib/core.mjs');
  const proot = await mkdtemp(join(tmpdir(), 'dsh-undo-hook-'));
  const mkcfg = (autoDir) => ({ autoDir, manualDir: join(proot, 'manual'), workspaceDirs: [proot], fileToolWhitelist: ['write', 'edit'], keepMessageOps: 200, profileName: 'hook' });
  const target = join(proot, 'hooked.txt');
  await writeFile(target, 'before-1');
  const allow = { kind: 'allow' };
  const deny = { kind: 'deny' };
  const runCase = async (p, cfg, verdict, tool = 'write') => {
    const warns = [];
    let calls = 0;
    let fellThrough = 0;
    // 模拟 cordis 的 next()：第一次调用交出下游结论，之后再调只会落到最内层默认 allow
    const next = async () => { calls++; if (calls === 1) return verdict; fellThrough++; return { kind: 'allow' }; };
    const listener = core.makePreExecuteListener({ cfg, logger: { warn: (m) => warns.push(String(m)) } });
    const got = await listener({ name: tool, arguments: { path: p }, agent: { messageId: 'h1' } }, next);
    const ops = await core.listMessageOps(cfg).catch(() => []);
    return { got, calls, fellThrough, files: ops.reduce((n, b) => n + b.files, 0), warns };
  };

  // 一、反斜杠绝对路径（Windows 上工作区内最常见的写法）：结论必须原样传下去
  const c1 = await runCase(target, mkcfg(join(proot, 'auto1')), deny);
  check(c1.got === deny, 'hook: 反斜杠绝对路径把 next() 的返回值原样传下去（不再返回 undefined）');
  check(c1.calls === 1, 'hook: next() 只被调用一次（二次调用会把下游结论覆盖成默认 allow）');
  check(c1.files === 1, 'hook: 反斜杠绝对路径的工作区写入被记入消息级台账');

  // 二、大文件分支：放行且不记账，返回值同样不能吞
  const big = join(proot, 'big.bin');
  await writeFile(big, Buffer.alloc(300 * 1024, 65));
  const c2 = await runCase(big, mkcfg(join(proot, 'auto2')), allow);
  check(c2.got === allow && c2.calls === 1 && c2.files === 0, 'hook: >256KB 文件放行且不记账，返回值原样');

  // 三、后置记账失败：必须仍然返回下游结论。把 <autoDir>/message-ops 占成文件，
  // 使前置采集正常、appendMessageOp 的 mkdir 报错（ENOTDIR/EEXIST）。
  const cfg3 = mkcfg(join(proot, 'auto3'));
  await mkdir(cfg3.autoDir, { recursive: true });
  await writeFile(join(cfg3.autoDir, 'message-ops'), 'x');
  const c3 = await runCase(target, cfg3, deny);
  check(c3.got === deny, 'hook: 后置记账失败也不改判（deny 仍是 deny，不被默认 allow 覆盖）');
  check(c3.calls === 1 && c3.warns.length === 1 && /message-ops/.test(c3.warns[0]), 'hook: 后置记账失败只告警一次（告警指向 message-ops），next() 仍只调用一次');

  // 四、追踪范围外与白名单外：直接放行，结论原样
  const c4 = await runCase(join(tmpdir(), 'outside-hooked.txt'), mkcfg(join(proot, 'auto4')), deny);
  check(c4.got === deny && c4.files === 0, 'hook: 追踪范围外的写入直接放行且不记账');
  const c5 = await runCase(target, mkcfg(join(proot, 'auto5')), allow, 'read');
  check(c5.got === allow && c5.files === 0, 'hook: 白名单外工具不拦截、结论原样');

  // 六、路径归一化（0.5.0 次缺陷）：正斜杠与相对路径同样要记账；快照目录及
  // 其边界的排除仍生效（不能因为归一化把 store 内写入或同前缀兄弟目录弄反）。
  const fw = target.replace(/\\/g, '/');
  const cF = await runCase(fw, mkcfg(join(proot, 'auto6')), deny);
  check(cF.got === deny && cF.calls === 1 && cF.files === 1, 'hook: 正斜杠绝对路径同样记账（归一化后不再漏记）');
  // 注意：跨盘符（仓库在 D:、临时目录在 C:）时 path.relative 会返回绝对路径，
  // 等于没测到相对形态；相对路径用例必须落在当前工作盘符内，用一个不存在的
  // 相对路径即可（钩子只读文件，不存在就记 beforeExists=false）。
  const cfgR = { ...mkcfg(join(proot, 'auto7')), workspaceDirs: [process.cwd()] };
  const cR = await runCase(join('tools', '__hook-rel-probe.txt'), cfgR, deny);
  check(cR.got === deny && cR.calls === 1 && cR.files === 1, 'hook: 相对路径（按 cwd 解析）同样记账');
  const cfg8 = mkcfg(join(proot, 'auto8'));
  const cS = await runCase(join(cfg8.manualDir, 'inside-store.txt'), cfg8, deny);
  check(cS.got === deny && cS.files === 0, 'hook: 快照目录内的写入仍被排除（归一化未造成过度追踪）');
  const cB = await runCase(join(proot, 'manual-extra', 'sibling.txt'), mkcfg(join(proot, 'auto9')), deny);
  check(cB.got === deny && cB.files === 1, 'hook: 同前缀兄弟目录不再被误排除（目录边界按分隔符切）');

  // 五、接线断言：index.js 必须用工厂注册，防止退回内联实现
  const idxSrc = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  check(idxSrc.includes("ctx.on('tools/pre-execute', makePreExecuteListener({"), 'hook: index.js 通过 makePreExecuteListener 注册（防退回内联实现）');
  await rm(proot, { recursive: true, force: true });
}

// ── W39 步骤三 P6b：瀑布契约模拟与注册层钩子直连（#42）──────────────────────
// #42 暴露的第三盲区是「注册层钩子零覆盖」：既有 P6 用例只直连工厂函数，从未验证
// 瀑布链上的返回值传递、链错误传播与 msgId 序列化。本段用忠实模拟 cordis 派发语义
// 的夹具补齐这十条。
{
  const core = await import('../lib/core.mjs');
  const wroot = await mkdtemp(join(tmpdir(), 'dsh-undo-wf-'));
  const allow = { kind: 'allow' };
  const deny = { kind: 'deny' };
  const target = join(wroot, 'wf.txt');
  await writeFile(target, 'wf-before');
  const mkcfg = (name) => ({ autoDir: join(wroot, name), manualDir: join(wroot, 'manual'), workspaceDirs: [wroot], fileToolWhitelist: ['write', 'edit'], keepMessageOps: 200, profileName: 'hookwf' });
  // 模拟 cordis EventWaterfall.waterfall 契约（逐字转录自 @deepseek-ai/cordis
  // 4.0.2/4.0.4，两版逐字节一致；dispatch 的 shift 语义保留：shift 掉 carrier 与
  // 事件名后监听器收到 (exec, next)，链尾是 fallback）。
  const makeWaterfallHarness = () => {
    const listeners = {};
    return {
      on(name, cb) { (listeners[name] ??= []).push(cb); },
      waterfall(...args) {
        const thisArg = (typeof args[0] === 'object' || typeof args[0] === 'function') ? args.shift() : null;
        const name = args.shift();
        const cbs = (listeners[name] ?? []).slice();
        const inner = args.pop();
        const next = () => { return (cbs.shift() ?? inner)(...args); };
        args.push(next);
        return next();
      },
    };
  };
  const mkExec = (agent, tool = 'write', p = target) => ({ callId: 'w39', name: tool, arguments: { path: p }, agent, signal: null });
  const runWf = async (cfg, exec, tail = allow, extra = []) => {
    const hw = makeWaterfallHarness();
    const warns = [];
    let tailCalls = 0;
    hw.on('tools/pre-execute', core.makePreExecuteListener({ cfg, logger: { warn: (m) => warns.push(String(m)) } }));
    for (const cb of extra) hw.on('tools/pre-execute', cb);
    let got = null;
    let err = null;
    try { got = await hw.waterfall('tools/pre-execute', exec, () => { tailCalls++; return tail; }); }
    catch (e) { err = e; }
    const ops = await core.listMessageOps(cfg).catch(() => []);
    return { got, err, warns, tailCalls, ops, files: ops.reduce((n, b) => n + b.files, 0) };
  };

  // 一、透传主断言：白名单工具加 scope 内文件，钩子返回值必须就是链尾结论
  const w1 = await runWf(mkcfg('wf1'), mkExec({ id: 'sess-1' }));
  check(w1.got === allow && w1.got?.kind === 'allow', 'P6b: 钩子把链尾结论原样传回（gate.kind 可读，不再 undefined）');

  // 二、msgId 序列化：agent 带循环引用，落盘的 messageId 必须是 agent.id 字符串
  const cyc = { id: 'sess-1' };
  cyc.self = cyc;
  const w2 = await runWf(mkcfg('wf2'), mkExec(cyc), deny);
  check(w2.files === 1 && w2.ops[0].messageId === 'sess-1', 'P6b: 循环引用 agent 也能落盘，messageId 取 agent.id 字符串');

  // 三、msgId 兜底：agent 缺失或空对象时退 null，落盘不报错
  const w3a = await runWf(mkcfg('wf3a'), mkExec(undefined));
  const w3b = await runWf(mkcfg('wf3b'), mkExec({}));
  check(w3a.files === 1 && w3a.ops[0].messageId === null && w3b.files === 1 && w3b.ops[0].messageId === null, 'P6b: agent 无 id 时 messageId 退 null 且照常落盘');

  // 四、记账旁路：message-ops 目录被文件占住，链尾结论仍要原样返回
  const cfg4 = mkcfg('wf4');
  await mkdir(cfg4.autoDir, { recursive: true });
  await writeFile(join(cfg4.autoDir, 'message-ops'), 'x');
  const w4 = await runWf(cfg4, mkExec({ id: 'sess-1' }), deny);
  check(w4.got === deny && w4.ops.length === 0, 'P6b: 记账失败不改判链尾结论，工具执行不被阻断');

  // 五、大于 256KB 分支：放行、返回值原样、不记账、blob 仓不落盘
  const cfg5 = mkcfg('wf5');
  const bigPath = join(wroot, 'wf-big.bin');
  await writeFile(bigPath, Buffer.alloc(300 * 1024, 66));
  const w5 = await runWf(cfg5, mkExec({ id: 'sess-1' }, 'write', bigPath), allow);
  const blobs5 = await readdir(join(cfg5.autoDir, 'blobs')).catch(() => []);
  check(w5.got === allow && w5.tailCalls === 1 && w5.files === 0 && blobs5.length === 0, 'P6b: 大于 256KB 放行且不记账，blob 仓为空');

  // 六、链下游故障原样传播：钩子不得吞掉下游监听器的异常
  const boom = () => { throw new Error('w39 downstream boom'); };
  const w6 = await runWf(mkcfg('wf6'), mkExec({ id: 'sess-1' }), allow, [boom]);
  check(w6.err instanceof Error && /downstream boom/.test(String(w6.err.message)), 'P6b: 链下游抛错原样传播，不被钩子吞掉');

  // 七、链下游故障不重试：链尾计数为零，证明没有二次执行
  check(w6.tailCalls === 0 && w6.files === 0, 'P6b: 链下游抛错时不重跑链（链尾计数为零）');

  // 八、提前分支（白名单外工具）遇下游故障同样传播且不重跑
  const w8 = await runWf(mkcfg('wf8'), mkExec({ id: 'sess-1' }, 'read'), allow, [boom]);
  check(w8.err instanceof Error && w8.tailCalls === 0, 'P6b: 白名单外工具遇下游故障同样传播且不重跑链');

  // 九、链前我方逻辑炸：降级放行，链恰好跑一次（blobs 被文件占住，writeBlob 必失败）
  const cfg9 = mkcfg('wf9');
  await mkdir(cfg9.autoDir, { recursive: true });
  await writeFile(join(cfg9.autoDir, 'blobs'), 'x');
  const w9 = await runWf(cfg9, mkExec({ id: 'sess-1' }), deny);
  check(w9.got === deny && w9.tailCalls === 1, 'P6b: 链前我方逻辑炸时降级放行，链恰好跑一次');

  // 十、60 秒窗口分组回归：同一钩子实例连续两次调用复用同一批次（真实 DSH 里监听器
  // 只在注册时构造一次，批次状态挂在闭包里，所以这里必须复用同一个钩子实例）。
  const cfg10 = mkcfg('wf10');
  const hw10 = makeWaterfallHarness();
  hw10.on('tools/pre-execute', core.makePreExecuteListener({ cfg: cfg10, logger: { warn: () => { /* noop */ } } }));
  const runSame = () => hw10.waterfall('tools/pre-execute', mkExec({ id: 'sess-1' }), () => allow);
  await runSame();
  await runSame();
  const ops10 = await core.listMessageOps(cfg10).catch(() => []);
  const files10 = ops10.reduce((n, b) => n + b.files, 0);
  check(ops10.length === 1 && files10 === 2, 'P6b: 同一 agent.id 在 60 秒窗口内复用同一消息批次');

  await rm(wroot, { recursive: true, force: true });
}

// ── W35：bundleCheck 认数组形式 dsh.bundle.patch（issue #40）──────────────────
// DSH 0.1.7-rc.1 起 dsh.bundle.patch 从字符串扩展为字符串或文件路径数组，
// @deepseek-ai/dsh-web-app 是数组形式第一个官方使用者：只认字符串会把合法 bundle
// 判成 no dsh.bundle.patch，触发 doctor 误报与安全模式误删。
{
  const core = await import('../lib/core.mjs');
  const broot = await mkdtemp(join(tmpdir(), 'dsh-undo-bundle-'));
  await writeFile(join(broot, 'package.json'), '{}');
  const mkBundle = async (name, patchJson, files) => {
    const dir = join(broot, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: patchJson } } }));
    for (const f of files) await writeFile(join(dir, f), 'x: 1\n');
    return dir;
  };
  const bcfg = { autoDir: join(broot, 'auto'), settingsFile: join(broot, 'settings.json'), profileName: 'test' };

  const arrDir = await mkBundle('arr-bundle', ['p1.yml', 'p2.yml'], ['p1.yml', 'p2.yml']);
  const b1 = await core.bundleCheck(bcfg, 'arr-bundle', broot);
  check(b1.ok === true && b1.dir === arrDir, 'W35: 数组形式 patch 且文件齐全时 ok，dir 指向包目录');

  await rm(join(arrDir, 'p2.yml'));
  const b2 = await core.bundleCheck(bcfg, 'arr-bundle', broot);
  check(b2.ok === false && String(b2.reason).includes(join(arrDir, 'p2.yml')), 'W35: 数组内某个文件缺失时按缺失绝对路径报错');

  await mkBundle('empty-bundle', [], []);
  const b3 = await core.bundleCheck(bcfg, 'empty-bundle', broot);
  check(b3.ok === false && /no dsh\.bundle\.patch/.test(String(b3.reason)), 'W35: 空数组视为未声明（no dsh.bundle.patch）');

  await mkBundle('bad-bundle', ['p1.yml', 5], ['p1.yml']);
  const b4 = await core.bundleCheck(bcfg, 'bad-bundle', broot);
  check(b4.ok === false && /非字符串项/.test(String(b4.reason)), 'W35: 数组含非字符串项时明确报错');

  await mkBundle('str-bundle', 'p1.yml', ['p1.yml']);
  const b5 = await core.bundleCheck(bcfg, 'str-bundle', broot);
  check(b5.ok === true, 'W35: 字符串形式 patch 行为不变（0.4.9 既有形态回归）');

  await rm(broot, { recursive: true, force: true });
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

// ── #34 撤回守卫：afterHash 指纹判断 + 撤回前 blob 兜底备份 ────────────────────
// 工厂函数直连（同 P6 模式）：appendMessageOp 写批次，undoMessage 撤回，断言
// 被后续消息改写的文件跳过、未改写的正常恢复、旧批次行为不变。
{
  const core = await import('../lib/core.mjs');
  const groot = await mkdtemp(join(tmpdir(), 'dsh-undo-guard-'));
  const gcfg = { autoDir: join(groot, 'auto'), settingsFile: join(groot, 'settings.json'), keepMessageOps: 200, profileName: 't' };
  await mkdir(join(gcfg.autoDir, 'message-ops'), { recursive: true });
  const blobs = core.blobDir(gcfg);
  const put = (p, text) => writeFile(p, text, 'utf8');
  // 记录一个带守卫字段的 op（模拟 pre-execute 钩子写入的批次）
  const recOp = async (bid, path, { before, after }) => {
    let beforeHash = null, beforeExists = false;
    if (before !== undefined) { await put(path, before); beforeHash = core.sha1Hex(Buffer.from(before, 'utf8')); beforeExists = true; await core.writeBlob(gcfg, beforeHash, Buffer.from(before, 'utf8')); }
    let afterHash = null, afterExists = false;
    if (after !== undefined) { await put(path, after); afterHash = core.sha1Hex(Buffer.from(after, 'utf8')); afterExists = true; }
    await core.appendMessageOp(gcfg, { batchId: bid, messageId: `msg-${bid}`, op: { tool: 'write_file', path, beforeHash, beforeExists, afterHash, afterExists, ts: Date.now() } });
  };
  // 1) 创建分支：批次 A 创建 foo，消息 B 重写，撤回 A 时 foo 保留 B 的内容
  await recOp('b1', join(groot, 'foo.md'), { after: 'content-A' });
  const foo = join(groot, 'foo.md');
  await put(foo, 'content-B'); // 后续消息重写
  const r1 = await core.undoMessage(gcfg, 'b1');
  check((await readFile(foo, 'utf8')) === 'content-B', '#34: created file rewritten later is kept (foo.md preserves B)');
  check(r1.skipped.length === 1 && r1.skipped[0].path === foo && /modified after batch/.test(r1.skipped[0].reason) && /foo\.md/.test(r1.notes ?? ''), '#34: skip entry carries path + reason, notes mention it');
  check(await core.pathExists(join(blobs, core.sha1Hex(Buffer.from('content-B', 'utf8')))), '#34: current content backed up to blob store before undo');
  // 2) 覆盖分支：批次改写已有文件，后续再改 → 跳过
  const bar = join(groot, 'bar.md');
  await recOp('b2', bar, { before: 'bar-orig', after: 'bar-after-A' });
  await put(bar, 'bar-after-B');
  const r2 = await core.undoMessage(gcfg, 'b2');
  check((await readFile(bar, 'utf8')) === 'bar-after-B' && r2.skipped.length === 1, '#34: modified file skipped on overwrite branch too');
  // 3) 未被后续改动的文件正常恢复（守卫不误伤）
  const baz = join(groot, 'baz.md');
  await recOp('b3', baz, { before: 'baz-orig', after: 'baz-after' });
  const r3 = await core.undoMessage(gcfg, 'b3');
  check((await readFile(baz, 'utf8')) === 'baz-orig' && r3.changed.length === 1 && r3.skipped.length === 0, '#34: untouched file restores normally');
  // 4) 新建且未被再改的文件正常删除
  const qux = join(groot, 'qux.md');
  await recOp('b4', qux, { after: 'qux-after' });
  const r4 = await core.undoMessage(gcfg, 'b4');
  check(!(await core.pathExists(qux)) && r4.deleted.length === 1, '#34: created file untouched since is deleted normally');
  // 5) 旧批次（无 afterHash/afterExists 字段）行为不变：即使后来被改写也照旧删除
  const oldf = join(groot, 'old.md');
  await core.appendMessageOp(gcfg, { batchId: 'b5', messageId: 'msg-b5', op: { tool: 'write_file', path: oldf, beforeHash: null, beforeExists: false, ts: Date.now() } });
  await put(oldf, 'rewritten-later');
  const r5 = await core.undoMessage(gcfg, 'b5');
  check(!(await core.pathExists(oldf)) && r5.deleted.length === 1, '#34: legacy batch without guard fields keeps old behavior');
  // 6) 同批次多次写同一路径：只对最后一次写入做守卫，恢复到最初内容
  const multi = join(groot, 'multi.md');
  await core.writeBlob(gcfg, core.sha1Hex(Buffer.from('m-orig', 'utf8')), Buffer.from('m-orig', 'utf8'));
  await core.appendMessageOp(gcfg, { batchId: 'b6', messageId: 'msg-b6', op: { tool: 'write_file', path: multi, beforeHash: core.sha1Hex(Buffer.from('m-orig', 'utf8')), beforeExists: true, afterHash: core.sha1Hex(Buffer.from('m-w1', 'utf8')), afterExists: true, ts: 1 } });
  await core.appendMessageOp(gcfg, { batchId: 'b6', messageId: 'msg-b6', op: { tool: 'write_file', path: multi, beforeHash: core.sha1Hex(Buffer.from('m-w1', 'utf8')), beforeExists: true, afterHash: core.sha1Hex(Buffer.from('m-w2', 'utf8')), afterExists: true, ts: 2 } });
  await put(multi, 'm-w2');
  const r6 = await core.undoMessage(gcfg, 'b6');
  check((await readFile(multi, 'utf8')) === 'm-orig' && r6.skipped.length === 0, '#34: multi-write batch restores to original (guard only on last write)');
  // 7) 批次删除了文件、之后被重建 → 存在性翻转，跳过
  const gone = join(groot, 'gone.md');
  await core.writeBlob(gcfg, core.sha1Hex(Buffer.from('g-orig', 'utf8')), Buffer.from('g-orig', 'utf8'));
  await put(gone, 'g-orig');
  await core.appendMessageOp(gcfg, { batchId: 'b7', messageId: 'msg-b7', op: { tool: 'delete_file', path: gone, beforeHash: core.sha1Hex(Buffer.from('g-orig', 'utf8')), beforeExists: true, afterHash: null, afterExists: false, ts: 1 } });
  await rm(gone, { force: true }); // 工具删除
  await put(gone, 'g-recreated'); // 后续消息重建
  const r7 = await core.undoMessage(gcfg, 'b7');
  check((await readFile(gone, 'utf8')) === 'g-recreated' && r7.skipped.length === 1, '#34: file recreated after batch deletion is kept (existence flip)');
  check(await core.pathExists(join(blobs, core.sha1Hex(Buffer.from('g-recreated', 'utf8')))), '#34: recreated content backed up before attempted restore');
  await rm(groot, { recursive: true, force: true });
}

// ── #35 脱敏形态补全：YAML 列表项 / 块标量 / 流式续行，env 跨行值 / 裸续行 ──────
// 纯函数直连：redactYamlContent / redactEnvContent 对各形态替换为占位符，
// 注释与空行保留，且对已脱敏文本幂等。
{
  const core = await import('../lib/core.mjs');
  const yamlIn = [
    '# credentials',
    'apiKey: sk-abc',
    'secrets:',
    '  - sk-list-secret',
    '  - another-secret',
    'providers:',
    '  - name: p1',
    '    key: nested-key-secret',
    'multiline: |',
    '  line1-secret',
    '  line2-secret',
    'flow: [a-secret,',
    '  b-secret]',
    '',
    'quoted: "sk-inline"',
  ].join('\n');
  const envIn = [
    'API_KEY=sk-abc',
    'export TOKEN="tok-secret"',
    '# comment',
    '',
    'OPEN_QUOTE="unterminated-secret',
    'continuation-secret"',
    'BARE=first-part',
    'bare-continuation-secret',
  ].join('\n');
  const y = core.redactYamlContent(yamlIn);
  const e = core.redactEnvContent(envIn);
  check(!/sk-list-secret|another-secret/.test(y) && y.includes('- "***REDACTED***"'), '#35: yaml list items replaced with placeholder');
  check(!/nested-key-secret/.test(y) && /key: "\*\*\*REDACTED\*\*\*"/.test(y), '#35: nested key-value inside list replaced');
  check(!/line1-secret|line2-secret/.test(y), '#35: block scalar content lines replaced');
  check(!/b-secret|a-secret/.test(y), '#35: flow-style continuation lines replaced');
  check(!/unterminated-secret|continuation-secret/.test(e), '#35: env unterminated-quote multi-line value replaced');
  check(!/bare-continuation-secret/.test(e) && e.includes('***REDACTED***'), '#35: env bare continuation line replaced with placeholder');
  check(y.includes('# credentials') && y.split('\n').includes('') && e.includes('# comment') && e.split('\n').includes(''), '#35: comments and blank lines preserved');
  check(core.redactYamlContent(y) === y && core.redactEnvContent(e) === e, '#35: redaction is idempotent');
  check(y.includes('apiKey: "***REDACTED***"') && y.includes('quoted: "***REDACTED***"') && e.includes('API_KEY=***REDACTED***') && e.includes('export TOKEN="***REDACTED***"'), '#35: plain key-value forms still redacted (regression)');
}

// ── W36：脱敏器构造折叠金样（#41 缺陷 1）────────────────────────────────────
// 逐字节金样：四个夹具的期望输出由规划侧用 PyYAML safe_load 验证过合法性（旧版
// 裸占位符 `***REDACTED***` 本身就是非法别名语法）并验证过二过不变，此处按字面量
// 落成 strict equal 断言，第五条验四夹具整体幂等。
{
  const core = await import('../lib/core.mjs');
  const R = '***REDACTED***';
  const gc = [
    {
      name: 'block',
      input: 'core:\n  theme: dark\n  order: |\n    first\n    second\n  apiKey: sk-abc\n',
      expect: `core:\n  theme: "${R}"\n  order: "${R}"\n  apiKey: "${R}"\n`,
    },
    {
      name: 'flow',
      input: 'providers: [openai,\n  deepseek]\n',
      expect: `providers: "${R}"\n`,
    },
    {
      name: 'nested',
      input: 'mcpServers:\n  - name: alpha\n    url: https://x\n  - beta\n',
      expect: `mcpServers:\n  - name: "${R}"\n    url: "${R}"\n  - "${R}"\n`,
    },
    {
      name: 'mixed',
      input: '# top\nsettings:\n  model: x\n\n  keys:\n    - k1\n    - k2\n...',
      expect: `# top\nsettings:\n  model: "${R}"\n\n  keys:\n    - "${R}"\n    - "${R}"\n...`,
    },
  ];
  for (const c of gc) {
    check(core.redactYamlContent(c.input) === c.expect, `W36: 金样 ${c.name} 逐字节相符（构造折叠输出合法 YAML）`);
  }
  check(gc.every((c) => core.redactYamlContent(core.redactYamlContent(c.input)) === c.expect), 'W36: 四个金样再脱敏一遍不变（幂等）');
}

// ── T1. #37 局外 WebUI 深色模式 + 主题 token 审计（v0.4.8）────────────────────
console.log('== T1. #37 offline WebUI dark mode + theme token audit (v0.4.8) ==');
{
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const html = await readFile(join(repoRoot, 'tools', 'webui', 'index.html'), 'utf8');
  const css = await readFile(join(repoRoot, 'tools', 'webui', 'styles.css'), 'utf8');
  const appJs = await readFile(join(repoRoot, 'tools', 'webui', 'app.js'), 'utf8');

  // 内联解析器必须排在样式表之前，否则首帧按亮色画完再翻黑，会闪一下白。
  const atResolver = html.indexOf('dsh-undo-theme');
  const atStyles = html.indexOf('styles.css');
  check(atResolver > -1 && atStyles > -1 && atResolver < atStyles, '#37: theme resolver precedes the stylesheet (no flash of light)');
  check(html.includes('prefers-color-scheme: dark') && html.includes('matchMedia'), '#37: resolver honours prefers-color-scheme');
  check(html.includes('id="btn-theme"'), '#37: three-state theme button in the topbar');
  check(!/data-theme="auto"/.test(html), '#37: data-theme never carries the auto preference');
  check(appJs.includes("'dsh-undo-theme'"), '#37: app.js reads the same localStorage key');
  check(appJs.includes("const THEME_STATES = ['auto', 'light', 'dark']"), '#37: three-state cycle auto -> light -> dark');
  check(appJs.includes("matchMedia('(prefers-color-scheme: dark)')"), '#37: app.js resolves auto against the system');
  check(appJs.includes("addEventListener('change'"), '#37: system theme change re-resolves auto');
  check(appJs.includes("setAttribute('data-theme', resolved)"), '#37: resolved theme written to data-theme');

  // 真跑一遍头部解析器：抽出内联脚本体，用最小 DOM 桩验证三态解析行为，
  // 而不是只匹配字符串。局外 WebUI 的正确性最终就落在这一段上。
  const resolverSrc = (html.match(/<script>([\s\S]*?)<\/script>/) ?? [])[1] ?? '';
  check(resolverSrc.includes('dsh-undo-theme'), '#37: inline resolver script body extracted');
  const runResolver = (stored, systemDark) => {
    let theme = null, prefAttr = null;
    const doc = { documentElement: { setAttribute: (k, v) => { if (k === 'data-theme') theme = v; if (k === 'data-theme-pref') prefAttr = v; } } };
    const win = { matchMedia: () => ({ matches: systemDark }) };
    const store = { getItem: () => stored };
    new Function('window', 'document', 'localStorage', resolverSrc)(win, doc, store);
    return { theme, prefAttr };
  };
  check(runResolver(null, true).theme === 'dark', '#37: unset preference + dark system -> data-theme=dark');
  check(runResolver(null, false).theme === 'light', '#37: unset preference + light system -> data-theme=light');
  check(runResolver('auto', true).theme === 'dark', '#37: auto + dark system -> data-theme=dark');
  check(runResolver('light', true).theme === 'light', '#37: explicit light wins over a dark system');
  check(runResolver('dark', false).theme === 'dark', '#37: explicit dark wins over a light system');
  const bogus = runResolver('bogus', true);
  check(bogus.prefAttr === 'auto' && bogus.theme === 'dark', '#37: unknown stored value falls back to auto');

  // 亮暗两套变量必须一一对应（布局变量与两种模式共用的状态色不在暗色块里重复声明）。
  const blockVars = (sel) => {
    const i = css.indexOf(sel);
    if (i < 0) return null;
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', open);
    return [...css.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
  };
  const lightVars = blockVars(':root {');
  const darkVars = blockVars('[data-theme="dark"] {');
  check(Array.isArray(lightVars) && lightVars.length > 0 && Array.isArray(darkVars) && darkVars.length > 0, '#37: light and dark palettes both parse');
  const sharedAcrossThemes = new Set(['--radius', '--safe', '--state-error', '--state-success', '--state-warn']);
  const missingInDark = (lightVars ?? []).filter((v) => !sharedAcrossThemes.has(v) && !(darkVars ?? []).includes(v));
  check(missingInDark.length === 0, `#37: every light colour token has a dark counterpart (missing: ${missingInDark.join(',') || 'none'})`);
  check(/color-scheme:\s*light/.test(css) && /color-scheme:\s*dark/.test(css), '#37: color-scheme declared so native widgets follow');

  // 主题 token 审计：client.js 用到的 --dsw-* 必须都在允许清单里（I12/I13 的根因守卫）。
  const allow = new Set((await readFile(join(repoRoot, 'tools', 'dsw-theme-tokens.txt'), 'utf8'))
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('--dsw-')));
  check(allow.size >= 10, `theme token allowlist loaded (${allow.size} tokens)`);
  const clientJs = await readFile(join(repoRoot, 'lib', 'client.js'), 'utf8');
  const usedTokens = [...new Set([...clientJs.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))].sort();
  const unknownTokens = usedTokens.filter((tk) => !allow.has(tk));
  check(unknownTokens.length === 0, `#37/I13: client.js only uses known theme tokens (unknown: ${unknownTokens.join(',') || 'none'})`);
  check(usedTokens.length >= 10, `client.js uses ${usedTokens.length} theme tokens`);
  check(!/--dsw-(state|bg|border|label|interactive)-/.test(clientJs), '#37/I13: no legacy non-alias token names in client.js');

  // 隔离闸门：DSH_ROOT 只有确实是一份产品树时才触发严格模式（与依赖树语义共存）。
  const { isDshProductTree } = await import('../lib/core.mjs');
  check((await isDshProductTree(join(root, 'no-such-tree'))) === false, 'isolation: a plain directory is not a product tree');
  check((await isDshProductTree('')) === false, 'isolation: empty DSH_ROOT never enters strict mode');
  const fakeTree = join(root, 'fake-product');
  await mkdir(join(fakeTree, 'lib'), { recursive: true });
  await writeFile(join(fakeTree, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.0.0"}\n');
  check((await isDshProductTree(fakeTree)) === false, 'isolation: package.json alone is not a product tree');
  await writeFile(join(fakeTree, 'lib', 'bin.js'), '// dsh bin\n');
  check((await isDshProductTree(fakeTree)) === true, 'isolation: package.json + lib/bin.js => strict mode on');
  const ps1 = await readFile(join(repoRoot, 'tools', 'apply-dsh-patches.ps1'), 'utf8');
  check(ps1.includes('lib\\bin.js') && ps1.includes('$productTree'), 'isolation: PowerShell side applies the same product-tree gate');
}

// ── T2. 启动预检体检与定点修复（v0.4.8）──────────────────────────────────
// 依据：隔离实例破坏式实验证明，profile 清单带 BOM、bundle 缺 dsh.bundle.patch
// 都会在任何插件挂载之前硬失败，进程内自救够不着。这一段既验检测面，也验修复
// 真能把文件改回来（BOM 剥掉、重复 id 去掉、悬空 junction 重指）。
console.log('== T2. boot preflight doctor + targeted repair (v0.4.8) ==');
{
  const core = await import('../lib/core.mjs');
  const rootD = await mkdtemp(join(tmpdir(), 'dsh-undo-doctor-'));
  const homeD = join(rootD, 'home');
  const webD = join(homeD, 'profiles', 'web');
  const autoD = join(homeD, 'undo-snapshots', 'auto');
  await mkdir(join(homeD, 'profiles', 'node_modules', 'exp-no-bundle'), { recursive: true });
  await mkdir(webD, { recursive: true });
  await mkdir(join(homeD, 'node_modules'), { recursive: true });
  await mkdir(autoD, { recursive: true });
  const cfgD = core.buildConfig({
    profileName: 'web', homeDir: homeD, profileDir: webD,
    manualDir: join(homeD, 'undo-snapshots', 'manual'), autoDir: autoD, pluginDirs: [],
  });

  // 1) profile 清单带 UTF-8 BOM（实测触发点：readProfileManifest 的 JSON.parse）
  const manifest = '{ "name": "dsh-profile-web", "dsh": { "profile": { "bundles": ["exp-no-bundle", "exp-missing-bundle"], "patchReload": "live" } } }\n';
  const manifestPath = join(webD, 'package.json');
  await writeFile(manifestPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(manifest, 'utf8')]));

  // 2) bundle 声明面：一个能解析但没声明 dsh.bundle.patch，一个根本解析不到
  await writeFile(join(homeD, 'profiles', 'node_modules', 'exp-no-bundle', 'package.json'), '{ "name": "exp-no-bundle", "version": "1.0.0" }\n');

  // 3) 悬空 junction：插件自身那条（迁移后最典型的症状）
  const selfLink = join(homeD, 'node_modules', 'dsh-undo-savepoint');
  const goneTarget = join(rootD, 'gone-target');
  await mkdir(goneTarget, { recursive: true });
  await symlink(goneTarget, selfLink, 'junction');
  await rm(goneTarget, { recursive: true, force: true });

  // 4) 同一个 patch 文件里 insert 了重复 id（实测触发点：duplicate loader entry id）
  const homePatch = join(homeD, 'cordis.patch.yml');
  await writeFile(homePatch, ['- insert:', '    - id: exp-dup', '      name: exp-one', '    - id: exp-dup', '      name: exp-two', ''].join('\n'));

  // 5) 上次启动没跑完，且没有可读的崩溃日志源
  await writeFile(join(autoD, 'boot-state.json'), JSON.stringify({ startedAt: '2026-09-15T14:00:00.000Z', pid: 1, ok: false, okAt: null, lastGoodAt: '2026-09-15T13:00:00.000Z', crashReason: null }));

  const codes = (r) => r.checks.map((c) => c.code);
  const before = await core.runDoctor(cfgD);
  const bomCheck = before.checks.find((c) => c.code === 'pre-manifest-bom');
  check(bomCheck !== undefined && bomCheck.level === 'err', 'T2: manifest BOM detected as an error');
  check(bomCheck?.fixable === true, 'T2: BOM check is marked fixable');
  check(before.checks.filter((c) => c.code === 'pre-bundle').length === 2, 'T2: both the local and the unresolvable bundle are reported');
  check(codes(before).includes('pre-link-dangling'), 'T2: dangling plugin junction detected');
  check(codes(before).includes('pre-loader-id'), 'T2: duplicated loader entry id detected');
  check(codes(before).includes('pre-boot-state'), 'T2: unfinished last boot surfaced');
  check(codes(before).includes('pre-crash-attribution'), 'T2: missing crash-log source surfaced');
  check(!codes(before).includes('pre-patchreload'), 'T2: a valid patchReload is not flagged');
  check(before.ok === false && before.fixable >= 3, `T2: report is unhealthy with fixable items (fixable=${before.fixable})`);

  const fixed = await core.runDoctorFix(cfgD);
  check(fixed.fixed >= 3 && fixed.failed === 0, `T2: fix applied cleanly (fixed=${fixed.fixed} failed=${fixed.failed})`);
  check(typeof fixed.snapshotId === 'string' && fixed.snapshotId.length > 0, 'T2: a pre-fix snapshot was taken');
  const afterManifest = await readFile(manifestPath);
  check(!(afterManifest[0] === 0xef && afterManifest[1] === 0xbb && afterManifest[2] === 0xbf), 'T2: BOM stripped from the profile manifest');
  check(JSON.parse(afterManifest.toString('utf8')).name === 'dsh-profile-web', 'T2: manifest still parses after the repair');
  const patchText = await readFile(homePatch, 'utf8');
  check((patchText.match(/id: exp-dup/g) ?? []).length === 1, 'T2: duplicate loader entry dropped, one left');
  check(patchText.includes('exp-two') && !patchText.includes('exp-one'), 'T2: the last entry of the duplicated id is the one kept');
  const afterCodes = codes(fixed.report);
  check(!afterCodes.includes('pre-manifest-bom') && !afterCodes.includes('pre-link-dangling') && !afterCodes.includes('pre-loader-id'), 'T2: repaired categories are clean on re-check');
  check(afterCodes.includes('pre-bundle'), 'T2: non-fixable problems stay reported (bundles)');
  const realSelf = await realpath(selfLink).catch(() => null);
  const pluginRoot = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..')).catch(() => null);
  check(realSelf !== null && pluginRoot !== null && realSelf.toLowerCase() === pluginRoot.toLowerCase(), 'T2: dangling plugin junction re-pointed at the installed plugin');
  const again = await core.runDoctorFix(cfgD);
  check(again.applied.length === 0, 'T2: a second repair run finds nothing to do (idempotent)');
  // 先摘掉 junction 本体再删目录，避免清理时跟随链接目标
  await rmdir(selfLink).catch(() => { });
  await cleanup(rootD);
}

console.log('== T2b. loader 条目判定收紧（#47）==');
// #47：llm-pi-ai 的 providers.*.models 是条目 config 内部的列表，旧扫描器按缩进抓所有
// `- id:`，同名模型被当成重复 loader 条目，fix=true 会删掉用户配置。判定收紧为「零缩进
// 顶层条目」与「顶层 insert 的直接子条目」两类，其余一律不登记 id。
{
  const core = await import('../lib/core.mjs');
  const root4 = await mkdtemp(join(tmpdir(), 'dsh-undo-loader47-'));
  const home4 = join(root4, 'home');
  const web4 = join(home4, 'profiles', 'web');
  await mkdir(web4, { recursive: true });
  await mkdir(join(home4, 'undo-snapshots', 'manual'), { recursive: true });
  await mkdir(join(home4, 'undo-snapshots', 'auto'), { recursive: true });
  const cfg4 = core.buildConfig({
    profileName: 'web', homeDir: home4, profileDir: web4,
    manualDir: join(home4, 'undo-snapshots', 'manual'), autoDir: join(home4, 'undo-snapshots', 'auto'), pluginDirs: [],
  });
  const patch4 = join(home4, 'cordis.patch.yml');
  const loaderHits = (r) => r.checks.filter((c) => c.code === 'pre-loader-id');

  // A) 嵌套 models 列表：同名 id 不登记，fix 不动文件
  const nested = [
    '- id: llm-pi-ai', '  config:', '    providers:', '      a:', '        models:',
    '          - id: same-model', '      b:', '        models:', '          - id: same-model', '',
  ].join('\n');
  await writeFile(patch4, nested, 'utf8');
  const repA = await core.runDoctor(cfg4);
  check(loaderHits(repA).length === 0, '#47: nested models ids are not loader entries (no report)');
  await core.runDoctorFix(cfg4);
  check((await readFile(patch4, 'utf8')) === nested, '#47: fix leaves the nested config byte-identical');

  // B) 顶层重复：仍检出（warn）并修掉，保留最后一条
  const top = ['- id: dup-entry', '  name: one', '- id: dup-entry', '  name: two', ''].join('\n');
  await writeFile(patch4, top, 'utf8');
  const repB = await core.runDoctor(cfg4);
  check(loaderHits(repB).length === 1 && loaderHits(repB)[0].fixable === true, '#47: top-level duplicate still detected and fixable');
  await core.runDoctorFix(cfg4);
  const afterB = await readFile(patch4, 'utf8');
  check((afterB.match(/id: dup-entry/g) ?? []).length === 1 && afterB.includes('name: two') && !afterB.includes('name: one'), '#47: top-level duplicate repaired, last entry kept');

  // C) 顶层 insert 的直接子条目：仍按 err 级检出并修掉
  const ins = ['- insert:', '    - id: dup-ins', '      name: one', '    - id: dup-ins', '      name: two', ''].join('\n');
  await writeFile(patch4, ins, 'utf8');
  const repC = await core.runDoctor(cfg4);
  check(loaderHits(repC).length === 1 && loaderHits(repC)[0].level === 'err', '#47: insert child duplicate still detected as err');
  await core.runDoctorFix(cfg4);
  const afterC = await readFile(patch4, 'utf8');
  check((afterC.match(/id: dup-ins/g) ?? []).length === 1 && afterC.includes('name: two'), '#47: insert child duplicate repaired, last entry kept');

  // D) 混合：顶层重复被修，嵌套同名模型原样保留
  const mixed = [
    '- id: dup-top', '  name: one', '- id: dup-top', '  name: two',
    '- id: llm-pi-ai', '  config:', '    providers:', '      a:', '        models:',
    '          - id: same-model', '      b:', '        models:', '          - id: same-model', '',
  ].join('\n');
  await writeFile(patch4, mixed, 'utf8');
  const repD = await core.runDoctor(cfg4);
  check(loaderHits(repD).length === 1 && String(loaderHits(repD)[0].name ?? '').includes('dup-top'), '#47: mixed patch reports only the top-level duplicate');
  await core.runDoctorFix(cfg4);
  const afterD = await readFile(patch4, 'utf8');
  check((afterD.match(/id: dup-top/g) ?? []).length === 1 && afterD.includes('name: two') && !afterD.includes('name: one'), '#47: mixed patch drops the top-level duplicate only');
  check((afterD.match(/same-model/g) ?? []).length === 2 && afterD.includes('- id: llm-pi-ai'), '#47: mixed patch keeps both nested model entries');

  await cleanup(root4);
}

console.log('== T3. undo_doctor fix=true: 预检修复的工具面（v0.4.8）==');
{
  const rootD3 = await mkdtemp(join(tmpdir(), 'dsh-undo-doctor-tool-'));
  const homeD3 = join(rootD3, 'home'), profileD3 = join(homeD3, 'profiles', 'web'), snapD3 = join(rootD3, 'snaps');
  await mkdir(profileD3, { recursive: true });
  const manifestD3 = '{ "name": "dsh-profile-web", "dsh": { "profile": { "bundles": [] } } }\n';
  await writeFile(join(profileD3, 'package.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(manifestD3, 'utf8')]));
  const toolsD3 = new Map();
  const ctxD3 = {
    tools: { register: (x) => { toolsD3.set(x.name, x); return () => { }; } },
    systemPrompt: { section: () => () => { } }, get: () => undefined,
    effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
  };
  apply(ctxD3, { manualDir: join(snapD3, 'manual'), autoDir: join(snapD3, 'auto'), homeDir: homeD3, profileDir: profileD3, watch: false, pluginDirs: [] });
  // apply 的启动自愈会异步写一条 {ok:false} 的启动态（写完才会有「上次启动未完成」提醒）。
  // 先等它落盘再摘掉：那条提醒与本次修复无关，却会让预检小结（仅在 0 问题时才打印）永不出现。
  const bootD3 = join(snapD3, 'auto', 'boot-state.json');
  await waitUntil(async () => (await readFile(bootD3, 'utf8').catch(() => null)) !== null);
  await rm(bootD3, { force: true });
  const doc = toolsD3.get('undo_doctor');
  const dry = await doc.execute({}, {});
  check(dry.includes('[fixable]'), 'T3: doctor marks the fixable problem without repairing it');
  const fixedD3 = await doc.execute({ fix: true }, {});
  const afterD3 = await readFile(join(profileD3, 'package.json'));
  check(!(afterD3[0] === 0xef && afterD3[1] === 0xbb && afterD3[2] === 0xbf), 'T3: undo_doctor fix=true stripped the manifest BOM');
  check(JSON.parse(afterD3.toString('utf8')).name === 'dsh-profile-web', 'T3: manifest still parses after the tool repair');
  check(!fixedD3.includes('[fixable]'), 'T3: the fix run re-checks and reports nothing fixable left');
  check(fixedD3.includes('link(s) checked'), 'T3: the fixed report shows the preflight summary (what was checked)');
  const againD3 = await doc.execute({ fix: true }, {});
  check(!againD3.includes('[fixable]'), 'T3: a second fix run finds nothing left to repair');
  await cleanup(rootD3);
}

await rm(root, { recursive: true, force: true });

// ══ v0.5.0 additions ═════════════════════════════════════════════════════
// 0.5.0 断言区：后续工单（W03/W05/W08/W12/W14/W18-W20/W22/W25/W26）的断言
// 统一追加在本区段内。断言写法约定：独立块级作用域 { ... }，自建夹具自清理，
// 不与上方历史测试段共享变量（root/home/profile 已被 rm，勿引用）。
{
  // 环境探针：让每次门禁输出都带环境指纹，排查平台差异断言数漂移用。
  const hasZstdW = typeof (await import('node:zlib')).zstdDecompressSync === 'function';
  console.log(`env: node ${process.version} platform=${process.platform} zstd=${hasZstdW}`);

  // cfgW：0.5.0 断言区共享的最小配置（独立临时目录，用后自清）。
  const rootW = await mkdtemp(join(tmpdir(), 'dsh-undo-w05-'));
  const homeW = join(rootW, 'home');
  const profileW = join(rootW, 'profile');
  await mkdir(homeW, { recursive: true });
  await mkdir(profileW, { recursive: true });
  await writeFile(join(homeW, 'settings.yaml'), 'model: v1\n');
  await writeFile(join(profileW, 'cordis.patch.yml'), '# patch\n[]\n');
  await writeFile(join(profileW, 'package.json'), '{"name":"test","v":1}\n');
  process.env.DSH_UNDO_SETTINGS = join(rootW, 'undo', 'settings.json');
  process.env.DSH_UNDO_ROOT = join(rootW, 'undo-snapshots');
  // cfgW 用字面量构造（不走 buildConfig）：core 的 SETTINGS_FILE / LEGACY_ROOT
  // 是 import 时求值的模块常量，文件尾设 env 已太晚；且 buildConfig 不接受
  // settingsFile 覆盖。所有 core 函数只吃纯数据 cfg，字面量即等价。
  const cfgW = {
    settingsFile: join(rootW, 'undo', 'settings.json'),
    profileName: 'web',
    homeDir: homeW,
    profileDir: profileW,
    manualDir: join(rootW, 'undo-snapshots', 'manual'),
    autoDir: join(rootW, 'undo-snapshots', 'auto'),
    sensitiveMode: 'redact',
    keepAuto: 20,
    keepPre: 10,
    pluginDirs: [],
    workspaceDirs: [],
    bootAlert: null,
    restoredHashes: new Map(),
    suppressAuto: 0,
  };
  // 断言区夹具常驻到进程结束（exit 前 rm），后续工单断言块追加在本块内
  // （`}` 之前），直接复用 cfgW / rootW / hasZstdW，无需重新构造。
  process.on('exit', () => { try { rmSync(rootW, { recursive: true, force: true }); } catch { /* noop */ } });
  check(typeof cfgW.manualDir === 'string', 'W04: 0.5.0 assertion zone cfgW ready');

  // 后续工单断言块追加在本行之后（`}` 之前）。共用本区的 cfgW / rootW / hasZstdW。
  const core = await import('../lib/core.mjs');

  // W46: dedupeMount 的 config 豁免与悬空 insert 清理（批次合集 §5，issue #43）。
  // 判定口径两处收紧：挂载条目按 `id:`/`name:` 识别（不再按子串），
  // 摘除粒度落在条目上（同级兄弟条目不被连带删除）。
  {
    const w46 = join(rootW, 'w46');
    await mkdir(w46, { recursive: true });
    const w46Read = async (p) => (await readFile(p, 'utf8')).replace(/\n$/, '');

    // 1. 同一 `- insert:` 键下并列「插件条目 + 带 config 的用户条目」：用户条目须逐字保留。
    const p1 = join(w46, 'exempt.yml');
    await writeFile(p1, '- insert:\n  - id: dsh-undo-savepoint\n    name: dsh-undo-savepoint\n  - id: dsh-mcp-client\n    name: dsh-mcp-client\n    config:\n      headers:\n        Authorization: Bearer sk-w46-keep\n', 'utf8');
    const r1 = await core.removeMountBlock(p1);
    const t1 = await w46Read(p1);
    check(!t1.includes('dsh-undo-savepoint') && r1.removed === 1,
      'W46: 带 config 的同级用户条目未被连带删除，插件条目已摘除');
    check(t1.includes('Authorization: Bearer sk-w46-keep'),
      'W46: 用户 config 条目逐字保留');

    // 2. 收紧识别：用户条目在 config 文本里提到插件名，不得被当作挂载条目删除。
    const p2 = join(w46, 'mention.yml');
    await writeFile(p2, '- insert:\n  - id: dsh-mcp-client\n    name: dsh-mcp-client\n    config:\n      note: "dsh-undo-savepoint is installed"\n      headers:\n        Authorization: Bearer sk-w46-keep\n', 'utf8');
    await core.removeMountBlock(p2);
    const t2 = await w46Read(p2);
    check(t2.includes('sk-w46-keep') && t2.includes('dsh-undo-savepoint'),
      'W46: 用户条目自述文字里的插件名不被误判为挂载（旧实现会清空文件）');

    // 3. 标记分支：插件条目自带 config 块，其后并列用户条目。摘除后不得留裸 config 残块。
    const p3 = join(w46, 'marker.yml');
    await writeFile(p3, '# dsh-undo-savepoint mount\n- insert:\n  - id: dsh-undo-savepoint\n    name: dsh-undo-savepoint\n    config:\n      retries: 3\n  - id: dsh-mcp-client\n    name: dsh-mcp-client\n    config:\n      headers:\n        Authorization: Bearer sk-w46-keep\n', 'utf8');
    await core.removeMountBlock(p3);
    const t3 = await w46Read(p3);
    check(!t3.includes('dsh-undo-savepoint') && !t3.includes('retries: 3') && !t3.includes('mount'),
      'W46: 标记注释随其所属条目一并清除，不留裸 config 残块');
    check(t3.includes('sk-w46-keep'), 'W46: 标记分支下用户条目仍逐字保留');

    // 4. 悬空 insert 检出与清理（不经 removeMountBlock，直接构造悬空形状）。
    const p4a = join(w46, 'dangling.yml');
    const p4b = join(w46, 'healthy.yml');
    await writeFile(p4a, '# patch\ninsert:\n\n', 'utf8');
    await writeFile(p4b, '- insert:\n    - id: x\n      name: x\n', 'utf8');
    const hitA = core.findDanglingInserts(await readFile(p4a, 'utf8'));
    const hitB = core.findDanglingInserts(await readFile(p4b, 'utf8'));
    check(hitA.length === 1 && hitB.length === 0 && hitA[0].line === 2,
      'W46: findDanglingInserts 只在悬空文件上命中且给出行号');
    check((await core.cleanDanglingInserts(p4a)) === 1 && (await core.cleanDanglingInserts(p4a)) === 0,
      'W46: cleanDanglingInserts 清理计数为 1 且二次调用幂等');
    check(!(await w46Read(p4a)).includes('insert:') && (await readFile(p4b, 'utf8')).includes('insert:'),
      'W46: 悬空键被清除，健康文件的 insert 键不受影响');

    // 5. #43 报告者形状走完整 dedupeMount 链：豁免上报、文件不被删、无悬空键。
    const h46 = join(w46, 'home');
    const pr46 = join(h46, 'profiles', 'web');
    await mkdir(pr46, { recursive: true });
    await writeFile(join(pr46, 'cordis.patch.yml'), '- insert:\n  - id: dsh-undo-savepoint\n    name: dsh-undo-savepoint\n', 'utf8');
    await writeFile(join(pr46, 'package.json'), '{"name":"p"}\n', 'utf8');
    const hp46 = join(h46, 'cordis.patch.yml');
    await writeFile(hp46, '- insert:\n  - id: dsh-undo-savepoint\n    name: dsh-undo-savepoint\n  - id: dsh-mcp-client\n    name: dsh-mcp-client\n    config:\n      headers:\n        Authorization: Bearer sk-w46-keep\n', 'utf8');
    const r5 = await core.dedupeMount({ homeDir: h46, profileDir: pr46, profileName: 'web' });
    const t5 = await readFile(hp46, 'utf8');
    check(Array.isArray(r5.exempt) && r5.exempt.length === 1 && r5.removed.length === 0,
      'W46: dedupeMount 对携带 config 的位置上报 exempt 且不删除该处');
    check(t5.includes('sk-w46-keep') && t5.includes('dsh-undo-savepoint') && !core.findDanglingInserts(t5).length,
      'W46: 豁免位置逐字未动且无悬空 insert 键');
  }

  // W47: profileName 六层检测链与快照库连续性守卫（issue #43 问题 1、#44 问题 1）。
  // 层序由决策点 9 拍板：plugin config > settings 文件 > argv --profile > 宿主 profile 通道
  // > DSH_PROFILE > web。断言直接打解析器函数，不依赖真实 profileContext（真机行为由 W45
  // 第三项第 4 条观察）。
  {
    const base = await import('../lib/base.mjs');
    const { t: tW47 } = await import('../lib/i18n.mjs');
    // 夹具必须同时满足两件事：loadSettingsFile() 读的是 base.mjs **加载期**捕获的
    // SETTINGS_FILE（本文件头部就把环境变量钉在了临时根上），而 base.LEGACY_ROOT 同理。
    // 第 2316 行之后的 re-bind 对已加载模块无效，所以夹具直接取 base 的常量并把环境变量
    // 对齐到同一处，再断言两者都落在临时根，避免用例静默空跑或碰到真实 home。
    const w47settings = base.SETTINGS_FILE;
    const w47settingsIsTemp = w47settings.startsWith(tmpdir()) && base.LEGACY_ROOT.startsWith(tmpdir());
    let w47settingsBackup = null;
    let w47settingsHadFile = false;
    try { w47settingsBackup = await readFile(w47settings, 'utf8'); w47settingsHadFile = true; } catch { /* 本来就没有 */ }
    await mkdir(dirname(w47settings), { recursive: true });
    const savedSettingsW = process.env.DSH_UNDO_SETTINGS;
    const savedProfileW = process.env.DSH_PROFILE;
    process.env.DSH_UNDO_SETTINGS = w47settings;
    delete process.env.DSH_PROFILE;
    const writeW47Settings = (obj) => writeFile(w47settings, JSON.stringify(obj), 'utf8');
    try {
      check(w47settingsIsTemp, 'W47: 设置文件与快照库都落在临时根（夹具不碰真实 home）');
      // (1) argv 旗标命中：两种写法都算 arg 层。
      await writeW47Settings({});
      const r47a1 = base.resolveProfileName({ argv: ['--profile', 'work'] });
      check(r47a1.name === 'work' && r47a1.source === 'arg', 'W47: argv `--profile work` 命中 arg 层');
      const r47a2 = base.resolveProfileName({ argv: ['--profile=work'] });
      check(r47a2.name === 'work' && r47a2.source === 'arg', 'W47: argv `--profile=work` 命中 arg 层');
      // (2) 宿主通道命中：argv 无 profile 时由 profileContext 决定。
      const r47b = base.resolveProfileName({ argv: [], hostProfileName: 'desktop' });
      check(r47b.name === 'desktop' && r47b.source === 'host', 'W47: 宿主 profile 通道命中 host 层');
      // (3) 环境变量命中：仅在 CLI 手工 export 时生效（桌面形态读不到，见层 5 注释）。
      process.env.DSH_PROFILE = 'cli-profile';
      const r47c = base.resolveProfileName({ argv: [], hostProfileName: null });
      check(r47c.name === 'cli-profile' && r47c.source === 'env', 'W47: DSH_PROFILE 命中 env 层');
      // (4) 各层全缺 -> web 兜底。
      delete process.env.DSH_PROFILE;
      const r47d = base.resolveProfileName({ argv: [] });
      check(r47d.name === 'web' && r47d.source === 'default', 'W47: 各层全缺时落 web / default');
      // (5) settings 档生效，且 config 层仍压过 settings 层（层序）。
      await writeW47Settings({ profileName: 'desk' });
      const r47e = base.resolveProfileName({ argv: [] });
      check(r47e.name === 'desk' && r47e.source === 'settings',
        `W47: settings 文件的 profileName 生效（得到 ${r47e.name}/${r47e.source}；文件 ${w47settings}；base 快照 ${base.SETTINGS_FILE}）`);
      const r47e2 = base.resolveProfileName({ configProfileName: 'cfg', argv: [] });
      check(r47e2.name === 'cfg' && r47e2.source === 'config', 'W47: config 层压过 settings 层');
      await writeW47Settings({});
      // (7) 非默认 home 变体（#44 数据点）：home 走临时目录，profileDir 必须基于该 home。
      // 先把 settings 档清空，否则本用例会先在 settings 层命中，测不到宿主通道。
      await writeW47Settings({});
      const r47g = base.resolveProfileName({ argv: [], hostProfileName: 'desktop' });
      const w47home = join(rootW, 'w47', 'nondefault-home');
      const cfg47g = base.buildConfig({ homeDir: w47home, hostProfileName: 'desktop' });
      check(r47g.name === 'desktop' && r47g.source === 'host'
        && cfg47g.profileName === 'desktop' && cfg47g.profileSource === 'host'
        && cfg47g.profileDir === join(w47home, 'profiles', 'desktop'),
        `W47: 非默认 home 变体下 profileDir 仍基于该 home（${cfg47g.profileName}/${cfg47g.profileSource}/${cfg47g.profileDir}）`);
      // (2b) 既有 detectProfileName 的签名与语义必须逐字不变。
      check(base.detectProfileName(['--profile', 'mine']) === 'mine'
        && base.detectProfileName(['--profile=mine']) === 'mine'
        && base.detectProfileName(['--profile']) === 'web',
        'W47: detectProfileName 旧签名与语义逐字保持');
      // (8) 连续性守卫：目标作用域为空而历史位置有快照时沿用既有位置；
      //     显式来源不触发继承，web 自身保留旧平铺回退。
      // 守卫读的是 base.mjs 加载期固定的 LEGACY_ROOT（= DSH_UNDO_ROOT），所以夹具必须
      // 建在真实 LEGACY_ROOT 下，不能自造一个假根；用完立刻清掉，避免污染后续断言块。
      const w47legacyRoot = base.LEGACY_ROOT;
      const w47legacyWeb = join(w47legacyRoot, 'web');
      await mkdir(join(w47legacyWeb, 'auto'), { recursive: true });
      try {
        const g47 = base.resolveStoreRoots('desktop', { source: 'default' });
        check(g47.autoDir === join(w47legacyWeb, 'auto') && g47.inheritedFrom === 'web',
          'W47: 守卫在目标作用域为空时沿用 web 作用域并记录来源');
        const g47b = base.resolveStoreRoots('desktop', { source: 'config' });
        check(g47b.autoDir === join(w47legacyRoot, 'desktop', 'auto') && !g47b.inheritedFrom,
          'W47: 显式来源不触发继承');
        // buildConfig 接线：settings 来源同样触发继承，且 cfg 记下 storeInheritedFrom。
        await writeFile(w47settings, JSON.stringify({ profileName: 'desktop' }), 'utf8');
        const cfg47inh = base.buildConfig({ homeDir: join(rootW, 'w47', 'inh-home') });
        check(cfg47inh.profileName === 'desktop' && cfg47inh.profileSource === 'settings'
          && cfg47inh.autoDir === join(w47legacyWeb, 'auto') && cfg47inh.storeInheritedFrom === 'web',
          `W47: buildConfig 沿用历史位置并记 storeInheritedFrom（${cfg47inh.profileName}/${cfg47inh.profileSource}/${cfg47inh.autoDir}，期望 ${join(w47legacyWeb, 'auto')}）`);
        await writeFile(w47settings, JSON.stringify({}), 'utf8');
      } finally {
        await rm(w47legacyWeb, { recursive: true, force: true });
      }
      const g47c = base.resolveStoreRoots('web', { source: 'default' });
      check(g47c.autoDir.endsWith(join('undo-snapshots', 'web', 'auto')) && !g47c.inheritedFrom,
        'W47: web 不触发继承（保留旧平铺回退）');
      // (6) #43 报告者场景金样（端到端）：home 下只有 profiles/desktop，argv 无 --profile，
      //     宿主通道注入 desktop。快照与 manifest 的 profile 字段都必须落在 desktop。
      const w47root = join(rootW, 'w47', 'golden');
      const w47home2 = join(w47root, 'dsh-home');
      const w47profile = join(w47home2, 'profiles', 'desktop');
      const w47manual = join(w47root, 'snaps', 'manual');
      const w47auto = join(w47root, 'snaps', 'auto');
      await mkdir(w47profile, { recursive: true });
      await writeFile(join(w47home2, 'settings.yaml'), 'model: x\n');
      await writeFile(join(w47profile, 'cordis.patch.yml'), '# patch\n[]\n');
      const w47tools = new Map();
      const w47ctx = {
        tools: { register: (t) => { w47tools.set(t.name, t); return () => { }; } },
        systemPrompt: { section: () => () => { } }, get: () => undefined,
        profileContext: { name: 'desktop' },
        effect: (fn) => { const d = fn(); return d ?? (() => { }); },
        logger: { info: () => { }, warn: () => { } },
      };
      apply(w47ctx, { manualDir: w47manual, autoDir: w47auto, homeDir: w47home2, pluginDirs: [], watch: false });
      await new Promise((r) => setTimeout(r, 300));
      const w47snap = await w47tools.get('undo_snapshot').execute({ reason: 'w47' }, {});
      const w47id = (await readdir(w47manual)).find((d) => d !== '.booting');
      const w47m = JSON.parse(await readFile(join(w47manual, w47id, 'manifest.json'), 'utf8'));
      check(w47m.profile === 'desktop' && w47m.files.some((f) => f.name === 'home-settings.yaml'),
        'W47: 宿主通道命中后快照 manifest 记为 desktop 且收下 home 配置');
      const w47list = await w47tools.get('undo_list').execute({}, {});
      check(String(w47list).includes('Profile: desktop') && String(w47list).includes(tW47('profile.source', { src: 'host' })),
        'W47: undo_list 尾注带 profile 名与来源');
      check(!!w47snap, 'W47: 金样场景下快照动作正常返回');
    } finally {
      if (savedSettingsW === undefined) delete process.env.DSH_UNDO_SETTINGS; else process.env.DSH_UNDO_SETTINGS = savedSettingsW;
      if (savedProfileW === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = savedProfileW;
      // 恢复设置文件：后续断言块（cfgW 的 publicSettings / 快照用例）读同一份文件。
      try {
        if (w47settingsHadFile) await writeFile(w47settings, w47settingsBackup, 'utf8');
        else await rm(w47settings, { force: true });
      } catch { /* 恢复失败不掩盖断言结果 */ }
    }
  }

  // W44: v4 会话实测与用例扩写（批次合集 §4，附 v4 实文件夹具生成器）。
  // E64 已修的路径由前四条断言钉住：v3 桶不再吞 v4，且 v4 是独立计数桶。
  {
    const fx = await import('./make-v4-session.mjs');
    const sessionMod = await import('../lib/session.mjs');
    const w44root = join(rootW, 'w44');
    const censusHome = join(w44root, 'census-home');
    const sessions44 = join(censusHome, 'sessions');
    await mkdir(sessions44, { recursive: true });
    await fx.writeMixed(sessions44);

    // (1) mixed 夹具文件名与既有识别规则一致（一个会话目录一个日志文件）。
    const specs = fx.sampleSpecs().map((s) => `${s.dir}/${s.file}`).sort();
    const onDisk = [];
    for (const d of await readdir(sessions44)) {
      for (const f of await readdir(join(sessions44, d))) onDisk.push(`${d}/${f}`);
    }
    check(JSON.stringify(onDisk.sort()) === JSON.stringify(specs),
      'W44: mixed 夹具产出六个样本，文件名与代际识别规则一致');
    check(fx.nodeTooOld() === false, 'W44: 夹具生成器在当前 Node 上可用（zstd Zlib API 齐备）');

    // (2) v4 头行：接受合规头（含 delegationDepth 与 PTC 迁移字段）、拒绝缺字段的头。
    const hdrText44 = sessionMod.zstdDecodeAll(fx.buildSession({ generation: 4 }));
    const hdr44 = JSON.parse(hdrText44.slice(0, hdrText44.indexOf('\n')));
    check(hdr44.version === 4 && typeof hdr44.version === 'number', 'W44: v4 头行的 version 是数值 4');
    check(sessionMod.analyzeSessionBytes(fx.buildSession({ generation: 4 })).status === 'ok',
      'W44: 合规 v4 头被接受（status=ok）');
    const noDepth = sessionMod.analyzeSessionBytes(fx.buildSession({ generation: 4, dropHeaderField: 'delegationDepth' }));
    check(noDepth.status === 'corrupt' && /not a valid session header/.test(noDepth.reason),
      'W44: 缺 delegationDepth 的 v4 头被拒为 corrupt');
    check(sessionMod.parseSessionLogZstdName('session.v4.jsonl.zstd').generation === 4,
      'W44: 会话名识别对 v4 走正则路（生成代际=4，无硬编码清单）');

    // (3) 代际分布四桶：v3 桶不含 v4（E64 直接断言），v4 计数等于 v4 文件数。
    const cen44 = await core.sessionCensus({ homeDir: censusHome });
    check(cen44.byGeneration.v0 === 1 && cen44.byGeneration.v2 === 1,
      'W44: v0 与 v2 桶计数各为 1');
    check(cen44.byGeneration.v3 === 1, 'W44: v3 桶只计 v3，不吞 v4（E64 直接断言）');
    check(cen44.byGeneration.v4 === 3, 'W44: v4 桶为 3（native + seeded + 单帧违规样本）');
    check(cen44.total === 6 && cen44.higherGenerations === 0, 'W44: 总会话数 6 且无更高代际');

    // (3b) 更高代际并入 v4 桶并单独计数，v5 起不必改代码。
    const v5Home = join(w44root, 'v5-home');
    await mkdir(join(v5Home, 'sessions', 'sess-v5'), { recursive: true });
    await writeFile(join(v5Home, 'sessions', 'sess-v5', 'session.v5.jsonl.zstd'),
      fx.buildSession({ generation: 5, id: 'fixture-v5' }));
    const cenV5 = await core.sessionCensus({ homeDir: v5Home });
    check(cenV5.byGeneration.v4 === 1 && cenV5.higherGenerations === 1,
      'W44: gen>4 并入 v4 桶，同时计 higherGenerations');

    // (4)(5) undo_scan 端到端：合规 v4 报 ok、单帧违规报 fixable、修复后复扫 ok 且 .bak 逐字节一致。
    const scanHome = join(w44root, 'scan-home');
    const scanSessions = join(scanHome, 'sessions');
    await mkdir(scanSessions, { recursive: true });
    await fx.writeMixed(scanSessions);
    await fx.writeTwoFrame(scanSessions, { dir: 'sess-v4-twoframe', file: 'session.v4.jsonl.zstd', generation: 4, id: 'fixture-v4-twoframe' });
    const tools44 = new Map();
    const ctx44 = {
      tools: { register: (t) => { tools44.set(t.name, t); return () => { }; } },
      systemPrompt: { section: () => () => { } }, get: () => undefined,
      effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
    };
    apply(ctx44, {
      manualDir: join(w44root, 'snap', 'manual'), autoDir: join(w44root, 'snap', 'auto'),
      homeDir: scanHome, profileDir: join(w44root, 'profile'), watch: false, pluginDirs: [],
    });
    await new Promise((r) => setTimeout(r, 400));
    const scan44a = await tools44.get('undo_scan').execute({}, {});
    check(new RegExp('ok\\s+.*sess-v4-twoframe[\\\\/]session\\.v4\\.jsonl\\.zstd \\(3 events, 2 frames\\)').test(scan44a),
      'W44: 合规两帧 v4 报 ok，事件帧计数正确');
    check(/fixable\s+.*sess-v4-single-frame/.test(scan44a), 'W44: 单帧布局违规样本报 fixable');
    check(/ok\s+.*sess-v4-seeded[\\/]session\.v4\.jsonl\.zstd/.test(scan44a),
      'W44: seeded v4 报 ok（代际识别不硬编码）');
    check(/summary: 6 ok, 0 fixed, 1 fixable, 0 isolated, 0 corrupt/.test(scan44a),
      'W44: 扫描汇总为 6 ok / 1 fixable');
    const single44 = join(scanSessions, 'sess-v4-single-frame', 'session.v4.jsonl.zstd');
    const before44 = await readFile(single44);
    const scan44b = await tools44.get('undo_scan').execute({ quarantine: true }, {});
    check(/fixed\s+.*sess-v4-single-frame/.test(scan44b), 'W44: quarantine 修复单帧违规样本');
    const scan44c = await tools44.get('undo_scan').execute({}, {});
    check(new RegExp('ok\\s+.*sess-v4-single-frame[\\\\/]session\\.v4\\.jsonl\\.zstd').test(scan44c),
      'W44: 修复后复扫为 ok');
    check(Buffer.compare(await readFile(single44 + '.bak'), before44) === 0,
      'W44: 修复前的原件在 .bak 中逐字节保留');

    // (6) 脱敏两形态：YAML 形态覆盖 home-settings.yaml，行级形态覆盖 .env；
    //     并钉住「v4 是第一个把头行文本写进磁盘的代际」这一事实（脱敏面必须覆盖头帧）。
    const marker44 = fx.PLAINTEXT_MARKER;
    const yamlW44 = `model: deepseek-flash\ndeepseek:\n  apiKey: ${marker44}\n  models:\n    - a\n    - b\nnested:\n  list:\n    - token: ${marker44}\n`;
    const redYaml44 = core.redactYamlContent(yamlW44);
    check(!redYaml44.includes(marker44), 'W44: YAML 形态脱敏后不含明文标记串');
    check(core.isYamlDest('home-settings.yaml') === true, 'W44: home-settings.yaml 走 YAML 脱敏路径');
    check(!core.redactByDest('home-.env', `MODEL=x\nAPI_KEY=${marker44}\n`).includes(marker44),
      'W44: 行级形态脱敏后不含明文标记串');
    check(hdrText44.includes(marker44), 'W44: v4 头帧确实携带明文标记（使上述断言有意义）');
    check(!sessionMod.zstdDecodeAll(fx.buildSession({ generation: 3 })).includes(marker44),
      'W44: v3 及更早的头行不携带文本内容（对照）');
    check(typeof hdr44.systemPrompt === 'string' && hdr44.systemPrompt.includes(marker44),
      'W44: 标记位置就在头行 systemPrompt，脱敏面必须覆盖头帧');
  }

  // W03: manifest 格式字段（schemaVersion / compression），只写不读。
  {
    const snapW03 = await core.createSnapshot(cfgW, 'manual', 'w03-field-check');
    // createSnapshot 返回 manifest 对象本身（不含 _dir）；_dir 只由 listSnapshots 附加。
    // 快照目录 = <manualDir>/<id>，故直接用返回的 id 拼路径。
    const mW03 = JSON.parse(await readFile(join(cfgW.manualDir, snapW03.id, 'manifest.json'), 'utf8'));
    check(mW03.schemaVersion === 1, 'W03: manifest carries schemaVersion=1');
    check(mW03.compression === 'none', 'W03: manifest carries compression=none');
  }

  // W08: 快照审计——手工构造带明文的历史快照目录（绕过 createSnapshot 的脱敏）
  {
    const auditDir = join(cfgW.manualDir, 'aud-test-0001');
    await mkdir(auditDir, { recursive: true });
    await writeFile(join(auditDir, 'manifest.json'), JSON.stringify({ id: 'aud-test-0001', time: new Date().toISOString(), kind: 'manual', reason: 'audit-test', files: [{ name: 'home-settings.yaml', hash: 'x', size: 10 }], profile: 'web' }));
    await writeFile(join(auditDir, 'home-settings.yaml'), 'api_key: sk-abcdef0123456789abcdef\n');
    const r = await core.auditSnapshots(cfgW);
    check(r.scanned >= 1, 'W08: audit sees the planted snapshot');
    check(r.findings.some((f) => f.snapshot === 'aud-test-0001' && f.kind === 'api-key'), 'W08: plaintext api-key flagged');
    await rm(auditDir, { recursive: true, force: true });
    const r2 = await core.auditSnapshots(cfgW);
    check(r2.ok === true, 'W08: clean store reports ok');
  }

  // W31: 首次挂载声明与确认（consent）。
  // 断言口径说明（施工期决策，已登记核验报告 E23）：W31 的核心行为发生在
  // apply() 内，但 apply 需要真实的 DSH ctx（工具经 peer 依赖
  // @deepseek-ai/dsh-tools 的 defineTool 注册，且 ctx.effect 的回调必须真正
  // 执行才会注册）；伪造 ctx 执行回调会启动真实 HTTP 服务与定时器并挂住测试
  // 进程。因此本区只断言 consent 的纯契约面（可稳定验证），端到端由局内实测
  // 与 W32 的卸载路径补齐。
  {
    // A1: 设置面新增两键且默认值正确（undefined = 从未确认）。
    check('consent' in core.DEFAULT_SETTINGS && core.DEFAULT_SETTINGS.consent === undefined,
      'W31: DEFAULT_SETTINGS.consent defaults to undefined (never confirmed)');
    check('consentAt' in core.DEFAULT_SETTINGS && core.DEFAULT_SETTINGS.consentAt === null,
      'W31: DEFAULT_SETTINGS.consentAt present and default null');

    // A2: 文案完整性锚点（中英双份都含「undo-snapshots」与「22.15」），
    // 且 getConsentText 按 DSH_UNDO_LANG 选语言，未设置时默认中文。
    const zhText = core.getConsentText('zh');
    const enText = core.getConsentText('en');
    const anchorsOk = zhText.includes('undo-snapshots') && zhText.includes('22.15')
      && enText.includes('undo-snapshots') && enText.includes('22.15');
    check(anchorsOk, 'W31: CONSENT_TEXT zh/en both carry undo-snapshots and 22.15 anchors');

    // A3: promptConsent 的三重缓解都可验证 —— 非 TTY 直通、环境变量逃生、
    // 且两者都返回 asked=false（不读 stdin，避免测试挂住）。
    const savedEnv = { noConsent: process.env.DSH_UNDO_NO_CONSENT, ttys: {} };
    let nonTty = null;
    let envSkip = null;
    try {
      process.env.DSH_UNDO_NO_CONSENT = '1';
      delete process.stdin.isTTY;
      envSkip = await core.promptConsent({});
      process.env.DSH_UNDO_NO_CONSENT = '';
      delete process.env.DSH_UNDO_NO_CONSENT;
      nonTty = await core.promptConsent({});
    } finally {
      if (savedEnv.noConsent === undefined) delete process.env.DSH_UNDO_NO_CONSENT;
      else process.env.DSH_UNDO_NO_CONSENT = savedEnv.noConsent;
    }
    check(envSkip?.accepted === true && envSkip?.asked === false && envSkip?.reason === 'env-skip',
      'W31: promptConsent env escape hatch accepts without asking');
    check(nonTty?.accepted === true && nonTty?.asked === false && nonTty?.reason === 'non-interactive',
      'W31: promptConsent auto-accepts non-interactive stdin');
  }

  // W32: 一键卸载（planUninstall + applyUninstall）。
  // 用真实 junction/文件夹具走核心函数（不 spawn CLI：本门禁从不派生子进程，
  // 真 junction 在 win32 需开发者模式或管理员权限，故注入 opts.listLinks；
  // removeLink 的原语行为已由真实 junction 单独验证过）。
  {
    const fxRoot = await mkdtemp(join(tmpdir(), 'dsh-undo-w32-'));
    process.on('exit', () => { try { rmSync(fxRoot, { recursive: true, force: true }); } catch { /* noop */ } });
    const fxHome = join(fxRoot, 'home');
    const fxProfile = join(fxHome, 'profiles', 'web');
    const fxDesktop = join(fxRoot, 'desktop');
    const fxTarget = join(fxRoot, 'fake-dsh-undo-savepoint-plugin');
    await mkdir(join(fxProfile, 'node_modules'), { recursive: true });
    await mkdir(fxDesktop, { recursive: true });
    await mkdir(join(fxHome, 'undo'), { recursive: true });
    await mkdir(fxTarget, { recursive: true });
    await writeFile(join(fxTarget, 'package.json'), '{"name":"dsh-undo-savepoint"}\n');
    const fxPatch = join(fxProfile, 'cordis.patch.yml');
    await writeFile(fxPatch, [
      '# patch',
      '- insert:',
      '    - id: dsh-undo-savepoint',
      '      name: dsh-undo-savepoint',
      '',
    ].join('\n'));
    const fxLink = join(fxProfile, 'node_modules', 'dsh-undo-savepoint');
    let fxLinkOk = false;
    try {
      await symlink(fxTarget, fxLink, process.platform === 'win32' ? 'junction' : 'dir');
      fxLinkOk = true;
    } catch { /* 平台不允许建链接：退化用注入的假 link 列表 */ }
    const sp = core.desktopShortcutPlan({ desktopDir: fxDesktop });
    await writeFile(sp.path, 'fake shortcut\n');
    const linkProbe = fxLinkOk ? null : [{ path: fxLink, name: 'dsh-undo-savepoint', target: fxTarget, ok: true }];
    const listLinksFn = async () => linkProbe ?? core.listLinks(join(fxProfile, 'node_modules'));

    const fxCfg = core.buildConfig({ homeDir: fxHome, profileName: 'web' });
    const planned = await core.planUninstall(fxCfg, { purge: false, desktopDir: fxDesktop, listLinks: listLinksFn });
    check(planned.plan.some((x) => x.what === 'mount declaration'), 'W32: plan finds the patch mount declaration');
    check(planned.plan.some((x) => x.what === 'junction'), 'W32: plan finds the plugin junction');
    check(planned.plan.some((x) => x.what === 'shortcut'), 'W32: plan finds the desktop shortcut');
    check(planned.plan.every((x) => x.what !== 'state dir' && x.what !== 'snapshot library'),
      'W32: default plan keeps state dir and snapshot library');
    check(planned.notes.some((n) => n.includes('kept: undo-snapshots')), 'W32: default plan notes the kept snapshot library');

    const applied = await core.applyUninstall(planned.plan, { purge: false });
    check(applied.removedMount === 1 && applied.removedJunction === 1 && applied.removedShortcut === 1 && applied.failed === 0,
      `W32: apply removes mount/junction/shortcut (${applied.removedMount}/${applied.removedJunction}/${applied.removedShortcut}, failed=${applied.failed})`);
    check(!(await core.pathExists(fxPatch)), 'W32: patch file deleted after its last entry was removed');
    check(!(await core.pathExists(fxLink)) || !fxLinkOk, 'W32: junction removed');
    check(!(await core.pathExists(sp.path)), 'W32: shortcut file removed');
    check(await core.pathExists(join(fxTarget, 'package.json')), 'W32: junction target directory left intact');

    const purged = await core.planUninstall(fxCfg, { purge: true, desktopDir: fxDesktop, listLinks: async () => [] });
    check(purged.plan.some((x) => x.what === 'state dir'), 'W32: --purge plan includes the state dir');

    // W32 兜底修（施工期发现）：无 mount 标记的扁平 patch（手工按 README 方式 B
    // 挂载的情形）在摘掉条目后不能留下空的 `- insert:` 残壳。
    const flatPatch = join(fxProfile, 'flat.patch.yml');
    await writeFile(flatPatch, '# patch\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n');
    await core.removeMountBlock(flatPatch);
    const flatLeft = await readFile(flatPatch, 'utf8');
    check(!flatLeft.includes('insert:'), 'W32: plain patch loses the emptied insert shell');

    // 真实场景：Windows 编辑器存的 patch 带 UTF-8 BOM，摘空后同样要删掉文件
    const bomPatch = join(fxProfile, 'bom.patch.yml');
    await writeFile(bomPatch, '\uFEFF# patch\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n');
    await core.removeMountBlock(bomPatch);
    const bomApplied = await core.applyUninstall([{ what: 'mount declaration', path: bomPatch }]);
    check(!(await core.pathExists(bomPatch)) && bomApplied.removedMount === 1,
      'W32: BOM patch deleted after its last entry was removed');

    // W31 语言路由（DSH_UNDO_LANG 显式设置时按该语言取文案）。
    const savedLang = process.env.DSH_UNDO_LANG;
    let routed = null;
    try {
      process.env.DSH_UNDO_LANG = 'en';
      routed = core.getConsentText();
    } finally {
      if (savedLang === undefined) delete process.env.DSH_UNDO_LANG; else process.env.DSH_UNDO_LANG = savedLang;
    }
    check(routed === core.CONSENT_TEXT.en, 'W31: getConsentText follows DSH_UNDO_LANG');
  }

  // W33: 快捷方式防挂起。桌面相关的 powershell 调用都在 win32 正常路径上，
  // 无超时则 powershell 无响应会永久挂住插件加载。
  {
    const coreSrc = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'core.mjs'), 'utf8');
    // 括号配平扫描每个 execFile(...) 调用（选项对象常跨多行，行级正则会误判）
    const calls = [];
    const scanRe = /execFile\s*\(/g;
    let sm;
    while ((sm = scanRe.exec(coreSrc)) !== null) {
      let depth = 0;
      let i = sm.index + sm[0].length - 1;
      let inStr = null;
      for (; i < coreSrc.length; i += 1) {
        const c = coreSrc[i];
        if (inStr) {
          if (c === '\\') { i += 1; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
        if (c === '(') depth += 1;
        else if (c === ')') { depth -= 1; if (depth === 0) break; }
      }
      calls.push(coreSrc.slice(sm.index, i + 1));
    }
    const noTimeout = calls.filter((c) => !/timeout\s*:/.test(c));
    // E29 裁决：快捷方式路径上的四个外部工具调用（win32 ×2 powershell.exe、
    // macOS xattr、Linux gio）都必须有界，任一挂起都会拖住插件加载。
    check(noTimeout.length === 0, `W33: no unbounded execFile call remains (${noTimeout.length} of ${calls.length})`);
    const all = calls.filter((c) => /'powershell\.exe'/.test(c));
    check(all.length === 2 && all.every((c) => /timeout\s*:/.test(c)),
      `W33: both win32 shortcut powershell calls carry a timeout (${all.length} found)`);
    const macLinux = calls.filter((c) => /'(xattr|gio)'/.test(c));
    check(macLinux.length === 2 && macLinux.every((c) => /timeout\s*:/.test(c)),
      `W33: macOS xattr and Linux gio calls are bounded too (${macLinux.length} found)`);
  }

  // W34: doctor 环境预检两项（长路径风险 + Node 能力）。两项都只在条件命中时出现。
  {
    const longHome = 'C:\\' + 'verylongsegment\\'.repeat(16) + 'u';
    const cfgLong = { ...cfgW, homeDir: longHome, profileName: 'web', profileDir: join(longHome, 'profiles', 'web') };
    const repLong = await core.runDoctor(cfgLong, { platform: 'win32', nodeVersion: 'v22.15.0' });
    const lp = repLong.checks.filter((c) => c.code === 'pre-long-path');
    check(lp.length === 1 && lp[0].level === 'warn' && /\d{3} chars/.test(lp[0].detail),
      `W34: long win32 home path warns with the measured length (${lp[0]?.detail ?? 'no check'})`);

    const repShort = await core.runDoctor({ ...cfgW, homeDir: 'C:\\u' }, { platform: 'win32', nodeVersion: 'v22.15.0' });
    check(repShort.checks.filter((c) => c.code === 'pre-long-path').length === 0,
      'W34: short win32 home path stays clean');
    const repLinux = await core.runDoctor(cfgLong, { platform: 'linux', nodeVersion: 'v22.15.0' });
    check(repLinux.checks.filter((c) => c.code === 'pre-long-path').length === 0,
      'W34: non-win32 never reports the long-path check');

    const repOld = await core.runDoctor({ ...cfgW, homeDir: 'C:\\u' }, { nodeVersion: 'v20.11.0' });
    const nc = repOld.checks.filter((c) => c.code === 'pre-node-capability');
    check(nc.length === 1 && /undo_scan/.test(nc[0].detail), 'W34: Node below 22.15 warns about undo_scan');
    const repNew = await core.runDoctor({ ...cfgW, homeDir: 'C:\\u' }, { nodeVersion: 'v22.15.0' });
    check(repNew.checks.filter((c) => c.code === 'pre-node-capability').length === 0,
      'W34: Node at the 22.15 threshold stays clean');
  }

  // W43: 桌面 profile 安装链适配（批次合集 §7）。本块覆盖前三部分：卸载覆盖 desktop
  // profile、桌面端运行中指引、版本读取的防御性静默。第四部分（官方 sanitize 痕迹的检测
  // 与一键恢复）紧随其后独立成块，与本次施工的两个提交一一对应。
  {
    const w43root = join(rootW, 'w43');
    const w43legacy = join(w43root, 'legacy-profile');
    const w43mount = join(w43legacy, 'cordis.patch.yml');
    await mkdir(w43legacy, { recursive: true });
    await writeFile(w43mount, [
      '# legacy patch',
      '- insert:',
      '    - id: dsh-undo-savepoint',
      '      name: dsh-undo-savepoint',
      '',
    ].join('\n'));

    // (1)(2) profile 目录发现：profiles/ 整个不存在时回退当前 profile 目录（旧行为保持）；
    // profiles/ 存在却没有可扫的 profile 目录时不回退，并明确报空目录。两例共用同一个
    // 含挂载声明的 legacy profile 目录，差别只在 home 下有没有 profiles/，断言因此直接落在
    // 「扫了还是没扫」上，而不是落在提示文案上。
    const homeMissing43 = join(w43root, 'home-missing');
    const homeEmpty43 = join(w43root, 'home-empty');
    await mkdir(join(homeEmpty43, 'profiles'), { recursive: true });
    const planOpts43 = { desktopDir: join(w43root, 'desktop'), listLinks: async () => [] };
    const planMissing43 = await core.planUninstall({ ...cfgW, homeDir: homeMissing43, profileDir: w43legacy }, planOpts43);
    const planEmpty43 = await core.planUninstall({ ...cfgW, homeDir: homeEmpty43, profileDir: w43legacy }, planOpts43);
    check(planMissing43.plan.some((x) => x.what === 'mount declaration' && x.path === w43mount),
      'W43: profiles 目录缺失时回退当前 profile 目录，挂载声明仍被扫到');
    check(!planEmpty43.plan.some((x) => x.path === w43mount)
      && planEmpty43.notes.some((n) => n.includes('no profile directory under')),
      `W43: profiles 目录存在但为空时不回退并报空目录（notes=${JSON.stringify(planEmpty43.notes)}）`);

    // (3)(4) 桌面运行探测。命令与参数注入，用假进程列表钉住解析分支，跨平台一致；
    // DSH_UNDO_NO_DESKTOP=1 的短路也在本组钉住。门禁进程全局置了该开关（不碰真实桌面），
    // 因此探测与体检断言都要临时摘掉它再还原。
    const health43 = await import('../lib/health.mjs');
    const probeRun43 = join(w43root, 'probe-running.mjs');
    const probeIdle43 = join(w43root, 'probe-idle.mjs');
    await writeFile(probeRun43, 'console.log(\'"DeepSeek Harness.exe","6972","Console","2","116,004 K"\')\n');
    await writeFile(probeIdle43, 'console.log("INFO: No tasks are running which match the specified criteria.")\n');
    const probe43 = (script) => ({ platform: 'win32', desktopProbeCommand: process.execPath, desktopProbeArgs: [script] });
    const withProbe43 = async (fn) => {
      const saved = process.env.DSH_UNDO_NO_DESKTOP;
      delete process.env.DSH_UNDO_NO_DESKTOP;
      try { return await fn(); } finally {
        if (saved === undefined) delete process.env.DSH_UNDO_NO_DESKTOP; else process.env.DSH_UNDO_NO_DESKTOP = saved;
      }
    };
    const st43 = await withProbe43(async () => ([
      await health43.desktopProcessState(probe43(probeRun43)),
      await health43.desktopProcessState(probe43(probeIdle43)),
    ]));
    const savedNoDesktop43 = process.env.DSH_UNDO_NO_DESKTOP;
    process.env.DSH_UNDO_NO_DESKTOP = '1';
    let st43short = null;
    try { st43short = await health43.desktopProcessState(probe43(probeRun43)); }
    finally { if (savedNoDesktop43 === undefined) delete process.env.DSH_UNDO_NO_DESKTOP; else process.env.DSH_UNDO_NO_DESKTOP = savedNoDesktop43; }
    check(st43[0] === 'running' && st43[1] === 'not-running' && st43short === 'not-running',
      `W43: 桌面探测三态与 NO_DESKTOP 短路实得 running/${st43[1]}/${st43short}，期望 running/not-running/not-running`);
    const st43unknown = await withProbe43(() => health43.desktopProcessState(
      { platform: 'win32', desktopProbeCommand: join(w43root, 'no-such-probe-binary'), desktopProbeArgs: [] }));
    check(st43unknown === 'unknown', `W43: 命令不存在时探测记 unknown 且不外抛（实得 ${st43unknown}）`);

    // (5) running 态下体检带桌面端指引，文案同时命中「完全退出」与进程名；未运行与探测失败
    // 都不产出该检查项。门禁固定英文输出，中文口径直接查词典，两种语言都钉住。
    const i18n43 = await import('../lib/i18n.mjs');
    const zhText43 = i18n43.t('doctor.desktopRunning', undefined, 'zh');
    const w43home2 = join(w43root, 'home-desktop');
    await mkdir(join(w43home2, 'profiles', 'desktop'), { recursive: true });
    await writeFile(join(w43home2, 'profiles', 'desktop', 'package.json'), '{"name":"desktop-profile"}\n');
    const cfg43 = { ...cfgW, homeDir: w43home2, profileName: 'desktop', profileDir: join(w43home2, 'profiles', 'desktop') };
    const hit43 = await withProbe43(async () => (await core.runDoctor(cfg43, probe43(probeRun43)))
      .checks.filter((c) => c.code === 'pre-desktop-running'));
    const quiet43 = await withProbe43(async () => ([
      await core.runDoctor(cfg43, probe43(probeIdle43)),
      await core.runDoctor(cfg43, { platform: 'win32', desktopProbeCommand: join(w43root, 'no-such-probe-binary'), desktopProbeArgs: [] }),
    ]));
    check(hit43.length === 1 && hit43[0].level === 'warn'
      && hit43[0].detail.includes('DeepSeek Harness') && hit43[0].detail.includes('completely')
      && zhText43.includes('完全退出') && zhText43.includes('DeepSeek Harness')
      && quiet43.every((r) => r.checks.filter((c) => c.code === 'pre-desktop-running').length === 0),
      `W43: 运行中给出「完全退出」指引、未运行与探测失败都不报（${hit43[0]?.detail ?? 'no check'}）`);

    // (6) W43 决策点 3：版本读取保持原样，取不到版本时静默为 null 且不误报升级。
    let v43 = null;
    let threw43 = null;
    try { v43 = await core.readDshVersion(); } catch (e) { threw43 = e; }
    const g43 = await core.dshVersionGuard({ ...cfgW, autoDir: join(w43root, 'version-auto'), homeDir: homeMissing43 });
    check(threw43 === null && (v43 === null || typeof v43 === 'string') && g43.current === v43 && g43.changed === false,
      `W43: 版本读取静默不抛错（${JSON.stringify(v43)}），无历史状态时不误报升级`);

    // (7) 部分 4：官方 sanitize 痕迹的检出。三要素（备份存在、补丁里没有本插件、bundles 里
    // 也没有本插件）齐全才报，各自缺一都不报；命中时报最新那份备份。这里不放开
    // DSH_UNDO_NO_DESKTOP，桌面探测走短路，验收只钉 sanitize 这一段，不受本机是否真开着
    // 桌面端影响。
    const sanPatch43 = '- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n';
    const sanBank43 = '# official sanitize left this file behind\n[]\n';
    const zhFix43 = i18n43.t('doctor.sanitizeTraceFix', { backup: 'BACKUP' }, 'zh');
    const mkSan43 = async (tag, { patch, bundles, backups }) => {
      const h = join(w43root, `home-san43-${tag}`);
      const d = join(h, 'profiles', 'desktop');
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'cordis.patch.yml'), patch);
      await writeFile(join(d, 'package.json'),
        `{"name":"desktop-profile","dsh":{"profile":{"bundles":${JSON.stringify(bundles)}}}}\n`);
      for (const [i, b] of (backups ?? []).entries()) {
        await writeFile(join(d, `cordis.patch.yml.bak-${b}`), i === 0 ? sanBank43 : sanPatch43);
      }
      return { home: h, dir: d, cfg: { ...cfgW, homeDir: h, profileName: 'desktop', profileDir: d } };
    };
    const trace43 = async (cfg) => (await core.runDoctor(cfg)).checks.filter((c) => c.code === 'pre-sanitize-trace');
    const sanFull43 = await mkSan43('full', { patch: '[]\n', bundles: ['@deepseek-ai/dsh-base'], backups: ['20261001-100000', '20261003-093000'] });
    const sanPatchKeep43 = await mkSan43('patch-keeps', { patch: sanPatch43, bundles: ['@deepseek-ai/dsh-base'], backups: ['20261001-100000'] });
    const sanBundlesKeep43 = await mkSan43('bundles-keep', { patch: '[]\n', bundles: ['@deepseek-ai/dsh-base', 'dsh-undo-savepoint'], backups: ['20261001-100000'] });
    const sanNoBackup43 = await mkSan43('no-backup', { patch: '[]\n', bundles: ['@deepseek-ai/dsh-base'], backups: [] });
    const hitSan43 = await trace43(sanFull43.cfg);
    const negSan43 = [
      await trace43(sanPatchKeep43.cfg),
      await trace43(sanBundlesKeep43.cfg),
      await trace43(sanNoBackup43.cfg),
    ];
    check(hitSan43.length === 1 && hitSan43[0].level === 'warn' && hitSan43[0].fixable === true
      && hitSan43[0].detail.includes('20261003-093000') && !hitSan43[0].detail.includes('20261001-100000')
      && hitSan43[0].fix.includes('doctor -Fix') && zhFix43.includes('装回来')
      && negSan43.every((r) => r.length === 0),
      `W43: sanitize 痕迹三要素齐全才报、缺一不报，命中最新的那份备份（命中 ${hitSan43.length} 条，三条缺一各自 ${negSan43.map((r) => r.length).join('/')} 条）`);

    // (8) 部分 4：一键恢复。补丁被最新备份覆盖、插件写回 dsh.profile.bundles 且原有宿主
    // bundle 不丢、当前补丁先留 .dsh-undo-bak、恢复后复检不再命中。
    const fixSan43 = await core.runDoctorFix(sanFull43.cfg);
    const afterSan43 = await readFile(join(sanFull43.dir, 'cordis.patch.yml'), 'utf8');
    const pkgSan43 = JSON.parse(await readFile(join(sanFull43.dir, 'package.json'), 'utf8'));
    let bakSan43 = null;
    try { bakSan43 = await readFile(join(sanFull43.dir, 'cordis.patch.yml.dsh-undo-bak'), 'utf8'); } catch { /* 缺备份时下面判失败 */ }
    const recheckSan43 = await trace43(sanFull43.cfg);
    const bundlesSan43 = pkgSan43?.dsh?.profile?.bundles ?? [];
    check(fixSan43.applied.some((a) => a.code === 'pre-sanitize-trace' && a.ok === true)
      && afterSan43 === sanPatch43 && bakSan43 === '[]\n'
      && bundlesSan43.includes('dsh-undo-savepoint') && bundlesSan43.includes('@deepseek-ai/dsh-base')
      && recheckSan43.length === 0,
      `W43: sanitize 恢复把补丁换成最新备份、插件写回 bundles 且复检干净（applied=${fixSan43.applied.filter((a) => a.code === 'pre-sanitize-trace').length}，复检 ${recheckSan43.length} 条）`);
  }

  // W50: 部分 sanitize（第二检出面）——bundles 已恢复、补丁内容却缺条目。
  // W43-4 的三要素要求补丁与 bundles 都没有本插件，官方恢复弹窗的另一处落点不满足：
  // 插件在、配置静默消失。这里按条目名级比对最新备份与当前补丁，钉检出四条件、分级、
  // 条目级搬回与幂等。
  {
    const { utimes } = await import('node:fs/promises');
    const health50 = await import('../lib/health.mjs');
    const { t: t50 } = await import('../lib/i18n.mjs');
    const NL = String.fromCharCode(10);
    // 夹具文本一律用行数组拼：本文件里写字面量反斜杠 n 转义，经工具链往返会被吃成真换行。
    const L = (...rows) => rows.join(NL) + NL;
    const w50root = join(rootW, 'w50');
    const BAK50 = 'cordis.patch.yml.bak-1790834455722';
    // 备份侧：2 个顶层键 + 2 条 insert 条目。insert 下故意放注释行与「config 更深缩进 +
    // 第二条同缩进兄弟条目」，这两种形态正是 splitItems 会判错、W50 自建缩进树的存在理由。
    const BAK50_TEXT = L(
      '- id: ui-settings-general',
      '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
      '  config:',
      '    welcomeNoticeVersion: 2026-08-13.1',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-flash',
      '- insert:',
      '    # 法律检索 MCP',
      '    - id: mcp-chinese-law',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: chinese_law',
      '    - id: mcp-chinese-law-ansvar',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: chinese_law_ansvar',
      '- id: ui-chat',
      '  name: "@deepseek-ai/dsh-client-ui-chat"',
      '  config:',
      '    transcriptView: standard',
    );
    // 当前侧：含官方 sanitize 之后桌面端新写的 agent-preset-registry（整文件覆盖会二次伤害），
    // 挂载块收在末尾。
    const CUR50_BODY = L(
      '- id: ui-chat',
      '  name: "@deepseek-ai/dsh-client-ui-chat"',
      '  config:',
      '    transcriptView: standard',
      '- id: agent-preset-registry',
      '  name: "@deepseek-ai/dsh-agent-preset-registry"',
      '  config:',
      '    default: standard',
    );
    const TAIL50 = L('', '# dsh-undo-savepoint mount (managed)', '- insert:', '    - id: dsh-undo-savepoint');
    const BAK50_CFGONLY = L(
      '- id: ui-settings-general',
      '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '- id: ui-chat',
      '  name: "@deepseek-ai/dsh-client-ui-chat"',
    );
    const mk50 = async (tag, {
      backup = BAK50_TEXT, cur = BAK50_TEXT + CUR50_BODY,
      bundles = ['@deepseek-ai/dsh-base', 'dsh-undo-savepoint'], ageBak = 0, patchOlder = false,
    } = {}) => {
      const h = join(w50root, `home-${tag}`);
      const d = join(h, 'profiles', 'desktop');   // 末级名必须 desktop，桌面判定按目录末级名（E83）
      await mkdir(d, { recursive: true });
      // 官方动作序列必然是「先备份后重建」：写文件顺序即 mtime 顺序（先 bak 后 patch）。
      if (backup !== null) await writeFile(join(d, BAK50), backup);
      await writeFile(join(d, 'cordis.patch.yml'), cur);
      await writeFile(join(d, 'package.json'),
        `{"name":"desktop-profile","dsh":{"profile":{"bundles":${JSON.stringify(bundles)}}}}${NL}`);
      const now = Math.floor(Date.now() / 1000);
      if (backup !== null && ageBak) {
        await utimes(join(d, BAK50), now + ageBak, now + ageBak);      // 正数 = 备份更新（倒挂）
      } else if (backup !== null && patchOlder) {
        await utimes(join(d, BAK50), now - 20, now - 20);
        await utimes(join(d, 'cordis.patch.yml'), now - 10, now - 10);
      }
      return { home: h, dir: d, cfg: { ...cfgW, profileName: 'desktop', homeDir: h, profileDir: d } };
    };
    const codes50 = (report) => report.checks.filter((c) => c.code === 'pre-partial-sanitize');

    // (1) 正例：备份四条齐全、当前补丁缺这四条 ⇒ warn 且 fixable，缺失清单逐名列出。
    const f50 = await mk50('full', { cur: CUR50_BODY + TAIL50, patchOlder: true });
    const hit50 = codes50(await core.runDoctor(f50.cfg));
    check(hit50.length === 1 && hit50[0].level === 'warn' && hit50[0].fixable === true,
      `W50: 补丁内容缺失命中 warn 且 fixable（命中 ${hit50.length} 条${hit50[0] ? '，level=' + hit50[0].level : ''}）`);
    const names50 = 'mcp-chinese-law, mcp-chinese-law-ansvar, agent-default-model, ui-settings-general';
    check(hit50.length === 1
      && hit50[0].detail === t50('doctor.partialSanitize', { backup: BAK50, names: names50 })
      && hit50[0].fix === t50('doctor.partialSanitizeFix', {})
      && hit50[0].detail.includes(BAK50)
      && ['ui-settings-general', 'agent-default-model', 'mcp-chinese-law', 'mcp-chinese-law-ansvar']
        .every((n) => hit50[0].detail.includes(n)),
      'W50: 缺失清单逐名列出（四段全在场），详情与修复帮助都走 i18n 键');
    // i18n 双语：三条键的必备信息在两份词典里都在（zh 三句为题面原文逐字）。
    check(t50('doctor.partialSanitize', { backup: 'B', names: 'N' }, 'zh').includes('若这是你自己删的')
      && t50('doctor.partialSanitizeFix', {}, 'zh').includes('这不是对那次选择的自动回退')
      && t50('doctor.partialSanitizeInfo', {}, 'zh').includes('低置信提示'),
      'W50: i18n 三条 zh 键含题面要求的免责句、非自动回退句与低置信提示');
    check(t50('doctor.partialSanitize', { backup: 'B', names: 'N' }, 'en').includes('If you deleted these yourself')
      && t50('doctor.partialSanitizeFix', {}, 'en').includes('not an automatic rollback')
      && t50('doctor.partialSanitizeInfo', {}, 'en').includes('low-confidence'),
      'W50: i18n 三条 en 键信息量对等');

    // (2) fix：条目级搬回。当前补丁已有的条目逐字不动，只追加缺失的四条。
    const before50 = await readFile(join(f50.dir, 'cordis.patch.yml'), 'utf8');
    const fix50 = await core.runDoctorFix(f50.cfg);
    const after50 = await readFile(join(f50.dir, 'cordis.patch.yml'), 'utf8');
    const bak50 = await readFile(join(f50.dir, 'cordis.patch.yml.dsh-undo-bak'), 'utf8');
    check(bak50 === before50, 'W50: .dsh-undo-bak 内容为恢复前原文（逐字节）');
    check(after50.includes('- id: ui-settings-general' + NL + '  name: "@deepseek-ai/dsh-client-ui-settings-general"')
      && after50.includes('- id: agent-default-model' + NL + '  name: "@deepseek-ai/dsh-agent-default-model"'),
      'W50: 两个缺失顶层键的完整文本块回到当前补丁');
    check(after50.includes('    - id: mcp-chinese-law' + NL + "      name: '@deepseek-ai/dsh-mcp-client'")
      && after50.includes('    - id: mcp-chinese-law-ansvar' + NL + "      name: '@deepseek-ai/dsh-mcp-client'"),
      'W50: 两条缺失 insert 条目连同内部 config 缩进回到当前补丁');
    check(after50.indexOf('- id: ui-settings-general' + NL) < after50.indexOf('- id: agent-default-model' + NL)
      && after50.indexOf('- id: mcp-chinese-law' + NL) < after50.indexOf('- id: mcp-chinese-law-ansvar' + NL),
      'W50: 搬回条目保持备份内的原相对顺序（顶层键与 insert 各自成序）');
    check(after50.includes('- id: agent-preset-registry' + NL + '  name: "@deepseek-ai/dsh-agent-preset-registry"')
      && after50.includes('- id: ui-chat' + NL + '  name: "@deepseek-ai/dsh-client-ui-chat"'),
      'W50: 当前补丁原有条目（含当前独有键）逐字不动');
    check(after50.indexOf('dsh-undo-savepoint mount') > after50.indexOf('- id: agent-preset-registry'),
      'W50: 新条目插在挂载块之前，挂载块仍在末尾');
    check(fix50.applied.some((a) => a.code === 'pre-partial-sanitize' && a.ok === true
      && /moved 4 missing entries/.test(a.action)),
      `W50: 记账写明搬回 4 条（${fix50.applied.find((a) => a.code === 'pre-partial-sanitize')?.action ?? '无'})`);
    check(fix50.snapshotId !== null && codes50(fix50.report).length === 0,
      'W50: 修前快照存在（doctor-fix-before）且复检不再命中');
    check(codes50(await core.runDoctor(f50.cfg)).length === 0 && core.findDanglingInserts(after50).length === 0,
      'W50: 恢复后复检干净且无悬空 insert 键');
    const fix50b = await core.runDoctorFix(f50.cfg);
    check(!fix50b.applied.some((a) => a.code === 'pre-partial-sanitize')
      && (await readFile(join(f50.dir, 'cordis.patch.yml'), 'utf8')) === after50,
      'W50: 连续两次 fix，第二次为 no-op（差集已空不再搬，幂等）');

    // (3) 负例：同目录没有 bak，无从比对。
    const f50NoBak = await mk50('nobak', { backup: null });
    check(codes50(await core.runDoctor(f50NoBak.cfg)).length === 0, 'W50: 无备份不报');

    // (4) 负例：差集为空（当前补丁为备份超集，用户已手工加回来）。
    const f50Super = await mk50('superset', { cur: BAK50_TEXT + CUR50_BODY + TAIL50, patchOlder: true });
    check(codes50(await core.runDoctor(f50Super.cfg)).length === 0, 'W50: 当前补丁是备份超集（差集为空）不报');

    // (5) 负例：bak mtime 晚于当前补丁（时间倒挂，用户自己拖出来的备份形态）。
    const f50Inv = await mk50('inverted', { ageBak: 600 });
    check(codes50(await core.runDoctor(f50Inv.cfg)).length === 0,
      'W50: 备份 mtime 晚于当前补丁（倒挂）不报');

    // (6) 分级：只有顶层键差异、无 insert 差异 ⇒ info 且不带 fixable。
    const f50CfgOnly = await mk50('cfgonly', { backup: BAK50_CFGONLY, cur: CUR50_BODY + TAIL50, patchOlder: true });
    const hit50Cfg = codes50(await core.runDoctor(f50CfgOnly.cfg));
    check(hit50Cfg.length === 1 && hit50Cfg[0].level === 'info' && hit50Cfg[0].fixable === undefined,
      `W50: 仅顶层键差异降为 info 且无 fixable（实得 ${hit50Cfg.length} 条${hit50Cfg[0] ? '，level=' + hit50Cfg[0].level : ''}）`);
    check(hit50Cfg[0]?.detail.includes('agent-default-model') && !hit50Cfg[0]?.detail.includes('mcp-chinese-law'),
      'W50: info 只列顶层键、不列 insert 条目');

    // (7) 负例：同键名不同值（用户 sanitize 后自己重配过，是合法状态）。
    const cur50Valued = (BAK50_TEXT + CUR50_BODY)
      .replace('welcomeNoticeVersion: 2026-08-13.1', 'welcomeNoticeVersion: 2099-01-01.1') + TAIL50;
    const f50Same = await mk50('samekey', { cur: cur50Valued, patchOlder: true });
    check(codes50(await core.runDoctor(f50Same.cfg)).length === 0, 'W50: 同键名不同值不报');

    // (8) mtime 相同（同秒，官方动作序列的正常态）视为不倒挂，照常判。
    const f50SameSec = await mk50('samesec', { cur: CUR50_BODY + TAIL50 });
    const now50 = Math.floor(Date.now() / 1000);
    await utimes(join(f50SameSec.dir, BAK50), now50 - 10, now50 - 10);
    await utimes(join(f50SameSec.dir, 'cordis.patch.yml'), now50 - 10, now50 - 10);
    const hit50SameSec = codes50(await core.runDoctor(f50SameSec.cfg));
    check(hit50SameSec.length === 1 && hit50SameSec[0].level === 'warn',
      'W50: 备份与当前补丁 mtime 相同（同秒）照常判');

    // (9) 多份 bak 时取字典序最新（13 位毫秒串，字典序即时序）参与比对。
    const f50Multi = await mk50('multi', { cur: CUR50_BODY + TAIL50 });
    const older50 = 'cordis.patch.yml.bak-1790834455721';
    await writeFile(join(f50Multi.dir, older50), BAK50_TEXT);
    await utimes(join(f50Multi.dir, BAK50), now50 - 20, now50 - 20);
    await utimes(join(f50Multi.dir, older50), now50 - 30, now50 - 30);
    await utimes(join(f50Multi.dir, 'cordis.patch.yml'), now50 - 10, now50 - 10);
    const hit50Multi = codes50(await core.runDoctor(f50Multi.cfg));
    check(hit50Multi.length === 1 && hit50Multi[0].detail.includes(BAK50)
      && !hit50Multi[0].detail.includes('1790834455721'),
      'W50: 多份备份时取字典序最新的那份参与比对');

    // (10) 纯函数：条目名级提取分两档、缩进树搬回、差集空时原文逐字返回。
    const ids50 = health50.collectPatchEntryIds(BAK50_TEXT);
    check(JSON.stringify(ids50.topKeys) === JSON.stringify(['ui-settings-general', 'agent-default-model', 'ui-chat'])
      && JSON.stringify(ids50.insertIds) === JSON.stringify(['mcp-chinese-law', 'mcp-chinese-law-ansvar']),
      `W50: 条目名提取分顶层键与 insert 两档且不串档（顶层 ${ids50.topKeys.length} 项、insert ${ids50.insertIds.length} 项）`);
    const cur50Pure = L('- id: keep-me', '  name: x') + TAIL50;
    const bak50Pure = L('- id: keep-me', '  name: x', '- id: lost-key', '  name: y',
      '- insert:', '    - id: lost-ins', '      name: z');
    const merge50 = health50.mergePatchEntries(cur50Pure, bak50Pure);
    check(merge50.moved === 2 && merge50.text.includes('- id: lost-key' + NL + '  name: y')
      && merge50.text.includes('    - id: lost-ins' + NL + '      name: z'),
      `W50: 纯函数搬回 2 条且缩进正确（实得 moved=${merge50.moved}）`);
    const rows50 = merge50.text.split(NL);
    check(rows50.findIndex((l) => l === '- id: lost-key') < rows50.findIndex((l) => /dsh-undo-savepoint mount/.test(l)),
      'W50: 纯函数把新增顶层条目插在挂载块之前');
    const noop50 = health50.mergePatchEntries(cur50Pure, L('- id: keep-me', '  name: x'));
    check(noop50.moved === 0 && noop50.text === cur50Pure, 'W50: 纯函数在差集为空时原文逐字返回');
  }

  // W09: 会话普查——浅层计数 + 零字节异常 + 深层结构分类
  {
    const sessDir = join(homeW, 'sessions', 'census-test');
    await mkdir(sessDir, { recursive: true });
    await writeFile(join(sessDir, 'session.jsonl.zstd'), '');
    const c = await core.sessionCensus(cfgW);
    check(c.total >= 1, 'W09: census counts the planted session');
    check(c.anomalous.some((a) => a.reason === 'zero-byte session log'),
      'W09: zero-byte session log flagged anomalous');
    const cd = await core.sessionCensus(cfgW, { deep: true });
    if (cd.deep) {
      check(cd.deep.corrupt >= 1, 'W09: deep classifies the empty log corrupt');
    } else {
      check(true, 'W09: deep scan skipped (no zstd API on this Node)');
    }
  }

  // W10: 磁盘占用——体积必须真的累加到内容上，剩余空间可取或按可缺省为 null
  {
    const probeDir = join(homeW, 'sessions', 'usage-probe');
    await mkdir(probeDir, { recursive: true });
    await writeFile(join(probeDir, 'session.jsonl.zstd'), 'x'.repeat(4096));
    const d = await core.diskUsage(cfgW);
    check(typeof d.storeBytes === 'number' && d.storeBytes >= 0,
      'W10: storeBytes is a non-negative number');
    check(d.sessionsBytes >= 4096, `W10: sessionsBytes counts planted content (${d.sessionsBytes})`);
    check(d.freeBytes === null || (typeof d.freeBytes === 'number' && d.freeBytes >= 0),
      'W10: freeBytes is a non-negative number or null');
  }

  // W11: 补丁状态聚合——任何环境下都返回结构化结果（含错误分支）
  {
    const p = await core.patchStatus(cfgW);
    check(typeof p.ok === 'boolean' && typeof p.missing === 'number', 'W11: patchStatus returns structured result');
    check(typeof p.reason === 'string' && p.reason.length > 0, 'W11: patchStatus always carries a reason');
  }

  // W12: 体检聚合——四维报告 + 告警规则。空仓库断言改用独立空配置（前提修正：
  // cfgW 在 W03 段已建过快照，且 listSnapshots 还会扫 LEGACY_ROOT）。
  {
    const emptyRoot = join(rootW, 'w12-empty');
    const emptyCfg = { ...cfgW, homeDir: join(emptyRoot, 'home'), profileDir: join(emptyRoot, 'profile'), manualDir: join(emptyRoot, 'manual'), autoDir: join(emptyRoot, 'auto') };
    const h = await core.healthCheck(cfgW);
    check(typeof h.ts === 'string' && typeof h.sessions.total === 'number' && typeof h.snapshots.total === 'number' && Array.isArray(h.findings),
      'W12: healthCheck returns the four-dimension report');
    const he = await core.healthCheck(emptyCfg);
    check(he.snapshots.total === 0 && he.findings.some((f) => f.code === 'snapshot-none'),
      'W12: empty store triggers snapshot-none finding');
    check(h.findings.length > 0 && h.findings.every((f) => ['warn', 'err'].includes(f.level) && f.detail.length > 0), 'W12: findings well-formed');
  }

  // W18: 升级检测状态机——首次只记录，版本变化才算升级，探测失败静默 null
  {
    const v = await core.readDshVersion();
    check(v === null || typeof v === 'string', 'W18: readDshVersion returns string or null');
    const g1 = await core.dshVersionGuard(cfgW);
    check(g1.changed === false, 'W18: first run records without upgrade event');
    await core.persistVersionState(cfgW, g1.state);
    const g2 = await core.dshVersionGuard(cfgW);
    check(g2.changed === false && g2.previous === null, 'W18: same version re-run is not an upgrade');
  }

  // W30: 崩溃自愈——bootFailStreak 持久化语义（writeBootState 携带、readBootState 读回）
  {
    await core.writeBootState(cfgW, { startedAt: 'x', pid: 1, ok: false, crashReason: null, bootFailStreak: 2 });
    const bs = await core.readBootState(cfgW);
    check(bs?.bootFailStreak === 2, 'W30: bootFailStreak round-trips through boot-state.json');
  }

  // W28: 启动守卫——透传启动（非 TTY + off）、--check 退出码、参数校验
  {
    const repoRootW = () => fileURLToPath(new URL('..', import.meta.url));
    const { execFile } = await import('node:child_process');
    const run = (args) => new Promise((resolve) => {
      execFile(process.execPath, [join(repoRootW(), 'tools', 'guard.mjs'), ...args], { env: { ...process.env, DSH_UNDO_SETTINGS: cfgW.settingsFile, DSH_UNDO_ROOT: join(rootW, 'undo-snapshots'), DSH_HOME: homeW } }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout: String(stdout) }));
    });
    const passthrough = await run(['--safe-mode', 'off', '--', process.execPath, '-e', "console.log('guarded-ok')"]);
    check(passthrough.code === 0 && passthrough.stdout.includes('guarded-ok'), 'W28: guard passes through the guarded command');
    const chk = await run(['--check']);
    check(chk.stdout.includes('guard: --check 结束'), 'W28: --check mode reports and exits');
    const bad = await run(['--safe-mode', 'wat']);
    check(bad.code === 2, 'W28: invalid --safe-mode value rejected with code 2');
  }

  // W29: 守卫快捷方式计划——三平台形态与默认跳过
  {
    const pWin = core.guardShortcutPlan({ platform: 'win32', desktopDir: 'C:\\Users\\t\\Desktop', pluginRoot: repoRoot });
    check(pWin.kind === 'lnk' && pWin.target.endsWith('launch-dsh-guard.bat'), 'W29: win32 guard shortcut targets the bat');
    const skip = await core.ensureGuardShortcut({ guardShortcutEnabled: false });
    check(skip.action === 'skipped', 'W29: guard shortcut skipped by default');
  }
}

// ── W49：脱敏清单扩充（issue #39 SEC）────────────────────────────────────────
// 反向敏感：本块断言在改动前全线变红。改动前 .yml 不在 SENSITIVE_DESTS 里，
// profile-cordis.patch.yml 会被 copyFile 明文入库；路由只认 .yaml，.yml 会落到
// env 脱敏器；守卫二只拦 .yaml，.yml 的占位符候选会被写回活文件。
console.log('== W49. #39 expanded redaction list + .yml routing + guard two + cleanup tool ==');
{
  const core = await import('../lib/core.mjs');
  const R = '***REDACTED***';
  // (1) 清单七项，且三项新名字与 destName 产出逐字相同（findSpec 非空即拼写正确）
  check(core.SENSITIVE_DESTS.size === 7, `W49: SENSITIVE_DESTS 扩到七项（实为 ${core.SENSITIVE_DESTS.size}）`);
  check(
    core.findSpec('home-cordis.patch.yml') && core.findSpec('profile-cordis.patch.yml') && core.findSpec('profile-cordis.yml'),
    'W49: 三个新增目标名与 destName 产出逐字相同（findSpec 非空）',
  );
  // (2) .yml 与 .yaml 同路（都走 YAML 脱敏），.env 仍走 env 脱敏器
  const yml = 'mcp:\n  headers:\n    Authorization: Bearer sk-w49-live\n';
  check(core.redactByDest('profile-x.yml', yml) === core.redactYamlContent(yml), 'W49: .yml 走 YAML 脱敏（与 redactYamlContent 逐字节相同）');
  check(core.isYamlDest('a.yml') && core.isYamlDest('a.yaml') && !core.isYamlDest('home-.env'), 'W49: isYamlDest 认 .yml 与 .yaml，不认 .env');

  // 共享夹具：一份带 MCP 令牌的活补丁层文件
  const w49root = await mkdtemp(join(tmpdir(), 'dsh-undo-test49-'));
  const home49 = join(w49root, 'home'), profile49 = join(w49root, 'profile'), snap49 = join(w49root, 'snaps');
  await mkdir(home49, { recursive: true }); await mkdir(profile49, { recursive: true });
  const liveYml49 = '# patch layer\n- insert:\n    - id: mcp\n      config:\n        headers:\n          Authorization: Bearer sk-w49-live\n12345 sk-w49-unmatch\nsecret: sk-w49-bare\n';
  await writeFile(join(profile49, 'cordis.patch.yml'), liveYml49);
  const tools49 = new Map();
  const ctx49 = {
    tools: { register: (t) => { tools49.set(t.name, t); return () => { }; } },
    systemPrompt: { section: () => () => { } }, get: () => undefined,
    effect: (fn) => { const d = fn(); return d ?? (() => { }); }, logger: { info: () => { }, warn: () => { } },
  };
  apply(ctx49, { manualDir: join(snap49, 'manual'), autoDir: join(snap49, 'auto'), homeDir: home49, profileDir: profile49, watch: false, pluginDirs: [] });
  await new Promise((r) => setTimeout(r, 300));
  const run49 = async (name, args) => (await tools49.get(name).execute(args, {}));
  const vault49 = join(snap49, 'auto', 'env-vault');
  const dirByReason49 = async (reason) => {
    for (const d of (await readdir(join(snap49, 'manual'))).filter((x) => x !== '.booting')) {
      try {
        const m = JSON.parse(await readFile(join(snap49, 'manual', d, 'manifest.json'), 'utf8'));
        if (m.reason === reason) return d;
      } catch { /* 目录刚建、清单未落 */ }
    }
    return null;
  };
  const manifest49 = async (d) => JSON.parse(await readFile(join(snap49, 'manual', d, 'manifest.json'), 'utf8'));

  // (3) vault 真值恢复：快照内替换成脱敏副本，明文必须在 vault 里且 ref 写进 manifest；
  //     同一内容跨快照跨 dest 按内容 sha 去重，.yml 与 .yaml 各占自己的 manifest 键。
  await run49('undo_snapshot', { reason: 'w49-vault' });
  const dir49 = await dirByReason49('w49-vault');
  const m49 = await manifest49(dir49);
  const ymlInSnap49 = await readFile(join(snap49, 'manual', dir49, 'profile-cordis.patch.yml'), 'utf8');
  check(ymlInSnap49.includes(R) && !ymlInSnap49.includes('sk-w49-live'), 'W49: 快照内 .yml 被脱敏（令牌不入快照）');
  check(!ymlInSnap49.includes('sk-w49-unmatch') && ymlInSnap49.includes(R) && !ymlInSnap49.includes('sk-w49-live'), 'W49 边界修正：无法识别的裸行仍整行丢弃（放行口未放宽）');
  check(!!m49.envVaultRefs['profile-cordis.patch.yml'], 'W49: manifest 的 envVaultRefs 含 .yml 目标名');
  check(
    (await readFile(join(vault49, `${core.sha1Hex(Buffer.from(liveYml49))}.env`), 'utf8')) === liveYml49,
    'W49: vault 按内容 sha 存原件，逐字节可恢复',
  );
  // 边界修正：删一行可能触发数据损坏，改动后必须在这儿钉死两个面。
  //   面一：裸的空流式标记（`[]` / `{}`）是合法空文档，且对补丁层与 profile 根文件是语义必要行，
  //         脱敏后必须原样保留，不得被「无法识别的裸行整行丢弃」吞掉。
  //   面二：其余裸行处理策略不变，无法识别的仍整行丢弃，列表项仍走脱敏折叠。
  check(core.redactYamlContent('# patch layer\n[]\n') === '# patch layer\n[]\n', 'W49 边界修正：裸 [] 不再被脱敏器吞掉');
  check(core.redactYamlContent('a: 1\n{}\n') === 'a: "***REDACTED***"\n{}\n', 'W49 边界修正：裸 {} 不再被脱敏器吞掉');
  check(core.redactYamlContent('[]\n12345 sk-live-inline\n') === '[]\n', 'W49 边界修正：无法识别的裸行仍整行丢弃（放行口未放宽）');
  check(core.redactYamlContent('[]\n- sk-live-inline\n') === '[]\n- "***REDACTED***"\n', 'W49 边界修正：列表项裸行仍走脱敏折叠，未被放行');
  check((await readFile(join(profile49, 'cordis.patch.yml'), 'utf8')) === liveYml49, 'W49: 采集不改活文件（脱敏只作用于快照副本）');

  // (4) 守卫二认 .yml（本工单唯一能损坏数据的路径，必须单独钉住）。
  //     先给 .yml 一个指向占位符 vault 条目的 ref，走 guard-two 的 vault 分支；
  //     再手工改 manifest 抹掉 ref 退回快照副本，走 no-ref 分支。
  //     断言口径：restore 收尾会「再确保挂载」往活文件追加挂载块，故不能断全等，
  //     改断「还原前内容被保留为前缀」+「占位符未被写入」。
  const snapYml49 = join(snap49, 'manual', dir49, 'profile-cordis.patch.yml');
  const pre49 = '# patch layer\npre-restore-49\n';
  await writeFile(join(profile49, 'cordis.patch.yml'), pre49);
  const phSha49 = core.sha1Hex(Buffer.from(`${R}\n`));
  await mkdir(vault49, { recursive: true });
  await writeFile(join(vault49, `${phSha49}.env`), `${R}\n`);
  await writeFile(join(profile49, '.env'), 'API_KEY=live-49\n');
  await run49('undo_snapshot', { reason: 'w49-guard2a' });
  const snapB49 = await dirByReason49('w49-guard2a');
  const mB49 = await manifest49(snapB49);
  mB49.envVaultRefs['profile-cordis.patch.yml'] = phSha49;
  await writeFile(join(snap49, 'manual', snapB49, 'manifest.json'), JSON.stringify(mB49));
  await writeFile(join(profile49, 'cordis.patch.yml'), pre49);
  const outB49 = await run49('undo_restore', { mode: 'id', snapshot_id: snapB49 });
  const liveB49 = await readFile(join(profile49, 'cordis.patch.yml'), 'utf8');
  check(
    liveB49.startsWith(pre49) && !liveB49.includes(R),
    'W49 守卫二：vault 条目为占位符时 .yml 拒写（活文件未被占位符覆盖）',
  );
  check(liveB49.includes('dsh-undo-savepoint mount'), 'W49 守卫二：挂载块仍被再确保（拒写不破坏挂载）');
  check(String(outB49).includes('Skipped') && String(outB49).includes('file skipped to keep the live file intact'), 'W49 守卫二：.yml 拒写在工具输出里明示（file skipped）');

  // (5) 守卫二反向敏感钉：手工造一份「无 ref 的老快照」（脱敏副本无 vault ref）。
  //     同一份 restore 里 .env（清单第三项）仍按文档化降级写占位符，.yml 必须被拦。
  const snapC49 = join(snap49, 'manual', 'w49-legacy-fixed');
  await mkdir(snapC49, { recursive: true });
  await writeFile(join(snapC49, 'profile-cordis.patch.yml'), ymlInSnap49);
  await writeFile(join(snapC49, 'home-.env'), `API_KEY=${R}\n`);
  await writeFile(join(snapC49, 'manifest.json'), JSON.stringify({
    id: 'w49-legacy-fixed', time: new Date().toISOString(), kind: 'manual', reason: 'w49-legacy',
    files: [{ name: 'profile-cordis.patch.yml', size: Buffer.byteLength(ymlInSnap49) }, { name: 'home-.env', size: 24 }],
    plugins: [], profileFiles: [], sensitiveMode: 'redact', redacted: ['profile-cordis.patch.yml', 'home-.env'],
    envVaultRefs: {}, profile: 'web',
  }));
  await writeFile(join(profile49, 'cordis.patch.yml'), pre49);
  // snapshot_id 只接受快照目录名（不是绝对路径）。
  const outC49 = await run49('undo_restore', { mode: 'id', snapshot_id: 'w49-legacy-fixed' });
  const liveC49 = await readFile(join(profile49, 'cordis.patch.yml'), 'utf8');
  check(
    liveC49.startsWith(pre49) && !liveC49.includes(R),
    'W49 守卫二：无 ref 老快照的 .yml 候选含占位符 ⇒ 拒写（反向敏感：改动前此处会被覆盖）',
  );
  check(String(outC49).includes('Skipped') && String(outC49).includes('file skipped to keep the live file intact'), 'W49 守卫二：无 ref 分支同样明示跳过');
  check(
    (await readFile(join(home49, '.env'), 'utf8')).includes(R),
    'W49 守卫二：.env 不拦，占位符降级行为不变（文档化降级）',
  );

  // (6) redact-existing：dry-run 零写盘、--apply 处理存量、二次跑幂等
  const existing49 = join(w49root, 'existing');
  const legacy49 = join(existing49, '20260930-120000-aaaa');
  await mkdir(legacy49, { recursive: true });
  await writeFile(join(legacy49, 'profile-cordis.patch.yml'), liveYml49);
  await writeFile(join(legacy49, 'home-cordis.patch.yml'), 'x: sk-w49-home-plain\n');
  await writeFile(join(legacy49, 'manifest.json'), JSON.stringify({
    id: '20260930-120000-aaaa', time: new Date().toISOString(), kind: 'auto', reason: 'legacy-live',
    files: [{ name: 'profile-cordis.patch.yml', size: Buffer.byteLength(liveYml49) }],
    plugins: [], profileFiles: [], sensitiveMode: 'redact', redacted: [], envVaultRefs: {}, profile: 'web',
  }));
  const tool49 = await import('./redact-existing.mjs');
  const cfg49 = core.buildConfig({ autoDir: existing49, manualDir: join(existing49, 'manual'), homeDir: home49, profileDir: profile49 });
  const dry49 = await tool49.run({ ...cfg49, apply: false });
  check(
    dry49.processed === 2 && dry49.vaultAdded === 0 && (await readFile(join(legacy49, 'profile-cordis.patch.yml'), 'utf8')) === liveYml49,
    'W49 存量工具：dry-run 报告 2 项且磁盘逐字节不变',
  );
  const applied49 = await tool49.run({ ...cfg49, apply: true });
  const afterYml49 = await readFile(join(legacy49, 'profile-cordis.patch.yml'), 'utf8');
  const mLegacy49 = JSON.parse(await readFile(join(legacy49, 'manifest.json'), 'utf8'));
  check(
    applied49.processed === 2 && applied49.vaultAdded === 2 && afterYml49.includes(R) && !afterYml49.includes('sk-w49-live'),
    'W49 存量工具：--apply 处理 2 项，快照内明文替换为占位符',
  );
  check(
    !!mLegacy49.envVaultRefs['profile-cordis.patch.yml'] &&
      (await readFile(join(existing49, 'env-vault', `${mLegacy49.envVaultRefs['profile-cordis.patch.yml']}.env`), 'utf8')) === liveYml49,
    'W49 存量工具：明文原件入 vault 且 ref 写回 manifest（内容寻址，逐字节相同）',
  );
  const again49 = await tool49.run({ ...cfg49, apply: true });
  check(again49.processed === 0 && again49.skipped >= 1, 'W49 存量工具：二次跑幂等（处理 0 项）');
  // (7) 工具体内不得引入子进程（W33 同类约束）
  const reSrc49 = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'redact-existing.mjs'), 'utf8');
  check(!/\b(?:execFile|spawn|exec)\s*\(/.test(reSrc49), 'W49 存量工具：不含任何子进程调用');
  await rm(w49root, { recursive: true, force: true });
}

// ── W48：安装锚点、宿主托管 bundle、桌面拒动 ─────────────────────────────────
// 反向敏感：改动前 bundleAnchors 只有 profile 与 ~/.dsh 两个锚点（~/.dsh 还排在前面），
// 桌面 profile 上解析不到的官方核心 bundle 一律报 cannot resolve 硬失败，safeModeSet(on)
// 在桌面 profile 上会真的改写桌面补丁；悬空 insert 键既无报告也无清理入口。
console.log('== W48. install anchor, host-managed bundles, desktop safe-mode refusal ==');
{
  const base48 = await import('../lib/base.mjs');
  const health48 = await import('../lib/health.mjs');
  const core48 = await import('../lib/core.mjs');
  const { execFile: exec48 } = await import('node:child_process');
  const w48root = await mkdtemp(join(tmpdir(), 'dsh-undo-test48-'));
  const snap48 = join(w48root, 'snaps');
  await mkdir(join(snap48, 'auto'), { recursive: true });
  await mkdir(join(snap48, 'manual'), { recursive: true });
  const sha48 = async (p) => core48.sha1Hex(await readFile(p));
  const stamp48 = async (paths) => (await Promise.all(paths.map(sha48))).join('|');

  // (1) 锚点次序：三个可解析目录里各放一份同名 probe-pkg。必须走子进程，
  //     DSH_HOME / DSH_ROOT 是 base.mjs 的 import 期常量，进程内改不动。
  const anchor48 = join(w48root, 'anchor');
  const install48 = join(anchor48, 'installTree'), homeA48 = join(anchor48, 'home'), profileA48 = join(anchor48, 'profile');
  const mkPkg48 = async (dir, marker) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'probe-host', marker }), 'utf8');
    const pkgDir = join(dir, 'node_modules', 'probe-pkg');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'probe-pkg', marker, dsh: { bundle: { patch: 'patch.js' } } }), 'utf8');
    await writeFile(join(pkgDir, 'patch.js'), `export const marker = '${marker}';\n`, 'utf8');
  };
  await mkdir(join(install48, 'lib'), { recursive: true });
  await writeFile(join(install48, 'lib', 'bin.js'), '// dsh product tree stand-in\n', 'utf8');
  await mkPkg48(install48, 'install'); await mkPkg48(homeA48, 'home'); await mkPkg48(profileA48, 'profile');
  await writeFile(join(homeA48, 'settings.yaml'), 'model: x\n', 'utf8');
  const libUrl48 = (f) => pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', f)).href;
  const probe48 = join(w48root, 'anchor-probe.mjs');
  await writeFile(probe48, [
    `const { buildConfig } = await import(${JSON.stringify(libUrl48('base.mjs'))});`,
    `const { bundleAnchors, bundleCheck, readDshVersion } = await import(${JSON.stringify(libUrl48('health.mjs'))});`,
    "const { readFile } = await import('node:fs/promises');",
    "const { join } = await import('node:path');",
    'const [profileName, profileDir, name] = process.argv.slice(2);',
    'const cfg = buildConfig({ profileName, profileDir });',
    'const out = { anchors: (await bundleAnchors(cfg, profileDir)).length, version: await readDshVersion() };',
    'try {',
    '  const r = await bundleCheck(cfg, name, profileDir);',
    '  out.ok = r.ok === true; out.hostManaged = r.hostManaged === true; out.reason = r.reason ?? null;',
    '  if (r.dir) { try { out.marker = JSON.parse(await readFile(join(r.dir, "package.json"), "utf8")).marker ?? null; } catch { out.marker = null; } }',
    '} catch (e) { out.threw = String((e && e.message) || e); }',
    'console.log(JSON.stringify(out));',
    'process.exit(0);',
    '',
  ].join('\n'), 'utf8');
  // E80：宿主注入的 DSH_PROFILE / DSH_UNDO_* 会抢跑通道，子进程环境必须干净。
  const env48 = (extra) => {
    const e = { ...process.env, ...extra, DSH_UNDO_LANG: 'en', DSH_UNDO_NO_DESKTOP: '1' };
    delete e.DSH_PROFILE; delete e.DSH_UNDO_SETTINGS; delete e.DSH_UNDO_ROOT;
    return e;
  };
  const run48 = (env, args) => new Promise((resolve) => {
    exec48(process.execPath, [probe48, ...args], { env }, (err, stdout) => resolve({
      code: err ? (err.code ?? 1) : 0,
      json: (() => { try { return JSON.parse(String(stdout)); } catch { return null; } })(),
    }));
  });
  const anchorProbe48 = () => run48(env48({ DSH_ROOT: install48, DSH_HOME: homeA48 }), ['web', profileA48, 'probe-pkg']);
  const p1a = await anchorProbe48();
  await rm(join(install48, 'node_modules'), { recursive: true, force: true });
  const p1b = await anchorProbe48();
  await rm(join(profileA48, 'node_modules'), { recursive: true, force: true });
  const p1c = await anchorProbe48();
  check(
    [p1a, p1b, p1c].every((x) => x.json && x.json.ok === true && x.json.anchors === 3)
      && [p1a, p1b, p1c].map((x) => x.json.marker).join(',') === 'install,profile,home',
    'W48 锚点次序：安装目录 > profile > ~/.dsh（三锚点同名包逐级回落）',
  );

  // (2) 探测容错：DSH_ROOT 不是产品树且取不到 @deepseek-ai/dsh 时，只少一个锚点，不外抛。
  const bare48 = join(anchor48, 'notAProductTree');
  await mkdir(bare48, { recursive: true });
  await writeFile(join(bare48, 'package.json'), '{"name":"not-a-dsh-tree"}\n', 'utf8');
  const empty48 = join(anchor48, 'emptyProfile');
  await mkdir(empty48, { recursive: true });
  const p2 = await run48(env48({ DSH_ROOT: bare48, DSH_HOME: homeA48 }), ['web', empty48, 'probe-absent-pkg']);
  check(
    p2.code === 0 && !!p2.json && !('threw' in p2.json) && p2.json.ok === false
      && p2.json.anchors === 2 && (p2.json.version === null || typeof p2.json.version === 'string'),
    'W48 探测容错：非产品树 DSH_ROOT + 取不到 dsh 包时只少一个锚点，不抛异常',
  );

  // (3)(4)(5) 桌面判定夹具：home 下 desktop 与 web 两个 profile，bundles 都声明两个名字。
  const home48 = join(w48root, 'home');
  const profileD48 = join(home48, 'profiles', 'desktop'), profileW48 = join(home48, 'profiles', 'web');
  const vendorProbe48 = '@deepseek-ai/dsh-probe-not-installed';
  const miss48 = 'probe-pkg-not-installed';
  const bundles48 = JSON.stringify({ name: 'probe-profile', dsh: { profile: { bundles: [vendorProbe48, miss48] } } });
  for (const [dir, nm] of [[profileD48, 'desktop'], [profileW48, 'web']]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), bundles48, 'utf8');
    await writeFile(join(dir, 'cordis.patch.yml'), `# ${nm} patch\n[]\n`, 'utf8');
  }
  await writeFile(join(home48, 'cordis.patch.yml'), '# home patch\n[]\n', 'utf8');
  const mkCfg48 = (name, dir) => base48.buildConfig({
    homeDir: home48, profileName: name, profileDir: dir,
    manualDir: join(snap48, 'manual'), autoDir: join(snap48, 'auto'),
  });
  const cfgD48 = mkCfg48('desktop', profileD48), cfgW48 = mkCfg48('web', profileW48);
  const pkgD48 = JSON.parse(bundles48);
  const rep48 = await health48.runDoctor(cfgD48);
  const host48 = rep48.checks.filter((c) => c.code === 'pre-bundle-host');
  const kept48 = (await health48.computeSafeBundles(cfgD48, pkgD48)).kept;
  const r3 = await health48.bundleCheck(cfgD48, vendorProbe48, profileD48);
  check(
    r3.ok === false && r3.hostManaged === true && /host-managed/.test(String(r3.reason))
    && host48.length === 1 && host48[0].name.includes(vendorProbe48)
    && host48[0].level === 'ok' && host48[0].detail.includes('host-managed')
    && kept48.includes(vendorProbe48) && cfgD48.profileDir === profileD48,
    'W48 桌面宿主托管 bundle：解析不到也不算异常（ok 档 + 理由可辨，不参与中和）',
  );

  // (4) 真缺失不被豁免吞掉：非官方核心名照旧 cannot resolve 硬失败，并进中和名单。
  const err48 = rep48.checks.filter((c) => c.code === 'pre-bundle' && c.name.includes(miss48));
  const pruned48 = (await health48.computeSafeBundles(cfgD48, pkgD48)).pruned;
  const r4 = await health48.bundleCheck(cfgD48, miss48, profileD48);
  check(
    r4.ok === false && r4.hostManaged !== true && r4.reason === `cannot resolve ${miss48}`
      && err48.length === 2 && err48.every((c) => c.level === 'err')
      && pruned48.some((p) => p.name === miss48),
    'W48 真缺失不被吞：桌面 profile 上非核心名的 bundle 仍报 cannot resolve 硬失败',
  );

  // (5) 非桌面形态输出不变：web profile 上同一个核心名照旧硬失败。
  const r5 = await health48.bundleCheck(cfgW48, vendorProbe48, profileW48);
  const errW48 = rep48.checks.filter((c) => c.code === 'pre-bundle' && c.name.includes(vendorProbe48));
  check(
    r5.ok === false && r5.hostManaged !== true && r5.reason === `cannot resolve ${vendorProbe48}`
      && errW48.length === 1 && errW48[0].level === 'err',
    'W48 非桌面形态不变：web profile 上同一核心名照旧硬失败（豁免只认 desktop）',
  );

  // (6) 桌面拒动：落在任何写盘之前，三份文件逐字节不变、零备份残留。
  const desk6 = [join(profileD48, 'package.json'), join(profileD48, 'cordis.patch.yml'), join(home48, 'cordis.patch.yml')];
  const before6 = await stamp48(desk6);
  const r6 = await health48.safeModeSet(cfgD48, true);
  const after6 = await stamp48(desk6);
  const auto6 = await readdir(join(snap48, 'auto'));
  check(
    r6.ok === false && r6.reason === 'desktop-profile'
      && typeof r6.error === 'string' && r6.error.trim().length > 20
      && after6 === before6 && !auto6.some((n) => n.startsWith('safe-mode')),
    'W48 桌面拒动：safeModeSet(on) 在任何写盘前拒绝，三份文件逐字节不变、零备份残留',
  );

  // (7) 只挡 on：web 上安全模式照常进入；桌面 profile 上前一次（CLI 侧）开过的状态仍能 off。
  const r7a = await health48.safeModeSet(cfgW48, true);
  const webPatch7 = await readFile(join(profileW48, 'cordis.patch.yml'), 'utf8');
  const deskBackup7 = join(snap48, 'auto', 'safe-mode-backup-manual-probe.yml');
  await writeFile(deskBackup7, '# desktop patch restored by off\n[]\n', 'utf8');
  await writeFile(join(snap48, 'auto', 'safe-mode.json'), JSON.stringify({
    active: true, enteredAt: '2026-10-04T00:00:00.000Z', backup: deskBackup7,
    snapshotId: 'manual-probe', homeFingerprint: null,
  }), 'utf8');
  const r7b = await health48.safeModeSet(cfgD48, false);
  check(
    r7a.ok === true && r7a.active === true && webPatch7.includes('SAFE MODE')
      && r7b.ok === true && r7b.active === false
      && (await readFile(join(profileD48, 'cordis.patch.yml'), 'utf8')).includes('restored by off'),
    'W48 只挡 on：web 上安全模式照常进入，桌面 profile 上 off 仍可关闭（逃生通道不被堵）',
  );

  // (8) 非默认 home（E:\dsh 替身）：临时 home 下的 desktop profile 同样豁免、同样被拒动。
  const home8 = join(w48root, 'home8'), profileD8 = join(home8, 'profiles', 'desktop');
  await mkdir(profileD8, { recursive: true });
  await writeFile(join(profileD8, 'package.json'), bundles48, 'utf8');
  await writeFile(join(profileD8, 'cordis.patch.yml'), '# desktop patch (stand-in home)\n[]\n', 'utf8');
  await writeFile(join(home8, 'cordis.patch.yml'), '# home patch (stand-in home)\n[]\n', 'utf8');
  const cfg8 = base48.buildConfig({
    homeDir: home8, profileName: 'desktop', profileDir: profileD8,
    manualDir: join(w48root, 's8', 'manual'), autoDir: join(w48root, 's8', 'auto'),
  });
  const r8a = await health48.bundleCheck(cfg8, vendorProbe48, profileD8);
  const eighth8 = [join(profileD8, 'package.json'), join(profileD8, 'cordis.patch.yml')];
  const before8 = await stamp48(eighth8);
  const r8b = await health48.safeModeSet(cfg8, true);
  const after8 = await stamp48(eighth8);
  check(
    home8.startsWith(tmpdir()) && r8a.hostManaged === true && r8b.ok === false
      && r8b.reason === 'desktop-profile' && after8 === before8,
    'W48 非默认 home：临时 home 下的 desktop profile 同样享豁免、同样被拒动',
  );
  await rm(w48root, { recursive: true, force: true });
}

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail > 0 ? 1 : 0);