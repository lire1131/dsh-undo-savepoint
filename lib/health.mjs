/**
 * dsh-undo-savepoint: 启动健康与安全守卫（崩溃归因 / 补丁托管 / 安全模式 / doctor / 体检）。
 *
 * V0.5.0 拆分（W17）：本模块承接原 lib/core.mjs 的崩溃归因（A）、补丁托管与安全模式（B）、
 * doctor 与修复（C）、环境预检辅助（W34）与体检族（D 区段），逐字节搬移、零行为变化。
 * core.mjs 保持同名 re-export，对外 API 面不变；W18 的升级护航追加在本文件末尾。
 *
 * 依赖方向：health -> snapshot -> session -> base（单向）。
 */
import { execFile } from 'node:child_process';
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

// ── 条目切分与悬空 insert 键（W46 交付，W48 由 core.mjs 下沉到本模块）─────────
// 下沉原因：doctor 的启动预检要报告悬空 `insert:` 键，而分层是 health -> snapshot
// -> session -> base 单向的，health 不能反向 import core。这几个都是纯文本函数，
// 只依赖自身与 fs，落在本模块不引入任何新依赖；core.mjs 改为从本模块导入后再
// 按原样 re-export（findDanglingInserts / cleanDanglingInserts 对外 API 面不变）。

/**
 * 条目级判定（W46，issue #43）。
 * 摘除粒度是条目而非行，因此判定也必须落在条目上，否则「同一 `- insert:` 键下
 * 并列用户条目」会被连带删除。
 */
const ITEM_START_RE = /^\s*-\s+/;

/** 按条目切分文本，兼顾缩进层级：一条 `- ` 起行的记录连同其后缩进更深的行算一个条目；
 * 缩进回到同级或更浅的 `- ` 行开启下一个条目。返回的条目数组按原序拼接即原文，不丢行。
 * 缩进跟踪必须落在「条目起始行」的缩进上，否则同级兄弟条目会被吞进上一条目的树里。 */
