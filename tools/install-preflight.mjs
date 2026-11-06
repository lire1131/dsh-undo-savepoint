#!/usr/bin/env node
// 用途：安装期环境自检入口（W85）。安装钩子、包装器与手动运行共用同一入口。
// 规则（规划四 2.4）：
//  - DSH_UNDO_SKIP_ENV_CHECK=1 直接跳过。
//  - 无阻断项：打印结论后退出 0，不打扰。
//  - 有阻断项且交互终端：询问，30 秒无输入按默认继续；选 n 退出 2。
//  - 有阻断项且非交互：打印结论后按默认继续，退出 0。
//  - --strict（包装器用）：有阻断项一律退出 2，不询问。
// 测试钩子 DSH_UNDO_ENVCHECK_FAKE 只接受 {"node","powershell","home"} 三个键。
import { createInterface } from 'node:readline';
import { detectEnv, formatEnvReport, pickLang, SKIP_ENV, parseNodeVersion } from './env-check.mjs';

const ASK_TIMEOUT_MS = 30000;
const STRICT = process.argv.includes('--strict');

function parseFake(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function optionsFromFake(fake) {
  if (!fake) return {};
  const out = {};
  if (fake.node !== undefined) {
    if (fake.node === 'missing') out.nodeText = null;
    else if (fake.node === 'old') out.nodeText = 'v18.20.0';
    else if (fake.node === 'host-old') out.nodeText = 'v22.23.4';
    else if (fake.node === 'ok') out.nodeText = 'v24.19.0';
    else out.nodeText = String(fake.node);
  }
  if (fake.powershell !== undefined) out.powershellOk = fake.powershell !== 'missing';
  if (fake.home !== undefined) out.homeWritable = fake.home !== 'unwritable';
  return out;
}

function writeBoth(text) {
  try { process.stderr.write(text); } catch { /* stderr 不可用 */ }
  try { process.stdout.write(text); } catch { /* stdout 不可用 */ }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rl.close(); } catch { /* 已关闭 */ }
      resolve(value);
    };
    const timer = setTimeout(() => {
      process.stdout.write('\n');
      done(true);
    }, ASK_TIMEOUT_MS);
    rl.on('SIGINT', () => done(true));
    rl.question(question, (line) => {
      const v = String(line).trim().toLowerCase();
      done(v !== 'n' && v !== 'no');
    });
  });
}

async function main() {
  if (process.env[SKIP_ENV] === '1') {
    writeBoth(pickLang(process.env) === 'zh'
      ? '已设置 DSH_UNDO_SKIP_ENV_CHECK，跳过环境自检。\n'
      : 'DSH_UNDO_SKIP_ENV_CHECK is set; environment check skipped.\n');
    return 0;
  }
  const fake = parseFake(process.env.DSH_UNDO_ENVCHECK_FAKE);
  const result = await detectEnv(optionsFromFake(fake));
  const lang = pickLang(process.env);
  const report = formatEnvReport(result, lang);
  writeBoth(report);
  if (result.blocking.length === 0) return 0;

  if (STRICT) { writeBoth(lang === 'zh' ? '存在阻断项，安装中止。\n' : 'Blocking issue found; install aborted.\n'); return 2; }
  if (!process.stdin.isTTY) {
    writeBoth(lang === 'zh' ? '非交互环境，按默认继续安装（退出码 0）。\n' : 'Non-interactive environment; continuing with the default (exit 0).\n');
    return 0;
  }
  const zh = lang !== 'en';
  const yes = await ask(zh ? '是否继续安装？[Y/n]（30 秒无输入按默认继续）' : 'Continue the install? [Y/n] (default after 30s) ');
  if (!yes) { writeBoth(zh ? '已选择中止安装（退出码 2）。\n' : 'Install aborted (exit 2).\n'); return 2; }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  writeBoth(`[dsh-undo-savepoint] environment check failed: ${String((e && e.message) || e)}\n`);
  process.exitCode = 0;
});

export { parseNodeVersion };
