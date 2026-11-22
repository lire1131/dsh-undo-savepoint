// tools/check-contrast.mjs — W104 深色模式对比度门禁。
// 用途：拿 tools/host-theme-tokens.json 里的宿主 token 取值，算出插件实际用到的
// 文字色对底色的对比度，深浅两套都过 WCAG 阈值（正文 4.5:1，次要文字 3:1）。
// 零依赖，只用 Node 内置模块；smoke 也直接 import 这里的算术，避免两套算法漂移。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 正文与次要文字的阈值。 */
export const MIN_TEXT = 4.5;
export const MIN_SECONDARY = 3;

/** client.js 里状态文字用的混合比例（60% 状态色 + 40% 主文字色）。 */
export const INK_WEIGHT = 0.6;

const FIXTURE_PATH = fileURLToPath(new URL('./host-theme-tokens.json', import.meta.url));

/** 读宿主 token 固件。 */
export function loadFixture(path) {
  return JSON.parse(readFileSync(path || FIXTURE_PATH, 'utf8'));
}

function toRgb(hex) {
  const h = String(hex).replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (s.length !== 6) throw new Error('not a 6-digit hex colour: ' + hex);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}

function toHex(rgb) {
  return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** WCAG 相对亮度。 */
export function luminance(hex) {
  const v = toRgb(hex).map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/** 两色对比度，返回 1 到 21 之间的比值。 */
export function contrastRatio(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB 里按权重混合两色（与 CSS color-mix(in srgb, A w, B 1-w) 同语义）。 */
export function mixHex(a, b, weightA) {
  const A = toRgb(a);
  const B = toRgb(b);
  return toHex([0, 1, 2].map((i) => A[i] * weightA + B[i] * (1 - weightA)));
}

/** 取一个 token 的值，缺就抛错（固件与样式必须同步）。 */
function tokenValue(theme, name) {
  if (!Object.prototype.hasOwnProperty.call(theme, name)) {
    throw new Error('theme fixture has no value for ' + name);
  }
  return theme[name];
}

/**
 * 状态色当文字用时的混合结果。与 client.js 的
 * --u-ink-*: color-mix(in srgb, <state> 60%, --dsw-alias-label-primary) 一一对应。
 */
export function inkColor(theme, stateToken, options) {
  const weight = options && Number.isFinite(options.inkWeight) ? options.inkWeight : INK_WEIGHT;
  return mixHex(tokenValue(theme, stateToken), tokenValue(theme, '--dsw-alias-label-primary'), weight);
}

/** 要核对的配色对：text 可以是 token 名、ink 描述，或者 ({mix}) 形状。 */
const PAIRS = [
  { id: 'body/panel', text: '--dsw-alias-label-primary', bg: '--dsw-alias-bg-layer-1', min: MIN_TEXT, what: '正文' },
  { id: 'secondary/panel', text: '--dsw-alias-label-secondary', bg: '--dsw-alias-bg-layer-1', min: MIN_TEXT, what: '次正文' },
  { id: 'tertiary/panel', text: '--dsw-alias-label-tertiary', bg: '--dsw-alias-bg-layer-1', min: MIN_SECONDARY, what: '弱文字' },
  { id: 'ink-ok/panel', ink: '--dsw-alias-state-success-primary', bg: '--dsw-alias-bg-layer-1', min: MIN_TEXT, what: '成功色文字' },
  { id: 'ink-error/panel', ink: '--dsw-alias-state-error-primary', bg: '--dsw-alias-bg-layer-1', min: MIN_TEXT, what: '危险色文字' },
  { id: 'ink-warn/panel', ink: '--dsw-alias-state-warn-primary', bg: '--dsw-alias-bg-layer-1', min: MIN_TEXT, what: '警示色文字' },
  { id: 'ink-biz/panel', ink: '--dsw-alias-state-business-primary', bg: '--dsw-alias-bg-layer-1', min: MIN_TEXT, what: '业务色文字' },
  { id: 'tertiary/layer2', text: '--dsw-alias-label-tertiary', bg: '--dsw-alias-bg-layer-2', min: MIN_SECONDARY, what: '弱文字（二级底）' },
  { id: 'body/base', text: '--dsw-alias-label-primary', bg: '--dsw-alias-bg-base', min: MIN_TEXT, what: '正文（裸底）' },
  { id: 'ink-ok/base', ink: '--dsw-alias-state-success-primary', bg: '--dsw-alias-bg-base', min: MIN_TEXT, what: '新增行文字' },
  { id: 'ink-error/base', ink: '--dsw-alias-state-error-primary', bg: '--dsw-alias-bg-base', min: MIN_TEXT, what: '删除行文字' }
];

/**
 * 跑一遍宿主主题配色对。返回 results（逐对结论）、failures（不达标的）、minRatio（最低比值）。
 * options.inkWeight 只给负向对照用，用来验证「不混合就会红」。
 */
export function checkContrast(fixture, options) {
  const fx = fixture || loadFixture();
  const results = [];
  for (const themeName of ['light', 'dark']) {
    const theme = fx[themeName];
    if (!theme) throw new Error('fixture has no ' + themeName + ' theme');
    for (const pair of PAIRS) {
      const text = pair.ink
        ? inkColor(theme, pair.ink, options)
        : tokenValue(theme, pair.text);
      const bg = tokenValue(theme, pair.bg);
      const ratio = contrastRatio(text, bg);
      results.push({
        theme: themeName,
        id: pair.id,
        what: pair.what,
        text: pair.ink ? pair.ink.replace('--dsw-alias-', '') + '@' + Math.round(((options && options.inkWeight) || INK_WEIGHT) * 100) + '%' : pair.text.replace('--dsw-alias-', ''),
        bg: pair.bg.replace('--dsw-alias-', ''),
        hex: text,
        bgHex: bg,
        ratio,
        min: pair.min,
        ok: ratio >= pair.min
      });
    }
  }
  const failures = results.filter((r) => !r.ok);
  const minRatio = results.reduce((acc, r) => Math.min(acc, r.ratio), Infinity);
  return { results, failures, minRatio };
}

// ── 局外 WebUI：直接解析 tools/webui/styles.css 的两套变量块 ────────────────
const WEBUI_CSS_PATH = fileURLToPath(new URL('./webui/styles.css', import.meta.url));

/** 取一个 CSS 选择器块里的变量表（块内没有嵌套规则）。 */
function parseVarBlock(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  const out = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** WebUI 上真正当文字用的配色对。 */
const WEBUI_PAIRS = [
  { id: 'body/panel', text: '--label-primary', bg: '--bg-layer-1', min: MIN_TEXT, what: '正文' },
  { id: 'secondary/panel', text: '--label-secondary', bg: '--bg-layer-1', min: MIN_TEXT, what: '次正文' },
  { id: 'tertiary/panel', text: '--label-tertiary', bg: '--bg-layer-1', min: MIN_SECONDARY, what: '弱文字' },
  { id: 'secondary/layer2', text: '--label-secondary', bg: '--bg-layer-2', min: MIN_TEXT, what: '次正文（二级底）' },
  { id: 'tertiary/layer2', text: '--label-tertiary', bg: '--bg-layer-2', min: MIN_SECONDARY, what: '弱文字（二级底）' },
  { id: 'accent/panel', text: '--accent', bg: '--bg-layer-1', min: MIN_TEXT, what: '强调色文字' },
  { id: 'error/panel', text: '--state-error', bg: '--bg-layer-1', min: MIN_TEXT, what: '危险色文字' },
  { id: 'success/panel', text: '--state-success', bg: '--bg-layer-1', min: MIN_TEXT, what: '成功色文字' },
  { id: 'warn/panel', text: '--state-warn', bg: '--bg-layer-1', min: MIN_TEXT, what: '警示色文字' },
  { id: 'on-accent', text: '--bg-layer-1', bg: '--accent', min: MIN_TEXT, what: '主按钮反白' },
  { id: 'body/page', text: '--label-primary', bg: '--bg', min: MIN_TEXT, what: '正文（页面底）' },
  { id: 'tertiary/page', text: '--label-tertiary', bg: '--bg', min: MIN_SECONDARY, what: '弱文字（页面底）' }
];

/** 跑一遍局外 WebUI 的配色对。 */
export function checkWebUiContrast(cssPath) {
  const css = readFileSync(cssPath || WEBUI_CSS_PATH, 'utf8');
  const themes = {
    light: parseVarBlock(css, ':root {'),
    dark: parseVarBlock(css, '[data-theme="dark"] {')
  };
  const results = [];
  for (const themeName of ['light', 'dark']) {
    const theme = themes[themeName];
    if (!theme) throw new Error('styles.css has no ' + themeName + ' palette');
    // 深色块只覆盖改动过的变量，其余从 :root 级联下来
    const merged = themeName === 'dark' ? { ...themes.light, ...theme } : theme;
    for (const pair of WEBUI_PAIRS) {
      const text = merged[pair.text];
      const bg = merged[pair.bg];
      if (!text || !bg) throw new Error('styles.css missing ' + (text ? pair.bg : pair.text));
      const ratio = contrastRatio(text, bg);
      results.push({
        theme: 'webui-' + themeName,
        id: pair.id,
        what: pair.what,
        text: pair.text,
        bg: pair.bg,
        hex: text,
        bgHex: bg,
        ratio,
        min: pair.min,
        ok: ratio >= pair.min
      });
    }
  }
  const failures = results.filter((r) => !r.ok);
  const minRatio = results.reduce((acc, r) => Math.min(acc, r.ratio), Infinity);
  return { results, failures, minRatio };
}

/** 宿主插件配色加局外 WebUI 配色，一起算。 */
export function checkAll(options) {
  const host = checkContrast(loadFixture(), options);
  const webui = checkWebUiContrast();
  const results = host.results.concat(webui.results);
  const failures = host.failures.concat(webui.failures);
  const minRatio = results.reduce((acc, r) => Math.min(acc, r.ratio), Infinity);
  return { host, webui, results, failures, minRatio };
}

/** 命令行入口：打印一张表，有红就退出码 1。 */
function main() {
  const report = checkAll();
  for (const r of report.results) {
    console.log('  ' + (r.ok ? 'ok  ' : 'FAIL') + ' - ' + (r.theme + '/' + r.id).padEnd(30)
      + ' ' + r.hex + ' on ' + r.bgHex + '  ' + r.ratio.toFixed(2) + ':1 (>= ' + r.min + ')  ' + r.what);
  }
  console.log('check-contrast: ' + report.results.length + ' pairs (host ' + report.host.results.length
    + ', webui ' + report.webui.results.length + '), lowest ' + report.minRatio.toFixed(2) + ':1, failed ' + report.failures.length);
  if (report.failures.length > 0) {
    console.error('FAIL: ' + report.failures.map((f) => f.theme + '/' + f.id + ' ' + f.ratio.toFixed(2) + ':1').join(', '));
    process.exit(1);
  }
  console.log('check-contrast: OK');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
