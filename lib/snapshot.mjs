/**
 * dsh-undo-savepoint: 快照存储与清理（创建/列举/跨机预检/自动清理）。
 *
 * V0.5.0 拆分（W16）：本模块承接原 lib/core.mjs 快照族的两段区间，逐字节搬移、
 * 零行为变化；core.mjs 保持同名 re-export，对外 API 面不变。
 *
 * 依赖方向：snapshot -> base（单向）；core -> snapshot。本模块不含 ctx 装配与 REST 路由。
 */
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  DSH_HOME,
  FILE_SPECS,
  SENSITIVE_DESTS,
  REDACTED_PLACEHOLDER,
  blobDir,
  collectPluginTree,
  collectProfileCodeRefs,
  destName,
  discoverPlugins,
  filePath,
  isRedacting,
  makeId,
  pathExists,
  readManifest,
  redactEnvContent,
  redactYamlContent,
  resolveToolsRequire,
  rootDir,
  sha1Hex,
  storeDirs,
  writeBlob,
  writeManifest,
  writeVault,
} from './base.mjs';

// ── 跨机一致性预检（v0.4）──────────────────────────────────────────────────
async function preflightSnapshot(cfg, snap) {
  const names = new Set();
  const patchFile = (snap.files ?? []).find((f) => f.name === 'profile-cordis.patch.yml');
  if (patchFile) {
    try {
      const text = await fs.readFile(join(snap._dir, patchFile.name), 'utf8');
      for (const m of text.matchAll(/name:\s*['"]?([^'"\s]+)['"]?/g)) {
        const n = m[1];
        if (n.startsWith('./') || n.startsWith('../') || n.startsWith('/') || n.startsWith('\\')) continue; // 本地文件
        if (n === 'dsh-undo-savepoint') continue; // 自身永远在
        names.add(n);
      }
    } catch { /* patch 缺失则跳过 */ }
  }
  const pkgFile = (snap.files ?? []).find((f) => f.name === 'profile-package.json');
  if (pkgFile) {
    try {
      const pkg = JSON.parse(await fs.readFile(join(snap._dir, pkgFile.name), 'utf8'));
      for (const n of (pkg.dsh?.profile?.bundles ?? [])) {
        if (typeof n === 'string' && n !== 'dsh-undo-savepoint') names.add(n);
      }
    } catch { /* package.json 缺失则跳过 */ }
  }
  const missing = [];
  for (const n of names) {
    if (canResolveAny(cfg, n)) continue;
    missing.push(n);
  }
  return { missing, checked: names.size };
}
function canResolveAny(cfg, name) {
  const anchors = [];
  try { anchors.push(createRequire(join(DSH_HOME, 'package.json'))); } catch { /* ignore */ }
  try { anchors.push(createRequire(join(rootDir(cfg, 'profile'), 'package.json'))); } catch { /* ignore */ }
  const toolsR = resolveToolsRequire();
  if (toolsR) anchors.push(toolsR);
  for (const r of anchors) {
    try { r.resolve(name); return true; } catch { /* try next anchor */ }
  }
  return false;
}

// ── 快照创建 / 列表 / 状态 ────────────────────────────────────────────────
async function createSnapshot(cfg, kind, reason, opts = {}) {
  const base = kind === 'manual' ? cfg.manualDir : cfg.autoDir;
  await fs.mkdir(base, { recursive: true });
  let id;
  do {
    id = makeId();
  } while (await pathExists(join(base, id)));
  const dir = join(base, id);
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  const envVaultRefs = {};
  const redacted = [];
  const redactedPreexisting = [];
  for (const spec of FILE_SPECS) {
    const src = filePath(cfg, spec);
    if (!(await pathExists(src))) continue;
    const name = destName(spec);
    const dest = join(dir, name);
    const buf = await fs.readFile(src);
    if (SENSITIVE_DESTS.has(name) && isRedacting(cfg)) {
      const text = buf.toString('utf8');
      const redactedText = name.endsWith('.yaml') ? redactYamlContent(text) : redactEnvContent(text);
      await fs.writeFile(dest, redactedText, 'utf8');
      // #41 守卫一：活文件内容已含占位符（被先前脱敏文本污染）⇒ 拒绝把污染文本入库为
      // 「真值」，否则还原时会把占位符当真值写回（W36 之前是非法 YAML）。快照目录仍写
      // 脱敏副本（真实性记录），还原侧由守卫二拒写。正常文件不受影响。
      if (text.includes(REDACTED_PLACEHOLDER)) {
        redactedPreexisting.push(name);
      } else {
        const sha = sha1Hex(buf);
        await writeVault(cfg, sha, buf);
        envVaultRefs[name] = sha;
      }
      redacted.push(name);
      files.push({ name, size: Buffer.byteLength(redactedText) });
      continue;
    }
    await fs.copyFile(src, dest);
    files.push({ name, size: buf.length });
  }
  const plugins = [];
  for (const p of await discoverPlugins(cfg)) {
    const tree = await collectPluginTree(cfg, p.dir);
    const refs = [];
    for (const f of tree.files) {
      await writeBlob(cfg, f.hash, await fs.readFile(f.abs));
      refs.push({ path: f.rel, hash: f.hash, size: f.size });
    }
    plugins.push({ name: p.name, dir: p.dir, version: p.version, files: refs, skipped: tree.skipped, truncated: tree.truncated });
  }
  const profileFiles = [];
  for (const f of await collectProfileCodeRefs(cfg)) {
    await writeBlob(cfg, f.hash, await fs.readFile(join(rootDir(cfg, 'profile'), f.path)));
    profileFiles.push({ path: f.path, hash: f.hash, size: f.size });
  }
  const snap = {
    id, time: new Date().toISOString(), kind, reason, files, plugins, profileFiles,
    sensitiveMode: cfg.sensitiveMode, redacted, envVaultRefs,
    // #41 守卫一留下的痕迹：这些敏感文件的活内容当时已含占位符，未入 vault。
    // 附加可选字段，旧代码 JSON.parse 忽略未知键，不动 schemaVersion。
    ...(redactedPreexisting.length > 0 ? { redactedPreexisting } : {}),
    profile: cfg.profileName,
    // V0.5.0 格式锚点（只写不读，向后兼容）：schemaVersion 标记清单格式代际，
    // 旧版插件按 JSON.parse 忽略未知字段处理；compression 为枚举占位，
    // 缺省（'none'）即现状不压缩写盘。二者均不构成读侧行为分支。
    schemaVersion: 1,
    compression: 'none',
    // V0.4.0 体验增强（P4）：快照标签/备注（可选）。
    note: (typeof opts.note === 'string' && opts.note) ? opts.note : null,
    tags: Array.isArray(opts.tags) ? opts.tags.map((x) => String(x).trim()).filter(Boolean) : [],
  };
  const manifestBytes = Buffer.byteLength(JSON.stringify(snap));
  const configBytes = files.reduce((n, f) => n + (f.size ?? 0), 0);
  const pluginBytes = plugins.reduce((n, p) => n + (p.files ?? []).reduce((m, f) => m + (f.size ?? 0), 0), 0);
  const profileBytes = profileFiles.reduce((n, f) => n + (f.size ?? 0), 0);
  snap.totalBytes = manifestBytes + configBytes + pluginBytes + profileBytes;
  await writeManifest(dir, snap);
  return snap;
}