function splitItems(text) {
  const lines = text.split('\n');
  const items = [];
  let cur = null;
  let itemIndent = -1;    // 当前条目起始 `- ` 行的缩进
  let childIndent = -1;   // 当前条目内已出现的最深缩进（吸收子行用）
  for (const line of lines) {
    const m = line.match(/^[ \t]*/);
    const ind = (m ? m[0].length : 0);
    if (line.trim() === '') { if (cur) cur.push(line); else items.push([line]); continue; }
    if (ITEM_START_RE.test(line)) {
      const startsNew = !cur || ind <= itemIndent || ind <= childIndent;
      if (startsNew) {
        if (cur) items.push(cur);
        cur = [line];
        itemIndent = ind;
        childIndent = ind;
      } else {
        cur.push(line);
        childIndent = Math.max(childIndent, ind);
      }
      continue;
    }
    if (cur && ind > itemIndent) {
      cur.push(line);
      // W48 实测修正：注释行的缩进是排版自由度，不代表真实嵌套层级。让注释抬高
      // childIndent，会把紧随其后、同缩进的真子条目判成兄弟条目，于是「键下有内容」
      // 被误判成悬空 `insert:` 键；实机 profile patch 里 `- insert:` + 缩进注释 +
      // 缩进子条目就是这种形态。注释仍然随条目保留，只是不再影响层级判定。
      if (!/^\s*#/.test(line)) childIndent = Math.max(childIndent, ind);
      continue;
    }
    if (cur) items.push(cur);
    cur = null;
    itemIndent = -1;
    childIndent = -1;
    items.push([line]);
  }
  if (cur) items.push(cur);
  return { items };
}

/** 条目是否「以 insert 键起头且键下没有任何列表子条目」。
 * 列表形（`- insert:`）与映射形（`insert:`）都认，判定落在条目边界上，
 * 因此不会把 `- insert:` 的同级兄弟条目误当成它的子条目。 */
function isDanglingInsertItem(item) {
  if (!item || !item.length) return false;
  const head = item[0];
  if (!/^\s*(?:-\s*)?insert:\s*(\{\s*\})?\s*$/.test(head)) return false;
  for (let i = 1; i < item.length; i += 1) {
    const l = item[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    return false;   // 键下还有实内容或子条目 ⇒ 不算悬空
  }
  return true;
}

/**
 * 悬空 `insert:` 键检出（W46）。悬空定义：键起头的条目里除键行自身外没有任何实内容。
 * @returns {Array<{line:number,text:string}>} 行号从 1 起
 */
function findDanglingInserts(text) {
  const lines = String(text).split('\n');
  const hits = [];
  let cursor = 0;
  for (const it of splitItems(String(text)).items) {
    const startLine = cursor + 1;
    cursor += it.length;
    if (isDanglingInsertItem(it)) hits.push({ line: startLine, text: it[0] });
  }
  return hits;
}

/** 就地清理悬空 `insert:` 键条目，返回清理条数。幂等。
 * 不牵连注释：注释行不进入条目树，无法判定归属，而紧邻的注释通常是文件级说明，
 * 误删的代价高于留一行注释。插件挂载自带的标记注释由 removeMountBlock 随条目清除。 */
async function cleanDanglingInserts(file) {
  const text = await fs.readFile(file, 'utf8');
  const hits = findDanglingInserts(text);
  if (!hits.length) return 0;
  const keep = [];
  for (const it of splitItems(text).items) {
    if (isDanglingInsertItem(it)) continue;
    keep.push(...it);
  }
  await fs.writeFile(file, keep.join('\n').replace(/\s+$/, '') + '\n', 'utf8');
  return hits.length;
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
/** W48：桌面形态判定。输入复用 W47 的解析结果（cfg.profileName），这里不重新解析
 * profile 名；体检逐个 profile 判定时传被检 profile 的目录，判定跟着那一份 profile 走。
 * 工单原文另有「来源为 W47 的 host 层且宿主报的是桌面」一条，实现上与名字判定合并：
 * W47 已把宿主报出的名字写进 cfg.profileName，来源为 host 且名为 desktop 时第一条即
 * 命中，因此不必再读 profileSource，也避免留下一条永不生效的分支。 */
const DESKTOP_PROFILE_NAME = 'desktop';
function isDesktopProfile(cfg, profileDir) {
  // W48 施工期修正（E83）：只认「将要被改写的那个 profile 目录」的末级名，不再回落到
  // cfg.profileName。真实桌面形态下本插件拿到的 profileDir 就是 <home>/profiles/desktop，
  // 末级名即 profile 名，两种口径判定一致；而 profileName 可以被宿主或环境注入
  // （本机 shell 就常驻 DSH_PROFILE=desktop），profileDir 又常被工具与隔离实例显式覆盖，
  // 两者不一致时只有目录能说明这次写盘落在谁身上，按 profileName 判会误拒非桌面 profile。
  const dir = profileDir ?? rootDir(cfg, 'profile');
  return basename(String(dir ?? '')).trim().toLowerCase() === DESKTOP_PROFILE_NAME;
}

/** W43：桌面端进程名。三平台同一个字符串，win32 的映像名多一个 .exe 后缀，按子串匹配即可
 * 覆盖两种写法（本机实测映像名为 `DeepSeek Harness.exe`）。 */
const DESKTOP_PROCESS_NAME = 'DeepSeek Harness';

/** W43：子进程探测的超时上界。原在 core.mjs 的快捷方式段落，doctor 的桌面探测要用同一个
 * 上界，按分层方向（health 在 core 之下）下沉到本模块，core.mjs 改为从本模块导入，
 * 单点定义、不复刻数值；数值与用法均未变。 */
const SHORTCUT_TOOL_TIMEOUT = 15000;

/** W43：桌面端是否在运行。三种结果 running / not-running / unknown，任何失败都不外抛：
 * unknown 与 not-running 一样不报警，避免误伤在 CI、隔离实例或没有权限枚举进程的机器上
 * 跑的体检。命令与参数可注入（inOpts.desktopProbeCommand / desktopProbeArgs），门禁用假输出
 * 钉住解析分支；DSH_UNDO_NO_DESKTOP=1 短路为 not-running（隔离实例与冒烟测试的既有开关）。
 * 平台口径：win32 用 tasklist.exe 全量列举后对映像名做子串匹配，不按 IMAGENAME 过滤。
 * 过滤写法要求写全 .exe，且无匹配时输出的提示文案随系统语言变化，两者都不可依赖。
 * 其余平台用 pgrep -f，退出码 1 是「没有匹配进程」的约定语义，其余失败记 unknown。 */
async function desktopProcessState(inOpts = {}) {
  if (process.env.DSH_UNDO_NO_DESKTOP === '1') return 'not-running';
  const win = (inOpts.platform ?? process.platform) === 'win32';
  const cmd = inOpts.desktopProbeCommand ?? (win ? 'tasklist.exe' : 'pgrep');
  const args = inOpts.desktopProbeArgs ?? (win ? ['/nh', '/fo', 'csv'] : ['-f', DESKTOP_PROCESS_NAME]);
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: SHORTCUT_TOOL_TIMEOUT, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        // pgrep 无匹配时退出码为 1，属正常结果，不是探测失败。
        resolve(!win && err.code === 1 ? 'not-running' : 'unknown');
        return;
      }
      resolve(String(stdout ?? '').toLowerCase().includes(DESKTOP_PROCESS_NAME.toLowerCase()) ? 'running' : 'not-running');
    });
  });
}

/** W43-4：插件自身的包名。清单的挂载声明与补丁文件的条目都按这个字符串判定，
 * 官方 sanitize 痕迹的三要素之一也是它。 */
const PLUGIN_NAME = 'dsh-undo-savepoint';

/** W43-4：官方 sanitize 备份文件名。桌面端启动失败时，官方恢复弹窗的第三项把补丁文件
 * 改名为 cordis.patch.yml.bak-<时间戳> 并在同目录留档，界面上没有恢复入口。 */
const SANITIZE_BACKUP_RE = /^cordis\.patch\.yml\.bak-/;

/** W43-4：识别官方 sanitize 痕迹。三要素必须同时成立，缺一个都不算，命中返回最新的那份
 * 备份名，否则返回 null：
 * 1) profile 目录下有 .bak-<时间戳> 备份；2) 当前补丁文件里不再出现本插件；
 * 3) 清单的 dsh.profile.bundles 里也没有本插件。
 * 只凭备份存在就报会误伤用户自己拖出来的备份，只凭插件缺失就报会把「用户主动卸载」
 * 也算成官方动作。时间戳串按字典序即时序，取最后一份即最新。 */
async function sanitizeTrace(dir, pkg) {
  let names;
  try { names = await fs.readdir(dir); } catch { return null; }
  const backups = names.filter((n) => SANITIZE_BACKUP_RE.test(n)).sort();
  if (backups.length === 0) return null;
  try {
    if ((await fs.readFile(join(dir, 'cordis.patch.yml'), 'utf8')).includes(PLUGIN_NAME)) return null;
  } catch { /* 当前补丁文件不存在，与「里面没有本插件」同解 */ }
  const bundles = pkg?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.includes(PLUGIN_NAME)) return null;
  return { backup: backups[backups.length - 1] };
}

