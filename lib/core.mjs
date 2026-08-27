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
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
// node:zlib 的 zstd API（zstdCompressSync/zstdDecompressSync/ZSTD_c_checksumFlag）是
// Node 22.15+ 才提供的。用命名空间导入 + 运行时能力检测：Node 20 下该属性为
// undefined，undo_scan 降级为"明确提示不支持"，插件其余功能不受影响（不再加载即崩）。
import * as zlib from 'node:zlib';
import { homedir } from 'node:os';
// 多语言（V0.3.9 R7）：唯一词典源 lib/i18n/{zh,en}.json，经零依赖 t() 翻译。
import { t } from './i18n.mjs';
// 零依赖 ZIP（V0.4.0 M1）：导出/导入用纯 Node 实现，跨三平台、与 PowerShell 双向互通。
import { writeZip, readZip } from './zip.mjs';

/** DSH 家目录解析（issue #6）：DSH_HOME > ~/.dsh。 */
const USER_HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
const DSH_HOME = process.env.DSH_HOME ?? join(USER_HOME, '.dsh');

/** Legacy flat snapshot root / settings / export root（环境变量可覆盖，测试隔离）。 */
const LEGACY_ROOT = process.env.DSH_UNDO_ROOT ?? join(DSH_HOME, 'undo-snapshots');
const SETTINGS_FILE = process.env.DSH_UNDO_SETTINGS ?? join(DSH_HOME, 'undo', 'settings.json');
const EXPORT_ROOT = process.env.DSH_UNDO_EXPORT ?? join(dirname(LEGACY_ROOT), 'undo-exports');
const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const PLUGIN_ROOT = dirname(TOOLS_DIR);

const DEFAULT_SETTINGS = {
  autoEnabled: true,
  watchDebounceMs: 1500,
  keepAuto: 20,
  keepPre: 10,
  autoCleanup: true,
  manualDir: join(LEGACY_ROOT, 'manual'),
  autoDir: join(LEGACY_ROOT, 'auto'),
  // V0.4.0 消息级撤销（P6）
  keepMessageOps: 200,
  fileToolWhitelist: ['write', 'edit', 'replace', 'patch'],
  workspaceDirs: [],
  workspaceWatch: false,
  // V0.4.0 桌面快捷方式（新增）：插件加载后自动在桌面创建一个双击打开局外工具的快捷方式。
  createDesktopShortcut: true,
  // V0.4.0 体验增强（P4）：定时快照（间隔制，0=关闭）。
  scheduledSnapshotEnabled: false,
  scheduledSnapshotMs: 0,
};

// ── 快照范围清单（单一事实来源：lib/spec.json；读不到退回内置默认）────────────
const SPEC_PATH = new URL('./spec.json', import.meta.url);
const DEFAULT_SPEC = {
  configFiles: [
    { root: 'profile', rel: 'cordis.patch.yml' },
    { root: 'profile', rel: 'package.json' },
    { root: 'profile', rel: 'cordis.yml' },
    { root: 'profile', rel: 'pnpm-workspace.yaml' },
    { root: 'profile', rel: 'pnpm-lock.yaml' },
    { root: 'home', rel: 'cordis.patch.yml' },
    { root: 'home', rel: 'settings.yaml' },
    { root: 'home', rel: '.env' },
    { root: 'home', rel: '.credentials.yaml' },
  ],
  pluginCodeExts: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json', '.yml', '.yaml'],
  pluginExcludeDirNames: ['node_modules', '.git', 'dist', 'build', 'cache', '.cache', 'coverage', '.turbo'],
  pluginExcludeFileNames: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.DS_Store'],
  pluginMaxFileBytes: 262144,
  pluginMaxSnapshotBytes: 5242880,
};
function loadSpec() {
  try {
    const j = JSON.parse(readFileSync(SPEC_PATH, 'utf8').replace(/^\uFEFF/, ''));
    return { ...DEFAULT_SPEC, ...j, configFiles: j.configFiles ?? DEFAULT_SPEC.configFiles };
  } catch { return { ...DEFAULT_SPEC }; }
}
const SPEC = loadSpec();
const FILE_SPECS = SPEC.configFiles;
const WATCHED_BASENAMES = new Set(FILE_SPECS.map((s) => basename(s.rel)));
const CODE_EXTS = new Set(SPEC.pluginCodeExts.map((e) => e.toLowerCase()));
const EXCLUDE_DIRS = new Set(SPEC.pluginExcludeDirNames);
const EXCLUDE_NAMES = new Set(SPEC.pluginExcludeFileNames);
const MAX_FILE_BYTES = SPEC.pluginMaxFileBytes;
const MAX_SNAP_BYTES = SPEC.pluginMaxSnapshotBytes;

