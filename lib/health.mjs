/**
 * dsh-undo-savepoint: 启动健康与安全守卫（崩溃归因 / 补丁托管 / 安全模式 / doctor / 体检）。
 *
 * V0.5.0 拆分（W17）：本模块承接原 lib/core.mjs 的崩溃归因（A）、补丁托管与安全模式（B）、
 * doctor 与修复（C）、环境预检辅助（W34）与体检族（D 区段），逐字节搬移、零行为变化。
 * core.mjs 保持同名 re-export，对外 API 面不变；W18 的升级护航追加在本文件末尾。
 *
 * 依赖方向：health -> snapshot -> session -> base（单向）。
 */
import { promises as fs, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { t } from './i18n.mjs';
import {
  DSH_HOME,
  DSH_ROOT,
  PLUGIN_ROOT,
  REDACTED_PLACEHOLDER,
  SENSITIVE_DESTS,
  SETTINGS_FILE,
  TOOLS_DIR,
  blobDir,
  busyError,
  filePath,
  fmtBytes,
  hasOpenTurn,
  pathExists,
  resolveToolsRequire,
  rootDir,
  sha1Hex,
  storeDirs,
  vaultDir,
} from './base.mjs';
import {
  analyzeSessionBytes,
  assertZstd,
  parseSessionLogZstdName,
  walkSessionFiles,
} from './session.mjs';
import {
  createSnapshot,
  listSnapshots,
} from './snapshot.mjs';

// ── 崩溃归因（v0.3 模块 3）：boot-state.json 读写 ─────────────────────────
async function readBootState(cfg) {
  try { return JSON.parse(await fs.readFile(join(cfg.autoDir, 'boot-state.json'), 'utf8')); } catch { return null; }
}
async function writeBootState(cfg, state) {
  try {
    await fs.mkdir(cfg.autoDir, { recursive: true });
    await fs.writeFile(join(cfg.autoDir, 'boot-state.json'), JSON.stringify(state, null, 2), 'utf8');
  } catch { /* 状态文件写失败不阻塞启动 */ }
}

// ── B5 崩溃归因 v2（v0.3.8）：日志签名分类 ─────────────────────────────────
function classifyCrash(text) {
  if (/corrupt Zstandard session log/i.test(text)) return 'session-corrupt';
  if (/declares no dsh\.bundle|cannot resolve profile bundle/i.test(text)) return 'bundle-check';
  if (/already registered|duplicate loader entry|failed to load plugin|cannot find (module|package)/i.test(text)) return 'patch-tree';
  return 'unknown';
}
async function candidateLogs(cfg) {
  const homeRoot = cfg.homeDir ?? DSH_HOME;
  const out = [];
  try {
    for (const f of await fs.readdir(join(homeRoot, 'logs'))) {
      if (f.toLowerCase().endsWith('.log')) out.push(join(homeRoot, 'logs', f));
    }
  } catch { /* logs 目录不存在 */ }
  try {
    for (const f of await fs.readdir(homeRoot)) {
      if (f.toLowerCase() === 'dsh.log') out.push(join(homeRoot, f));
    }
  } catch { /* home 不存在 */ }
  return out;
}
async function readCrashLogTail(cfg) {
  for (const p of await candidateLogs(cfg)) {
    try {
      const st = await fs.stat(p);
      if (st.size === 0) continue;
      const fd = await fs.open(p, 'r');
      try {
        const len = Math.min(st.size, 262144);
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, st.size - len);
        return { path: p, text: buf.toString('utf8') };
      } finally { await fd.close(); }
    } catch { /* 单个日志失败跳过 */ }
  }
  return null;
}
function crashAdvice(reason) {
  switch (reason) {
    case 'session-corrupt': return t('crash.session');
    case 'bundle-check': return t('crash.bundle');
    case 'patch-tree': return t('crash.patch');
    default: return '';
  }
}

// ── B4 补丁托管（v0.3.8）：dsh-session-persistence-jsonl 容错补丁校验 ────────
// 补丁目标定位。DSH_ROOT 指向一份 dsh 产品树时进入严格隔离模式：只认该产品树，
// 不再回落到全局安装与用户级 node_modules，隔离实例（副本 DSH）据此保证补丁
// 永不落到本体产物树上。
// 产品树判定要求同时存在 package.json 与 lib/bin.js。DSH_ROOT 另有既存含义（dsh
// 依赖树解析根，测试与 CI 里指向 /tmp/dsh-fake15、用户主目录这类目录），那种目录
// 不是产品树，不会触发严格模式，探测顺序与改动前逐条一致。
async function isDshProductTree(dir) {
  if (!dir) return false;
  try {
    await fs.access(join(dir, 'package.json'));
    await fs.access(join(dir, 'lib', 'bin.js'));
    return true;
  } catch { return false; }
}
async function locatePatchTarget(relTarget) {
  if (await isDshProductTree(DSH_ROOT)) {
    for (const p of [join(DSH_ROOT, 'node_modules', relTarget), join(DSH_ROOT, relTarget)]) {
      try { await fs.access(p); return p; } catch { /* 下一个候选根 */ }
    }
    return null;
  }
  const roots = [];
  if (process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'));
    roots.push(join(process.env.APPDATA, 'npm', 'node_modules'));
  }
  roots.push(join(homedir(), 'node_modules'));
  roots.push(join(DSH_HOME, 'node_modules'));
  for (const r of roots) {
    const p = join(r, relTarget);
    try { await fs.access(p); return p; } catch { /* 下一个候选根 */ }
  }
  return null;
}
/**
 * 纯函数（v0.4.5，供 patchVerify 与离线测试共用）：在产物文本上匹配补丁清单。
 * 补丁可带多版本子串（variants，DSH 0.1.2-rc.1 起 appendBatch 签名变化），
 * 无 variants 的按扁平 old/new 处理。任一形态 new 命中 = 已应用；任一形态
 * old 命中 = missing；全不命中 = unmatched（版本演进后清单待更新）；
 * 清单标了 obsoletedOn 且传入 version 命中该版本线时 = obsoleted（官方产物
 * 已消解该问题，无锚点属预期，不算异常）。
 * @param {string} text 目标产物源码
 * @param {object[]} patches 清单 patches 数组
 * @param {string} [version] 目标产物的包版本（用于 obsoletedOn 判定）
 * @returns {{ missing: string[], unmatched: string[], obsoleted: string[] }}
 */
function matchPatchesInText(text, patches, version) {
  const missing = [], unmatched = [], obsoleted = [];
  for (const p of patches ?? []) {
    const variants = p.variants ?? [{ old: p.old, new: p.new }];
    if (variants.some((v) => text.includes(v.new))) continue;
    if (variants.some((v) => text.includes(v.old))) { missing.push(p.id); continue; }
    if (patchObsoletedOn(p, version)) { obsoleted.push(p.id); continue; }
    unmatched.push(p.id);
  }
  return { missing, unmatched, obsoleted };
}

