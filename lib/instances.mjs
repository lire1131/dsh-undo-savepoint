/**
 * dsh-undo-savepoint: 多实例（端口 × home × profile）支持。
 *
 * 用途：局外 WebUI 与局内面板都要能「选实例（端口）→ 选 profile」查看快照。
 * 本模块把「实例列表」「端口归一化」「库根解析（home × profile）」「进程扫描」的纯逻辑
 * 收在一处，启动器、REST 路由与冒烟测试共用同一套判定，不必起服务。
 *
 * 实例来源：settings 里的 instances 数组，每项 { name, port?, home, profile?, url? }，
 * 另有 current 字段标记默认实例（字符串，指向 name），currentProfile 标记上次选中的 profile。
 *
 * 优先级（高到低，与规划二 13.4.2 的裁决一致）：
 *   --home  >  --instance  >  DSH_HOME 环境变量  >  settings.current  >  现有默认行为
 * --home 必须由调用方在动态 import lib/core.mjs 之前落到 process.env.DSH_HOME，
 * 因为 DSH_HOME 是 base.mjs 的加载期常量（与 tools/doctor.mjs 同一写法）。
 *
 * 端口只承担身份与存活探测；快照数据一律从 home 读，不做离线代理写。
 *
 * @module dsh-undo-savepoint/instances
 */
import { join, dirname, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

/** 实例名只允许文件名安全的字符，避免它被拼进路径或用于注入。 */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 端口合法区间；越界或非整数一律归 null（等于「只按 home 读，不探测」）。 */
const PORT_MIN = 1;
const PORT_MAX = 65535;

/**
 * 端口归一化。接受整数与纯数字字符串（老 settings 里常写成 "3082"），
 * 其余（小数、越界、空串、布尔）一律 null。返回 null 不报错，调用方按「不探测」处理。
 * @param {unknown} v
 * @returns {number|null}
 */
function normalizePort(v) {
  let n = v;
  if (typeof n === 'string' && /^\d{1,5}$/.test(n.trim())) n = Number(n.trim());
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n >= PORT_MIN && n <= PORT_MAX ? n : null;
}

/**
 * 归一化实例列表：丢掉形状不对的项、重名的只留第一条。
 * 不校验 home 是否存在（那是调用方的事，且要能给出人话报错）。
 * 输出形状固定为 { name, port, home, profile, url }，port/profile/url 可为 null，
 * 保证 JSON 往返恒等（settings 读回再归一化与首次归一化逐字一致）。
 */
function normalizeInstances(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    const home = typeof it.home === 'string' ? it.home.trim() : '';
    if (!NAME_RE.test(name) || home === '') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      port: normalizePort(it.port),
      home,
      profile: typeof it.profile === 'string' && it.profile.trim() !== '' ? it.profile.trim() : null,
      url: typeof it.url === 'string' && it.url.trim() !== '' ? it.url.trim() : null,
    });
  }
  return out;
}

/** 找出默认实例：current 指向谁就是谁；指向不存在时退回列表第一条。 */
function defaultInstanceName(raw, current) {
  const list = normalizeInstances(raw);
  if (list.length === 0) return null;
  const cur = typeof current === 'string' ? current.trim() : '';
  return list.some((x) => x.name === cur) ? cur : list[0].name;
}

/**
 * 裁决最终用哪个 home / profile。
 * 返回 { ok:true, home, profile, name, port, source } 或 { ok:false, error, known }。
 * source 取值 cli-home / cli-instance / env / settings / default，供界面显示来源。
 */
function resolveInstance(inOpts = {}) {
  const list = normalizeInstances(inOpts.instances);
  const homeArg = typeof inOpts.home === 'string' ? inOpts.home.trim() : '';
  const instanceArg = typeof inOpts.instance === 'string' ? inOpts.instance.trim() : '';
  const profileArg = typeof inOpts.profile === 'string' && inOpts.profile.trim() !== '' ? inOpts.profile.trim() : null;
  const envHome = typeof inOpts.envHome === 'string' && inOpts.envHome.trim() !== '' ? inOpts.envHome.trim() : '';

  if (homeArg !== '') return { ok: true, home: homeArg, profile: profileArg, name: null, port: null, source: 'cli-home' };

  if (instanceArg !== '') {
    const hit = list.find((x) => x.name === instanceArg);
    if (!hit) return { ok: false, error: 'instance not found: ' + instanceArg, known: list.map((x) => x.name) };
    return { ok: true, home: hit.home, profile: profileArg ?? hit.profile, name: hit.name, port: hit.port, source: 'cli-instance', url: hit.url };
  }

  if (envHome !== '') return { ok: true, home: envHome, profile: profileArg, name: null, port: null, source: 'env' };

  const curName = defaultInstanceName(list, inOpts.current);
  if (curName) {
    const hit = list.find((x) => x.name === curName);
    return { ok: true, home: hit.home, profile: profileArg ?? hit.profile, name: hit.name, port: hit.port, source: 'settings', url: hit.url };
  }

  return { ok: true, home: null, profile: profileArg, name: null, port: null, source: 'default' };
}

