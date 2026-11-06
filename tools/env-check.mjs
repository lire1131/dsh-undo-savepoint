// 用途：安装期环境自检库（W84）。纯函数，探测手段可注入，零依赖。
// 判据来自规划四 2.4：外部 node 缺失或主版本低于 20 为阻断；宿主 0.2.2 需要的
// 24.9 只是提示项；PowerShell 缺失与非 Windows 平台为提示；DSH home 不可写为阻断。
import { promises as fs, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OFFLINE_NODE_MIN = [20, 0];
export const HOST_NODE_MIN = [24, 9];

const VERSION_RE = /v?(\d+)\.(\d+)\.(\d+)/;

/** 把 `v22.23.4` 这类文本解析成 [major, minor, patch]；解析不到返回 null。 */
export function parseNodeVersion(text) {
  const m = VERSION_RE.exec(String(text ?? ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 版本三元组比较：a 低于 b 返回 true。 */
export function belowVersion(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) > (b[i] ?? 0)) return false;
  }
  return false;
}

function defaultRunVersion(cmd) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout ?? '').trim());
      });
    } catch { resolve(null); }
  });
}

function defaultRunPowerShell(cmd) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, ['-NoProfile', '-Command', 'exit 0'], { timeout: 5000, windowsHide: true }, (err) => {
        resolve(!err);
      });
    } catch { resolve(false); }
  });
}

