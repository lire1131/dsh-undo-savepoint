/* dsh-undo-savepoint 局外 WebUI 逻辑（V0.4.0，D5：手写轻量 DOM、零依赖、双语） */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // ── 多语言 ──────────────────────────────────────────────────────────────
  const dict = {
    zh: {
      total: '快照', profile: 'Profile', loading: '加载中…',
      undo: '撤销', redo: '重做', snapshot: '快照', prune: '清理', export: '导出',
      import: '导入', settings: '设置', safemode: '安全模式', safemodeOff: '退出安全模式',
      diff: '对比', restore: '恢复', del: '删除', cancel: '取消', confirm: '确认',
      close: '关闭', empty: '暂无快照', diffTitle: '快照对比', settingsTitle: '设置',
      confirmTitle: '确认操作', save: '保存', removeConfirm: '删除该快照？',
      restoreConfirm: '恢复到该快照？会先把当前状态存为撤销点。',
      undoClick: '撤销最近一次变更？', redoClick: '重做最近一次撤销？',
      safemodeClick: '进入安全模式：禁用除本插件外的全部用户插件，处理完请重启 DSH 后退出。',
      safemodeOffClick: '退出安全模式，恢复之前的插件与 bundle？',
      crashBanner: '上次 DSH 启动未完成（可能崩溃）。',
      lastGood: '最后已知良好快照', restoreGood: '恢复', lang: '语言', refresh: '刷新',
      theme: '主题', themeAuto: '跟随系统', themeLight: '浅色', themeDark: '深色',
      manual: '手动', auto: '自动', pre: '撤销前', baseline: '基线', legacy: '旧版',
      stepAuto: '自动', preState: '撤销点', files: '个文件', profileFiles: '个配置文件',
      pluginFiles: '个插件文件', redacted: '脱敏', needsRestart: '需重启', truncated: '截断',
      npmSync: '依赖未同步', diffCurrent: '对比预览',
      makeSnap: '创建手动快照', reasonPlaceholder: '说明（可选）', makeSnapConfirm: '创建',
      diagnose: '诊断', doctorTitle: '诊断报告', doctorOk: '健康', doctorWarn: '提醒', doctorErr: '异常',
      doctorHealthy: '一切健康 🎉', doctorUnhealthy: '发现异常，建议处理。', doctorHead: '项检查',
      doctorFix: '修复可修项', doctorFixable: '可修复', doctorFixed: '已修复', doctorFailed: '失败', doctorSnapshot: '修复前快照',
      msgBtn: '对话撤回', msgTitle: '对话级撤回', msgEmpty: '暂无可撤回的消息批次', msgUndo: '撤回', msgUndoClick: '撤回该消息批次的文件改动？', msgUndone: '已撤回',
      setAuto: '自动保存', setDebounce: '防抖(ms)', setKeep: '自动档保留', setKeepPre: '后悔档保留', setCleanup: '自动清理', setManualDir: '手动快照目录', setAutoDir: '自动快照目录', setSensitive: '敏感模式', setSensitiveRedact: '脱敏(默认)', setSensitiveKeep: '明文(旧行为)', setPluginDirs: '插件目录白名单(逗号分隔,留空=自动发现)', setWorkspaceDirs: '跟踪工作区目录(逗号/分号分隔,非空=覆盖默认当前目录,留空=仅当前目录)', setDesktop: '桌面快捷方式', setDesktopInfo: '桌面目录', saved: '设置已保存', setSchedule: '定时快照', setScheduleEnabled: '启用定时快照', setScheduleMs: '间隔(分钟,≥1)', note: '备注', tags: '标签', editNote: '编辑备注/标签', noteEmpty: '无备注', noteSaved: '备注已保存', noteFailed: '保存失败', exportPass: '导出密码(可选，加密)', importPass: '导入密码', encrypted: '已加密', needPass: '该导出已加密，需密码', tree: '目录树', notePlaceholder: '备注内容(可选)', tagsPlaceholder: '标签，逗号分隔(可选)', today: '今天', yesterday: '昨天'
    },
    en: {
      total: 'snapshots', profile: 'Profile', loading: 'Loading…',
      undo: 'Undo', redo: 'Redo', snapshot: 'Snapshot', prune: 'Prune', export: 'Export',
      import: 'Import', settings: 'Settings', safemode: 'Safe mode', safemodeOff: 'Exit safe mode',
      diff: 'Diff', restore: 'Restore', del: 'Delete', cancel: 'Cancel', confirm: 'Confirm',
      close: 'Close', empty: 'No snapshots yet', diffTitle: 'Snapshot diff', settingsTitle: 'Settings',
      confirmTitle: 'Confirm', save: 'Save', removeConfirm: 'Delete this snapshot?',
      restoreConfirm: 'Restore to this snapshot? Current state is saved as an undo point first.',
      undoClick: 'Undo the latest change?', redoClick: 'Redo the latest undo?',
      safemodeClick: 'Enter safe mode: disables every user plugin except this one. Restart DSH before exiting.',
      safemodeOffClick: 'Exit safe mode and restore the previous plugins/bundles?',
      crashBanner: 'Previous DSH run did not finish starting (likely crashed).',
      lastGood: 'Last known-good snapshot', restoreGood: 'Restore', lang: 'language', refresh: 'refresh',
      theme: 'theme', themeAuto: 'follow system', themeLight: 'light', themeDark: 'dark',
      manual: 'manual', auto: 'auto', pre: 'undo point', baseline: 'baseline', legacy: 'legacy',
      stepAuto: 'auto', preState: 'undo point', files: 'files', profileFiles: 'config files',
      pluginFiles: 'plugin files', redacted: 'redacted', needsRestart: 'restart needed', truncated: 'truncated',
      npmSync: 'deps out of sync', diffCurrent: 'diff preview',
      makeSnap: 'Create manual snapshot', reasonPlaceholder: 'reason (optional)', makeSnapConfirm: 'Create',
      diagnose: 'Diagnose', doctorTitle: 'Diagnostic report', doctorOk: 'healthy', doctorWarn: 'warning', doctorErr: 'error',
      doctorHealthy: 'All healthy 🎉', doctorUnhealthy: 'Issues found — check the report.', doctorHead: 'checks',
      doctorFix: 'Repair fixable', doctorFixable: 'fixable', doctorFixed: 'fixed', doctorFailed: 'failed', doctorSnapshot: 'pre-fix snapshot',
      msgBtn: 'Message undo', msgTitle: 'Message-level undo', msgEmpty: 'No message batches to undo', msgUndo: 'Undo', msgUndoClick: 'Undo the file changes of this message batch?', msgUndone: 'undone',
      setAuto: 'Auto-save', setDebounce: 'Debounce (ms)', setKeep: 'Auto snapshots kept', setKeepPre: 'Pre-restore kept', setCleanup: 'Auto-cleanup', setManualDir: 'Manual snapshot dir', setAutoDir: 'Auto snapshot dir', setSensitive: 'Sensitive mode', setSensitiveRedact: 'Redact (default)', setSensitiveKeep: 'Plaintext (legacy)', setPluginDirs: 'Plugin dirs whitelist (comma-separated, empty = auto)', setWorkspaceDirs: 'Tracked workspace dirs (comma/semicolon separated; non-empty replaces current-dir scope, empty = current dir only)', setDesktop: 'Desktop shortcut', setDesktopInfo: 'Desktop dir', saved: 'Settings saved', setSchedule: 'Scheduled snapshots', setScheduleEnabled: 'Enable scheduled snapshots', setScheduleMs: 'Interval (min, ≥1)', note: 'note', tags: 'tags', editNote: 'Edit note/tags', noteEmpty: 'no note', noteSaved: 'Note saved', noteFailed: 'Save failed', exportPass: 'Export password (optional, encrypts)', importPass: 'Import password', encrypted: 'encrypted', needPass: 'This export is encrypted — password required', tree: 'tree', notePlaceholder: 'note (optional)', tagsPlaceholder: 'tags, comma-separated (optional)', today: 'Today', yesterday: 'Yesterday'
    },
  };
  let LANG = 'zh';
  let dictNow = dict.zh;

  function setLang(lang) {
    LANG = lang === 'en' ? 'en' : 'zh';
    dictNow = dict[LANG];
    document.documentElement.lang = LANG;
    dumpT();
    // 语言切换后重渲染动态内容（安全模式按钮/崩溃横幅/时间线里的“脱敏”徽标等）
    closePanel();
    refresh();
  }
  function t(key) { return dictNow[key] ?? dict[_enOrZh()][key] ?? key; }
  function _enOrZh() { return LANG; }
  function dumpT() {
    $('#lbl-total').textContent = t('total');
    $('#btn-undo').textContent = `↩ ${t('undo')}`;
    $('#btn-redo').textContent = `↪ ${t('redo')}`;
    $('#btn-snapshot').textContent = `＋ ${t('snapshot')}`;
    $('#btn-prune').textContent = `🧹 ${t('prune')}`;
    $('#btn-doctor').textContent = `🔍 ${t('diagnose')}`;
    $('#btn-export').textContent = `⬇ ${t('export')}`;
    $('#btn-import').textContent = `⬆ ${t('import')}`;
    $('#btn-settings').textContent = `⚙ ${t('settings')}`;
    $('#btn-message').textContent = `💬 ${t('msgBtn')}`;
    renderThemeBtn();
  }

  // ── API ─────────────────────────────────────────────────────────────────
  const api = async (path, opts) => {
    const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && j?.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
    return j;
  };
  const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const get = (p) => api(p, { method: 'GET' });

  // ── Toast ───────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${kind ?? ''}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ── Overlay helpers ─────────────────────────────────────────────────────
  function openPanel(html) {
    const overlay = $('#overlay');
    const panel = $('#panel');
    overlay.classList.remove('hidden');
    panel.innerHTML = html;
    panel.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));
  }
  function closePanel() { $('#overlay').classList.add('hidden'); $('#panel').innerHTML = ''; }
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closePanel(); });

  function confirmBox(opts) {
    openPanel(`
      <div class="panel-head"><h3>${t('confirmTitle')}</h3></div>
      <div class="panel-body"><p style="margin:0">${opts.message}</p></div>
      <div class="panel-foot">
        <button class="btn" data-close>${t('cancel')}</button>
        <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" id="yes">${opts.yes ?? t('confirm')}</button>
      </div>`);
    $('#yes').addEventListener('click', async () => { closePanel(); await opts.onYes(); });
  }

  const fmtTime = (iso) => (iso ?? '').replace('T', ' ').slice(0, 19);
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── 状态 / 列表 ─────────────────────────────────────────────────────────
  let status = null;
  async function refresh() {
    try { status = await get('/api/undo/status'); } catch (e) { toast(e.message, 'err'); return; }
    $('#stat-total').textContent = status.total;
    $('#stat-profile').textContent = status.profile ?? status.profiles?.[0] ?? 'web';
    $('#btn-undo').disabled = !status.canUndo;
    $('#btn-redo').disabled = !status.canRedo;
    if (status.safeModeActive) {
      $('#btn-safemode').textContent = `🛡 ${t('safemodeOff')}`;
      $('#btn-safemode').classList.add('btn-danger');
    } else {
      $('#btn-safemode').textContent = `🛡 ${t('safemode')}`;
      $('#btn-safemode').classList.remove('btn-danger');
    }
    renderCrashBanner();
    await renderTimeline();
  }

  function renderCrashBanner() {
    const el = $('#crash-banner');
    if (!status?.bootAlert) { el.classList.add('hidden'); return; }
    const lastGood = status.lastGoodSnapshotId;
    el.innerHTML = `⚠️ ${t('crashBanner')}${lastGood ? ` ${t('lastGood')}: <b>${esc(lastGood)}</b>` : ''}` +
      (lastGood ? `<span class="cb-actions"><button class="btn btn-danger" id="ra">${t('restoreGood')}</button></span>` : '');
    el.classList.remove('hidden');
    const ra = $('#ra');
    if (ra) ra.addEventListener('click', () => restoreById(lastGood));
  }

  async function renderTimeline() {
    let list;
    try { list = (await get('/api/undo/list')).snapshots; } catch (e) { toast(e.message, 'err'); return; }
    const wrap = $('#timeline');
    if (!list.length) { wrap.innerHTML = `<div class="timeline-loading">${t('empty')}</div>`; return; }
    wrap.innerHTML = '';
    const todayKey = new Date().toISOString().slice(0, 10);
    const yesterdayKey = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const groups = new Map();
    for (const s of list) { const day = (s.time ?? '').slice(0, 10); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(s); }
    let i = 0;
    for (const [day, items] of groups) {
      const label = day === todayKey ? `📅 ${t('today')}` : day === yesterdayKey ? `📅 ${t('yesterday')}` : `📅 ${day}`;
      const gh = document.createElement('div');
      gh.className = 'tl-date';
      gh.textContent = label;
      wrap.appendChild(gh);
      for (const s of items) {
        i++;
        const kind = s.kind ?? 'auto';
        const pluginCount = (s.plugins ?? []).reduce((n, p) => n + (p.files ?? []).length, 0)
          + (s.profileFiles ?? []).filter((f) => f.hash).length;
        const chips = [];
        if (s.redacted?.length) chips.push(`<span class="chip warn">${t('redacted')}</span>`);
        if (s.stepped) chips.push(`<span class="chip">${t('stepAuto')}</span>`);
        if (s.consumed) chips.push(`<span class="chip">${t('preState')}</span>`);
        if (s.truncated) chips.push(`<span class="chip warn">${t('truncated')}</span>`);
        const tags = (s.tags ?? []).map((x) => `<span class="chip accent">#${esc(x)}</span>`).join('');
        const noteHtml = s.note ? `<div class="tl-note">📝 ${esc(s.note)}</div>` : '';
        const item = document.createElement('div');
        item.className = 'tl-item';
        item.style.animationDelay = `${Math.min((i - 1) * 25, 260)}ms`;
        item.innerHTML = `
          <span class="tl-rail"></span><span class="tl-dot ${kind}"></span>
          <div class="tl-body">
            <div class="tl-top">
              <span class="tl-kind">${esc(kind)}</span>
              <span class="tl-id">${esc(s.id)}</span>
              <span class="tl-meta">${fmtTime(s.time)}${s.location ? ` · ${esc(s.location)}` : ''}</span>
              ${chips.join('')}
            </div>
            <div class="tl-reason">${esc(s.reason ?? '')}</div>
            <div class="tl-meta">${(s.files ?? []).length} ${t('files')}${pluginCount ? `, ${pluginCount} ${t('pluginFiles')}` : ''}${s.totalBytes ? ` · ${fmtBytes(s.totalBytes)}` : ''}</div>
            ${tags ? `<div class="tl-tags">${tags}</div>` : ''}
            ${noteHtml}
          </div>
          <div class="tl-actions">
            <button class="btn btn-ghost" data-act="diff">${t('diff')}</button>
            <button class="btn btn-ghost" data-act="restore">${t('restore')}</button>
            <button class="btn btn-ghost" data-act="note">${t('editNote')}</button>
            <button class="btn btn-ghost" data-act="del">${t('del')}</button>
          </div>`;
        item.querySelector('[data-act="diff"]').addEventListener('click', () => showDiff(s.id));
        item.querySelector('[data-act="restore"]').addEventListener('click', () => restoreById(s.id));
        item.querySelector('[data-act="note"]').addEventListener('click', () => openNoteEditor(s));
        item.querySelector('[data-act="del"]').addEventListener('click', () => removeById(s));
        wrap.appendChild(item);
      }
    }
  }

  // V0.4.0 P4：编辑快照备注/标签。
  function openNoteEditor(s) {
    openPanel(`
      <div class="panel-head"><h3>${t('editNote')} · ${esc(s.id)}</h3><button class="close-x" data-close>×</button></div>
      <div class="panel-body">
        <label class="lbl">${t('note')}</label><input type="text" id="note-text" value="${esc(s.note ?? '')}" placeholder="${t('notePlaceholder')}">
        <label class="lbl">${t('tags')}</label><input type="text" id="note-tags" value="${esc((s.tags ?? []).join(', '))}" placeholder="${t('tagsPlaceholder')}">
      </div>
      <div class="panel-foot"><button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" id="note-save">${t('save')}</button></div>`);
    $('#note-save').addEventListener('click', async () => {
      try {
        await post('/api/undo/note', { id: s.id, note: $('#note-text').value, tags: $('#note-tags').value.split(',').map((x) => x.trim()).filter(Boolean) });
        toast(`${t('noteSaved')} ✓`, 'ok'); closePanel(); await refresh();
      } catch (e) { toast(e.message, 'err'); }
    });
  }
  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '?';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
  }

  async function showDiff(id) {
    try {
      const d = (await get(`/api/undo/diff?id=${encodeURIComponent(id)}`)).diff;
      let tree = [];
      try { tree = (await get(`/api/undo/tree?id=${encodeURIComponent(id)}`)).tree ?? []; } catch (e) { /* 局外旧后端也可能没有 tree 接口，降级为纯文件导航 */ }
      openPanel(`
        <div class="panel-head"><h3>${t('diffTitle')} · ${esc(id)}</h3><button class="close-x" data-close>×</button></div>
        <div class="panel-body" id="diff-wrap"></div>
        <div class="panel-foot"><button class="btn btn-ghost" id="diff-prev" title="上一文件">‹</button>
          <span id="diff-count" style="align-self:center;font-size:12px;color:var(--label-tertiary)"></span>
          <button class="btn btn-ghost" id="diff-next" title="下一文件">›</button>
          <span style="flex:1"></span>
          <button class="btn" data-close>${t('close')}</button></div>`);
      const wrap = $('#diff-wrap');
      if (!Array.isArray(d) || !d.length) {
        wrap.innerHTML = `<p style="margin:0;color:var(--label-secondary)">${t('diffCurrent')} — （无差异）</p>`;
        return;
      }
      const files = d.map((f, i) => ({ ...f, i }));
      let cur = 0;
      const renderTree = (nodes) => {
        let html = '';
        for (const n of nodes) {
          const isLeaf = !(n.children && n.children.length);
          const cls = n.status === 'deleted' ? 'tnode del' : n.status === 'added' ? 'tnode add' : n.status === 'modified' ? 'tnode mod' : 'tnode';
          if (isLeaf) {
            html += `<button class="${cls}" data-file="${esc(n.fullName ?? n.path)}"><span class="tnode-mark">${n.status === 'deleted' ? '−' : n.status === 'added' ? '＋' : '~'}</span>${esc(n.name)}<span class="tnode-count">+${n.added ?? 0} −${n.removed ?? 0}</span></button>`;
          } else {
            html += `<div class="${cls}"><span class="tnode-mark">📁</span>${esc(n.name)}<span class="tnode-count">${(n.children ?? []).length}</span></div><div class="tnode-children">${renderTree(n.children)}</div>`;
          }
        }
        return html;
      };
      const treeHtml = tree.length ? `<div class="diff-tree">${renderTree(tree)}</div>` : `<div class="diff-nav">${files.map((x) => `<button class="fnav ${x.i === cur ? 'active' : ''}" data-i="${x.i}">${esc(x.name)}<span class="fnav-count">+${x.added} −${x.removed}</span></button>`).join('')}</div>`;
      const render = () => {
        const f = files[cur];
        const lines = [
          ...f.removedLines.map((l) => `<span class="diff-line removed">− ${esc(l)}</span>`),
          ...f.addedLines.map((l) => `<span class="diff-line added">＋ ${esc(l)}</span>`),
        ];
        wrap.innerHTML = `
          <div class="diff-cols">
            ${treeHtml}
            <div class="diff-view">
              <div class="diff-filehead">${esc(f.name)} <span class="chip">+${f.added} −${f.removed}</span></div>
              <pre>${lines.join('\n') || '（无差异）'}</pre>
            </div>
          </div>`;
        $('#diff-count').textContent = `${cur + 1}/${files.length}`;
        wrap.querySelectorAll('.fnav').forEach((b) => b.addEventListener('click', () => { cur = Number(b.dataset.i); render(); }));
        wrap.querySelectorAll('[data-file]').forEach((b) => b.addEventListener('click', () => { const idx = files.findIndex((x) => x.name === b.dataset.file); if (idx >= 0) { cur = idx; render(); } }));
        $('#diff-prev').disabled = cur === 0;
        $('#diff-next').disabled = cur === files.length - 1;
        $('#diff-prev').onclick = () => { if (cur > 0) { cur--; render(); } };
        $('#diff-next').onclick = () => { if (cur < files.length - 1) { cur++; render(); } };
      };
      render();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ── 动作 ───────────────────────────────────────────────────────────────
  async function restoreById(id) {
    confirmBox({
      message: `${t('restoreConfirm')}<br><b>${esc(id)}</b>`,
      danger: true, yes: t('restore'),
      onYes: async () => {
        try { await post('/api/undo/restore', { snapshot_id: id }); toast(`${t('restore')} ✓ (${id})`, 'ok'); await refresh(); }
        catch (e) { toast(e.message, 'err'); }
      },
    });
  }
  async function removeById(s) {
    confirmBox({
      message: `${t('removeConfirm')}<br><b>${esc(s.id)}</b>`, danger: true,
      onYes: async () => { try { await post('/api/undo/remove', { id: s.id }); toast(`${t('del')} ✓`, 'ok'); await refresh(); } catch (e) { toast(e.message, 'err'); } },
    });
  }

  $('#btn-undo').addEventListener('click', () => confirmBox({
    message: t('undoClick'), onYes: async () => { try { await post('/api/undo/undo'); toast(`${t('undo')} ✓`, 'ok'); await refresh(); } catch (e) { toast(e.message, 'err'); } },
  }));
  $('#btn-redo').addEventListener('click', () => confirmBox({
    message: t('redoClick'), onYes: async () => { try { await post('/api/undo/redo'); toast(`${t('redo')} ✓`, 'ok'); await refresh(); } catch (e) { toast(e.message, 'err'); } },
  }));
  $('#btn-snapshot').addEventListener('click', () => {
    openPanel(`
    <div class="panel-head"><h3>${t('makeSnap')}</h3><button class="close-x" data-close>×</button></div>
    <div class="panel-body"><label class="lbl">${t('reasonPlaceholder')}</label><input type="text" id="snap-reason" placeholder="${t('reasonPlaceholder')}"></div>
    <div class="panel-foot"><button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" id="snap-go">${t('makeSnapConfirm')}</button></div>`);
    $('#snap-go').addEventListener('click', async () => {
      const reason = $('#snap-reason').value.trim();
      try { const r = await post('/api/undo/snapshot', { reason }); toast(`${t('snapshot')} ✓ ${r.id}`, 'ok'); closePanel(); await refresh(); } catch (e) { toast(e.message, 'err'); }
    });
  });

  $('#btn-prune').addEventListener('click', async () => {
    try { await post('/api/undo/prune'); toast(`${t('prune')} ✓`, 'ok'); await refresh(); } catch (e) { toast(e.message, 'err'); }
  });
  const doctorPanel = (d, extra) => {
    const banner = d.healthy ? `✅ ${t('doctorHealthy')}` : `⚠️ ${t('doctorUnhealthy')}`;
    const rows = (d.checks ?? []).map((c) => {
      const mark = c.level === 'err' ? '❌' : c.level === 'warn' ? '⚠️' : '✅';
      const badge = c.fixable ? ` <span class="chip warn">${t('doctorFixable')}</span>` : '';
      return `<div class="doc-row ${c.level}"><span class="doc-mark">${mark}</span><div><b>${esc(c.name)}${badge}</b><div class="doc-detail">${esc(c.detail)}</div>${c.fix ? `<div class="doc-fix">→ ${esc(c.fix)}</div>` : ''}</div></div>`;
    }).join('');
    const n = d.fixable ?? 0;
    const note = extra
      ? `<div class="doc-summary"><span class="doc-counts">${t('doctorFixed')} ${extra.fixed ?? 0} · ${t('doctorFailed')} ${extra.failed ?? 0}${extra.snapshotId ? ` · ${t('doctorSnapshot')} ${esc(extra.snapshotId)}` : ''}</span></div>`
      : '';
    return `<div class="panel-head"><h3>${t('doctorTitle')}</h3><span class="chip ${d.healthy ? 'ok' : 'warn'}">${d.healthy ? t('doctorOk') : t('doctorWarn')}</span><button class="close-x" data-close>×</button></div>
      <div class="panel-body"><div class="doc-summary">${banner}<span class="doc-counts">${d.summary?.ok ?? 0} ${t('doctorOk')} · ${d.summary?.warn ?? 0} ${t('doctorWarn')} · ${d.summary?.err ?? 0} ${t('doctorErr')}</span></div>${note}${rows}</div>
      <div class="panel-foot"><button class="btn" data-close>${t('close')}</button>${n > 0 ? `<button class="btn btn-primary" id="doctor-fix">🔧 ${t('doctorFix')} (${n})</button>` : ''}</div>`;
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
    try {
      openPanel(doctorPanel(await get('/api/undo/doctor'), null));
      attachDoctorFix();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-export').addEventListener('click', () => {
    openPanel(`
      <div class="panel-head"><h3>${t('export')}</h3><button class="close-x" data-close>×</button></div>
      <div class="panel-body"><label class="lbl">${t('exportPass')}</label><input type="password" id="export-pass" placeholder="${t('exportPass')}"></div>
      <div class="panel-foot"><button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" id="export-go">${t('export')}</button></div>`);
    $('#export-go').addEventListener('click', async () => {
      try {
        const r = await post('/api/undo/export', { password: $('#export-pass').value });
        toast(`${t('export')} ✓ ${r.count ?? 0}${r.encrypted ? ` · ${t('encrypted')}` : ''}`, 'ok'); closePanel();
      } catch (e) { toast(e.message, 'err'); }
    });
  });
  $('#btn-import').addEventListener('click', async () => {
    try {
      const pick = await post('/api/undo/pick-file');
      if (!pick.ok || !pick.path) { toast('canceled'); return; }
      openPanel(`
        <div class="panel-head"><h3>${t('import')}</h3><button class="close-x" data-close>×</button></div>
        <div class="panel-body"><label class="lbl">${t('importPass')}</label><input type="password" id="import-pass" placeholder="${t('importPass')}"></div>
        <div class="panel-foot"><button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" id="import-go">${t('import')}</button></div>`);
      $('#import-go').addEventListener('click', async () => {
        try {
          const r = await post('/api/undo/import', { path: pick.path, password: $('#import-pass').value });
          toast(`${t('import')} ✓ ${r.imported ?? 0}`, 'ok'); closePanel(); await refresh();
        } catch (e) { toast(e.message, 'err'); }
      });
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-safemode').addEventListener('click', () => {
    const on = !(status?.safeModeActive);
    confirmBox({
      message: on ? t('safemodeClick') : t('safemodeOffClick'), danger: true, yes: t('confirm'),
      onYes: async () => {
        try { const r = await post('/api/undo/safe-mode', { on }); toast(String(r.message ?? r.ok), 'ok'); await refresh(); }
        catch (e) { toast(e.message, 'err'); }
      },
    });
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-message').addEventListener('click', openMessages);
  $('#btn-refresh').addEventListener('click', refresh);
  $('#btn-lang').addEventListener('click', () => setLang(LANG === 'zh' ? 'en' : 'zh'));
  $('#btn-theme').addEventListener('click', cycleTheme);

  // ── 对话级撤回 ─────────────────────────────────────────────────────
  async function openMessages() {
    let msgs;
    try { msgs = (await get('/api/undo/messages')).messages ?? []; } catch (e) { toast(e.message, 'err'); return; }
    const rows = msgs.length
      ? msgs.map((m) => `
        <div class="tl-item">
          <div class="tl-body">
            <div class="tl-top"><span class="tl-id">${esc(m.id)}</span><span class="tl-meta">${fmtTime(m.startedAt)}</span>${m.deleted ? `<span class="chip warn">deleted</span>` : ''}</div>
            <div class="tl-meta">${m.files} ${t('files')}${m.messageId ? ` · msg=${esc(m.messageId)}` : ''}${(m.tools ?? []).length ? ` · [${esc((m.tools ?? []).join(', '))}]` : ''}</div>
          </div>
          <div class="tl-actions"><button class="btn btn-danger" data-mid="${esc(m.id)}">${t('msgUndo')}</button></div>
        </div>`).join('')
      : `<div class="timeline-loading">${t('msgEmpty')}</div>`;
    openPanel(`<div class="panel-head"><h3>${t('msgTitle')}</h3><button class="close-x" data-close>×</button></div>
      <div class="panel-body" style="max-height:60vh;overflow:auto">${rows}</div>
      <div class="panel-foot"><button class="btn" data-close>${t('cancel')}</button></div>`);
    $('#panel').querySelectorAll('[data-mid]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.mid;
      confirmBox({ message: `${t('msgUndoClick')}<br><b>${esc(id)}</b>`, danger: true, onYes: async () => {
        try { await post('/api/undo/message', { id }); toast(`${t('msgUndone')} ✓`, 'ok'); closePanel(); await refresh(); }
        catch (e) { toast(e.message, 'err'); }
      } });
    }));
  }

  async function openSettings() {
    let s;
    try { s = (await get('/api/undo/settings')).settings; } catch (e) { toast(e.message, 'err'); return; }
    openPanel(`
      <div class="panel-head"><h3>${t('settingsTitle')}</h3><button class="close-x" data-close>×</button></div>
      <div class="panel-body">
        <label class="lbl">${t('setAuto')}</label><label class="checkbox-row"><input type="checkbox" id="set-autoEnabled" ${s.autoEnabled ? 'checked' : ''}></label>
        <div class="row">
          <div><label class="lbl">${t('setDebounce')}</label><input type="number" id="set-watchDebounceMs" value="${s.watchDebounceMs}"></div>
          <div><label class="lbl">${t('setKeep')}</label><input type="number" id="set-keepAuto" value="${s.keepAuto}"></div>
          <div><label class="lbl">${t('setKeepPre')}</label><input type="number" id="set-keepPre" value="${s.keepPre}"></div>
        </div>
        <label class="checkbox-row"><input type="checkbox" id="set-autoCleanup" ${s.autoCleanup ? 'checked' : ''}> ${t('setCleanup')}</label>
        <label class="lbl">${t('setSensitive')}</label>
        <label class="checkbox-row"><input type="radio" name="set-sensitive" id="set-sensitive-redact" ${s.sensitiveMode !== 'keep' ? 'checked' : ''}> ${t('setSensitiveRedact')}</label>
        <label class="checkbox-row"><input type="radio" name="set-sensitive" id="set-sensitive-keep" ${s.sensitiveMode === 'keep' ? 'checked' : ''}> ${t('setSensitiveKeep')}</label>
        <label class="lbl">${t('setPluginDirs')}</label><input type="text" id="set-pluginDirs" value="${esc((s.pluginDirs ?? []).join(','))}">
        <label class="lbl">${t('setWorkspaceDirs')}</label><input type="text" id="set-workspaceDirs" value="${esc((s.workspaceDirs ?? []).join(','))}">
        <label class="lbl">${t('setManualDir')}</label><input type="text" id="set-manualDir" value="${esc(s.manualDir)}">
        <label class="lbl">${t('setAutoDir')}</label><input type="text" id="set-autoDir" value="${esc(s.autoDir)}">
        <label class="checkbox-row"><input type="checkbox" id="set-desktop" ${s.createDesktopShortcut !== false ? 'checked' : ''}> ${t('setDesktop')}</label>
        <div class="tl-meta">${t('setDesktopInfo')}: ${esc(s.desktopDir ?? '')}</div>
        <div class="row">
          <div><label class="lbl">${t('setSchedule')}</label></div>
          <label class="checkbox-row"><input type="checkbox" id="set-scheduleEnabled" ${s.scheduledSnapshotEnabled ? 'checked' : ''}> ${t('setScheduleEnabled')}</label>
          <div><label class="lbl">${t('setScheduleMs')}</label><input type="number" id="set-scheduleMs" value="${Math.round((s.scheduledSnapshotMs ?? 0) / 60000)}" min="1"></div>
        </div>
      </div>
      <div class="panel-foot"><button class="btn" data-close>${t('cancel')}</button><button class="btn btn-primary" id="set-save">${t('save')}</button></div>`);
    $('#set-save').addEventListener('click', async () => {
      try {
        await post('/api/undo/settings', {
          manualDir: $('#set-manualDir').value,
          autoDir: $('#set-autoDir').value,
          keepAuto: Number($('#set-keepAuto').value),
          keepPre: Number($('#set-keepPre').value),
          watchDebounceMs: Number($('#set-watchDebounceMs').value),
          autoEnabled: $('#set-autoEnabled').checked,
          autoCleanup: $('#set-autoCleanup').checked,
          pluginDirs: $('#set-pluginDirs').value,
          workspaceDirs: $('#set-workspaceDirs').value,
          sensitiveMode: $('#set-sensitive-keep').checked ? 'keep' : 'redact',
          createDesktopShortcut: $('#set-desktop').checked,
          scheduledSnapshotEnabled: $('#set-scheduleEnabled').checked,
          scheduledSnapshotMs: Math.round((Number($('#set-scheduleMs').value) || 0) * 60000),
        });
        toast(`${t('saved')} ✓`, 'ok'); closePanel(); await refresh();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  // ── 启动 ───────────────────────────────────────────────────────────────
  // ── 主题（v0.4.8 / #37）────────────────────────────────────────────────────
  // 偏好三态（auto / light / dark）存 localStorage，解析结果写 data-theme=light|dark。
  // 与 index.html 头部内联脚本共用同一个 key 与同一套判定，样式表只认 light|dark。
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
    rootEl.setAttribute('data-theme', resolved);
    rootEl.setAttribute('data-theme-pref', themePref);
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

  (async () => {
    applyTheme(readThemePref(), false);
    try {
      const loc = await get('/api/undo/locale');
      if (loc.lang && loc.lang !== 'auto') setLang(loc.lang);
      else setLang((navigator.language || '').startsWith('zh') ? 'zh' : 'en');
    } catch { setLang((navigator.language || '').startsWith('zh') ? 'zh' : 'en'); }
    await refresh();
  })();
})();
