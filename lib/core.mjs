/**
 * dsh-undo-savepoint: shared core engine (V0.4.0, P2 全平台总纲 D2/D8).
 *
 * 目的：把"快照/撤销/恢复/清理/导出导入/安全模式/崩溃归因/diff/设置/脱敏"这套
 * 纯逻辑从 lib/index.js 抽到本模块，局内（index.js，经 ctx/tools/webServer 包装）
 * 与局外（tools/undo-server.mjs，独立本地服务器）共用同一份、被三平台 CI 验证的
 * 引擎，根治"双实现漂移"。
 *
 * 边界（与 index.js 的职责划分）：
 * - 本模块：只依赖 node 内置 + lib/i18n.mjs，零 npm 依赖；所有函数以 `cfg`
 *   （一个纯数据对象）为输入，做快照/恢复/清理/安全模式等操作。**不含**任何
 *   ctx / tool 注册 / watcher / systemPrompt / REST 路由 / WebUI 装配。
 * - index.js：DSH 运行时外壳（defineTool 包装、context.inject、watcher、REST、
 *   systemPrompt section、启动自检）。启动时把 `setTurnProvider(hasOpenTurn)`
 *   注入本模块，使"会话运行中拒绝撤销/安全模式"守卫在局内有效；局外服务器不
 *   注入（默认无会话 → 放行）。
 * - 纯搬家（P1）：本模块先完整承接原 index.js 的纯逻辑，行为零变化；smoke 180
 *   全绿 + e2e 10 全绿为门槛。
 *
 * @module dsh-undo-savepoint/core
 */
import { createRequire } from 'node:module';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { homedir } from 'node:os';
// 多语言（V0.3.9 R7）：唯一词典源 lib/i18n/{zh,en}.json，经零依赖 t() 翻译。
import { t } from './i18n.mjs';
// 零依赖 ZIP（V0.4.0 M1）：导出/导入用纯 Node 实现，跨三平台、与 PowerShell 双向互通。
import { writeZip, readZip } from './zip.mjs';
import {
  DSH_HOME,
  LEGACY_ROOT,
  SETTINGS_FILE,
  EXPORT_ROOT,
  TOOLS_DIR,
  PLUGIN_ROOT,
  DEFAULT_SETTINGS,
  loadSpec,
  FILE_SPECS,
  WATCHED_BASENAMES,
  SENSITIVE_DESTS,
  setTurnProvider,
  hasOpenTurn,
  busyError,
  DSH_ROOT,
  resolveToolsRequire,
  isCodeFile,
  sha1Hex,
  blobDir,
  readBlob,
  writeBlob,
  safeRel,
  redactEnvContent,
  redactYamlContent,
  isRedacting,
  vaultDir,
  writeVault,
  readVault,
  redactByDest,
  snapSensitiveBuf,
  rootDir,
  filePath,
  destName,
  findSpec,
  fmtBytes,
  makeId,
  pathExists,
  loadSettingsFile,
  detectProfileName,
  resolveStoreRoots,
  buildConfig,
  readManifest,
  writeManifest,
  storeDirs,
  discoverPlugins,
  collectPluginTree,
  collectProfileCodeRefs,
  isPluginEcho,
} from './base.mjs';
import {
  zstdUnavailable,
  assertZstd,
  zstdScanFrames,
  zstdDecodeAll,
  analyzeSessionBytes,
  recodeSessionBytes,
  walkSessionFiles,
  parseSessionLogZstdName,
} from './session.mjs';
import {
  preflightSnapshot,
  canResolveAny,
  createSnapshot,
  listSnapshots,
  dirLabel,
  findSnapshot,
  setSnapshotMeta,
  pruneAuto,
  pruneOrphanBlobs,
} from './snapshot.mjs';
import {
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
} from './health.mjs';