// ── W50：部分 sanitize（第二个检出面）────────────────────────────────────
// W43-4 的三要素只在「补丁与 bundles 都没有本插件」时命中。桌面端官方恢复弹窗还有
// 第二种落点：bundles 已经恢复、补丁内容却缺了几条，三要素因此都不成立，现场表现为
// 插件在、配置静默消失。这里按条目名级比对最新备份与当前补丁，只报差集，不做文本 diff。

/** 条目首行的 id 值；不是 `- id:` 形态返回 null。 */
function entryIdOf(item) {
  const m = /^\s*-\s*id:\s*(\S+)\s*$/.exec(item?.[0] ?? '');
  return m ? m[1] : null;
}

/** 行首缩进长度（空格与制表符都算 1 列）。 */
function indentOf(line) {
  const m = /^[ \t]*/.exec(String(line ?? ''));
  return m ? m[0].length : 0;
}

/**
 * 解析补丁文本里 `- ` 行的缩进树：每行给出 {idx,indent,parent}，parent 为 -1 表示顶层。
 * 必须自己解树，不能复用 splitItems：splitItems 每条目只吸收一层缩进，条目内一旦出现更深
 * 缩进，同缩进的兄弟子条目就被判成顶层。真机备份的 `- insert:` 下正是「子条目带更深 config
 * 行 + 第二条同缩进子条目」这种形态，用它会漏掉第二条 insert 条目、并把它错当顶层配置键，
 * 恢复时就会写到顶层（重复 loader entry id，冷启动进安全模式）。
 * 父链取「比本行更浅的最近候选行」，因此 `- id: x` 下再挂 `args:` 列表时，args 的列表项也
 * 会成为候选父，不会破坏 insert 子条目的父链深度。
 */
function seqLines(text) {
  const lines = String(text).split('\n');
  const rows = [];
  for (const [idx, line] of lines.entries()) {
    if (!ITEM_START_RE.test(line)) continue;
    const ind = indentOf(line);
    let parent = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].indent < ind) { parent = rows[i].idx; break; }
    }
    rows.push({ idx, indent: ind, parent });
  }
  return rows;
}

/** 缩进树里某行的直属子行。 */
function seqChildren(lines, rows, parentIdx) {
  return rows.filter((r) => r.parent === parentIdx).map((r) => lines[r.idx]);
}

/** 条目首行是否 `insert:` 形态（列表形 `- insert:` 与映射形 `insert:` 都认）。 */
function isInsertKeyLine(line) {
  return /^\s*(?:-\s*)?insert:\s*$/.test(String(line ?? ''));
}

/** 条目首行是否顶层配置键（零缩进的 `key:`），是则返回键名。
 *  只认零缩进：缩进键属于某个条目的内部配置，不是顶层键。 */
function topLevelKeyOf(line) {
  const m = /^([A-Za-z_][\w.-]*):(?:\s.*)?$/.exec(String(line ?? ''));
  return m ? m[1] : null;
}

/**
 * W50：提取补丁文本的条目名集合（纯函数，零依赖）。
 * - 顶层配置键：零缩进的 `key:` 形态（`- id: x` 这类列表条目不是键，归下面的条目档）；
 * - insert 条目：`- insert:` 键条目树内的 `- id:` 子条目名，即真正会丢的那几条配置。
 * 比对粒度是条目名，同键名即视为存在，值不同不算差异（用户重配过是合法状态）。
 */
function collectPatchEntryIds(text) {
  const lines = String(text).split('\n');
  const rows = seqLines(text);
  const topKeys = new Set();
  const insertIds = new Set();
  for (const r of rows) {
    const line = lines[r.idx];
    const key = topLevelKeyOf(line);
    if (key) { topKeys.add(key); continue; }
    if (r.parent !== -1) continue;      // 序列子条目不是顶层配置键
    const id = entryIdOf([line]);
    if (id) topKeys.add(id);
    if (!isInsertKeyLine(line)) continue;
    for (const child of seqChildren(lines, rows, r.idx)) {
      const cid = entryIdOf([child]);
      if (cid) insertIds.add(cid);
    }
  }
  return { topKeys: [...topKeys], insertIds: [...insertIds] };
}

/** 排序后的差集（备份有、当前没有的名字）。 */
function missingNames(from, have) {
  const seen = new Set(have);
  return [...new Set(from)].filter((n) => !seen.has(n)).sort();
}

/**
 * W50 检出：部分 sanitize 痕迹。四条件全中才算命中：
 * 1) 同目录有 `SANITIZE_BACKUP_RE` 备份，取字典序最新（13 位毫秒串，字典序即时序）；
 * 2) 时间不倒挂：最新备份的 mtime 不晚于当前补丁的 mtime（同秒视为不倒挂）。官方动作序列
 *    必然是「先备份后重建」，倒挂说明这份备份更可能是用户自己拖出来的，保守不报；
 * 3) 条目名级差集非空（顶层键或 insert 条目至少一条）；
 * 4) 分级：有缺失 insert 条目 ⇒ warn 且 fixable；只有顶层键差异 ⇒ info 且不带 fixable。
 * 与 sanitizeTrace 并存互不替代，真机上两者按各自条件独立判定。
 */
