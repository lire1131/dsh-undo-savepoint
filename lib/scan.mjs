/**
 * dsh-undo-savepoint: 本机 DSH 实例扫描（端口建议）。
 *
 * 用途：局外 WebUI / 局内面板的「扫描本机」按钮。只产出建议，不自动改 settings。
 *
 * 做法（零依赖，只用 child_process 调系统自带命令）：
 *   1. 进程表：Windows 用 PowerShell 的 Get-CimInstance Win32_Process；其余平台用 ps。
 *   2. 监听端口：Windows 用 netstat -ano；其余平台先试 lsof，再试 ss。
 *   3. 取「DSH 进程或命令行含 dsh」的 pid，与监听表相交，得到候选端口；
 *      命令行里带 --port 的也直接进候选。
 *   4. 逐个候选端口探测 GET /api/undo/status（1.2 秒超时），能答的就是本插件实例。
 *
 * 任何一步失败都只降级为空列表 + error 文案，不抛栈。整轮 8 秒硬超时。
 *
 * @module dsh-undo-savepoint/scan
 */
import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 1200;
const MAX_CANDIDATES = 24;

/** 进程名/命令行里能说明「这是 DSH」的判据。DeepSeek Harness 是桌面端映像名。 */
const DSH_RE = /deepseek|dsh/i;

/** execFile 的 Promise 包装：失败不抛，返回 {ok:false, out}。 */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, out: String(stdout ?? ''), err: String(stderr ?? err?.message ?? err) });
        resolve({ ok: true, out: String(stdout ?? '') });
      });
    } catch (error) {
      resolve({ ok: false, out: '', err: String(error?.message ?? error) });
    }
  });
}

/** PowerShell 的 ConvertTo-Json 可能是单个对象，也可能是数组；统一成数组。 */
function asList(j) {
  if (j === null || j === undefined) return [];
  return Array.isArray(j) ? j : [j];
}

/**
 * 解析 PowerShell 进程表 JSON。字段名大小写不敏感（ConvertTo-Json 保留原始名）。
 * @param {string} text
 * @returns {Array<{pid:number|null, name:string, cmdline:string}>}
 */
function parseProcessesPowerShell(text) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? '').replace(/^\uFEFF/, '').trim() || '[]');
  } catch {
    return [];
  }
  const out = [];
  for (const it of asList(raw)) {
    if (!it || typeof it !== 'object') continue;
    const pid = Number(it.ProcessId ?? it.processId ?? it.PID ?? it.pid);
    out.push({
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      name: String(it.Name ?? it.name ?? ''),
      cmdline: String(it.CommandLine ?? it.commandLine ?? ''),
    });
  }
  return out;
}

/**
 * 解析 Windows netstat -ano 的 LISTENING 行。
 * @param {string} text
 * @returns {Array<{pid:number, port:number, addr:string}>}
 */
function parseNetstatWindows(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!/^TCP\s/i.test(t) || !/LISTENING/i.test(t)) continue;
    const parts = t.split(/\s+/);
    // TCP <local> <foreign> LISTENING <pid>
    const local = parts[1] ?? '';
    const pid = Number(parts[parts.length - 1]);
    const m = /:(\d{1,5})$/.exec(local);
    if (!m || !Number.isInteger(pid)) continue;
    const port = Number(m[1]);
    if (port < 1 || port > 65535) continue;
    out.push({ pid, port, addr: local.replace(/:\d{1,5}$/, '') });
  }
  return out;
}

/**
 * 解析 `ps -eo pid=,args=`。
 * @param {string} text
 * @returns {Array<{pid:number|null, name:string, cmdline:string}>}
 */
function parsePsPosix(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    const m = /^(\d+)\s+(.*)$/.exec(t);
    if (!m) continue;
    const cmdline = m[2];
    const name = cmdline.split(/\s+/)[0] ?? '';
    out.push({ pid: Number(m[1]), name: name.split(/[\\/]/).pop() ?? name, cmdline });
  }
  return out;
}

/**
 * 解析 lsof -nP -iTCP -sTCP:LISTEN。
 * 行样例：node 1234 user 20u IPv4 0x… 0t0 TCP 127.0.0.1:3082 (LISTEN)
 * @param {string} text
 * @returns {Array<{pid:number, port:number, addr:string}>}
 */
function parseLsof(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/\(LISTEN\)/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[1]);
    const m = /:(\d{1,5})\s+\(LISTEN\)/.exec(line);
    if (!Number.isInteger(pid) || !m) continue;
    out.push({ pid, port: Number(m[1]), addr: '' });
  }
  return out;
}

/**
 * 解析 `ss -ltnp`。
 * 行样例：LISTEN 0 511 127.0.0.1:3082 0.0.0.0:* users:(("node",pid=1234,fd=20))
 * @param {string} text
 * @returns {Array<{pid:number, port:number, addr:string}>}
 */
function parseSs(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!/^LISTEN\s/i.test(t)) continue;
    const parts = t.split(/\s+/);
    const local = parts[3] ?? '';
    const pm = /pid=(\d+)/.exec(t);
    const lm = /:(\d{1,5})$/.exec(local);
    if (!pm || !lm) continue;
    out.push({ pid: Number(pm[1]), port: Number(lm[1]), addr: local.replace(/:\d{1,5}$/, '') });
  }
  return out;
}