// ── 敏感信息（v0.3.2）：脱敏 + 本机 vault ──────────────────────────────────
const SENSITIVE_DESTS = new Set(['home-.env', 'profile-.env', 'home-.credentials.yaml']);
const REDACTED_PLACEHOLDER = '***REDACTED***';

// ── 会话运行守卫（局内注入 turn 检测；局外默认放行）──────────────────────────
let turnProvider = () => false;
/** 注入"是否有会话正在运行"的检测函数（index.js 传 ctx 版 hasOpenTurn）。 */
export function setTurnProvider(fn) {
  turnProvider = typeof fn === 'function' ? fn : () => false;
}
function hasOpenTurn() {
  try { return turnProvider(); } catch { return false; }
}
function busyError() {
  return { ok: false, error: { code: 'busy', message: t('err.busy') } };
}

// ── @deepseek-ai/dsh-tools 延迟解析（局外/隔离场景允许缺省）──────────────────
const DSH_ROOT = process.env.DSH_ROOT ?? '';
let _toolsRequire = null;
function resolveToolsRequire() {
  if (_toolsRequire) return _toolsRequire;
  try {
    const local = createRequire(import.meta.url);
    local.resolve('@deepseek-ai/dsh-tools');
    _toolsRequire = local;
    return _toolsRequire;
  } catch { /* not resolvable from core location */ }
  if (DSH_ROOT !== '') {
    try {
      _toolsRequire = createRequire(join(DSH_ROOT, 'package.json'));
      _toolsRequire.resolve('@deepseek-ai/dsh-tools');
      return _toolsRequire;
    } catch { _toolsRequire = null; }
  }
  return null;
}

// ── 基础工具函数 ──────────────────────────────────────────────────────────
function isCodeFile(name) {
  const base = basename(name);
  if (EXCLUDE_NAMES.has(base)) return false;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : '';
  return CODE_EXTS.has(ext);
}

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

/** 共享 blob 库：<快照根>/blobs/<sha1>，跨快照内容去重（v0.2 模块 1 保险 2）。 */
function blobDir(cfg) {
  return join(dirname(cfg.autoDir), 'blobs');
}
async function readBlob(cfg, hash) {
  try { return await fs.readFile(join(blobDir(cfg), hash)); } catch { return null; }
}
async function writeBlob(cfg, hash, buf) {
  const dir = blobDir(cfg);
  const target = join(dir, hash);
  if (await pathExists(target)) return;
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, target).catch(() => { /* 并发下另一个快照已写入，忽略 */ });
}

/** 相对路径安全校验：恢复时防 manifest 被篡改后向任意路径写文件。 */
function safeRel(rel) {
  return typeof rel === 'string' && rel !== ''
    && !rel.includes('..') && !rel.startsWith('/') && !rel.startsWith('\\')
    && !/^[A-Za-z]:/.test(rel);
}

/** .env 行级脱敏：保留键名 / export 前缀 / 引号形式 / 注释 / 空行，只替换值。 */
function redactEnvContent(text) {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/);
    if (!m) return line;
    const val = m[3];
    const quote = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : '';
    return `${m[1]}${m[2]}${quote}${REDACTED_PLACEHOLDER}${quote}`;
  }).join('\n');
}

/** YAML 键值脱敏（.credentials.yaml）：保留缩进/键名/注释结构，只替换值。 */
function redactYamlContent(text) {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*[A-Za-z_][A-Za-z0-9_.-]*\s*:\s*)(.*)$/);
    if (!m) return line;
    const val = m[2].trim();
    if (val === '' || val.startsWith('#')) return line; // 空值/注释值原样
    return `${m[1]}${REDACTED_PLACEHOLDER}`;
  }).join('\n');
}

/** 敏感文件是否启用脱敏（sensitiveMode !== 'keep' 时脱敏）。 */
function isRedacting(cfg) {
  return cfg.sensitiveMode !== 'keep';
}

/** 本机 vault：<autoDir>/env-vault/<内容sha1>.env（内容寻址去重，不随导出带走）。 */
function vaultDir(cfg) {
  return join(cfg.autoDir, 'env-vault');
}
async function writeVault(cfg, sha1, buf) {
  const dir = vaultDir(cfg);
  const target = join(dir, `${sha1}.env`);
  if (await pathExists(target)) return;
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, target).catch(() => { /* 并发写入已存在 */ });
}
async function readVault(cfg, sha1) {
  try { return await fs.readFile(join(vaultDir(cfg), `${sha1}.env`)); } catch { return null; }
}