async function partialSanitizeTrace(dir) {
  let names;
  try { names = await fs.readdir(dir); } catch { return null; }
  const backups = names.filter((n) => SANITIZE_BACKUP_RE.test(n)).sort();
  if (backups.length === 0) return null;
  const backup = backups[backups.length - 1];
  const patch = join(dir, 'cordis.patch.yml');
  let patchText = null;
  try { patchText = await fs.readFile(patch, 'utf8'); } catch { /* 当前补丁缺失：整份内容都算缺失 */ }
  if (patchText !== null) {
    try {
      const bakMs = (await fs.stat(join(dir, backup))).mtimeMs;
      const curMs = (await fs.stat(patch)).mtimeMs;
      if (bakMs > curMs) return null;
    } catch { /* 取不到 mtime 就不做倒挂判断，交给差集 */ }
  }
  let bakText;
  try { bakText = await fs.readFile(join(dir, backup), 'utf8'); } catch { return null; }
  const pre = collectPatchEntryIds(bakText);
  const post = patchText === null
    ? { topKeys: [], insertIds: [] }
    : collectPatchEntryIds(patchText);
  const missingInserts = missingNames(pre.insertIds, post.insertIds);
  const missingKeys = missingNames(pre.topKeys, post.topKeys);
  if (missingInserts.length === 0 && missingKeys.length === 0) return null;
  return { backup, missingInserts, missingKeys, level: missingInserts.length > 0 ? 'warn' : 'info' };
}

/** 补丁文本里的根级条目缩进长度；没有任何 `- ` 行时退回 0。 */
function rootItemIndent(text) {
  const m = /^([ \t]*)- /.exec(String(text));
  return m ? m[1].length : 0;
}

/**
 * W50 恢复（纯函数）：条目级搬回。从备份抽出缺失条目的完整文本块，按备份原序追加到
 * 当前补丁的对应尾部；当前已有条目一律不动，绝不整文件覆盖（现场当前补丁含备份里没有的
 * 条目，覆盖会制造二次伤害）。缩进基准 = 现有条目实测缩进，取不到时按 YAML 序列约定退一级。
 * @returns {{text:string,moved:number}} moved 为实际搬回条数
 */
function mergePatchEntries(currentText, backupText) {
  const pre = collectPatchEntryIds(backupText);
  const post = collectPatchEntryIds(currentText);
  const missInsert = new Set(missingNames(pre.insertIds, post.insertIds));
  const missKeys = new Set(missingNames(pre.topKeys, post.topKeys));
  if (missInsert.size === 0 && missKeys.size === 0) return { text: currentText, moved: 0 };

  // 只定位插入点与缩进基准，原文一律按行原样保留（不重排、不重写任何既有行）。
  const lines = String(currentText).split('\n');
  const rootIndent = lines.some((l) => /^- /.test(l)) ? rootItemIndent(currentText)
    : (lines.some((l) => /^\s*(?:-\s*)?insert:\s*$/.test(l)) ? 2 : 0);
  const curRows = seqLines(currentText);
  const bakRows = seqLines(backupText);
  const bakLines = String(backupText).split('\n');
  const childrenOf = (rows, idx) => rows.filter((r) => r.parent === idx);
  /** 某行所属块（它自身 + 全部后代）的末行号。 */
  const blockEnd = (rows, idx) => {
    const kids = [];
    for (const r of rows) {
      let p = r.parent;
      for (let hop = 0; p !== -1 && hop < 64; hop += 1) {
        if (p === idx) { kids.push(r.idx); break; }
        p = rows.find((q) => q.idx === p)?.parent ?? -1;
      }
    }
    return kids.length ? Math.max(...kids) : idx;
  };
  /** 下一个同级或更浅的 `- ` 行（条目界的判据）。 */
  const nextRowAt = (rows, idx, limit) => rows.find((r) => r.idx > idx && r.indent <= limit);
  /** 条目自身结束的行号：含条目内部 name/config 行，止于下一个同级或更浅条目之前。 */
  const entryEnd = (text, rows, idx) => {
    const stop = nextRowAt(rows, idx, rows.find((r) => r.idx === idx).indent);
    const start = blockEnd(rows, idx);
    const src = String(text).split('\n');
    const limit = stop ? stop.idx : src.length;
    let last = start;
    for (let i = start + 1; i < limit; i += 1) if (src[i].trim() !== '') last = i;
    return last;
  };
  /** 「本插件挂载块」注释头之前的空行位置；没有挂载块时为 -1。 */
  const mountAnchor = (() => {
    for (let i = 0; i < lines.length; i += 1) {
      if (!/dsh-undo-savepoint mount/.test(lines[i])) continue;
      let head = i;
      while (head > 0 && lines[head - 1].trim() === '') head -= 1;
      return head - 1;
    }
    return -1;
  })();
  let insertEnd = -1;        // `- insert:` 条目块末行号 + 1（新增 insert 子条目插在这里）
  let insertIndent = null;   // 该块内直属子条目的实测缩进
  let rootsEnd = -1;         // 顶层条目区最后一行的行号（新增顶层条目接在它后面）
  for (const r of curRows) {
    if (r.parent !== -1) continue;
    const line = lines[r.idx];
    if (isInsertKeyLine(line)) {
      insertEnd = blockEnd(curRows, r.idx) + 1;
      const kids = childrenOf(curRows, r.idx).filter((c) => /^\s*- id:/.test(lines[c.idx]));
      if (kids.length) insertIndent = indentOf(lines[kids[0].idx]);
      continue;
    }
    if (entryIdOf([line])) rootsEnd = entryEnd(currentText, curRows, r.idx);
  }
  // 末段是挂载块时，新顶层条目插在它的注释头之前：挂载块永远保持在文件尾部。
  // 条目区有时会把挂载块前的注释行一并卷进来（注释行非空），这里按锚点收紧。
  if (mountAnchor >= 0) rootsEnd = Math.min(rootsEnd, mountAnchor);
  // 备份侧抽块：条目盒 = 从条目行到条目结束行，含 name/config 行与尾部注释空行；
  // 有后一个同级或更浅条目时以它为界，避免把下一条的内容卷进来。按备份原序产出。
  const boxEnd = (rows, idx) => {
    const stop = nextRowAt(rows, idx, rows.find((r) => r.idx === idx).indent);
    let end = entryEnd(backupText, rows, idx);
    if (!stop) {
      end = bakLines.length - 1;
      while (end > idx && bakLines[end].trim() === '') end -= 1;
      return end;
    }
    end = Math.max(end, stop.idx - 1);
    while (end > idx && bakLines[end].trim() === '') end -= 1;
    return Math.min(end, stop.idx - 1);
  };
  const newInserts = [];
  const newRoots = [];
  let moveInsertCount = 0;
  let moveRootCount = 0;
  for (const r of bakRows) {
    if (isInsertKeyLine(bakLines[r.idx]) && r.parent === -1) {
      const indent = insertIndent ?? (r.indent + 2);
      const kids = childrenOf(bakRows, r.idx);
      for (const c of kids) {
        const cid = entryIdOf([bakLines[c.idx]]);
        if (!cid || !missInsert.has(cid)) continue;
        moveInsertCount += 1;
        const base = indentOf(bakLines[c.idx]);
        let stop = nextRowAt(bakRows, c.idx, c.indent)?.idx ?? bakLines.length;
        while (stop > c.idx && bakLines[stop - 1].trim() === '') stop -= 1;
        for (let i = c.idx; i < stop; i += 1) {
          const raw = bakLines[i];
          if (raw.trim() === '') { newInserts.push(''); continue; }
          const rest = raw.slice(Math.min(base, raw.length - raw.trimStart().length));
          newInserts.push(' '.repeat(indent) + rest);
        }
      }
      continue;
    }
    if (r.parent !== -1 || !missKeys.has(entryIdOf([bakLines[r.idx]]))) continue;
    moveRootCount += 1;
    const block = [];
    for (let i = r.idx; i <= boxEnd(bakRows, r.idx); i += 1) block.push(bakLines[i]);
    newRoots.push(block.join('\n'));
  }
  // 插入点：顶层条目接在最后一个顶层条目之后（挂载块因此自动留在末尾），insert 子条目接在
  // 现有 `- insert:` 块之后。两处同点时先顶层后 insert，用一次正序构建保住各自内部顺序。
  const at = new Map();
  const push = (pos, rows) => at.set(pos, [...(at.get(pos) ?? []), ...rows]);
  if (newRoots.length > 0) push(Math.max(rootsEnd + 1, 0), newRoots);
  if (newInserts.length > 0) {
    if (insertEnd >= 0) push(insertEnd, newInserts);
    else push(Math.max(rootsEnd + 1, 0), [
      ' '.repeat(rootIndent) + '- insert:',
      ...newInserts.map((l) => (l.trim() === '' ? l : ' '.repeat(rootIndent + 2) + l)),
    ]);
  }
  const out = [];
  for (let i = 0; i <= lines.length; i += 1) {
    if (at.has(i)) out.push(...at.get(i));
    if (i < lines.length) out.push(lines[i]);
  }
  const moved = moveInsertCount + moveRootCount;
  return { text: out.join('\n').replace(/\s+$/, '') + '\n', moved };
}

