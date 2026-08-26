# 更新日志

dsh-undo-savepoint 的重要变更。日期为本地时间（UTC+8)。English version: [CHANGELOG.en.md](CHANGELOG.en.md)

## [0.4.2] - 2026-08-26

### 新增

- **`undo_scan` 支持 synthetic-closer seq 重叠修复**：扫描改为逐帧解码（不再把整个日志 `Buffer.concat` 到内存，避免大文件出现 `Allocation error : not enough memory`），并识别「崩溃恢复写入的 `step/end`+`turn/end` 合成关闭帧之后，续跑会话又复用旧 seq」的损坏模式；`quarantine=true` / `dsh-undo.ps1 scan --fix` 时只删除该合成关闭帧即可让日志恢复连续，保留其后全部事件（原件留 `.bak` + 隔离区副本）。

## [0.4.1] - 2026-08-23

### 修复

- **macOS 延迟投递修复（CI e2e-watch）**：restore/undo 后 `ensureMount` 重写 `cordis.patch.yml` 的内容哈希登记入 `restoredHashes`，使 watcher 的内容 echo 检测识别「这是挂载管理写、非用户变更」；避免 macOS FSEvents 延迟投递事件在 `suppressAuto` 同步窗口外被当作真实变更，产生挡住 redo 的回声快照。已在三平台 CI 验证（此前仅 macOS 失败，现 macOS/ubuntu/windows 均绿）。

## [0.4.0] - 2026-08-22

### 新增

