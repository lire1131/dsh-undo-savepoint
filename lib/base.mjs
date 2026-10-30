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

/** W73（#50）：对话头按钮档位白名单。auto 交给 .titleRow 的容器查询，full / compact 强制。 */
const HEADER_MODES = ['auto', 'full', 'compact'];
/** W73：读取点统一校验，非法值返回 undefined，让调用链继续回落默认 auto。 */
function normalizeHeaderMode(v) {
  return HEADER_MODES.includes(v) ? v : undefined;
}

const DEFAULT_SETTINGS = {
  autoEnabled: true,
  watchDebounceMs: 1500,
  keepAuto: 20,
  keepPre: 10,
  autoCleanup: true,
  // W73（#50）：对话头按钮档位（auto / full / compact）。WebUI 设置页可改，两端接口同形。
  headerMode: 'auto',
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
// W49（issue #39）：补丁层与 profile 层的 YAML 此前明文入库。三份名字必须与
// destName(spec) 的产出逐字相同（spec.json 的 configFiles 里这三项本就已采集）。
const SENSITIVE_DESTS = new Set([
  'home-.env',
  'profile-.env',
  'home-.credentials.yaml',
  'home-settings.yaml',
  'home-cordis.patch.yml',
  'profile-cordis.patch.yml',
  'profile-cordis.yml',
]);
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
    // 裸的空流式标记（顶层 `[]` / `{}`）是合法的空文档，且对补丁层与 profile 根文件
    // 是语义必要行（W49 边界修正：此前会被下面那条整行丢弃）。只放行这两个字面量，
    // 其余无法识别的裸行与续行仍按原策略整行丢弃（防泄露优先于保行）。
    if (line.trim() === '[]' || line.trim() === '{}') { out.push(line); i++; continue; }
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

/**
 * 该 dest 名是否走 YAML 脱敏（W49，issue #39）：同时认 .yaml 与 .yml。
 * 三处（本文件的 redactByDest、snapshot.mjs 采集、core.mjs 还原守卫二）共用，
 * 避免后缀口径漂移。守卫二若漏认 .yml，会把 "***REDACTED***" 写回活文件。
 */
function isYamlDest(destName) {
  return typeof destName === 'string' && (destName.endsWith('.yaml') || destName.endsWith('.yml'));
}

/** 按文件类型脱敏文本（.env 行级 / YAML 键值）。对已脱敏文本幂等。 */
function redactByDest(destName, text) {
  return isYamlDest(destName) ? redactYamlContent(text) : redactEnvContent(text);
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

/**
 * 读取指定路径的 settings JSON 原始对象（不合并默认值，保留“键是否存在”的信息）。
 * 切库时用它读目标实例自己的设置；读不到返回 null，由调用方回落到默认。
 * @param {string} path
 * @returns {object|null}
 */
function loadSettingsAt(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

/**
 * 把一份原始 settings 对象里存在的用户可编辑键应用到 cfg。
 * 只覆盖文件里确实写了的键，未写的保持 cfg 现值；consent/consentAt 属安装态，不在此列。
 * @param {object} cfg
 * @param {object|null} raw
 * @returns {{dirsChanged: boolean}}
 */
function applySettingsToCfg(cfg, raw) {
  if (!raw || typeof raw !== 'object') return { dirsChanged: false };
  const hadManual = cfg.manualDir;
  const hadAuto = cfg.autoDir;
  const str = (k) => { if (typeof raw[k] === 'string' && raw[k].trim() !== '') cfg[k] = raw[k].trim(); };
  const num = (k, lo, hi) => { if (Number.isFinite(raw[k])) cfg[k] = Math.min(hi, Math.max(lo, Math.round(raw[k]))); };
  const bool = (k) => { if (typeof raw[k] === 'boolean') cfg[k] = raw[k]; };
  bool('autoEnabled');
  num('watchDebounceMs', 200, 60000);
  num('keepAuto', 1, 500);
  num('keepPre', 0, 500);
  bool('autoCleanup');
  str('manualDir');
  str('autoDir');
  if (raw.sensitiveMode === 'redact' || raw.sensitiveMode === 'keep') cfg.sensitiveMode = raw.sensitiveMode;
  // W73（#50）：对话头按钮档位。文件里写了非法值时按规划口径回落 auto（不是保留旧值）；
  // 键不存在时保持 cfg 现值，避免热重读把没碰过的设置改掉。
  if (raw.headerMode !== undefined) cfg.headerMode = normalizeHeaderMode(raw.headerMode) ?? DEFAULT_SETTINGS.headerMode;
  if (Array.isArray(raw.pluginDirs)) cfg.pluginDirs = raw.pluginDirs.map((x) => String(x).trim()).filter(Boolean);
  if (Array.isArray(raw.workspaceDirs)) cfg.workspaceDirs = raw.workspaceDirs.map((x) => String(x).trim()).filter(Boolean);
  bool('workspaceWatch');
  bool('createDesktopShortcut');
  if (typeof raw.desktopDir === 'string' || raw.desktopDir === null) cfg.desktopDir = raw.desktopDir;
  bool('scheduledSnapshotEnabled');
  if (Number.isFinite(raw.scheduledSnapshotMs)) cfg.scheduledSnapshotMs = Math.max(0, Math.round(raw.scheduledSnapshotMs));
  bool('bootHealthEnabled');
  bool('upgradeGuardEnabled');
  if (Number.isFinite(raw.autoSafeModeAfterFails)) cfg.autoSafeModeAfterFails = Math.max(0, Math.round(raw.autoSafeModeAfterFails));
  if (raw.guardAutoSafeMode === 'ask' || raw.guardAutoSafeMode === 'on' || raw.guardAutoSafeMode === 'off') cfg.guardAutoSafeMode = raw.guardAutoSafeMode;
  bool('guardShortcutEnabled');
  if (Number.isFinite(raw.keepMessageOps)) cfg.keepMessageOps = Math.max(0, Math.round(raw.keepMessageOps));
  if (Array.isArray(raw.fileToolWhitelist)) cfg.fileToolWhitelist = raw.fileToolWhitelist.map((x) => String(x));
  return { dirsChanged: cfg.manualDir !== hadManual || cfg.autoDir !== hadAuto };
}

/** argv 的 `--profile` 解析（W47）：只做命令行层，未命中返回 null 而不是兜底值，
 *  好让 resolveProfileName 能区分「argv 命中」与「整条链都没命中」。 */
function profileFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--profile') {
      const next = list[i + 1];
      if (typeof next === 'string' && next && !next.startsWith('-')) return next;
      continue; // 该写法没带值：继续往后找 `--profile=X`，语义与旧实现逐字一致
    }
    if (typeof a === 'string' && a.startsWith('--profile=')) {
      // 逐字保持旧行为：`--profile=` 命中即返回（可能为空串）。空串在 resolveProfileName
      // 里被视作未命中，但 detectProfileName 的旧语义必须原样保留。
      return a.slice('--profile='.length);
    }
  }
  return null;
}