async function stateOf(snap) {
  const pairs = [];
  for (const file of (snap.files ?? [])) {
    if (SENSITIVE_DESTS.has(file.name) && snap.envVaultRefs?.[file.name]) {
      pairs.push([file.name, snap.envVaultRefs[file.name]]);
      continue;
    }
    try {
      const buf = await fs.readFile(join(snap._dir, file.name));
      pairs.push([file.name, sha1Hex(buf)]);
    } catch { /* missing file: skip */ }
  }
  for (const p of (snap.plugins ?? [])) {
    for (const f of (p.files ?? [])) pairs.push([`plugin:${p.name}/${f.path}`, f.hash]);
  }
  for (const f of (snap.profileFiles ?? [])) {
    if (f.hash) pairs.push([`profile:${f.path}`, f.hash]);
  }
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function currentState(cfg) {
  const pairs = [];
  for (const spec of FILE_SPECS) {
    const p = filePath(cfg, spec);
    try {
      const buf = await fs.readFile(p);
      pairs.push([destName(spec), sha1Hex(buf)]);
    } catch { /* absent */ }
  }
  for (const p of await discoverPlugins(cfg)) {
    const tree = await collectPluginTree(cfg, p.dir);
    for (const f of tree.files) pairs.push([`plugin:${p.name}/${f.rel}`, f.hash]);
  }
  for (const f of await collectProfileCodeRefs(cfg)) {
    pairs.push([`profile:${f.path}`, f.hash]);
  }
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
function sameState(a, b) {
  return a.length === b.length && a.every(([n, h], i) => b[i]?.[0] === n && b[i]?.[1] === h);
}

// ── 恢复 / 回滚 ───────────────────────────────────────────────────────────
async function renameWithRetry(src, dest, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      if (i >= attempts - 1 || !['EPERM', 'EBUSY', 'EEXIST'].includes(err?.code)) throw err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}
async function applySnapshot(cfg, snap) {
  const restored = [];
  const missing = [];
  const notes = [];
  const hashes = new Map();
  for (const file of (snap.files ?? [])) {
    const spec = findSpec(file.name);
    if (!spec) continue;
    const src = join(snap._dir, file.name);
    if (!(await pathExists(src))) continue;
    let buf = await fs.readFile(src);
    let sensitiveNote = null;
    if (SENSITIVE_DESTS.has(file.name)) {
      const ref = snap.envVaultRefs?.[file.name];
      if (ref) {
        const real = await readVault(cfg, ref);
        if (real) buf = real;
        else sensitiveNote = `${file.name}: vault missing — redacted placeholder restored, please fill in the real values`;
      } else if (snap.sensitiveMode === 'redact') {
        sensitiveNote = `${file.name}: restored as redacted placeholder (values were stripped from this snapshot)`;
      }
    }
    const target = filePath(cfg, spec);
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.undo-tmp`;
    // 增强写入即 0600：消除"先按默认 umask(0644) 落盘、恢复完才 chmod"的短暂窗口
    const sensitive = SENSITIVE_DESTS.has(file.name);
    await fs.writeFile(tmp, buf, sensitive ? { mode: 0o600 } : undefined);
    await renameWithRetry(tmp, target);
    // #17: 恢复的敏感文件必须保持 owner-only(0600),否则 credentials-local
    // 在 POSIX 上拒绝启动(默认 umask 会让 writeFile 写出 0644)。
    if (SENSITIVE_DESTS.has(file.name)) {
      try { await fs.chmod(target, 0o600); } catch { /* 平台不支持则忽略 */ }
    }
    hashes.set(file.name, sha1Hex(buf));
    restored.push(file.name);
    if (sensitiveNote) notes.push(sensitiveNote);
  }
  const liveDirs = new Set((await discoverPlugins(cfg)).map((p) => p.dir));
  for (const p of (snap.plugins ?? [])) {
    if (!safeRel(p.name) || !liveDirs.has(p.dir)) {
      missing.push(`plugin ${p.name}: directory no longer present (${p.dir})`);
      continue;
    }
    for (const f of (p.files ?? [])) {
      if (!safeRel(f.path)) { missing.push(`${p.name}/${f.path}: unsafe path, skipped`); continue; }
      const buf = await readBlob(cfg, f.hash);
      if (!buf) { missing.push(`${p.name}/${f.path}: snapshot blob missing`); continue; }
      const target = join(p.dir, f.path);
      await fs.mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.undo-tmp`;
      await fs.writeFile(tmp, buf);
      await renameWithRetry(tmp, target);
      const key = `plugin:${p.name}/${f.path}`;
      hashes.set(key, f.hash);
      restored.push(key);
    }
  }
  for (const f of (snap.profileFiles ?? [])) {
    if (!f.hash || !safeRel(f.path)) continue;
    const buf = await readBlob(cfg, f.hash);
    if (!buf) { missing.push(`profile:${f.path}: snapshot blob missing`); continue; }
    const target = join(rootDir(cfg, 'profile'), f.path);
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.undo-tmp`;
    await fs.writeFile(tmp, buf);
    await renameWithRetry(tmp, target);
    const key = `profile:${f.path}`;
    hashes.set(key, f.hash);
    restored.push(key);
  }
  cfg.restoredHashes = hashes;
  return { restored, missing, notes };
}

const DEPENDENCY_FILES = new Set(['profile-package.json', 'profile-pnpm-lock.yaml', 'profile-pnpm-workspace.yaml']);
function testNeedsRestart(restored) {
  return restored.some((n) => n === 'profile-cordis.patch.yml' || n === 'profile-package.json' || n.startsWith('plugin:') || n.startsWith('profile:'));
}
function runPnpm(args, cwd) {
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    execFile(windows ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm', windows ? ['/d', '/s', '/c', 'pnpm', ...args] : args, {
      cwd,
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const tail = (value) => String(value ?? '').slice(-4000);
      resolve({
        ok: error == null,
        code: typeof error?.code === 'string' ? error.code : (error == null ? 0 : 1),
        stdout: tail(stdout),
        stderr: tail(stderr),
        error: error == null ? '' : String(error.message ?? error),
      });
    });
  });
}
async function reconcileDependencies(cfg, restored, syncDeps) {
  const touched = restored.some((name) => DEPENDENCY_FILES.has(name));
  if (!touched) return { touched: false, synced: false };
  const profileDir = rootDir(cfg, 'profile');
  if (syncDeps !== true) {
    return {
      touched: true,
      synced: false,
      note: `dependency state may be out of sync — run 'dsh plugin --profile ${cfg.profileName} install' (or 'pnpm install --frozen-lockfile' in ${profileDir})`,
    };
  }
  const lockPath = join(profileDir, 'pnpm-lock.yaml');
  const args = (await pathExists(lockPath)) ? ['install', '--frozen-lockfile'] : ['install'];
  const startedAt = Date.now();
  const result = await runPnpm(args, profileDir);
  const command = `pnpm ${args.join(' ')}`;
  return {
    touched: true,
    synced: result.ok,
    command,
    profileDir,
    durationMs: Date.now() - startedAt,
    ...result,
    note: result.ok
      ? `dependencies synced (${command})`
      : `dependency sync failed (${command}): ${result.stderr || result.error}`,
  };
}

/** 把 ensureMount 写入 cordis.patch.yml 后的内容哈希登记到 restoredHashes，
 *  使 watcher 的内容 echo 检测能识别"这是 restore 自身的挂载管理写，而非用户变更"，
 *  避免 macOS 等平台延迟投递的事件产生挡住 redo 的回声快照。 */
function recordMountHash(cfg, text) {
  try {
    if (cfg?.restoredHashes && typeof cfg.restoredHashes.set === 'function') {
      cfg.restoredHashes.set(destName({ root: 'profile', rel: 'cordis.patch.yml' }), sha1Hex(Buffer.from(text, 'utf8')));
    }
  } catch { /* noop */ }
}

/** 保持插件挂载：bundle 模式去除手工 patch 重复挂载；patch 模式补挂载行。 */
async function ensureMount(cfg) {
  const patch = filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' });
  if (!(await pathExists(patch))) return false;
  let text = await fs.readFile(patch, 'utf8');
  let bundleMode = false;
  try {
    const pkg = JSON.parse(await fs.readFile(filePath(cfg, { root: 'profile', rel: 'package.json' }), 'utf8'));
    bundleMode = Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('dsh-undo-savepoint');
  } catch { /* profile package.json missing/unreadable: treat as patch mode */ }
  if (bundleMode) {
    const marker = '# dsh-undo-savepoint mount';
    const idx = text.indexOf(marker);
    if (idx >= 0) {
      const rel = text.indexOf('name: dsh-undo-savepoint', idx);
      let end = rel >= 0 ? text.indexOf('\n', rel) : text.indexOf('\n', idx);
      if (end >= 0) end += 1;
      let start = idx;
      if (text[start - 1] === '\n' && text[start - 2] === '\n') start -= 1;
      if (end > start) {
        const newText = text.slice(0, start) + text.slice(end);
        await fs.writeFile(patch, newText, 'utf8');
        recordMountHash(cfg, newText);
        return true;
      }
    }
    return false;
  }
  if (text.includes('dsh-undo-savepoint')) return false;
  text = text.replace(/^\s*\[\]\s*$/m, '');
  const block = `\n# dsh-undo-savepoint mount (re-ensured by dsh-undo-savepoint)\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n`;
  const newText = text.replace(/\s*$/, '') + block;
  await fs.writeFile(patch, newText, 'utf8');
  recordMountHash(cfg, newText);
  return true;
}

/** I12 启动去重自愈：保留 canonical 挂载（bundle > profile patch > home patch）。 */
async function dedupeMount(cfg) {
  const found = [];
  const profilePatchPath = filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' });
  const homePatchPath = filePath(cfg, { root: 'home', rel: 'cordis.patch.yml' });
  const pkgPath = filePath(cfg, { root: 'profile', rel: 'package.json' });
  const hasMount = async (p) => (await pathExists(p)) && (await fs.readFile(p, 'utf8')).includes('dsh-undo-savepoint');
  if (await pathExists(profilePatchPath)) {
    const text = await fs.readFile(profilePatchPath, 'utf8');
    if (text.includes('dsh-undo-savepoint')) found.push({ location: profilePatchPath, kind: 'profile-patch' });
    for (const m of text.matchAll(/^\s*-\s*include:\s*['"]?([^'"\s#]+)/gm)) {
      const inc = join(rootDir(cfg, 'profile'), m[1].replace(/[\\/]$/, ''));
      if (await hasMount(inc)) found.push({ location: inc, kind: 'profile-patch' });
    }
  }
  if (await hasMount(homePatchPath)) found.push({ location: homePatchPath, kind: 'home-patch' });
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    if (Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('dsh-undo-savepoint')) {
      found.push({ location: pkgPath, kind: 'bundle' });
    }
  } catch { /* package.json 缺失/损坏：bundle 面视为无 */ }
  if (found.length <= 1) return { found: found.length, kept: null, removed: [] };
  const rank = { bundle: 3, 'profile-patch': 2, 'home-patch': 1 };
  const kept = found.reduce((a, b) => (rank[a.kind] >= rank[b.kind] ? a : b));
  const removed = [];
  for (const m of found) {
    if (m.location === kept.location) continue;
    const bak = `${m.location}.dsh-undo-bak`;
    if (!(await pathExists(bak))) await fs.copyFile(m.location, bak);
    if (m.kind === 'bundle') {
      const pkg = JSON.parse(await fs.readFile(m.location, 'utf8'));
      pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles ?? []).filter((n) => n !== 'dsh-undo-savepoint');
      await fs.writeFile(m.location, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    } else {
      await removeMountBlock(m.location);
    }
    removed.push(m.location);
  }
  return { found: found.length, kept: kept.location, removed };
}
async function removeMountBlock(file) {
  let text = await fs.readFile(file, 'utf8');
  const marker = '# dsh-undo-savepoint mount';
  if (text.includes(marker)) {
    const idx = text.indexOf(marker);
    const rel = text.indexOf('name: dsh-undo-savepoint', idx);
    let end = rel >= 0 ? text.indexOf('\n', rel) : text.indexOf('\n', idx);
    if (end >= 0) end += 1;
    let start = idx;
    if (text[start - 1] === '\n' && text[start - 2] === '\n') start -= 1;
    if (end > start) text = text.slice(0, start) + text.slice(end);
  } else {
    const lines = text.split('\n');
    const items = [];
    let cur = null;
    for (const line of lines) {
      if (/^\s*-\s+/.test(line)) {
        if (cur) items.push(cur);
        cur = [line];
      } else if (cur && /^\s+\S/.test(line)) {
        cur.push(line);
      } else {
        if (cur) { items.push(cur); cur = null; }
        items.push([line]);
      }
    }
    if (cur) items.push(cur);
    // 丢掉含本插件的 list item（连同其缩进子行）
    const kept = items.filter((it) => !it.some((l) => l.includes('dsh-undo-savepoint')));
    // 丢掉空壳：子行被摘光后只剩 `- insert:`，且其后不是新的列表项（空行也算无子行）
    const out = [];
    for (let i = 0; i < kept.length; i += 1) {
      const it = kept[i];
      if (/^\s*-\s+insert:\s*$/.test(it[0])) {
        const next = kept[i + 1];
        const nextStartsItem = !!next && /^\s*-\s+/.test(next[0]);
        const nextBlank = !next || next.every((l) => l.trim() === '');
        if (!nextStartsItem || nextBlank) continue;
      }
      out.push(...it);
    }
    text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  }
  await fs.writeFile(file, text.replace(/\s+$/, '') + '\n', 'utf8');
}

// ── W32 一键卸载：列出 / 执行本插件的全部落盘产物 ─────────────────────────
// 插件落盘六处：npm 包目录（不归本工具，交给 npm uninstall）/ profile junction × N /
// stateDir（设置与状态）/ 快照库 / 桌面快捷方式 / patch 与 bundle 挂载声明。
// 默认温和：只摘挂载声明、junction、快捷方式；purge=true 才连状态目录与快照库一起删。
// junction 一律走 removeLink（只删链接本体，不跟随目标），避免 Windows 下递归进插件源码。

/** 待清理的 profile 目录列表（显式 profile 只给一个；否则扫 profiles/）。 */
async function uninstallTargetProfileDirs(cfg, opts) {
  if (opts.profile) return [join(rootDir(cfg, 'home'), 'profiles', opts.profile)];
  const dirs = await profileDirs(cfg);
  return dirs.length ? dirs : [rootDir(cfg, 'profile')];
}

/**
 * 规划卸载动作（只读，不删任何东西）。
 * @returns {Promise<{home:string, plan:Array, notes:string[]}>} plan 每项 {what, path, target?}
 *   what ∈ junction | shortcut | mount declaration | mount declaration (bundle) | state dir | snapshot library
 */
async function planUninstall(cfg, opts = {}) {
  const listLinksFn = opts.listLinks ?? listLinks;
  const home = rootDir(cfg, 'home');
  const dirs = await uninstallTargetProfileDirs(cfg, opts);
  const plan = [];
  const notes = [];

  // 1. 挂载声明：各 profile 的 patch / bundle 数组 + home 级 patch
  const decls = [];
  for (const d of dirs) {
    decls.push({ path: join(d, 'cordis.patch.yml'), kind: 'patch' });
    decls.push({ path: join(d, 'package.json'), kind: 'bundle' });
  }
  decls.push({ path: join(home, 'cordis.patch.yml'), kind: 'patch' });
  for (const d of decls) {
    if (!(await pathExists(d.path))) continue;
    if (d.kind === 'bundle') {
      let pkg;
      try { pkg = JSON.parse((await fs.readFile(d.path, 'utf8')).replace(/^\uFEFF/, '')); } catch { continue; }
      const bundles = pkg?.dsh?.profile?.bundles;
      if (Array.isArray(bundles) && bundles.includes('dsh-undo-savepoint')) {
        plan.push({ what: 'mount declaration (bundle)', path: d.path });
      }
      continue;
    }
    const text = await fs.readFile(d.path, 'utf8');
    if (text.includes('dsh-undo-savepoint')) plan.push({ what: 'mount declaration', path: d.path });
  }

  // 2. junction（每个 profile 的 node_modules 与 home 级 node_modules 各扫一层）
  const roots = dirs.map((d) => join(d, 'node_modules'));
  roots.push(join(home, 'node_modules'));
  for (const r of roots) {
    if (!(await pathExists(r))) continue;
    for (const link of await listLinksFn(r)) {
      const t = String(link.target ?? '').toLowerCase();
      const n = String(link.name ?? '').toLowerCase();
      if (t.includes('dsh-undo-savepoint') || n.includes('dsh-undo-savepoint')) {
        plan.push({ what: 'junction', path: link.path, target: link.target ?? null });
      }
    }
  }

  // 3. 桌面快捷方式（按平台文件名，找不到即跳过）
  const desktopDir = opts.desktopDir ?? cfg.desktopDir ?? (await resolveDesktopDir());
  const sp = desktopShortcutPlan({ desktopDir });
  if (await pathExists(sp.path)) plan.push({ what: 'shortcut', path: sp.path });

  // 4. --purge：状态目录 + 快照库（快照库 = manualDir/autoDir 的父目录，兼容旧平铺）
  if (opts.purge) {
    const snapRoots = new Set([LEGACY_ROOT]);
    for (const d of dirs) {
      const name = String(d).split(/[\\/]/).filter(Boolean).pop();
      const sr = resolveStoreRoots(name);
      snapRoots.add(dirname(sr.manualDir));
      snapRoots.add(dirname(sr.autoDir));
    }
    const seen = new Set();
    const items = [{ what: 'state dir', path: join(home, 'undo') }];
    for (const r of snapRoots) items.push({ what: 'snapshot library', path: r });
    // 去重，并丢掉已被祖先目录覆盖的更深路径（如 root 与 root\profile 只留 root）
    const deduped = [];
    for (const it of items) {
      const norm = it.path.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      const covered = items.some((o) => {
        if (o === it) return false;
        const on = o.path.toLowerCase();
        return norm.startsWith(on + '\\') || norm.startsWith(on + '/');
      });
      if (covered) continue;
      deduped.push(it);
    }
    for (const it of deduped) {
      if (await pathExists(it.path)) plan.push(it);
    }
  } else {
    notes.push(`kept: undo-snapshots (use --purge)`);
  }
  return { home, plan, notes };
}

/** 判断 patch 摘除后是否已无实质内容（空文件、只剩注释，或只剩空数组/空 insert 壳）。 */
function isPatchEffectivelyEmpty(text) {
  return String(text)
    .replace(/^\uFEFF/, '') // Windows 编辑器常存 UTF-8 BOM，不剥掉会让 ^# 行首锚点失配
    .replace(/^#[^\n]*$/gm, '')
    .replace(/\s|\[|\]/g, '')
    .replace(/-\s*insert:/g, '')
    .replace(/-/g, '') === '';
}

/**
 * 执行 planUninstall 的结果。逐项独立 try/catch，单项失败不影响其余。
 * 不产出「保留了什么」的提示：那是 planUninstall 的职责（opts.purge 语义），
 * 执行器只报告自己改变的东西（例如摘空后被删除的 patch）。
 * @returns {Promise<{removedMount:number, removedJunction:number, removedShortcut:number, removedOther:number, failed:number, notes:string[], errors:Array}>}
 */
async function applyUninstall(plan) {
  const r = { removedMount: 0, removedJunction: 0, removedShortcut: 0, removedOther: 0, failed: 0, notes: [], errors: [] };
  for (const p of plan) {
    try {
      if (p.what === 'junction') {
        await removeLink(p.path);
        r.removedJunction += 1;
      } else if (p.what === 'shortcut') {
        await fs.rm(p.path, { force: true });
        r.removedShortcut += 1;
      } else if (p.what === 'mount declaration') {
        await removeMountBlock(p.path);
        const left = await fs.readFile(p.path, 'utf8');
        if (isPatchEffectivelyEmpty(left)) {
          await fs.rm(p.path, { force: true });
          r.notes.push(`emptied patch removed: ${p.path}`);
        }
        r.removedMount += 1;
      } else if (p.what === 'mount declaration (bundle)') {
        const pkg = JSON.parse((await fs.readFile(p.path, 'utf8')).replace(/^\uFEFF/, ''));
        pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles ?? []).filter((n) => n !== 'dsh-undo-savepoint');
        await fs.writeFile(p.path, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        r.removedMount += 1;
      } else {
        await fs.rm(p.path, { recursive: true, force: true });
        r.removedOther += 1;
      }
    } catch (e) {
      r.failed += 1;
      r.errors.push({ what: p.what, path: p.path, error: String(e?.message ?? e) });
    }
  }
  return r;
}

async function markFlag(snap, flag, value) {
  if (!(await pathExists(join(snap._dir, 'manifest.json')))) return;
  snap[flag] = value;
  await writeManifest(snap._dir, snap);
}
async function migrateLegacy(cfg) {
  if (!(await pathExists(LEGACY_ROOT))) return 0;
  let moved = 0;
  for (const entry of await fs.readdir(LEGACY_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(LEGACY_ROOT, entry.name);
    const mf = join(dir, 'manifest.json');
    if (!(await pathExists(mf))) continue;
    let kind;
    try { kind = (await readManifest(dir)).kind; } catch { continue; }
    const dest = kind === 'manual' ? cfg.manualDir : cfg.autoDir;
    await fs.mkdir(dest, { recursive: true });
    await fs.rename(dir, join(dest, entry.name));
    moved++;
  }
  return moved;
}
function classifyChange(names) {
  if (names.some((n) => n === 'package.json')) return 'plugin-change';
  if (names.some((n) => n === 'cordis.patch.yml')) return 'patch-change';
  if (names.some((n) => n === 'settings.yaml')) return 'settings-change';
  return 'config-change';
}

// ── diff（结构化 + 简单行级）────────────────────────────────────────────
async function diffSnapshotStructured(cfg, snap) {
  const out = [];
  for (const spec of FILE_SPECS) {
    const src = filePath(cfg, spec);
    const name = destName(spec);
    const snapPath = join(snap._dir, name);
    const snapHas = await pathExists(snapPath);
    const curHas = await pathExists(src);
    if (!snapHas && !curHas) continue;
    if (snapHas && !curHas) { out.push({ name, added: 0, removed: 0, addedLines: [], removedLines: ['(file did not exist at snapshot time)'] }); continue; }
    if (!snapHas && curHas) { out.push({ name, added: 1, removed: 0, addedLines: ['(file is absent in snapshot)'], removedLines: [] }); continue; }
    let a = (await fs.readFile(snapPath, 'utf8')).split(/\r?\n/);
    let b = (await fs.readFile(src, 'utf8')).split(/\r?\n/);
    if (SENSITIVE_DESTS.has(name)) {
      a = redactByDest(name, a.join('\n')).split(/\r?\n/);
      b = redactByDest(name, b.join('\n')).split(/\r?\n/);
    }
    const setA = new Set(a); const setB = new Set(b);
    const onlyA = [...setA].filter((l) => !setB.has(l));
    const onlyB = [...setB].filter((l) => !setA.has(l));
    if (onlyA.length === 0 && onlyB.length === 0) continue;
    out.push({
      name: SENSITIVE_DESTS.has(name) ? `${name} (redacted)` : name,
      added: onlyB.length,
      removed: onlyA.length,
      addedLines: onlyB.slice(0, 8),
      removedLines: onlyA.slice(0, 8),
    });
  }
  for (const p of (snap.plugins ?? [])) {
    for (const f of (p.files ?? [])) {
      const d = diffFileContent(await readBlob(cfg, f.hash), await fs.readFile(join(p.dir, f.path)).catch(() => null));
      if (d) out.push({ name: `plugin:${p.name}/${f.path}`, ...d });
    }
  }
  for (const f of (snap.profileFiles ?? [])) {
    if (!f.hash) continue;
    const d = diffFileContent(await readBlob(cfg, f.hash), await fs.readFile(join(rootDir(cfg, 'profile'), f.path)).catch(() => null));
    if (d) out.push({ name: `profile:${f.path}`, ...d });
  }
  return out;
}

// ── 目录树 diff（V0.4.0 P4）──────────────────────────────────────────────
function buildTreeNodes(entries) {
  const root = { name: '', path: '', status: 'unchanged', children: [] };
  for (const e of entries) {
    const path = e.name.replace(/^plugin:/, '').replace(/^profile:/, '');
    const segs = path.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      let child = node.children.find((c) => c.name === seg);
      if (!child) {
        child = { name: seg, path: segs.slice(0, i + 1).join('/'), status: 'unchanged', children: [] };
        node.children.push(child);
      }
      node = child;
    }
    const status = e.removed > 0 && e.added === 0 ? 'deleted' : (e.added > 0 && e.removed === 0 ? 'added' : 'modified');
    node.status = status;
    node.fileCount = 1;
    node.added = e.added; node.removed = e.removed;
    node.addedLines = e.addedLines; node.removedLines = e.removedLines;
    node.fullName = e.name;
  }
  // 目录状态沿子节点上溯：任一子变化则目录视为 modified。
  const derive = (n) => {
    for (const c of n.children) { derive(c); if (c.status !== 'unchanged') n.status = c.status === 'deleted' && n.status === 'unchanged' ? 'deleted' : (n.status === 'unchanged' ? 'modified' : n.status); }
  };
  derive(root);
  return root.children;
}

/**
 * 目录树 diff：把 diffSnapshotStructured 的扁平结果按 配置/插件/Profile 代码 分根、
 * 再按路径段嵌套成树，供 WebUI 与局内面板做「目录树联动 + 文件级 diff」导航。
 */
async function diffTree(cfg, snap) {
  const flat = await diffSnapshotStructured(cfg, snap);
  const roots = [];
  const configs = flat.filter((e) => !e.name.startsWith('plugin:') && !e.name.startsWith('profile:'));
  const plugins = flat.filter((e) => e.name.startsWith('plugin:'));
  const profiles = flat.filter((e) => e.name.startsWith('profile:'));
  if (configs.length) roots.push({ key: 'config', label: '配置', children: buildTreeNodes(configs) });
  if (plugins.length) roots.push({ key: 'plugin', label: '插件', children: buildTreeNodes(plugins) });
  if (profiles.length) roots.push({ key: 'profile', label: 'Profile 代码', children: buildTreeNodes(profiles) });
  return roots;
}
function diffFileContent(snapBuf, curBuf) {
  if (snapBuf && !curBuf) return { added: 0, removed: 1, addedLines: [], removedLines: ['(file was deleted after snapshot)'] };
  if (!snapBuf && curBuf) return { added: 1, removed: 0, addedLines: ['(snapshot content unavailable — blob missing)'], removedLines: [] };
  if (!snapBuf && !curBuf) return null;
  const a = snapBuf.toString('utf8').split(/\r?\n/);
  const b = curBuf.toString('utf8').split(/\r?\n/);
  const setA = new Set(a); const setB = new Set(b);
  const onlyA = [...setA].filter((l) => !setB.has(l));
  const onlyB = [...setB].filter((l) => !setA.has(l));
  if (onlyA.length === 0 && onlyB.length === 0) return null;
  return { added: onlyB.length, removed: onlyA.length, addedLines: onlyB.slice(0, 8), removedLines: onlyA.slice(0, 8) };
}
async function diffSnapshot(cfg, snap) {
  const lines = [];
  for (const spec of FILE_SPECS) {
    const src = filePath(cfg, spec);
    const name = destName(spec);
    const snapPath = join(snap._dir, name);
    const snapHas = await pathExists(snapPath);
    const curHas = await pathExists(src);
    if (!snapHas && !curHas) continue;
    if (snapHas && !curHas) { lines.push(`${name}: file did not exist at snapshot time`); continue; }
    if (!snapHas && curHas) { lines.push(`${name}: NEW file (absent in snapshot)`); continue; }
    const snapBuf = SENSITIVE_DESTS.has(name) ? await snapSensitiveBuf(cfg, snap, name) : await fs.readFile(snapPath).catch(() => null);
    let a = (snapBuf ? snapBuf.toString('utf8') : '').split(/\r?\n/);
    let b = (await fs.readFile(src, 'utf8')).split(/\r?\n/);
    if (SENSITIVE_DESTS.has(name)) {
      a = redactByDest(name, a.join('\n')).split(/\r?\n/);
      b = redactByDest(name, b.join('\n')).split(/\r?\n/);
    }
    const setA = new Set(a); const setB = new Set(b);
    const onlyA = [...setA].filter((l) => !setB.has(l));
    const onlyB = [...setB].filter((l) => !setA.has(l));
    if (onlyA.length === 0 && onlyB.length === 0) continue;
    lines.push(`${name}: snapshot has ${onlyA.length} unique line(s), current has ${onlyB.length} unique line(s)`);
    if (SENSITIVE_DESTS.has(name)) lines.push(`  (sensitive values are redacted in diffs; restore pulls real values from the local vault)`);
    for (const l of onlyA.slice(0, 6)) lines.push(`  - (in snapshot) ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
    for (const l of onlyB.slice(0, 6)) lines.push(`  + (current)    ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
  }
  for (const p of (snap.plugins ?? [])) {
    for (const f of (p.files ?? [])) {
      const d = diffFileContent(await readBlob(cfg, f.hash), await fs.readFile(join(p.dir, f.path)).catch(() => null));
      if (!d) continue;
      const label = `plugin ${p.name}/${f.path}`;
      const note = [...d.removedLines, ...d.addedLines].find((l) => l.startsWith('('));
      if (note) { lines.push(`${label}: ${note}`); continue; }
      lines.push(`${label}: snapshot has ${d.removed} unique line(s), current has ${d.added} unique line(s)`);
      for (const l of d.removedLines.slice(0, 6)) lines.push(`  - (in snapshot) ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
      for (const l of d.addedLines.slice(0, 6)) lines.push(`  + (current)    ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
    }
  }
  for (const f of (snap.profileFiles ?? [])) {
    if (!f.hash) continue;
    const d = diffFileContent(await readBlob(cfg, f.hash), await fs.readFile(join(rootDir(cfg, 'profile'), f.path)).catch(() => null));
    if (!d) continue;
    const label = `profile ./${f.path}`;
    const note = [...d.removedLines, ...d.addedLines].find((l) => l.startsWith('('));
    if (note) { lines.push(`${label}: ${note}`); continue; }
    lines.push(`${label}: snapshot has ${d.removed} unique line(s), current has ${d.added} unique line(s)`);
    for (const l of d.removedLines.slice(0, 6)) lines.push(`  - (in snapshot) ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
    for (const l of d.addedLines.slice(0, 6)) lines.push(`  + (current)    ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no differences)';
}

// ── undo/redo 栈 ─────────────────────────────────────────────────────────
async function undoCandidates(cfg, list) {
  const unconsumedPre = list.filter((s) => s.kind === 'pre-restore' && !s.consumed);
  const preStates = [];
  for (const p of unconsumedPre) preStates.push(await stateOf(p));
  const candidates = [];
  for (const s of list) {
    if (s.kind === 'pre-restore') continue;
    const st = await stateOf(s);
    if (preStates.some((p) => sameState(p, st))) continue;
    candidates.push({ s, st });
  }
  return candidates;
}
async function appendRollbackLog(cfg, entry) {
  try {
    const dir = dirname(cfg.settingsFile);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, 'rollback-log.jsonl');
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    let text = '';
    try { text = await fs.readFile(file, 'utf8'); } catch { /* new file */ }
    text += line;
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length > 100) text = lines.slice(lines.length - 100).join('\n') + '\n';
    await fs.writeFile(file, text, 'utf8');
  } catch { /* logging must never break rollback */ }
}

// ── 消息级撤销（V0.4.0，P6：每条 AI 消息 → 文件变更清单 → 逆序回滚）────────
function messageOpsDir(cfg) { return join(cfg.autoDir, 'message-ops'); }
async function readMessageOps(cfg, id) {
  try { return JSON.parse(await fs.readFile(join(messageOpsDir(cfg), `${id}.json`), 'utf8')); }
  catch { return null; }
}
/** 追加一条工具变更 op 到指定批次；批次不存在则创建。返回更新后的批次。 */
async function appendMessageOp(cfg, batch) {
  const dir = messageOpsDir(cfg);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `${batch.batchId}.json`);
  let b = await readMessageOps(cfg, batch.batchId);
  if (!b) b = { batchId: batch.batchId, messageId: batch.messageId ?? null, startedAt: new Date().toISOString(), ops: [] };
  b.ops.push(batch.op);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(b, null, 2), 'utf8');
  await fs.rename(tmp, file);
  return b;
}
/** 列出最近批次（降序）。 */
async function listMessageOps(cfg, limit = 200) {
  const dir = messageOpsDir(cfg);
  if (!(await pathExists(dir))) return [];
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      const b = JSON.parse(await fs.readFile(join(dir, e.name), 'utf8'));
      out.push({ id: b.batchId, startedAt: b.startedAt ?? null, messageId: b.messageId ?? null, files: (b.ops ?? []).length, tools: [...new Set((b.ops ?? []).map((o) => o.tool))], ops: b.ops ?? [] });
    } catch { /* broken batch */ }
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return out.slice(0, limit);
}
/** 清理超出 keepMessageOps 的旧批次（不删 blob，blob 由快照清理统一管理）。 */
async function pruneMessageOps(cfg) {
  const keep = Number.isFinite(cfg.keepMessageOps) ? cfg.keepMessageOps : 200;
  const dir = messageOpsDir(cfg);
  if (!(await pathExists(dir))) return { removed: 0 };
  const batches = await listMessageOps(cfg, 100000);
  let removed = 0;
  for (const b of batches.slice(keep)) {
    const p = join(dir, `${b.id}.json`);
    await fs.rm(p, { force: true }); removed++;
  }
  return { removed };
}
/** 撤回一个消息批次：逆序恢复 before 内容 / 删除新建文件。 */
async function undoMessage(cfg, id) {
  const dir = messageOpsDir(cfg);
  let batch;
  if (id && id !== 'latest') batch = await readMessageOps(cfg, id);
  else { const l = await listMessageOps(cfg, 1); batch = l.length ? await readMessageOps(cfg, l[0].id) : null; }
  if (!batch) return { ok: false, error: id ? `message batch not found: ${id}` : 'no message batches recorded yet', code: 'not-found' };
  const ops = [...(batch.ops ?? [])].reverse();
  const changed = [], deleted = [], missing = [], skipped = [];
  // #34 守卫：只对每个路径在批次内"最后一次写入"做指纹比对（反向序列中该路径
  // 的首个 op）。同一批次内对同一文件的多次写入属于中间状态，不算"后续改动"，
  // 否则多写批次会恢复不到最初内容。旧批次（无 afterExists 字段）行为不变。
  const guarded = new Set();
  // #34 兜底：撤回前把批次涉及文件的当前内容写入 blob 库。即使指纹判断出错
  // （或旧批次无守卫），被覆盖/删除的内容仍可从 blobs 目录找回。过大文件
  // （>8MB）跳过备份，防内存峰值；这些 blob 不入引用清单，之后由 undoCompact 回收。
  const backedUp = new Set();
  for (const op of ops) {
    if (!op?.path || backedUp.has(op.path)) continue;
    backedUp.add(op.path);
    try {
      const st = await fs.stat(op.path);
      if (st.size > 8 * 1024 * 1024) continue;
      const buf = await fs.readFile(op.path);
      await writeBlob(cfg, sha1Hex(buf), buf);
    } catch { /* 当前不存在：无需备份 */ }
  }
  for (const op of ops) {
    try {
      if (op.afterExists !== undefined && !guarded.has(op.path)) {
        guarded.add(op.path);
        let curHash = null, curExists = true;
        try {
          const st = await fs.stat(op.path);
          // 当前文件超过指纹上限时无法比对哈希（curHash 留 null）；
          // 若批次记录过指纹而当前文件超限，本身就是"后来变大"的修改信号。
          if (st.size <= 262144) curHash = sha1Hex(await fs.readFile(op.path));
        } catch { curExists = false; }
        // 存在性翻转，或指纹可比对时不一致 → 该文件被批次之后的动作改写过 → 跳过
        const mismatch = op.afterExists !== curExists
          || (op.afterHash && curExists && curHash !== op.afterHash);
        if (mismatch) { skipped.push({ path: op.path, reason: 'modified after batch (content differs from post-execution fingerprint)' }); continue; }
      }
      if (op.beforeExists) {
        const buf = await readBlob(cfg, op.beforeHash);
        if (!buf) { missing.push({ path: op.path, reason: 'before content unavailable (blob missing)' }); continue; }
        await fs.mkdir(dirname(op.path), { recursive: true });
        const tmp = `${op.path}.u-tmp`;
        await fs.writeFile(tmp, buf);
        // v0.4.5：rename 失败（Windows 目标被占用等竞态）不再静默吞掉后仍记
        // changed——回退直接写入（内容一致，非原子）；两写都失败才报 skipped。
        let restored = false;
        try {
          await fs.rename(tmp, op.path);
          restored = true;
        } catch {
          try {
            await fs.writeFile(op.path, buf);
            restored = true;
          } catch { /* 双写失败，落到 skipped */ }
          await fs.rm(tmp, { force: true }).catch(() => { /* 残留 tmp 不影响结果 */ });
        }
        if (restored) changed.push(op.path);
        else { skipped.push({ path: op.path, reason: 'restore write failed (rename and direct write both failed)' }); continue; }
      } else {
        // 新建的文件：若当前仍存在则删除（用 try 捕获已不存在的情况）
        try { await fs.rm(op.path, { force: false }); deleted.push(op.path); } catch { skipped.push({ path: op.path, reason: 'already absent' }); }
      }
    } catch (e) {
      skipped.push({ path: op.path, reason: String(e?.message ?? e) });
    }
  }
  const notes = skipped.length ? `(skipped: ${skipped.map((s) => s.path).join(', ')})` : '';
  await appendRollbackLog(cfg, { mode: 'message-rollback', batchId: batch.batchId, messageId: batch.messageId ?? null, changed: changed.length, deleted: deleted.length, missing: missing.length, skipped: skipped.length });
  return { ok: true, batchId: batch.batchId, messageId: batch.messageId, changed, deleted, missing, skipped, notes };
}
/** 收集所有仍被引用的 blob：快照（插件/档案） + 消息批次 before 内容。 */
async function collectReferencedBlobs(cfg) {
  const refs = new Set();
  for (const s of await listSnapshots(cfg)) {
    for (const p of (s.plugins ?? [])) for (const f of (p.files ?? [])) if (f.hash) refs.add(f.hash);
    for (const f of (s.profileFiles ?? [])) if (f.hash) refs.add(f.hash);
  }
  const mdir = messageOpsDir(cfg);
  if (await pathExists(mdir)) {
    for (const e of await fs.readdir(mdir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      try { const b = JSON.parse(await fs.readFile(join(mdir, e.name), 'utf8')); for (const op of (b.ops ?? [])) if (op.beforeHash) refs.add(op.beforeHash); } catch { /* broken */ }
    }
  }
  return refs;
}
/** 孤儿 blob GC（V0.4.0，P7）：删除不被任何快照/消息批次引用的 blob 与残留 .tmp。 */
async function undoCompact(cfg) {
  const refs = await collectReferencedBlobs(cfg);
  const dir = blobDir(cfg);
  if (!(await pathExists(dir))) return { ok: true, removed: 0, freed: 0 };
  let removed = 0, freed = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const isTmp = e.name.endsWith('.tmp');
    if (!isTmp && refs.has(e.name)) continue; // 被引用：保留
    const p = join(dir, e.name);
    try { freed += (await fs.stat(p)).size; } catch { /* gone */ }
    await fs.rm(p, { force: true }); removed++;
  }
  return { ok: true, removed, freed };
}
async function restore(cfg, mode, id, options = {}) {
  if (hasOpenTurn()) return busyError();
  const syncDeps = options.syncDeps === true;
  const list = await listSnapshots(cfg);
  if (mode === 'undo') {
    const cur = await currentState(cfg);
    const candidates = await undoCandidates(cfg, list);
    if (candidates.length === 0) return { ok: false, error: t('undo.nothing') };
    const target = candidates.find((c) => !sameState(cur, c.st)) ?? null;
    if (!target) {
      return {
        ok: true,
        unchanged: true,
        targetId: candidates[0].s.id,
        message: t('undo.alreadyMatches'),
      };
    }
    const stepped = target !== candidates[0];
    const pre = await createSnapshot(cfg, 'pre-restore', `before-restore:${target.s.id} (${target.s.kind}: ${target.s.reason ?? ''})`);
    cfg.suppressAuto++;
    try {
      const { restored, missing, notes } = await applySnapshot(cfg, target.s);
      if (stepped) await markFlag(candidates[0].s, 'stepped', true);
      const remounted = await ensureMount(cfg);
      const needsRestart = testNeedsRestart(restored);
      const deps = await reconcileDependencies(cfg, restored, syncDeps);
      const preflight = await preflightSnapshot(cfg, target.s);
      await appendRollbackLog(cfg, { mode: 'undo', targetId: target.s.id, targetKind: target.s.kind, preSnapshotId: pre.id, files: restored, missing, notes, needsRestart, deps, preflightMissing: preflight.missing });
      return { ok: true, restored, missing, notes, needsRestart, deps, preflight, targetId: target.s.id, targetKind: target.s.kind, targetReason: target.s.reason, preSnapshotId: pre.id, stepped, remounted };
    } finally {
      cfg.suppressAuto--;
    }
  }
  if (mode === 'redo') {
    const pre = list.find((s) => s.kind === 'pre-restore' && !s.consumed);
    if (!pre) return { ok: false, error: t('undo.nothingRedo') };
    const newer = list.find((s) => s.time > pre.time && (s.kind !== 'pre-restore' || !s.consumed));
    if (newer) return { ok: false, error: t('undo.redoBlocked') };
    cfg.suppressAuto++;
    try {
      const { restored, missing, notes } = await applySnapshot(cfg, pre);
      await markFlag(pre, 'consumed', true);
      const preState = await stateOf(pre);
      for (const s of list) {
        if (s.kind === 'pre-restore' || !s.stepped) continue;
        if (sameState(preState, await stateOf(s))) await markFlag(s, 'stepped', false);
      }
      const needsRestart = testNeedsRestart(restored);
      const deps = await reconcileDependencies(cfg, restored, syncDeps);
      const preflight = await preflightSnapshot(cfg, pre);
      await appendRollbackLog(cfg, { mode: 'redo', targetId: pre.id, files: restored, missing, notes, needsRestart, deps, preflightMissing: preflight.missing });
      return { ok: true, restored, missing, notes, needsRestart, deps, preflight, targetId: pre.id, preSnapshotId: pre.id, remounted: false };
    } finally {
      cfg.suppressAuto--;
    }
  }
  const target = findSnapshot(list, id ?? '');
  if (!target) return { ok: false, error: t('undo.notFound', { id }) };
  const pre = await createSnapshot(cfg, 'pre-restore', `before-restore:${target.id} (${target.kind}: ${target.reason ?? ''})`);
  cfg.suppressAuto++;
  try {
    const { restored, missing, notes } = await applySnapshot(cfg, target);
    const remounted = await ensureMount(cfg);
    const needsRestart = testNeedsRestart(restored);
    const deps = await reconcileDependencies(cfg, restored, syncDeps);
    const preflight = await preflightSnapshot(cfg, target);
    await appendRollbackLog(cfg, { mode: 'restore', targetId: target.id, targetKind: target.kind, preSnapshotId: pre.id, files: restored, missing, notes, needsRestart, deps, preflightMissing: preflight.missing });
    return { ok: true, restored, missing, notes, needsRestart, deps, preflight, targetId: target.id, targetKind: target.kind, targetReason: target.reason, preSnapshotId: pre.id, stepped: false, remounted };
  } finally {
    cfg.suppressAuto--;
  }
}
async function removeSnapshot(cfg, id) {
  const list = await listSnapshots(cfg);
  const snap = findSnapshot(list, id ?? '');
  if (!snap) return { ok: false, error: t('undo.notFound', { id }) };
  await fs.rm(snap._dir, { recursive: true, force: true });
  return { ok: true, removed: id };
}

// ── 原生对话框（V0.4.0 M2，平台分发）──────────────────────────────────────
// win32 用 PowerShell（原声）；darwin 用 osascript；linux 探测 zenity/kdialog，
// 均无则返回取消（WebUI 切换手输路径，功能不丢、体验降级）。
const PICK_TIMEOUT = 300000;
/** 通用 picker 执行器：返回 { ok, path } 或 { ok:false, cancelled:true }。 */
function runPicker(cmd, args, parse) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PICK_TIMEOUT, windowsHide: true, encoding: 'utf8' }, (_err, stdout) => {
      const p = parse(stdout ?? '');
      if (p) return resolve({ ok: true, path: p });
      return resolve({ ok: false, cancelled: true });
    });
  });
}
function pickDirectory() {
  if (process.platform === 'darwin') {
    return runPicker('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select snapshot directory")'], (o) => o.trim());
  }
  if (process.platform === 'linux') {
    // 优先 zenity，其次 kdialog；没有桌面环境时两个都失败 → 取消
    return runPicker('zenity', ['--file-selection', '--directory', '--title=Select snapshot directory'], (o) => o.trim().split('\n')[0])
      .then((r) => r.ok ? r : runPicker('kdialog', ['--getexistingdirectory', process.cwd()], (o) => o.trim().split('\n')[0]));
  }
  // win32 + 其他：沿用 PowerShell（Windows 原声）
  return new Promise((resolve) => {
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$f.Description = 'Select snapshot directory'",
      '$f.ShowNewFolderButton = $true',
      "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
    ].join('; ');
    execFile('powershell', ['-NoProfile', '-Command', script], {
      timeout: PICK_TIMEOUT,
      windowsHide: true,
      encoding: 'utf8',
    }, (_err, stdout) => {
      const p = (stdout ?? '').trim();
      return p ? resolve({ ok: true, path: p }) : resolve({ ok: false, cancelled: true });
    });
  });
}
function pickFile() {
  if (process.platform === 'darwin') {
    return runPicker('osascript', ['-e', 'POSIX path of (choose file with prompt "Select a dsh-undo-savepoint snapshot export" of type {"zip"})'], (o) => o.trim());
  }
  if (process.platform === 'linux') {
    return runPicker('zenity', ['--file-selection', '--title=Select a dsh-undo-savepoint snapshot export'], (o) => o.trim().split('\n')[0])
      .then((r) => r.ok ? r : runPicker('kdialog', ['--getopenfilename', process.cwd(), '*.zip'], (o) => o.trim().split('\n')[0]));
  }
  return new Promise((resolve) => {
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.OpenFileDialog',
      "$f.Filter = 'ZIP archives (*.zip)|*.zip|All files (*.*)|*.*'",
      '$f.Title = "Select a dsh-undo-savepoint snapshot export"',
      "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }",
    ].join('; ');
    execFile('powershell', ['-NoProfile', '-Command', script], {
      timeout: PICK_TIMEOUT,
      windowsHide: true,
      encoding: 'utf8',
    }, (_err, stdout) => {
      const p = (stdout ?? '').trim();
      return p ? resolve({ ok: true, path: p }) : resolve({ ok: false, cancelled: true });
    });
  });
}

