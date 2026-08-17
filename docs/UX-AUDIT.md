# Echo Notes 本次新增界面 UX 审计报告

> 审计基线：`.agents/skills/echo-notes-design`（项目设计规范）+ `product-design:audit` 方法。
> 审计范围：本次未提交的三个新界面——记忆中心、审核中心/收件箱、关系建议。
> 生成时间：2026-08-15 ｜ Obsidian 1.12.7 ｜ 插件 0.4.20 ｜ 证据目录：`output/playwright/settings-ui/`

## 1. 结论速览

**总体：架构与证据边界做得扎实，主要问题集中在无障碍与信息密度，没有 P0 阻断项。**

三个新界面延续了「安静、可信、原生 Obsidian」的设计语言：全程只用 Obsidian 主题变量（无硬编码 hex）、层级徽标有清晰语义色、AI 候选/证据/人工闸口边界文案到位、无横向溢出。短板集中在：记忆中心 Tab 的无障碍不完整（缺 `aria-controls`、无键盘方向键导航、无 `focus-visible`）、收件箱卡片信息过载、以及若干空态文案缺少「下一步动作」。

| 维度 | 评价 |
| --- | --- |
| 视觉/层级 | 好。变量统一，层级靠留白与排版，无装饰性堆砌。 |
| 证据与人工闸口 | 好。「AI 只提出候选，经你确认才进入长期记忆」「证据：…」「关系不会自动建立」等边界清晰。 |
| 空/错/加载态 | 中。错误态给出方向；主空态只解释现状、未邀请行动。 |
| 无障碍 | 中偏弱。Tab 缺 aria-controls、方向键导航与 focus-visible；移动端触控目标不足 44px。 |
| 信息架构 | 中。收件箱卡片字段过载；总览「记忆首页/已应用记忆」疑似重复入口。 |
| 响应式 | 好。1280/375 视口下 `documentOverflow/contentOverflow = 0`，弹窗均不横向溢出。 |

## 1.1 计划执行结果（2026-08-15）

本轮按上述优先级完成了可逆的界面与交互改进，未新增 Vault 数据结构、迁移或外部 API 变更。记忆中心已从弹窗改为记忆设置阶段内与「提取规则」「维护工具」并列的 Tab：

- 记忆中心 Tab 补齐 `aria-controls`、`tabpanel`、方向键/Home/End 导航与可见焦点；角标标记为辅助技术隐藏；去掉重复的「已应用记忆」入口，改为明确的「审核中心」。
- 审核中心将候选卡整理为「AI 候选 → 原文证据 → 你的决定」证据轨；AI 判断依据、关联建议和高级动作渐进披露；批量批准与「设为核心并批准」增加二次确认；空态提供「选择转写稿并提取」。
- 关系建议改为「先选关系类型，再确认」两步流程，「无关系」改成准确的「忽略本次」，避免把暂不采纳误读为删除。
- 设置页在新人指引已开始/完成/关闭后使用紧凑摘要，工作流阶段显示「已就绪/当前待配置/待配置」，外部 Agent 保持禁用并标注规划中。
- 移动端新人指引提供「配置离线转写」入口，并明确桌面端录音、快捷键与完整指引的边界；任务中心空态提供「打开新人指引」。
- Personal Agent 上下文包明确「全部」筛选选项、字符预算说明和零结果提示，术语统一为「Personal Agent 上下文包」。

当前验证：`npm run verify:settings-ui` 通过（Obsidian 1.12.7，`runtimeErrors: 0`，桌面/窄屏及明暗主题截图与布局断言通过）；`npm run typecheck` 通过。关系建议弹窗的真机触控与读屏复核仍属于后续人工验收，不由截图替代。

## 2. 审计范围与方法

- **对象**：完整使用链路，包括 `src/settings/settings-tab.ts`、`src/getting-started/getting-started-guide.ts`、`src/task-center/task-center-view.ts`、三个记忆中心界面、`src/memory/memory-context-modal.ts` 及其在 `styles.css` 中的样式块。
- **证据**：重跑 `npm run verify:settings-ui` 通过（`runtimeErrors: 0`）；再以隔离 Obsidian Vault 定向补拍三界面，覆盖桌面 1280 与移动 375 视口、明暗两套主题，以及收件箱两条空态、关系建议空态。
- **不覆盖**：真实录音/转写/AI 链路、真机录音权限与读屏器体验、真实 provider 计费链路及发布状态。截图只证明视觉与布局，不证明真实 AI 链或发布状态。

## 3. 基线分界面发现（实施前）

### 3.1 记忆中心（`memory-center-modal.ts`）

截图：`memory-center-overview-desktop-1280-light.png` ｜ `memory-center-overview-mobile-content-375-light.png`（同组含 dark）

- **[P1] Tab 无障碍不完整（缺 aria-controls 与 tabpanel）**。Tab 已设 `role="tab"`、`aria-selected`、`tabindex`，但未设置 `aria-controls`，两个面板也没有 `role="tabpanel"`/`id`。截图度量确认 `tabs[].hasControls = false`。证据：`memory-center-modal.ts:64,76,88-89`。
- **[P1] Tab 只支持点击，无方向键/Home/End 键盘导航**。`createTab` 只注册 `click`，未处理 `keydown`（ArrowLeft/Right/Home/End）。证据：`memory-center-modal.ts:80`。
- **[P1] Tab 无 `:focus-visible` 样式**。`button.echo-notes-memory-center-tab` 只有 `:hover` 与 `.is-active`，键盘聚焦不可见；而既有设置页/任务中心 Tab 均有 focus-visible。证据：`styles.css` 无对应规则（对照 `styles.css:982,2150`）。
- **[P2] 层级徽标「核心」复用交互强调色**。`is-core` 用 `var(--interactive-accent)`，与链接、激活 Tab、CTA 同色，弱化了「最高优先级」的语义，也易与可点击元素混淆。证据：`styles.css:3923-3926`。
- **[P2] 总览快捷入口疑似重复**。「记忆首页」与「已应用记忆」两个入口的 onClick 都是 `openHome()`，用户无法区分两者。证据：`memory-center-modal.ts:234,236`。
- **[P2] 审核中心 Tab 的角标未 aria-hidden**。角标数字会被读作 Tab 名称的一部分（实测可访问名含「4」）。证据：`memory-center-modal.ts:127`。