/** 解析当前 DSH profile（v0.3.3，issue #3）。`dsh web` 是 `--profile web` 的别名。
 *  W47：改为 profileFromArgv 的薄包装，签名、默认值（process.argv）与兜底 `'web'`
 *  逐字不变，既有调用点与既有测试读到的行为保持原样。 */
function detectProfileName(argv = process.argv ?? []) {
  return profileFromArgv(argv) ?? 'web';
}

/**
 * W47 六层 profile 解析（issue #43 问题 1、#44 问题 1）。层序由决策点 9 拍板，
 * 越靠前越可信，不得改序：
 *   1 plugin config 的 profileName（显式配置层，用户写下的意志）
 *   2 settings 文件的 profileName
 *   3 argv 的 --profile
 *   4 宿主 profile 通道（profileContext 服务的 name）
 *   5 环境变量 DSH_PROFILE
 *   6 web 兜底
 * 返回 { name, source }，source 与层一一对应：config / settings / arg / host / env / default。
 * settings 层由本函数自行 loadSettingsFile()，调用方不必先读设置文件。
 * @param {{configProfileName?: unknown, argv?: readonly string[], hostProfileName?: unknown}} [opts]
 */
function resolveProfileName(opts = {}) {
  const nonEmpty = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
  const fromConfig = nonEmpty(opts.configProfileName);
  if (fromConfig) return { name: fromConfig, source: 'config' };
  const fromSettings = nonEmpty(loadSettingsFile().profileName);
  if (fromSettings) return { name: fromSettings, source: 'settings' };
  const fromArg = nonEmpty(profileFromArgv(opts.argv ?? process.argv));
  if (fromArg) return { name: fromArg, source: 'arg' };
  const fromHost = nonEmpty(opts.hostProfileName);
  if (fromHost) return { name: fromHost, source: 'host' };
  // #44 实测：DSH_PROFILE 与 DSH_PROFILE_DIR 由 shell-env registry 按 profileContext 逐次
  // 注入「模型的 shell 子进程」，插件宿主进程读不到。因此本层对桌面形态无效，只对 CLI
  // 用户手工 export 有效。保留作 CLI 兜底，且不得当作桌面问题的修复手段。
  const fromEnv = nonEmpty(process.env.DSH_PROFILE);
  if (fromEnv) return { name: fromEnv, source: 'env' };
  return { name: 'web', source: 'default' };
}