// obsoletedOn 声明某补丁在哪些 DSH 版本线上已被官方产物消解（无锚点属预期）。
// 只有传入 version 且前缀命中时才判定，纯文本调用保持既有语义（未命中即 unmatched）。
function patchObsoletedOn(patch, version) {
  const on = patch?.obsoletedOn;
  if (!Array.isArray(on) || on.length === 0 || !version) return false;
  return on.some((prefix) => String(version).startsWith(String(prefix)));
}

// 补丁目标是 <pkg>/lib/index.js，包版本从 <pkg>/package.json 读取。
function readPatchTargetVersion(target) {
  try { return JSON.parse(readFileSync(join(dirname(target), '..', 'package.json'), 'utf8')).version; } catch { return undefined; }
}

async function patchVerify(cfg) {
  try {
    const manifest = JSON.parse(readFileSync(join(TOOLS_DIR, 'dsh-patches.json'), 'utf8'));
    const target = await locatePatchTarget(manifest.target);
    if (!target) return { ok: false, reason: 'target-not-found' };
    const text = readFileSync(target, 'utf8');
    const { missing, unmatched, obsoleted } = matchPatchesInText(text, manifest.patches, readPatchTargetVersion(target));
    if (unmatched.length > 0) {
      return { ok: false, reason: `unmatched:${unmatched[0]}`, unmatched, target };
    }
    return { ok: missing.length === 0, missing, obsoleted, target };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function lastGoodSnapshot(cfg, list) {
  const at = cfg.bootAlert?.lastGoodAt ?? null;
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return list.find((s) => s.kind !== 'pre-restore' && Date.parse(s.time) <= t) ?? null;
}

// ── 一键安全模式（v0.3 模块 4；v0.3.7/0.3.8 按复盘补完）───────────────────
async function readSafeModeState(cfg) {
  try { return JSON.parse(await fs.readFile(join(cfg.autoDir, 'safe-mode.json'), 'utf8')); } catch { return { active: false }; }
}
async function homeFingerprint(cfg) {
  return sha1Hex(Buffer.from(`${rootDir(cfg, 'home')}|${cfg.profileName}`, 'utf8'));
}
function bundleAnchors(cfg, profileDir) {
  const anchors = [];
  try { anchors.push(createRequire(join(DSH_HOME, 'package.json'))); } catch { /* DSH_HOME 无 package.json 也可 */ }
  try { anchors.push(createRequire(join(profileDir ?? rootDir(cfg, 'profile'), 'package.json'))); } catch { /* profile 无 package.json 也可 */ }
  return anchors;
}
// profileDir 缺省 = 当前 profile；体检要逐个 profile 判定（v0.4.8）。
async function bundleCheck(cfg, name, profileDir) {
  for (const r of bundleAnchors(cfg, profileDir)) {
    for (const sp of (r.resolve.paths(name) ?? [])) {
      const cand = join(sp, name);
      let pkg;
      try { pkg = JSON.parse(await fs.readFile(join(cand, 'package.json'), 'utf8')); } catch { continue; }
      // dsh.bundle.patch 既可是字符串，也可是文件路径数组（DSH 0.1.7-rc.1 起扩展，
      // 对齐本体 packages/boot/app-boot/src/profile.ts 的归一化语义：
      // 字符串先包成数组再逐个解析）。@deepseek-ai/dsh-web-app 是数组形式第一个
      // 官方使用者，issue #40 的误报即由此而来。
      const patchRaw = pkg.dsh?.bundle?.patch;
      const patchList = typeof patchRaw === 'string' ? [patchRaw] : Array.isArray(patchRaw) ? patchRaw : null;
      if (!patchList || patchList.length === 0) {
        return { ok: false, reason: `no dsh.bundle.patch (${name})` };
      }
      for (const patch of patchList) {
        if (typeof patch !== 'string' || !patch) {
          return { ok: false, reason: `dsh.bundle.patch 含非字符串项: ${JSON.stringify(patch)} (${name})` };
        }
        if (!(await pathExists(join(cand, patch)))) {
          return { ok: false, reason: `dsh.bundle.patch 文件缺失: ${join(cand, patch)}` };
        }
      }
      return { ok: true, dir: cand };
    }
  }
  return { ok: false, reason: `cannot resolve ${name}` };
}
async function computeSafeBundles(cfg, pkg) {
  const pruned = [];
  const kept = [];
  for (const name of (pkg.dsh?.profile?.bundles ?? [])) {
    if (typeof name !== 'string') {
      pruned.push({ name: String(name), reason: 'non-string bundle entry' });
      continue;
    }
    const r = await bundleCheck(cfg, name);
    if (r.ok) kept.push(name);
    else pruned.push({ name, reason: r.reason });
  }
  return { pruned, kept };
}
async function safeModeStatus(cfg) {
  const st = await readSafeModeState(cfg);
  if (st.active && st.homeFingerprint && st.homeFingerprint !== await homeFingerprint(cfg)) {
    return { ...st, active: false, stale: true };
  }
  return st;
}
async function safeModeSet(cfg, on) {
  if (hasOpenTurn()) return busyError();
  const st = await safeModeStatus(cfg);
  const patch = filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' });
  const homePatch = filePath(cfg, { root: 'home', rel: 'cordis.patch.yml' });
  const pkgPath = filePath(cfg, { root: 'profile', rel: 'package.json' });
  if (on) {
    if (st.active) {
      let rescanned = [];
      try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
        rescanned = (await computeSafeBundles(cfg, pkg)).pruned;
      } catch { /* package.json 读不到则重扫结果为空 */ }
      return {
        ok: true, active: true,
        message: t('safe.alreadyOn', { entered: st.enteredAt ?? '?' })
          + (rescanned.length > 0
            ? t('safe.rescan.found', { n: rescanned.length, list: rescanned.map((p) => p.name).join(', ') })
            : t('safe.rescan.none')),
      };
    }
    const snap = await createSnapshot(cfg, 'manual', 'safe-mode-before');
    const backup = join(cfg.autoDir, `safe-mode-backup-${snap.id}.yml`);
    const homeBackup = join(cfg.autoDir, `safe-mode-home-backup-${snap.id}.yml`);
    const pkgBackup = join(cfg.autoDir, `safe-mode-pkg-${snap.id}.json`);
    await fs.mkdir(cfg.autoDir, { recursive: true });
    if (await pathExists(patch)) await fs.copyFile(patch, backup);
    else await fs.writeFile(backup, '[]\n', 'utf8');
    const homePatchExists = await pathExists(homePatch);
    if (homePatchExists) await fs.copyFile(homePatch, homeBackup);
    if (!(await pathExists(backup))) {
      return { ok: false, error: t('safe.err.backupWrite', { backup }) };
    }
    let prunedBundles = [];
    let pkgBackedUp = false;
    let pkgRaw = null;
    try { pkgRaw = await fs.readFile(pkgPath, 'utf8'); } catch { /* package.json 缺失 */ }
    if (pkgRaw !== null) {
      await fs.writeFile(pkgBackup, pkgRaw, 'utf8');
      pkgBackedUp = true;
      try {
        const pkg = JSON.parse(pkgRaw);
        const { pruned, kept } = await computeSafeBundles(cfg, pkg);
        prunedBundles = pruned;
        const orig = pkg.dsh?.profile?.bundles ?? [];
        if (kept.join('\u0000') !== orig.join('\u0000')) {
          pkg.dsh = pkg.dsh ?? {};
          pkg.dsh.profile = pkg.dsh.profile ?? {};
          pkg.dsh.profile.bundles = kept;
          await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        }
      } catch (error) {
        return { ok: false, error: t('safe.err.corruptPkg', { msg: String(error?.message ?? error) }) };
      }
    }
    const minimal = `# dsh-undo-savepoint SAFE MODE (entered ${new Date().toISOString()})\n# All user plugins except dsh-undo-savepoint are temporarily disabled.\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n`;
    await fs.writeFile(patch, minimal, 'utf8');
    if (homePatchExists) {
      await fs.writeFile(homePatch, `# dsh-undo-savepoint SAFE MODE (home level, entered ${new Date().toISOString()})\n[]\n`, 'utf8');
    }
    const state = {
      active: true, enteredAt: new Date().toISOString(), backup, snapshotId: snap.id,
      homeBackup: homePatchExists ? homeBackup : undefined,
      homeFingerprint: await homeFingerprint(cfg),
    };
    if (pkgBackedUp) state.pkgBackup = pkgBackup;
    if (prunedBundles.length > 0) state.prunedBundles = prunedBundles;
    await fs.writeFile(join(cfg.autoDir, 'safe-mode.json'), JSON.stringify(state, null, 2), 'utf8');
    const prunedTxt = prunedBundles.length > 0
      ? t('safe.neutralized', { n: prunedBundles.length, list: prunedBundles.map((p) => `${p.name}（${p.reason}）`).join('；') })
      : '';
    let patchNote = '';
    try {
      const pv = await patchVerify(cfg);
      if (pv.ok === false && Array.isArray(pv.missing) && pv.missing.length > 0) {
        patchNote = t('safe.patchNote', { n: pv.missing.length, list: pv.missing.join(', ') });
      }
    } catch { /* 检测失败不影响安全模式 */ }
    return { ok: true, active: true, snapshotId: snap.id, prunedBundles, message: t('safe.on', { id: snap.id }) + prunedTxt + patchNote };
  }
  // off
  if (!st.active) {
    return st.stale
      ? { ok: true, active: false, message: t('safe.stale') }
      : { ok: true, active: false, message: t('safe.notActive') };
  }
  if (!st.backup || !(await pathExists(st.backup))) {
    return { ok: false, error: 'Safe-mode backup missing. Restore a snapshot from before the crash first (undo_list / undo_restore).' };
  }
  if (st.homeBackup && !(await pathExists(st.homeBackup))) {
    return { ok: false, error: 'Safe-mode home backup missing. Restore a snapshot from before the crash first (undo_list / undo_restore).' };
  }
  if (st.pkgBackup && !(await pathExists(st.pkgBackup))) {
    return { ok: false, error: 'Safe-mode package.json backup missing. Restore a snapshot from before the crash first (undo_list / undo_restore).' };
  }
  await fs.copyFile(st.backup, patch);
  if (st.homeBackup) await fs.copyFile(st.homeBackup, homePatch);
  let pkgRestored = false;
  if (st.pkgBackup) {
    await fs.copyFile(st.pkgBackup, pkgPath);
    pkgRestored = true;
  }
  await fs.rm(join(cfg.autoDir, 'safe-mode.json'), { force: true });
  const restoreTxt = pkgRestored
    ? t('safe.off.restorePkg', { n: st.prunedBundles?.length ?? 0 })
    : t('safe.off.legacy');
  return { ok: true, active: false, message: t('safe.off') + restoreTxt };
}

/** 一键诊断（V0.4.0，D4/P5）。返回结构化健康报告；offline 局外也复用。
 *  inOpts.platform / inOpts.nodeVersion 仅用于测试注入。 */
async function runDoctor(cfg, inOpts = {}) {
  const checks = [];
  const add = (level, code, name, detail, fix, opts) => checks.push({
    level, code, name,
    detail: String(detail ?? ''),
    fix: String(fix ?? ''),
    // fixable 的检查项可由 runDoctorFix 定点修复（v0.4.8 启动预检）
    ...(opts?.fixable ? { fixable: true } : {}),
  });
  const snapshots = await listSnapshots(cfg);
  // 1. store 目录存在且可写（真实写探针，避免平台误报）
  for (const [dir, label] of [[cfg.manualDir, 'manual'], [cfg.autoDir, 'auto']]) {
    if (!(await pathExists(dir))) { add('warn', `store-${label}`, `${label} store`, `directory not present (${dir})`, 'first snapshot creates it'); continue; }
    const probe = join(dir, '.doctor-probe');
    try { await fs.writeFile(probe, ''); await fs.rm(probe, { force: true }); add('ok', `store-${label}`, `${label} store`, `writable (${dir})`); }
    catch { add('err', `store-${label}`, `${label} store`, `not writable (${dir})`, 'check directory permissions'); }
  }
  // 2. blob 引用完整性（缺失 / 孤儿）
  const blobRoot = blobDir(cfg);
  const referenced = new Set();
  const refs = [];
  for (const s of snapshots) {
    for (const p of (s.plugins ?? [])) for (const f of (p.files ?? [])) if (f.hash) { referenced.add(f.hash); refs.push({ snap: s.id, hash: f.hash, ref: `plugin:${p.name}` }); }
    for (const f of (s.profileFiles ?? [])) if (f.hash) { referenced.add(f.hash); refs.push({ snap: s.id, hash: f.hash, ref: `profile:${f.path}` }); }
  }
  await fs.mkdir(blobRoot, { recursive: true }).catch(() => { /* ignore */ });
  let missingBlob = 0;
  const seen = new Set();
  for (const r of refs) {
    if (seen.has(r.hash)) continue; seen.add(r.hash);
    if (!(await pathExists(join(blobRoot, r.hash)))) { missingBlob++; add('err', 'missing-blob', `missing blob ${r.hash}`, `referenced by ${r.snap} (${r.ref})`, 'that data is unrecoverable; restore of that file may fail'); }
  }
  let orphan = 0;
  if (await pathExists(blobRoot)) {
    for (const e of await fs.readdir(blobRoot, { withFileTypes: true })) {
      if (e.isFile() && !referenced.has(e.name)) { orphan++; add('warn', 'orphan-blob', `orphan blob ${e.name}`, 'not referenced by any snapshot', 'run undo_compact to reclaim'); }
    }
  }
  // 3. settings 文件健康
  try { const st = await fs.stat(SETTINGS_FILE); add('ok', 'settings', 'settings file', `${st.size} bytes (${SETTINGS_FILE})`); }
  catch { add('warn', 'settings', 'settings file', `missing (${SETTINGS_FILE})`, 'using bundled defaults'); }
  // 4. 快照规模分布
  const byKind = { manual: 0, auto: 0, 'pre-restore': 0, baseline: 0 };
  for (const s of snapshots) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  add('ok', 'counts', 'snapshot counts', `total=${snapshots.length} manual=${byKind.manual} auto=${byKind.auto} pre=${byKind['pre-restore']} baseline=${byKind.baseline}`);
  // 5. 启动预检（v0.4.8）：这些硬失败都发生在插件挂载之前，进程内自救够不着
  await preflightChecks(cfg, add, checks, inOpts);
  // 汇总
  const levels = { ok: 0, warn: 0, err: 0 };
  for (const c of checks) levels[c.level] = (levels[c.level] ?? 0) + 1;
  return {
    ok: levels.err === 0,
    healthy: levels.err === 0 && levels.warn === 0,
    summary: { level: levels.err ? 'err' : levels.warn ? 'warn' : 'ok', ...levels },
    checks,
    counts: { total: snapshots.length, ...byKind },
    fixable: checks.filter((c) => c.fixable === true).length,
  };
}
// ── 启动预检（v0.4.8）：硬失败规则来自隔离实例实测 ──────────────────────
// 2026-09-15 用独立临时 home 做破坏式启动实验，结论是下列失败都发生在任何插件
// 挂载之前，进程内的启动自愈完全够不着，只能靠这份局外体检兜住：
//   1. profile 清单带 UTF-8 BOM：引导在 readProfileManifest 的 JSON.parse 处硬失败；
//   2. bundles 里有解析不到或未声明 dsh.bundle.patch 的包：dsh-app-boot 硬失败；
//   3. dsh.profile.patchReload 不是 live/startup：dsh-app-boot 硬失败；
//   4. profiles/node_modules 下 junction 悬空：产品树被移动或删除后最常见；
//   5. 同一个 patch 文件里 loader entry id 重复：duplicate loader entry id。
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// junction 重指用文件头已有的 PLUGIN_ROOT（= 插件包根目录）

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === UTF8_BOM[0] && buf[1] === UTF8_BOM[1] && buf[2] === UTF8_BOM[2];
}

