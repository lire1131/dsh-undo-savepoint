/**
 * dsh-undo-savepoint: 宿主 REST 面冒烟（实例切换 / 库根校验 / 连端口代理）。
 *
 * 背景：lib/index.js 的 webServer 路由长期只有源码级断言（smoke 的 W53/W62），
 * 实例切换与代理是原生命周期之外的写操作，必须真调一次路由才能证明：
 *   - GET /api/undo/instances 返回实例列表与 effective.storeRoot；
 *   - status 带 storeRoot/storeScope/sharedStore；
 *   - POST /api/undo/instances 切库后 manualDir/profile 真的换了；
 *   - reset 能切回启动默认；
 *   - 代理拒绝非回环、坏路径与不可达远端。
 *
 * 隔离：DSH_UNDO_SETTINGS / DSH_UNDO_ROOT 指向临时目录；ctx 是手工假宿主。
 *
 * 用法：node tools/host-api-smoke.mjs（已加入 npm test）
 *
 * @module dsh-undo-savepoint/host-api-smoke
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';

const root = await mkdtemp(join(tmpdir(), 'dsh-undo-host-api-'));
const homeA = join(root, 'homeA');
const homeB = join(root, 'homeB');
await mkdir(homeA, { recursive: true });
await mkdir(homeB, { recursive: true });
const settingsFile = join(root, 'undo', 'settings.json');
await mkdir(dirname(settingsFile), { recursive: true });
await writeFile(settingsFile, JSON.stringify({ consent: true, autoEnabled: false, keepAuto: 5, keepPre: 2 }, null, 2), 'utf8');
process.env.DSH_UNDO_SETTINGS = settingsFile;
process.env.DSH_UNDO_ROOT = join(root, 'undo-snapshots');
process.env.DSH_HOME = join(root, 'dsh-home');

const { apply } = await import('../lib/index.js');

let pass = 0, fail = 0;
const check = (cond, label) => { if (cond) { pass++; console.log('  ok  -', label); } else { fail++; console.error('  FAIL -', label); } };

// ── 假宿主 ─────────────────────────────────────────────────────────────────
const registered = [];
let route = null; // webServer.register 传进来的前缀处理器
const ctx = {
  tools: { register: (t) => { registered.push(t.name); return () => { }; } },
  systemPrompt: { section: () => () => { } },
  get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); },
  logger: { info: () => { }, warn: () => { }, debug: () => { } },
  webServer: { register: (r) => { route = r.handler; return () => { }; } },
};

/** 调一次宿主路由，返回 {status, body}。headers 可选（局内 status 的 port 取自 Host 头）。 */
function call(handler, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = body === undefined
      ? Object.assign(Readable.from([]), { method, url: path, headers })
      : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method, url: path, headers });
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code; },
      end(text) {
        try { resolve({ status: this.statusCode, body: JSON.parse(text) }); }
        catch (e) { reject(new Error('non-JSON response: ' + String(text).slice(0, 120))); }
      },
    };
    handler(req, res).catch(reject);
  });
}

apply(ctx, {
  manualDir: join(process.env.DSH_UNDO_ROOT, 'manual'),
  autoDir: join(process.env.DSH_UNDO_ROOT, 'auto'),
  homeDir: homeA,
  profileDir: join(homeA, 'profiles', 'web'),
  profileName: 'web',
  pluginDirs: [],
  watch: false,
});
await new Promise((r) => setTimeout(r, 300));

check(typeof route === 'function', '宿主 webServer 注册了 /api/undo 前缀处理器');

const status0 = await call(route, 'GET', '/api/undo/status');
check(status0.status === 200 && status0.body.ok === true
  && status0.body.storeScope === 'flat' && status0.body.sharedStore === true
  && typeof status0.body.storeRoot === 'string',
  `status 带库根作用域（${status0.body.storeScope}/${status0.body.sharedStore}）`);

const inst0 = await call(route, 'GET', '/api/undo/instances');
check(inst0.status === 200 && inst0.body.ok === true && Array.isArray(inst0.body.instances)
  && inst0.body.effective.home === homeA && typeof inst0.body.effective.storeRoot === 'string',
  'GET /api/undo/instances 返回实例列表与 effective.storeRoot');

