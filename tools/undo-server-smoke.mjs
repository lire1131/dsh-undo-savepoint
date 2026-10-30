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
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
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
// 宿主 shell 可能注入 DSH_HOME/DSH_PROFILE（从 DSH 会话里跑测试时必现）。
// 不剥掉会把 server 的实例裁决打到真实 home 上，本测试就不再是隔离的。
delete baseEnv.DSH_HOME;
delete baseEnv.DSH_PROFILE;
delete baseEnv.DSH_PROFILE_DIR;

const children = []; // 全部子进程登记，finally 统一清场

/** 启动一个持续运行的服务器实例，等 stdout 出现"打开: URL"后返回 {child,url,output} */
function startServer(extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, ...extraArgs, '--no-open'], { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // W53：面板副标题改取实时 profile，两端 status 都要带这两个字段（局外还保留 profiles 数组）
  check(typeof s?.body?.profileName === 'string' && s.body.profileName.length > 0
    && typeof s?.body?.profileSource === 'string' && Array.isArray(s?.body?.profiles),
    `局外 status 带 profileName/profileSource 且保留 profiles（${s?.body?.profileName}/${s?.body?.profileSource}）`);


  // W62：库根作用域与共享标志；实例接口带 effective.storeRoot
  check(s?.body?.sharedStore === true && typeof s?.body?.storeRoot === 'string' && s?.body?.storeScope === 'flat',
    `局外 status 带 storeRoot/storeScope/sharedStore（${s?.body?.storeScope}/${s?.body?.sharedStore}）`);
  const instR = await fetch(new URL('api/undo/instances', A.url), { signal: AbortSignal.timeout(2000) });
  const instJ = instR.ok ? await instR.json() : null;
  check(instJ?.ok === true && Array.isArray(instJ.instances) && typeof instJ.effective?.storeRoot === 'string',
    'GET /api/undo/instances 返回实例列表与 effective.storeRoot');

  const listR = await fetch(new URL('api/undo/list', A.url), { signal: AbortSignal.timeout(2000) });
  check(listR.ok && (await listR.json()).ok === true, 'GET /api/undo/list 可命中（核心端点无缺失）');

  // ── 场景 1b（第二轮 A / 契约 4.4-4.5）：实例增删、settings 跟随实例、热重读、合并写 ──
  // 局外与局内同形：实例列表只在启动实例的 settings 文件里存一份；切到某实例后，
  // GET/POST /api/undo/settings 读写它自己的 <home>/undo/settings.json，热重读不重启。
  const S = {
    async get(p) {
      const r = await fetch(new URL('api/undo/' + p, A.url), { signal: AbortSignal.timeout(4000) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    async post(p, body) {
      const r = await fetch(new URL('api/undo/' + p, A.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(4000),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  };
  const homeB = join(sandbox, 'homeB');
  await mkdir(homeB, { recursive: true });
  const instancesFile = baseEnv.DSH_UNDO_SETTINGS;

  const instA = await S.get('instances');
  check(instA.body?.ok === true && instA.body.settingsFile === instancesFile
    && instA.body.effective?.settingsFile === instancesFile
    && typeof instA.body.effective?.storeRoot === 'string',
    '局外 GET /api/undo/instances 带 settingsFile 与 effective.settingsFile');

  const upA = await S.post('instances', { upsert: { name: 'inst-b', port: 3082, home: homeB } });
  const fileUpA = JSON.parse(await readFile(instancesFile, 'utf8'));
  check(upA.body?.ok === true && upA.body.instances.some((x) => x.name === 'inst-b' && x.home === homeB)
    && (fileUpA.instances ?? []).some((x) => x.name === 'inst-b' && x.home === homeB),
    '局外 POST {upsert} 写入实例，落盘在启动实例的 settings 文件里');

  const readBackA = await S.get('instances');
  check(readBackA.body?.instances?.some((x) => x.name === 'inst-b' && x.home === homeB) === true,
    '局外 GET /api/undo/instances 读回刚 upsert 的实例');

  const badNameA = await S.post('instances', { upsert: { name: 'bad name', home: homeB } });
  check(badNameA.status === 400 && badNameA.body?.error?.code === 'bad-name',
    '局外 upsert 坏 name 给 400 bad-name');

  const badHomeA = await S.post('instances', { upsert: { name: 'ghost', home: join(sandbox, 'ghost-home') } });
  const fileBadA = JSON.parse(await readFile(instancesFile, 'utf8'));
  check(badHomeA.status === 400 && badHomeA.body?.error?.code === 'bad-home'
    && !(fileBadA.instances ?? []).some((x) => x.name === 'ghost'),
    '局外 upsert 不存在的 home 给 400 bad-home 且不落盘');

  // 目标实例自带一份 settings：值与启动实例不同，热重读与合并写都以它为准。
  const homeBSettings = join(homeB, 'undo', 'settings.json');
  await mkdir(dirname(homeBSettings), { recursive: true });
  const seedB = (keepAuto, keepPre, sensitiveMode) => writeFile(homeBSettings, JSON.stringify({
    keepAuto, keepPre, sensitiveMode,
    instances: [{ name: 'keepme', home: homeB }], current: 'keepme',
  }, null, 2), 'utf8');
  await seedB(42, 7, 'keep');
  const switchedA = await S.post('instances', { instance: 'inst-b' });
  const settingsOfB = await S.get('settings');
  check(switchedA.body?.ok === true && switchedA.body.settingsFile === homeBSettings
    && settingsOfB.body?.settingsFile === homeBSettings
    && settingsOfB.body.settings.keepAuto === 42 && settingsOfB.body.settings.keepPre === 7
    && settingsOfB.body.settings.sensitiveMode === 'keep'
    && settingsOfB.body.instancesFile === instancesFile,
    '局外切实例后 GET /api/undo/settings 指向目标实例文件，值来自该文件；instances 仍在启动文件');

  await seedB(77, 3, 'redact');
  const hotA = await S.get('settings');
  check(hotA.body?.reloaded === true && hotA.body.settings.keepAuto === 77
    && hotA.body.settings.keepPre === 3 && hotA.body.settings.sensitiveMode === 'redact',
    '局外热重读——改目标 settings 文件后不重启，GET 立刻看到新值');

  const postSettingsA = await S.post('settings', { keepAuto: 12 });
  const writtenA = JSON.parse(await readFile(homeBSettings, 'utf8'));
  check(postSettingsA.body?.ok === true && postSettingsA.body.settings.keepAuto === 12
    && Array.isArray(writtenA.instances) && writtenA.instances.length === 1
    && writtenA.instances[0].name === 'keepme' && writtenA.current === 'keepme',
    '局外 POST /api/undo/settings 合并写：不丢目标文件里的 instances/current 键');

  // W73（#50）：headerMode 默认 auto / 写入后可读回 / 文件里的非法值回落 auto（与局内同形）。
  const hmDefaultA = await S.get('settings');
  const hmPostA = await S.post('settings', { headerMode: 'compact' });
  const hmHotA = await S.get('settings');
  await writeFile(homeBSettings, JSON.stringify({
    keepAuto: 12, headerMode: 'xx',
    instances: [{ name: 'keepme', home: homeB }], current: 'keepme',
  }, null, 2), 'utf8');
  const hmBadA = await S.get('settings');
  check(hmDefaultA.body?.settings?.headerMode === 'auto' && hmPostA.body?.settings?.headerMode === 'compact'
    && hmHotA.body?.settings?.headerMode === 'compact' && hmBadA.body?.settings?.headerMode === 'auto',
    'W73: headerMode 默认 auto、写入后读得回 compact、文件里的非法值回落 auto');

  const removedA = await S.post('instances', { remove: 'inst-b' });
  const fileAfterRemoveA = JSON.parse(await readFile(instancesFile, 'utf8'));
  check(removedA.body?.ok === true && !removedA.body.instances.some((x) => x.name === 'inst-b')
    && removedA.body.current === null && fileAfterRemoveA.current === null,
    '局外 POST {remove} 删除实例并清掉指向它的 current');

  const resetA2 = await S.post('instances', { reset: true });
  check(resetA2.body?.ok === true && resetA2.body.reset === true && resetA2.body.settingsFile === instancesFile,
    '局外 {reset:true} 把 settingsFile 一并切回启动实例（不只是 manualDir/autoDir）');

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

  // ── 场景 5（第二轮 B / 契约 4.1/4.4-4.7）：端口 × profile 的局外路由面 ──────────
  // 单实例检测要求上面几个都停下后才能起带 --home 的 E，否则会被判「已在运行」直接退出。
  const bootHome = join(sandbox, 'boot-home');
  for (const p of ['web', 'desktop']) {
    const dir = join(bootHome, 'profiles', p);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: p + '-fixture' }) + '\n', 'utf8');
    await writeFile(join(dir, 'cordis.patch.yml'), '# ' + p + ' fixture\n[]\n', 'utf8');
  }
  const E = await startServer(['--home', bootHome]);
  check(E.url !== null, '局外 B：带 --home 的服务器启动成功');
  const eport = Number(new URL(E.url).port);
  const Eget = async (p) => {
    const r = await fetch(new URL('api/undo/' + p, E.url), { signal: AbortSignal.timeout(4000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const Epost = async (p, body) => {
    const r = await fetch(new URL('api/undo/' + p, E.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(4000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const eSettings = join(bootHome, 'undo', 'settings.json');
  const eInstances = join(bootHome, 'undo-snapshots', 'web');

  // 状态面：port/mode/homeDir/settingsFile/instancesFile/profileDetail/profilesInfo
  const stE = await Eget('status');
  check(stE.body?.ok === true && stE.body.port === eport && stE.body.mode === 'local'
    && stE.body.homeDir === bootHome && stE.body.settingsFile === eSettings
    && stE.body.instancesFile === instancesFile
    && stE.body.profileName === 'web' && stE.body.profileDetail?.name === 'web'
    && stE.body.profileDetail.storeRoot === eInstances
    && Array.isArray(stE.body.profilesInfo) && stE.body.profilesInfo.some((p) => p.name === 'desktop')
    && Array.isArray(stE.body.profiles) && stE.body.profiles.includes('web'),
    `局外 B：status 带 port/mode/homeDir/settingsFile/instancesFile/profileDetail/profilesInfo（port=${stE.body?.port}/${eport}）`);

  // 实例列表：存活探测、字段齐全、home 不被 probedHome 覆盖、离线不抛栈
  const probeHome = join(sandbox, 'probe-home');
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
  await Epost('instances', { upsert: { name: 'probe', port: probePort, home: homeB } });
  await Epost('instances', { upsert: { name: 'dead', port: 1, home: homeB } });
  const instE = await Eget('instances');
  const FIELDS_E = ['name', 'port', 'home', 'profile', 'url', 'reachable', 'hasApi', 'apiVersion', 'currentProfile',
    'profiles', 'total', 'storeRoot', 'settingsFile', 'instanceName', 'probedHome', 'homeMismatch', 'error'];
  const probeE = instE.body?.instances?.find((x) => x.name === 'probe');
  const deadE = instE.body?.instances?.find((x) => x.name === 'dead');
  check(instE.body?.ok === true && Array.isArray(instE.body.instances) && probeE && deadE
    && instE.body.instances.every((x) => FIELDS_E.every((k) => k in x)),
    `局外 B：GET /instances 每项字段齐全（${instE.body?.instances?.length ?? '?'} 项）`);
  check(probeE.reachable === true && probeE.hasApi === true && probeE.apiVersion === 2
    && probeE.total === 7 && probeE.currentProfile === 'web' && probeE.instanceName === 'probe'
    && probeE.home === homeB && probeE.probedHome === probeHome && probeE.homeMismatch === true
    && deadE.reachable === false && deadE.hasApi === false && deadE.apiVersion === null
    && typeof deadE.error === 'string',
    '局外 B：在线实例探测到 reachable/hasApi/total 且 home 保留配置值；不可达端口 reachable:false 不抛栈');

  const badPortE = await Epost('instances', { upsert: { name: 'badport', port: 70000, home: homeB } });
  const strPortE = await Epost('instances', { upsert: { name: 'strok', port: '3082', home: homeB } });
  const strokE = (await Eget('instances')).body?.instances?.find((x) => x.name === 'strok');
  check(badPortE.status === 400 && badPortE.body?.error?.code === 'bad-port'
    && strPortE.body?.ok === true && strokE?.port === 3082,
    '局外 B：upsert 越界端口给 400 bad-port；纯数字字符串端口按整数落盘（"3082"→3082）');

  // list：每条带 profileMatch（true/false/null 三态），countByProfile 三项和=总数
  const snapE = await Epost('snapshot', { reason: 'b-fixture' });
  const listE = await Eget('list?profile=desktop');
  const snapsE = listE.body?.snapshots ?? [];
  const cbpE = listE.body?.countByProfile ?? {};
  check(snapE.body?.ok === true && listE.body?.ok === true && snapsE.length > 0
    && snapsE.every((s) => Object.prototype.hasOwnProperty.call(s, 'profileMatch')
      && (s.profileMatch === null || typeof s.profileMatch === 'boolean'))
    && ['web', 'desktop', 'unknown'].every((k) => Number.isInteger(cbpE[k]))
    && cbpE.web + cbpE.desktop + cbpE.unknown === snapsE.length
    && typeof listE.body.store?.root === 'string' && listE.body.profile === 'desktop',
    `局外 B：GET /list?profile=desktop 每条带 profileMatch，countByProfile 三项和=总数（${JSON.stringify(cbpE)}/${snapsE.length}）`);

  // switch：profileName/profileDetail.name/storeRoot 跟随；切回无副作用；reset 回启动实例
  const swDeskE = await Epost('instances', { switch: { instance: 'probe', profile: 'desktop' } });
  const stDeskE = await Eget('status');
  check(swDeskE.body?.ok === true && stDeskE.body?.profileName === 'desktop'
    && stDeskE.body.profileDetail?.name === 'desktop'
    && stDeskE.body.storeRoot === join(homeB, 'undo-snapshots', 'desktop'),
    `局外 B：{switch:{instance,profile}} 后 status 的 profileName/profileDetail.name/storeRoot 跟随（${stDeskE.body?.profileName}）`);
  const swWebE = await Epost('instances', { switch: { instance: 'probe', profile: 'web' } });
  const stWebE = await Eget('status');
  const resetE = await Epost('instances', { reset: true });
  const stBootE = await Eget('status');
  check(swWebE.body?.ok === true && stWebE.body?.profileName === 'web'
    && stWebE.body.storeRoot === join(homeB, 'undo-snapshots', 'web')
    && resetE.body?.ok === true && stBootE.body?.profileName === 'web'
    && stBootE.body.homeDir === bootHome && stBootE.body.settingsFile === eSettings,
    '局外 B：切回同 profile 无副作用（storeRoot 回到同作用域），{reset} 回到启动实例与 settings 文件');

  // scan：只给建议，形状固定，不抛栈（本机有没有 DSH 进程都允许空数组）
  const scanE = await Epost('scan', {});
  const sugE = scanE.body?.suggestions;
  check(scanE.status === 200 && scanE.body?.ok === true && Array.isArray(sugE)
    && typeof scanE.body.durationMs === 'number' && typeof scanE.body.scannedAt === 'string'
    && Array.isArray(scanE.body.known)
    && sugE.every((s) => ['port', 'pid', 'name', 'cmdline', 'home', 'hasApi', 'profileName', 'instanceName', 'total'].every((k) => k in s)),
    `局外 B：POST /scan 返回 {ok,suggestions[]} 且不抛栈（${sugE?.length ?? '?'} 条建议，${scanE.body?.durationMs ?? '?'}ms）`);

  // desktop 安全模式：默认拒动且不写盘；confirmDesktop 放行；off 复原
  const deskPkgE = join(bootHome, 'profiles', 'desktop', 'package.json');
  const deskPatchE = join(bootHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const beforeE = { pkg: await readFile(deskPkgE, 'utf8'), patch: await readFile(deskPatchE, 'utf8') };
  const noConfirmE = await Epost('safe-mode', { action: 'on', profile: 'desktop' });
  const afterE = { pkg: await readFile(deskPkgE, 'utf8'), patch: await readFile(deskPatchE, 'utf8') };
  check(noConfirmE.status === 200 && noConfirmE.body?.ok === false && noConfirmE.body.reason === 'desktop-profile'
    && noConfirmE.body.needConfirm === true
    && afterE.pkg === beforeE.pkg && afterE.patch === beforeE.patch,
    '局外 B：安全模式 {profile:desktop} 不带 confirmDesktop → reason=desktop-profile 且不写盘');
  const confirmE = await Epost('safe-mode', { action: 'on', profile: 'desktop', confirmDesktop: true });
  const patchAfterE = await readFile(deskPatchE, 'utf8');
  check(confirmE.body?.ok === true && confirmE.body.confirmedDesktop === true && /SAFE MODE/.test(patchAfterE),
    '局外 B：带 confirmDesktop:true 时允许写盘（desktop patch 出现 SAFE MODE 标记）');
  const offE = await Epost('safe-mode', { action: 'off', profile: 'desktop', confirmDesktop: true });
  const stSafeE = await Epost('safe-mode', { action: 'status', profile: 'desktop' });
  check(offE.body?.ok === true && stSafeE.body?.ok === true && stSafeE.body.active === false,
    '局外 B：安全模式 off 复原（status.active=false），桌面默认拒动路径不受影响');
  await new Promise((r) => probeSrv.close(r));
  await stop(E.child);
} finally {
  await Promise.all(children.map(stop));
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail > 0 ? 1 : 0);