/** W48：官方核心 bundle 名单。这些件由桌面宿主自己拉起，桌面 profile 的 node_modules
 * 里通常没有它们，解析不到不算异常。判定范围限定在官方发行 scope 内（@deepseek-ai/dsh-*）：
 * 用户插件（含本插件 dsh-undo-savepoint）与第三方 scope 永不落入这一档，名单之外的名字
 * 照旧报 cannot resolve，真缺失不会被吞掉。
 * 实测依据：桌面 profile 的 bundles 里 @deepseek-ai/dsh-base 与 dsh-web-app 由宿主提供；
 * @deepseek-ai/dsh-experimental-voice-input-bundle 与 dsh-experimental-auto-review 在本机
 * 任何锚点下都解析不到，而桌面启动正常，说明它们同属宿主托管。 */
const HOST_MANAGED_BUNDLE_RE = /^@deepseek-ai\/dsh(?:-|$)/;
function isHostManagedBundle(name) {
  return typeof name === 'string' && HOST_MANAGED_BUNDLE_RE.test(name);
}

/** W48：dsh 安装目录锚点。探测链与 readDshVersion 同源（DSH_ROOT 产品树 →
 * resolveToolsRequire 解析 @deepseek-ai/dsh 包），区别是这里只返回「可作 createRequire
 * base 的目录」，取不到就返回 null，且任何一环失败都只跳过本锚点、不外抛。
 * ASAR 内路径不能直接当 createRequire 的 base（普通 node 读不到 app.asar 内部），
 * 因此取包含 package.json 的那一级目录，该级不存在时本锚点作废。 */
async function installAnchorDir() {
  try {
    if (await isDshProductTree(DSH_ROOT)) return DSH_ROOT;
  } catch { /* 跳过本环 */ }
  try {
    const req = resolveToolsRequire();
    if (req) {
      const dir = dirname(req.resolve('@deepseek-ai/dsh/package.json'));
      if (await pathExists(join(dir, 'package.json'))) return dir;
    }
  } catch { /* 跳过本环 */ }
  return null;
}

/** W48：bundle 解析锚点，次序对齐官方 packages/boot/app-boot/src/profile.ts：
 * dsh 安装目录 > profile 目录 > ~/.dsh。安装锚点放首位（合集第 190 行，已向社区确认，
 * 不得改序）；后两个锚点的构造方式与 v0.4.8 一致。 */