// 写入一条命名实例，走 settings.instances + current 持久化分支
await writeFile(settingsFile, JSON.stringify({ consent: true, autoEnabled: false, keepAuto: 5, keepPre: 2, instances: [{ name: 'b', home: homeB, profile: 'work' }] }, null, 2), 'utf8');
const inst1 = await call(route, 'GET', '/api/undo/instances');
check(inst1.body.instances.length === 1 && inst1.body.instances[0].name === 'b',
  'GET /api/undo/instances 读到 settings 里的命名实例');

const switchB = await call(route, 'POST', '/api/undo/instances', { instance: 'b' });
check(switchB.status === 200 && switchB.body.ok === true && switchB.body.home === homeB && switchB.body.profile === 'work',
  'POST /api/undo/instances 按名字切到 homeB/work');
const persisted = JSON.parse(await readFile(settingsFile, 'utf8'));
check(persisted.current === 'b', '切到命名实例后 current 落盘');
const settingsB = await call(route, 'GET', '/api/undo/settings');
// 第二轮语义：库根按 home × profile 解析。目标实例 homeB 既没有 profiles/work 也没有
// 任何快照目录 → 默认 scoped（<home>/undo-snapshots/<profile>/{manual,auto}），不再是平铺。
check(settingsB.body.settings.manualDir === join(homeB, 'undo-snapshots', 'work', 'manual')
  && settingsB.body.settings.autoDir === join(homeB, 'undo-snapshots', 'work', 'auto'),
  '切库后 manualDir/autoDir 落到目标 home 的 profile 作用域（单改 homeDir 不够）');

const reset = await call(route, 'POST', '/api/undo/instances', { reset: true });
const settingsA = await call(route, 'GET', '/api/undo/settings');
const statusA = await call(route, 'GET', '/api/undo/status');
const persisted2 = JSON.parse(await readFile(settingsFile, 'utf8'));
check(reset.body.ok === true && reset.body.reset === true
  && settingsA.body.settings.manualDir === join(process.env.DSH_UNDO_ROOT, 'manual')
  && statusA.body.profileName === 'web',
  'POST {reset:true} 切回启动默认库根与 profile');
check(persisted2.current === null, 'reset 清掉 current，下次启动不会又被切走');

const badHome = await call(route, 'POST', '/api/undo/instances', { home: join(root, 'nope') });
check(badHome.status === 400 && badHome.body.error && badHome.body.error.code === 'bad-home',
  '切到不存在的 home 给 400 bad-home');

const badHost = await call(route, 'POST', '/api/undo/instances/proxy', { url: 'http://example.com', path: '/api/undo/status' });
check(badHost.body.ok === false && badHost.body.error.code === 'bad-host',
  '代理拒绝非回环地址（bad-host）');
const badPath = await call(route, 'POST', '/api/undo/instances/proxy', { url: 'http://127.0.0.1:1', path: '/api/undo/nope' });
check(badPath.body.ok === false && badPath.body.error.code === 'bad-action',
  '代理拒绝白名单外的 action（bad-action）');
const unreachable = await call(route, 'POST', '/api/undo/instances/proxy', { url: 'http://127.0.0.1:1', path: '/api/undo/status' });
check(unreachable.body.ok === false && unreachable.body.error.code === 'remote-failed',
  '代理对不可达远端返回 remote-failed，不抛栈');

// ── 第二轮 A（契约 4.4/4.5）：instances 字段 / 增删 / settings 跟随实例 / 热重读 / 合并写 ──
// 实例列表只在「启动实例的 settings 文件」里存一份（instancesFile）；切到别的实例后，
// GET/POST /api/undo/settings 一律读写目标实例自己的 <home>/undo/settings.json，
// 单改 homeDir 不搬 settingsFile 会让面板继续写启动实例的文件（本轮修复点）。
const instFields = await call(route, 'GET', '/api/undo/instances');
check(instFields.status === 200 && instFields.body.settingsFile === settingsFile
  && instFields.body.effective?.home === homeA && instFields.body.effective?.settingsFile === settingsFile
  && typeof instFields.body.effective.storeRoot === 'string',
  'A: GET /api/undo/instances 带 settingsFile（实例文件）与 effective（home/storeRoot/settingsFile）');