async function listSnapshots(cfg) {
  const out = [];
  for (const base of storeDirs(cfg)) {
    if (!(await pathExists(base))) continue;
    for (const entry of await fs.readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      try {
        const snap = await readManifest(dir);
        snap._dir = dir;
        snap._store = dirLabel(cfg, base);
        out.push(snap);
      } catch { /* ignore broken */ }
    }
  }
  out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return out;
}
function dirLabel(cfg, dir) {
  if (dir === cfg.manualDir) return 'manual';
  if (dir === cfg.autoDir) return 'auto';
  return 'legacy';
}
function findSnapshot(list, id) {
  return list.find((s) => s.id === id) ?? null;
}

/**
 * 更新一个既有快照的标签/备注（V0.4.0 P4）。
 * @param {object} cfg
 * @param {string} id 快照 id
 * @param {{note?:string, tags?:string[]}} patch 只更新传入的字段（note 传 null 清空；tags 传 [] 清空）
 */
async function setSnapshotMeta(cfg, id, patch = {}) {
  const list = await listSnapshots(cfg);
  const s = findSnapshot(list, id);
  if (!s) return { ok: false, error: `snapshot not found: ${id}`, code: 'not-found' };
  const { _dir, _store, ...manifest } = s;
  const note = 'note' in patch ? patch.note : (manifest.note ?? null);
  const tags = Array.isArray(patch.tags) ? patch.tags.map((x) => String(x).trim()).filter(Boolean) : (Array.isArray(manifest.tags) ? manifest.tags : []);
  const updated = { ...manifest, note, tags };
  await writeManifest(s._dir, updated);
  return { ok: true, id, note, tags };
}

// ── 清理 / 迁移 ───────────────────────────────────────────────────────────
async function pruneAuto(cfg, list) {
  const removed = { removedAuto: 0, removedPre: 0, removedBlobs: 0 };
  if (cfg.autoCleanup === false) return removed;
  const inAuto = (s) => (s._store ?? dirLabel(cfg, s._dir)) === 'auto';
  const remove = async (snap) => {
    await fs.rm(snap._dir, { recursive: true, force: true });
  };
  const auto = list
    .filter((s) => (s.kind === 'auto' || s.kind === 'baseline') && inAuto(s))
    .sort((a, b) => (a.time < b.time ? -1 : 1));
  const excessAuto = auto.slice(0, Math.max(0, auto.length - cfg.keepAuto));
  for (const snap of excessAuto) { await remove(snap); removed.removedAuto++; }
  const pre = list
    .filter((s) => s.kind === 'pre-restore' && inAuto(s))
    .sort((a, b) => {
      if (!!a.consumed !== !!b.consumed) return a.consumed ? -1 : 1;
      return a.time < b.time ? -1 : 1;
    });
  const excessPre = pre.slice(0, Math.max(0, pre.length - cfg.keepPre));
  for (const snap of excessPre) { await remove(snap); removed.removedPre++; }
  removed.removedBlobs = await pruneOrphanBlobs(cfg, list);
  return removed;
}
async function pruneOrphanBlobs(cfg, list) {
  const blob = blobDir(cfg);
  if (!(await pathExists(blob))) return 0;
  const refs = new Set();
  for (const s of list) {
    for (const p of (s.plugins ?? [])) {
      for (const f of (p.files ?? [])) if (f.hash) refs.add(f.hash);
    }
    for (const f of (s.profileFiles ?? [])) if (f.hash) refs.add(f.hash);
  }
  let removed = 0;
  for (const entry of await fs.readdir(blob, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!refs.has(entry.name)) {
      await fs.rm(join(blob, entry.name), { force: true });
      removed++;
    }
  }
  return removed;
}
export {
  preflightSnapshot,
  canResolveAny,
  createSnapshot,
  listSnapshots,
  dirLabel,
  findSnapshot,
  setSnapshotMeta,
  pruneAuto,
  pruneOrphanBlobs,
};
