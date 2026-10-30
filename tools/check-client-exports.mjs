#!/usr/bin/env node
// W79（issue #52）：客户端导出面发布门禁。
//
// 背景：lib/client.js 是 loader 产物，smoke 只做文本断言，抓不住「factory 提前 return 导致
// 导出面变成 0 项」这一整类事故。那种情况下 WebUI 的撤销按钮、快照面板、设置页会一起消失，
// 而所有文本断言仍然全绿。
//
// 做法：按 loader 契约（window.__ModuleLoader__.load(cfg) → cfg.factory(require)）在内存里
// 执行一次真实文件，取导出键集合与冻结清单精确比对；再跑两条内存注入的负向自测，证明本门禁
// 对「提前 return」与「导出改名」都会真的变红。
//
// 只读：不写仓库、不起服务、不联网。执行时间 < 1 秒。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url));
// 冻结清单：改动导出面必须同步改这里，否则门禁红。顺序无关，比对前排序。
const EXPECT = [
  'UndoHeader',
  'SnapshotPanel',
  'KeyBindRow',
  'UndoMainPage',
  'UndoSettingsSection',
  'UndoBundleConfig',
  'apply',
  'inject',
].sort();

/** loader 与浏览器侧的最小桩：只提供 factory 执行期真正会碰到的成员。 */
function makeDocument() {
  return {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild() {} },
    body: {},
  };
}

/** factory 拿到的 require：三个注入模块给最小实现，其余一律抛错（loader 也不会给）。 */
function makeRequire() {
  const react = {
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useMemo: (f) => (typeof f === 'function' ? f() : f),
    useCallback: (f) => f,
    useRef: (v) => ({ current: v }),
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: { $$typeof: 'gate.fragment' },
  };
  react.default = react;
  const jsx = (type, props) => ({ type, props });
  return (id) => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: react.Fragment };
    if (id === 'react-dom') return { createPortal: (node) => node };
    throw new Error('client export gate has no stub for module: ' + id);
  };
}

/** 执行一次源码，返回 { keys } 或 { error }。任何异常都按红处理，不吞栈。 */
function loadExports(src) {
  let cfg = null;
  const windowStub = { __ModuleLoader__: { load: (c) => { cfg = c; } } };
  const documentStub = makeDocument();
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'document', src);
    fn(windowStub, documentStub);
    if (!cfg || typeof cfg.factory !== 'function') return { error: 'loader did not receive a factory' };
    const exported = cfg.factory(makeRequire());
    if (!exported || typeof exported !== 'object') return { error: 'factory did not return an exports object' };
    return { keys: Object.keys(exported).sort() };
  } catch (e) {
    return { error: 'execution failed: ' + String((e && e.stack) || e) };
  }
}

const same = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

/** 单点替换：锚点缺失或多处命中都返回 null（不猜，直接红）。 */
function replaceOnce(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0) return null;
  if (text.indexOf(from, at + 1) >= 0) return null;
  return text.slice(0, at) + to + text.slice(at + from.length);
}

let failed = 0;
const fail = (msg) => { failed++; console.error('GATE_FAIL ' + msg); };
const ok = (msg) => { console.log('  ok  ' + msg); };

const src = await readFile(CLIENT, 'utf8');

// 1) 真实文件：键集合精确等于冻结清单。
const real = loadExports(src);
if (real.error) {
  fail(real.error);
} else {
  console.log('CLIENT_EXPORTS=' + real.keys.join(','));
  console.log('CLIENT_EXPORT_COUNT=' + real.keys.length);
  if (!same(real.keys, EXPECT)) {
    const extra = real.keys.filter((k) => !EXPECT.includes(k));
    const missing = EXPECT.filter((k) => !real.keys.includes(k));
    fail('export key set drifted (missing: ' + (missing.join(',') || 'none') + '; unexpected: ' + (extra.join(',') || 'none') + ')');
  } else {
    ok('export key set matches the frozen list of ' + EXPECT.length);
  }
}

// 2) 负向自测一：factory 提前 return module.exports ⇒ 导出面必须不足 8 项。
const early = replaceOnce(src, 'var module = { exports: {} };', 'var module = { exports: {} };\r\n\t\treturn module.exports;   // gate self-test: early return');
if (early === null) {
  fail('negative control 1: anchor "var module = { exports: {} };" is missing or not unique');
} else {
  const r = loadExports(early);
  if (r.error) fail('negative control 1 should yield a short export list, got error: ' + r.error);
  else if (same(r.keys, EXPECT) || r.keys.length >= EXPECT.length) fail('negative control 1 escaped the gate: early return still exported ' + r.keys.length + ' keys');
  else ok('negative control 1 caught an early return (exports ' + r.keys.length + ' < ' + EXPECT.length + ')');
}

// 3) 负向自测二：把 apply 改名 ⇒ 键集合比对必须红（防「数量相同、名字被换」蒙混过关）。
const renamed = replaceOnce(src, 'exports.apply = apply;', 'exports.applyRenamed = apply;');
if (renamed === null) {
  fail('negative control 2: anchor "exports.apply = apply;" is missing or not unique');
} else {
  const r = loadExports(renamed);
  if (r.error) fail('negative control 2 should still load and expose 8 keys, got error: ' + r.error);
  else if (same(r.keys, EXPECT)) fail('negative control 2 escaped the gate: a renamed export still matched the frozen list');
  else if (r.keys.includes('apply') || !r.keys.includes('applyRenamed')) fail('negative control 2 did not observe the rename (keys: ' + r.keys.join(',') + ')');
  else if (r.keys.length !== EXPECT.length) fail('negative control 2 expected ' + EXPECT.length + ' keys after a rename, got ' + r.keys.length);
  else ok('negative control 2 caught a renamed export (same count, set differs)');
}

if (failed > 0) {
  console.error('GATE_FAILED ' + failed + ' check(s)');
  process.exit(1);
}
console.log('GATE_OK');
