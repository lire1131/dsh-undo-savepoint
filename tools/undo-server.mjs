/**
 * dsh-undo-savepoint: standalone offline undo server (V0.4.0, D1/D8).
 *
 * 用途：DSH 挂掉时，用它 + 浏览器一键回退配置/插件树/安全模式。
 * - 纯 Node ≥20，仅依赖 node:http/fs/path/child_process + 本插件 lib/core.mjs（零 npm 依赖）。
 * - 只监听 127.0.0.1 + 随机端口（防局域网暴露）；启动打印 URL 并自动开浏览器（--no-open 关闭）。
 * - 单实例：PID 文件 + 端口探测，重复启动自动提示已有实例的 URL 并退出。
 * - API 面与局内 REST 契约一一对应（status/list/diff/snapshot/undo/redo/restore/remove/
 *   prune/export/import/settings/safe-mode/boot-alert），复用 core.mjs 同一批函数，双端天然一致。
 * - 静态托管 tools/webui/（index.html/app.js/styles.css），不引 CDN、不打包。
 *
 * 用法：node tools/undo-server.mjs [--profile <name>] [--no-open] [--lang en|zh]
 *
 * @module dsh-undo-savepoint/undo-server
 */
import { createServer } from 'node:http';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import {
  NAME_RE, normalizeInstances, resolveInstance, scanProcessArgs, storeRootsFor, storeRootsProfileFor,
  describeStoreAt, listProfilesFor, isImplicitStoreDir, snapshotProfileMatch, normalizePort,
} from '../lib/instances.mjs';
import { scanLocalInstances } from '../lib/scan.mjs';

// ── 参数解析 ──────────────────────────────────────────────────────────────
function parseArg(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    profile: get('--profile') ?? get('-p'),
    instance: get('--instance'),
    home: get('--home'),
    noOpen: argv.includes('--no-open'),
    lang: get('--lang'),
  };
}
const args = parseArg(process.argv.slice(2));
if (args.lang) process.env.DSH_UNDO_LANG = args.lang;

// ── W61：多实例裁决必须在动态 import 之前完成 ────────────────────────────────
// DSH_HOME 是 lib/base.mjs 的加载期常量，import 之后再改环境变量读到的还是旧值。
// 所以这里先用纯 fs 把 settings 里的实例列表读出来（路径按 env 推断，与 core 同规则），
// 裁决完再把最终 home 落到 process.env.DSH_HOME，最后才 import core。
const bootHomeGuess = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const bootSettingsPath = process.env.DSH_UNDO_SETTINGS ?? join(bootHomeGuess, 'undo', 'settings.json');
async function readBootSettings() {
  try { return JSON.parse(await fs.readFile(bootSettingsPath, 'utf8')); } catch { return {}; }
}
const bootSettings = await readBootSettings();
const bootInstances = normalizeInstances(bootSettings.instances);
const bootResolved = resolveInstance({
  instances: bootInstances,
  current: bootSettings.current,
  instance: args.instance,
  home: args.home,
  profile: args.profile,
  envHome: process.env.DSH_HOME,
});
if (!bootResolved.ok) {
  const known = (bootResolved.known ?? []).join(', ');
  console.error(`✖ ${bootResolved.error}${known ? `（已配置的实例：${known}）` : '（settings 里没有配置 instances）'}`);
  process.exit(2);
}
if (bootResolved.home && !existsSync(bootResolved.home)) {
  console.error(`✖ 实例 home 目录不存在：${bootResolved.home}（检查 --home 或 settings 里的 instances[].home）`);
  process.exit(2);
}
if (bootResolved.home) process.env.DSH_HOME = bootResolved.home;
if (bootResolved.profile) process.env.DSH_PROFILE = bootResolved.profile;

const {
  buildConfig,
  SETTINGS_FILE,
  LEGACY_ROOT,
  listSnapshots,
  currentState,
  undoCandidates,
  sameState,
  lastGoodSnapshot,
  safeModeStatus,
  safeModeSet,
  publicSettings,
  findSnapshot,
  runDoctor,
  runDoctorFix,
  diffSnapshotStructured,
  restore,
  createSnapshot,
  removeSnapshot,
  setSnapshotMeta,
  pruneAuto,
  exportSnapshots,
  importSnapshots,
  pickDirectory,
  pickFile,
  readBootState,
  readCrashLogTail,
  classifyCrash,
  crashAdvice,
  listMessageOps,
  undoMessage,
  ensureDesktopShortcut,
  ensureGuardShortcut,
  t,
} = await import('../lib/core.mjs');
// W62：库根作用域判定与局内同一实现（base 已随 core import 加载，这里取缓存）。
const { describeStore, loadSettingsAt, applySettingsToCfg } = await import('../lib/base.mjs');

const WEBUI_DIR = fileURLToPath(new URL('./webui', import.meta.url));
const STATE_FILE = join(dirname(SETTINGS_FILE), 'undo-server.json');