const upA = await call(route, 'POST', '/api/undo/instances', { upsert: { name: 'inst-b', port: 3082, home: homeB } });
const fileAfterUpsert = JSON.parse(await readFile(settingsFile, 'utf8'));
check(upA.status === 200 && upA.body.ok === true
  && upA.body.instances.some((x) => x.name === 'inst-b' && x.home === homeB)
  && (fileAfterUpsert.instances ?? []).some((x) => x.name === 'inst-b' && x.home === homeB),
  'A: POST {upsert} 写入实例，落盘在启动实例的 settings 文件里');

const readBackA = await call(route, 'GET', '/api/undo/instances');
check(readBackA.body.instances.some((x) => x.name === 'inst-b' && x.home === homeB),
  'A: GET /api/undo/instances 读回刚 upsert 的实例');

const badNameUp = await call(route, 'POST', '/api/undo/instances', { upsert: { name: 'bad name', home: homeB } });
check(badNameUp.status === 400 && badNameUp.body.error?.code === 'bad-name',
  'A: upsert 坏 name 给 400 bad-name');

const ghostHomeA = join(root, 'ghost-home');
const badHomeUp = await call(route, 'POST', '/api/undo/instances', { upsert: { name: 'ghost', home: ghostHomeA } });
const fileAfterBadA = JSON.parse(await readFile(settingsFile, 'utf8'));
check(badHomeUp.status === 400 && badHomeUp.body.error?.code === 'bad-home'
  && !(fileAfterBadA.instances ?? []).some((x) => x.name === 'ghost'),
  'A: upsert 不存在的 home 给 400 bad-home 且不落盘');

// 目标实例自带一份 settings：值与启动实例不同，热重读与合并写都以它为准。
const homeBSettings = join(homeB, 'undo', 'settings.json');
await mkdir(dirname(homeBSettings), { recursive: true });
await writeFile(homeBSettings, JSON.stringify({
  keepAuto: 42, keepPre: 7, sensitiveMode: 'keep',
  instances: [{ name: 'keepme', home: homeB }], current: 'keepme',
}, null, 2), 'utf8');
const switchedA = await call(route, 'POST', '/api/undo/instances', { instance: 'inst-b' });
const settingsOfB = await call(route, 'GET', '/api/undo/settings');
check(switchedA.body.ok === true && switchedA.body.settingsFile === homeBSettings
  && settingsOfB.body.settingsFile === homeBSettings
  && settingsOfB.body.settings.keepAuto === 42 && settingsOfB.body.settings.keepPre === 7
  && settingsOfB.body.settings.sensitiveMode === 'keep'
  && settingsOfB.body.instancesFile === settingsFile,
  'A: 切实例后 GET /api/undo/settings 指向目标实例文件，值来自该文件；instances 仍在启动文件');

// 热重读：另一个入口改了目标实例的 settings，本次请求立刻看到新值（不重启、不缓存）。
await writeFile(homeBSettings, JSON.stringify({
  keepAuto: 77, keepPre: 3, sensitiveMode: 'redact',
  instances: [{ name: 'keepme', home: homeB }], current: 'keepme',
}, null, 2), 'utf8');
const hotA = await call(route, 'GET', '/api/undo/settings');
check(hotA.body.reloaded === true && hotA.body.settings.keepAuto === 77
  && hotA.body.settings.keepPre === 3 && hotA.body.settings.sensitiveMode === 'redact',
  'A: 热重读——改目标 settings 文件后不重启，GET 立刻看到新值');

// 合并写：POST 只覆盖可编辑设置，instances/current 等非设置键必须原样保留。
const postSettingsA = await call(route, 'POST', '/api/undo/settings', { keepAuto: 12 });
const writtenA = JSON.parse(await readFile(homeBSettings, 'utf8'));
check(postSettingsA.body.ok === true && postSettingsA.body.settings.keepAuto === 12
  && Array.isArray(writtenA.instances) && writtenA.instances.length === 1
  && writtenA.instances[0].name === 'keepme' && writtenA.current === 'keepme',
  'A: POST /api/undo/settings 合并写：不丢目标文件里的 instances/current 键');