/** $DSH_HOME/profiles 下的 profile 目录（跳过共享的 node_modules 与隐藏目录）。 */
async function profileDirs(cfg) {
  const base = join(rootDir(cfg, 'home'), 'profiles');
  const out = [];
  try {
    for (const e of await fs.readdir(base, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      out.push(join(base, e.name));
    }
  } catch { /* profiles 目录缺失：DSH 还没起过一次 */ }
  return out;
}

/**
 * 解析 YAML patch 文本里的 list item，给出每个 item 的行区间、id 值与它是否位于
 * insert 之下。只认 `- key:` 形式的 item，够覆盖 cordis.patch.yml 的实际结构。
 */
function scanLoaderItems(text) {
  const lines = text.split('\n');
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const col = m[1].length;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      const ind = l.length - l.replace(/^\s+/, '').length;
      if (ind <= col) break;
      end = j;
    }
    let parentKey = null;
    for (let k = i - 1; k >= 0; k--) {
      const pm = /^(\s*)-\s+([A-Za-z_][\w-]*):/.exec(lines[k]);
      if (!pm) continue;
      if (pm[1].length < col) { parentKey = pm[2]; break; }
    }
    const raw = m[3].trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
    items.push({ key: m[2], value: raw, id: m[2] === 'id' && raw ? raw : null, start: i, end, col, parentKey, inserted: parentKey === 'insert' });
  }
  return items;
}