### 3.2 审核中心/收件箱（`memory-inbox-modal.ts`）

截图：`memory-inbox-desktop-1280-light.png` ｜ `memory-inbox-mobile-content-375-light.png` ｜ `memory-inbox-empty-desktop-1280-light.png` ｜ `memory-inbox-filtered-empty-desktop-1280-light.png`

- **[P1] 卡片信息过载**。单卡默认展开约 10 个信息块（勾选、标题、层级、元信息、内容、为什么值得记住、采纳理由、证据、来源、相关建议），再加编辑区与 4 个操作按钮，首屏可读性差。建议把「为什么值得记住 / 采纳理由 / 证据 / 相关建议」折叠进 `<details>`（与编辑区的渐进披露同模式）。证据：`memory-inbox-modal.ts:224-332`。
- **[P2] 单卡 4 操作与顶部 4 批量操作并存，主次不清晰**。批准/拒绝/设为核心/重置 × 批准已选/拒绝已选/拒绝低优先级/批准工作记忆，同一屏幕 8 类动作易让用户犹豫。「设为核心」与「批准」结果也容易混淆。证据：`memory-inbox-modal.ts:167-170,316-332`。
- **[P2] 主空态未邀请行动**。「目前没有待审核的记忆候选。新的候选会在下一次提取后出现在这里。」只解释现状，未给出「去转写/提取记忆」的下一步（筛选空态「请调整筛选条件」是合格的）。证据：`memory-inbox-modal.ts:77`。
- **[P2] 移动端触控目标不足 44px**。按钮实测最小高度 30px，低于规范 44px；Tab 高 36px。注：375px 为内容区模拟，非原生移动验收。证据：截图度量 `minButtonHeight = 30`；`styles.css:3781`（tab `min-height:36px`）。
- **正向确认**：4 档层级统计、筛选排序、证据引用、人工闸口提示「关系不会自动建立，需在审核后人工确认」均正确，证据边界做得到位。

### 3.3 关系建议（`memory-relation-suggestion-modal.ts`）

截图：`memory-relation-suggestion-desktop-1280-light.png` ｜ `memory-relation-suggestion-mobile-content-375-light.png` ｜ `memory-relation-suggestion-empty-desktop-1280-light.png`

- **[P2] 「无关系」按钮用 `x` 图标，语义易被误读**。`x` 视觉上接近「关闭/删除/拒绝」，与「忽略此建议」的真实意图不符，建议换 `minus` / `circle-slash` 或纯文字。证据：`memory-relation-suggestion-modal.ts:68-69`。
- **[P2] 空态无下一步动作**。「没有发现可能相关的历史记忆。」未说明何时会再次出现或可做何事。证据：`memory-relation-suggestion-modal.ts:48`。
- **[P1] 无 `:focus-visible`**。该弹窗按钮均无可见键盘焦点样式（与 3.1 的 Tab 同一问题，建议统一补）。证据：`styles.css` 无对应规则。
- **正向确认**：顶部明确「默认不会建立任何关系，请逐条确认」，且逐条「无关系/建议类型」按钮符合人工闸口边界。

## 4. 修复优先级清单

### P1（无障碍，建议优先）

1. 记忆中心 Tab：补 `aria-controls` 指向面板 id，面板加 `role="tabpanel"`/`id`；补方向键/Home/End 键盘导航；补 `:focus-visible`。
2. 三个新界面全部可交互控件补 `:focus-visible`（2px `var(--interactive-accent)` outline + offset），与既有组件对齐。
3. 收件箱卡片：把次要字段（为什么值得记住 / 采纳理由 / 证据 / 相关建议）折叠进渐进披露。

### P2（体验打磨）

4. 「无关系」按钮更换图标或改纯文字。
5. 主空态与关系建议空态补充下一步动作文案。
6. 总览「记忆首页 / 已应用记忆」去重或改名为两个明确不同的动作。
7. 层级徽标 `is-core` 改回语义色（如 `--color-orange` 或专用核心色），避免与交互色混用。
8. 移动端把高频操作（批准/拒绝）触控目标提到 ≥44px；Tab 角标加 `aria-hidden`。

## 5. 证据限制

- 截图来自隔离测试 Vault 的渲染结果，只证明视觉/布局与 DOM 度量，不证明真实录音/AI 链路或发布状态。
- 焦点/键盘/对比度结论来自代码与 DOM 度量，未做真实键盘与读屏器自动化；标注为「待人工复核」。
- 375px 是内容区模拟，不是原生移动端验收；移动端结论需真机复测。
- 未截图捕获加载态与错误态（`renderOverview` 的 loading/error 为瞬时或需故障注入），文案已按代码静态核对。

## 附：本次证据文件

- `output/playwright/settings-ui/summary.json`（重跑基线，`runtimeErrors: 0`）
- `output/playwright/settings-ui/ux-audit-summary.json`（定向补拍度量）
- `output/playwright/settings-ui/memory-center-current-*`、`memory-inbox-current-*`（本轮验证脚本补拍，桌面 1280 与窄屏 375，明暗主题）
- `output/playwright/settings-ui/memory-center-overview-*`、`memory-inbox-*`、`memory-relation-suggestion-*`（16 张定向截图）