// W73（#50）：headerMode 默认 auto / 写入后可读回 / 文件里的非法值回落 auto（与局外同形）。
const hmDefaultA = await call(route, 'GET', '/api/undo/settings');
const hmPostA = await call(route, 'POST', '/api/undo/settings', { headerMode: 'compact' });
const hmHotA = await call(route, 'GET', '/api/undo/settings');
await writeFile(homeBSettings, JSON.stringify({
  keepAuto: 12, headerMode: 'xx',
  instances: [{ name: 'keepme', home: homeB }], current: 'keepme',
}, null, 2), 'utf8');
const hmBadA = await call(route, 'GET', '/api/undo/settings');
check(hmDefaultA.body.settings.headerMode === 'auto' && hmPostA.body.settings.headerMode === 'compact'
  && hmHotA.body.settings.headerMode === 'compact' && hmBadA.body.settings.headerMode === 'auto',
  'W73: headerMode 默认 auto、写入后读得回 compact、文件里的非法值回落 auto');

const removedA = await call(route, 'POST', '/api/undo/instances', { remove: 'inst-b' });
const fileAfterRemove = JSON.parse(await readFile(settingsFile, 'utf8'));
check(removedA.body.ok === true && !removedA.body.instances.some((x) => x.name === 'inst-b')
  && removedA.body.current === null && !(fileAfterRemove.instances ?? []).some((x) => x.name === 'inst-b')
  && fileAfterRemove.current === null,
  'A: POST {remove} 删除实例并清掉指向它的 current');

const resetA2 = await call(route, 'POST', '/api/undo/instances', { reset: true });
check(resetA2.body.ok === true && resetA2.body.reset === true && resetA2.body.settingsFile === settingsFile,
  'A: {reset:true} 把 settingsFile 一并切回启动实例（不只是 manualDir/autoDir）');
// 切实例时 currentProfile 已经被写进 SETTINGS_FILE；reset 必须连带清掉，否则重启又切回上次 profile。
const fileAfterReset = JSON.parse(await readFile(settingsFile, 'utf8'));
check(fileAfterReset.current === null && fileAfterReset.currentProfile === null,
  'A: {reset:true} 同时清掉持久化的 current/currentProfile（重启不会又切回上次选择）');

// ── 第二轮 B（契约 4.1/4.4/4.5/4.6/4.7）：端口 × profile 的路由面 ──────────────
// 局内：port 取自请求 Host 头；instances 每项带存活探测结果；list 带归属标注与计数；
// switch 换 profile 后 status 的 profileName/profileDetail.name/storeRoot 跟随；
// scan 只给建议不抛栈；desktop 安全模式默认拒动、confirmDesktop 后放行。
const webProfile = join(homeA, 'profiles', 'web');
const deskProfile = join(homeA, 'profiles', 'desktop');
await mkdir(webProfile, { recursive: true });
await mkdir(deskProfile, { recursive: true });
await writeFile(join(webProfile, 'package.json'), '{"name":"web-fixture"}\n', 'utf8');
await writeFile(join(webProfile, 'cordis.patch.yml'), '# web fixture\n[]\n', 'utf8');
await writeFile(join(deskProfile, 'package.json'), '{"name":"desk-fixture"}\n', 'utf8');
await writeFile(join(deskProfile, 'cordis.patch.yml'), '# desk fixture\n[]\n', 'utf8');

/** 假远端：模拟一个装了新版插件的 DSH 实例（home 故意与配置不同，用来验 probedHome/homeMismatch）。 */
const probeHome = join(root, 'probe-home');
await mkdir(probeHome, { recursive: true });
const probeSrv = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true, profileName: 'web', storeRoot: join(probeHome, 'undo-snapshots', 'web'),
    total: 7, homeDir: probeHome, settingsFile: join(probeHome, 'undo', 'settings.json'),
    instanceName: 'probe',
  }));
});
await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r));
const probePort = probeSrv.address().port;