/** 同一 patch 文件内重复的 loader entry id（保留最后一条，返回该删的条目）。 */
function duplicateLoaderItems(items) {
  const byId = new Map();
  for (const it of items) {
    if (!it.id) continue;
    const a = byId.get(it.id) ?? [];
    a.push(it);
    byId.set(it.id, a);
  }
  const out = [];
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    out.push({ id, list, drop: list.slice(0, -1), inserted: list.some((x) => x.inserted) });
  }
  return out;
}

/** 列出一层 node_modules 里的 junction / 符号链接（@scope 下钻一层）。 */
async function listLinks(root) {
  const out = [];
  const scan = async (dir, prefix) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) {
        let target = null;
        try { target = await fs.readlink(abs); } catch { target = null; }
        if (target && !isAbsolute(target)) target = resolve(dir, target);
        out.push({ path: abs, name: prefix + e.name, target, ok: target ? await pathExists(target) : false });
      } else if (e.isDirectory() && e.name.startsWith('@')) {
        await scan(abs, `${prefix}${e.name}/`);
      }
    }
  };
  await scan(root, '');
  return out;
}

/** 删掉一个 junction（只删链接本体，不跟随目标）。 */
async function removeLink(p) {
  try { await fs.rmdir(p); return; }
  catch { /* 非目录或已不存在，退回 force 删除 */ }
  await fs.rm(p, { force: true });
}

