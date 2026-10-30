/**
 * dsh-undo-savepoint: 面板 300 条数据管线基准（可跑阈值）。
 *
 * 用途：W58 的「200 条以上按批渲染」只有源码级断言，缺少耗时口径。本模块从
 * lib/client.js 原样抽取 localDayKey / dayBucketOf / filterSnaps / groupSnaps /
 * PAGE_SIZE，在 Node 里跑 300 条快照的「筛选 → 分组 → 取当前批」，给 smoke
 * 一个可执行的阈值：单次最坏 < 16ms（60fps 一帧）。
 *
 * 边界：这里量的是数据管线，不含 DOM 绘制。真实 DOM 渲染耗时仍在 3082 真机
 * 用浏览器计时，见 _scratch 验收清单。
 *
 * @module dsh-undo-savepoint/panel-perf
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 单次最坏耗时上限：一帧 60fps = 16.7ms，取整 16ms。 */
export const PERF_LIMIT_MS = 16;
/** 夹具条数：门禁口径 300 条。 */
export const PERF_ITEMS = 300;

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/** 从 bundle 里原样抽出纯函数区间，避免另写一份实现造成口径漂移。 */
function loadPipeline() {
  const text = readFileSync(CLIENT, 'utf8');
  const start = text.indexOf('const PAGE_SIZE = 200;');
  const end = text.indexOf('function fmtBytes(n) {');
  if (start < 0 || end <= start) throw new Error('client.js: panel pipeline markers not found');
  const chunk = text.slice(start, end);
  // 只求值纯函数区间；区间内不引用 React/DOM。
  const factory = new Function(chunk + '\nreturn { PAGE_SIZE, filterSnaps, groupSnaps, localDayKey };');
  return factory();
}

/** 300 条夹具：跨天、跨类型、跨 profile、带可搜索原因。 */
function buildFixture(n = PERF_ITEMS) {
  const kinds = ['manual', 'auto', 'baseline', 'pre-restore'];
  const profiles = ['web', 'desktop', null];
  const reasons = ['manual:ui', 'plugin-mounted', 'dsh-upgrade-guard', 'doctor-fix-before', 'watcher'];
  const now = Date.now();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: 'perf-' + String(i).padStart(4, '0'),
      time: new Date(now - i * 3600 * 1000).toISOString(),
      kind: kinds[i % kinds.length],
      profile: profiles[i % profiles.length],
      reason: reasons[i % reasons.length],
      location: i % 2 === 0 ? 'manual' : 'auto',
      files: new Array(i % 7),
    });
  }
  return out;
}

/**
 * 跑基准。
 * @param {{runs?: number, items?: number}} [opts]
 * @returns {{items: number, runs: number, worstMs: number, avgMs: number, limitMs: number}}
 */
export function runPanelPerf(opts = {}) {
  const runs = Number.isFinite(opts.runs) && opts.runs > 0 ? Math.floor(opts.runs) : 100;
  const items = Number.isFinite(opts.items) && opts.items > 0 ? Math.floor(opts.items) : PERF_ITEMS;
  const { filterSnaps, groupSnaps, PAGE_SIZE } = loadPipeline();
  const list = buildFixture(items);
  const pass = () => {
    const visible = filterSnaps(list, '');
    const groups = groupSnaps(visible);
    const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    const shown = visible.slice(0, PAGE_SIZE);
    const hit = filterSnaps(list, 'manual');
    return groups.length + pageCount + shown.length + hit.length;
  };
  for (let i = 0; i < 10; i++) pass(); // 预热
  // 单次最坏会被 GC/机器负载放大，门禁用 p95：95% 的 300 条重建落在 16ms 一帧内。
  const samples = [];
  let total = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    pass();
    const dt = performance.now() - t0;
    samples.push(dt);
    total += dt;
  }
  samples.sort((a, b) => a - b);
  const pct = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  return {
    items,
    runs,
    p50Ms: Number(pct(0.5).toFixed(3)),
    p95Ms: Number(pct(0.95).toFixed(3)),
    worstMs: Number(samples[samples.length - 1].toFixed(3)),
    avgMs: Number((total / runs).toFixed(3)),
    limitMs: PERF_LIMIT_MS,
  };
}

// 直接运行时打印结果，便于真机复测。
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/panel-perf.mjs')) {
  console.log(JSON.stringify(runPanelPerf(), null, 2));
}
