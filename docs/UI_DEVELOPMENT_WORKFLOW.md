# Echo Notes 用户界面研发流程

本流程适用于 Echo Notes 的用户可见新页面、新弹窗、新的多步骤交互，以及会改变信息架构、文案层级或主操作的较大改版。

## 核心规则

> No Prototype, No UI Implementation.

先确认用户体验，再还原工程实现。HTML 原型是产品/UX 设计源，不是临时演示稿。

以下改动必须先经过原型评审：

- 新增页面、Modal、ItemView 或新的主要入口。
- 新增多步骤流程、审核流程、配置流程或状态转换。
- 改变首屏认知、信息架构、主次 CTA、默认信息量或渐进披露方式。

以下改动可以直接进入工程修复，但仍需通过对应的 UI 验证：

- 不改变任务流的错别字、文案微调、间距和对齐修复。
- 不改变行为的颜色变量、主题适配、键盘焦点和触控目标修复。
- 明确的运行时错误、溢出或无障碍缺陷修复。

## 固定阶段

```text
需求/问题
  ↓
现状审计与用户任务
  ↓
UX Brief（五个问题 + 状态矩阵）
  ↓
三个视觉/信息架构方向
  ↓ 用户选择
单文件 HTML 交互原型
  ↓ 用户书面确认
UI Freeze（版本 + SHA-256）
  ↓
Obsidian 工程还原
  ↓
Design QA + 本地验证
```

### UX Brief 必答

1. 用户为什么来到这里？
2. 用户最重要的一个动作是什么？
3. 第一眼应该理解什么，而不是看到哪些字段？
4. 默认用户需要知道多少，哪些能力必须渐进展开？
5. 页面有哪些首次、正常、处理中、成功、失败、空态和高级状态？

### 原型要求

- 原型使用脱敏 Mock 数据，不调用真实 Provider，不读取 Vault，不保存真实 API Key。
- 原型必须能直接打开；最终交付采用单文件 `index.html`，CSS、JavaScript 和 Mock 数据内嵌。
- 视觉遵循 `echo-notes-design`：Obsidian 主题变量、安静层级、可信证据边界、清晰的下一步动作。
- AI 候选、原文证据、用户决定必须保持可区分；任何“自动成为事实”的暗示都不合格。
- 375px 内容宽度下不允许横向溢出，主要触控目标不小于 44px。

### 冻结与解冻

每个功能目录的 `review.md` 记录：

- `status`：`draft`、`direction_selected`、`in_review`、`approved`、`implemented`。
- 原型版本、所选方向、SHA-256、验证结果、用户确认原文和实现偏差。

只有用户明确书面确认原型后，才能将状态改为 `approved` 并进入 `src/` 还原。批准后 HTML 内容或哈希发生变化，必须退回 `in_review`，重新确认。

工程实现允许为了 Obsidian 原生组件、主题变量、响应式和无障碍做技术适配，但任何可见的信息架构、文案、CTA 或状态行为偏差都必须记录并重新确认。

## Echo Notes 特殊边界

- Memory 继续遵循“AI 管理 Proposal，用户拥有 Truth”：Candidate 是不可变审计真源，Review 保存用户判断，Profile/Timeline/Context 是可重建派生视图。
- `记忆 Base URL` 与 `记忆配置自检` 只属于 Memory → `提取设置`，不得在高级维护或其他页面重复出现。
- 本流程不改变 Provider、SecretStorage、设置键、命令 ID、候选/审核 Schema 或 Vault 路径。
- 研发、验证和截图只能针对 `/Users/anbang/笔记/Develop-obsidian` 或隔离临时 Vault；禁止操作生产 Vault。

## 验证入口

```bash
npm run verify:prototype -- <feature-slug>
npm run verify:settings-ui
npm test
npm run lint
npm run typecheck
npm run build
npm run verify
git diff --check
```

截图、Mock 和自动化结果只能证明原型或 UI 的交互、布局与运行时行为，不证明真实 Provider、计费、录音链路或发布状态。