/** 创建 junction（Windows 目录联接），非 Windows 退回 dir 符号链接。 */
async function makeLink(target, linkPath) {
  await fs.mkdir(dirname(linkPath), { recursive: true });
  await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** 启动预检检查项（v0.4.8）：只读扫描，不改任何文件；可修复项标 fixable。
 *  inOpts.platform / inOpts.nodeVersion 仅用于测试注入（缺省取真实值）。 */
async function preflightChecks(cfg, add, checks, inOpts = {}) {
  const start = checks.length;
  const home = rootDir(cfg, 'home');
  const dirs = await profileDirs(cfg);

  // W34-1：win32 长路径风险。路径超 MAX_PATH 260 时资源管理器手删会失败/留残骸，
  // 提前告警给出实测长度与处置建议（清理一律走 tools/uninstall.mjs）。
  const platform = inOpts.platform ?? process.platform;
  const longest = longestSnapshotPath(cfg, home, dirs, platform);
  if (longest !== null && longest > 240) {
    add('warn', 'pre-long-path', 'snapshot path length',
      `longest expected snapshot path is ${longest} chars, close to the Windows MAX_PATH limit of 260`,
      'enable Windows long paths (LongPathsEnabled) or use a shorter user directory; for cleanup run tools/uninstall.mjs instead of Explorer');
  }

  // W34-2：Node 能力。undo_scan 的会话修复依赖 Node 22.15+，低于此值降级为只读提示。
  const nodeVersion = inOpts.nodeVersion ?? process.version;
  if (belowVersion(parseMajorMinor(nodeVersion), MIN_SCAN_NODE)) {
    add('warn', 'pre-node-capability', 'Node.js capability',
      `${nodeVersion} is below ${MIN_SCAN_NODE.join('.')}; undo_scan falls back to a read-only notice and cannot repair sessions`,
      `upgrade Node.js to ${MIN_SCAN_NODE.join('.')} or newer to enable session scan repair`);
  }

  let bundlesChecked = 0;
  let linksChecked = 0;
  // 清单里 link: 声明的依赖名：只有这些（以及自身插件）的软链才纳入悬空检查。
  const declaredLinks = new Set();
  if (dirs.length === 0) {
    add('warn', 'pre-profiles', 'profiles', `no profile directory under ${join(home, 'profiles')}`, 'start DSH once to create it');
  }
  for (const dir of dirs) {
    const name = basename(dir);
    const manifest = join(dir, 'package.json');
    let buf;
    try { buf = await fs.readFile(manifest); }
    catch { add('err', 'pre-manifest-missing', `profile ${name} manifest`, `missing (${manifest})`, 'restore this file from a snapshot'); continue; }
    if (hasBom(buf)) {
      add('err', 'pre-manifest-bom', `profile ${name} manifest`, `starts with a UTF-8 BOM, DSH aborts at JSON.parse before loading any plugin (${manifest})`, 'repair: strip the BOM (dsh-undo.ps1 doctor -Fix)', { fixable: true });
    }
    let pkg = null;
    try { pkg = JSON.parse((hasBom(buf) ? buf.subarray(3) : buf).toString('utf8')); }
    catch (e) { add('err', 'pre-manifest-json', `profile ${name} manifest`, `invalid JSON (${e?.message ?? e})`, 'restore this file from a snapshot'); continue; }
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
      add('err', 'pre-manifest-shape', `profile ${name} manifest`, 'must hold a JSON object', 'restore this file from a snapshot');
      continue;
    }
    const prof = pkg?.dsh?.profile;
    const bundles = prof?.bundles;
    if (bundles !== undefined && !Array.isArray(bundles)) {
      add('err', 'pre-bundles-type', `profile ${name} bundles`, 'dsh.profile.bundles must be an array', 'fix the manifest or restore it from a snapshot');
    } else {
      for (const b of bundles ?? []) {
        if (typeof b !== 'string') { add('err', 'pre-bundles-item', `profile ${name} bundles`, `non-string bundle entry: ${JSON.stringify(b)}`, 'remove that entry'); continue; }
        bundlesChecked++;
        const r = await bundleCheck(cfg, b, dir);
        if (!r.ok) add('err', 'pre-bundle', `bundle ${b}`, `${r.reason}, DSH aborts before loading any plugin`, 'run dsh-undo.ps1 safe-mode -Label on, then restart DSH');
      }
    }
    const reload = prof?.patchReload;
    if (reload !== undefined && reload !== 'live' && reload !== 'startup') {
      add('err', 'pre-patchreload', `profile ${name} patchReload`, `${JSON.stringify(reload)} is invalid, must be "live" or "startup"`, 'set that field back to "live"');
    }
    for (const [dep, spec] of Object.entries(pkg?.dependencies ?? {})) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue;
      declaredLinks.add(dep);
      const target = resolve(dir, spec.slice(5));
      const rel = dep.split('/');
      // DSH 两种落点都算装好：profile 自己的 node_modules（实测 0.1.5-rc.2 装插件走这里）
      // 与 profiles/node_modules 共享树（bundles 装配走这里）。
      const candidates = [join(dir, 'node_modules', ...rel), join(home, 'profiles', 'node_modules', ...rel)];
      let linked = false;
      for (const p of candidates) if (await pathExists(p)) { linked = true; break; }
      // 这两类都不是启动硬失败（真正让 DSH 起不来的是 bundles 声明面，已由 pre-bundle
      // 报错），因此一律 warn：能正常启动的机器上不该出现红色误报（2026-09-15 实机校准）。
      if (!(await pathExists(target))) {
        if (!(bundles ?? []).includes(dep)) add('warn', 'pre-link-target', `link ${dep}`, `link target missing (${target}), the linked package was moved or deleted`, 'fix the link: path in the profile manifest, or restore the package');
      } else if (!linked) {
        add('warn', 'pre-link-missing', `link ${dep}`, `no junction at ${candidates[0]} or ${candidates[1]} (target ${target})`, 'repair: recreate the junction (dsh-undo.ps1 doctor -Fix)', { fixable: true });
      }
    }
  }
  for (const p of [filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' }), filePath(cfg, { root: 'home', rel: 'cordis.patch.yml' })]) {
    let raw;
    try { raw = await fs.readFile(p); }
    catch { continue; }
    const label = `patch ${basename(dirname(p))}/cordis.patch.yml`;
    if (hasBom(raw)) add('warn', 'pre-patch-bom', label, `starts with a UTF-8 BOM (${p})`, 'repair: strip the BOM (dsh-undo.ps1 doctor -Fix)', { fixable: true });
    for (const d of duplicateLoaderItems(scanLoaderItems(raw.toString('utf8').replace(/^\uFEFF/, '')))) {
      const lines = d.list.map((x) => `line ${x.start + 1}`).join(', ');
      const why = d.inserted ? 'DSH aborts with "duplicate loader entry id"' : 'the last entry wins, the earlier ones are dead weight';
      add(d.inserted ? 'err' : 'warn', 'pre-loader-id', `loader entry id "${d.id}"`, `appears ${d.list.length} times in the same file (${lines}), ${why} (${p})`, 'repair: keep the last entry and drop the earlier ones (dsh-undo.ps1 doctor -Fix)', { fixable: true });
    }
  }
  for (const root of [join(home, 'node_modules'), join(home, 'profiles', 'node_modules')]) {
    const links = await listLinks(root);
    linksChecked += links.length;
    for (const l of links) {
      if (l.ok) continue;
      const self = l.name === 'dsh-undo-savepoint';
      // 包树里 DSH 自己的内部软链（@deepseek-ai/* 之类）不归预检管：它们在能正常启动
      // 的机器上也常年悬空，全量上报会把真正的问题淹没（2026-09-15 实机 16 条误报）。
      if (!self && !declaredLinks.has(l.name)) continue;
      add(self ? 'err' : 'warn', 'pre-link-dangling', `link ${l.name || basename(l.path)}`, `points at a missing target (${l.target ?? 'unreadable'}), ${l.path}`, self ? 'repair: re-point this junction at the installed plugin (dsh-undo.ps1 doctor -Fix)' : 'reinstall the linked package, or fix the link: path in the profile manifest', { fixable: self });
    }
  }
  const bs = await readBootState(cfg);
  if (bs && bs.ok !== true) {
    const at = bs.startedAt ? new Date(bs.startedAt).toLocaleString() : 'unknown time';
    add('warn', 'pre-boot-state', 'last boot', `did not finish (started ${at}${bs.crashReason ? `, classified as ${bs.crashReason}` : ''}${bs.lastGoodAt ? `, last known-good ${new Date(bs.lastGoodAt).toLocaleString()}` : ''})`, 'undo the last change, or run dsh-undo.ps1 safe-mode -Label on');
  }
  if (bs && bs.ok !== true && !bs.crashReason && (await candidateLogs(cfg)).length === 0) {
    add('warn', 'pre-crash-attribution', 'crash attribution', 'no crash-log source found ($DSH_HOME/logs/*.log and $DSH_HOME/dsh.log are both absent on DSH 0.1.5-rc.2), so the crash cause cannot be classified', 'start DSH through a wrapper that captures stdout/stderr');
  }
  // #41 体检项：本机 vault 的「真值」条目含占位符 = 历史污染（0.4.x 入库无守卫）。
  // 守卫二会拒绝还原这些条目，此检查主动提示用户清理。只读扫描，不改任何文件。
  {
    const vDir = vaultDir(cfg);
    if (await pathExists(vDir)) {
      for (const ent of await fs.readdir(vDir)) {
        if (!ent.endsWith('.env')) continue;
        let raw;
        try { raw = await fs.readFile(join(vDir, ent), 'utf8'); } catch { continue; }
        if (raw.includes(REDACTED_PLACEHOLDER)) {
          add('warn', 'pre-vault-contamination', `vault entry ${ent}`, 'contains redaction placeholders (contaminated "true value" from a pre-0.5.0 incident, #41); affected snapshots will refuse to restore this file', `delete the contaminated entry: ${join(vDir, ent)} (content-addressed, safe to remove)`);
        }
      }
    }
  }
  const problems = checks.slice(start).filter((c) => c.level !== 'ok').length;
  if (problems === 0) {
    add('ok', 'pre-summary', 'boot preflight', `${dirs.length} profile(s), ${bundlesChecked} bundle(s), ${linksChecked} link(s) checked, no blocking problem found`);
  }
}