/** 探测用：把 dsh 进程命令行里的 --port 与 home 收出来，只在界面上做提示，不自动加入列表。 */
function scanProcessArgs(commandLine) {
  const line = String(commandLine ?? '');
  const port = /--port[= ](\d{2,5})/.exec(line);
  const home = /--home[= ]"?([^"\s]+)"?/.exec(line);
  return { port: port ? Number(port[1]) : null, home: home ? home[1] : null };
}

/** 从请求的 Host 头取端口（局内面板要知道自己装在哪个端口上）。 */
function portFromHost(host) {
  const s = String(host ?? '').trim();
  const m = /:(\d{1,5})$/.exec(s);
  return m ? normalizePort(Number(m[1])) : null;
}

/**
 * 实例 home 下的快照库根（平铺布局，历史口径）。
 * buildConfig 的 manualDir/autoDir 来自 settings 与 resolveStoreRoots（跟 DSH_HOME 走），
 * 单传 homeDir 不会搬动快照库；切实例必须显式重绑，否则「切了 home 却还在读旧库」。
 * @param {string} home
 * @returns {{manualDir: string, autoDir: string}|null}
 */
function storeRootsFor(home) {
  const h = String(home ?? '').trim();
  if (h === '') return null;
  return { manualDir: join(h, 'undo-snapshots', 'manual'), autoDir: join(h, 'undo-snapshots', 'auto') };
}

/**
 * 按 home × profile 解析库根，并给出作用域判定（flat / scoped / custom + shared 标志）。
 *
 * 规则（与 base.resolveStoreRoots 的历史语义对齐，但不受模块级 DSH_HOME 限制）：
 *   1. <home>/undo-snapshots/<profile>/{manual,auto} 已有内容 → scoped（按 profile 分片）
 *   2. 否则 <home>/undo-snapshots/{manual,auto} 有内容 → flat（跨 profile 共享）
 *   3. 都没有 → 用 scoped（新库默认分片），保证新装机器不会又把两个 profile 混进平铺库
 *
 * @param {string} home
 * @param {string} profile
 * @returns {{manualDir:string, autoDir:string, scope:'flat'|'scoped', shared:boolean, inheritedFrom:string|null, exists:boolean}}
 */
function storeRootsProfileFor(home, profile) {
  const h = String(home ?? '').trim();
  const p = String(profile ?? '').trim() || 'web';
  const base = join(h, 'undo-snapshots');
  const scoped = { manualDir: join(base, p, 'manual'), autoDir: join(base, p, 'auto') };
  const flat = { manualDir: join(base, 'manual'), autoDir: join(base, 'auto') };
  const has = (d) => existsSync(join(d, 'manual')) || existsSync(join(d, 'auto'));
  if (has(join(base, p))) return { ...scoped, scope: 'scoped', shared: false, inheritedFrom: null, exists: true };
  if (has(base)) return { ...flat, scope: 'flat', shared: true, inheritedFrom: 'flat', exists: true };
  return { ...scoped, scope: 'scoped', shared: false, inheritedFrom: null, exists: false };
}

/**
 * 判定任意 home 下的库根作用域（describeStore 的 home 参数版）。
 * legacyRoot 用于环境变量 DSH_UNDO_ROOT 重定位的场景：那个根仍是「平铺」的历史根，
 * 与 home 下的平铺根等价，都算 flat/shared。
 * @param {string} home
 * @param {string} profileName
 * @param {string} manualDir
 * @param {string} autoDir
 * @param {string} [legacyRoot]
 * @returns {{root:string, scope:'flat'|'scoped'|'custom', shared:boolean}}
 */