/** 按文件类型脱敏文本（.env 行级 / YAML 键值）。对已脱敏文本幂等。 */
function redactByDest(destName, text) {
  return destName.endsWith('.credentials.yaml') ? redactYamlContent(text) : redactEnvContent(text);
}

/** 快照内敏感文件的"对比内容"（v0.3.2）：diff 一律显示脱敏版，不读 vault。 */
async function snapSensitiveBuf(cfg, snap, destName) {
  try { return await fs.readFile(join(snap._dir, destName)); } catch { return null; }
}

function rootDir(cfg, root) {
  return root === 'profile'
    ? (cfg.profileDir ?? join(DSH_HOME, 'profiles', 'web'))
    : (cfg.homeDir ?? DSH_HOME);
}

function filePath(cfg, spec) {
  return join(rootDir(cfg, spec.root), spec.rel);
}

function destName(spec) {
  return `${spec.root}-${spec.rel.replace(/[\\/]/g, '-')}`;
}

function findSpec(name) {
  return FILE_SPECS.find((s) => destName(s) === name) ?? null;
}

/** 体积展示（R3 totalBytes）：<1KB 显示 B，否则 KB/MB。 */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function makeId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${ts}-${randomBytes(2).toString('hex')}`;
}

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function loadSettingsFile() {
  try {
    const j = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { ...DEFAULT_SETTINGS, ...j };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

/** 解析当前 DSH profile（v0.3.3，issue #3）。`dsh web` 是 `--profile web` 的别名。 */
function detectProfileName(argv = process.argv ?? []) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile' && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
    if (a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  return 'web';
}

/** 快照仓库按 profile 隔离；兼容旧平铺布局（profile 作用域目录不存在时回退平铺）。 */
function resolveStoreRoots(profileName) {
  const scoped = join(LEGACY_ROOT, profileName);
  const hasScoped = existsSync(join(scoped, 'auto')) || existsSync(join(scoped, 'manual'));
  const hasFlat = existsSync(join(LEGACY_ROOT, 'auto')) || existsSync(join(LEGACY_ROOT, 'manual'));
  if (hasScoped || !hasFlat) {
    return { manualDir: join(scoped, 'manual'), autoDir: join(scoped, 'auto') };
  }
  return { manualDir: join(LEGACY_ROOT, 'manual'), autoDir: join(LEGACY_ROOT, 'auto') };
}

/**
 * 构建引擎用的 cfg 对象。局内（index.js 的 apply）与局外（undo-server.mjs，无 ctx）
 * 共用一个纯数据 cfg 构造器，保证双端路径/设置语义一致。
 * @param {object} [overrides] 可覆盖 homeDir/profileDir/sensitiveMode/bootAlert/profileName 等
 */
function buildConfig(overrides = {}) {
  const profileName = overrides.profileName ?? detectProfileName();
  const homeDir = overrides.homeDir ?? DSH_HOME;
  const profileDir = overrides.profileDir ?? join(DSH_HOME, 'profiles', profileName);
  const fileSettings = loadSettingsFile();
  const roots = resolveStoreRoots(profileName);
  return {
    ...fileSettings,
    profileName,
    homeDir,
    profileDir,
    manualDir: overrides.manualDir ?? fileSettings.manualDir ?? roots.manualDir,
    autoDir: overrides.autoDir ?? fileSettings.autoDir ?? roots.autoDir,
    settingsFile: SETTINGS_FILE,
    sensitiveMode: overrides.sensitiveMode ?? fileSettings.sensitiveMode ?? 'redact',
    pluginDirs: overrides.pluginDirs ?? fileSettings.pluginDirs ?? [],
    bootAlert: overrides.bootAlert ?? null,
    suppressAuto: 0,
    restoredHashes: new Map(),
  };
}

async function readManifest(dir) {
  const text = await fs.readFile(join(dir, 'manifest.json'), 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, '')); // tolerate a BOM (PS5.1 wrote it)
}

async function writeManifest(dir, snap) {
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(snap, null, 2), 'utf8');
}

/** All directories that may hold snapshots (manual, auto, legacy root). */
function storeDirs(cfg) {
  return [cfg.manualDir, cfg.autoDir, LEGACY_ROOT];
}

// ── 插件发现 / 代码树收集（v0.2 模块 1）────────────────────────────────────
async function discoverPlugins(cfg) {
  const out = [];
  const seen = new Set();
  const add = async (dir, name) => {
    let real = dir;
    try { real = await fs.realpath(dir); } catch { /* 目录已不存在 */ }
    if (seen.has(real)) return;
    seen.add(real);
    let version = '';
    try {
      const pkg = JSON.parse(await fs.readFile(join(real, 'package.json'), 'utf8'));
      version = typeof pkg.version === 'string' ? pkg.version : '';
    } catch { /* 无 package.json 也收（本地插件目录） */ }
    out.push({ name, dir: real, version });
  };
  const envDirs = (process.env.DSH_PLUGIN_DIRS ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const explicit = [...(Array.isArray(cfg.pluginDirs) ? cfg.pluginDirs : []), ...envDirs];
  // cfg.pluginDirs 是数组（哪怕是空数组）就视为显式配置：空 = 关闭自动发现
  if (explicit.length > 0 || Array.isArray(cfg.pluginDirs)) {
    for (const d of explicit) await add(d, basename(d));
    return out;
  }
  // 自动发现：只收 junction（避免把 node_modules 里几百个普通包全收进来）
  const roots = new Set([join(DSH_HOME, 'node_modules')]);
  let reqPaths = [];
  try { reqPaths = resolveToolsRequire()?.resolve.paths('@deepseek-ai/dsh-tools') ?? []; } catch { /* ignore */ }
  for (const p of reqPaths) roots.add(p);
  for (const root of roots) {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isSymbolicLink()) continue; // Windows junction 在 Node 中 isSymbolicLink() = true
      const target = await fs.realpath(join(root, e.name)).catch(() => null);
      if (!target) continue;
      try { if (!(await fs.stat(target)).isDirectory()) continue; } catch { continue; }
      await add(target, e.name);
    }
  }
  return out;
}

async function collectPluginTree(cfg, dir) {
  const files = [];
  const skipped = [];
  const dirs = [];
  let total = 0;
  let truncated = false;
  const walk = async (rel) => {
    if (truncated) return;
    let entries;
    try { entries = await fs.readdir(join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        dirs.push(r);
        await walk(r);
      } else if (e.isFile()) {
        if (!isCodeFile(e.name)) continue;
        const abs = join(dir, r);
        let st;
        try { st = await fs.stat(abs); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) { skipped.push({ path: r, reason: 'too-large' }); continue; }
        if (total + st.size > MAX_SNAP_BYTES) { truncated = true; return; }
        const hash = sha1Hex(await fs.readFile(abs));
        files.push({ rel: r, abs, hash, size: st.size });
        total += st.size;
      }
    }
  };
  await walk('');
  return { files, skipped, truncated, dirs };
}

async function collectProfileCodeRefs(cfg) {
  const refs = [];
  const patch = filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' });
  if (!(await pathExists(patch))) return refs;
  const text = await fs.readFile(patch, 'utf8');
  for (const m of text.matchAll(/name:\s*['"]?\.\/([^'"\s]+)['"]?/g)) {
    const rel = m[1];
    if (!safeRel(rel)) continue;
    const abs = join(rootDir(cfg, 'profile'), rel);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      refs.push({ path: rel, hash: sha1Hex(await fs.readFile(abs)), size: st.size });
    } catch { /* 文件不存在则跳过 */ }
  }
  return refs;
}

/** 插件文件 echo 检测（watcher 用）：恢复动作写回的文件内容仍与 restoredHashes 一致 → true。 */
async function isPluginEcho(cfg, plugin, file) {
  const tree = await collectPluginTree(cfg, plugin.dir);
  let matched = false;
  for (const f of tree.files) {
    if (basename(f.rel) !== file) continue;
    const key = `plugin:${plugin.name}/${f.rel}`;
    if (!cfg.restoredHashes.has(key)) return false; // 恢复清单里没有 → 真实变更
    if (cfg.restoredHashes.get(key) !== f.hash) return false; // 内容被改 → 真实变更
    matched = true;
  }
  return matched; // 无匹配文件（被删除）也视为真实变更
}

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

// ── B6 undo_scan（v0.3.8）：会话文件健康扫描 + 修复 ─────────────────────────
const ZSTD_MAGIC = 4247762216;
const zstdCompressSync = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync : null;
const zstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
const ZSTD_CHECKSUM = { params: { [zlib.constants?.ZSTD_c_checksumFlag ?? 1]: 1 } };
const ZSTD_UNSUPPORTED = 'ZSTD_UNSUPPORTED';
function zstdUnavailable() {
  const e = new Error('This Node version does not ship the zstd Zlib API (zstdCompressSync/zstdDecompressSync); undo_scan requires Node.js >= 22.15.');
  e.code = ZSTD_UNSUPPORTED;
  return e;
}
function assertZstd() {
  if (!zstdCompressSync || !zstdDecompressSync) throw zstdUnavailable();
}
function zstdScanFrames(b) {
  const frames = [];
  let off = 0;
  while (off < b.length) {
    const start = off;
    if (b.length - off < 4) { frames.push({ start, end: off, torn: true }); return frames; }
    if (b.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error('bad frame magic at ' + off);
    off += 4;
    if (off === b.length) { frames.push({ start, end: off, torn: true }); return frames; }
    const d = b.readUInt8(off);
    off += 1;
    if ((d & 24) !== 0) throw new Error('reserved frame-header bit at ' + (off - 1));
    const csf = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df;
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
    const rhb = (ss ? 0 : 1) + db + csb;
    if (b.length - off < rhb) { frames.push({ start, end: off, torn: true }); return frames; }
    off += rhb;
    for (;;) {
      if (b.length - off < 3) { frames.push({ start, end: off, torn: true }); return frames; }
      const bh = b.readUIntLE(off, 3);
      off += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      if (bt === 3) throw new Error('reserved block type at ' + (off - 3));
      const pl = bt === 1 ? 1 : bs;
      if (b.length - off < pl) { frames.push({ start, end: off, torn: true }); return frames; }
      off += pl;
      if (last) break;
    }
    if (ck) {
      if (b.length - off < 4) { frames.push({ start, end: off, torn: true }); return frames; }
      off += 4;
    }
    frames.push({ start, end: off });
  }
  return frames;
}
function zstdDecodeAll(b) {
  assertZstd();
  const frames = zstdScanFrames(b);
  const parts = [];
  for (const f of frames) {
    if (f.torn) throw new Error('torn frame at byte ' + f.start);
    parts.push(zstdDecompressSync(b.subarray(f.start, f.end)));
  }
  return Buffer.concat(parts).toString('utf8');
}
function tryJsonLine(s) { try { JSON.parse(s); return true; } catch { return false; } }
function isSessionHeaderLine(v) {
  return typeof v === 'object' && v !== null && v.type === 'session' &&
    typeof v.version === 'number' && typeof v.id === 'string' &&
    typeof v.createdAt === 'number' && Number.isSafeInteger(v.createdAt) && v.createdAt >= 0 &&
    typeof v.delegationDepth === 'number' && Number.isSafeInteger(v.delegationDepth) && v.delegationDepth >= 0;
}

/**
 * Return the inclusive seq range carried by one storage-record JSON line, a
 * `{ noSeq: true }` marker for a valid JSON record without seq/seq0, or null
 * when the line is not parseable JSON at all.
 */
function recordSeqRange(line) {
  let v = null;
  try { v = JSON.parse(line); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  if (Number.isSafeInteger(v.seq0)) {
    const texts = Array.isArray(v.data?.texts) ? v.data.texts : null;
    const args = Array.isArray(v.data?.args) ? v.data.args : null;
    const payload = texts ?? args;
    if (payload && payload.length > 0) {
      return { first: v.seq0, last: v.seq0 + payload.length - 1, type: v.type };
    }
    return { first: v.seq0, last: v.seq0, type: v.type };
  }
  if (Number.isSafeInteger(v.seq)) return { first: v.seq, last: v.seq, type: v.type };
  // 合法 JSON 但无 seq/seq0（心跳/未来格式扩展等）：合法记录，跳过 seq 连续性校验
  return { noSeq: true, type: v.type };
}

/** Parse one zstd frame into storage records without materializing the whole log. */
function frameRecords(b, frames, i) {
  const f = frames[i];
  const text = zstdDecompressSync(b.subarray(f.start, f.end)).toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const records = [];
  for (const line of lines) {
    const r = recordSeqRange(line);
    if (!r) return { records: null, badLine: line };
    records.push({ line, ...r });
  }
  return { records };
}

function analyzeSessionBytes(b) {
  try {
    assertZstd();
    const frames = zstdScanFrames(b);
    if (frames.some((f) => f.torn)) return { status: 'corrupt', reason: 'torn frame' };
    if (frames.length === 0) return { status: 'corrupt', reason: 'empty or header-less' };

    const headerText = zstdDecompressSync(b.subarray(frames[0].start, frames[0].end)).toString('utf8');
    const nl = headerText.indexOf('\n');
    if (nl === -1) return { status: 'corrupt', reason: 'no newline in decoded text' };
    const headerLine = headerText.slice(0, nl);
    let parsed = null;
    try { parsed = JSON.parse(headerLine); } catch { /* 首行非 JSON */ }
    if (!isSessionHeaderLine(parsed)) return { status: 'corrupt', reason: 'first line is not a valid session header' };

    if (frames.length < 2) {
      const text = zstdDecodeAll(b);
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      return {
        status: 'fixable',
        reason: 'single-frame layout violation',
        events: Math.max(0, lines.length - 1),
        frames: frames.length,
      };
    }

    const metas = [];
    let expected = 0;
    let seqIssue = null;
    let events = 0;
    let badJson = null;
    for (let i = 1; i < frames.length; i++) {
      const { records, badLine } = frameRecords(b, frames, i);
      if (!records) {
        badJson ??= { frame: i, line: badLine };
        continue;
      }
      const expectedBefore = expected;
      const firstSeq = records[0]?.first;
      const lastSeq = records.at(-1)?.last;
      const types = records.map((r) => r.type);
      const isCloserPair = records.length === 2 && types[0] === 'step/end' && types[1] === 'turn/end'
        && records[1].first === records[0].first + 1;
      let frameEvents = 0;
      for (const rec of records) {
        if (rec.noSeq) { frameEvents += 1; continue; } // 无 seq 行：计入事件但不参与连续性校验
        frameEvents += rec.last - rec.first + 1;
        if (rec.first !== expected) seqIssue ??= { frame: i, expected, got: rec.first };
        expected = rec.last + 1;
      }
      events += frameEvents;
      metas.push({
        i,
        start: frames[i].start,
        end: frames[i].end,
        firstSeq,
        lastSeq,
        isCloserPair,
        expectedBefore,
      });
    }

    if (badJson) return { status: 'corrupt', reason: `bad JSON line in frame ${badJson.frame}` };

    // Synthetic-closer overlap: a frame containing only step/end + turn/end is
    // followed by a frame that restarts at the pre-closer seq. Removing the
    // closer frame restores the contiguous tail (the interrupted turn resumes
    // without the synthetic boundary).
    let candidate = null;
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i];
      if (!m.isCloserPair) continue;
      for (let j = i + 1; j < metas.length; j++) {
        if (metas[j].firstSeq === m.expectedBefore) {
          candidate = { start: m.start, end: m.end, expectedBefore: m.expectedBefore };
          break;
        }
      }
      if (candidate) break;
    }
    if (candidate) {
      return {
        status: 'fixable',
        reason: 'synthetic-closer overlap',
        events,
        frames: frames.length,
        repairStart: candidate.start,
        repairEnd: candidate.end,
      };
    }
    if (seqIssue) {
      return {
        status: 'corrupt',
        reason: `seq gap in committed region at frame ${seqIssue.frame} (expected ${seqIssue.expected}, got ${seqIssue.got})`,
      };
    }

    return { status: 'ok', events, frames: frames.length };
  } catch (error) {
    if (error?.code === ZSTD_UNSUPPORTED) throw error;
    return { status: 'corrupt', reason: String(error?.message ?? error) };
  }
}

function recodeSessionBytes(b, repair) {
  assertZstd();
  if (repair?.repairStart !== undefined && repair?.repairEnd !== undefined) {
    // 多次崩溃恢复可能留下多个 synthetic-closer 重叠帧：循环删除直到重分析 ok，
    // 而非只删第一个（否则双重叠文件每次 --fix 都选同一个 closer，永远修不完）。
    let out = Buffer.concat([
      b.subarray(0, repair.repairStart),
      b.subarray(repair.repairEnd),
    ]);
    for (let removed = 1; ; removed++) {
      const check = analyzeSessionBytes(out);
      if (check.status === 'ok') return out;
      if (check.status !== 'fixable' || check.reason !== 'synthetic-closer overlap'
        || check.repairStart === undefined || check.repairEnd === undefined) {
        throw new Error(`seq-overlap repair re-analysis failed: ${check.reason}`);
      }
      if (removed >= 1024) throw new Error('seq-overlap repair exceeded safe iteration limit (1024)');
      out = Buffer.concat([out.subarray(0, check.repairStart), out.subarray(check.repairEnd)]);
    }
  }
  const text = zstdDecodeAll(b);
  const nl = text.indexOf('\n');
  if (nl === -1) throw new Error('no newline in decoded text');
  const headerLine = text.slice(0, nl);
  const rest = text.slice(nl + 1);
  let parsed = null;
  try { parsed = JSON.parse(headerLine); } catch { /* 下抛 */ }
  if (!isSessionHeaderLine(parsed)) throw new Error('first line is not a valid session header');
  const frames = [zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), ZSTD_CHECKSUM)];
  if (rest.length > 0) frames.push(zstdCompressSync(Buffer.from(rest, 'utf8'), ZSTD_CHECKSUM));
  const out = Buffer.concat(frames);
  const check = zstdDecodeAll(out);
  if (check !== text) throw new Error('round-trip text mismatch');
  for (const l of check.split('\n')) { if (l.trim() && !tryJsonLine(l)) throw new Error('bad JSON line after recode'); }
  const re = analyzeSessionBytes(out);
  if (re.status !== 'ok') throw new Error(`recode re-analysis failed: ${re.reason}`);
  return out;
}
async function walkSessionFiles(cfg) {
  const root = join(cfg.homeDir ?? DSH_HOME, 'sessions');
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase() === 'session.jsonl.zstd') out.push(p);
    }
  }
  return out;
}

// ── B4 补丁托管（v0.3.8）：dsh-session-persistence-jsonl 容错补丁校验 ────────
async function locatePatchTarget(relTarget) {
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
async function patchVerify(cfg) {
  try {
    const manifest = JSON.parse(readFileSync(join(TOOLS_DIR, 'dsh-patches.json'), 'utf8'));
    const target = await locatePatchTarget(manifest.target);
    if (!target) return { ok: false, reason: 'target-not-found' };
    const text = readFileSync(target, 'utf8');
    const missing = [];
    for (const p of manifest.patches) {
      if (text.includes(p.new)) continue;
      if (text.includes(p.old)) missing.push(p.id);
      else return { ok: false, reason: `unmatched:${p.id}` };
    }
    return { ok: missing.length === 0, missing, target };
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
function bundleAnchors(cfg) {
  const anchors = [];
  try { anchors.push(createRequire(join(DSH_HOME, 'package.json'))); } catch { /* DSH_HOME 无 package.json 也可 */ }
  try { anchors.push(createRequire(join(rootDir(cfg, 'profile'), 'package.json'))); } catch { /* profile 无 package.json 也可 */ }
  return anchors;
}
async function bundleCheck(cfg, name) {
  for (const r of bundleAnchors(cfg)) {
    for (const sp of (r.resolve.paths(name) ?? [])) {
      const cand = join(sp, name);
      let pkg;
      try { pkg = JSON.parse(await fs.readFile(join(cand, 'package.json'), 'utf8')); } catch { continue; }
      const patch = pkg.dsh?.bundle?.patch;
      if (typeof patch !== 'string' || !patch) {
        return { ok: false, reason: `no dsh.bundle.patch (${name})` };
      }
      if (!(await pathExists(join(cand, patch)))) {
        return { ok: false, reason: `dsh.bundle.patch 文件缺失: ${join(cand, patch)}` };
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
  for (const spec of FILE_SPECS) {
    const src = filePath(cfg, spec);
    if (!(await pathExists(src))) continue;
    const name = destName(spec);
    const dest = join(dir, name);
    const buf = await fs.readFile(src);
    if (SENSITIVE_DESTS.has(name) && isRedacting(cfg)) {
      const text = buf.toString('utf8');
      const redactedText = name.endsWith('.credentials.yaml') ? redactYamlContent(text) : redactEnvContent(text);
      await fs.writeFile(dest, redactedText, 'utf8');
      const sha = sha1Hex(buf);
      await writeVault(cfg, sha, buf);
      envVaultRefs[name] = sha;
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
    profile: cfg.profileName,
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
/** 一键诊断（V0.4.0，D4/P5）。返回结构化健康报告；offline 局外也复用。 */
async function runDoctor(cfg) {
  const checks = [];
  const add = (level, code, name, detail, fix) => checks.push({ level, code, name, detail: String(detail ?? ''), fix: String(fix ?? '') });
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
  // 汇总
  const levels = { ok: 0, warn: 0, err: 0 };
  for (const c of checks) levels[c.level] = (levels[c.level] ?? 0) + 1;
  return {
    ok: levels.err === 0,
    healthy: levels.err === 0 && levels.warn === 0,
    summary: { level: levels.err ? 'err' : levels.warn ? 'warn' : 'ok', ...levels },
    checks,
    counts: { total: snapshots.length, ...byKind },
  };
}
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
    await fs.writeFile(tmp, buf);
    await renameWithRetry(tmp, target);
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
    const out = [];
    let pending = null;
    const flush = () => {
      if (pending && !pending.some((l) => l.includes('dsh-undo-savepoint'))) out.push(...pending);
      pending = null;
    };
    for (const line of lines) {
      if (/^\s*-\s+/.test(line)) { flush(); pending = [line]; continue; }
      if (pending && /^\s+\S/.test(line)) { pending.push(line); continue; }
      flush();
      out.push(line);
    }
    flush();
    text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  }
  await fs.writeFile(file, text.replace(/\s+$/, '') + '\n', 'utf8');
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
  for (const op of ops) {
    try {
      if (op.beforeExists) {
        const buf = await readBlob(cfg, op.beforeHash);
        if (!buf) { missing.push({ path: op.path, reason: 'before content unavailable (blob missing)' }); continue; }
        await fs.mkdir(dirname(op.path), { recursive: true });
        const tmp = `${op.path}.u-tmp`;
        await fs.writeFile(tmp, buf);
        await fs.rename(tmp, op.path).catch(() => { /* windows rename race */ });
        changed.push(op.path);
      } else {
        // 新建的文件：若当前仍存在则删除（用 try 捕获已不存在的情况）
        try { await fs.rm(op.path, { force: false }); deleted.push(op.path); } catch { skipped.push({ path: op.path, reason: 'already absent' }); }
      }
    } catch (e) {
      skipped.push({ path: op.path, reason: String(e?.message ?? e) });
    }
  }
  const notes = skipped.length ? `(skipped: ${skipped.map((s) => s.path).join(', ')})` : '';
  await appendRollbackLog(cfg, { mode: 'message-rollback', batchId: batch.batchId, messageId: batch.messageId ?? null, changed: changed.length, deleted: deleted.length, missing: missing.length });
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
async function importSnapshots(cfg, zipPath, password) {
  if (!zipPath || !(await pathExists(zipPath))) return { ok: false, error: `file not found: ${zipPath ?? '(none)'}` };
  let imported = 0;
  let skipped = 0;
  try {
    // V0.4.0 P4：支持可选加密导出。检测到加密头时要求密码；解密到临时文件再解析。
    let entries;
    const raw = await fs.readFile(zipPath);
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
        const name = e.name.slice('blobs/'.length).normalize('NFC');
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
      const dest = (kind === 'manual' ? cfg.manualDir : cfg.autoDir);
      if (await pathExists(join(dest, id))) { skipped++; continue; }
      const destDir = join(dest, id);
      await fs.mkdir(destDir, { recursive: true });
      // 将该目录名下（不含深层子目录？快照目录是平的）所有条目写入
      for (const e of entries) {
        if (!e.name.startsWith(`${dir}/`)) continue;
        const rel = e.name.slice(`${dir}/`.length);
        if (!rel || rel.includes('/')) continue; // 只取该快照目录下的顶层文件
        await fs.writeFile(join(destDir, rel.normalize('NFC')), e.data);
      }
      imported++;
    }
    return { ok: true, imported, skipped, source: zipPath };
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

async function resolveDesktopDir(platform = process.platform) {
  try {
    if (platform === 'win32') {
      // GetFolderPath 处理 OneDrive 桌面重定向，比 USERPROFILE\Desktop 可靠
      const out = await new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::GetFolderPath('Desktop')`], { windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
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
  const cmd = `$ErrorActionPreference='Stop'; $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('${esc(plan.path)}'); $s.TargetPath='cmd.exe'; $s.Arguments='/c ""${plan.target}""'; $s.WorkingDirectory='${esc(dirname(plan.target))}'; $s.IconLocation='${icon}'; $s.Description='dsh-undo-savepoint - open offline undo tool'; $s.Save();`;
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true }, (err, stdout, stderr) => { if (err) reject(new Error(String(stderr || err))); else resolve(stdout); });
  });
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
      try { await new Promise((r) => execFile('xattr', ['-d', 'com.apple.quarantine', plan.path], () => r())); } catch { /* macOS 无 xattr 或已无隔离 */ }
      return { ok: true, action: 'created', path: plan.path };
    }
    const desktopTxt = `[Desktop Entry]\nType=Application\nName=dsh-undo-savepoint\nComment=Open dsh-undo offline undo tool\nExec="${plan.exec}"\nTerminal=true\nCategories=Utility;\n`;
    await fs.writeFile(plan.path, desktopTxt, { mode: 0o755 });
    try { await new Promise((r) => execFile('gio', ['set', plan.path, 'metadata::trusted', 'true'], () => r())); } catch { /* gio 不可用时跳过标记信任 */ }
    return { ok: true, action: 'created', path: plan.path };
  } catch (e) {
    return { ok: false, action: 'error', path: plan.path, error: String(e?.message ?? e) };
  }
}

export {
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
  removeMountBlock,
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
};