/**
 * 启动预检的可修复子集（v0.4.8）：先快照再动手，只做有实测依据的定点修复，
 * 覆盖 UTF-8 BOM、同文件重复 loader id、悬空 junction（插件自身与 link: 依赖）。
 */
async function runDoctorFix(cfg) {
  const home = rootDir(cfg, 'home');
  const before = await runDoctor(cfg);
  const applied = [];
  const rec = (code, target, action, ok, error) => applied.push({ code, target, action, ok: ok === true, error: error ? String(error?.message ?? error) : null });
  let snapshotId = null;
  try { snapshotId = (await createSnapshot(cfg, 'manual', 'doctor-fix-before')).id; }
  catch (e) { rec('snapshot', cfg.manualDir, 'pre-fix snapshot', false, e); }
  for (const dir of await profileDirs(cfg)) {
    const manifest = join(dir, 'package.json');
    try {
      const buf = await fs.readFile(manifest);
      if (!hasBom(buf)) continue;
      await fs.copyFile(manifest, `${manifest}.dsh-undo-bak`);
      await fs.writeFile(manifest, buf.subarray(3));
      rec('pre-manifest-bom', manifest, 'stripped the UTF-8 BOM (backup: package.json.dsh-undo-bak)', true);
    } catch (e) { rec('pre-manifest-bom', manifest, 'strip the UTF-8 BOM', false, e); }
  }
  for (const p of [filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' }), filePath(cfg, { root: 'home', rel: 'cordis.patch.yml' })]) {
    try {
      if (!(await pathExists(p))) continue;
      const raw = await fs.readFile(p);
      let text = raw.toString('utf8');
      const stripped = hasBom(raw);
      if (stripped) text = text.replace(/^\uFEFF/, '');
      const dups = duplicateLoaderItems(scanLoaderItems(text));
      const kill = new Set();
      let dropped = 0;
      for (const d of dups) for (const it of d.drop) for (let i = it.start; i <= it.end; i++) { kill.add(i); dropped++; }
      if (!stripped && kill.size === 0) continue;
      const next = kill.size > 0 ? text.split('\n').filter((_, i) => !kill.has(i)).join('\n') : text;
      await fs.copyFile(p, `${p}.dsh-undo-bak`);
      await fs.writeFile(p, next, 'utf8');
      const what = [
        stripped ? 'stripped the UTF-8 BOM' : null,
        kill.size > 0 ? `dropped ${dropped} duplicate loader line(s) from ${dups.length} duplicated id(s), the last entry of each id is kept` : null,
      ].filter(Boolean).join('; ');
      rec('pre-loader-id', p, `${what} (backup: cordis.patch.yml.dsh-undo-bak)`, true);
    } catch (e) { rec('pre-loader-id', p, 'repair the patch file', false, e); }
  }
  for (const root of [join(home, 'node_modules'), join(home, 'profiles', 'node_modules')]) {
    for (const l of await listLinks(root)) {
      if (l.ok || l.name !== 'dsh-undo-savepoint') continue;
      try {
        await removeLink(l.path);
        await makeLink(PLUGIN_ROOT, l.path);
        rec('pre-link-dangling', l.path, `re-pointed at ${PLUGIN_ROOT}`, true);
      } catch (e) { rec('pre-link-dangling', l.path, `re-point at ${PLUGIN_ROOT}`, false, e); }
    }
  }
  for (const dir of await profileDirs(cfg)) {
    let pkg = null;
    try { pkg = JSON.parse((await fs.readFile(join(dir, 'package.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch { continue; }
    for (const [dep, spec] of Object.entries(pkg?.dependencies ?? {})) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue;
      const target = resolve(dir, spec.slice(5));
      const rel = dep.split('/');
      const candidates = [join(dir, 'node_modules', ...rel), join(home, 'profiles', 'node_modules', ...rel)];
      let linked = false;
      for (const p of candidates) if (await pathExists(p)) { linked = true; break; }
      if (!(await pathExists(target)) || linked) continue;
      const linkPath = candidates[0];
      try {
        await removeLink(linkPath);
        await makeLink(target, linkPath);
        rec('pre-link-missing', linkPath, `recreated the junction to ${target}`, true);
      } catch (e) { rec('pre-link-missing', linkPath, `recreate the junction to ${target}`, false, e); }
    }
  }
  const report = await runDoctor(cfg);
  return {
    ok: report.ok,
    snapshotId,
    applied,
    fixed: applied.filter((a) => a.ok).length,
    failed: applied.filter((a) => !a.ok).length,
    before: { ok: before.ok, summary: before.summary, fixable: before.fixable },
    report,
  };
}

// ══ v0.5.0 W34：doctor 环境预检两项（长路径风险 + Node 能力）══════════════
// 两项都只读、只提示，不进 runDoctorFix：路径长度与 Node 安装都不是插件可代修的
// 范畴，与 0.5.0「主动发现、不越权动手」的边界一致。

/** undo_scan 的会话修复能力所需的最低 Node 主次版本（文案里的 22.15 即此值）。 */
const MIN_SCAN_NODE = [22, 15];

/** 解析版本串为 [major, minor]（无法解析返回 null）。 */
function parseMajorMinor(version) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** 比较 [major, minor] 是否低于阈值。 */
function belowVersion(mm, min) {
  if (!mm) return false; // 解析不出来就不报，避免误报
  return mm[0] < min[0] || (mm[0] === min[0] && mm[1] < min[1]);
}

/** win32 上快照文件的实测最长路径长度；非 win32 返回 null（不做该检查）。 */
function longestSnapshotPath(cfg, home, dirs, platform) {
  if (platform !== 'win32') return null;
  // 层级：home / profiles / <name> / node_modules / <pkg> 之外的快照树：
  // undo-snapshots[/<profile>]/<manual|auto>/<id>/ 再加一个 blob 文件名（40 字符 hex）
  const profileName = String(cfg?.profileName ?? 'web');
  const bases = [join(home, 'undo-snapshots'), join(home, 'undo-snapshots', profileName)];
  let longest = 0;
  for (const b of bases) {
    for (const sub of ['manual', 'auto']) {
      const p = join(b, sub, '20260919-210712-ffff', 'blobs', '0'.repeat(40));
      if (p.length > longest) longest = p.length;
    }
  }
  return longest;
}

// T-07：快照敏感文件明文审计（只读）。0.4.9 把 home 级 settings.yaml 纳入
// 脱敏之前的历史快照可能存有明文令牌；按敏感文件清单 + 秘密形态正则逐快照
// 检查，报告「哪个快照的哪个文件里有几处什么形态的疑似明文」。
const SECRET_SHAPES = [
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9]{16,}/g },
  { kind: 'gh-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  // 通用键值形态：负向前瞻排除脱敏占位值（含 redact 字样，大小写不敏感）
  { kind: 'generic-secret', re: /\b(?:token|secret|password|api[_-]?key)\b['"]?\s*[:=]\s*['"]?(?![^\s'"]*redact)[^\s'"]{8,}/gi },
];
async function auditSnapshots(cfg) {
  const list = await listSnapshots(cfg);
  const findings = [];
  for (const snap of list) {
    for (const f of (snap.files ?? [])) {
      if (!SENSITIVE_DESTS.has(f.name)) continue;
      let text = '';
      try { text = await fs.readFile(join(snap._dir, f.name), 'utf8'); } catch { continue; }
      for (const shape of SECRET_SHAPES) {
        const hits = [...text.matchAll(shape.re)].length;
        if (hits > 0) findings.push({ snapshot: snap.id, time: snap.time, file: f.name, kind: shape.kind, count: hits });
      }
    }
  }
  return { ok: findings.length === 0, scanned: list.length, findings };
}

// F1 · 会话普查：浅层（代际分布/体积/零字节异常）+ 深层（结构分类，同 undo_scan 链）。
// 代际桶 v3 = generation >= 3（v1 不存在于 DSH 命名序列）。浅层不读文件内容，启动期安全；
// 深层供升级报告与 doctor 使用，启动体检不调用。Node 无 zstd API 时深层保持 null。
async function sessionCensus(cfg, opts = {}) {
  const deep = opts.deep === true;
  const root = join(cfg.homeDir ?? DSH_HOME, 'sessions');
  const paths = await walkSessionFiles(cfg);
  const byGeneration = { v0: 0, v2: 0, v3: 0 };
  const anomalous = [];
  let bytes = 0;
  for (const p of paths) {
    const gen = parseSessionLogZstdName(basename(p))?.generation ?? -1;
    if (gen === 0) byGeneration.v0++;
    else if (gen === 2) byGeneration.v2++;
    else if (gen >= 3) byGeneration.v3++;
    let size = 0;
    try { size = (await fs.stat(p)).size; } catch { /* 文件消失即忽略 */ }
    bytes += size;
    if (size === 0) anomalous.push({ path: p, reason: 'zero-byte session log' });
  }
  const out = { root, total: paths.length, byGeneration, bytes, anomalous, deep: null };
  if (deep && paths.length > 0) {
    try { assertZstd(); } catch { return out; } // Node 无 zstd API：深层静默缺省
    let ok = 0, fixable = 0, corrupt = 0;
    for (const p of paths) {
      try {
        const a = analyzeSessionBytes(await fs.readFile(p));
        if (a.status === 'ok') ok++;
        else if (a.status === 'fixable') fixable++;
        else corrupt++;
      } catch { corrupt++; }
    }
    out.deep = { ok, fixable, corrupt };
  }
  return out;
}

// F1 · 磁盘占用：快照仓库 + 会话目录体积，与文件系统剩余空间。
// fs.statfs 为 Node 内置（18.15+ 三平台可用），不破零依赖约束。
async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { total += (await fs.stat(p)).size; } catch { /* 单文件失败跳过 */ }
      }
    }
  }
  return total;
}

// 探测链 manualDir → DSH_HOME：目录不存在或平台异常时逐级回退，全失败为 null，
// 调用方按可缺省处理（不因取不到剩余空间而失败）。
async function diskUsage(cfg) {
  const storeBytes = (await Promise.all(storeDirs(cfg).map(dirSize))).reduce((a, b) => a + b, 0);
  const sessionsBytes = await dirSize(join(cfg.homeDir ?? DSH_HOME, 'sessions'));
  let freeBytes = null;
  let usedPct = null;
  for (const probe of [cfg.manualDir, DSH_HOME]) {
    try {
      const st = await fs.statfs(probe);
      freeBytes = st.bavail * st.bsize;
      usedPct = st.blocks > 0 ? Math.round((1 - st.bavail / st.blocks) * 100) : null;
      break;
    } catch { /* 下一候选 */ }
  }
  return { storeBytes, sessionsBytes, freeBytes, usedPct };
}

// F1 · 补丁状态聚合：包装 patchVerify 为计数形态（applied/unmatched/reason）。
async function patchStatus(cfg) {
  try {
    const pv = await patchVerify(cfg);
    const missing = Array.isArray(pv?.missing) ? pv.missing.length : 0;
    const unmatched = typeof pv?.reason === 'string' && pv.reason.startsWith('unmatched:') ? 1 : 0;
    return { ok: pv?.ok === true && missing === 0, missing, unmatched, reason: pv?.reason ?? (pv?.ok === true ? 'ok' : 'unchecked') };
  } catch (error) {
    return { ok: false, missing: 0, unmatched: 0, reason: `error: ${String(error?.message ?? error)}` };
  }
}

// F1 · 体检聚合：会话普查 + 快照覆盖 + 补丁状态 + 磁盘占用 → 一份报告。
// 静默策略：findings 为空 = 正常（调用方不输出任何东西）。
async function healthCheck(cfg, opts = {}) {
  const sessions = await sessionCensus(cfg, { deep: opts.deep === true });
  const disk = await diskUsage(cfg);
  const patches = await patchStatus(cfg);
  const list = await listSnapshots(cfg);
  const now = Date.now();
  let lastSnapshotAt = null;
  for (const s of list) {
    const tms = Date.parse(s.time);
    if (!Number.isNaN(tms) && (lastSnapshotAt === null || tms > lastSnapshotAt)) lastSnapshotAt = tms;
  }
  const lastSnapshotAgeMin = lastSnapshotAt === null ? null : Math.round((now - lastSnapshotAt) / 60000);
  const findings = [];
  if (sessions.anomalous.length > 0) findings.push({ level: 'warn', code: 'session-anomaly', detail: `${sessions.anomalous.length} session log(s) anomalous; run undo_scan to inspect` });
  if (sessions.deep && sessions.deep.corrupt > 0) findings.push({ level: 'err', code: 'session-corrupt', detail: `${sessions.deep.corrupt} corrupt session file(s); run undo_scan quarantine=true` });
  if (list.length === 0) findings.push({ level: 'warn', code: 'snapshot-none', detail: 'no snapshots yet; create a baseline with undo_snapshot' });
  if (lastSnapshotAgeMin !== null && lastSnapshotAgeMin > 7 * 24 * 60) findings.push({ level: 'warn', code: 'snapshot-stale', detail: `last snapshot was ${Math.floor(lastSnapshotAgeMin / 1440)} day(s) ago` });
  if (patches.missing > 0) findings.push({ level: 'warn', code: 'patch-missing', detail: `${patches.missing} tolerance patch target(s) missing (${patches.reason})` });
  if (patches.unmatched > 0) findings.push({ level: 'warn', code: 'patch-unmatched', detail: `tolerance patches do not match the current DSH build (${patches.reason})` });
  if (disk.usedPct !== null && disk.usedPct >= 95) findings.push({ level: 'err', code: 'disk-tight', detail: `disk usage ${disk.usedPct}%` });
  else if (disk.usedPct !== null && disk.usedPct >= 90) findings.push({ level: 'warn', code: 'disk-tight', detail: `disk usage ${disk.usedPct}%` });
  if (disk.freeBytes !== null && disk.freeBytes < 100 * 1024 * 1024) findings.push({ level: 'err', code: 'disk-low', detail: `only ${fmtBytes(disk.freeBytes)} free` });
  return {
    ts: new Date().toISOString(),
    sessions: { root: sessions.root, total: sessions.total, byGeneration: sessions.byGeneration, bytes: sessions.bytes, anomalous: sessions.anomalous.length, deep: sessions.deep },
    snapshots: { total: list.length, lastSnapshotAt: lastSnapshotAt === null ? null : new Date(lastSnapshotAt).toISOString(), lastSnapshotAgeMin, profiles: [...new Set(list.map((s) => s.profile).filter(Boolean))] },
    patches,
    disk,
    findings,
  };
}

// ── F3 · DSH 升级护航：版本读取与状态机（持久化文件 <autoDir>/dsh-version.json）──
// 探测链：DSH_ROOT 产品树 package.json → resolveToolsRequire 解析 dsh 包 → null（静默不启用）。
async function readDshVersion() {
  if (DSH_ROOT && (await isDshProductTree(DSH_ROOT))) {
    try {
      return JSON.parse(await fs.readFile(join(DSH_ROOT, 'package.json'), 'utf8')).version ?? null;
    } catch { return null; }
  }
  try {
    const req = resolveToolsRequire();
    return req('@deepseek-ai/dsh/package.json').version ?? null;
  } catch { return null; }
}
async function readVersionState(cfg) {
  try { return JSON.parse(await fs.readFile(join(cfg.autoDir, 'dsh-version.json'), 'utf8')); } catch { return null; }
}
async function persistVersionState(cfg, state) {
  try {
    await fs.mkdir(cfg.autoDir, { recursive: true });
    await fs.writeFile(join(cfg.autoDir, 'dsh-version.json'), JSON.stringify(state, null, 2), 'utf8');
  } catch { /* 状态写失败不致命 */ }
}
// 纯函数：比对并给出决策，不改盘。changed = 有前值且与当前不同（首次记录不算升级）。
async function dshVersionGuard(cfg) {
  const current = await readDshVersion();
  const prev = await readVersionState(cfg);
  const hasPrev = prev?.lastVersion != null;
  const changed = current !== null && hasPrev && prev.lastVersion !== current;
  const state = {
    lastVersion: current,
    lastSeen: new Date().toISOString(),
    previousVersion: changed ? prev.lastVersion : prev?.previousVersion ?? null,
    upgradedAt: changed ? new Date().toISOString() : prev?.upgradedAt ?? null,
  };
  return { current, previous: state.previousVersion, changed, state };
}

export {
  readBootState,
  writeBootState,
  classifyCrash,
  candidateLogs,
  readCrashLogTail,
  crashAdvice,
  isDshProductTree,
  matchPatchesInText,
  patchVerify,
  lastGoodSnapshot,
  readSafeModeState,
  homeFingerprint,
  bundleAnchors,
  bundleCheck,
  computeSafeBundles,
  safeModeStatus,
  safeModeSet,
  runDoctor,
  profileDirs,
  listLinks,
  removeLink,
  runDoctorFix,
  auditSnapshots,
  sessionCensus,
  diskUsage,
  patchStatus,
  healthCheck,
  readDshVersion,
  dshVersionGuard,
  persistVersionState,
};
