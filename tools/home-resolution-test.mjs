// tools/home-resolution-test.mjs — issue #6 regression: every derived path
// (settings file, snapshot root, profile dir, home root) follows DSH_HOME,
// exactly like the official launcher (@deepseek-ai/dsh-home-paths).
//
// The test runs the SAME script twice in child processes, each with its own
// environment:
//   1) DSH_HOME=<tmp>            -> derived paths must resolve under DSH_HOME
//   2) DSH_HOME unset            -> derived paths must resolve under
//                                   <USERPROFILE/HOME>\.dsh (the default)
// Each child builds fixtures ONLY under its temp root, snapshots them via the
// real plugin entry, then triggers an undo and verifies the rollback log
// landed next to the DSH_HOME-based settings file.
//
// Run:  node tools/home-resolution-test.mjs   (parent spawns both branches)
// Convention: like smoke-test.mjs, falls back to DSH_ROOT=C:/Users/yzf so
// @deepseek-ai/dsh-tools resolves on dev machines without a local install.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DSH_ROOT = process.env.DSH_ROOT ?? 'C:/Users/yzf';

const SELF = fileURLToPath(import.meta.url);

// ── child mode: run the assertions under the env the parent prepared ───────
async function child() {
  const mode = process.env.UNDO_HOME_TEST; // 'honored' | 'default'
  const tmp = process.env.UNDO_HOME_TMP;
  const dshHome = mode === 'honored'
    ? process.env.DSH_HOME                     // DSH_HOME wins
    : join(process.env.USERPROFILE ?? process.env.HOME, '.dsh'); // default ~/.dsh
  const profileDir = join(dshHome, 'profiles', 'web');
  const snapDir = join(tmp, 'snaps');
  await mkdir(profileDir, { recursive: true });
  await mkdir(snapDir, { recursive: true });
  await writeFile(join(dshHome, 'settings.yaml'), 'model: dshhome-check\n');
  await writeFile(join(profileDir, 'cordis.patch.yml'), '# patch\n[]\n');
  await writeFile(join(profileDir, 'package.json'), '{"v":1}\n');

  // import AFTER env is in place: lib/index.js reads DSH_HOME at module load
  const { apply } = await import('../lib/index.js');
  const tools = new Map();
  const ctx = {
    tools: { register: (t) => { tools.set(t.name, t); return () => { }; } },
    systemPrompt: { section: () => () => { } },
    get: () => undefined,
    effect: (fn) => { const d = fn(); return d ?? (() => { }); },
    logger: { info: () => { }, warn: (...a) => console.warn('[warn]', ...a) },
  };
  // NO homeDir / profileDir overrides: everything must derive from DSH_HOME
  apply(ctx, { manualDir: join(snapDir, 'manual'), autoDir: join(snapDir, 'auto'), watch: false, pluginDirs: [], keepAuto: 2 });
  await new Promise((r) => setTimeout(r, 400)); // baseline lands

  let pass = 0, fail = 0;
  const check = (cond, label) => { if (cond) { pass++; console.log(`  ok  - ${label}`); } else { fail++; console.error(`  FAIL - ${label}`); } };
  const run = async (name, args) => (await tools.get(name).execute(args, {}));
  const manualDir = join(snapDir, 'manual');

  // 1) snapshot must capture files from DSH_HOME roots (home + profile dir)
  await run('undo_snapshot', { reason: 's1' });
  const s1Id = (await readdir(manualDir)).find((d) => d !== '.booting');
  const m1 = JSON.parse(await readFile(join(manualDir, s1Id, 'manifest.json'), 'utf8'));
  const names = m1.files.map((f) => f.name);
  check(names.includes('home-settings.yaml'), `[${mode}] snapshot read home root from ${dshHome}`);
  check(names.includes('profile-cordis.patch.yml') && names.includes('profile-package.json'), `[${mode}] snapshot read profile dir from ${profileDir}`);

  // 2) settings file must be under DSH_HOME/undo (rollback log proves it)
  await writeFile(join(profileDir, 'package.json'), '{"v":2}\n');
  await run('undo_snapshot', { reason: 's2' });
  const out = await run('undo_restore', { mode: 'undo' });
  const logFile = join(dshHome, 'undo', 'rollback-log.jsonl');
  try {
    const text = await readFile(logFile, 'utf8');
    check(text.includes('profile-package.json'), `[${mode}] settings file + rollback log under ${dshHome}/undo`);
  } catch {
    check(false, `[${mode}] rollback log missing at ${logFile} (undo output: ${String(out).split('\n')[0]})`);
  }

  console.log(`[${mode}] RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

// ── parent mode: run both branches ─────────────────────────────────────────
async function parent() {
  const tmpA = await mkdtemp(join(tmpdir(), 'dsh-undo-home-a-'));
  const tmpB = await mkdtemp(join(tmpdir(), 'dsh-undo-home-b-'));
  const envHonored = { ...process.env, UNDO_HOME_TEST: 'honored', UNDO_HOME_TMP: tmpA, DSH_HOME: tmpA };
  const envDefault = { ...process.env, UNDO_HOME_TEST: 'default', UNDO_HOME_TMP: tmpB, USERPROFILE: tmpB, HOME: tmpB };
  delete envDefault.DSH_HOME;
  const tmpC = await mkdtemp(join(tmpdir(), 'dsh-undo-home-c-'));
  const envEmpty = { ...process.env, UNDO_HOME_TEST: 'empty', UNDO_HOME_TMP: tmpC, USERPROFILE: tmpC, HOME: tmpC, DSH_HOME: '' };

  let pass = 0, fail = 0;
  for (const [label, env] of [['honored(DSH_HOME set)', envHonored], ['default(DSH_HOME unset)', envDefault], ['empty(DSH_HOME="")', envEmpty]]) {
    console.log(`== ${label} ==`);
    const r = spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', cwd: dirname(dirname(SELF)) });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const ok = r.status === 0;
    console.log(`   -> ${ok ? 'PASS' : 'FAIL'} (exit ${r.status})`);
    if (ok) pass++; else fail++;
  }
  console.log(`\n== RESULT: ${pass} branch(es) passed, ${fail} failed ==`);
  process.exit(fail > 0 ? 1 : 0);
}

if (process.env.UNDO_HOME_TEST) await child();
else await parent();
