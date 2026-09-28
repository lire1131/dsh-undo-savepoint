/**
 * dsh-undo-savepoint: base module (v0.5.0 拆分第一步，D3 的 base 模块).
 *
 * 承接 core.mjs 的常量、纯工具函数与插件发现逻辑。切割面经符号交叉引用
 * 分析验证：本区间不引用 core 后续区间的任何符号（单向依赖链地基）。
 * session / snapshot / health 模块 import 本模块；core.mjs 作为门面
 * import 本模块并 re-export，对外 API 面零变化。
 *
 * @module dsh-undo-savepoint/base
 */
import { createRequire } from 'node:module';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
// 多语言（V0.3.9 R7）：唯一词典源 lib/i18n/{zh,en}.json，经零依赖 t() 翻译。
import { t } from './i18n.mjs';

/** 展开 DSH_HOME 的 ~ / ~/ / ~\ 前缀（与宿主 expandHomePath 同语义），其余原样返回。 */
function expandHomePrefix(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** DSH 家目录解析（issue #6）：DSH_HOME > ~/.dsh。空串与纯空白视为未设置，
 *  波浪号前缀展开、resolve() 归一为绝对路径，与宿主 resolveDshHome 行为一致。 */
const USER_HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
const DSH_HOME_ENV = process.env.DSH_HOME;
const DSH_HOME = typeof DSH_HOME_ENV === 'string' && DSH_HOME_ENV.trim().length > 0
  ? resolve(expandHomePrefix(DSH_HOME_ENV.trim()))
  : join(USER_HOME, '.dsh');

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
  // V0.5.0 DSH 安全管家：启动体检（挂 boot-state 30 秒定时器）与 DSH 升级
  // 护航（版本变化自动保险快照）的开关。默认开启，WebUI 设置面板可关。
  bootHealthEnabled: true,
  upgradeGuardEnabled: true,
  // v0.5.0 守卫（W29）：可选的守卫桌面快捷方式与守卫处置默认档。
  guardShortcutEnabled: false,
  guardAutoSafeMode: 'ask',
  // v0.5.0 崩溃自愈（W30）：连续启动失败达到该次数自动进安全模式；0 = 关闭。
  autoSafeModeAfterFails: 2,
  // V0.5.0 W31 安装确认：undefined = 从未确认过（首次挂载走 consent 流程）；
  // true = 已确认启用；false = 用户明确拒绝，进入停用模式（不注册工具、不建快捷方式）。
  consent: undefined,
  consentAt: null,
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
const SENSITIVE_DESTS = new Set(['home-.env', 'profile-.env', 'home-.credentials.yaml', 'home-settings.yaml']);
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

/** .env 行级脱敏：保留键名 / export 前缀 / 引号形式 / 注释 / 空行，只替换值。
 * #35：值本身的续行（引号未闭合的跨行值、非键非注释的裸续行）一律替换为
 * 占位符——键值行已脱敏，续行再原样入库就是绕过面。无状态的逐行兜底：
 * 凡不是"键="、注释、空行的行都替换，天然覆盖所有续行形态，且幂等。 */
function redactEnvContent(text) {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/);
    if (m) {
      const val = m[3];
      const quote = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : '';
      return `${m[1]}${m[2]}${quote}${REDACTED_PLACEHOLDER}${quote}`;
    }
    // 空行与注释保留；其余（跨行值的续行、裸文本）替换为占位符
    if (line.trim() === '' || line.trim().startsWith('#')) return line;
    return REDACTED_PLACEHOLDER;
  }).join('\n');
}

/** YAML 脱敏「构造折叠」（#41 根修，替代 #35 的逐行值替换）：
 * - 普通值替换为带引号占位符（裸 * 开头标量是 YAML 别名语法，不加引号必非法）；
 * - 块标量（key: | 之下的内容行）与多行流式集合整体折叠为单行引号占位符，吞掉构造行；
 * - 列表项内联键保留键名；无法识别的裸行/续行整行丢弃（过度脱敏方向）。
 * 输出对常见形态保证是合法 YAML；对已脱敏文本幂等。 */
function countFlowDepth(s) {
  let d = 0;
  for (const ch of s) {
    if (ch === '[' || ch === '{') d++;
    else if (ch === ']' || ch === '}') d--;
  }
  return d;
}
function redactYamlContent(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const indOf = (l) => (l.match(/^(\s*)/))[1];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const ind = indOf(line);
    if (line.trim() === '' || line.trim().startsWith('#') || line === '---' || line === '...') { out.push(line); i++; continue; }
    const kv = line.match(/^(\s*[A-Za-z_][A-Za-z0-9_.-]*\s*:\s*)(.*)$/);
    if (kv) {
      const val = kv[2].trim();
      if (val === '' || val.startsWith('#')) { out.push(line); i++; continue; }
      if (/^[|>][+-]?\d*(\s+#.*)?$/.test(val)) {
        // 块标量头：整块折叠为单行占位符，吞掉所有更深缩进的内容行
        out.push(`${kv[1]}"${REDACTED_PLACEHOLDER}"`);
        i++;
        while (i < lines.length) {
          const n = lines[i];
          if (n.trim() === '') { i++; continue; }
          if (indOf(n).length > ind.length) { i++; continue; }
          break;
        }
        continue;
      }
      if (/^[[{]/.test(val)) {
        // 流式集合头：折叠 + 括号计数吞到平衡（引号内括号不识别，过吞方向安全）
        out.push(`${kv[1]}"${REDACTED_PLACEHOLDER}"`);
        let depth = countFlowDepth(val);
        i++;
        while (i < lines.length && depth > 0) { depth += countFlowDepth(lines[i]); i++; }
        continue;
      }
      out.push(`${kv[1]}"${REDACTED_PLACEHOLDER}"`);
      i++;
      continue;
    }
    const li = line.match(/^(\s*-\s+)(.*)$/);
    if (li) {
      const rest = li[2];
      const ikv = rest.match(/^([A-Za-z_][A-Za-z0-9_.-]*\s*:\s*)(.*)$/);
      if (ikv) {
        const iv = ikv[2].trim();
        if (iv === '' || iv.startsWith('#')) { out.push(line); i++; continue; }
        out.push(`${li[1]}${ikv[1]}"${REDACTED_PLACEHOLDER}"`);
        i++;
        continue;
      }
      if (rest.trim() === '' || rest.trim().startsWith('#')) { out.push(line); i++; continue; }
      out.push(`${li[1]}"${REDACTED_PLACEHOLDER}"`);
      i++;
      continue;
    }
    i++; // 无法识别的裸行/续行：整行丢弃（防泄露优先于保行）
  }
  return out.join('\n');
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
  return destName.endsWith('.yaml') ? redactYamlContent(text) : redactEnvContent(text);
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

export {
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
  REDACTED_PLACEHOLDER,
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
};