const stB = await call(route, 'GET', '/api/undo/status', undefined, { host: '127.0.0.1:3082' });
check(stB.body.ok === true && stB.body.port === 3082 && stB.body.mode === 'host'
  && stB.body.homeDir === homeA && stB.body.settingsFile === settingsFile && stB.body.instancesFile === settingsFile
  && stB.body.profileName === 'web' && stB.body.profileDetail?.name === 'web'
  && stB.body.profileDetail.storeRoot === join(homeA, 'undo-snapshots', 'web')
  && Array.isArray(stB.body.profilesInfo) && stB.body.profilesInfo.some((p) => p.name === 'desktop')
  && Array.isArray(stB.body.profiles) && stB.body.profiles.includes('web'),
  `B: 局内 status 带 port/mode/homeDir/settingsFile/instancesFile/profileDetail/profilesInfo（port=${stB.body.port}）`);

await call(route, 'POST', '/api/undo/instances', { upsert: { name: 'probe', port: probePort, home: homeB } });
await call(route, 'POST', '/api/undo/instances', { upsert: { name: 'dead', port: 1, home: homeB } });
const instB = await call(route, 'GET', '/api/undo/instances');
const FIELDS_B = ['name', 'port', 'home', 'profile', 'url', 'reachable', 'hasApi', 'apiVersion', 'currentProfile',
  'profiles', 'total', 'storeRoot', 'settingsFile', 'instanceName', 'probedHome', 'homeMismatch', 'error'];
const probeB = instB.body.instances.find((x) => x.name === 'probe');
const deadB = instB.body.instances.find((x) => x.name === 'dead');
check(instB.body.ok === true && Array.isArray(instB.body.instances) && probeB && deadB
  && instB.body.instances.every((x) => FIELDS_B.every((k) => k in x)),
  `B: GET /api/undo/instances 每项字段齐全（${instB.body.instances.length} 项，port/reachable/hasApi/profiles/currentProfile/total/probedHome/homeMismatch）`);
check(probeB.reachable === true && probeB.hasApi === true && probeB.apiVersion === 2
  && probeB.total === 7 && probeB.currentProfile === 'web' && probeB.instanceName === 'probe'
  && probeB.home === homeB && probeB.probedHome === probeHome && probeB.homeMismatch === true
  && Array.isArray(probeB.profiles)
  && deadB.reachable === false && deadB.hasApi === false && deadB.apiVersion === null
  && typeof deadB.error === 'string',
  'B: 在线实例探测到 reachable/hasApi/total 且 home 不被 probedHome 覆盖；不可达端口 reachable:false 不抛栈');

const badPortB = await call(route, 'POST', '/api/undo/instances', { upsert: { name: 'badport', port: 70000, home: homeB } });
const strPortB = await call(route, 'POST', '/api/undo/instances', { upsert: { name: 'strok', port: '3082', home: homeB } });
const strokB = (await call(route, 'GET', '/api/undo/instances')).body.instances.find((x) => x.name === 'strok');
check(badPortB.status === 400 && badPortB.body.error?.code === 'bad-port'
  && strPortB.body.ok === true && strokB?.port === 3082,
  'B: upsert 越界端口给 400 bad-port；纯数字字符串端口按整数落盘（"3082"→3082）');

const snapB = await call(route, 'POST', '/api/undo/snapshot', { reason: 'b-fixture' });
const listB = await call(route, 'GET', '/api/undo/list?profile=desktop');
const snapsB = listB.body.snapshots ?? [];
const cbpB = listB.body.countByProfile ?? {};
check(snapB.body.ok === true && listB.body.ok === true && snapsB.length > 0
  && snapsB.every((s) => Object.prototype.hasOwnProperty.call(s, 'profileMatch')
    && (s.profileMatch === null || typeof s.profileMatch === 'boolean'))
  && ['web', 'desktop', 'unknown'].every((k) => Number.isInteger(cbpB[k]))
  && cbpB.web + cbpB.desktop + cbpB.unknown === snapsB.length
  && typeof listB.body.store?.root === 'string' && typeof listB.body.store.scope === 'string'
  && listB.body.profile === 'desktop',
  `B: GET /list?profile=desktop 每条带 profileMatch，countByProfile 三项和=总数（${JSON.stringify(cbpB)}/${snapsB.length}）`);