// ── 导出 / 导入（V0.4.0 M1：纯 Node ZIP，双向互通；M6：导入路径 NFC 归一化）──
// V0.4.0 P4：可选 ZIP 加密导出（AES-256-GCM + scrypt，node:crypto，零依赖）。
// 默认不加密 = 与 PowerShell 互操作完全不变；带密码才加密，产物仍是 .zip 文件（内容加密）。
const ENC_MAGIC = Buffer.from('DSHUNDOENC1', 'ascii');
const ENC_SALT = 'dsh-undo-savepoint/export/v1';
function encryptBuffer(buf, password) {
  const key = scryptSync(String(password), ENC_SALT, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENC_MAGIC, iv, tag, ct]);
}
function decryptBuffer(buf, password) {
  if (!buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) throw new Error('not an encrypted dsh-undo export');
  const iv = buf.subarray(ENC_MAGIC.length, ENC_MAGIC.length + 12);
  const tag = buf.subarray(ENC_MAGIC.length + 12, ENC_MAGIC.length + 28);
  const ct = buf.subarray(ENC_MAGIC.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(String(password), ENC_SALT, 32), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
function isEncryptedExport(buf) {
  return buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC);
}
async function exportSnapshots(cfg, password) {
  await fs.mkdir(EXPORT_ROOT, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zip = join(EXPORT_ROOT, `dsh-undo-export-${ts}.zip`);
  const files = [];
  let count = 0;
  let sensitiveWarning = false;
  try {
    const addDir = async (dir, prefix) => {
      if (!(await pathExists(dir))) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!(await pathExists(join(dir, entry.name, 'manifest.json')))) continue;
        try {
          const snap = await readManifest(join(dir, entry.name));
          if (snap.sensitiveMode !== 'redact' && (snap.files ?? []).some((f) => SENSITIVE_DESTS.has(f.name))) {
            sensitiveWarning = true;
          }
        } catch { /* broken manifest: ignore */ }
        const baseRel = `${prefix}/${entry.name}`;
        const walk = async (relDir) => {
          for (const e of await fs.readdir(join(dir, entry.name, relDir), { withFileTypes: true })) {
            const rr = relDir === '' ? e.name : `${relDir}/${e.name}`;
            if (e.isDirectory()) { await walk(rr); continue; }
            if (e.isFile()) files.push({ name: `${baseRel}/${rr}`, data: await fs.readFile(join(dir, entry.name, rr)) });
          }
        };
        await walk('');
        count++;
      }
    };
    await addDir(cfg.manualDir, 'manual');
    await addDir(cfg.autoDir, 'auto');
    const blob = blobDir(cfg);
    if (await pathExists(blob)) {
      for (const entry of await fs.readdir(blob, { withFileTypes: true })) {
        if (entry.isFile()) files.push({ name: `blobs/${entry.name}`, data: await fs.readFile(join(blob, entry.name)) });
      }
    }
    await writeZip(zip, files);
    let encrypted = false;
    if (password && String(password).length) {
      const raw = await fs.readFile(zip);
      await fs.writeFile(zip, encryptBuffer(raw, password));
      encrypted = true;
    }
    return { ok: true, path: zip, count, sensitiveWarning, encrypted };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
/** 导入条目标名安全校验（H1 加固）：拒绝 .. / 绝对路径 / 非法 blob 名 / 非法快照 id。
 *  blob 文件名必须是 40 位 hex（sha1；PS 端 Get-FileHash 大写、Node 端小写，故大小写不敏感，
 *  写入时保留原大小写，保证与 manifest 里记录的 hash 字符串一致）。快照 id 必须匹配 makeId 格式。 */
const BLOB_NAME_RE = /^[0-9a-f]{40}$/i;
const SNAP_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/i;
function assertSafeZipEntry(name, what) {
  if (typeof name !== 'string' || name === ''
    || name.includes('..') || name.startsWith('/') || name.startsWith('\\')
    || /^[A-Za-z]:/.test(name)) {
    throw new Error(`unsafe ${what} in import zip: ${JSON.stringify(name ?? '(empty)')}`);
  }
}

async function importSnapshots(cfg, zipPath, password) {
  if (!zipPath || !(await pathExists(zipPath))) return { ok: false, error: `file not found: ${zipPath ?? '(none)'}` };
  let imported = 0;
  let skipped = 0;
  let rejected = 0;
  try {
    // V0.4.0 P4：支持可选加密导出。检测到加密头时要求密码；解密到临时文件再解析。
    let entries;
    // H2 加固：整体体积上限（防 zip 炸弹把宿主进程内存打爆）。
    const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
    // #25 后续加固：先 stat 再读文件。此前是 readFile 之后才查长度，超大文件
    // 会先被整包打进内存再拒绝。读后再查一次，防 stat 与 read 之间文件被追加。
    try {
      const st = await fs.stat(zipPath);
      if (st.size > MAX_ZIP_BYTES) return { ok: false, error: `import zip too large (${st.size} bytes > ${MAX_ZIP_BYTES})` };
    } catch { /* stat 失败交给后面的 readFile 报错 */ }
    const raw = await fs.readFile(zipPath);
    if (raw.length > MAX_ZIP_BYTES) return { ok: false, error: `import zip too large (${raw.length} bytes > ${MAX_ZIP_BYTES})` };
    if (isEncryptedExport(raw)) {
      if (!password || !String(password).length) return { ok: false, error: '该导出已加密，需提供密码才能导入。', code: 'encrypted' };
      let dec;
      try { dec = decryptBuffer(raw, password); }
      catch { return { ok: false, error: '解密失败（密码错误或文件损坏）。', code: 'bad-password' }; }
      const tmp = `${zipPath}.dec.tmp`;
      await fs.writeFile(tmp, dec);
      try { entries = await readZip(tmp); } finally { await fs.rm(tmp, { force: true }).catch(() => { /* noop */ }); }
    } else {
      entries = await readZip(zipPath);
    }
    // 先把 blobs/ 目录内容写入共享 blob 库，再处理每个快照目录
    const blobs = entries.filter((e) => e.name.startsWith('blobs/') && !e.name.endsWith('/'));
    if (blobs.length > 0) {
      const destBlob = blobDir(cfg);
      await fs.mkdir(destBlob, { recursive: true });
      for (const e of blobs) {
        assertSafeZipEntry(e.name, 'blob entry');
        const name = e.name.slice('blobs/'.length).normalize('NFC');
        if (!BLOB_NAME_RE.test(name)) { rejected++; continue; } // 非 sha1 命名的条目一律跳过（含穿越尝试）
        if (!(await pathExists(join(destBlob, name)))) {
          await fs.writeFile(join(destBlob, name), e.data);
        }
      }
    }
    const dirs = entries.filter((e) => e.name.split('/').length >= 2 && e.name.endsWith('/'));
    // 查找所有含 manifest.json 的快照目录条目
    const snapDirs = new Set();
    for (const e of entries) {
      if (!e.name.endsWith('/manifest.json')) continue;
      assertSafeZipEntry(e.name, 'snapshot entry');
      const dir = e.name.slice(0, -'/manifest.json'.length);
      const parts = dir.split('/');
      if (parts.length >= 2) snapDirs.add(dir); // 形如 manual/<id> 或 auto/<id>
    }
    for (const dir of snapDirs) {
      let kind = 'auto';
      const mf = entries.find((e) => e.name === `${dir}/manifest.json`);
      if (mf) {
        try { kind = (JSON.parse(mf.data.toString('utf8'))).kind ?? 'auto'; } catch { /* default auto */ }
      }
      const id = dir.split('/').pop().normalize('NFC');
      if (!SNAP_ID_RE.test(id)) { rejected++; continue; } // 非法快照 id（含 .. 穿越尝试）
      const dest = (kind === 'manual' ? cfg.manualDir : cfg.autoDir);
      if (await pathExists(join(dest, id))) { skipped++; continue; }
      const destDir = join(dest, id);
      await fs.mkdir(destDir, { recursive: true });
      // 将该目录名下（不含深层子目录？快照目录是平的）所有条目写入
      for (const e of entries) {
        if (!e.name.startsWith(`${dir}/`)) continue;
        assertSafeZipEntry(e.name, 'snapshot file entry');
        const rel = e.name.slice(`${dir}/`.length);
        if (!rel || rel.includes('/') || rel.includes('..')) continue; // 只取该快照目录下的顶层文件
        await fs.writeFile(join(destDir, rel.normalize('NFC')), e.data);
      }
      imported++;
    }
    return { ok: true, imported, skipped, rejected, source: zipPath };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ── 恢复结果呈现（工具 execute 复用）───────────────────────────────────────
function renderRestoreResult(r) {
  if (!r.ok) {
    const err = typeof r.error === 'string' ? r.error : (r.error?.message ?? 'unknown error');
    return t('restore.failed', { err });
  }
  if (r.unchanged) return r.message ?? t('restore.unchanged');
  const lines = [
    t('restore.ok', { id: r.targetId, kind: r.targetKind, reason: r.targetReason ? `: ${r.targetReason}` : '' }),
    t('restore.files', { files: r.restored.length > 0 ? r.restored.join(', ') : '(none)' }),
    t('restore.prestate', { id: r.preSnapshotId }),
  ];
  if (r.stepped) lines.push(t('restore.stepped'));
  if (r.remounted) lines.push(t('restore.remounted'));
  if (Array.isArray(r.missing) && r.missing.length > 0) lines.push(t('restore.notRestored', { missing: r.missing.join(', ') }));
  if (r.needsRestart) lines.push(t('restore.needsRestart'));
  if (r.deps?.touched) {
    if (r.deps.synced) {
      lines.push(t('restore.depsSynced', { command: r.deps.command }));
    } else {
      lines.push(t('restore.depsNote', { note: r.deps.note }));
      lines.push(t('restore.depsHint'));
    }
  }
  if (Array.isArray(r.preflight?.missing) && r.preflight.missing.length > 0) {
    lines.push(t('restore.preflightMissing', { missing: r.preflight.missing.join(', ') }));
    lines.push(t('restore.preflightHint'));
  }
  if (Array.isArray(r.notes) && r.notes.length > 0) {
    for (const n of r.notes) lines.push(t('restore.note', { note: n }));
  }
  return lines.join('\n');
}

// ── 设置 / 编辑 ───────────────────────────────────────────────────────────
function publicSettings(cfg) {
  return {
    autoEnabled: cfg.autoEnabled,
    watchDebounceMs: cfg.watchDebounceMs,
    keepAuto: cfg.keepAuto,
    keepPre: cfg.keepPre,
    autoCleanup: cfg.autoCleanup,
    manualDir: cfg.manualDir,
    autoDir: cfg.autoDir,
    snapshotDir: LEGACY_ROOT,
    pluginDirs: Array.isArray(cfg.pluginDirs) ? cfg.pluginDirs : [],
    sensitiveMode: cfg.sensitiveMode ?? 'redact',
    createDesktopShortcut: cfg.createDesktopShortcut,
    desktopDir: cfg.desktopDir ?? null,
    workspaceDirs: Array.isArray(cfg.workspaceDirs) ? cfg.workspaceDirs : [],
    scheduledSnapshotEnabled: cfg.scheduledSnapshotEnabled ?? false,
    scheduledSnapshotMs: cfg.scheduledSnapshotMs ?? 0,
    bootHealthEnabled: cfg.bootHealthEnabled !== false,
    upgradeGuardEnabled: cfg.upgradeGuardEnabled !== false,
    consent: cfg.consent === true ? true : (cfg.consent === false ? false : null),
    consentAt: cfg.consentAt ?? null,
    guardShortcutEnabled: cfg.guardShortcutEnabled === true,
    guardAutoSafeMode: cfg.guardAutoSafeMode ?? 'ask',
    autoSafeModeAfterFails: cfg.autoSafeModeAfterFails ?? 2,
  };
}

// ── 桌面快捷方式（V0.4.0 新增）：插件加载后自动在桌面创建一个双击打开局外工具的快捷方式 ──
// 三平台：
//  - win32  ：用 WScript.Shell(COM) 生成 .lnk，cmd /c 指向 tools/launch-undo.bat
//  - darwin ：复制 tools/launch-undo.command 到桌面（chmod +x）
//  - linux  ：写 tools/launch-undo.desktop 到桌面（Exec=launch-undo.sh，chmod +x + gio trust）
// 规则：幂等（已存在跳过）；可配置关闭（cfg.createDesktopShortcut=false）；测试可注入
//       platform/desktopDir/pluginRoot。任何失败返回 {ok:false,error}，绝不抛（启动不因它崩溃）。

function desktopDirFallback(platform = process.platform) {
  return platform === 'win32'
    ? join(process.env.USERPROFILE ?? homedir(), 'Desktop')
    : join(homedir(), 'Desktop');
}

// W33：桌面快捷方式相关的外部工具调用统一超时。四处（win32 解析桌面目录 + 生成
// .lnk，macOS xattr 去隔离，Linux gio 标记信任）都在插件加载的快捷方式路径上，
// 工具无响应时会永久挂住插件加载；超时后 execFile 杀掉子进程并按失败回落，
// 不影响插件其余功能（四处回调本就把错误当可忽略）。
const SHORTCUT_TOOL_TIMEOUT = 15000;

async function resolveDesktopDir(platform = process.platform) {
  try {
    if (platform === 'win32') {
      // GetFolderPath 处理 OneDrive 桌面重定向，比 USERPROFILE\Desktop 可靠
      const out = await new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::GetFolderPath('Desktop')`], { timeout: SHORTCUT_TOOL_TIMEOUT, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
      });
      if (out) return out;
    }
    if (platform === 'linux') {
      // XDG：优先读取 user-dirs.dirs 里的 XDG_DESKTOP_DIR
      try {
        const txt = (await fs.readFile(join(homedir(), '.config', 'user-dirs.dirs'), 'utf8')).replace(/^#.*$/gm, '');
        const m = /XDG_DESKTOP_DIR\s*=\s*"([^"]+)"/.exec(txt);
        if (m) return m[1].replace(/^\$HOME/, homedir());
      } catch { /* fall back */ }
    }
  } catch { /* fall back */ }
  return desktopDirFallback(platform);
}

function desktopShortcutPlan(inOpts = {}) {
  const platform = inOpts.platform ?? process.platform;
  const pluginRoot = inOpts.pluginRoot ?? PLUGIN_ROOT;
  const desktopDir = inOpts.desktopDir ?? desktopDirFallback(platform);
  const base = 'dsh-undo-savepoint';
  if (platform === 'win32') return { platform, kind: 'lnk', desktopDir, path: join(desktopDir, `${base}.lnk`), target: join(pluginRoot, 'tools', 'launch-undo.bat') };
  if (platform === 'darwin') return { platform, kind: 'command', desktopDir, path: join(desktopDir, `${base}.command`), source: join(pluginRoot, 'tools', 'launch-undo.command') };
  return { platform, kind: 'desktop', desktopDir, path: join(desktopDir, `${base}.desktop`), source: join(pluginRoot, 'tools', 'launch-undo.desktop'), exec: join(pluginRoot, 'tools', 'launch-undo.sh') };
}

async function createWinLnk(plan) {
  const esc = (s) => s.replace(/'/g, "''");
  // V0.4.0 支持自定义图标：优先用 plugin banner（tools/webui/logo.ico），回退 logo.png，再回退系统默认。
  const icon = plan.icon ? `${esc(plan.icon)},0` : 'shell32.dll,13';
  const cmd = `$ErrorActionPreference='Stop'; $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('${esc(plan.path)}'); $s.TargetPath='cmd.exe'; $s.Arguments='/c ""${plan.target}""'; $s.WorkingDirectory='${esc(dirname(plan.target))}'; $s.IconLocation='${icon}'; $s.Description='${esc(plan.description ?? 'dsh-undo-savepoint - open offline undo tool')}'; $s.Save();`;
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: SHORTCUT_TOOL_TIMEOUT, windowsHide: true }, (err, stdout, stderr) => { if (err) reject(new Error(String(stderr || err))); else resolve(stdout); });
  });
}

// 平台信任标记（W29 抽取为单一外部调用点）：macOS 去隔离属性、Linux 标记 desktop 文件可信。
// 守卫快捷方式与既有桌面快捷方式共用这两支，避免同一外部调用出现第二套写法与漏加超时。
async function clearMacQuarantine(path) {
  try { await new Promise((r) => execFile('xattr', ['-d', 'com.apple.quarantine', path], { timeout: SHORTCUT_TOOL_TIMEOUT }, () => r())); } catch { /* macOS 无 xattr 或已无隔离 */ }
}
async function markLinuxTrusted(path) {
  try { await new Promise((r) => execFile('gio', ['set', path, 'metadata::trusted', 'true'], { timeout: SHORTCUT_TOOL_TIMEOUT }, () => r())); } catch { /* gio 不可用时跳过标记信任 */ }
}

/** 确保桌面快捷方式存在。cfg.createDesktopShortcut=false 或 DSH_UNDO_NO_DESKTOP=1 时禁用；
 *  测试可传 desktopDir/pluginRoot。任何失败返回 {ok:false,action:'error'}，绝不抛。 */
async function ensureDesktopShortcut(cfg = {}, inOpts = {}) {
  const disabled = cfg.createDesktopShortcut === false || (process.env.DSH_UNDO_NO_DESKTOP === '1' && inOpts.force !== true);
  if (disabled) return { ok: true, action: 'disabled', path: null };
  const platform = inOpts.platform ?? process.platform;
  const desktopDir = inOpts.desktopDir ?? cfg.desktopDir ?? await resolveDesktopDir(platform);
  const pr = inOpts.pluginRoot ?? cfg.pluginRoot ?? PLUGIN_ROOT;
  const plan = desktopShortcutPlan({ platform, desktopDir, pluginRoot: pr });
  // V0.4.0 logo：为快捷方式解析图标（ICO 优先，PNG 次之），不存在则用系统默认。
  const ico = join(pr, 'tools', 'webui', 'logo.ico');
  const png = join(pr, 'tools', 'webui', 'logo.png');
  plan.icon = (await pathExists(ico)) ? ico : ((await pathExists(png)) ? png : null);
  if (await pathExists(plan.path)) return { ok: true, action: 'exists', path: plan.path };
  try {
    await fs.mkdir(plan.desktopDir, { recursive: true });
    if (plan.kind === 'lnk') { await createWinLnk(plan); return { ok: true, action: 'created', path: plan.path }; }
    if (plan.kind === 'command') {
      await fs.copyFile(plan.source, plan.path);
      await fs.chmod(plan.path, 0o755);
      await clearMacQuarantine(plan.path);
      return { ok: true, action: 'created', path: plan.path };
    }
    const desktopTxt = `[Desktop Entry]\nType=Application\nName=dsh-undo-savepoint\nComment=Open dsh-undo offline undo tool\nExec="${plan.exec}"\nTerminal=true\nCategories=Utility;\n`;
    await fs.writeFile(plan.path, desktopTxt, { mode: 0o755 });
    await markLinuxTrusted(plan.path);
    return { ok: true, action: 'created', path: plan.path };
  } catch (e) {
    return { ok: false, action: 'error', path: plan.path, error: String(e?.message ?? e) };
  }
}

// ── v0.5.0 守卫快捷方式（W29）：可选生成「DSH 安全启动」桌面入口 ──────────
// 复用 desktopShortcutPlan 的平台分支与 createWinLnk；目标恒为
// tools/launch-dsh-guard.*（bat / command / sh）。默认关闭（guardShortcutEnabled=false），
// 幂等（已存在跳过），失败只返回 {ok:false} 绝不抛。
function guardShortcutPlan(inOpts = {}) {
  const platform = inOpts.platform ?? process.platform;
  const desktopDir = inOpts.desktopDir ?? null;
  const pluginRoot = inOpts.pluginRoot ?? PLUGIN_ROOT;
  const name = platform === 'win32' ? 'DSH 安全启动.lnk'
    : platform === 'darwin' ? 'launch-dsh-guard.command' : 'launch-dsh-guard.desktop';
  const path = desktopDir ? join(desktopDir, name) : null;
  if (platform === 'win32') return { platform, kind: 'lnk', name, path, target: join(pluginRoot, 'tools', 'launch-dsh-guard.bat'), description: 'dsh-undo-savepoint guard - guarded DSH launch' };
  if (platform === 'darwin') return { platform, kind: 'copy', name, path, source: join(pluginRoot, 'tools', 'launch-dsh-guard.command') };
  const source = join(pluginRoot, 'tools', 'launch-dsh-guard.sh');
  return { platform, kind: 'desktop', name, path, source, exec: source };
}
async function ensureGuardShortcut(cfg = {}, inOpts = {}) {
  if (cfg.guardShortcutEnabled !== true) return { ok: true, action: 'skipped', path: null };
  try {
    const plan = guardShortcutPlan(inOpts);
    const desktop = inOpts.desktopDir ?? await resolveDesktopDir(inOpts.platform ?? process.platform);
    const path = plan.path ?? join(desktop, plan.name);
    if (await pathExists(path)) return { ok: true, action: 'exists', path };
    await fs.mkdir(desktop, { recursive: true });
    if (plan.kind === 'lnk') {
      await createWinLnk({ ...plan, path });
      return { ok: true, action: 'created', path };
    }
    if (plan.kind === 'copy') {
      await fs.copyFile(plan.source, path);
      await fs.chmod(path, 0o755);
      await clearMacQuarantine(path);
      return { ok: true, action: 'created', path };
    }
    const txt = `[Desktop Entry]\nType=Application\nName=DSH 安全启动\nComment=Guarded DSH launch (preflight / safe-mode rescue / log capture)\nExec="${plan.exec}"\nTerminal=true\nCategories=Utility;\n`;
    await fs.writeFile(path, txt, { mode: 0o755 });
    await markLinuxTrusted(path);
    return { ok: true, action: 'created', path };
  } catch (e) {
    return { ok: false, action: 'error', path: null, error: String(e?.message ?? e) };
  }
}

// ══ v0.5.0 health guard ═════════════════════════════════════════════════
// 安全管家新区段：F1/F3/F4 的净新增函数统一写在这里。W17 拆分时整段外移
// lib/health.mjs，core 保持 re-export，对外 API 面零变化。

// ── W31 首次挂载声明与确认（first-run consent）──────────────────────────
// 文案由 2026-09-19 规划补丁 §四 给定，逐字采用。规范要求：全平铺直叙、
// 无口号无修辞、无破折号（CONVENTIONS 第七节）。两份文案各含「undo-snapshots」
// 与「22.15」字样，是文案完整性的验收锚点（勿在改动中丢失）。
// 用 String.raw 保留 Windows 路径反斜杠（普通模板串会把 \u 当转义）。
const CONSENT_TEXT = {
  zh: String.raw`[dsh-undo-savepoint] 首次运行确认（首次挂载时打印）

本插件为 DSH 提供快照、撤销、回退与安全模式能力。继续前请确认以下事项。

运行环境
- DSH 0.1.2 及以上（含 0.1.5-rc 线）。
- Node.js 20 及以上。会话扫描修复（undo_scan）需要 Node.js 22.15 及以上，
  低版本自动降级为只读提示，其余功能不受影响。
- Windows / macOS / Linux 均可运行。Windows 差异三点：
  使用 junction 挂载（删除请勿手动）、默认创建桌面快捷方式（设置中可关）、
  系统默认 260 字符路径上限（见下方已知限制）。

写入位置（卸载时的清理范围）
- <DSH 主目录>\undo\ ：设置、状态、blob 去重文件
- <DSH 主目录>\undo-snapshots\ ：快照库
- 各 profile 的 node_modules 下：指向本包的 junction
- Windows 桌面：一个快捷方式

已知限制
- Windows 用户目录较深或使用中文用户名时，快照文件可能超出资源管理器
  的删除路径上限。卸载请用本插件提供的卸载命令，不要手动搜索删除。
- 多途径重复挂载会导致 DSH 启动失败。本插件启动时自动去重；
  若 DSH 已无法启动，在插件目录运行 node tools/doctor.mjs --fix 修复。

确认
- 输入 y 并回车：启用本插件（30 秒无输入默认 y）
- 输入 n 并回车：停用本插件，不注册任何工具，按提示卸载
- 环境变量 DSH_UNDO_NO_CONSENT=1 可跳过本确认（CI/自动化场景）`,
  en: String.raw`[dsh-undo-savepoint] First-run consent (printed on first mount)

This plugin provides snapshot, undo, rollback and safe-mode capabilities
for DSH. Please review the following before continuing.

Environment
- DSH 0.1.2 or later (including the 0.1.5-rc line).
- Node.js 20 or later. Session scan repair (undo_scan) requires
  Node.js 22.15+; older versions degrade to a read-only notice.
  All other features are unaffected.
- Windows / macOS / Linux are all supported. Windows specifics:
  junction-based mounts (do not delete by hand), a desktop shortcut
  created by default (can be disabled in settings), and the default
  260-character path limit (see Known limitations).

Locations written (cleanup scope when uninstalling)
- <DSH home>\undo\ : settings, state, blob store
- <DSH home>\undo-snapshots\ : snapshot library
- node_modules of each profile: a junction pointing to this package
- Windows desktop: one shortcut

Known limitations
- With a deep or non-ASCII Windows user directory, snapshot files may
  exceed the Explorer path limit for deletion. Uninstall with the
  command this plugin provides; do not search and delete files by hand.
- Duplicate mounts from multiple install paths can break DSH startup.
  The plugin deduplicates automatically; if DSH already fails to start,
  run node tools/doctor.mjs --fix from the plugin directory.

Confirm
- y + Enter: enable the plugin (defaults to y after 30s of no input)
- n + Enter: disable the plugin, register no tools, uninstall as guided
- Set DSH_UNDO_NO_CONSENT=1 to skip this consent (CI/automation)`,
};

/** 按 DSH_UNDO_LANG 显式取值；未显式设置时默认中文（文案原语言）。 */
function getConsentText(lang) {
  const l = String(lang ?? process.env.DSH_UNDO_LANG ?? '').trim().toLowerCase();
  if (l.startsWith('en')) return CONSENT_TEXT.en;
  if (l.startsWith('zh')) return CONSENT_TEXT.zh;
  return CONSENT_TEXT.zh;
}

/**
 * 首次挂载确认。返回 { accepted, asked, reason }。
 * - settingsFile 已存在 → 不再询问（用户此前已表态），accepted 由调用方按 consent 值判定
 * - DSH_UNDO_NO_CONSENT=1 → 直接通过（CI/自动化逃生通道）
 * - 非 TTY（headless/管道）→ 自动通过，asked=false
 * - TTY → readline 询问 y/n，30 秒无输入默认 y
 * 任何异常都退回「通过」，绝不因确认流程阻断插件加载（与 rc8 降级盖子同精神）。
 */
async function promptConsent(cfg, opts = {}) {
  if (process.env.DSH_UNDO_NO_CONSENT === '1') return { accepted: true, asked: false, reason: 'env-skip' };
  const tty = typeof process.stdin?.isTTY === 'boolean' ? process.stdin.isTTY : false;
  if (!tty) return { accepted: true, asked: false, reason: 'non-interactive' };
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000;
  const { createInterface } = await import('node:readline');
  return await new Promise((resolve) => {
    let settled = false;
    const done = (accepted, reason) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch { /* 已关闭 */ }
      resolve({ accepted, asked: true, reason });
    };
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => done(true, 'timeout-default-yes'), timeoutMs);
    if (timer.unref) timer.unref();
    rl.question('Enable dsh-undo-savepoint? [y/n] (default y after 30s): ', (answer) => {
      clearTimeout(timer);
      const a = String(answer ?? '').trim().toLowerCase();
      if (a === 'n' || a === 'no') done(false, 'declined');
      else done(true, a === '' ? 'empty-default-yes' : 'accepted');
    });
  });
}

export {
  isDshProductTree,
  matchPatchesInText,
  t,
  DSH_HOME,
  LEGACY_ROOT,
  SETTINGS_FILE,
  EXPORT_ROOT,
  DEFAULT_SETTINGS,
  loadSpec,
  FILE_SPECS,
  WATCHED_BASENAMES,
  blobDir,
  vaultDir,
  readBlob,
  writeBlob,
  readVault,
  writeVault,
  safeRel,
  redactByDest,
  redactEnvContent,
  redactYamlContent,
  isRedacting,
  isCodeFile,
  sha1Hex,
  snapSensitiveBuf,
  rootDir,
  filePath,
  destName,
  findSpec,
  fmtBytes,
  makeId,
  pathExists,
  loadSettingsFile,
  detectProfileName,
  resolveStoreRoots,
  buildConfig,
  setTurnProvider,
  readManifest,
  writeManifest,
  storeDirs,
  discoverPlugins,
  collectPluginTree,
  collectProfileCodeRefs,
  isPluginEcho,
  readBootState,
  writeBootState,
  classifyCrash,
  crashAdvice,
  candidateLogs,
  readCrashLogTail,
  zstdUnavailable,
  assertZstd,
  zstdScanFrames,
  zstdDecodeAll,
  analyzeSessionBytes,
  recodeSessionBytes,
  walkSessionFiles,
  parseSessionLogZstdName,
  patchVerify,
  lastGoodSnapshot,
  readSafeModeState,
  homeFingerprint,
  bundleAnchors,
  bundleCheck,
  computeSafeBundles,
  safeModeStatus,
  safeModeSet,
  preflightSnapshot,
  canResolveAny,
  createSnapshot,
  listSnapshots,
  dirLabel,
  findSnapshot,
  runDoctor,
  runDoctorFix,
  auditSnapshots,
  sessionCensus,
  diskUsage,
  patchStatus,
  healthCheck,
  readDshVersion,
  dshVersionGuard,
  persistVersionState,
  CONSENT_TEXT,
  getConsentText,
  promptConsent,
  setSnapshotMeta,
  stateOf,
  currentState,
  sameState,
  renameWithRetry,
  applySnapshot,
  testNeedsRestart,
  runPnpm,
  reconcileDependencies,
  ensureMount,
  dedupeMount,
  listLinks,
  removeLink,
  profileDirs,
  removeMountBlock,
  planUninstall,
  applyUninstall,
  pruneAuto,
  pruneOrphanBlobs,
  markFlag,
  migrateLegacy,
  classifyChange,
  diffSnapshotStructured,
  diffFileContent,
  diffSnapshot,
  diffTree,
  undoCandidates,
  appendRollbackLog,
  messageOpsDir,
  readMessageOps,
  appendMessageOp,
  listMessageOps,
  pruneMessageOps,
  undoMessage,
  collectReferencedBlobs,
  undoCompact,
  restore,
  removeSnapshot,
  pickDirectory,
  pickFile,
  exportSnapshots,
  importSnapshots,
  isEncryptedExport,
  encryptBuffer,
  decryptBuffer,
  renderRestoreResult,
  publicSettings,
  desktopDirFallback,
  resolveDesktopDir,
  desktopShortcutPlan,
  ensureDesktopShortcut,
  guardShortcutPlan,
  ensureGuardShortcut,
};
