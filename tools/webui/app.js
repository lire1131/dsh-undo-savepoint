/* dsh-undo-savepoint 局外 WebUI 逻辑（0.5.1-canary.1 第二轮：流程条 + 实例/Profile + 对比浮层 v2）。
   手写轻量 DOM、零依赖、双语；协议形状以 _scratch/round2-contract.md 第四节为准。
   新字段（instances[].port/reachable/hasApi/profiles、status.port/profilesInfo/settingsFile/
   instancesFile、list.profileMatch/countByProfile）全部按可缺失实现，旧服务端也能正常渲染。 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ── 多语言（zh 与 en 键集必须完全相等，且不许空值） ──────────────────────
  const dict = {
    zh: {
      appTitle: 'dsh-undo-savepoint', subtitle: '配置 / 插件 / 健康 快照',
      loading: '加载中…', loadingHint: '正在读取快照库，请稍候。',
      errorTitle: '加载失败', errorHint: '无法读取接口，确认 undo-server 还在运行后重试。', retry: '重试',
      empty: '暂无快照', emptyHint: '创建快照会把当前的配置、插件与 Profile 文件收进快照库。',
      noMatch: '没有匹配的快照', noMatchHint: '换一个搜索词或筛选条件试试。', clearFilters: '清除筛选',
      close: '关闭', cancel: '取消', confirm: '确认', save: '保存', del: '删除', delete: '删除', edit: '编辑',
      more: '更多', refresh: '刷新', settings: '设置', diagnose: '诊断', language: '语言',
      theme: '主题', themeAuto: '跟随系统', themeLight: '浅色', themeDark: '深色',
      undo: '撤销', redo: '重做', snapshot: '创建快照', makeSnap: '创建快照',
      prune: '清理过期快照', pruneShort: '清理', diff: '对比', diffTitle: '快照对比',
      restore: '恢复到此处', export: '导出', import: '导入',
      safemode: '安全模式', safemodeOff: '退出安全模式', msgBtn: '对话撤回',
      stepPort: '端口', stepProfile: 'Profile', stepStore: '快照库',
      instance: '实例', port: '端口', profile: 'Profile', store: '快照库',
      shared: '共享库', scoped: '按 profile 分片', customStore: '自定义库',
      unknownProfile: '归属未知', online: '在线', offline: '离线', apiOld: '旧版接口', current: '当前',
      snapUnit: '条快照', files: '个文件', profileFiles: '个配置文件', pluginFiles: '个插件文件',
      recent: '最近', home: 'Home', settingsFile: '设置文件', instancesFile: '实例文件',
      apiOldHint: '端口在线但插件未安装或版本较旧，只能按文件读取。',
      statusOnlineHint: '目标 DSH 端口可连通。', statusOfflineHint: '目标 DSH 端口不可连通，数据仍从 home 读取。',
      undoClick: '撤销最近一次变更？', redoClick: '重做最近一次撤销？',
      removeConfirm: '删除该快照？此操作不可撤销。',
      restoreConfirm: '恢复到该快照？会先把当前状态存为撤销点。',
      bulkConfirm: '删除选中的快照？此操作不可撤销。',
      pruneClick: '清理超出保留数的自动快照？手动快照不受影响。',
      safemodeClick: '进入安全模式：禁用除本插件外的全部用户插件，处理完请重启 DSH 后退出。',
      safemodeOffClick: '退出安全模式，恢复之前的插件与 bundle？',
      onlineWarn: '目标 DSH 正在运行，离线写入可能与其运行态冲突；建议在宿主内操作，仍要继续？',
      desktopWarn: 'desktop profile 的安全模式会改动 profile 配置，确认后才会写入。',
      homeMismatch: '端口与 home 不一致',
      homeMismatchHint: '配置的 home 与端口实测 home 不同，注意别看成另一个库。',
      probedHome: '实测 home',
      untrustedProfileHint: '该快照的 profile 字段不可信（旧版清单），按归属未知处理。',
      lastGood: '最后已知良好快照', restoreGood: '恢复到此处',
      autoSafeModeNote: '已自动进入安全模式（连续启动未完成）',
      crashBanner: '上次 DSH 启动未完成（可能崩溃）。',
      searchPlaceholder: '搜索 id / 原因 / 位置 / Profile', filterAll: '全部类型',
      kindManual: '手动', kindAuto: '自动', kindPre: '撤销前', kindBaseline: '基线',
      showSharedAll: '显示共享库全部',
      showSharedHint: '关闭时只看当前 profile 与归属未知；开启后显示全部。',
      selected: '项已选', deleteSelected: '删除所选', clearSelection: '清除选择', selectOne: '选择该快照',
      showing: '显示', today: '今天', yesterday: '昨天',
      stepAuto: '自动', preState: '撤销点', redacted: '脱敏', truncated: '截断', needsRestart: '需重启',
      note: '备注', tags: '标签', editNote: '编辑备注/标签',
      notePlaceholder: '备注内容（可选）', tagsPlaceholder: '标签，逗号分隔（可选）',
      noteSaved: '备注已保存', noteFailed: '保存失败', noNote: '无备注',
      makeSnapTitle: '创建快照', reasonPlaceholder: '说明（可选）', makeSnapConfirm: '创建', snapshotDone: '已创建快照',
      diffEmpty: '无差异', diffEmptyHint: '该快照与当前状态一致。',
      diffLoading: '正在读取对比…', diffLoadingHint: '正在读取快照与当前文件的差异。',
      diffError: '对比加载失败', diffErrorHint: '稍后重试，或先刷新快照列表。',
      diffFileEmpty: '该文件没有行级差异',
      groupConfig: '配置', groupPlugins: '插件', groupProfiles: 'Profile 代码', diffFilesCount: '个文件',
      settingsTitle: '设置', secInstances: '实例', secPolicy: '快照策略', secGuard: '安全与体检',
      instTitle: '实例管理', instAdd: '添加实例', instEdit: '编辑实例',
      instName: '名称', instPort: '端口', instHome: 'Home 路径',
      instHomeHint: '实例 home 目录，快照库与设置都从它读取。',
      instSave: '保存实例', instUpdate: '保存修改', instRemove: '删除',
      instNone: '还没有配置实例', instNoneHint: '手动添加，或用「扫描本机」发现正在运行的 DSH 端口。',
      instCurrent: '当前实例', instProfiles: '可用 Profile', instTotal: '快照数', apiLabel: '接口',
      instScan: '扫描本机', instScanning: '正在扫描…',
      instScanEmpty: '没有发现可加入的 DSH 端口', instScanEmptyHint: '确认 DSH 正在运行后重试；也可以手动添加实例。',
      instScanError: '扫描失败', instScanReady: '扫描完成',
      instScanHint: '扫描只给建议，不会自动写入实例列表。',
      instScanNotReady: '当前服务端尚未提供扫描接口，升级后再试。',
      instAddTo: '加入实例', instAdded: '已加入实例', instAlready: '已在实例中',
      instSaved: '实例已保存', instDeleted: '实例已删除', instDeleteConfirm: '删除实例',
      instBadName: '名称只允许字母、数字、点、下划线、短横线，长度 1-64。',
      instBadHome: '请填写 home 路径。', instBadPort: '端口需为 1-65535 的整数，或留空。',
      instSuggest: '扫描建议', process: '进程', probesProfile: '探测 Profile', scanDuration: '耗时',
      setAuto: '自动保存', setDebounce: '防抖（ms）', setKeep: '自动档保留数', setKeepPre: '后悔档保留数',
      setCleanup: '自动清理', setManualDir: '手动快照目录', setAutoDir: '自动快照目录',
      setSensitive: '敏感模式', setSensitiveRedact: '脱敏（默认）', setSensitiveKeep: '明文（旧行为）',
      setPluginDirs: '插件目录白名单（逗号分隔，留空=自动发现）',
      setWorkspaceDirs: '跟踪工作区目录（逗号/分号分隔，空=仅当前目录）',
      setDesktop: '创建桌面快捷方式', setDesktopInfo: '桌面目录',
      setSchedule: '定时快照', setScheduleEnabled: '启用定时快照', setScheduleMs: '间隔（分钟，≥1）',
      setBootHealth: '启动健康体检', setUpgradeGuard: 'DSH 升级护航',
      setGuardMode: '守卫发现启动受阻时', setGuardAsk: '询问（10 秒默认进入安全模式）',
      setGuardOn: '自动进入安全模式', setGuardOff: '只提醒不处理',
      setGuardShortcut: '创建「DSH 安全启动」桌面快捷方式',
      setAutoHeal: '连续启动失败时自动进入安全模式（次数）',
      saved: '设置已保存', saveFailed: '保存失败',
      doctorTitle: '诊断报告', doctorOk: '健康', doctorWarn: '提醒', doctorErr: '异常',
      doctorHealthy: '一切健康', doctorUnhealthy: '发现异常，建议处理。', doctorHead: '项检查',
      doctorFix: '修复可修项', doctorFixable: '可修复', doctorFixed: '已修复', doctorFailed: '失败',
      doctorSnapshot: '修复前快照',
      exportPass: '导出密码（可选，加密）', importPass: '导入密码', encrypted: '已加密',
      needPass: '该导出已加密，需密码', exportDone: '导出完成', importDone: '导入完成',
      msgTitle: '对话级撤回', msgEmpty: '暂无可撤回的消息批次', msgUndo: '撤回',
      msgUndoClick: '撤回该消息批次的文件改动？', msgUndone: '已撤回',
      instanceSwitched: '已切换实例', profileSwitched: '已切换 Profile', switchFailed: '切换失败',
      pickFileCanceled: '已取消选择文件', pruneDone: '清理完成', undoDone: '已撤销', redoDone: '已重做',
      restoreDone: '已恢复', removeDone: '已删除',
      confirmTitle: '确认操作', details: '详情'
    },
    en: {
      appTitle: 'dsh-undo-savepoint', subtitle: 'Config / plugin / health snapshots',
      loading: 'Loading…', loadingHint: 'Reading the snapshot store.',
      errorTitle: 'Failed to load', errorHint: 'The API did not answer. Check that undo-server is still running and retry.', retry: 'Retry',
      empty: 'No snapshots yet', emptyHint: 'Create a snapshot to capture the current config, plugin and profile files.',
      noMatch: 'No matching snapshots', noMatchHint: 'Try another search term or filter.', clearFilters: 'Clear filters',
      close: 'Close', cancel: 'Cancel', confirm: 'Confirm', save: 'Save', del: 'Delete', delete: 'Delete', edit: 'Edit',
      more: 'More', refresh: 'Refresh', settings: 'Settings', diagnose: 'Diagnose', language: 'Language',
      theme: 'Theme', themeAuto: 'Follow system', themeLight: 'Light', themeDark: 'Dark',
      undo: 'Undo', redo: 'Redo', snapshot: 'Create snapshot', makeSnap: 'Create snapshot',
      prune: 'Prune expired', pruneShort: 'Prune', diff: 'Compare', diffTitle: 'Snapshot compare',
      restore: 'Restore to here', export: 'Export', import: 'Import',
      safemode: 'Safe mode', safemodeOff: 'Exit safe mode', msgBtn: 'Message undo',
      stepPort: 'Port', stepProfile: 'Profile', stepStore: 'Snapshot store',
      instance: 'Instance', port: 'Port', profile: 'Profile', store: 'Snapshot store',
      shared: 'Shared store', scoped: 'Per-profile store', customStore: 'Custom store',
      unknownProfile: 'Unknown profile', online: 'Online', offline: 'Offline', apiOld: 'Legacy API', current: 'Current',
      snapUnit: 'snapshots', files: 'files', profileFiles: 'config files', pluginFiles: 'plugin files',
      recent: 'Latest', home: 'Home', settingsFile: 'Settings file', instancesFile: 'Instances file',
      apiOldHint: 'The port is online but the plugin is missing or older, so reads fall back to files.',
      statusOnlineHint: 'The target DSH port answers.', statusOfflineHint: 'The target DSH port is unreachable; data is read from home.',
      undoClick: 'Undo the latest change?', redoClick: 'Redo the latest undo?',
      removeConfirm: 'Delete this snapshot? This cannot be undone.',
      restoreConfirm: 'Restore to this snapshot? Current state is saved as an undo point first.',
      bulkConfirm: 'Delete the selected snapshots? This cannot be undone.',
      pruneClick: 'Prune auto snapshots beyond the retention limit? Manual snapshots are kept.',
      safemodeClick: 'Enter safe mode: disables every user plugin except this one. Restart DSH before exiting.',
      safemodeOffClick: 'Exit safe mode and restore the previous plugins and bundles?',
      onlineWarn: 'The target DSH is running; offline writes can race with its live state. Operating inside the host is safer. Continue?',
      desktopWarn: 'Safe mode on the desktop profile edits profile config; it writes only after you confirm.',
      homeMismatch: 'Port/home mismatch',
      homeMismatchHint: 'The configured home differs from the home probed on this port; make sure you are reading the intended store.',
      probedHome: 'Probed home',
      untrustedProfileHint: 'This snapshot profile field is not trustworthy (legacy manifest), so it is treated as unknown.',
      lastGood: 'Last known-good snapshot', restoreGood: 'Restore to here',
      autoSafeModeNote: 'Safe mode was entered automatically (repeated unfinished boots)',
      crashBanner: 'The previous DSH start did not finish (likely crashed).',
      searchPlaceholder: 'Search id / reason / location / profile', filterAll: 'All kinds',
      kindManual: 'Manual', kindAuto: 'Auto', kindPre: 'Pre-undo', kindBaseline: 'Baseline',
      showSharedAll: 'Show every shared-store snapshot',
      showSharedHint: 'Off: current profile plus unknown only. On: everything.',
      selected: 'selected', deleteSelected: 'Delete selected', clearSelection: 'Clear selection', selectOne: 'Select this snapshot',
      showing: 'Showing', today: 'Today', yesterday: 'Yesterday',
      stepAuto: 'auto', preState: 'undo point', redacted: 'redacted', truncated: 'truncated', needsRestart: 'restart needed',
      note: 'Note', tags: 'Tags', editNote: 'Edit note/tags',
      notePlaceholder: 'Note (optional)', tagsPlaceholder: 'Tags, comma-separated (optional)',
      noteSaved: 'Note saved', noteFailed: 'Save failed', noNote: 'No note',
      makeSnapTitle: 'Create snapshot', reasonPlaceholder: 'Reason (optional)', makeSnapConfirm: 'Create', snapshotDone: 'Snapshot created',
      diffEmpty: 'No differences', diffEmptyHint: 'The snapshot matches the current state.',
      diffLoading: 'Loading comparison…', diffLoadingHint: 'Reading differences between the snapshot and current files.',
      diffError: 'Failed to load comparison', diffErrorHint: 'Retry in a moment, or refresh the snapshot list first.',
      diffFileEmpty: 'No line-level differences in this file',
      groupConfig: 'Config', groupPlugins: 'Plugins', groupProfiles: 'Profile code', diffFilesCount: 'files',
      settingsTitle: 'Settings', secInstances: 'Instances', secPolicy: 'Snapshot policy', secGuard: 'Safety and checks',
      instTitle: 'Instance management', instAdd: 'Add instance', instEdit: 'Edit instance',
      instName: 'Name', instPort: 'Port', instHome: 'Home path',
      instHomeHint: 'Instance home directory; the store and settings are read from it.',
      instSave: 'Save instance', instUpdate: 'Save changes', instRemove: 'Remove',
      instNone: 'No instances configured', instNoneHint: 'Add one manually, or use Scan this machine to find running DSH ports.',
      instCurrent: 'Current instance', instProfiles: 'Profiles', instTotal: 'Snapshots', apiLabel: 'API',
      instScan: 'Scan this machine', instScanning: 'Scanning…',
      instScanEmpty: 'No DSH ports found', instScanEmptyHint: 'Make sure DSH is running and retry, or add an instance manually.',
      instScanError: 'Scan failed', instScanReady: 'Scan finished',
      instScanHint: 'Scan only suggests ports; nothing is written until you add an instance.',
      instScanNotReady: 'This server build does not expose the scan API yet.',
      instAddTo: 'Add instance', instAdded: 'Instance added', instAlready: 'Already added',
      instSaved: 'Instance saved', instDeleted: 'Instance removed', instDeleteConfirm: 'Remove instance',
      instBadName: 'Names allow letters, digits, dot, underscore and hyphen, 1-64 chars.',
      instBadHome: 'Home path is required.', instBadPort: 'Port must be an integer from 1 to 65535, or empty.',
      instSuggest: 'Suggestions', process: 'Process', probesProfile: 'Probed profile', scanDuration: 'took',
      setAuto: 'Auto-save', setDebounce: 'Debounce (ms)', setKeep: 'Auto snapshots kept', setKeepPre: 'Pre-restore kept',
      setCleanup: 'Auto-cleanup', setManualDir: 'Manual snapshot dir', setAutoDir: 'Auto snapshot dir',
      setSensitive: 'Sensitive mode', setSensitiveRedact: 'Redact (default)', setSensitiveKeep: 'Plaintext (legacy)',
      setPluginDirs: 'Plugin dirs whitelist (comma-separated, empty = auto)',
      setWorkspaceDirs: 'Tracked workspace dirs (comma/semicolon, empty = current dir only)',
      setDesktop: 'Create desktop shortcut', setDesktopInfo: 'Desktop dir',
      setSchedule: 'Scheduled snapshots', setScheduleEnabled: 'Enable scheduled snapshots', setScheduleMs: 'Interval (min, ≥1)',
      setBootHealth: 'Startup health check', setUpgradeGuard: 'DSH upgrade guard',
      setGuardMode: 'When the guard finds boot blockers', setGuardAsk: 'Ask (auto safe mode after 10s)',
      setGuardOn: 'Enter safe mode automatically', setGuardOff: 'Warn only',
      setGuardShortcut: 'Create the "DSH guarded launch" desktop shortcut',
      setAutoHeal: 'Auto safe mode after N failed boots',
      saved: 'Settings saved', saveFailed: 'Save failed',
      doctorTitle: 'Diagnostic report', doctorOk: 'healthy', doctorWarn: 'warning', doctorErr: 'error',
      doctorHealthy: 'All healthy', doctorUnhealthy: 'Issues found; consider fixing them.', doctorHead: 'checks',
      doctorFix: 'Repair fixable', doctorFixable: 'fixable', doctorFixed: 'fixed', doctorFailed: 'failed',
      doctorSnapshot: 'pre-fix snapshot',
      exportPass: 'Export password (optional, encrypts)', importPass: 'Import password', encrypted: 'encrypted',
      needPass: 'This export is encrypted; password required', exportDone: 'Export finished', importDone: 'Import finished',
      msgTitle: 'Message-level undo', msgEmpty: 'No message batches to undo', msgUndo: 'Undo',
      msgUndoClick: 'Undo the file changes of this message batch?', msgUndone: 'undone',
      instanceSwitched: 'Switched instance', profileSwitched: 'Switched profile', switchFailed: 'Switch failed',
      pickFileCanceled: 'File selection canceled', pruneDone: 'Prune finished', undoDone: 'Undone', redoDone: 'Redone',
      restoreDone: 'Restored', removeDone: 'Deleted',
      confirmTitle: 'Confirm', details: 'details'
    },
  };

  let LANG = 'zh';
  let dictNow = dict.zh;
  const t = (key) => {
    const v = dictNow[key];
    return typeof v === 'string' && v !== '' ? v : (dict.en[key] ?? key);
  };

  function setLang(lang, opts) {
    const options = opts || {};
    LANG = lang === 'en' ? 'en' : 'zh';
    dictNow = dict[LANG];
    document.documentElement.lang = LANG;
    applyStaticI18n();
    syncSafemodeLabel();
    syncSelectionUi();
    if (options.render !== false) { closePanel(); refresh(); }
  }

  function applyStaticI18n() {
    document.title = t('appTitle');
    $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-title]').forEach((el) => {
      const v = t(el.dataset.i18nTitle);
      el.title = v;
      if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', v);
    });
    $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    const langBtn = $('#btn-lang');
    if (langBtn) { langBtn.title = `${t('language')}: ${LANG === 'zh' ? '中文' : 'English'}`; langBtn.setAttribute('aria-label', langBtn.title); }
    renderThemeBtn();
  }

  // ── 主题（与 index.html 头部解析器共用 key 与判定） ───────────────────────
  const THEME_KEY = 'dsh-undo-theme';
  const THEME_STATES = ['auto', 'light', 'dark'];
  const mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let themePref = 'auto';

  function readThemePref() {
    try { const v = localStorage.getItem(THEME_KEY); return THEME_STATES.includes(v) ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function resolveTheme(pref) {
    if (pref === 'dark') return 'dark';
    if (pref === 'light') return 'light';
    return mqDark && mqDark.matches ? 'dark' : 'light';
  }
  function applyTheme(pref, persist) {
    themePref = THEME_STATES.includes(pref) ? pref : 'auto';
    const resolved = resolveTheme(themePref);
    const rootEl = document.documentElement;
    rootEl.setAttribute('data-theme-pref', themePref);
    rootEl.setAttribute('data-theme', resolved);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#141518' : '#2f8f83');
    if (persist) { try { localStorage.setItem(THEME_KEY, themePref); } catch (e) { /* 隐私模式不可写，忽略 */ } }
    renderThemeBtn();
  }
  function renderThemeBtn() {
    const btn = $('#btn-theme');
    if (!btn) return;
    const icon = { auto: '🌗', light: '☀️', dark: '🌙' }[themePref] ?? '🌗';
    const name = { auto: t('themeAuto'), light: t('themeLight'), dark: t('themeDark') }[themePref] ?? '';
    btn.textContent = icon;
    btn.title = `${t('theme')}: ${name}`;
    btn.setAttribute('aria-label', btn.title);
  }
  function cycleTheme() {
    applyTheme(THEME_STATES[(THEME_STATES.indexOf(themePref) + 1) % THEME_STATES.length], true);
  }
  if (mqDark) {
    const onSystemTheme = () => { if (themePref === 'auto') applyTheme('auto', false); };
    if (mqDark.addEventListener) mqDark.addEventListener('change', onSystemTheme);
    else if (mqDark.addListener) mqDark.addListener(onSystemTheme);
  }

  // ── API ─────────────────────────────────────────────────────────────────
  const api = async (path, opts) => {
    const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = j && j.error;
      const message = typeof err === 'string' ? err : (err && typeof err.message === 'string' ? err.message : `HTTP ${r.status}`);
      throw new Error(message);
    }
    return j;
  };
  const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const get = (p) => api(p, { method: 'GET' });

  // ── 基础格式化 ──────────────────────────────────────────────────────────
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (iso) => {
    const d = new Date(iso ?? '');
    if (Number.isNaN(d.getTime())) return String(iso ?? '').replace('T', ' ').slice(0, 19);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };
  const localDayKey = (v) => {
    const d = v instanceof Date ? v : new Date(v ?? '');
    if (Number.isNaN(d.getTime())) return String(v ?? '').slice(0, 10);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '?';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
  }
  function shortPath(p) {
    const s = String(p ?? '');
    if (s.length <= 72) return s;
    return `…${s.slice(-68)}`;
  }
  const countText = (n) => `${n} ${t('snapUnit')}`;

  // ── 全局状态 ────────────────────────────────────────────────────────────
  const state = {
    seq: 0,
    loading: true,
    err: null,
    localLoadedAt: 0,
    status: null,
    info: null,
    snaps: [],
    counts: { web: 0, desktop: 0, unknown: 0 },
    profile: 'web',
    profileNames: ['web', 'desktop'],
    currentName: null,
    currentInstance: null,
    home: '',
    settingsFile: '',
    instancesFile: '',
    storeRoot: '',
    storeScope: null,
    shared: false,
    port: null,
    serverPort: null,
    reachable: null,
    hasApi: null,
    homeMismatch: false,
    probedHome: '',
    query: '',
    kind: 'all',
    showSharedAll: false,
    selected: new Set(),
  };

  // ── Toast / Overlay / 确认 ─────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `toast ${kind ?? ''}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function openPanel(html, cls) {
    const overlay = $('#overlay');
    const panel = $('#panel');
    panel.className = `panel${cls ? ' ' + cls : ''}`;
    panel.innerHTML = html;
    overlay.classList.remove('hidden');
    panel.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));
  }
  function closePanel() {
    const overlay = $('#overlay');
    const panel = $('#panel');
    if (overlay) overlay.classList.add('hidden');
    if (panel) { panel.className = 'panel'; panel.innerHTML = ''; }
  }
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closePanel(); });

  function onlineRaceNote() {
    if (state.currentInstance && state.currentInstance.reachable === true) {
      return `<div class="note note-warn"><span aria-hidden="true">⚠</span> ${esc(t('onlineWarn'))}</div>`;
    }
    return '';
  }
  function desktopRaceNote() {
    if (state.profile === 'desktop') {
      return `<div class="note note-warn"><span aria-hidden="true">⚠</span> ${esc(t('desktopWarn'))}</div>`;
    }
    return '';
  }

  function confirmBox(opts) {
    const extra = `${opts.online ? onlineRaceNote() : ''}${opts.desktop ? desktopRaceNote() : ''}`;
    openPanel(`
      <div class="panel-head"><h3>${esc(opts.title ?? t('confirmTitle'))}</h3><button type="button" class="close-x" data-close aria-label="${esc(t('close'))}">×</button></div>
      <div class="panel-body">
        <div class="confirm-msg">${opts.message ?? ''}</div>
        ${extra}
      </div>
      <div class="panel-foot">
        <button type="button" class="btn" data-close>${esc(opts.cancel ?? t('cancel'))}</button>
        <button type="button" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" id="confirm-yes">${esc(opts.yes ?? t('confirm'))}</button>
      </div>`);
    $('#confirm-yes').addEventListener('click', async () => {
      closePanel();
      try { await opts.onYes(); } catch (e) { toast(e.message, 'err'); }
    });
  }

  // ── 状态归一化（新字段缺失时全部回落到旧形状） ───────────────────────────
  function normalizeCounts(raw) {
    const out = { web: 0, desktop: 0, unknown: 0 };
    for (const s of state.snaps) {
      if (s && (s.profile === 'web' || s.profile === 'desktop')) out[s.profile] += 1;
      else out.unknown += 1;
    }
    if (raw && typeof raw === 'object') {
      for (const k of ['web', 'desktop', 'unknown']) {
        if (Number.isFinite(raw[k])) out[k] = raw[k];
      }
    }
    return out;
  }

  function profileNamesFrom(status, cur, info) {
    let names = [];
    if (Array.isArray(status?.profilesInfo)) names = status.profilesInfo.map((p) => (p && typeof p.name === 'string' ? p.name : '')).filter(Boolean);
    if (!names.length && Array.isArray(info?.profiles)) names = info.profiles.filter((p) => typeof p === 'string' && p !== '');
    if (!names.length && cur && Array.isArray(cur.profiles)) names = cur.profiles.filter((p) => typeof p === 'string' && p !== '');
    if (!names.length) names = ['web', 'desktop'];
    if (state.profile && !names.includes(state.profile)) names = [state.profile, ...names];
    return Array.from(new Set(names));
  }

  function applyStatus(status, info) {
    const eff = (info && info.effective) || {};
    const list = info && Array.isArray(info.instances) ? info.instances : [];
    const curName = (info && typeof info.current === 'string' && info.current) || eff.name || status?.instanceName || null;
    const cur = list.find((x) => x && x.name === curName) || list[0] || null;
    state.status = status ?? null;
    state.info = info ?? null;
    state.currentName = curName;
    state.currentInstance = cur ?? null;
    state.port = cur ? (cur.port ?? null) : (eff.port ?? status?.instancePort ?? null);
    state.serverPort = status?.port ?? info?.port ?? null;
    state.profile = status?.profileName ?? status?.profile ?? info?.currentProfile ?? eff.profile ?? cur?.currentProfile ?? state.profile ?? 'web';
    state.profileNames = profileNamesFrom(status, cur, info);
    state.home = status?.homeDir ?? info?.homeDir ?? eff.home ?? cur?.home ?? '';
    state.settingsFile = status?.settingsFile ?? info?.settingsFile ?? eff.settingsFile ?? '';
    state.instancesFile = status?.instancesFile ?? info?.settingsFile ?? '';
    state.storeRoot = status?.storeRoot ?? status?.profileDetail?.storeRoot ?? '';
    state.storeScope = status?.storeScope ?? status?.profileDetail?.storeScope ?? null;
    state.shared = Boolean(status?.sharedStore ?? status?.profileDetail?.sharedStore ?? state.storeScope === 'flat');
    state.reachable = cur && typeof cur.reachable === 'boolean' ? cur.reachable : null;
    state.hasApi = cur && typeof cur.hasApi === 'boolean' ? cur.hasApi : null;
    state.homeMismatch = cur?.homeMismatch === true;
    state.probedHome = typeof cur?.probedHome === 'string' ? cur.probedHome : '';
  }

  async function refresh() {
    const seq = ++state.seq;
    state.loading = true;
    state.err = null;
    renderStatus();
    renderTimeline();

    let status = null;
    try {
      status = await get('/api/undo/status');
    } catch (e) {
      if (seq !== state.seq) return;
      state.loading = false;
      state.err = e;
      renderFlow();
      renderStatus();
      renderTimeline();
      return;
    }
    if (seq !== state.seq) return;

    let info = null;
    try { info = await get('/api/undo/instances'); } catch (e) { info = null; }
    if (seq !== state.seq) return;
    applyStatus(status, info);

    let listRes = null;
    try {
      const qs = state.profile ? `?profile=${encodeURIComponent(state.profile)}` : '';
      listRes = await get(`/api/undo/list${qs}`);
    } catch (e) {
      if (seq !== state.seq) return;
      state.loading = false;
      state.err = e;
      renderFlow();
      renderStatus();
      renderTimeline();
      return;
    }
    if (seq !== state.seq) return;

    state.snaps = Array.isArray(listRes?.snapshots) ? listRes.snapshots : [];
    state.counts = normalizeCounts(listRes?.countByProfile);
    if (listRes?.store && typeof listRes.store === 'object') {
      if (typeof listRes.store.root === 'string') state.storeRoot = listRes.store.root;
      if (typeof listRes.store.scope === 'string') state.storeScope = listRes.store.scope;
      state.shared = listRes.store.shared === true;
    }
    const alive = new Set(state.snaps.map((s) => s.id));
    state.selected = new Set(Array.from(state.selected).filter((id) => alive.has(id)));
    state.loading = false;
    state.err = null;
    state.localLoadedAt = Date.now();
    renderFlow();
    renderStatus();
    renderTimeline();
    syncSelectionUi();
  }

  // ── 流程条：① 端口 → ② Profile → ③ 快照库 ──────────────────────────────
  function renderFlow() {
    renderInstances();
    renderProfileSeg();
    const badge = $('#store-badge');
    if (badge) {
      badge.classList.remove('hidden', 'badge-shared', 'badge-scoped');
      if (state.shared) { badge.classList.add('badge-shared'); badge.textContent = t('shared'); badge.title = state.storeRoot || ''; }
      else if (state.storeScope === 'scoped') { badge.classList.add('badge-scoped'); badge.textContent = t('scoped'); badge.title = state.storeRoot || ''; }
      else if (state.storeScope === 'custom') { badge.classList.add('badge-scoped'); badge.textContent = t('customStore'); badge.title = state.storeRoot || ''; }
      else { badge.classList.add('hidden'); }
    }
    const counted = $('#store-count');
    if (counted) {
      counted.innerHTML = `<span class="count-chip">web ${state.counts.web}</span>` +
        `<span class="count-chip">desktop ${state.counts.desktop}</span>` +
        `<span class="count-chip">${esc(t('unknownProfile'))} ${state.counts.unknown}</span>`;
    }
    setPath('#flow-home', state.home);
    setPath('#flow-settings', state.settingsFile);
  }
  function setPath(sel, value) {
    const el = $(sel);
    if (!el) return;
    el.textContent = value ? shortPath(value) : '—';
    el.title = value || '';
  }

  // W62 断言依赖的三句字面量不要改：box 始终可见，空列表只隐藏下拉。
  function renderInstances() {
    const box = $('#inst-box');
    const sel = $('#sel-instance');
    if (!box || !sel) return;
    const info = state.info;
    const list = info && Array.isArray(info.instances) ? info.instances : [];
    box.classList.remove('hidden');
    const curName = state.currentName;
    const cur = state.currentInstance;
    const staticEl = $('#inst-static');
    if (staticEl) {
      const nameText = (cur && cur.name) || curName || t('instance');
      const portText = state.port ? ` · :${state.port}` : '';
      staticEl.textContent = `${nameText}${portText}`;
      staticEl.title = (cur && cur.home) || state.home || '';
    }
    const apiBadge = $('#inst-api-badge');
    if (apiBadge) {
      const legacy = state.reachable === true && state.hasApi === false;
      apiBadge.classList.toggle('hidden', !legacy);
      apiBadge.title = legacy ? t('apiOldHint') : '';
      apiBadge.textContent = t('apiOld');
    }
    if (staticEl) staticEl.classList.remove('hidden');
    if (list.length === 0) { sel.classList.add('hidden'); return; }
    sel.classList.remove('hidden');
    if (staticEl) staticEl.classList.add('hidden');
    const options = list.map((x) => {
      const dot = typeof x.reachable === 'boolean' ? (x.reachable ? '●' : '○') : '·';
      const portPart = x.port ? ` · :${x.port}` : '';
      const legacyPart = x.reachable === true && x.hasApi === false ? ` · ${t('apiOld')}` : '';
      return `<option value="${esc(x.name)}"${x.name === curName ? ' selected' : ''}>${dot} ${esc(x.name)}${portPart}${legacyPart}</option>`;
    }).join('');
    sel.innerHTML = `${options}<option value="__settings">⚙ ${esc(t('instTitle'))}</option>`;
  }

  function renderProfileSeg() {
    const seg = $('#profile-seg');
    if (!seg) return;
    seg.innerHTML = state.profileNames.map((name) => {
      const on = name === state.profile;
      return `<button type="button" class="seg-btn${on ? ' is-on' : ''}" data-profile="${esc(name)}" aria-pressed="${on ? 'true' : 'false'}">${esc(name)}</button>`;
    }).join('');
  }

  // ── 状态条：在线 / 离线 / 旧版接口 / 共享库 ──────────────────────────────
  function badgeHtml(kind, text, title) {
    return `<span class="badge badge-${kind} badge-dot"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
  }
  function renderStatus() {
    const badges = $('#status-badges');
    const meta = $('#status-meta');
    const list = [];
    if (state.reachable === true) list.push(badgeHtml('online', t('online'), t('statusOnlineHint')));
    else if (state.reachable === false) list.push(badgeHtml('offline', t('offline'), t('statusOfflineHint')));
    if (state.reachable === true && state.hasApi === false) list.push(badgeHtml('legacy', t('apiOld'), t('apiOldHint')));
    if (state.homeMismatch) list.push(badgeHtml('warn', t('homeMismatch'), `${t('homeMismatchHint')} ${t('probedHome')}: ${state.probedHome || '—'}`));
    if (state.shared) list.push(badgeHtml('shared', t('shared'), state.storeRoot));
    else if (state.storeScope === 'scoped') list.push(badgeHtml('scoped', t('scoped'), state.storeRoot));
    if (badges) badges.innerHTML = list.join('');

    if (meta) {
      if (state.err) {
        meta.textContent = t('errorHint');
        meta.title = String(state.err.message || state.err);
      } else if (state.localLoadedAt) {
        const bytes = state.snaps.reduce((n, s) => n + (Number.isFinite(s.totalBytes) ? s.totalBytes : 0), 0);
        const latest = state.snaps[0]?.time;
        const bits = [countText(state.snaps.length)];
        if (bytes > 0) bits.push(fmtBytes(bytes));
        if (latest) bits.push(`${t('recent')} ${fmtTime(latest)}`);
        meta.textContent = bits.join(' · ');
        meta.title = [state.home, state.settingsFile].filter(Boolean).join('\n');
      } else if (state.loading) {
        meta.textContent = t('loadingHint');
      } else {
        meta.textContent = '';
      }
    }

    const undo = $('#btn-undo');
    const redo = $('#btn-redo');
    if (undo) undo.disabled = !state.status?.canUndo;
    if (redo) redo.disabled = !state.status?.canRedo;
    const snap = $('#btn-snapshot');
    if (snap) snap.disabled = false;
    syncSafemodeLabel();
    syncSelectionUi();
    renderCrashBanner();
  }

  function syncSafemodeLabel() {
    const btn = $('#btn-safemode');
    if (!btn) return;
    const label = $('#safemode-label');
    const active = state.status?.safeModeActive === true;
    if (label) label.textContent = active ? t('safemodeOff') : t('safemode');
    btn.classList.toggle('is-on', active);
    btn.title = active ? t('safemodeOffClick') : t('safemodeClick');
  }

  function syncSelectionUi() {
    const n = state.selected.size;
    const cnt = $('#sel-count');
    const del = $('#btn-bulk-del');
    const clear = $('#btn-clear-sel');
    if (cnt) cnt.textContent = `${n} ${t('selected')}`;
    for (const el of [cnt, del, clear]) if (el) el.classList.toggle('hidden', n === 0 || state.loading === true);
  }

  // ── 三态骨架（图标 + 一句话 + 主操作） ──────────────────────────────────
  function stateBox(kind, opts) {
    const options = opts || {};
    const icon = { loading: '⏳', error: '⚠', empty: '🗂' }[kind] || '•';
    const title = options.title ?? (kind === 'loading' ? t('loading') : kind === 'error' ? t('errorTitle') : t('empty'));
    const sub = options.sub ?? (kind === 'loading' ? t('loadingHint') : kind === 'error' ? t('errorHint') : t('emptyHint'));
    const action = options.action
      ? `<button type="button" class="btn ${options.primary ? 'btn-primary' : ''}" data-act="${esc(options.action)}">${esc(options.actionLabel ?? t('retry'))}</button>`
      : '';
    return `<div class="state state-${esc(kind)}" role="status">
      <div class="state-icon" aria-hidden="true">${icon}</div>
      <h3 class="state-title">${esc(title)}</h3>
      <p class="state-sub">${esc(sub)}</p>
      ${action}
    </div>`;
  }

  // ── 时间线 ──────────────────────────────────────────────────────────────
  function kindLabel(kind) {
    const map = { manual: t('kindManual'), auto: t('kindAuto'), 'pre-restore': t('kindPre'), baseline: t('kindBaseline') };
    return map[kind] || String(kind ?? '');
  }
  function profileMatchOf(s) {
    if (s.profileMatch === null) return true;
    if (typeof s.profileMatch === 'boolean') return s.profileMatch;
    if (s.profile == null) return true;
    return s.profile === state.profile;
  }
  function matchesQuery(s) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    const hay = [s.id, s.kind, s.location, s.reason, s.profile, s.note, ...(Array.isArray(s.tags) ? s.tags : [])]
      .filter((x) => x != null).join(' ').toLowerCase();
    return hay.includes(q);
  }
  function filteredSnaps() {
    return state.snaps.filter((s) => {
      if (!state.showSharedAll && !profileMatchOf(s)) return false;
      if (state.kind !== 'all' && s.kind !== state.kind) return false;
      return matchesQuery(s);
    }).sort((a, b) => new Date(b.time ?? 0) - new Date(a.time ?? 0));
  }

  function renderTimeline() {
    const wrap = $('#timeline');
    if (!wrap) return;
    if (state.loading) {
      wrap.innerHTML = stateBox('loading');
      setListCount(0, 0);
      return;
    }
    if (state.err) {
      wrap.innerHTML = stateBox('error', { action: 'retry', actionLabel: t('retry') });
      setListCount(0, 0);
      return;
    }
    if (!state.snaps.length) {
      wrap.innerHTML = stateBox('empty', { action: 'snapshot', actionLabel: t('snapshot'), primary: true });
      setListCount(0, 0);
      return;
    }
    const shown = filteredSnaps();
    setListCount(shown.length, state.snaps.length);
    if (!shown.length) {
      wrap.innerHTML = stateBox('empty', { title: t('noMatch'), sub: t('noMatchHint'), action: 'clearFilters', actionLabel: t('clearFilters') });
      return;
    }
    const todayKey = localDayKey(new Date());
    const yesterdayKey = localDayKey(new Date(Date.now() - 86400000));
    const groups = new Map();
    for (const s of shown) {
      const day = localDayKey(s.time);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(s);
    }
    const html = [];
    for (const [day, items] of groups) {
      const label = day === todayKey ? `📅 ${t('today')}` : day === yesterdayKey ? `📅 ${t('yesterday')}` : `📅 ${day}`;
      html.push(`<div class="day-head"><span>${esc(label)}</span><span class="day-count">${items.length}</span></div>`);
      for (const s of items) html.push(snapCard(s));
    }
    wrap.innerHTML = html.join('');
  }

  function setListCount(shown, total) {
    const el = $('#list-count');
    if (!el) return;
    el.textContent = total ? `${t('showing')} ${shown} / ${total}` : '';
  }

  function snapCard(s) {
    const kind = s.kind ?? 'auto';
    const untrusted = s.profileMatch === null;
    const profile = untrusted ? null : (s.profile ?? null);
    const profileCls = profile === 'web' ? 'is-web' : profile === 'desktop' ? 'is-desktop' : 'is-unknown';
    const fileCount = Array.isArray(s.files) ? s.files.length : 0;
    const pluginCount = (s.plugins ?? []).reduce((n, p) => n + ((p.files ?? []).length), 0)
      + (s.profileFiles ?? []).filter((f) => f && f.hash).length;
    const chips = [];
    if (s.redacted?.length) chips.push(`<span class="chip chip-warn">${t('redacted')}</span>`);
    if (s.stepped) chips.push(`<span class="chip">${t('stepAuto')}</span>`);
    if (s.consumed) chips.push(`<span class="chip">${t('preState')}</span>`);
    if (s.truncated) chips.push(`<span class="chip chip-warn">${t('truncated')}</span>`);
    const tags = (Array.isArray(s.tags) ? s.tags : []).map((x) => `<span class="chip chip-accent">#${esc(x)}</span>`).join('');
    const note = s.note ? `<div class="snap-note">📝 ${esc(s.note)}</div>` : '';
    const checked = state.selected.has(s.id);
    const meta = [`<span>${fileCount} ${t('files')}</span>`];
    if (pluginCount) meta.push(`<span>${pluginCount} ${t('pluginFiles')}</span>`);
    if (Number.isFinite(s.totalBytes)) meta.push(`<span>${fmtBytes(s.totalBytes)}</span>`);
    if (s.location) meta.push(`<span>${esc(s.location)}</span>`);
    return `<article class="snap${checked ? ' is-selected' : ''}" data-id="${esc(s.id)}">
      <label class="snap-check" title="${esc(t('selectOne'))}">
        <input type="checkbox" data-check="${esc(s.id)}"${checked ? ' checked' : ''} aria-label="${esc(t('selectOne'))}">
      </label>
      <div class="snap-main">
        <div class="snap-top">
          <span class="badge badge-profile ${profileCls}"${untrusted ? ` title="${esc(t('untrustedProfileHint'))}"` : s.profileMatch === false ? ` title="${esc(t('showSharedHint'))}"` : ''}>${esc(profile || t('unknownProfile'))}</span>
          <span class="snap-kind">${esc(kindLabel(kind))}</span>
          <span class="snap-id">${esc(s.id)}</span>
          <span class="snap-time">${esc(fmtTime(s.time))}</span>
          ${chips.join('')}
        </div>
        <div class="snap-reason">${esc(s.reason || '—')}</div>
        <div class="snap-meta">${meta.join('')}</div>
        ${tags ? `<div class="snap-tags">${tags}</div>` : ''}
        ${note}
      </div>
      <div class="snap-actions">
        <button type="button" class="btn btn-sm" data-act="diff">${esc(t('diff'))}</button>
        <button type="button" class="btn btn-sm" data-act="restore">${esc(t('restore'))}</button>
        <button type="button" class="btn btn-sm btn-ghost" data-act="note">${esc(t('editNote'))}</button>
        <button type="button" class="btn btn-sm btn-danger" data-act="del">${esc(t('del'))}</button>
      </div>
    </article>`;
  }

  // ── 时间线交互 ──────────────────────────────────────────────────────────
  $('#timeline').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'retry') { refresh(); return; }
    if (act === 'snapshot') { openSnapshot(); return; }
    if (act === 'clearFilters') { clearFilters(); return; }
    const card = btn.closest('[data-id]');
    if (!card) return;
    const id = card.dataset.id;
    const snap = state.snaps.find((s) => s.id === id);
    if (!snap) return;
    if (act === 'diff') showDiff(id);
    else if (act === 'restore') restoreById(id);
    else if (act === 'note') openNoteEditor(snap);
    else if (act === 'del') removeById(snap);
  });
  $('#timeline').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-check]');
    if (!cb) return;
    if (cb.checked) state.selected.add(cb.dataset.check);
    else state.selected.delete(cb.dataset.check);
    const card = cb.closest('.snap');
    if (card) card.classList.toggle('is-selected', cb.checked);
    syncSelectionUi();
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    const value = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = value; renderTimeline(); }, 120);
  });
  $('#kind-filter').addEventListener('change', (e) => { state.kind = e.target.value; renderTimeline(); });
  $('#show-shared').addEventListener('change', (e) => { state.showSharedAll = e.target.checked; renderTimeline(); });
  $('#btn-bulk-del').addEventListener('click', removeSelected);
  $('#btn-clear-sel').addEventListener('click', () => {
    state.selected.clear();
    $$('#timeline [data-check]').forEach((cb) => { cb.checked = false; });
    $$('#timeline .snap').forEach((card) => card.classList.remove('is-selected'));
    syncSelectionUi();
  });

  function clearFilters() {
    state.query = '';
    state.kind = 'all';
    state.showSharedAll = false;
    $('#search').value = '';
    $('#kind-filter').value = 'all';
    $('#show-shared').checked = false;
    renderTimeline();
  }

  // ── 流程条交互：实例 / Profile ──────────────────────────────────────────
  $('#sel-instance').addEventListener('change', async (e) => {
    const value = e.target.value;
    if (value === '__settings') { e.target.value = state.currentName ?? ''; openSettings(); return; }
    if (!value) return;
    try {
      let r = await post('/api/undo/instances', { switch: { instance: value } }).catch(() => null);
      if (!r || !r.effective) r = await post('/api/undo/instances', { instance: value });
      toast(`${t('instanceSwitched')}: ${value}`, 'ok');
      await refresh();
    } catch (err) {
      toast(`${t('switchFailed')}: ${err.message}`, 'err');
      renderInstances();
    }
  });

  $('#profile-seg').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-profile]');
    if (!btn) return;
    const next = btn.dataset.profile;
    if (!next || next === state.profile) return;
    try {
      let r = await post('/api/undo/instances', { switch: { profile: next } }).catch(() => null);
      if (!r || !(r.effective || r.profile === next)) r = await post('/api/undo/instances', { profile: next });
      toast(`${t('profileSwitched')}: ${next}`, 'ok');
      await refresh();
    } catch (err) {
      toast(`${t('switchFailed')}: ${err.message}`, 'err');
    }
  });

  // ── 动作 ───────────────────────────────────────────────────────────────
  async function restoreById(id) {
    confirmBox({
      message: `${t('restoreConfirm')}<br><strong class="mono">${esc(id)}</strong>`,
      online: true,
      yes: t('restore'),
      onYes: async () => {
        await post('/api/undo/restore', { snapshot_id: id });
        toast(`${t('restoreDone')} ✓ ${id}`, 'ok');
        await refresh();
      },
    });
  }
  async function removeById(s) {
    confirmBox({
      message: `${t('removeConfirm')}<br><strong class="mono">${esc(s.id)}</strong>`,
      danger: true,
      online: true,
      onYes: async () => {
        await post('/api/undo/remove', { id: s.id });
        state.selected.delete(s.id);
        toast(`${t('removeDone')} ✓`, 'ok');
        await refresh();
      },
    });
  }
  async function removeSelected() {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    confirmBox({
      message: `${t('bulkConfirm')}<br><strong>${countText(ids.length)}</strong>`,
      danger: true,
      online: true,
      yes: t('deleteSelected'),
      onYes: async () => {
        let ok = 0;
        let failed = 0;
        for (const id of ids) {
          try { await post('/api/undo/remove', { id }); ok += 1; } catch (e) { failed += 1; }
        }
        state.selected.clear();
        toast(`${t('removeDone')} ${ok}${failed ? ` · ${t('doctorFailed')} ${failed}` : ''}`, failed ? 'err' : 'ok');
        await refresh();
      },
    });
  }

  function openSnapshot() {
    openPanel(`
      <div class="panel-head"><h3>${esc(t('makeSnapTitle'))}</h3><button type="button" class="close-x" data-close aria-label="${esc(t('close'))}">×</button></div>
      <div class="panel-body">
        <div class="field"><span>${esc(t('note'))}</span><input type="text" id="snap-reason" placeholder="${esc(t('reasonPlaceholder'))}"></div>
      </div>
      <div class="panel-foot">
        <button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
        <button type="button" class="btn btn-primary" id="snap-go">${esc(t('makeSnapConfirm'))}</button>
      </div>`);
    const go = async () => {
      const reason = ($('#snap-reason').value || '').trim();
      try {
        const r = await post('/api/undo/snapshot', { reason });
        toast(`${t('snapshotDone')} ✓ ${r.id}`, 'ok');
        closePanel();
        await refresh();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#snap-go').addEventListener('click', go);
    $('#snap-reason').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  function openNoteEditor(s) {
    openPanel(`
      <div class="panel-head"><h3>${esc(t('editNote'))} · <span class="mono">${esc(s.id)}</span></h3><button type="button" class="close-x" data-close aria-label="${esc(t('close'))}">×</button></div>
      <div class="panel-body">
        <div class="field"><span>${esc(t('note'))}</span><input type="text" id="note-text" value="${esc(s.note ?? '')}" placeholder="${esc(t('notePlaceholder'))}"></div>
        <div class="field"><span>${esc(t('tags'))}</span><input type="text" id="note-tags" value="${esc((s.tags ?? []).join(', '))}" placeholder="${esc(t('tagsPlaceholder'))}"></div>
      </div>
      <div class="panel-foot">
        <button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
        <button type="button" class="btn btn-primary" id="note-save">${esc(t('save'))}</button>
      </div>`);
    $('#note-save').addEventListener('click', async () => {
      try {
        await post('/api/undo/note', {
          id: s.id,
          note: $('#note-text').value,
          tags: $('#note-tags').value.split(',').map((x) => x.trim()).filter(Boolean),
        });
        toast(`${t('noteSaved')} ✓`, 'ok');
        closePanel();
        await refresh();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  // ── 对比浮层 v2：配置 / 插件 / Profile 代码 三组 ────────────────────────
  function normalizeDiff(raw) {
    if (Array.isArray(raw)) return raw.filter((x) => x && typeof x === 'object');
    if (raw && typeof raw === 'object') {
      const out = [];
      const roots = [['configs', 'config'], ['plugins', 'plugin'], ['profiles', 'profile']];
      for (const aliases of roots) {
        for (const key of aliases) {
          const arr = raw[key];
          if (Array.isArray(arr)) {
            for (const f of arr) if (f && typeof f === 'object') out.push({ ...f, group: f.group ?? aliases[0] });
            break;
          }
        }
      }
      return out;
    }
    return [];
  }
  function diffGroupOf(f) {
    const g = String(f.group ?? f.root ?? f.groupKey ?? '').toLowerCase();
    if (g.includes('plugin')) return 'plugins';
    if (g.includes('profile')) return 'profiles';
    if (g.includes('config')) return 'configs';
    const name = String(f.name ?? '');
    if (name.startsWith('plugin:')) return 'plugins';
    if (name.startsWith('profile:')) return 'profiles';
    return 'configs';
  }
  function diffDisplayName(name) {
    return String(name ?? '').replace(/^plugin:/, '').replace(/^profile:/, '');
  }
  function diffLineCounts(f) {
    const added = Number.isFinite(f.added) ? f.added : (Array.isArray(f.addedLines) ? f.addedLines.length : 0);
    const removed = Number.isFinite(f.removed) ? f.removed : (Array.isArray(f.removedLines) ? f.removedLines.length : 0);
    return { added, removed };
  }

  async function showDiff(id) {
    openPanel(`
      <div class="panel-head">
        <h3>${esc(t('diffTitle'))} · <span class="mono">${esc(id)}</span></h3>
        <button type="button" class="close-x" data-close aria-label="${esc(t('close'))}">×</button>
      </div>
      <div class="panel-body diff-root" id="diff-root">${stateBox('loading', { title: t('diffLoading'), sub: t('diffLoadingHint') })}</div>
      <div class="panel-foot"><button type="button" class="btn" data-close>${esc(t('close'))}</button></div>`, 'panel-diff');
    const root = $('#diff-root');
    const load = async () => {
      let d;
      try {
        d = normalizeDiff((await get(`/api/undo/diff?id=${encodeURIComponent(id)}`)).diff);
      } catch (e) {
        root.innerHTML = stateBox('error', { title: t('diffError'), sub: `${t('diffErrorHint')} ${e.message}`, action: 'diff-retry', actionLabel: t('retry') });
        bindRetry();
        return;
      }
      if (!d.length) {
        root.innerHTML = stateBox('empty', { title: t('diffEmpty'), sub: t('diffEmptyHint') });
        return;
      }
      renderDiff(d);
    };
    const bindRetry = () => {
      const retry = root.querySelector('[data-act="diff-retry"]');
      if (retry) retry.addEventListener('click', () => {
        root.innerHTML = stateBox('loading', { title: t('diffLoading'), sub: t('diffLoadingHint') });
        load();
      });
    };
    const renderDiff = (files) => {
      const order = ['configs', 'plugins', 'profiles'];
      const labels = { configs: t('groupConfig'), plugins: t('groupPlugins'), profiles: t('groupProfiles') };
      const groups = order.map((key) => ({
        key,
        label: labels[key],
        files: files.filter((f) => diffGroupOf(f) === key),
      })).filter((g) => g.files.length);
      let index = 0;
      const totalAdded = files.reduce((n, f) => n + diffLineCounts(f).added, 0);
      const totalRemoved = files.reduce((n, f) => n + diffLineCounts(f).removed, 0);
      const nav = groups.map((g) => `<div class="diff-group">
        <div class="diff-group-title"><span>${esc(g.label)}</span><span>${g.files.length}</span></div>
        ${g.files.map((f) => {
          const { added, removed } = diffLineCounts(f);
          const globalIndex = files.indexOf(f);
          return `<button type="button" class="diff-file" data-i="${globalIndex}">
            <span class="diff-file-name">${esc(diffDisplayName(f.name))}</span>
            <span class="diff-file-count"><span class="diff-add">+${added}</span><span class="diff-del">−${removed}</span></span>
          </button>`;
        }).join('')}
      </div>`).join('');
      root.innerHTML = `
        <div class="diff-summary">
          <span>${files.length} ${esc(t('diffFilesCount'))}</span>
          <span class="diff-add">+${totalAdded}</span>
          <span class="diff-del">−${totalRemoved}</span>
          <span class="muted">${esc(groups.map((g) => `${g.label} ${g.files.length}`).join(' · '))}</span>
        </div>
        <div class="diff-layout">
          <nav class="diff-files" aria-label="${esc(t('diffTitle'))}">${nav}</nav>
          <section class="diff-main">
            <div class="diff-filehead" id="diff-filehead"></div>
            <pre class="diff-content" id="diff-content"></pre>
          </section>
        </div>`;
      const show = (i) => {
        index = Math.max(0, Math.min(files.length - 1, i));
        const f = files[index];
        const group = diffGroupOf(f);
        const { added, removed } = diffLineCounts(f);
        const head = root.querySelector('#diff-filehead');
        const content = root.querySelector('#diff-content');
        if (!head || !content) return;
        head.innerHTML = `<span class="badge badge-profile">${esc(labels[group] || group)}</span>
          <span class="diff-path">${esc(f.name)}</span>
          <span class="diff-file-count"><span class="diff-add">+${added}</span><span class="diff-del">−${removed}</span></span>`;
        const lines = [
          ...(Array.isArray(f.removedLines) ? f.removedLines : []).map((l) => `<span class="diff-line removed">− ${esc(l)}</span>`),
          ...(Array.isArray(f.addedLines) ? f.addedLines : []).map((l) => `<span class="diff-line added">＋ ${esc(l)}</span>`),
        ];
        content.innerHTML = lines.length ? lines.join('') : `<span class="diff-empty">${esc(t('diffFileEmpty'))}</span>`;
        root.querySelectorAll('.diff-file').forEach((btn) => {
          const on = Number(btn.dataset.i) === index;
          btn.classList.toggle('is-active', on);
          btn.setAttribute('aria-current', on ? 'true' : 'false');
        });
        const active = root.querySelector('.diff-file.is-active');
        if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
      };
      root.querySelectorAll('.diff-file').forEach((btn) => {
        btn.addEventListener('click', () => show(Number(btn.dataset.i)));
      });
      show(index);
    };
    await load();
  }

  // ── 对话级撤回 ──────────────────────────────────────────────────────────
  async function openMessages() {
    let msgs = [];
    try { msgs = (await get('/api/undo/messages')).messages ?? []; } catch (e) { toast(e.message, 'err'); return; }
    const rows = msgs.length
      ? msgs.map((m) => `<div class="inst-card">
          <div class="inst-head"><span class="mono">${esc(m.id)}</span><span class="muted">${esc(fmtTime(m.startedAt))}</span>${m.deleted ? `<span class="chip chip-warn">${esc(t('del'))}</span>` : ''}</div>
          <div class="inst-meta"><span>${m.files} ${esc(t('files'))}</span>${m.messageId ? `<span>msg=${esc(m.messageId)}</span>` : ''}${(m.tools ?? []).length ? `<span>[${esc((m.tools ?? []).join(', '))}]</span>` : ''}</div>
          <div class="inst-actions"><button type="button" class="btn btn-sm btn-danger" data-mid="${esc(m.id)}">${esc(t('msgUndo'))}</button></div>
        </div>`).join('')
      : stateBox('empty', { title: t('msgEmpty') });
    openPanel(`<div class="panel-head"><h3>${esc(t('msgTitle'))}</h3><button type="button" class="close-x" data-close aria-label="${esc(t('close'))}">×</button></div>
      <div class="panel-body"><div class="inst-list">${rows}</div></div>
      <div class="panel-foot"><button type="button" class="btn" data-close>${esc(t('close'))}</button></div>`);
    $$('#panel [data-mid]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.mid;
      confirmBox({
        message: `${t('msgUndoClick')}<br><strong class="mono">${esc(id)}</strong>`,
        danger: true,
        onYes: async () => {
          await post('/api/undo/message', { id });
          toast(`${t('msgUndone')} ✓`, 'ok');
          await refresh();
        },
      });
    }));
  }

  // ── 诊断 / 导出 / 导入 / 清理 / 安全模式 ────────────────────────────────
  const doctorPanel = (d, extra) => {
    const banner = d.healthy ? `✅ ${t('doctorHealthy')}` : `⚠️ ${t('doctorUnhealthy')}`;
    const rows = (d.checks ?? []).map((c) => {
      const mark = c.level === 'err' ? '❌' : c.level === 'warn' ? '⚠️' : '✅';
      const badge = c.fixable ? ` <span class="chip chip-warn">${t('doctorFixable')}</span>` : '';
      return `<div class="doc-row ${esc(c.level)}"><span class="doc-mark">${mark}</span><div><b>${esc(c.name)}${badge}</b><div class="doc-detail">${esc(c.detail)}</div>${c.fix ? `<div class="doc-fix">→ ${esc(c.fix)}</div>` : ''}</div></div>`;
    }).join('');
    const n = d.fixable ?? 0;
    const note = extra
      ? `<div class="doc-summary"><span class="doc-counts">${t('doctorFixed')} ${extra.fixed ?? 0} · ${t('doctorFailed')} ${extra.failed ?? 0}${extra.snapshotId ? ` · ${t('doctorSnapshot')} ${esc(extra.snapshotId)}` : ''}</span></div>`
      : '';
    return `<div class="panel-head"><h3>${esc(t('doctorTitle'))}</h3><span class="chip ${d.healthy ? 'chip-ok' : 'chip-warn'}">${esc(d.healthy ? t('doctorOk') : t('doctorWarn'))}</span><button type="button" class="close-x" data-close aria-label="${esc(t('close'))}">×</button></div>
      <div class="panel-body"><div class="doc-summary">${banner}<span class="doc-counts">${d.summary?.ok ?? 0} ${t('doctorOk')} · ${d.summary?.warn ?? 0} ${t('doctorWarn')} · ${d.summary?.err ?? 0} ${t('doctorErr')}</span></div>${note}${rows}</div>
      <div class="panel-foot"><button type="button" class="btn" data-close>${esc(t('close'))}</button>${n > 0 ? `<button type="button" class="btn btn-primary" id="doctor-fix">🔧 ${esc(t('doctorFix'))} (${n})</button>` : ''}</div>`;
  };
  const attachDoctorFix = () => {
    const btn = $('#doctor-fix');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await post('/api/undo/doctor/fix');
        toast(`${t('doctorFix')} ✓ ${r.fixed ?? 0}`, 'ok');
        openPanel(doctorPanel(r, { fixed: r.fixed ?? 0, failed: r.failed ?? 0, snapshotId: r.snapshotId }));
        attachDoctorFix();
        await refresh();
      } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
    });
  };
  $('#btn-doctor').addEventListener('click', async () => {
    closeMore();
    try {
      openPanel(doctorPanel(await get('/api/undo/doctor'), null));
      attachDoctorFix();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#btn-export').addEventListener('click', () => {
    closeMore();
    openPanel(`
      <div class="panel-head"><h3>${esc(t('export'))}</h3><button type="button" class="close-x" data-close aria-label="${esc(t('close'))}">×</button></div>
      <div class="panel-body"><div class="field"><span>${esc(t('exportPass'))}</span><input type="password" id="export-pass" placeholder="${esc(t('exportPass'))}"></div></div>
      <div class="panel-foot"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button><button type="button" class="btn btn-primary" id="export-go">${esc(t('export'))}</button></div>`);
    $('#export-go').addEventListener('click', async () => {
      try {
        const r = await post('/api/undo/export', { password: $('#export-pass').value });
        toast(`${t('exportDone')} ✓ ${r.count ?? 0}${r.encrypted ? ` · ${t('encrypted')}` : ''}`, 'ok');
        closePanel();
      } catch (e) { toast(e.message, 'err'); }
    });
  });

  $('#btn-import').addEventListener('click', async () => {
    closeMore();
    try {
      const pick = await post('/api/undo/pick-file');
      if (!pick.ok || !pick.path) { toast(t('pickFileCanceled')); return; }
      openPanel(`
        <div class="panel-head"><h3>${esc(t('import'))}</h3><button type="button" class="close-x" data-close aria-label="${esc(t('close'))}">×</button></div>
        <div class="panel-body"><div class="field"><span>${esc(t('importPass'))}</span><input type="password" id="import-pass" placeholder="${esc(t('importPass'))}"></div></div>
        <div class="panel-foot"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button><button type="button" class="btn btn-primary" id="import-go">${esc(t('import'))}</button></div>`);
      $('#import-go').addEventListener('click', async () => {
        try {
          const r = await post('/api/undo/import', { path: pick.path, password: $('#import-pass').value });
          toast(`${t('importDone')} ✓ ${r.imported ?? 0}`, 'ok');
          closePanel();
          await refresh();
        } catch (e) { toast(e.message, 'err'); }
      });
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#btn-prune').addEventListener('click', () => {
    closeMore();
    confirmBox({
      message: t('pruneClick'),
      onYes: async () => {
        await post('/api/undo/prune');
        toast(`${t('pruneDone')} ✓`, 'ok');
        await refresh();
      },
    });
  });

  $('#btn-safemode').addEventListener('click', () => {
    const on = !(state.status?.safeModeActive);
    const send = async (extra) => {
      const body = { on, action: on ? 'on' : 'off', profile: state.profile, ...extra };
      const r = await post('/api/undo/safe-mode', body);
      if (r && r.needConfirm === true && r.reason === 'desktop-profile') return { needConfirm: true };
      if (r && r.ok === false) {
        const reason = typeof r.error === 'string' ? r.error : (r.error?.message ?? r.reason ?? t('saveFailed'));
        toast(String(reason), 'err');
        return { needConfirm: false };
      }
      toast(`${on ? t('safemode') : t('safemodeOff')} ✓`, 'ok');
      await refresh();
      return { needConfirm: false };
    };
    confirmBox({
      message: on ? t('safemodeClick') : t('safemodeOffClick'),
      danger: true,
      online: true,
      desktop: on && state.profile === 'desktop',
      yes: t('confirm'),
      onYes: async () => {
        const first = await send({});
        if (!first.needConfirm) return;
        confirmBox({
          message: `${t('desktopWarn')}<br><strong>${esc(state.profile)}</strong>`,
          danger: true,
          online: true,
          yes: t('confirm'),
          onYes: async () => { await send({ confirmDesktop: true }); },
        });
      },
    });
  });

  $('#btn-undo').addEventListener('click', () => {
    confirmBox({
      message: t('undoClick'),
      onYes: async () => {
        await post('/api/undo/undo');
        toast(`${t('undoDone')} ✓`, 'ok');
        await refresh();
      },
    });
  });
  $('#btn-redo').addEventListener('click', () => {
    confirmBox({
      message: t('redoClick'),
      onYes: async () => {
        await post('/api/undo/redo');
        toast(`${t('redoDone')} ✓`, 'ok');
        await refresh();
      },
    });
  });
  $('#btn-snapshot').addEventListener('click', openSnapshot);
  $('#btn-refresh').addEventListener('click', () => refresh());
  $('#btn-lang').addEventListener('click', () => setLang(LANG === 'zh' ? 'en' : 'zh'));
  $('#btn-theme').addEventListener('click', cycleTheme);
  $('#btn-settings').addEventListener('click', openSettings);

  // ── 「更多」菜单 ────────────────────────────────────────────────────────
  function closeMore() {
    const more = $('#more-menu');
    if (more) more.open = false;
  }
  document.addEventListener('click', (e) => {
    const more = $('#more-menu');
    if (!more || !more.open) return;
    if (!more.contains(e.target)) more.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = $('#overlay');
    if (overlay && !overlay.classList.contains('hidden')) { closePanel(); return; }
    closeMore();
  });

  // ── 设置弹层：实例管理 + 扫描建议 + 策略/守卫 ───────────────────────────
  let setCtx = null;

  function field(label, inner, cls) {
    return `<label class="field ${cls ?? ''}"><span>${esc(label)}</span>${inner}</label>`;
  }
  function checkRow(label, id, checked) {
    return `<label class="check-row"><input type="checkbox" id="${esc(id)}"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  }
  function radioRow(name, id, label, checked) {
    return `<label class="check-row"><input type="radio" name="${esc(name)}" id="${esc(id)}"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  }

  async function openSettings() {
    let settingsRes = null;
    let instRes = null;
    try { settingsRes = await get('/api/undo/settings'); } catch (e) { toast(e.message, 'err'); return; }
    try { instRes = await get('/api/undo/instances'); } catch (e) { instRes = null; }
    const s = settingsRes?.settings ?? {};
    setCtx = {
      s,
      settingsFile: settingsRes?.settingsFile ?? '',
      instancesFile: settingsRes?.instancesFile ?? (instRes && instRes.settingsFile) ?? '',
      inst: instRes,
      editing: null,
      draft: null,
      pendingDelete: null,
      scan: { status: 'idle', list: [], error: '', notReady: false, meta: null },
    };
    openPanel(settingsHtml(s), 'panel-settings');
    renderInstManage();
    $('#set-save').addEventListener('click', saveSettings);
    $('#inst-scan').addEventListener('click', runScan);
    $('#inst-manage').addEventListener('click', onInstManageClick);
    $('#inst-manage').addEventListener('input', onInstFormInput);
  }

  function settingsHtml(s) {
    const guardMode = s.guardAutoSafeMode;
    return `
      <div class="panel-head"><h3>${esc(t('settingsTitle'))}</h3><button type="button" class="close-x" data-close aria-label="${esc(t('close'))}">×</button></div>
      <div class="panel-body settings-body">
        <section class="sec">
          <div class="sec-head">
            <h4 class="sec-title">${esc(t('secInstances'))}</h4>
            ${setCtx.instancesFile && setCtx.instancesFile !== setCtx.settingsFile
              ? `<span class="sec-note">${esc(t('instancesFile'))}: <code class="mono">${esc(setCtx.instancesFile)}</code></span>`
              : ''}
            <span class="sec-note">${esc(t('settingsFile'))}: <code class="mono">${esc(setCtx.settingsFile || '—')}</code></span>
          </div>
          <div class="sec-head">
            <h4 class="sec-title">${esc(t('instTitle'))}</h4>
            <button type="button" class="btn" id="inst-scan">📡 ${esc(t('instScan'))}</button>
          </div>
          <div id="inst-manage"></div>
        </section>

        <section class="sec">
          <div class="sec-head"><h4 class="sec-title">${esc(t('secPolicy'))}</h4></div>
          <div class="form-grid">
            ${checkRow(t('setAuto'), 'set-autoEnabled', s.autoEnabled)}
            ${checkRow(t('setCleanup'), 'set-autoCleanup', s.autoCleanup)}
            ${field(t('setDebounce'), `<input type="number" id="set-watchDebounceMs" value="${esc(s.watchDebounceMs ?? 300)}">`)}
            ${field(t('setKeep'), `<input type="number" id="set-keepAuto" value="${esc(s.keepAuto ?? 50)}">`)}
            ${field(t('setKeepPre'), `<input type="number" id="set-keepPre" value="${esc(s.keepPre ?? 10)}">`)}
            ${field(t('setScheduleMs'), `<input type="number" id="set-scheduleMs" min="1" value="${esc(Math.round((s.scheduledSnapshotMs ?? 0) / 60000))}">`)}
          </div>
          ${checkRow(t('setScheduleEnabled'), 'set-scheduleEnabled', s.scheduledSnapshotEnabled)}
          <div class="field"><span>${esc(t('setManualDir'))}</span><input type="text" id="set-manualDir" value="${esc(s.manualDir ?? '')}"></div>
          <div class="field"><span>${esc(t('setAutoDir'))}</span><input type="text" id="set-autoDir" value="${esc(s.autoDir ?? '')}"></div>
          <div class="field"><span>${esc(t('setPluginDirs'))}</span><input type="text" id="set-pluginDirs" value="${esc((s.pluginDirs ?? []).join(','))}"></div>
          <div class="field"><span>${esc(t('setWorkspaceDirs'))}</span><input type="text" id="set-workspaceDirs" value="${esc((s.workspaceDirs ?? []).join(','))}"></div>
        </section>

        <section class="sec">
          <div class="sec-head"><h4 class="sec-title">${esc(t('secGuard'))}</h4></div>
          <div class="sec-head"><span class="sec-note">${esc(t('setSensitive'))}</span></div>
          <div class="form-grid">
            ${radioRow('set-sensitive', 'set-sensitive-redact', t('setSensitiveRedact'), s.sensitiveMode !== 'keep')}
            ${radioRow('set-sensitive', 'set-sensitive-keep', t('setSensitiveKeep'), s.sensitiveMode === 'keep')}
          </div>
          <div class="form-grid">
            ${checkRow(t('setBootHealth'), 'set-bootHealth', s.bootHealthEnabled !== false)}
            ${checkRow(t('setUpgradeGuard'), 'set-upgradeGuard', s.upgradeGuardEnabled !== false)}
            ${checkRow(t('setDesktop'), 'set-desktop', s.createDesktopShortcut !== false)}
            ${checkRow(t('setGuardShortcut'), 'set-guardShortcut', s.guardShortcutEnabled)}
          </div>
          <div class="field"><span>${esc(t('setDesktopInfo'))}</span><input type="text" id="set-desktopDir" value="${esc(s.desktopDir ?? '')}" readonly></div>
          <div class="sec-head"><span class="sec-note">${esc(t('setGuardMode'))}</span></div>
          <div class="form-grid">
            ${radioRow('set-guardmode', 'set-guard-ask', t('setGuardAsk'), guardMode !== 'on' && guardMode !== 'off')}
            ${radioRow('set-guardmode', 'set-guard-on', t('setGuardOn'), guardMode === 'on')}
            ${radioRow('set-guardmode', 'set-guard-off', t('setGuardOff'), guardMode === 'off')}
          </div>
          ${field(t('setAutoHeal'), `<input type="number" id="set-autoHeal" min="0" value="${esc(s.autoSafeModeAfterFails ?? 2)}">`)}
        </section>
      </div>
      <div class="panel-foot">
        <button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
        <button type="button" class="btn btn-primary" id="set-save">${esc(t('save'))}</button>
      </div>`;
  }

  function instanceStatusBadge(x) {
    if (x && x.port && x.reachable === true && x.hasApi === false) return `<span class="badge badge-legacy badge-dot">${esc(t('apiOld'))}</span>`;
    if (x && x.port && x.reachable === true) return `<span class="badge badge-online badge-dot">${esc(t('online'))}</span>`;
    if (x && x.port && x.reachable === false) return `<span class="badge badge-offline badge-dot">${esc(t('offline'))}</span>`;
    return '';
  }
  function mismatchBadge(x) {
    if (!x || x.homeMismatch !== true) return '';
    const title = `${t('homeMismatchHint')} ${t('probedHome')}: ${x.probedHome || '—'}`;
    return `<span class="badge badge-warn" title="${esc(title)}">${esc(t('homeMismatch'))}</span>`;
  }

  function renderInstManage() {
    const host = $('#inst-manage');
    if (!host || !setCtx) return;
    const list = setCtx.inst && Array.isArray(setCtx.inst.instances) ? setCtx.inst.instances : [];
    const currentName = setCtx.inst?.current ?? state.currentName;
    const cards = list.length
      ? `<div class="inst-list">${list.map((x) => {
        const isCurrent = x.name === currentName;
        const pending = setCtx.pendingDelete === x.name;
        const profiles = Array.isArray(x.profiles) && x.profiles.length ? x.profiles.join(', ') : (x.currentProfile || x.profile || '—');
        const total = Number.isFinite(x.total) ? `${x.total} ${t('snapUnit')}` : '';
        return `<div class="inst-card${isCurrent ? ' is-current' : ''}">
          <div class="inst-head">
            <span class="inst-name">${esc(x.name)}</span>
            ${instanceStatusBadge(x)}
            ${mismatchBadge(x)}
            ${isCurrent ? `<span class="badge badge-current">${esc(t('current'))}</span>` : ''}
            <span class="inst-actions">
              <button type="button" class="btn btn-sm" data-inst-act="edit" data-name="${esc(x.name)}">${esc(t('edit'))}</button>
              <button type="button" class="btn btn-sm btn-danger" data-inst-act="remove" data-name="${esc(x.name)}">${esc(t('instRemove'))}</button>
            </span>
          </div>
          <div class="inst-meta">
            <span>${x.port ? `:${x.port}` : '—'}</span>
            <span class="path-text" title="${esc(x.home ?? '')}">${esc(shortPath(x.home ?? ''))}</span>
          </div>
          <div class="inst-meta">
            <span>${esc(t('instProfiles'))}: ${esc(profiles)}</span>
            <span>${esc(t('apiLabel'))}: ${x.reachable === true ? (x.hasApi === true ? 'v2' : esc(t('apiOld'))) : x.port ? esc(t('offline')) : '—'}</span>
            ${total ? `<span>${esc(total)}</span>` : ''}
          </div>
          ${pending ? `<div class="inst-delete-confirm">
            <span>${esc(t('instDeleteConfirm'))} <b>${esc(x.name)}</b>?</span>
            <button type="button" class="btn btn-sm btn-danger" data-inst-act="remove-confirm" data-name="${esc(x.name)}">${esc(t('del'))}</button>
            <button type="button" class="btn btn-sm" data-inst-act="remove-cancel">${esc(t('cancel'))}</button>
          </div>` : ''}
        </div>`;
      }).join('')}</div>`
      : stateBox('empty', { title: t('instNone'), sub: t('instNoneHint') });

    const editing = setCtx.editing;
    const draft = setCtx.draft || {};
    const nameValue = draft['inst-name'] ?? (editing && editing.name) ?? '';
    const portValue = draft['inst-port'] ?? (editing && editing.port != null ? String(editing.port) : '');
    const homeValue = draft['inst-home'] ?? (editing && editing.home) ?? '';
    const form = `<div class="inst-form">
      ${field(t('instName'), `<input type="text" id="inst-name" value="${esc(nameValue)}" placeholder="local-3082" autocomplete="off">`)}
      ${field(t('instPort'), `<input type="number" id="inst-port" min="1" max="65535" value="${esc(portValue)}" placeholder="3082">`)}
      ${field(t('instHome'), `<input type="text" id="inst-home" value="${esc(homeValue)}" placeholder="D:\\dsh\\home" autocomplete="off">`)}
      <div class="inst-form-actions">
        <button type="button" class="btn btn-primary" data-inst-act="save">${esc(editing ? t('instUpdate') : t('instSave'))}</button>
        ${editing ? `<button type="button" class="btn" data-inst-act="cancel">${esc(t('cancel'))}</button>` : ''}
      </div>
    </div>
    <p class="sec-note">${esc(t('instHomeHint'))}</p>
    ${scanHtml()}`;

    host.innerHTML = cards + scanHtml() + form;
  }

  function scanHtml() {
    const scan = setCtx.scan;
    let body = '';
    if (scan.status === 'loading') {
      body = `<div class="scan-note">${esc(t('instScanning'))}</div>`;
    } else if (scan.status === 'error') {
      body = `<div class="scan-note scan-error">${esc(t('instScanError'))}: ${esc(scan.error || '')}${scan.notReady ? ` · ${esc(t('instScanNotReady'))}` : ''}</div>`;
    } else if (scan.status === 'ready') {
      if (!scan.list.length) {
        body = `<div class="scan-note">${esc(t('instScanEmpty'))} · ${esc(t('instScanEmptyHint'))}</div>`;
      } else {
        const insts = setCtx.inst && Array.isArray(setCtx.inst.instances) ? setCtx.inst.instances : [];
        const cards = scan.list.map((s, i) => {
          const already = insts.some((x) => (s.port && x.port === s.port) || (s.home && x.home === s.home));
          const statusBadge = s.hasApi === false
            ? `<span class="badge badge-legacy badge-dot">${esc(t('apiOld'))}</span>`
            : `<span class="badge badge-online badge-dot">${esc(t('online'))}</span>`;
          const profileText = s.profileName || s.profile || '—';
          const total = Number.isFinite(s.total) ? `${s.total} ${t('snapUnit')}` : '';
          return `<div class="scan-card">
            <div class="scan-top">
              ${statusBadge}
              <b class="mono">${s.port ? ':' + s.port : '—'}</b>
              <span class="muted">${esc(s.name ?? '')}</span>
            </div>
            <div class="scan-meta">${esc(t('probesProfile'))}: <b>${esc(profileText)}</b>${total ? ` · ${esc(total)}` : ''}${Number.isFinite(s.pid) ? ` · ${esc(t('process'))} ${s.pid}` : ''}</div>
            <div class="scan-meta path-text" title="${esc(s.home ?? '')}">${esc(shortPath(s.home ?? '—'))}</div>
            <div class="scan-actions">
              <button type="button" class="btn btn-sm ${already ? '' : 'btn-primary'}" data-inst-act="scan-add" data-i="${i}"${already || !s.home ? ' disabled' : ''}>${esc(already ? t('instAlready') : t('instAddTo'))}</button>
            </div>
          </div>`;
        }).join('');
        const meta = scan.meta && Number.isFinite(scan.meta.durationMs) ? ` · ${esc(t('scanDuration'))} ${scan.meta.durationMs}ms` : '';
        body = `<div class="scan-note">${esc(t('instScanReady'))}${meta}</div><div class="scan-list">${cards}</div>`;
      }
    } else {
      body = `<div class="scan-note">${esc(t('instScanHint'))}</div>`;
    }
    return `<div class="scan-box"><div class="scan-head"><span class="sec-title">${esc(t('instSuggest'))}</span></div><div id="scan-result">${body}</div></div>`;
  }

  function onInstFormInput(e) {
    const id = e.target.id;
    if (id !== 'inst-name' && id !== 'inst-port' && id !== 'inst-home') return;
    if (!setCtx) return;
    if (!setCtx.draft) setCtx.draft = {};
    setCtx.draft[id] = e.target.value;
  }

  async function onInstManageClick(e) {
    const btn = e.target.closest('[data-inst-act]');
    if (!btn || !setCtx) return;
    const act = btn.dataset.instAct;
    if (act === 'save') await saveInstanceFromForm();
    else if (act === 'cancel') { setCtx.editing = null; setCtx.draft = null; renderInstManage(); }
    else if (act === 'edit') {
      const name = btn.dataset.name;
      const hit = (setCtx.inst?.instances ?? []).find((x) => x.name === name);
      setCtx.editing = hit ? { ...hit } : { name };
      setCtx.draft = null;
      setCtx.pendingDelete = null;
      renderInstManage();
    } else if (act === 'remove') {
      setCtx.pendingDelete = btn.dataset.name;
      renderInstManage();
    } else if (act === 'remove-cancel') {
      setCtx.pendingDelete = null;
      renderInstManage();
    } else if (act === 'remove-confirm') {
      await removeInstance(btn.dataset.name);
    } else if (act === 'scan-add') {
      await addSuggestion(Number(btn.dataset.i));
    }
  }

  async function saveInstanceFromForm() {
    if (!setCtx) return;
    const name = ($('#inst-name')?.value ?? '').trim();
    const portRaw = ($('#inst-port')?.value ?? '').trim();
    const home = ($('#inst-home')?.value ?? '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) { toast(t('instBadName'), 'err'); return; }
    if (!home) { toast(t('instBadHome'), 'err'); return; }
    let port = null;
    if (portRaw !== '') {
      const n = Number(portRaw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) { toast(t('instBadPort'), 'err'); return; }
      port = n;
    }
    const editing = setCtx.editing;
    try {
      await post('/api/undo/instances', { upsert: { name, port, home } });
      if (editing && editing.name && editing.name !== name) {
        try { await post('/api/undo/instances', { remove: editing.name }); } catch (e) { /* 改名时旧名清理失败不阻断 */ }
      }
      toast(`${t('instSaved')} ✓`, 'ok');
      setCtx.editing = null;
      setCtx.draft = null;
      await reloadSettingsInstances();
      await refresh();
      renderInstManage();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function removeInstance(name) {
    if (!setCtx || !name) return;
    try {
      await post('/api/undo/instances', { remove: name });
      toast(`${t('instDeleted')} ✓`, 'ok');
      setCtx.pendingDelete = null;
      await reloadSettingsInstances();
      await refresh();
      renderInstManage();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function reloadSettingsInstances() {
    if (!setCtx) return;
    try {
      const inst = await get('/api/undo/instances');
      setCtx.inst = inst;
      if (inst && inst.settingsFile) setCtx.instancesFile = inst.settingsFile;
    } catch (e) { /* 保留旧列表 */ }
  }

  async function runScan() {
    if (!setCtx) return;
    const scanBtn = $('#inst-scan');
    if (scanBtn) { scanBtn.disabled = true; scanBtn.setAttribute('aria-busy', 'true'); }
    setCtx.scan = { status: 'loading', list: [], error: '', notReady: false, meta: null };
    renderInstManage();
    try {
      const r = await post('/api/undo/scan');
      const raw = Array.isArray(r?.suggestions) ? r.suggestions : [];
      const seen = new Set();
      const list = raw.filter((s) => {
        if (!s || typeof s !== 'object') return false;
        const key = `${s.port ?? ''}|${s.pid ?? ''}|${s.home ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setCtx.scan = {
        status: 'ready',
        list,
        error: '',
        notReady: false,
        meta: { durationMs: r?.durationMs, scannedAt: r?.scannedAt },
      };
    } catch (e) {
      const message = String(e.message || e);
      setCtx.scan = {
        status: 'error',
        list: [],
        error: message,
        notReady: /unknown route|not-found|404|not found/i.test(message),
        meta: null,
      };
    }
    if (scanBtn) { scanBtn.disabled = false; scanBtn.removeAttribute('aria-busy'); }
    renderInstManage();
  }

  function safeInstanceName(raw, port) {
    let name = String(raw ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!name) name = `local-${port ?? 'dsh'}`;
    return name.slice(0, 64);
  }

  async function addSuggestion(i) {
    if (!setCtx || setCtx.scan.status !== 'ready') return;
    const s = setCtx.scan.list[i];
    if (!s || !s.home) return;
    const used = new Set((setCtx.inst?.instances ?? []).map((x) => x.name));
    const base = safeInstanceName(s.instanceName || `local-${s.port ?? 'dsh'}`, s.port);
    let name = base;
    let n = 2;
    while (used.has(name)) { name = `${base}-${n}`; n += 1; }
    try {
      await post('/api/undo/instances', { upsert: { name, port: Number.isFinite(s.port) ? s.port : null, home: s.home } });
      toast(`${t('instAdded')} ✓`, 'ok');
      await reloadSettingsInstances();
      await refresh();
      renderInstManage();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function saveSettings() {
    if (!setCtx) return;
    const value = (id) => $(id)?.value ?? '';
    const checked = (id) => { const el = $(id); return !!(el && el.checked); };
    const body = {
      manualDir: value('#set-manualDir'),
      autoDir: value('#set-autoDir'),
      keepAuto: Number(value('#set-keepAuto')),
      keepPre: Number(value('#set-keepPre')),
      watchDebounceMs: Number(value('#set-watchDebounceMs')),
      autoEnabled: checked('#set-autoEnabled'),
      autoCleanup: checked('#set-autoCleanup'),
      pluginDirs: value('#set-pluginDirs'),
      workspaceDirs: value('#set-workspaceDirs'),
      sensitiveMode: checked('#set-sensitive-keep') ? 'keep' : 'redact',
      createDesktopShortcut: checked('#set-desktop'),
      scheduledSnapshotEnabled: checked('#set-scheduleEnabled'),
      scheduledSnapshotMs: Math.round((Number(value('#set-scheduleMs')) || 0) * 60000),
      bootHealthEnabled: checked('#set-bootHealth'),
      upgradeGuardEnabled: checked('#set-upgradeGuard'),
      guardAutoSafeMode: checked('#set-guard-on') ? 'on' : checked('#set-guard-off') ? 'off' : 'ask',
      guardShortcutEnabled: checked('#set-guardShortcut'),
      autoSafeModeAfterFails: Math.max(0, Number(value('#set-autoHeal')) || 0),
    };
    try {
      await post('/api/undo/settings', body);
      toast(`${t('saved')} ✓`, 'ok');
      closePanel();
      await refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ── 崩溃横幅 ────────────────────────────────────────────────────────────
  function renderCrashBanner() {
    const el = $('#crash-banner');
    if (!el) return;
    if (!state.status?.bootAlert) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const lastGood = state.status.lastGoodSnapshotId;
    el.innerHTML = `<span>⚠️ ${esc(t('crashBanner'))}${lastGood ? ` ${esc(t('lastGood'))}: <b class="mono">${esc(lastGood)}</b>` : ''}${state.status.autoSafeMode ? ` · ${esc(t('autoSafeModeNote'))}` : ''}</span>` +
      (lastGood ? `<span class="cb-actions"><button type="button" class="btn btn-sm btn-danger" id="crash-restore">${esc(t('restoreGood'))}</button></span>` : '');
    el.classList.remove('hidden');
    const btn = $('#crash-restore');
    if (btn) btn.addEventListener('click', () => restoreById(lastGood));
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  function bindBaseEvents() {
    applyTheme(readThemePref(), false);
  }

  (async () => {
    bindBaseEvents();
    let lang = (navigator.language || '').startsWith('zh') ? 'zh' : 'en';
    try {
      const loc = await get('/api/undo/locale');
      if (loc && (loc.lang === 'zh' || loc.lang === 'en')) lang = loc.lang;
    } catch (e) { /* 旧服务端没有 locale 时按浏览器语言 */ }
    setLang(lang, { render: false });
    await refresh();
  })();
})();