async function bundleAnchors(cfg, profileDir) {
  const anchors = [];
  const install = await installAnchorDir();
  if (install) {
    try { anchors.push(createRequire(join(install, 'package.json'))); } catch { /* 安装目录无 package.json 也可 */ }
  }
  try { anchors.push(createRequire(join(profileDir ?? rootDir(cfg, 'profile'), 'package.json'))); } catch { /* profile 无 package.json 也可 */ }
  try { anchors.push(createRequire(join(DSH_HOME, 'package.json'))); } catch { /* DSH_HOME 无 package.json 也可 */ }
  return anchors;
}
// profileDir 缺省 = 当前 profile；体检要逐个 profile 判定（v0.4.8）。
async function bundleCheck(cfg, name, profileDir) {
  const pdir = profileDir ?? rootDir(cfg, 'profile');
  // W48：桌面形态下宿主托管的官方核心 bundle 解析不到时不算异常，理由串与真缺失分开。
  const hostManaged = isDesktopProfile(cfg, pdir) && isHostManagedBundle(name);
  for (const r of await bundleAnchors(cfg, pdir)) {
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
  return hostManaged
    ? { ok: false, hostManaged: true, reason: `host-managed bundle (${name})` }
    : { ok: false, reason: `cannot resolve ${name}` };
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
    // 宿主托管的件不参与中和（W48）：它们不是本插件装的，摘掉也换不回启动能力，
    // 反而会改坏桌面 profile 的 bundles 清单。
    if (r.ok || r.hostManaged) kept.push(name);
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
  // W48：桌面 profile 拒动。桌面上的逃生舱是官方恢复弹窗的第三按钮，不是本插件的
  // safe mode；拒动落在任何写盘之前（早于下面的快照与备份），保证桌面 profile 目录
  // 不被本插件触碰。只挡 on：在 CLI 上对桌面 profile 手动开过的状态仍要能用 off 关掉。
  if (on && isDesktopProfile(cfg)) {
    return { ok: false, reason: 'desktop-profile', error: t('safe.err.desktop') };
  }
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
  // 6. 悬空 `insert:` 键（W48 挂接 W46 的检出能力）：宿主 sanitize 补丁后常留只带键行、
  //    键下没有内容的条目，这类键会把后续同级条目并进自己的树里，是启动期疑难杂症的来源。
  //    只读检测，命中给 warn 并标可清理，实际摘除走 runDoctorFix。
  for (const [rootName, label] of [['profile', 'profile patch'], ['home', 'home patch']]) {
    const p = filePath(cfg, { root: rootName, rel: 'cordis.patch.yml' });
    try {
      if (!(await pathExists(p))) continue;
      const hits = findDanglingInserts(await fs.readFile(p, 'utf8'));
      if (hits.length === 0) continue;
      add('warn', 'dangling-insert', `dangling insert key (${label})`,
        `${hits.length} dangling insert key(s) at line(s) ${hits.map((h) => h.line).join(', ')} (${p})`,
        'dsh-undo.ps1 doctor -Fix removes them', { fixable: true });
    } catch { /* 读不到就不报，交给上面的 patch 检查项 */ }
  }
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
 * 判断缩进树里的一行是不是 loader 条目（#47）。
 * 只有零缩进的顶层条目，以及顶层 `- insert:` 的直接子条目算。缩进更深的 `- id:` 属于
 * 某条目的 config 内部（如 llm-pi-ai 的 providers.*.models），删它等于删用户配置。
 */
function isLoaderRow(lines, row, byIdx) {
  if (!row) return false;
  if (row.parent === -1) return true;
  const parent = byIdx.get(row.parent);
  if (!parent || parent.indent !== 0) return false;
  return isInsertKeyLine(lines[parent.idx]);
}

/**
 * 解析 YAML patch 文本里的 list item，给出每个 item 的行区间、id 值与它是否位于
 * insert 之下。只认 `- key:` 形式的 loader 条目，够覆盖 cordis.patch.yml 的实际结构。
 */
function scanLoaderItems(text) {
  const lines = text.split('\n');
  const seq = seqLines(text);
  const byIdx = new Map(seq.map((r) => [r.idx, r]));
  const items = [];
  for (const row of seq) {
    const i = row.idx;
    const m = /^(\s*)-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!isLoaderRow(lines, row, byIdx)) continue;
    const col = row.indent;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      if (indentOf(l) <= col) break;
      end = j;
    }
    const parentKey = row.parent === -1 ? null : 'insert';
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

  // W43-2：桌面端运行中指引。桌面端在运行时会持有 profile 与补丁文件，此时改动可能被宿主
  // 覆盖，所以要在确凿探测到运行中时给出「先完全退出再重试」的指引。探测失败（unknown）与
  // 确定未运行都不产出检查项：前者是环境限制，后者无需提示，两者都不该变成噪声。
  if (dirs.some((d) => isDesktopProfile(cfg, d)) && (await desktopProcessState(inOpts)) === 'running') {
    add('warn', 'pre-desktop-running', 'desktop app running', t('doctor.desktopRunning'),
      'quit DeepSeek Harness completely, then retry');
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
        if (r.ok) continue;
        // W48：桌面形态下宿主托管的官方核心 bundle 报 ok 档并说明来源，不进硬失败；
        // 名字不在核心名单里的照旧报 err，真缺失不会被这一档吞掉。
        if (r.hostManaged) {
          add('ok', 'pre-bundle-host', `bundle ${b}`, t('doctor.hostManaged', { name: b }), 'no action needed');
          continue;
        }
        add('err', 'pre-bundle', `bundle ${b}`, `${r.reason}, DSH aborts before loading any plugin`, 'run dsh-undo.ps1 safe-mode -Label on, then restart DSH');
      }
    }
    const reload = prof?.patchReload;
    if (reload !== undefined && reload !== 'live' && reload !== 'startup') {
      add('err', 'pre-patchreload', `profile ${name} patchReload`, `${JSON.stringify(reload)} is invalid, must be "live" or "startup"`, 'set that field back to "live"');
    }
    // W43-4：官方 sanitize 痕迹。桌面端启动失败时，官方恢复弹窗的第三项会把本插件移出
    // bundles 并把补丁文件改名留档，界面上没有恢复入口，用户看到的现象是「插件无声消失」。
    // 三要素齐全才报，标 fixable 交由 runDoctorFix 定点恢复；文案写明这不是自动回退用户
    // 的那次选择，要不要装回来由用户定。
    const sanitize4 = await sanitizeTrace(dir, pkg);
    if (sanitize4) {
      add('warn', 'pre-sanitize-trace', `profile ${name} bundle entry`,
        t('doctor.sanitizeTrace', { backup: sanitize4.backup }),
        t('doctor.sanitizeTraceFix', { backup: sanitize4.backup }), { fixable: true });
    }
    // W50：部分 sanitize（第二检出面）。bundles 已恢复、补丁内容却缺条目时，上面三要素都不
    // 成立，靠条目名级差集兜住。与上一条互不排斥：真机按各自条件独立判定。
    const partialW50 = await partialSanitizeTrace(dir);
    if (partialW50) {
      const names = [...partialW50.missingInserts, ...partialW50.missingKeys].join(', ');
      if (partialW50.level === 'warn') {
        add('warn', 'pre-partial-sanitize', `profile ${name} patch content`,
          t('doctor.partialSanitize', { backup: partialW50.backup, names }),
          t('doctor.partialSanitizeFix'), { fixable: true });
      } else {
        add('info', 'pre-partial-sanitize', `profile ${name} patch content`,
          t('doctor.partialSanitize', { backup: partialW50.backup, names }),
          t('doctor.partialSanitizeInfo'));
      }
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
  // W43-4：官方 sanitize 痕迹的恢复。按三要素检出后，把插件写回清单的
  // dsh.profile.bundles，并用最新的官方备份覆盖当前补丁文件。这一步排在补丁内容修复之前，
  // 恢复出来的内容随后照常过 BOM 与重复 loader id 的检查；当前补丁文件若还没有
  // .dsh-undo-bak 备份就先留一份，不覆盖更早的原件。
  // 恢复不等于自动撤销用户的那次选择（弹窗第三项本就是用户点出来的），报告里按
  // 「已按检出结果恢复」记，用户不想要时仍可用修前快照撤回去。
  for (const dir of await profileDirs(cfg)) {
    let pkg = null;
    try { pkg = JSON.parse((await fs.readFile(join(dir, 'package.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch { continue; }
    const trace = await sanitizeTrace(dir, pkg);
    if (!trace) continue;
    const patch = join(dir, 'cordis.patch.yml');
    try {
      if ((await pathExists(patch)) && !(await pathExists(`${patch}.dsh-undo-bak`))) await fs.copyFile(patch, `${patch}.dsh-undo-bak`);
      await fs.copyFile(join(dir, trace.backup), patch);
      const prof = pkg.dsh?.profile ?? {};
      const bundles = Array.isArray(prof.bundles) ? prof.bundles : [];
      pkg.dsh = { ...(pkg.dsh ?? {}), profile: { ...prof, bundles: [...bundles, PLUGIN_NAME] } };
      await fs.writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      rec('pre-sanitize-trace', dir, `restored ${trace.backup} over cordis.patch.yml and put ${PLUGIN_NAME} back into dsh.profile.bundles (the previous patch was copied to cordis.patch.yml.dsh-undo-bak when no such backup existed)`, true);
    } catch (e) { rec('pre-sanitize-trace', patch, `restore ${trace.backup}`, false, e); }
  }
  // W50：部分 sanitize 的条目级搬回。只把备份里有、当前没有的条目追加回当前补丁的对应尾部，
  // 当前已有条目（含桌面端在官方 sanitize 之后新写的那些）一律不动，绝不整文件覆盖。
  // 恢复不等于自动撤销用户的那次选择，用户仍可用修前快照或 .dsh-undo-bak 回退。
  for (const dir of await profileDirs(cfg)) {
    try {
      const partial = await partialSanitizeTrace(dir);
      if (!partial) continue;
      const patch = join(dir, 'cordis.patch.yml');
      let cur = '';
      try { cur = await fs.readFile(patch, 'utf8'); } catch { /* 当前补丁缺失：整份内容按缺失处理 */ }
      const merged = mergePatchEntries(cur, await fs.readFile(join(dir, partial.backup), 'utf8'));
      if (merged.moved === 0) continue;
      if (cur !== '') {
        const bak = `${patch}.dsh-undo-bak`;
        if (!(await pathExists(bak))) await fs.copyFile(patch, bak);
      }
      await fs.writeFile(patch, merged.text, 'utf8');
      rec('pre-partial-sanitize', patch, `moved ${merged.moved} missing entr${merged.moved === 1 ? 'y' : 'ies'} back from ${partial.backup} (entry-level merge, later writes kept; the previous patch was copied to cordis.patch.yml.dsh-undo-bak when no such backup existed and a patch file was there)`, true);
    } catch (e) { rec('pre-partial-sanitize', join(dir, 'cordis.patch.yml'), 'merge the missing patch entries back', false, e); }
  }
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
      const fixLines = text.split('\n');
      const fixSeq = seqLines(text);
      const fixByIdx = new Map(fixSeq.map((r) => [r.idx, r]));
      let dropped = 0;
      let skipped = 0;
      for (const d of dups) for (const it of d.drop) {
        // #47 守卫：删除前再确认这一行确实是 loader 条目。宁可少修，不可误删。
        if (!isLoaderRow(fixLines, fixByIdx.get(it.start), fixByIdx)) { skipped += 1; continue; }
        for (let i = it.start; i <= it.end; i++) { kill.add(i); dropped++; }
      }
      if (!stripped && kill.size === 0) continue;
      const next = kill.size > 0 ? fixLines.filter((_, i) => !kill.has(i)).join('\n') : text;
      await fs.copyFile(p, `${p}.dsh-undo-bak`);
      await fs.writeFile(p, next, 'utf8');
      const what = [
        stripped ? 'stripped the UTF-8 BOM' : null,
        kill.size > 0 ? `dropped ${dropped} duplicate loader line(s) from ${dups.length} duplicated id(s), the last entry of each id is kept` : null,
        skipped > 0 ? `skipped ${skipped} entry(ies) that are not loader entries` : null,
      ].filter(Boolean).join('; ');
      rec('pre-loader-id', p, `${what} (backup: cordis.patch.yml.dsh-undo-bak)`, true);
    } catch (e) { rec('pre-loader-id', p, 'repair the patch file', false, e); }
  }
  // W48：悬空 `insert:` 键清理（W46 的检出能力落在这里）。与上一步同样先留备份，
  // 但上一步可能已经写过同名备份，这里只在备份不存在时补一份，不覆盖更早的原件；
  // 判定与清理都在条目粒度上，注释行不动。
  for (const p of [filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' }), filePath(cfg, { root: 'home', rel: 'cordis.patch.yml' })]) {
    try {
      if (!(await pathExists(p))) continue;
      const hits = findDanglingInserts(await fs.readFile(p, 'utf8'));
      if (hits.length === 0) continue;
      const bak = `${p}.dsh-undo-bak`;
      if (!(await pathExists(bak))) await fs.copyFile(p, bak);
      const n = await cleanDanglingInserts(p);
      rec('dangling-insert', p, `removed ${n} dangling insert key(s) at line(s) ${hits.map((h) => h.line).join(', ')} (backup: cordis.patch.yml.dsh-undo-bak)`, true);
    } catch (e) { rec('dangling-insert', p, 'remove the dangling insert keys', false, e); }
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
// 代际桶按 DSH 命名代独立计数（v1 不存在于 DSH 命名序列）。v4 为 0.2.0 的
// SESSION_FORMAT_VERSION，此前被 gen >= 3 并进 v3 桶，代际分布在用户侧不可辨（勘误 E64）。
// gen > 4 的未代并入 v4 桶，并由 higherGenerations 标注，为将来的 v5 留出不改结构的余量。
// 浅层不读文件内容，启动期安全；深层供升级报告与 doctor 使用，启动体检不调用。
// Node 无 zstd API 时深层保持 null。
async function sessionCensus(cfg, opts = {}) {
  const deep = opts.deep === true;
  const root = join(cfg.homeDir ?? DSH_HOME, 'sessions');
  const paths = await walkSessionFiles(cfg);
  const byGeneration = { v0: 0, v2: 0, v3: 0, v4: 0 };
  let higherGenerations = 0;
  const anomalous = [];
  let bytes = 0;
  for (const p of paths) {
    const gen = parseSessionLogZstdName(basename(p))?.generation ?? -1;
    if (gen === 0) byGeneration.v0++;
    else if (gen === 2) byGeneration.v2++;
    else if (gen === 3) byGeneration.v3++;
    else if (gen >= 4) { byGeneration.v4++; if (gen > 4) higherGenerations++; }
    let size = 0;
    try { size = (await fs.stat(p)).size; } catch { /* 文件消失即忽略 */ }
    bytes += size;
    if (size === 0) anomalous.push({ path: p, reason: 'zero-byte session log' });
  }
  const out = { root, total: paths.length, byGeneration, higherGenerations, bytes, anomalous, deep: null };
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
// W43 决策点 3：本函数保持原样不动。两条取版本的路径失败都收敛成 null，调用方按「读不到版本」
// 跳过升级护航，绝不外抛；桌面端把产品树装进 app.asar（普通 node 解析不到归档内部）时也只是
// 护航静默，不会连带拖垮体检与启动。ASAR 内取版本的做法推迟到 W45 的人工桌面验收一并核实，
// 此处不预先加分支。
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
  // W43：桌面端运行中探测（doctor 环境预检用）。冒烟测试直接导入本模块调用它钉住三态结果。
  desktopProcessState,
  // W43：子进程探测的超时上界（core.mjs 的快捷方式调用也从这里取）。
  SHORTCUT_TOOL_TIMEOUT,
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
  // W48：由 core.mjs 下沉到本模块的纯文本工具。core.mjs 从本模块导入后按原样
  // re-export，对外 API 面（undo 工具的 findDanglingInserts / cleanDanglingInserts）不变。
  splitItems,
  isDanglingInsertItem,
  findDanglingInserts,
  cleanDanglingInserts,
  // W50：部分 sanitize 的检出与条目级搬回。纯文本助手一并导出，离线脚本与冒烟测试可直接钉。
  partialSanitizeTrace,
  collectPatchEntryIds,
  mergePatchEntries,
};
