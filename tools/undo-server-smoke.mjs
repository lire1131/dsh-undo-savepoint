/**
 * dsh-undo-savepoint: 局外 undo-server 冒烟测试（离线，仅 127.0.0.1）。
 *
 * 用途：undo-server 此前零测试覆盖，issue #18（缺路由）/ #19（readState 在
 * ESM 里误用 require 被裸 catch 吞掉，单实例检测从未生效）/ PR #21（import
 * 有效性的启动即崩风险）都是用户先发现的。本测试把三类回归全部拦在 CI：
 *   1. 启动即崩类（语法/导入/顶层错误）：进程能起来 + /api/undo/status 200
 *   2. 路由缺失类：status/list 等核心端点真实可命中
 *   3. 单实例检测类：已有实例时二次启动必须复用退出（exit 0 + "已在运行"）
 * 附带陈旧 pid / 损坏状态文件两个兜底场景。
 *
 * 隔离：DSH_UNDO_SETTINGS / DSH_UNDO_ROOT 指向临时目录，不碰真实 home
 * （同 smoke-test 2026-08-18 隔离修复的教训）。
 *
 * 用法：node tools/undo-server-smoke.mjs（已加入 npm test）
 *
 * @module dsh-undo-savepoint/undo-server-smoke
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'tools', 'undo-server.mjs');

let pass = 0, fail = 0;
const check = (cond, label) => {
  if (cond) { pass++; console.log('  ok  -', label); }
  else { fail++; console.error('  FAIL -', label); }
};

// ── 隔离环境（与 smoke-test 同款 env 覆盖）────────────────────────────────
const sandbox = await mkdtemp(join(tmpdir(), 'undo-server-smoke-'));
const stateFile = join(sandbox, 'undo', 'undo-server.json');
const baseEnv = {
  ...process.env,
  DSH_UNDO_SETTINGS: join(sandbox, 'undo', 'settings.json'),
  DSH_UNDO_ROOT: join(sandbox, 'undo-snapshots'),
  DSH_UNDO_LANG: 'zh',
};

const children = []; // 全部子进程登记，finally 统一清场

/** 启动一个持续运行的服务器实例，等 stdout 出现"打开: URL"后返回 {child,url,output} */
function startServer() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, '--no-open'], { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    const onData = (d) => {
      output += d;
      const m = output.match(/打开: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m) { child.stdout.off('data', onData); resolve({ child, url: m[1], output }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { output += d; }); // console.warn 走 stderr（如状态文件损坏告警）
    child.once('exit', (code) => resolve({ child, url: null, output, exitCode: code }));
  });
}

/** 运行一个预期会自行退出的实例（如复用检测），收集退出码与输出 */
function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, '--no-open'], { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('exit', (code) => resolve({ code, output }));
    // 兜底：万一意外挂起（检测回归时 B 不退出），超时判失败而不是卡死 CI
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 15000).unref?.();
  });
}

const stop = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode) return resolve();
  child.once('exit', resolve);
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 3000).unref?.();
});

const fetchStatus = async (url, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(new URL('api/undo/status', url), { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { code: r.status, body: await r.json() };
    } catch { /* 未就绪，重试 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
};

try {
  // ── 场景 1：启动即崩类回归（#19/#21 的直接拦截点）────────────────────
  const A = await startServer();
  check(A.url !== null, 'undo-server 启动成功（无语法/导入/顶层错误）');
  const s = await fetchStatus(A.url);
  check(s !== null && s.code === 200, '/api/undo/status 返回 200');
  check(s?.body?.ok === true, 'status 响应结构 ok:true（路由与序列化正常）');

  const listR = await fetch(new URL('api/undo/list', A.url), { signal: AbortSignal.timeout(2000) });
  check(listR.ok && (await listR.json()).ok === true, 'GET /api/undo/list 可命中（核心端点无缺失）');

  // ── 场景 2：单实例复用（#19 的主回归点）───────────────────────────────
  const B = await runOnce();
  check(B.code === 0, `二次启动退出码 0（实际 ${B.code}）`);
  check(B.output.includes('已在运行'), '二次启动打印"已在运行"（单实例检测生效）');

  // ── 场景 3：陈旧 pid 兜底（A 被杀后状态文件指向死 pid）────────────────
  const stateBefore = JSON.parse(await readFile(stateFile, 'utf8'));
  await stop(A.child);
  const R = await startServer();
  check(R.url !== null, 'A 被杀后启动正常新起（陈旧 pid 不阻塞）');
  const stateAfter = JSON.parse(await readFile(stateFile, 'utf8'));
  check(stateAfter.pid !== stateBefore.pid, '状态文件更新为新 pid');

  // ── 场景 4：损坏状态文件降级（#19 修复的 catch 收窄行为）──────────────
  await stop(R.child);
  await writeFile(stateFile, 'garbage{{{', 'utf8');
  const D = await startServer();
  check(D.url !== null && D.output.includes('状态文件损坏'), '损坏状态文件：告警后正常新起（不再静默 null）');
  await stop(D.child);
} finally {
  await Promise.all(children.map(stop));
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail > 0 ? 1 : 0);