- **全平台适配**：核心抽离为纯 Node、零依赖的 `lib/core.mjs`（~1900 行，约 100 导出），`lib/index.js` 转为薄主机壳；ZIP（`lib/zip.mjs`，纯 Node 实现，兼容 PowerShell）、目录/文件选择器、pnpm 调用均按平台分发（win32=PowerShell / darwin=osascript / linux=zenity→kdialog）；CI 升级为三平台矩阵 `windows/ubuntu/macos × node[20,22]`（fail-fast false）。
- **局外 WebUI（跨平台，DSH 挂了也能可视化回滚）**：`tools/undo-server.mjs`（`node:http`，绑定 127.0.0.1，单实例锁）+ `tools/webui/{index.html,app.js,styles.css}` + `tools/launch-undo.{bat,command,sh,desktop}` 启动器；时间线 / 文件级 diff / 一键回滚 / 诊断 / 安全模式全都有。
- **时间线 Time Machine**：快照时间线可视化、文件级双栏 diff（新增/删除行高亮、逐文件导航、上一/下一文件）、入场动画（尊重 `prefers-reduced-motion`）。
- **一键诊断 `undo_doctor`**：核心 `runDoctor` + 对话工具 `undo_doctor` + REST `GET /api/undo/doctor` + WebUI 诊断按钮；检查 store 可写性（真实 `.doctor-probe` 写/删）、blob 缺失/孤儿、settings 健康、快照规模，输出结构化 ok/warn/err 报告与修复提示。
- **消息级撤销 `undo_message` / `undo_message_list`**：`tools/pre-execute` 旁路记录工作区文件变更（白名单 `write/edit/replace/patch`、`workspaceDirs` 范围、60s 时间窗批次），按反向序恢复 before 内容/删除新建文件；`keepMessageOps`、`fileToolWhitelist`、`workspaceDirs`、`workspaceWatch` 设于 `DEFAULT_SETTINGS` 与 cfg。
- **快照瘦身 `undo_compact`**：孤儿 blob GC（不被任何快照/消息批次引用的 blob 与残留 `.tmp`），支持 `dry_run`。
- **桌面快捷方式（新增）**：插件加载后自动在桌面创建「dsh-undo-savepoint」快捷方式，双击即打开局外工具（undo-server WebUI）。三平台分发（win32=`cmd /c launch-undo.bat`，darwin=`launch-undo.command`，linux=`launch-undo.desktop`）；幂等（已存在跳过）；`settings.createDesktopShortcut=false` 或 `DSH_UNDO_NO_DESKTOP=1` 可关闭；`desktopDir` 可覆盖（测试用）。
- **ZIP 互操作修复**：`readZip` 将条目名 `\` 归一为 `/`（NFC），使纯 Node 能读 PowerShell `Compress-Archive` 产出的 ZIP——双向格式互通已验证。
- **体验增强**：快照备注/标签（`undo_note` 工具 + `/api/undo/note`，WebUI 时间线可直接编辑；`undo_snapshot` 支持 `note`/`tags`）；定时快照（设置 `scheduledSnapshotEnabled`/`scheduledSnapshotMs`，按间隔自动创建 auto 快照并做保留清理）；目录树 diff（`/api/undo/tree` + WebUI 左栏树导航，按目录聚合、增/删/改着色）；ZIP 加密导出（`node:crypto` AES-256-GCM + scrypt，`DSHUNDOENC1` magic 头；默认不加密保持 PowerShell 互通，导入带密码自动解密）。
- **可视化增强**：时间线按日期分组卡片化、备注/标签芯片、入场/过渡动效（尊重 `prefers-reduced-motion`）；局内（client）头部新增「对话撤回」入口与消息级撤回面板（复用 `/api/undo/messages` + `/api/undo/message`）；局内快照面板新增「加密导出/导入」密码输入（`/api/undo/export|import` 带 `password`）与「定时快照」设置（`/api/undo/settings` 的 `scheduledSnapshotEnabled/Ms`，与 WebUI 对齐）。
- **插件 Logo 与图标接线**：新增 image2.0 生成提示词 `docs/logo-prompt.md`；Web 页面（`tools/webui/index.html`）接入 favicon（`logo.svg` 跨平台占位 + `logo.png` 生成后兜底）；桌面快捷方式（`createWinLnk`）在 `tools/webui/logo.ico` 存在时用自定义图标（回退 `logo.png`，再回退系统默认）；新增零依赖 `tools/make-ico.mjs` 把生成的透明 PNG 转成 Windows `.ico`。
- **工作区范围可配置**：消息级撤销新增设置页字段「跟踪工作区目录」（`settings.workspaceDirs`），纳入 `publicSettings` 与 `POST /api/undo/settings`（`DEFAULT_SETTINGS.workspaceDirs` 与之动态联动）；逗号/分号分隔可多选，非空时覆盖默认 `[process.cwd()]`，留空=仅当前工作目录；i18n 补 zh/en 键；局内面板（client）与局外 WebUI（app.js）的设置页已同步该字段，且面板补齐 `createDesktopShortcut`/`desktopDir` 显示，两边设置项一致。
- **Logo 换新（小体积）**：WebUI 主 favicon 用内置 `tools/webui/logo.svg`（852 B，最小）；桌面快捷方式用从 `logo.svg` 经 headless Edge 栅格化的 **64×64 透明 PNG**（3.4 KB）转成 `tools/webui/logo.ico`（3.5 KB），`logo.png` 同 3.4 KB 作为兜底；现有 `.lnk` 图标原地指向新 ICO。

### 修复

- **依赖纪律**：整个插件保持零运行时依赖（ZIP、translate、picker、server 全手写）；单快照引用 ≤5MB（超限仅清单+告警）与插件体积上限（`check-size` 收紧到 5MB）两道门禁持续回归。
- 供测试回归：smoke 由 174 项扩至 189 项（消息级撤销、孤儿 GC、zip 互操、i18n 完整性、doctor），e2e、home、check-size、check-version 全绿。

## [0.3.9] - 2026-08-22

### 新增

- **多语言（host / CLI / WebUI 一起落地）**：
  - 新增 `lib/i18n/{zh,en}.json` 作为唯一词典源（140 键，覆盖 host 用户可见消息与 WebUI 全部文案）；零依赖翻译器 `lib/i18n.mjs`（`t(key, vars?, lang?)`），语言优先级 `DSH_UNDO_LANG` > 本机 `Intl`/`LANG` 中文 > en 兜底
  - host 端 `lib/index.js` 用户可见文案接入 `t()`：安全模式（进入/已开启/重扫/中和/补丁提示/状态/退出/损坏包拒绝）、undo/redo/restore 结果渲染、busy 拦截、快照/列表/差异/清理/导出/导入/最近回滚/版权，`smoke` 固定 `DSH_UNDO_LANG=en` 后断言保持不变
  - WebUI（`lib/client.js`）沿用 `ctx.locale.register/bind`（rc8 已确认兼容），内联 zh/en 词典与 `lib/i18n` 做**单一词典源一致性断言**（client 每键在 JSON 存在且非空、zh/en 键集一致），防止两处飘移
  - 离线 CLI（`dsh-undo.ps1` / `dsh-undo-savepoint-lib.ps1`）：新增 `Get-UndoLanguage` / `Get-UndoText`（读 `lib/i18n/*.json`，`DSH_UNDO_LANG` / `$PSUICulture` 选择），`snapshot`、`undo` 等结果文案双语化；`.ps1` 保持 UTF-8 with BOM
- **产物体积门禁缩到 5M**：新增 `tools/check-size.mjs`，扫描 `lib/` + `tools/` + 顶层 `package.json`/README/CHANGELOG/LICENSE/`cordis.patch.yml`，跳过 `node_modules/.git/.github/docs`；`npm test` 首位执行，超过 5MB 即失败。当前产物约 565KB
- **主题色变量化（`--dsw-alias-*`）**：WebUI `client.js` 硬编码颜色迁移到 `--dsw-alias-bg-layer-1 / --dsw-alias-bg-mask-1 / --dsw-alias-border-l3 / --dsw-alias-state-error-primary / --dsw-alias-state-success-primary / --dsw-alias-state-business-primary`（`--dsw-specific-tip` 保留），配合主题切换

### 测试
- smoke 174 → 180（+6 个 WebUI/词典一致性断言）；`npm test` 全链（check-size → check-version → smoke → home-resolution → e2e）绿
- e2e 10/10 无回归；CLI `status` 在 `DSH_UNDO_LANG=en` 下可运行

### 变更
- 环境变量：`DSH_UNDO_LANG`（`zh`/`en`；未设置时宿主中文环境默认中文，否则英文）

## [0.3.8] - 2026-08-21

### 新增

- **安全模式 bundle 中和**：安全模式此前只最小化 patch 层，对「profile bundles 硬校验失败导致 DSH 起不来」完全无效。现进入安全模式时用与 dsh-app-boot `loadProfile` 相同的三项规则（可解析 / 有 `dsh.bundle.patch` / patch 文件存在）逐项校验 `dsh.profile.bundles`，剔除坏条目写回（原 `package.json` 双保险：快照 + 独立备份 `safe-mode-pkg-<id>.json`）；退出时整份恢复，消息报告中和条目数。边界：`package.json` 缺失跳过不阻断；JSON 损坏拒绝进入且绝不破坏性重写。幂等重扫：已在安全模式中再次 `on` 时只重扫报告，不重复写
- **崩溃归因 v2（crashReason）**：上次崩溃后启动时扫描日志尾部匹配已知签名，把崩溃分类为 `session-corrupt`（会话文件损坏）/ `bundle-check`（bundles 硬校验失败）/ `patch-tree`（插件挂载/加载失败）/ `unknown`，写入 `boot-state.json`（下次启动直接复用，日志滚动不丢归因）；`undo_list` 崩溃横幅按分类给出处置建议（会话损坏→`undo_scan`，bundle→进安全模式），`/api/undo/status` 返回 `crashReason` 字段
- **`undo_scan` 会话健康扫描与修复**：扫描 `<home>/sessions/**/session.jsonl.zstd`，判定 `ok` / `fixable`（单帧布局违规，8/18 崩溃根因）/ `corrupt`（无法解码 / 首行非法 header / 坏 JSON 行）；`quarantine=true` 时修复 `fixable` 文件——原件复制到 `<undo 根>/corrupt-quarantine/` 并留 `.bak`，重编码为「header 独立帧 + 事件帧」并做三重校验（round-trip 文本一致 / 逐行 JSON / 重分析）后替换；`corrupt` 文件只隔离复制、绝不动原件。配套：`dsh-undo.ps1 scan [--fix] [-Label <home>]` 与离线脚本 `tools/session-scan.mjs`（DSH 起不来时也能用）。**依赖 Node ≥22.15**（`node:zlib` 的 zstd API）；Node 20 下 `undo_scan` 降级为明确"不支持"提示、插件其余功能不受影响
- **dsh-session-persistence-jsonl 补丁托管**：3 处容错补丁（`appendBatch` 自愈 / `listArtifacts` 隔离 / `readFirstZstdLine` 宽容）以 `tools/dsh-patches.json` 清单托管（old = rc8 原始代码，new = rc6 已验证补丁）；`tools/apply-dsh-patches.ps1 status|verify|apply|remove` 离线应用/还原（逐补丁备份 `.bak-<id>`，未知状态中止不写）；插件启动时只读校验并告警（绝不自动改文件），进入安全模式时附带提示

### 优化
- `undo_safe_mode` 工具描述与 WebUI 确认文案同步 v0.3.8 能力（bundle 中和）

### 测试
- smoke 146 → 174（新增 5 节 28 个断言）： bundle 中和往返 + 损坏 package.json 拒绝进入、 日志签名分类（session-corrupt / bundle-check 两场景）、 扫描/修复/隔离/复扫、补丁清单 old/new 与真实 rc8/rc6 目标精确匹配
- 修复：编辑后的 `.ps1` 文件重新携带 UTF-8 BOM（用例 25 编码审计回归校验）
- 收尾验证：smoke 174 全绿；e2e 10/10 无回归；home-resolution 2 分支全绿

## [0.3.7] - 2026-08-21

### 修复
- **issue #11：快捷方式脚本编码事故**：`tools/make-desktop-shortcut.ps1` 转 UTF-8 with BOM（中文 Windows PowerShell 5.x 按 GBK 解析无 BOM 中文 → 引号被破坏 → ParserError，「DSH撤销管理器」桌面快捷方式创建失败）；新增 smoke 编码审计用例（含非 ASCII 的 `.ps1/.bat` 无 BOM 即 FAIL），杜绝回归
- **安全模式自删/悬空修复（8/17 复盘补完）**：
  - 空备份回退：进入时 profile patch 缺失 → 备份写 `[]`（语义=无用户插件可禁用），不再留下"引用从未创建的备份"死锁
  - 不变量断言：`active ⇒ 备份文件真实存在`，进入侧断言失败拒绝写状态文件
  - 双级 patch：home 级 `cordis.patch.yml` 一并备份/最小化/恢复（此前安全模式只动 profile 级，home 级挂载的插件完全不受控）
  - home 指纹：状态记录 home 指纹（home 根 + profile + settings.yaml 统计），家目录重建/换机时残留状态自动降级为不激活并告警，绝不把旧家的安全模式带到新家
  - 启动自愈：安全模式激活中若 undo 挂载丢失（profile 初始化竞态），启动时自动补挂载
- **rc8 双重挂载启动即崩（2026-08-21 现场）**：
  - 启动去重自愈 `dedupeMount`：扫描 bundle / profile patch（含 include 引用）/ home patch 全部挂载源，重复时只保留 canonical（bundle > profile patch > home patch），改动前先备份 `.dsh-undo-bak`
  - 注册防御 `registerToolOnce`：重复注册只告警跳过，绝不炸掉启动
  - `safeEffect` rc8 兼容盖子（工作区既有实现）随发布版合入

### 优化
- **单快照 ≤5MB 约束**：`pluginMaxSnapshotBytes` 10MB → 5MB；manifest 新增 `totalBytes`（快照物化体积），`undo_list` 展示体积与 `[truncated]` 标记；超限语义沿用"仅记清单+告警，不丢数据"
- **快照精简固化**：新增 smoke 断言——无外部插件环境快照总字节 <100KB

### 测试
- smoke 114 → 146（新增 10 节 32 个断言）：编码审计、快照精简+totalBytes、patch 缺失进出安全模式、全新 home 往返、双级 patch 备份恢复、home 指纹降级、启动自愈、5MB 截断、双重挂载去重（patch+patch / patch+bundle 两场景）、重复注册降级与 safeEffect 兜底
- 清理健壮性：`fs.rm` 统一加重试（Windows 杀软/索引器短暂占用目录句柄会偶发 ENOTEMPTY）
- e2e 10/10 无回归；home-resolution 2 分支全绿；CI 在 windows-latest × node[20,22] 上执行

## [0.3.6] - 2026-08-20

### 修复
- **快照补齐启动关键文件**：新增 profile 级 `pnpm-lock.yaml` 与 home 级 `cordis.patch.yml`，与 `dsh plugin add/update/remove` 实际改动的状态对齐（issue #8）
- **恢复后对账依赖状态**：undo/redo/restore 触及 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 时，默认报告 `node_modules` 可能不同步并给出重建命令；显式开启同步时执行 `pnpm install --frozen-lockfile`（无 lockfile 回退普通 `pnpm install`），安装失败不回滚已还原的配置文件
- **watcher 容错（node 20 CI 暴露）**：`fs.watch` 补挂 error 处理器——被监听目录被删除/重命名时（测试清理临时目录、真实使用中卸载插件/改目录名），Windows 下 FSWatcher 异步抛 `EPERM`，此前无处理会以未捕获异常炸掉整个进程；现自动关闭该监听并告警，不再崩溃

### 优化
- **移除 npm 安装方式**：README 删除 npm 发布版安装说明与 npm 安装地址，安装方式收敛为 GitHub 直装（方式 A）与本地源码（方式 B）

### 变更
- 离线 CLI：`dsh-undo.ps1 undo|redo|restore -SyncDeps`
- 模型工具：`undo_restore` 新增 `sync_deps` 布尔参数
- REST：`/api/undo/undo|redo|restore` 接受可选 `syncDeps`

### 变更
- **CI 迁移 windows-latest**：本项目为纯 Windows 插件（`runPnpm` 走 `cmd.exe`、测试用 `.cmd` 假 pnpm、附带 `.ps1/.bat` 工具），此前 CI 误跑 ubuntu-latest，第 24 节"假 pnpm"测试必然失败（`pnpm.cmd` 在 Linux 上不生效，marker 未生成导致 ENOENT 抛崩）——现已与真实部署环境一致
- **fail-fast: false**：node 20 / 22 矩阵各自跑完、独立报告，不再互相取消
- **补跑 home-resolution-test.mjs**：CI 与 `npm test` 四脚本套件对齐（此前漏跑 issue #6 的 DSH_HOME 回归）
- **smoke-test §24 诊断加固**：sync_deps 失败时打印 restore 输出尾部，marker 缺失走明确断言，不再被未捕获 ENOENT 掩盖真实失败原因

### 测试
- smoke 106 → 114（新增 lockfile/home patch 快照、字节级还原、默认不同步、显式同步命令校验、spec.json 一致性断言）
- e2e 10/10 无回归；CI 在 windows-latest × node[20,22] 全绿

## [0.3.5] - 2026-08-17

### 修复
- **支持 `DSH_HOME` 环境变量**（issue #6）：家目录解析优先读 `DSH_HOME`，无则回退 `~/.dsh`，与 DSH 官方启动器一致。此前所有 `.dsh` 相对路径（设置文件、快照根、profile 目录）都硬编码 `~/.dsh`，使用第三方客户端（家目录非默认）时设置丢失、自定义快照目录重启后回退默认
  - `lib/index.js`：新增 `DSH_HOME_DIR` 常量（`DSH_HOME` ?? `join(HOME, '.dsh')`），`LEGACY_ROOT` / `SETTINGS_FILE` / `rootDir()` / `profileDir` 全部基于它
  - `tools/dsh-undo-savepoint-lib.ps1`：同步对齐，`$script:DshHome` 优先 `$env:DSH_HOME`
  - `tools/make-desktop-shortcut.ps1`：桌面快捷方式候选路径支持 `$DSH_HOME`（自定义家目录客户端也能自动定位插件目录）
  - `DSH_UNDO_ROOT` / `DSH_UNDO_SETTINGS` 显式覆盖优先级不变
  - `node_modules` 发现路径保持 `HOME`（用户级，不在 `.dsh` 下）

### 优化
- **README 预览图改走 jsDelivr CDN**（`cdn.jsdelivr.net/gh/lire1131/dsh-undo-plugin@master/docs/*.png`）：`raw.githubusercontent.com` 在国内网络常被阻断，此前仓库页 README 图片经常加载不出来；CDN 直连可稳定加载。图片有缓存（约 12h），需强制刷新时访问 `https://purge.jsdelivr.net/gh/lire1131/dsh-undo-plugin@master/` 清缓存

### 测试
- smoke 106/106、e2e 10/10 全通过（无回归）
- 新增 DSH_HOME 验证：设 `DSH_HOME=/tmp/fake` 后快照和设置均写入该路径，`~/.dsh` 无残留；不设时回退行为不变
- 新增自动化回归 `tools/home-resolution-test.mjs`（双分支：`DSH_HOME` 优先 / 默认回退 `~/.dsh`，验证快照捕获来源与设置文件落点），已接入 `npm test` 与 CI

## [0.3.4] - 2026-08-16

### 新增
- **WebUI 快照入口全面增强**（替换社区 PR #4 的"两个小相机图标"方案，改为成套 UI）：
  - 会话头部「撤销 / 恢复 / 快照」三按钮全部图标化（红色 ↶ / 绿色 ↷ / 相机，单色 `currentColor` 随主题自适应）
  - **快照按钮 = 一键手动快照**：点击立即存档当前配置（等价面板内「手动保存」，成功后按钮旁闪现「已存档 <id>」），不再打开面板
  - 头部新增**自动快照状态徽章**：绿点 + 「已存 N 份快照 · 最近 xx 分钟前」，30 秒自动轮询刷新（配置一改、自动快照落地，徽章即刻变化）；**点击徽章 = 打开快照面板**
  - 快照面板头部：相机图标 + 标题 + 当前 profile 副标题（取自最新快照 manifest 的 `profile` 字段，v0.3.3 多 profile 成果的可见化）
- 纯客户端改动（`lib/client.js`），host 端与快照逻辑零改动

### 修复
- **会话运行中禁止撤销/恢复/回滚/安全模式切换**：有任何 live 会话处于 open turn（agent 正在执行）时，undo/redo/restore 与 safe-mode on/off 一律拒绝并给出明确提示（host 端安全闸 + WebUI 专属提示）。此前撤销会写回 `cordis.patch.yml`、触发 DSH 内置 HMR 热重建插件树，导致所有正在跑的会话一起中断、无法恢复（用户反馈的"误点撤销导致整个工作区崩溃"）；空闲时行为完全不变

### 测试
- smoke 101 → 106（运行中守卫：open turn 拒绝且配置未被回滚 / safe-mode 拒绝且 patch 未被改写 / closed turn 放行）

## [0.3.3] - 2026-08-16

### 新增
- **多 profile 支持**（issue #3）：从 `process.argv` 解析当前 profile（`--profile mine` / `--profile=mine`，`dsh web` 回退 `web`），`config.profileName` 可显式覆盖
  - `profileDir` 默认改为当前 profile 目录（此前硬编码 `web`——非 web profile 下快照读错、watcher 漏监听、恢复写错位置）
  - 快照仓库按 profile 隔离：`<快照根>/<profileName>/{auto,manual}`；兼容旧数据——profile 作用域目录不存在而旧平铺目录存在时自动回退平铺（不隐身旧快照）
  - manifest 增加 `profile` 字段，`undo_list` 显示当前 profile
  - 离线 CLI/GUI 同步：`DSH_UNDO_PROFILE` 环境变量或 settings `profileName` 指定（离线无法看到 argv）
  - 显式配置（`profileDir` / `manualDir` / `autoDir` / `profileName`）优先级不变
- **ps1 离线工具支持 `DSH_UNDO_ROOT` / `DSH_UNDO_SETTINGS` 环境变量**（与 Node 插件对齐；此前 ps1 只认默认路径，自定义库用户离线工具会错位）
- **package.json 声明 `dsh.runtime: "host"`**（WhaleHarness 审计门槛：使用 child_process 必须声明 host runtime）

### 修复
- settings.json 默认位置迁移兼容：旧位置（如 `D:\dsh\undo\settings.json`）配置的数据不再"隐身"——新位置读取后按配置目录继续工作

### 测试
- smoke 98 → 101（argv 解析 / manifest profile 字段 / 显式 profileName 覆盖）；e2e 10/10

## [0.3.2] - 2026-08-15

### 新增
- **敏感信息脱敏 + 本机 vault**（默认开启）：`.env` 与 `.credentials.yaml` 进快照时值替换为 `***REDACTED***`（键名/export/引号/注释/结构全保留），快照与导出 ZIP 可自由外传零泄露；真实值存本机 vault（`<autoDir>/env-vault/`，内容寻址），**本机回滚完整还原含值**，换机回滚得到占位 + 提示填写
  - `sensitiveMode` 设置：`redact`（默认）/ `keep`（明文旧行为）；旧快照自动兼容
  - **diff 两侧都脱敏**（快照侧与当前侧，含旧快照明文），界面永不出现真实值
- **`.credentials.yaml` 纳入快照范围**（此前不在——DSH 真凭据文件损坏时局内外都救不了）
- **局外急救补齐**（DSH 挂了也能救全）：
  - **GUI 崩溃横幅升级**：读 boot-state.json（旧逻辑查已废弃的 .booting，v0.3 后失效已修复），显示 last-good 快照 + 一键回退到该快照
  - **GUI 一键安全模式按钮**（on/off 确认框）；**GUI 标题栏显示当前敏感模式**
  - **CLI 新增 `recent` 命令**：查看回滚日志（WebUI 的 undo_recent 对等能力）
  - **CLI `settings -Label "key=value;..."`**：离线修改设置（此前只读）
  - **CLI undo/redo/restore 输出增强**：needsRestart / 跨机 preflight 警告 / 脱敏占位 Note 提示
- **WebUI 设置独立侧栏栏目**：「快照」栏目一页展示全部设置（不再挤在"通用"里），含敏感模式下拉、插件目录白名单、目录 📁 选择
- **设置双端同步修复**：ps1 补读 keepPre/autoCleanup（此前 GUI 打开显示为空并覆盖 WebUI 值）；GUI 目录选择用「浏览」按钮
- **孤儿 blob 清理**：`undo_prune` / 清理过期顺带删除"无任何快照引用"的插件代码 blob（跨机导入残留不再占空间）
- **导出敏感警告**：keep 模式或旧快照含明文敏感文件时，导出（对话/WebUI/CLI）明确警告"包含真实密钥，请勿外传"
- **`undo_list` 显示敏感模式**：附当前模式 + 最近快照脱敏文件数

### 修复
- ps1 `Get-UndoBootAlert` 升级为读 boot-state.json（含 lastGoodAt），新增 `Get-UndoLastGoodId`
- GUI 工具栏 11 按钮溢出被列表遮挡（两行排列 + 单实例 Mutex 防重复后台）
- diff 泄露：当前文件侧明文直接显示（如 `DEEPSEEK_API_KEY: sk-...`）——两侧统一脱敏

### 测试
- smoke 76 → 98（脱敏规则各形态 / vault 本机完整恢复 / 换机占位 / diff 双侧零泄露 / keep 明文 / 孤儿 blob 清理 / 旧快照兼容）；e2e 10/10

## [0.3.1] - 2026-08-15

### 新增
- **跨机一致性预检**:恢复（undo/redo/restore）时自动扫描目标快照引用的插件（patch 挂载条目 + package.json bundles),本机解析不到的**明确列出并提示**"恢复后可能启动失败",建议先装插件或安全模式启动
  - 多锚点探测（用户 node_modules / profile 依赖树 / 插件位置链）,任一可解析即视为已装，避免 junction 布局误报
  - 本地文件条目（`name: './xxx'`）不探测；预检结果写入回滚日志
- **docs/migration 双语文档**:跨机迁移行为说明（插件代码不会塞入目标机、blob 残留、patch 缺插件的坑）+ 最佳实践，中英双语

### 修复
- `toolsRequire` 从块级作用域提升为模块级（此前外部函数引用会被 try/catch 静默吞掉 ReferenceError,预检的多锚点解析依赖它）

## [0.3.0] - 2026-08-15

### 新增
- **崩溃归因升级**:`.booting` 标记升级为 `boot-state.json`,记录每次启动的结果与"最后正常启动时间";上次异常退出时，`undo_list` 与 WebUI 直接给出**具体的最后正常快照 id 与一键回退按钮**,不再只说"上次崩溃了"
- **一键安全模式**:`undo_safe_mode` 工具（对话可直接用）+ WebUI 快照面板「安全模式」按钮 + 离线 CLI `safe-mode on|off|status`——进入时自动手动快照并备份 `cordis.patch.yml`,把 patch 最小化（只留撤销系统）,保证 DSH 一定能启动；退出时恢复原配置。DSH 完全起不来时的终极兜底
- **重启联动**:undo/redo/restore 涉及插件代码或挂载配置时，报告与 WebUI 明确提示"重启 DSH 后生效",回滚日志同步记录

## [0.2.1] - 2026-08-15

### 新增
- **一键桌面快捷方式**:`tools/make-desktop-shortcut.bat`(双击）/ `.ps1`(命令行）自动定位插件目录，在桌面创建「DSH撤销管理器」快捷方式——解决"装完找不到局外工具"
- **README 新增「局外工具在哪」章节**:写明两种安装方式的工具路径 + 一段无需先找文件的一行命令（自动定位并创建快捷方式）+ 打开工具目录命令

### 修复
- 澄清包名/仓库名差异：安装命令写 `dsh-undo-plugin`,装好后目录名是**包名 `dsh-undo-savepoint`**——按仓库名找目录必然找不到，README 已标注

## [0.2.0] - 2026-08-15

### 新增
- **插件代码树快照**:自动发现用户插件（`node_modules` 下的 junction,如 `D:\dsh\plugins\*`）与 profile 本地代码文件（`cordis.patch.yml` 里 `name: './xxx'` 引用的 `router-global.mjs` 等）,插件代码被改坏也能撤销——配置没变也能撤（如 whale-kit "yield* is not async iterable" 这类纯代码事故）
- **体积 4 道保险**:扩展名白名单（只收 `.js/.mjs/.cjs/.ts/.json/.yml` 等代码文件，资源如 gif/png 不进快照，实测 pet 57MB→47KB)、内容寻址 blob 库去重（`<快照根>/blobs`,没变的文件零拷贝）、单文件/单快照上限（超限记录 skipped)、按引用恢复（缺失明确报告）
- **插件文件 diff**:`undo_diff` 与 WebUI 差异预览显示 `plugin:xxx` / `profile:xxx` 条目
- **插件 watcher**:插件代码目录变化自动快照（`plugin-code-change`),恢复动作自身不误伤（echo 检测）
- **单一清单 `lib/spec.json`**:快照范围 Node 与 PowerShell 共用一份配置，不再双写漂移
- **`pluginDirs` 设置**:可显式指定插件目录白名单（空数组 = 关闭自动发现，测试/隔离用）
- **导出/导入含 blob 库**:ZIP 备份迁移后 restore 不缺内容
- 快照 manifest 记录插件名/版本/跳过项；`undo_list` 显示插件文件数；恢复报告列出未恢复项（missing)

### 修复
- 旧快照（无 plugins 字段）在 PowerShell 离线工具下被 `@($null)` 单元素数组污染状态与 diff(过滤空值）
- 离线 CLI diff 分支改用统一实现（Get-UndoDiffText),支持插件文件
- ps1 文件统一 UTF-8 BOM,PowerShell 5.1 正确解析中文注释

## [0.1.1] - 2026-08-15

### 新增
- **回滚事件日志**:每次 undo / redo / restore 成功后追加一条 JSON 记录（时间、模式、目标快照、被回滚的文件）,保留最近 100 条
- **`undo_recent` 工具**:随时查看最近的回滚操作，排查"配置怎么突然变了"——回滚可能发生在其他会话或离线工具里
- **提示词规则 7**:用户对配置状态困惑时，AI 先调 `undo_recent` 确认是否为回滚所致

## [0.1.0] - 2026-08-14

### 新增
- **自动快照 + 手动快照分库存储**(`manual` / `auto`):配置每次变更自动存档（1.5 秒防抖）,启动生成 baseline;手动快照永不自动清理
- **undo / redo / 恢复到任意版本**:pre-restore 重做点机制，存在更新的真实变更时禁止 redo
- **快照管理面板**:逐条 diff 预览、恢复前变更摘要确认、删除、清理、导出 / 导入（ZIP 备份迁移）
- **WebUI 撤销/重做/快照按钮 + 全局快捷键**(Ctrl+Alt+Z / Ctrl+Alt+Y,可自定义）
- **崩溃自检**:上次 DSH 未正常启动时提示，可一键回滚
- **主动告知**:配置变更后 AI 提示"已自动保存，随时可撤销"
- **离线 CLI + GUI v2**:DSH 启动不了也能用（快照/撤销/回退/diff/清理/导出导入/设置/托盘）
- **双语 GUI**(系统语言自动检测，`DSH_UNDO_LANG` 可覆盖）
- **dsh.bundle 生态安装**:`dsh plugin add github:lire1131/dsh-undo-plugin#master`
- 设置项：自动保存开关、防抖、保留数量、自动清理、快照目录（原生文件夹选择器）

### 变更
- 插件由 `dsh-undo` 更名为 **`dsh-undo-savepoint`**
- 依赖解析不再硬编码作者路径（基于插件位置解析，回退 `$DSH_ROOT`)
- 默认存储/设置基于用户主目录；旧版平铺存储自动迁移到分库结构

### 修复
- 硬编码作者路径导致其他机器启动失败（issue #1)
- undo/redo 被监听器自身写入的自动快照误拦（内容哈希回显检测）
- prune 从未真正执行，自动快照无限堆积；保留上限现在真正生效
- 双加载 bug(社区反馈）:bundle 安装不再追加手动挂载，并清理历史遗留
- README 安装命令指向错误仓库名

## [0.0.1] - 2026-08-14

本地原型：配置变更快照 + undo / redo,后并入 0.1.0。
