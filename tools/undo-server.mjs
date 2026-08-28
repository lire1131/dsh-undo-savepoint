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
  t,
} from '../lib/core.mjs';

const WEBUI_DIR = fileURLToPath(new URL('./webui', import.meta.url));
const STATE_FILE = join(dirname(SETTINGS_FILE), 'undo-server.json');

// ── 参数解析 ──────────────────────────────────────────────────────────────
function parseArg(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    profile: get('--profile') ?? get('-p'),
    noOpen: argv.includes('--no-open'),
    lang: get('--lang'),
  };
}
const args = parseArg(process.argv.slice(2));
if (args.lang) process.env.DSH_UNDO_LANG = args.lang;

// ── 构建引擎 cfg（与局内同一构造器）与崩溃横幅 ──────────────────────────────
const cfg = buildConfig({ profileName: args.profile ?? undefined, bootAlert: null });

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
        return send(res, 200, { ok: true, canUndo, canRedo, total: list.length, bootAlert: cfg.bootAlert?.crashed === true, crashReason: cfg.bootAlert?.crashReason ?? null, lastGoodSnapshotId: cfg.bootAlert?.lastGoodId ?? lastGood?.id ?? null, safeModeActive: safe.active === true, safeModeEnteredAt: safe.enteredAt ?? null, profiles: [cfg.profileName] });
      }
      if (method === 'GET' && path === '/api/undo/list') {
        const snapshots = (await listSnapshots(cfg)).map((s) => { const { _dir, _store, ...rest } = s; return { ...rest, location: _store ?? 'auto' }; });
        return send(res, 200, { ok: true, snapshots });
      }
      if (method === 'GET' && path === '/api/undo/doctor') {
        return send(res, 200, { ok: true, ...await runDoctor(cfg) });
      }
      if (method === 'GET' && path === '/api/undo/diff') {
        const id = url.searchParams.get('id') ?? '';
        const list = await listSnapshots(cfg);
        const snap = id === 'latest' ? list[0] ?? null : findSnapshot(list, id);
        if (!snap) return send(res, 404, { ok: false, error: { code: 'not-found', message: `snapshot not found: ${id}` } });
        return send(res, 200, { ok: true, id: snap.id, diff: await diffSnapshotStructured(cfg, snap) });
      }
      if (method === 'GET' && path === '/api/undo/settings') {
        return send(res, 200, { ok: true, settings: publicSettings(cfg) });
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
        if (typeof body.createDesktopShortcut === 'boolean') {
          cfg.createDesktopShortcut = body.createDesktopShortcut;
          if (body.createDesktopShortcut) void ensureDesktopShortcut(cfg).catch(() => { /* 尽力而为 */ });
        }
        // 关键：写回完整 publicSettings，绝不丢其他键（保证局内/局外同步）
        await fs.mkdir(dirname(SETTINGS_FILE), { recursive: true });
        await fs.writeFile(SETTINGS_FILE, JSON.stringify(publicSettings(cfg), null, 2), 'utf8');
        await fs.mkdir(cfg.manualDir, { recursive: true });
        await fs.mkdir(cfg.autoDir, { recursive: true });
        const pruned = await pruneAuto(cfg, await listSnapshots(cfg));
        return send(res, 200, { ok: true, settings: publicSettings(cfg), pruned });
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
      if (method === 'POST' && path === '/api/undo/undo') { return send(res, 200, { ok: true, ...await restore(cfg, 'undo') }); }
      if (method === 'POST' && path === '/api/undo/redo') { return send(res, 200, { ok: true, ...await restore(cfg, 'redo') }); }
      if (method === 'POST' && path === '/api/undo/restore') {
        const body = await readJson(req);
        const r = await restore(cfg, 'id', body?.snapshot_id, { syncDeps: body?.sync_deps === true });
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
        return send(res, 200, { ok: true, ...await exportSnapshots(cfg) });
      }
      if (method === 'POST' && path === '/api/undo/import') {
        const body = await readJson(req);
        return send(res, 200, { ok: true, ...await importSnapshots(cfg, body?.path) });
      }
      if (method === 'POST' && path === '/api/undo/pick-dir') { return send(res, 200, { ok: true, ...await pickDirectory() }); }
      if (method === 'POST' && path === '/api/undo/pick-file') { return send(res, 200, { ok: true, ...await pickFile() }); }
      if (method === 'POST' && path === '/api/undo/safe-mode') {
        const body = await readJson(req);
        const on = body?.on === true;
        return send(res, 200, { ok: true, ...await safeModeSet(cfg, on) });
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
  console.log(`  Profile: ${cfg.profileName}`);
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