/** 旧版平铺 / `web` 作用域：桌面用户历史快照的落点，连续性守卫要认这两个位置。 */
const INHERIT_PROFILE = 'web';

/** 按 profile 分片的作用域快照仓库（不做任何存在性判断）。 */
function scopedStoreRoots(profileName) {
  const scoped = join(LEGACY_ROOT, profileName);
  return { manualDir: join(scoped, 'manual'), autoDir: join(scoped, 'auto') };
}

/**
 * 快照仓库按 profile 隔离；兼容旧平铺布局（profile 作用域目录不存在时回退平铺）。
 * W47 连续性守卫：改链之后，桌面用户的既有快照可能仍记在 `web` 作用域或旧平铺布局下。
 * 当解析来源是自动来源（`settings` / `default`）且目标作用域尚无快照，而 `web` 作用域或
 * 平铺布局已有快照时，沿用既有位置，让用户的 `undo_list` 不突然变空。
 * **显式来源（config / arg / host / env）不触发继承**：用户明说了用哪个 profile 就照着来。
 * `web` 自身也不触发继承，否则平铺布局的既有回退会失效。
 * @param {string} profileName
 * @param {{source?: string}} [opts]
 * @returns {{manualDir: string, autoDir: string, inheritedFrom?: string}}
 */
function resolveStoreRoots(profileName, opts = {}) {
  const scoped = scopedStoreRoots(profileName);
  const flat = { manualDir: join(LEGACY_ROOT, 'manual'), autoDir: join(LEGACY_ROOT, 'auto') };
  const has = (d) => existsSync(join(d, 'auto')) || existsSync(join(d, 'manual'));
  const hasScoped = has(join(LEGACY_ROOT, profileName));
  const hasFlat = has(LEGACY_ROOT);
  const autoSource = opts.source === 'settings' || opts.source === 'default';
  if (autoSource && profileName !== INHERIT_PROFILE && !hasScoped) {
    const webScoped = has(join(LEGACY_ROOT, INHERIT_PROFILE));
    if (webScoped) return { ...scopedStoreRoots(INHERIT_PROFILE), inheritedFrom: INHERIT_PROFILE };
    if (hasFlat) return { ...flat, inheritedFrom: 'flat' };
  }
  if (hasScoped || !hasFlat) return scoped;
  return flat;
}