// W61：实例列表与默认实例存在与其它设置同一个 settings 文件里（JSON），与 core 的
// 设置读写共用一份，避免出现两套配置源。
async function readServerSettings() {
  try { return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
async function writeServerSettings(obj) {
  await fs.mkdir(dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ── 构建引擎 cfg（与局内同一构造器）与崩溃横幅 ──────────────────────────────
/** 实例自己的 settings 文件；切到某实例后，所有可编辑设置都以这份文件为准。 */
const instanceSettingsPath = (home) => join(home, 'undo', 'settings.json');
function buildCfg(res, profileOverride) {
  const home = res?.home ?? null;
  const profile = String(profileOverride ?? res?.profile ?? '').trim() || null;
  const overrides = { profileName: profile ?? args.profile ?? undefined, homeDir: home ?? undefined, bootAlert: null };
  // W61：buildConfig 的 manualDir/autoDir 来自 settings 与 resolveStoreRoots，单传 homeDir 不会
  // 搬动快照库。切实例必须显式重绑，否则切了 home 还在读旧库，撤销会跨实例串味。
  const roots = storeRootsFor(home);
  if (roots) { overrides.manualDir = roots.manualDir; overrides.autoDir = roots.autoDir; }
  const built = buildConfig(overrides);
  // 第二轮：库根按 home × profile 解析；目标实例自己的 settings 才是可编辑设置的来源。
  if (home && roots) {
    built.settingsFile = instanceSettingsPath(home);
    const raw = loadSettingsAt(built.settingsFile);
    const targetProfile = built.profileName ?? 'web';
    const proots = storeRootsProfileFor(home, targetProfile);
    built.manualDir = proots.manualDir;
    built.autoDir = proots.autoDir;
    if (raw) applySettingsToCfg(built, raw);
    // settings 里的目录是固定值；只有真正自定义（非默认布局）的目录才保留。
    built.manualDir = raw && !isImplicitStoreDir(home, raw.manualDir) ? raw.manualDir : proots.manualDir;
    built.autoDir = raw && !isImplicitStoreDir(home, raw.autoDir) ? raw.autoDir : proots.autoDir;
    built.storeInheritedFrom = proots.inheritedFrom ?? null;
  }
  built.instanceName = res?.name ?? null;
  built.instanceSource = res?.source ?? null;
  built.instancePort = res?.port ?? null;
  return built;
}
const bootProfile = args.profile ?? bootResolved.profile ?? (typeof bootSettings.currentProfile === 'string' ? bootSettings.currentProfile : null);
let cfg = buildCfg(bootResolved, bootProfile);

const bootProfileResolved = bootProfile ?? null;
/** 快照目录里 manifest 的条数（只用于 profile 维度总量显示）。 */
async function countStoreSnapshots(roots) {
  let n = 0;
  for (const base of [roots?.manualDir, roots?.autoDir]) {
    if (!base) continue;
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      for (const e of entries) if (e.isDirectory() && existsSync(join(base, e.name, 'manifest.json'))) n += 1;
    } catch { /* 目录不存在 = 0 条 */ }
  }
  return n;
}
/** 某个 home × profile 的库根详情；liveCfg 传入时复用已算好的列表。 */
async function profileInfoFor(home, profile, liveCfg) {
  const roots = storeRootsProfileFor(home, profile);
  let manualDir = roots.manualDir;
  let autoDir = roots.autoDir;
  const raw = loadSettingsAt(instanceSettingsPath(home));
  if (raw && !isImplicitStoreDir(home, raw.manualDir)) manualDir = raw.manualDir;
  if (raw && !isImplicitStoreDir(home, raw.autoDir)) autoDir = raw.autoDir;
  const store = describeStoreAt(home, profile, manualDir, autoDir, LEGACY_ROOT);
  const total = liveCfg ? (await listSnapshots(liveCfg)).length : await countStoreSnapshots({ manualDir, autoDir });
  return {
    name: profile, manualDir, autoDir,
    storeRoot: store.root, storeScope: store.scope, sharedStore: store.shared,
    total, exists: roots.exists === true,
  };
}
/** 一个 home 下所有 profile 的库根详情。 */
async function profilesInfoFor(home) {
  const out = [];
  for (const name of listProfilesFor(home)) out.push(await profileInfoFor(home, name, name === cfg.profileName ? cfg : null));
  return out;
}
/** 同 home 切 profile 的 cfg 副本（只换库根与 profileDir）。 */
function cfgForProfile(target, profile) {
  const home = target.homeDir ?? null;
  const roots = storeRootsProfileFor(home, profile);
  const raw = loadSettingsAt(target.settingsFile);
  let manualDir = roots.manualDir;
  let autoDir = roots.autoDir;
  if (raw && !isImplicitStoreDir(home, raw.manualDir)) manualDir = raw.manualDir;
  if (raw && !isImplicitStoreDir(home, raw.autoDir)) autoDir = raw.autoDir;
  return { ...target, profileName: profile, profileDir: join(home, 'profiles', profile), manualDir, autoDir, storeInheritedFrom: roots.inheritedFrom ?? null };
}
/** 生效实例统一形状。 */
function effectivePayload(ownPort) {
  const home = cfg.homeDir ?? null;
  const store = describeStoreAt(home, cfg.profileName, cfg.manualDir, cfg.autoDir, LEGACY_ROOT);
  return {
    name: cfg.instanceName ?? null, port: cfg.instancePort ?? null,
    home, profile: cfg.profileName ?? null, profileSource: cfg.profileSource ?? null,
    source: cfg.instanceSource ?? null, storeRoot: store.root, storeScope: store.scope,
    settingsFile: cfg.settingsFile, mode: 'local', serverPort: ownPort ?? null,
  };
}
/** 探测实例端口：旧版插件（无 profileName/storeRoot）标 hasApi=false。 */
async function probeInstance(inst) {
  const out = {
    name: inst.name, port: inst.port ?? null, home: inst.home, profile: inst.profile ?? null, url: inst.url ?? null,
    reachable: false, hasApi: false, apiVersion: null, currentProfile: null,
    profiles: listProfilesFor(inst.home), total: null, storeRoot: null, settingsFile: null, instanceName: null, probedHome: null, homeMismatch: false, error: null,
  };
  if (out.port) {
    try {
      const r = await fetch(`http://127.0.0.1:${out.port}/api/undo/status`, { signal: AbortSignal.timeout(1200) });
      out.reachable = true;
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (data && data.ok === true) {
          out.hasApi = data.profileName !== undefined || data.storeRoot !== undefined;
          out.apiVersion = out.hasApi ? 2 : null;
          if (typeof data.profileName === 'string') out.currentProfile = data.profileName;
          if (typeof data.homeDir === 'string' && data.homeDir !== '') out.probedHome = data.homeDir;
          if (Number.isFinite(data.total)) out.total = data.total;
          if (typeof data.storeRoot === 'string') out.storeRoot = data.storeRoot;
          if (typeof data.settingsFile === 'string') out.settingsFile = data.settingsFile;
          if (typeof data.instanceName === 'string') out.instanceName = data.instanceName;
          out.profiles = listProfilesFor(out.home);
        }
      }
    } catch (error) {
      out.error = String(error?.message ?? error);
    }
  }
  // 配置里的 home 是用户写的意志，探测只补「端口实际指向哪」的旁证，绝不覆盖。
    out.homeMismatch = !!(out.probedHome && String(out.probedHome).toLowerCase().replace(/[\\/]+$/, '') !== String(out.home).toLowerCase().replace(/[\\/]+$/, ''));
    const settings = loadSettingsAt(instanceSettingsPath(out.home)) ?? {};
  if (!out.currentProfile) {
    out.currentProfile = typeof settings.currentProfile === 'string' ? settings.currentProfile
      : typeof settings.profileName === 'string' ? settings.profileName : (out.profile ?? 'web');
  }
  if (out.total === null) {
    const pi = await profileInfoFor(out.home, out.currentProfile, null);
    out.total = pi.total;
    out.storeRoot = out.storeRoot ?? pi.storeRoot;
  }
  if (!out.settingsFile) out.settingsFile = instanceSettingsPath(out.home);
  return out;
}
// W61：切换实例时若有进行中的长操作，排队等它们结束，不拒绝（用户拍板项）。
// 只包住会写盘或长时间跑的四类：撤销、恢复、导出、导入。
let inflightOps = 0;
const withOpLock = async (fn) => {
  inflightOps += 1;
  try { return await fn(); } finally { inflightOps -= 1; }
};
async function waitOpsIdle(timeoutMs = 30000) {
  const t0 = Date.now();
  while (inflightOps > 0 && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return inflightOps === 0;
}


async function computeBootAlert() {
  try {
    const prev = await readBootState(cfg);
    if (!prev || prev.ok !== false) { cfg.bootAlert = null; return; }
    let crashReason = prev.crashReason ?? null;
    if (!crashReason) {
      const log = await readCrashLogTail(cfg);
      if (log) crashReason = classifyCrash(log.text);
    }
    cfg.bootAlert = {
      crashed: true,
      lastGoodAt: prev.lastGoodAt ?? null,
      crashReason,
      lastGoodId: prev.lastGoodAt ? (await lastGoodSnapshot(cfg, await listSnapshots(cfg)))?.id ?? null : null,
    };
  } catch (e) { console.warn(`⚠️ 读取启动警报失败，跳过: ${e?.message ?? e}`); cfg.bootAlert = null; }
}

// ── 单实例（PID 文件 + 进程存活探测）───────────────────────────────────────
function isAlive(pid) {
  // process.kill(pid, 0) 的 catch 是"进程不存在"的标准判定，ESRCH 时返回 false
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
// 读单实例状态文件。注意：本文件是 ESM，禁止用 require()（会抛 ReferenceError
// 且曾被裸 catch 吞掉，导致单实例检测形同虚设，见 issue #19）。
// catch 只吞 JSON 解析失败（状态文件损坏 → 视为无状态并告警），其余异常照常抛出。
function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    console.warn(`⚠️ undo-server 状态文件损坏，忽略: ${STATE_FILE}`);
    return null;
  }
}
// 单实例检测：读状态文件 + pid 存活 + URL 存活探测三层兜底（issue #19）。
// pid 存活 ≠ 服务可用（pid 可能被系统复用导致 isAlive 误判），因此再对
// 局外独有端点 /api/undo/locale 做一次真实探测，双确认才复用退出。
async function isUndoServerAlive(base) {
  try {
    const r = await fetch(new URL('api/undo/locale', base), { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; } // 探测失败 = 服务不在（连接拒绝/超时/非本插件），视为陈旧状态
}

// ── 服务器 ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 65536) { req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      // 故意降级：无效 JSON 的请求体按空对象处理，与局内 readJson 行为一致（#19 教训：
      // 此处 catch 范围仅限 JSON.parse 一行，不吞其他异常）
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname.replace(/^\/+/, '') || 'index.html');
  if (rel.includes('..')) { res.writeHead(403); res.end('forbidden'); return; }
  const file = join(WEBUI_DIR, rel);
  if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 not found'); return; }
  const data = await fs.readFile(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
}

let timer = null;
function setShutdown() {
  if (timer) return;
  timer = setTimeout(() => { try { server.close(); } catch { /* noop */ } }, 3000);
  timer.unref?.();
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    // M2 加固：跨站 CSRF 防护——浏览器发起的跨源请求必带 Origin，与 Host 不符即拒。
    // 无 Origin 的请求（curl / 本机脚本）放行，保持离线工具可用性。
    const origin = req.headers?.origin;
    if (origin) {
      let ok = false;
      try {
        const o = new URL(origin);
        const host = String(req.headers?.host ?? '');
        ok = o.host === host && (o.protocol === 'http:' || o.protocol === 'https:');
      } catch { ok = false; }
      if (!ok) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'cross-origin request rejected' } }));
        return;
      }
    }
    if (path.startsWith('/api/')) {
      if (method === 'GET' && path === '/api/undo/status') {
        const list = await listSnapshots(cfg);
        const cur = await currentState(cfg);
        const candidates = await undoCandidates(cfg, list);
        const canUndo = candidates.some((c) => !sameState(cur, c.st));
        const pre = list.find((s) => s.kind === 'pre-restore' && !s.consumed);
        const canRedo = pre !== undefined && !list.some((s) => s.time > pre.time && (s.kind !== 'pre-restore' || !s.consumed));
        const lastGood = await lastGoodSnapshot(cfg, list);
        const safe = await safeModeStatus(cfg);
        const homeNow = cfg.homeDir ?? null;
        const store = describeStoreAt(homeNow, cfg.profileName, cfg.manualDir, cfg.autoDir, LEGACY_ROOT);
        const profilesInfo = await profilesInfoFor(homeNow);
        const profileDetail = profilesInfo.find((p) => p.name === cfg.profileName) ?? null;
        const ownPort = server.address()?.port ?? null;
        return send(res, 200, { ok: true, canUndo, canRedo, total: list.length, bootAlert: cfg.bootAlert?.crashed === true, crashReason: cfg.bootAlert?.crashReason ?? null, lastGoodSnapshotId: cfg.bootAlert?.lastGoodId ?? lastGood?.id ?? null, safeModeActive: safe.active === true, safeModeEnteredAt: safe.enteredAt ?? null, profiles: [cfg.profileName], profileName: cfg.profileName ?? null, profileSource: cfg.profileSource ?? null, storeRoot: store.root, storeScope: store.scope, sharedStore: store.shared, storeInheritedFrom: cfg.storeInheritedFrom ?? null, instanceName: cfg.instanceName ?? null, instanceSource: cfg.instanceSource ?? null, instancePort: cfg.instancePort ?? null, port: ownPort, homeDir: homeNow, settingsFile: cfg.settingsFile, instancesFile: SETTINGS_FILE, mode: 'local', profileDetail, profilesInfo });
      }
      if (method === 'GET' && path === '/api/undo/list') {
        // 第二轮：profile 只做归属标注与统计，不丢数据。
        const wantProfile = (url.searchParams.get('profile') ?? '').trim() || (cfg.profileName ?? '');
        const includeShared = url.searchParams.get('includeShared') === '1' || url.searchParams.get('includeShared') === 'true';
        const homeNow = cfg.homeDir ?? null;
        const store = describeStoreAt(homeNow, cfg.profileName, cfg.manualDir, cfg.autoDir, LEGACY_ROOT);
        const snapshots = (await listSnapshots(cfg)).map((s) => {
          const { _dir, _store, ...rest } = s;
          return {
            ...rest,
            location: _store ?? 'auto',
            profileMatch: snapshotProfileMatch(rest, wantProfile, store.scope),
          };
        });
        const countByProfile = { web: 0, desktop: 0, unknown: 0 };
        for (const s of snapshots) {
          const bucket = store.scope === 'scoped'
            ? (cfg.profileName ?? 'unknown')
            : (s.profileMatch === null ? 'unknown' : (typeof s.profile === 'string' ? s.profile : 'unknown'));
          if (bucket === 'web' || bucket === 'desktop') countByProfile[bucket] += 1;
          else countByProfile.unknown += 1;
        }
        return send(res, 200, {
          ok: true, snapshots, profile: wantProfile, includeShared,
          store: { root: store.root, scope: store.scope, shared: store.shared }, countByProfile,
        });
      }
      if (method === 'GET' && path === '/api/undo/doctor') {
        return send(res, 200, { ok: true, ...await runDoctor(cfg, { desktopShortcut: true }) });
      }
      if (method === 'POST' && path === '/api/undo/doctor/fix') {
        // 预检自愈（v0.4.8）：清单 BOM / patch 重复 loader id / 悬空 junction 等定点修复，
        // 修前先落一个手动快照；返回修复清单 + 复查报告（字段与 GET doctor 同形）。
        const r = await runDoctorFix(cfg, { desktopShortcut: true });
        return send(res, 200, { ok: true, snapshotId: r.snapshotId ?? null, applied: r.applied ?? [], fixed: r.fixed ?? 0, failed: r.failed ?? 0, before: r.before, ...r.report });
      }
      if (method === 'GET' && path === '/api/undo/diff') {
        const id = url.searchParams.get('id') ?? '';
        const list = await listSnapshots(cfg);
        const snap = id === 'latest' ? list[0] ?? null : findSnapshot(list, id);
        if (!snap) return send(res, 404, { ok: false, error: { code: 'not-found', message: `snapshot not found: ${id}` } });
        return send(res, 200, { ok: true, id: snap.id, diff: await diffSnapshotStructured(cfg, snap) });
      }
      if (method === 'GET' && path === '/api/undo/settings') {
        // 热重读：另一个入口（局内面板 / 插件页）改了同一个 settings 文件时，这里立刻跟上。
        const rawSettings = loadSettingsAt(cfg.settingsFile);
        if (rawSettings) applySettingsToCfg(cfg, rawSettings);
        return send(res, 200, { ok: true, settings: publicSettings(cfg), settingsFile: cfg.settingsFile, instancesFile: SETTINGS_FILE, instanceName: cfg.instanceName ?? null, instancePort: cfg.instancePort ?? null, profileName: cfg.profileName ?? null, homeDir: cfg.homeDir ?? null, reloaded: rawSettings !== null });
      }
      if (method === 'POST' && path === '/api/undo/settings') {
        const body = await readJson(req);
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        if (typeof body.autoEnabled === 'boolean') cfg.autoEnabled = body.autoEnabled;
        if (typeof body.autoCleanup === 'boolean') cfg.autoCleanup = body.autoCleanup;
        if (Number.isFinite(body.watchDebounceMs)) cfg.watchDebounceMs = clamp(Math.round(body.watchDebounceMs), 200, 60000);
        if (Number.isFinite(body.keepAuto)) cfg.keepAuto = clamp(Math.round(body.keepAuto), 1, 500);
        if (Number.isFinite(body.keepPre)) cfg.keepPre = clamp(Math.round(body.keepPre), 0, 500);
        const normDir = (v) => (typeof v === 'string' ? v.trim().replace(/[\\/]+$/, '') : '');
        if (normDir(body.manualDir) !== '') cfg.manualDir = normDir(body.manualDir);
        if (normDir(body.autoDir) !== '') cfg.autoDir = normDir(body.autoDir);
        // 与局内保持一致：完整可设置项（数组或逗号/分号分隔字符串）
        if (Array.isArray(body.pluginDirs)) cfg.pluginDirs = body.pluginDirs.map((s) => String(s).trim()).filter(Boolean);
        else if (typeof body.pluginDirs === 'string') cfg.pluginDirs = body.pluginDirs.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
        if (body.sensitiveMode === 'redact' || body.sensitiveMode === 'keep') cfg.sensitiveMode = body.sensitiveMode;
        // W73（#50）：对话头按钮档位（auto / full / compact），非法值不写入。
        if (body.headerMode === 'auto' || body.headerMode === 'full' || body.headerMode === 'compact') cfg.headerMode = body.headerMode;
        if (typeof body.createDesktopShortcut === 'boolean') {
          cfg.createDesktopShortcut = body.createDesktopShortcut;
          if (body.createDesktopShortcut) void ensureDesktopShortcut(cfg).catch(() => { /* 尽力而为 */ });
        }
        // v0.5.0：启动体检开关（局外设置面板的复选框同样要能落盘）
        if (typeof body.bootHealthEnabled === 'boolean') cfg.bootHealthEnabled = body.bootHealthEnabled;
        // v0.5.0 F3：DSH 升级护航开关（局外设置面板的复选框同样要能落盘）
        if (typeof body.upgradeGuardEnabled === 'boolean') cfg.upgradeGuardEnabled = body.upgradeGuardEnabled;
        // v0.5.0 F3：崩溃自愈阈值（0 = 关闭）
        if (Number.isFinite(body.autoSafeModeAfterFails)) cfg.autoSafeModeAfterFails = Math.max(0, Math.round(body.autoSafeModeAfterFails));
        // v0.5.0 W29：守卫处置档与守卫快捷方式开关（勾选即建，与桌面快捷方式同款）
        if (body.guardAutoSafeMode === 'ask' || body.guardAutoSafeMode === 'on' || body.guardAutoSafeMode === 'off') cfg.guardAutoSafeMode = body.guardAutoSafeMode;
        if (typeof body.guardShortcutEnabled === 'boolean') {
          cfg.guardShortcutEnabled = body.guardShortcutEnabled;
          if (body.guardShortcutEnabled) void ensureGuardShortcut(cfg).catch(() => { /* 尽力而为 */ });
        }
        // 关键：写回完整 publicSettings，绝不丢其他键（保证局内/局外同步）。
        // 写目标实例自己的 settings 文件；合并原文以保留 instances/current 等非设置键。
        await fs.mkdir(dirname(cfg.settingsFile), { recursive: true });
        await fs.writeFile(cfg.settingsFile, JSON.stringify({ ...(loadSettingsAt(cfg.settingsFile) ?? {}), ...publicSettings(cfg) }, null, 2), 'utf8');
        await fs.mkdir(cfg.manualDir, { recursive: true });
        await fs.mkdir(cfg.autoDir, { recursive: true });
        const pruned = await pruneAuto(cfg, await listSnapshots(cfg));
        return send(res, 200, { ok: true, settings: publicSettings(cfg), pruned, settingsFile: cfg.settingsFile, profileName: cfg.profileName ?? null });
      }
      if (method === 'GET' && path === '/api/undo/messages') {
        const msgs = (await listMessageOps(cfg)).map((m) => ({ id: m.id, messageId: m.messageId ?? null, files: m.files ?? 0, tools: m.tools ?? [], startedAt: m.startedAt ?? null, deleted: m.deleted ?? false }));
        return send(res, 200, { ok: true, messages: msgs });
      }
      if (method === 'POST' && path === '/api/undo/message') {
        const body = await readJson(req);
        const r = await undoMessage(cfg, body?.id ?? 'latest');
        return send(res, 200, { ok: r.ok, ...r });
      }
      if (method === 'POST' && path === '/api/undo/snapshot') {
        const body = await readJson(req);
        const reason = typeof body?.reason === 'string' && body.reason !== '' ? body.reason : 'manual';
        const snap = await createSnapshot(cfg, 'manual', reason);
        return send(res, 200, { ok: true, id: snap.id, files: snap.files.length, reason });
      }
      // W61：实例列表与切换。列表带出每个实例的 name/home/profile 与当前生效项；
      // 切换时若有进行中的撤销/恢复/导出/导入，等它们结束再换（排队不拒绝）。
      if (method === 'GET' && path === '/api/undo/instances') {
        const s = await readServerSettings();
        const list = normalizeInstances(s.instances);
        const instances = await Promise.all(list.map((inst) => probeInstance(inst)));
        const homeNow = cfg.homeDir ?? null;
        const ownPort = server.address()?.port ?? null;
        return send(res, 200, {
          ok: true, instances,
          current: typeof s.current === 'string' ? s.current : null,
          currentProfile: typeof s.currentProfile === 'string' ? s.currentProfile : (cfg.profileName ?? null),
          settingsFile: SETTINGS_FILE, homeDir: homeNow, port: ownPort,
          profiles: listProfilesFor(homeNow),
          effective: effectivePayload(ownPort),
        });
      }
      if (method === 'POST' && path === '/api/undo/scan') {
        // 扫描只产出建议，不自动写 settings；命令缺失/超时都返回空列表而不是抛栈。
        const known = normalizeInstances((await readServerSettings()).instances);
        let scanned;
        try { scanned = await scanLocalInstances(); } catch (error) { scanned = { ok: false, durationMs: 0, scannedAt: new Date().toISOString(), suggestions: [], error: String(error?.message ?? error) }; }
        return send(res, 200, { ok: true, ...scanned, known });
      }
      if (method === 'POST' && path === '/api/undo/instances') {
        const body = await readJson(req);
        // 实例列表的增删：只写 settings.instances/current，不动运行时实例。
        if (body && typeof body.upsert === 'object' && body.upsert !== null) {
          const up = body.upsert;
          const name = typeof up.name === 'string' ? up.name.trim() : '';
          const home = typeof up.home === 'string' ? up.home.trim() : '';
          const portRaw = up.port;
          const portGiven = !(portRaw === undefined || portRaw === null || portRaw === '');
          const port = portGiven ? normalizePort(portRaw) : null;
          if (!NAME_RE.test(name)) return send(res, 400, { ok: false, error: { code: 'bad-name', message: '实例名只允许字母、数字、点、下划线、短横线，长度 1-64' } });
          if (portGiven && port === null) return send(res, 400, { ok: false, error: { code: 'bad-port', message: '端口必须是 1-65535 的整数：' + String(portRaw) } });
          if (!home || !existsSync(home)) return send(res, 400, { ok: false, error: { code: 'bad-home', message: '实例 home 目录不存在：' + home } });
          const s0 = await readServerSettings();
          const list = normalizeInstances(s0.instances).filter((x) => x.name !== name);
          list.push({ name, port, home, profile: typeof up.profile === 'string' && up.profile.trim() !== '' ? up.profile.trim() : null, url: typeof up.url === 'string' && up.url.trim() !== '' ? up.url.trim() : null });
          await writeServerSettings({ ...s0, instances: list });
          return send(res, 200, { ok: true, instances: list, current: typeof s0.current === 'string' ? s0.current : null, currentProfile: typeof s0.currentProfile === 'string' ? s0.currentProfile : null, settingsFile: SETTINGS_FILE });
        }
        if (typeof body?.remove === 'string') {
          const name = body.remove.trim();
          const s0 = await readServerSettings();
          const list = normalizeInstances(s0.instances).filter((x) => x.name !== name);
          const current = s0.current === name ? null : (typeof s0.current === 'string' ? s0.current : null);
          await writeServerSettings({ ...s0, instances: list, current });
          return send(res, 200, { ok: true, instances: list, current, currentProfile: typeof s0.currentProfile === 'string' ? s0.currentProfile : null, settingsFile: SETTINGS_FILE });
        }
        if (body?.reset === true) {
          cfg = buildCfg(bootResolved, bootProfileResolved);
          return send(res, 200, { ok: true, switched: true, reset: true, effective: effectivePayload(server.address()?.port ?? null), home: cfg.homeDir ?? null, profile: cfg.profileName ?? null, storeRoot: dirname(cfg.manualDir), settingsFile: cfg.settingsFile });
        }
        const s = await readServerSettings();
        const list = normalizeInstances(s.instances);
        const sw = body && typeof body.switch === 'object' && body.switch !== null ? body.switch : body;
        const instanceName = typeof sw?.instance === 'string' ? sw.instance.trim() : '';
        const homeArg = typeof sw?.home === 'string' ? sw.home.trim() : '';
        // 只给 profile（顶栏 Profile 分段控件）时保持当前 home，不被 settings.current 带去别的实例。
        const stayCurrent = instanceName === '' && homeArg === '';
        const next = stayCurrent
          ? { ok: true, home: cfg.homeDir ?? null, name: cfg.instanceName ?? null, port: cfg.instancePort ?? null, source: cfg.instanceSource ?? 'host' }
          : resolveInstance({ instances: list, current: s.current, instance: instanceName || null, home: homeArg || null, profile: null, envHome: null });
        if (!next.ok) return send(res, 400, { ok: false, error: { code: 'bad-instance', message: next.error, known: next.known ?? [] } });
        const home = homeArg !== '' ? homeArg : next.home;
        if (!home || !existsSync(home)) return send(res, 400, { ok: false, error: { code: 'bad-home', message: '实例 home 目录不存在：' + (home ?? '') } });
        const hit = instanceName ? list.find((x) => x.name === instanceName) ?? null : null;
        const wantedProfile = typeof sw?.profile === 'string' && sw.profile.trim() !== ''
          ? sw.profile.trim()
          : (hit?.profile ?? (typeof s.currentProfile === 'string' && s.currentProfile.trim() !== '' ? s.currentProfile.trim() : (cfg.profileName ?? 'web')));
        if (!NAME_RE.test(wantedProfile)) return send(res, 400, { ok: false, error: { code: 'bad-profile', message: 'profile 名不合法：' + wantedProfile } });
        const idle = await waitOpsIdle();
        if (!idle) return send(res, 409, { ok: false, error: { code: 'busy', message: '有操作仍在进行，未切换实例；请等待当前操作结束后重试' } });
        cfg = buildCfg({ ...next, home, port: hit?.port ?? next.port ?? null }, wantedProfile);
        cfg.instanceName = next.name ?? hit?.name ?? null;
        cfg.instanceSource = next.source ?? null;
        cfg.instancePort = hit?.port ?? next.port ?? null;
        if (next.source === 'settings' || next.name) {
          await writeServerSettings({ ...s, current: hit?.name ?? next.name ?? s.current ?? null, currentProfile: wantedProfile });
        }
        return send(res, 200, { ok: true, switched: true, name: cfg.instanceName, source: cfg.instanceSource, effective: effectivePayload(server.address()?.port ?? null), home: cfg.homeDir ?? null, profile: cfg.profileName ?? null, storeRoot: dirname(cfg.manualDir), settingsFile: cfg.settingsFile, queued: false });
      }
      if (method === 'POST' && path === '/api/undo/undo') { return send(res, 200, { ok: true, ...await withOpLock(() => restore(cfg, 'undo')) }); }
      if (method === 'POST' && path === '/api/undo/redo') { return send(res, 200, { ok: true, ...await withOpLock(() => restore(cfg, 'redo')) }); }
      if (method === 'POST' && path === '/api/undo/restore') {
        const body = await readJson(req);
        const r = await withOpLock(() => restore(cfg, 'id', body?.snapshot_id, { syncDeps: body?.sync_deps === true }));
        return send(res, r.ok ? 200 : 400, { ok: r.ok, ...r });
      }
      if (method === 'POST' && path === '/api/undo/remove') {
        const body = await readJson(req);
        return send(res, 200, { ok: true, ...await removeSnapshot(cfg, body?.id) });
      }
      if (method === 'POST' && path === '/api/undo/note') {
        const body = await readJson(req);
        const r = await setSnapshotMeta(cfg, body?.id ?? '', body ?? {});
        return send(res, r.ok ? 200 : 404, { ok: r.ok, ...r });
      }
      if (method === 'POST' && path === '/api/undo/prune') {
        const list = await listSnapshots(cfg);
        return send(res, 200, { ok: true, pruned: await pruneAuto(cfg, list) });
      }
      if (method === 'POST' && path === '/api/undo/export') {
        const body = await readJson(req);
        // M3 修复：把 WebUI 收集的密码透传给导出（否则加密开关是摆设）。
        return send(res, 200, { ok: true, ...await withOpLock(() => exportSnapshots(cfg, body?.password ?? '')) });
      }
      if (method === 'POST' && path === '/api/undo/import') {
        const body = await readJson(req);
        return send(res, 200, { ok: true, ...await withOpLock(() => importSnapshots(cfg, body?.path, body?.password ?? '')) });
      }
      if (method === 'POST' && path === '/api/undo/pick-dir') { return send(res, 200, { ok: true, ...await pickDirectory() }); }
      if (method === 'POST' && path === '/api/undo/pick-file') { return send(res, 200, { ok: true, ...await pickFile() }); }
      if (method === 'POST' && path === '/api/undo/safe-mode') {
        const body = await readJson(req);
        const action = typeof body?.action === 'string' ? body.action : (body?.on === true ? 'on' : body?.on === false ? 'off' : 'status');
        const targetProfile = typeof body?.profile === 'string' && body.profile.trim() !== '' ? body.profile.trim() : (cfg.profileName ?? 'web');
        const targetCfg = targetProfile === cfg.profileName ? cfg : cfgForProfile(cfg, targetProfile);
        const targetIsDesktop = basename(String(targetCfg.profileDir ?? '')).trim().toLowerCase() === 'desktop';
        if (action === 'on' || action === 'off') {
          // 桌面 profile 默认拒动（W48）；显式 confirmDesktop 才允许离线写文件（先快照再改）。
          if (action === 'on' && targetIsDesktop && body?.confirmDesktop !== true) {
            return send(res, 200, { ok: false, reason: 'desktop-profile', needConfirm: true, profile: targetProfile, error: t('safe.err.desktop') });
          }
          const r = await safeModeSet(targetCfg, action === 'on', { allowDesktop: body?.confirmDesktop === true });
          return send(res, 200, { ok: r.ok, ...r, profile: targetProfile, confirmedDesktop: targetIsDesktop && body?.confirmDesktop === true });
        }
        const st = await safeModeStatus(targetCfg);
        return send(res, 200, { ok: true, active: st.active === true, enteredAt: st.enteredAt ?? null, profile: targetProfile });
      }
      if (method === 'GET' && path === '/api/undo/locale') {
        return send(res, 200, { ok: true, lang: process.env.DSH_UNDO_LANG ?? 'auto' });
      }
      return send(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${path}` } });
    }
    // 静态资源
    await serveStatic(req, res, url);
  } catch (error) {
    send(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } });
  }
});

// ── 启动 ─────────────────────────────────────────────────────────────────
async function main() {
  await computeBootAlert();
  // 单实例检测（必须在 listen 之前）：三层兜底见 isUndoServerAlive 注释
  const existing = readState();
  if (existing && isAlive(existing.pid) && existing.url) {
    if (await isUndoServerAlive(existing.url)) {
      console.log(`ℹ️  undo-server 已在运行：${existing.url}`);
      process.exit(0);
    }
    console.warn(`⚠️ 状态文件指向 ${existing.url} 但无响应（pid ${existing.pid} 可能已被其他进程复用），忽略并重新启动`);
  }
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', (e) => { console.error('undo-server failed to bind:', e.message); process.exit(1); });
  });
  const addr = server.address();
  const port = addr.port;
  const base = `http://127.0.0.1:${port}/`;
  await fs.mkdir(dirname(STATE_FILE), { recursive: true });
  // 原子写：先写临时文件再 rename，避免进程中途被杀留下半个 JSON
  const stateTmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(stateTmp, JSON.stringify({ pid: process.pid, port, url: base, startedAt: new Date().toISOString() }, null, 2), 'utf8');
  await fs.rename(stateTmp, STATE_FILE);
  console.log(`\n  dsh-undo-savepoint 局外 WebUI`);
  console.log(`  Profile: ${cfg.profileName}  实例: ${cfg.instanceName ?? '本机'}  端口: ${cfg.instancePort ?? '—'}`);
  console.log(`  快照目录: ${LEGACY_ROOT}`);
  if (cfg.bootAlert?.crashed) {
    console.log(`  ⚠️ 上次 DSH 启动未完成（可能崩溃）。${cfg.bootAlert.lastGoodId ? `建议回退到快照 ${cfg.bootAlert.lastGoodId}。` : ''}${crashAdvice(cfg.bootAlert.crashReason ?? '')}`);
  }
  console.log(`\n  打开: ${base}   (关闭标签页即退出服务器)\n`);
  if (!args.noOpen) openBrowser(base);
}
function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => { /* ignore */ });
  else if (process.platform === 'darwin') execFile('open', [url], () => { /* ignore */ });
  else execFile('xdg-open', [url], () => { /* ignore */ });
}
await main();