const swToDesk = await call(route, 'POST', '/api/undo/instances', { switch: { instance: 'probe', profile: 'desktop' } });
const stDesk = await call(route, 'GET', '/api/undo/status');
check(swToDesk.body.ok === true && stDesk.body.profileName === 'desktop'
  && stDesk.body.profileDetail?.name === 'desktop'
  && stDesk.body.storeRoot === join(homeB, 'undo-snapshots', 'desktop'),
  `B: {switch:{instance,profile}} 后 status 的 profileName/profileDetail.name/storeRoot 跟随（${stDesk.body.profileName}）`);

const swToWeb = await call(route, 'POST', '/api/undo/instances', { switch: { instance: 'probe', profile: 'web' } });
const stWeb = await call(route, 'GET', '/api/undo/status');
const resetB = await call(route, 'POST', '/api/undo/instances', { reset: true });
const stBoot = await call(route, 'GET', '/api/undo/status');
check(swToWeb.body.ok === true && stWeb.body.profileName === 'web'
  && stWeb.body.storeRoot === join(homeB, 'undo-snapshots', 'web')
  && resetB.body.ok === true && stBoot.body.profileName === 'web'
  && stBoot.body.homeDir === homeA && stBoot.body.settingsFile === settingsFile,
  'B: 切回同 profile 无副作用（storeRoot 回到同作用域），{reset} 回到启动实例与 settings 文件');

const scanB = await call(route, 'POST', '/api/undo/scan', {});
const sugB = scanB.body?.suggestions;
check(scanB.status === 200 && scanB.body.ok === true && Array.isArray(sugB)
  && typeof scanB.body.durationMs === 'number' && typeof scanB.body.scannedAt === 'string'
  && Array.isArray(scanB.body.known)
  && sugB.every((s) => ['port', 'pid', 'name', 'cmdline', 'home', 'hasApi', 'profileName', 'instanceName', 'total'].every((k) => k in s)),
  `B: POST /api/undo/scan 返回 {ok,suggestions[]} 且不抛栈（${sugB?.length ?? '?'} 条建议，${scanB.body?.durationMs ?? '?'}ms）`);

const deskPkgPath = join(deskProfile, 'package.json');
const deskPatchPath = join(deskProfile, 'cordis.patch.yml');
const beforeDesk = { pkg: await readFile(deskPkgPath, 'utf8'), patch: await readFile(deskPatchPath, 'utf8') };
const noConfirmB = await call(route, 'POST', '/api/undo/safe-mode', { action: 'on', profile: 'desktop' });
const afterDesk = { pkg: await readFile(deskPkgPath, 'utf8'), patch: await readFile(deskPatchPath, 'utf8') };
check(noConfirmB.status === 200 && noConfirmB.body.ok === false && noConfirmB.body.reason === 'desktop-profile'
  && noConfirmB.body.needConfirm === true
  && afterDesk.pkg === beforeDesk.pkg && afterDesk.patch === beforeDesk.patch,
  'B: 局内安全模式 {profile:desktop} 不带 confirmDesktop → reason=desktop-profile 且不写盘');

const confirmB = await call(route, 'POST', '/api/undo/safe-mode', { action: 'on', profile: 'desktop', confirmDesktop: true });
const patchAfterB = await readFile(deskPatchPath, 'utf8');
check(confirmB.body.ok === true && confirmB.body.confirmedDesktop === true && /SAFE MODE/.test(patchAfterB),
  'B: 带 confirmDesktop:true 时允许写盘（desktop patch 出现 SAFE MODE 标记）');

const offB = await call(route, 'POST', '/api/undo/safe-mode', { action: 'off', profile: 'desktop', confirmDesktop: true });
const safeStatusB = await call(route, 'POST', '/api/undo/safe-mode', { action: 'status', profile: 'desktop' });
check(offB.body.ok === true && safeStatusB.body.ok === true && safeStatusB.body.active === false,
  'B: 安全模式 off 复原（status.active=false），桌面默认拒动路径不受影响');

await new Promise((resolve) => probeSrv.close(resolve));
await rm(root, { recursive: true, force: true }).catch(() => { });
console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail > 0 ? 1 : 0);