/**
 * 判定快照库根的作用域，供状态接口做「profile 标签 ↔ 库内容」绑定校验。
 * - flat：<LEGACY_ROOT>/{manual,auto}，跨 profile 共享（历史默认布局）；
 * - scoped：<LEGACY_ROOT>/<profile>/{manual,auto}，按 profile 分片；
 * - custom：用户自定义目录，或只有一半落在默认布局。
 * shared=true 表示该库不与 profile 绑定，面板必须显式标注，不能只报 profile 名。
 * 纯函数，不读盘，双端与单测直接复用。
 * @param {string} profileName
 * @param {string} manualDir
 * @param {string} autoDir
 * @returns {{root: string, scope: 'flat'|'scoped'|'custom', shared: boolean}}
 */
function describeStore(profileName, manualDir, autoDir) {
  const norm = (p) => {
    const s = resolve(String(p ?? ''));
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const base = norm(LEGACY_ROOT);
  const flat = norm(join(base, 'manual')) === norm(manualDir) && norm(join(base, 'auto')) === norm(autoDir);
  const scoped = norm(join(base, profileName, 'manual')) === norm(manualDir) && norm(join(base, profileName, 'auto')) === norm(autoDir);
  const scope = flat ? 'flat' : scoped ? 'scoped' : 'custom';
  return { root: dirname(resolve(String(manualDir ?? ''))), scope, shared: scope === 'flat' };
}

/**
 * 构建引擎用的 cfg 对象。局内（index.js 的 apply）与局外（undo-server.mjs，无 ctx）
 * 共用一个纯数据 cfg 构造器，保证双端路径/设置语义一致。
 * @param {object} [overrides] 可覆盖 homeDir/profileDir/sensitiveMode/bootAlert/profileName 等
 */
function buildConfig(overrides = {}) {
  // W47：六层解析器的唯一落点。hostProfileName 由宿主侧（index.js）从 profileContext
  // 服务取到后传进来；局外工具与 CLI 不传，该层恒空。
  const resolved = resolveProfileName({
    configProfileName: overrides.profileName,
    argv: overrides.argv,
    hostProfileName: overrides.hostProfileName,
  });
  const profileName = resolved.name;
  const homeDir = overrides.homeDir ?? DSH_HOME;
  // profileDir 默认必须跟着「生效的 home」走，不能写死模块级 DSH_HOME：
  // 否则显式传 homeDir 的调用方（W47 用例 7 的非默认 home、离线工具的隔离夹具）
  // 拿到的 profileDir 仍指向真实 home，夹具读不到自己的 patch 文件。
  const profileDir = overrides.profileDir ?? join(homeDir, 'profiles', profileName);
  const fileSettings = loadSettingsFile();
  const roots = resolveStoreRoots(profileName, { source: resolved.source });
  return {
    ...fileSettings,
    profileName,
    /** W47：profile 名的解析来源（config / settings / arg / host / env / default）。 */
    profileSource: resolved.source,
    /** W47：作用域为空而沿用历史快照位置时，记下沿用的位置。 */
    storeInheritedFrom: roots.inheritedFrom ?? null,
    homeDir,
    profileDir,
    // 连续性守卫必须排在本机历史设置之前：DEFAULT_SETTINGS.manualDir/autoDir 硬写的是
    // 平铺路径（`<LEGACY_ROOT>/auto`），会把守卫算出的 web 作用域硬盖回去，守卫在真实链路上
    // 等于没接。仅在守卫确实命中（roots.inheritedFrom 有值）时让 roots 优先，其余情况
    // 保持原有取值顺序，显式覆盖与设置文件的作用照旧。
    manualDir: overrides.manualDir ?? (roots.inheritedFrom ? roots.manualDir : (fileSettings.manualDir ?? roots.manualDir)),
    autoDir: overrides.autoDir ?? (roots.inheritedFrom ? roots.autoDir : (fileSettings.autoDir ?? roots.autoDir)),
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
  HEADER_MODES,
  normalizeHeaderMode,
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
  isYamlDest,
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
  loadSettingsAt,
  applySettingsToCfg,
  detectProfileName,
  resolveProfileName,
  resolveStoreRoots,
  describeStore,
  buildConfig,
  readManifest,
  writeManifest,
  storeDirs,
  discoverPlugins,
  collectPluginTree,
  collectProfileCodeRefs,
  isPluginEcho,
};