function describeStoreAt(home, profileName, manualDir, autoDir, legacyRoot) {
  const norm = (p) => {
    const s = resolve(String(p ?? ''));
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const h = String(home ?? '').trim();
  const manual = norm(manualDir);
  const auto = norm(autoDir);
  const isFlatAt = (base) => norm(join(base, 'manual')) === manual && norm(join(base, 'auto')) === auto;
  if (h === '') return { root: dirname(resolve(String(manualDir ?? ''))), scope: 'custom', shared: false };
  const base = join(h, 'undo-snapshots');
  const flat = isFlatAt(base) || (typeof legacyRoot === 'string' && legacyRoot.trim() !== '' && isFlatAt(legacyRoot.trim()));
  const scoped = norm(join(base, profileName, 'manual')) === manual
    && norm(join(base, profileName, 'auto')) === auto;
  const scope = flat ? 'flat' : scoped ? 'scoped' : 'custom';
  return { root: dirname(resolve(String(manualDir ?? ''))), scope, shared: scope === 'flat' };
}

/**
 * 列出某 home 下存在的 profile 目录名。profiles/ 不存在时回落 web/desktop，
 * 保证新机器与只有一份 profile 的机器都能在界面上选到两个维度。
 * @param {string} home
 * @returns {string[]}
 */
/** profiles/ 下不属于 profile 的目录名：DSH 会把共享 node_modules 放在 profiles/node_modules。 */
const NON_PROFILE_DIRS = new Set(['node_modules', '.bin', '.cache', '.pnpm']);
/** 一个目录看起来像 profile 的标记文件（DSH 初始化时至少写一个）。 */
const PROFILE_MARKERS = ['package.json', 'cordis.yml', 'cordis.patch.yml'];

function looksLikeProfileDir(base) {
  return PROFILE_MARKERS.some((f) => existsSync(join(base, f)));
}

/**
 * 列出某 home 下真正像 profile 的目录名。
 *
 * 真实机器上 `profiles/` 里还有 `node_modules`（共享依赖），它不是 profile；
 * 早期实现把目录名照单全收，界面上会冒出一个叫 `node_modules` 的 profile，并把流程条挤爆。
 * 规则：常见名 web / desktop 直接认（首次初始化可能还没写标记文件）；
 * 其余目录必须带 package.json / cordis*.yml 之一；node_modules 等固定排除。
 * profiles/ 不存在或过滤后为空时回落 web/desktop。
 * @param {string} home
 * @returns {string[]}
 */
function listProfilesFor(home) {
  const h = String(home ?? '').trim();
  const fallback = ['web', 'desktop'];
  if (h === '') return fallback;
  try {
    const dir = join(h, 'profiles');
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => NAME_RE.test(n) && !n.startsWith('.') && !NON_PROFILE_DIRS.has(n.toLowerCase()))
      .filter((n) => n === 'web' || n === 'desktop' || looksLikeProfileDir(join(dir, n)));
    if (names.length === 0) return fallback;
    const rank = (n) => (n === 'web' ? 0 : n === 'desktop' ? 1 : 2);
    return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  } catch {
    return fallback;
  }
}

/**
 * 这个目录是不是「按默认布局算出来的」库根（平铺或任一 profile 的 scoped）。
 * 用途：settings 里的 manualDir/autoDir 是 publicSettings 每次都写的固定值，
 * 若把它当成用户显式覆盖，切 profile 时就会被上一份 profile 的默认值钉死。
 * 只有「不是默认布局」的目录才视为用户真正自定义的路径。
 * @param {string} home
 * @param {string} dir
 * @returns {boolean}
 */
function isImplicitStoreDir(home, dir) {
  const d = typeof dir === 'string' ? dir.trim() : '';
  if (d === '') return true;
  const h = String(home ?? '').trim();
  if (h === '') return false;
  const norm = (p) => {
    const s = resolve(String(p ?? ''));
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const base = join(h, 'undo-snapshots');
  const target = norm(d);
  if (target === norm(join(base, 'manual')) || target === norm(join(base, 'auto'))) return true;
  for (const p of listProfilesFor(h)) {
    if (target === norm(join(base, p, 'manual')) || target === norm(join(base, p, 'auto'))) return true;
  }
  return false;
}

/**
 * 判定一条快照是否属于请求的 profile。
 *
 * 返回 true/false/null 三态：
 *   - null = 归属未知（manifest 没有 profile，或是 0.5.0 之前没有 schemaVersion 的旧清单，
 *     那时 profile 字段可能被默认写成 web，不可信）。UI 必须把 null 的行当「归属未知」显示，
 *     默认也显示，避免被过滤误藏。
 *   - scoped 库里的快照天然属于该 profile（目录本身就是归属证明），一律 true。
 *   - profile 为空表示不过滤，一律 true。
 * @param {object} snap
 * @param {string|null} profile
 * @param {'flat'|'scoped'|'custom'} scope
 * @returns {boolean|null}
 */
function snapshotProfileMatch(snap, profile, scope) {
  const want = typeof profile === 'string' ? profile.trim() : '';
  if (want === '') return true;
  if (scope === 'scoped') return true;
  const p = snap && typeof snap.profile === 'string' && snap.profile.trim() !== '' ? snap.profile.trim() : null;
  if (!p) return null;
  const trusted = Number.isFinite(snap.schemaVersion) && snap.schemaVersion >= 1;
  if (!trusted) return null;
  return p === want;
}

export {
  NAME_RE,
  PORT_MIN,
  PORT_MAX,
  normalizePort,
  normalizeInstances,
  defaultInstanceName,
  resolveInstance,
  scanProcessArgs,
  portFromHost,
  storeRootsFor,
  storeRootsProfileFor,
  describeStoreAt,
  listProfilesFor,
  isImplicitStoreDir,
  snapshotProfileMatch,
};
