# dsh-undo-savepoint 发布与文档规范

> 本仓库版本号、commit、tag、Release、双语文档的固定格式。2026-08-23 起执行；历史条目只归一格式，不改写 git 历史。

## 一、版本号

**格式：`vMAJOR.MINOR.PATCH`（SemVer 三段，带 `v` 前缀）。** tag、Release 标题、`package.json` 的 `version`（无 `v`）三处必须一致。

| 段 | 何时递增 | 示例 |
|---|---|---|
| MAJOR | 快照/清单格式不兼容（旧版插件读不了新快照）、使用方式破坏性变化 | v0.5.0（如重排快照仓库结构） |
| MINOR | 新功能、新工具、新平台支持 | v0.4.0（全平台适配） |
| PATCH | bug 修复、文案、文档、内部强化 | v0.4.1（macOS 回声快照修复） |

**硬规则（历史上都踩过）：**

1. 禁止四段版本号（`0.3.3.1` 事故——非 semver，方式 A 安装被 pnpm 拒绝，见 issue #5）
2. 版本号一旦对外出现（commit / 文档 / release）**绝不回收复用**（`0.4.0→0.3.1` 回退事故——发布前预留的版本号被降级复用，导致 migration 文档版本引用错乱）
3. 发布前三查：`package.json` version == tag == Release 标题；`npm run check-version` 绿

## 二、Commit 消息

**格式：`<type>(<scope>?): <中文描述>`**（type 用英文标准词，描述统一中文，一条 commit 一个意图）

| type | 用途 | 仓库实例 |
|---|---|---|
| `feat` | 新功能 | `feat(webui): 时间线按日期分组卡片化` |
| `fix` | bug 修复 | `fix(host): 会话运行中拒绝撤销，防 HMR 连锁中断` |
| `docs` | 文档 | `docs: README 截图改走 jsDelivr CDN` |
| `chore` | 构建/配置/杂务 | `chore(ci): 补跑 home-resolution 回归` |
| `test` | 测试 | `test: smoke 174→189（消息级撤销/孤儿GC）` |
| `refactor` | 重构 | `refactor(core): 快照引擎抽为纯 Node 零依赖` |
| `perf` | 性能 | `perf(zip): 条目名归一化提升读兼容` |
| `ci` | CI 专属 | `ci: 升级三平台 × node[20,22] 矩阵` |
| `release` | **发版专用** | `release: v0.4.2` |

**scope 可选**，取值：`host` / `webui` / `cli` / `ps1` / `core` / `ci` / `docs`。

**细则：**

- 发版 commit 固定写 `vX.Y.Z 摘要A + 摘要B (修复 #N ...)`，版本号后不加冒号（历史 `v0.4.3: 摘要` 冒号格式 2026-08-31 起停用），变更明细放 CHANGELOG，commit body 最多列 3-5 条要点（不再把十几项塞标题）
- 关联 issue：描述尾部 `(#12)`；解决型用 `fix: ... (closes #12)`
- 破坏性变更：`feat!:` 或 `feat(host)!:`，body 里写迁移说明
- 内部规划编号（R1 / P6 / D7 / Scenario A 等）**不进 commit 信息**，描述直接写功能本身
- 中英不混写：type 英文 + 描述中文，不再出现全英文句式 commit（`Fix double-load bug (community report)` 这类历史遗留不再新增）

## 三、Tag 与 Release

**Tag：`vX.Y.Z`**，打在对应 `release:` commit 上，与 Release 同步创建（现状已符合，固化）。

**Release 标题固定：`vX.Y.Z`**（纯版本号，主题看正文；不再出现 `v0.3.8 — 安全模式 2.0`、`dsh-undo-savepoint v0.4.1` 等变体）。

**Release 正文固定模板：**

```markdown
vX.Y.Z · YYYY-MM-DD

## 亮点
（最多 3 条，一句话一条，面向用户价值）

## 新增
- ...

## 修复
- ...

## 升级注意
（无则整节省略；写破坏性变化与迁移要点）

## 安装
dsh plugin --profile web add github:lire1131/dsh-undo-savepoint#master
（已装用户：dsh plugin --profile web update dsh-undo-savepoint）

完整变更见 [CHANGELOG](https://github.com/lire1131/dsh-undo-savepoint/blob/master/CHANGELOG.md#0xy---yyyy-mm-dd)。
```

**细则：**

- 日期格式统一 `YYYY-MM-DD`；正文中文（英文用户看 CHANGELOG.en.md，Release 只维护中文）
- 禁止内部规划编号、禁止注入器模板自动文（`dev_release_plugin` 发布后手动按本模板补写）
- patch 版「新增」段可省，但不能空模板发布

## 四、双语文档

- `README.md` / `README.en.md`、`CHANGELOG.md` / `CHANGELOG.en.md`、`docs/migration.md` / `migration.en.md` 成对维护：**改了中文必须同步英文**，commit 里两者一起进
- 中文版全角标点（，。：；（）、！？），英文版半角；代码 span（`` ` `` 内）、URL、命令行除外
- 功能描述里的版本注记（「v0.3.8 起」）只允许出现在 CHANGELOG 与迁移文档；README 描述现状，不写演进史

## 五、CHANGELOG

- 遵循 Keep a Changelog；每版本段名只用：**新增 / 变更 / 优化 / 修复 / 安全 / 测试**（「入口」「CI」内容并入「变更」）
- 版本标题 `## [X.Y.Z] - YYYY-MM-DD`，新版本在最上
- 面向用户语言：写「做了什么、为什么」，内部实现细节（函数名、哈希机制）只在影响理解时保留

## 六、内部规划编号

R1-R4 / P1-P7 / B4-B6 / I13 / D7 / Scenario A 等编号只存在于内部任务清单；对外产物（commit / Release / CHANGELOG / README / docs）一律翻译成功能描述。

## 七、叙述文本

> 2026-08-31 起执行。适用于对外叙述性文字（版本 commit 标题、Release / CHANGELOG 条目正文、issue 与 PR 回复正文、README 功能描述）。结构性格式符号不受此限（见第 4 条）。

1. **禁用修辞**：不用比喻、排比、感叹、口号式表述；只写事实、原因、结果（做了什么、为什么、实测表现）。形容词仅在传达可验证信息时保留（如「明确的错误信息」），不写渲染性形容（如「焕然一新」「重磅」）。
2. **禁用破折号（——）**：一律不出现，用逗号、句号或括号衔接。英文文本同样不用 em dash（—）。
3. **禁用冒号引导叙述**：版本 commit 标题不写 `vX.Y.Z: 摘要`，直接 `vX.Y.Z 摘要`；叙述句内部不接冒号长串。条目格式必需的结构性冒号除外（`**标题**：`、`type(scope):` 前缀、表格、命令示例）。
4. **结构性符号不受限**：commit type 前缀冒号、CHANGELOG 条目标题冒号、代码块、命令行、表格、markdown 标题、列表标记属于格式骨架，照常使用。