/** 取命令行里的 --port / --home（与 instances.scanProcessArgs 同语义，这里内联避免循环依赖）。 */
function portFromCmdline(cmdline) {
  const m = /--port[= ](\d{2,5})/.exec(String(cmdline ?? ''));
  return m ? Number(m[1]) : null;
}

/** 单个端口探测：能答 /api/undo/status 且 JSON 可解析即视为本插件实例。 */
async function probePort(port, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/undo/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { reachable: true, hasApi: false, isApi: false, data: null };
    const data = await r.json().catch(() => null);
    const isApi = !!(data && data.ok === true);
    const hasApi = isApi && (data.profileName !== undefined || data.storeRoot !== undefined);
    return { reachable: true, hasApi, isApi, data };
  } catch {
    return { reachable: false, hasApi: false, isApi: false, data: null };
  }
}

/**
 * 扫描本机 DSH 实例。
 * @param {{platform?:string, timeoutMs?:number, probeTimeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, durationMs:number, scannedAt:string, suggestions:Array, error:string|null}>}
 */
async function scanLocalInstances(opts = {}) {
  const t0 = Date.now();
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const errors = [];

  // 1) 进程表
  let processes = [];
  if (platform === 'win32') {
    const psCmd = "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
      + "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'DeepSeek|dsh' -or $_.CommandLine -match 'dsh' } "
      + "| Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], timeoutMs);
    if (r.ok) processes = parseProcessesPowerShell(r.out);
    else if (r.out) processes = parseProcessesPowerShell(r.out);
    if (!r.ok) errors.push('powershell: ' + String(r.err ?? '').slice(0, 200));
  } else {
    const r = await run('ps', ['-eo', 'pid=,args='], timeoutMs);
    if (r.ok) processes = parsePsPosix(r.out);
    else errors.push('ps: ' + String(r.err ?? '').slice(0, 200));
  }

  // 2) 监听端口
  let listening = [];
  if (platform === 'win32') {
    const r = await run('netstat.exe', ['-ano'], timeoutMs);
    if (r.ok) listening = parseNetstatWindows(r.out);
    else errors.push('netstat: ' + String(r.err ?? '').slice(0, 200));
  } else {
    const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], timeoutMs);
    if (lsof.ok) listening = parseLsof(lsof.out);
    else {
      const ss = await run('ss', ['-ltnp'], timeoutMs);
      if (ss.ok) listening = parseSs(ss.out);
      else errors.push('lsof/ss unavailable');
    }
  }

  // 3) 候选：DSH 进程 + 其命令行端口 + 其监听端口
  const dshPids = new Set();
  const cmdPorts = new Set();
  const pidInfo = new Map();
  for (const p of processes) {
    if (!DSH_RE.test(p.name) && !DSH_RE.test(p.cmdline)) continue;
    // 局外 undo-server 自己也会答 status，但它不是 DSH 实例，排除掉避免「加入实例」加错。
    if (/undo-server\.mjs/i.test(p.cmdline)) continue;
    if (p.pid) { dshPids.add(p.pid); pidInfo.set(p.pid, p); }
    const cp = portFromCmdline(p.cmdline);
    if (cp) cmdPorts.add(cp);
  }
  const listenPorts = new Set(cmdPorts);
  for (const l of listening) if (dshPids.has(l.pid)) listenPorts.add(l.port);
  // 桌面端端口不在命令行里，但进程监听端口能覆盖；pidInfo 用监听行的 pid 补。
  const portToPid = new Map();
  for (const l of listening) if (dshPids.has(l.pid) && !portToPid.has(l.port)) portToPid.set(l.port, l.pid);

  const ports = [...listenPorts].filter((p) => p >= 1 && p <= 65535).slice(0, MAX_CANDIDATES).sort((a, b) => a - b);

  // 4) 并发探测
  const probes = await Promise.all(ports.map(async (port) => {
    const pr = await probePort(port, probeTimeoutMs);
    if (!pr.isApi) return null;
    const pid = portToPid.get(port) ?? null;
    const info = pid ? pidInfo.get(pid) : null;
    return {
      port,
      pid,
      name: info?.name ?? null,
      cmdline: info?.cmdline ? info.cmdline.slice(0, 240) : null,
      home: pr.data?.homeDir ?? null,
      hasApi: pr.hasApi,
      profileName: pr.data?.profileName ?? null,
      instanceName: pr.data?.instanceName ?? null,
      total: Number.isFinite(pr.data?.total) ? pr.data.total : null,
    };
  }));

  const suggestions = probes.filter(Boolean).sort((a, b) => a.port - b.port);
  return {
    ok: true,
    durationMs: Date.now() - t0,
    scannedAt: new Date().toISOString(),
    suggestions,
    error: errors.length > 0 ? errors.join('; ').slice(0, 400) : null,
  };
}

export {
  DEFAULT_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  DSH_RE,
  parseProcessesPowerShell,
  parseNetstatWindows,
  parsePsPosix,
  parseLsof,
  parseSs,
  portFromCmdline,
  probePort,
  scanLocalInstances,
};