async function defaultProbeWritable(dir) {
  const probe = join(dir, `.dsh-undo-write-probe-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, '', { mode: fsConstants.W_OK });
    await fs.unlink(probe).catch(() => { /* 删除失败不影响可写结论 */ });
    return true;
  } catch { return false; }
}

const MESSAGES = {
  zh: {
    header: '[dsh-undo-savepoint] 安装前环境自检',
    blocking: '阻断项',
    advisory: '提示项',
    none: '未发现阻断项。',
    continue: '继续安装。',
    skip: '已设置 DSH_UNDO_SKIP_ENV_CHECK，跳过环境自检。',
    nodeMissing: { title: '外部 Node.js 缺失（PATH 中找不到 node）', hint: '可能后果：离线工具（局外 WebUI、dsh-undo.ps1）无法启动，DSH 内的快照与撤销不受影响。修复建议：安装 Node.js 20 或更新版本并加入 PATH，https://nodejs.org' },
    nodeOld: { title: '外部 Node.js 版本过低（{version}，需要 20 或更新）', hint: '可能后果：离线工具无法运行。修复建议：升级 Node.js。' },
    nodeHostOld: { title: '外部 Node.js 低于 DSH 0.2.2 要求的 24.9（{version}）', hint: '只影响 DSH 0.2.2 及以后宿主能否启动，与本插件的离线工具无关。' },
    pwshMissing: { title: '找不到 PowerShell（powershell.exe 或 pwsh）', hint: '只影响依赖 PowerShell 的离线工具链，DSH 内的快照与撤销不受影响。' },
    nonWin32: { title: '当前平台不是 Windows（{platform}）', hint: '桌面快捷方式相关功能不可用，其余功能不受影响。' },
    homeUnwritable: { title: 'DSH home 不可写（{dir}）', hint: '可能后果：快照与恢复不可用。修复建议：检查目录权限或换一个 DSH home。' },
  },
  en: {
    header: '[dsh-undo-savepoint] install-time environment check',
    blocking: 'blocking',
    advisory: 'advisory',
    none: 'No blocking issue found.',
    continue: 'Continuing with the install.',
    skip: 'DSH_UNDO_SKIP_ENV_CHECK is set; environment check skipped.',
    nodeMissing: { title: 'external Node.js not found on PATH', hint: 'Impact: the offline tools (out-of-host WebUI, dsh-undo.ps1) cannot start; snapshots and undo inside DSH are unaffected. Fix: install Node.js 20 or newer and add it to PATH, https://nodejs.org' },
    nodeOld: { title: 'external Node.js is too old ({version}, 20 or newer required)', hint: 'Impact: the offline tools cannot run. Fix: upgrade Node.js.' },
    nodeHostOld: { title: 'external Node.js is below the 24.9 required by DSH 0.2.2 ({version})', hint: 'This only affects whether the DSH 0.2.2+ host can start; the offline tools are unaffected.' },
    pwshMissing: { title: 'PowerShell not found (powershell.exe or pwsh)', hint: 'Only the PowerShell-dependent offline tooling is affected; snapshots and undo inside DSH keep working.' },
    nonWin32: { title: 'platform is not Windows ({platform})', hint: 'Desktop-shortcut features are unavailable; everything else keeps working.' },
    homeUnwritable: { title: 'DSH home is not writable ({dir})', hint: 'Impact: snapshots and restore are unavailable. Fix: check the directory permissions or use another DSH home.' },
  },
};

const CODE_TO_MESSAGE = {
  'node-missing': 'nodeMissing',
  'node-old': 'nodeOld',
  'node-host-old': 'nodeHostOld',
  'pwsh-missing': 'pwshMissing',
  'non-win32': 'nonWin32',
  'home-unwritable': 'homeUnwritable',
};

/** 语言选择：DSH_UNDO_LANG > DSH_LOCALE > LANG > 系统区域；都取不到时返回 null（中英并排）。 */
export function pickLang(env = process.env) {
  const raw = env.DSH_UNDO_LANG || env.DSH_LOCALE || env.LANG || '';
  const v = String(raw).toLowerCase();
  if (v.startsWith('zh')) return 'zh';
  if (v.startsWith('en')) return 'en';
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
    if (/^zh/i.test(loc)) return 'zh';
    if (/^en/i.test(loc)) return 'en';
  } catch { /* 区域不可用 */ }
  return null;
}

/**
 * 运行全部检测。可注入：
 *  - runVersion(cmd) → 版本文本或 null
 *  - runPowerShell(cmd) → boolean
 *  - probeWritable(dir) → boolean
 *  - nodeText / powershellOk / homeWritable：直接给结果（测试用）
 *  - platform、env、homeDir
 * 返回 { blocking, advisory, checks }，每项 { code, ...变量 }。
 */
export async function detectEnv(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? env.DSH_HOME ?? join(homedir(), '.dsh');
  const runVersion = opts.runVersion ?? defaultRunVersion;
  const runPowerShell = opts.runPowerShell ?? defaultRunPowerShell;
  const probeWritable = opts.probeWritable ?? defaultProbeWritable;
  const blocking = [];
  const advisory = [];
  const checks = {};

  const nodeText = Object.prototype.hasOwnProperty.call(opts, 'nodeText')
    ? opts.nodeText
    : await runVersion(opts.nodeCmd ?? 'node');
  const nodeVersion = parseNodeVersion(nodeText);
  checks.node = nodeText;
  checks.nodeVersion = nodeVersion;
  if (!nodeVersion) {
    blocking.push({ code: 'node-missing' });
  } else if (belowVersion(nodeVersion, OFFLINE_NODE_MIN)) {
    blocking.push({ code: 'node-old', version: nodeText });
  } else if (belowVersion(nodeVersion, HOST_NODE_MIN)) {
    advisory.push({ code: 'node-host-old', version: nodeText });
  }

  const psOk = Object.prototype.hasOwnProperty.call(opts, 'powershellOk')
    ? opts.powershellOk
    : ((await runPowerShell('powershell.exe')) || (await runPowerShell('pwsh')));
  checks.powershell = psOk;
  if (!psOk) advisory.push({ code: 'pwsh-missing' });

  checks.platform = platform;
  if (platform !== 'win32') advisory.push({ code: 'non-win32', platform });

  const homeOk = Object.prototype.hasOwnProperty.call(opts, 'homeWritable')
    ? opts.homeWritable
    : await probeWritable(homeDir);
  checks.homeWritable = homeOk;
  if (!homeOk) blocking.push({ code: 'home-unwritable', dir: homeDir });

  return { blocking, advisory, checks, homeDir, platform };
}

/** 把检测结果渲染成可打印文本；lang 为 null 时中英并排。 */
export function formatEnvReport(result, lang) {
  const langs = lang ? [lang] : ['zh', 'en'];
  const lines = [];
  for (const l of langs) {
    const m = MESSAGES[l];
    const render = (item) => {
      const key = CODE_TO_MESSAGE[item.code];
      const def = m[key];
      if (!def) return null;
      const sub = (s) => s.replace(/\{(\w+)\}/g, (_, k) => String(item[k] ?? ''));
      return { title: sub(def.title), hint: sub(def.hint) };
    };
    lines.push(m.header);
    if (result.blocking.length === 0) {
      lines.push(`  ${m.none}`);
    } else {
      lines.push(`  ${m.blocking}:`);
      for (const item of result.blocking) {
        const r = render(item);
        if (r) { lines.push(`    - ${r.title}`); lines.push(`      ${r.hint}`); }
      }
    }
    for (const item of result.advisory) {
      const r = render(item);
      if (r) { lines.push(`  ${m.advisory}: ${r.title}`); lines.push(`      ${r.hint}`); }
    }
    if (l !== langs[langs.length - 1]) lines.push('');
  }
  return lines.join('\n') + '\n';
}

export const SKIP_ENV = 'DSH_UNDO_SKIP_ENV_CHECK';
export { MESSAGES };
