# Echo Notes 架构

## 模块边界

| 模块 | 责任 | 当前主要文件 |
| --- | --- | --- |
| 插件编排 | 命令、任务生命周期、自动化、Ribbon 与状态栏 | `src/main.ts` |
| 音频 | 实时采集、分段、内存释放、进度事件 | `src/audio/` |
| Provider 适配 | 请求协议、能力差异、错误规范化 | `src/providers/` |
| 转写稿 | 路径、frontmatter、托管区块、人工内容保护 | `src/transcript/` |
| AI 分析 | 配置预检、分块、模板、结果写回 | `src/analysis/` |
| Echo Memory | 初始化、候选包、审核 sidecar、记忆关系、会议页、画像、跨记录聚合与上下文包编译 | `src/memory/` |
| Obsidian IO | 文件、编辑器、链接操作 | `src/obsidian/` |
| 安全与隐私 | SecretStorage、脱敏、上传预览、自动化排除 | `src/security/`、`src/privacy/` |
| 任务中心 | 任务状态、恢复上下文、百炼远端任务暂停/取消语义、展示与重试入口 | `src/task-center/` |

## 数据与状态边界

### Vault 真源

- 原始音频文件。
- `.transcript.md` 完整转写稿、分析元数据和 AI 分析托管区块。
- 未完成长音频 transcript 内的 `echo-notes-checkpoint` 注释 JSON；它只在源音频与无密钥配置指纹匹配时复用，成功完成后移除。
- 未完成长文本分析在同一 transcript 内按模板隔离的 `echo-notes-analysis-checkpoint` 注释 JSON；身份绑定实际发送正文、模板、Provider、模型、Base URL、语言、脱敏与分块配置。每块最多保留最终汇总实际使用的 12,000 字符，不含密钥或 raw response，成功写入最终分析后移除。
- 未完成 Echo Memory 长文本提取在 `99 系统/echo-memory-checkpoints.json`（英文目录为 `99 System`）中的共享 JSON；按 transcript 路径隔离，身份绑定来源正文、候选输入、纳入分析、初始化用户、Schema/Prompt/Pipeline、Provider、Base URL 指纹、模型、语言和分块配置。只保存已通过证据校验的结构化断言，每块最多 24,000 字符，不含密钥、完整请求或 raw response。
- Echo Memory 按断言逐条严格校验 `evidenceQuote`：混合响应只保留能在当前分块逐字定位的断言，并在检查点、候选包、Task Center 摘要和运行日志记录拒绝数量；若非空响应中的断言全部无法定位，任务仍失败。被拒绝内容和 Provider 原始响应不持久化。
- 用户确认的已批准记忆关系保存在 `99 系统/echo-memory-relations.json`（英文目录为 `99 System`）；记录冲突、补充、替代或作废语义、两端候选/审核/transcript 快照及不可追加覆盖的确认和撤销历史。
- Echo Memory 会议页、候选包、同目录 `.review.md` 审核 sidecar、人物/组织/项目/User 画像、`05 聚合` 下的项目/人物/时间线视图、`06 上下文包` 和运行日志。
- Echo Memory 的 `07 转写增强/术语与上下文.md` 同时提供可读审计表格和插件托管 JSON。转写请求只消费已批准、作用域匹配且完成关系解析的术语与记忆快照；诊断只保存 ID、数量和内容指纹。
- 候选包内的插件托管 JSON 保留模型提取结果；审核 sidecar 记录状态、修正值和事件历史；关系存储记录跨候选的人工判断。三者共同构成编译真源，画像与跨记录聚合都是可重建派生结果。

### 插件设置与 SecretStorage

- `data.json` 保存设置和最多 100 条 Task Center 摘要。百炼异步摘要可额外保存 `task_id`、提交时间、远端状态和无密钥配置指纹；不保存音频、转写正文、模型响应、临时 OSS 凭证、签名 URL 或 API Key。
- API Key 按用途和 Provider 分别保存在 Obsidian `SecretStorage`。
- 插件重启时，持久化为 `running` 的任务会转成明确的中断失败状态，并按恢复上下文重新绑定重试动作。

### 仅运行时状态

- 正在处理的 Promise、AbortController、WebSocket、MediaStream、文件写入队列和 UI 回调。
- 这些对象不能序列化；持久化层只记录安全重建它们所需的最小参数。

## 主链路

1. `src/main.ts` 解析用户命令或自动化事件并创建任务。
2. Provider 在发出请求前完成本地配置检查，音频 Provider 通过统一进度事件报告分段状态。
3. `TranscriptService` 只替换受托管 transcript 区块，保留自定义 frontmatter、人工正文和分析结果。
4. AI 分析读取最终 transcript，按需分块；每块成功后通过 `vault.process` 合并检查点，失败或重启时只复用严格匹配的连续前缀，最终汇总成功写回托管区块后清理该模板检查点。
5. Echo Memory 读取 transcript 与本次选中的成功分析，按需分块提取；每块成功后通过 `vault.process` 合并共享检查点，只复用身份、连续序号、边界、文本指纹、Provider、模型和证据定位全部匹配的前缀。
6. 完整分块结果生成 Schema v2 的证据型候选包（六种记忆类型、working/long-term 时效、可选准入理由与时间范围）、默认待审核的 sidecar、清单记录和会议页；可选画像编译完成后只删除当前 transcript 的检查点条目，清理失败仅记日志，不逆转成功状态。
7. 用户在 Obsidian Modal 中批准、修正、拒绝或重置候选断言，审核 sidecar 只替换 `echo-memory-review:managed` 区块。
8. 用户可在另一 Modal 中为同主体、不同候选的已批准断言确认或撤销冲突、补充、替代与作废关系；关系通过 `vault.process` 写入独立 JSON，不修改候选或审核 sidecar。
9. 编译只消费已批准断言和仍匹配当前生效值的关系；替代/作废排除目标，冲突/补充保留两端并显示关系 ID 与回链。审核值变化使旧关系安全失效，撤销后重建恢复目标。
10. 同一编译计划只把长期断言（或缺少时效的 legacy 断言）写入主体画像，工作记忆保留在项目、人物、时间线三份跨记录视图；聚合只遍历候选目录，按观察时间稳定排序，并分别替换 `echo-memory:managed` 与 `echo-memory-aggregation:managed` 区块。首页聚合导航也使用独立托管区块。
11. `create-personal-agent-context-package` 读取同一份当前生效记忆集合，在本地 Modal 中预览项目/人物/日期、记忆类型、时效过滤和字符预算；确认后只替换 `echo-memory-context:managed` 区块并打开 `06 上下文包` 文件，不发起外部请求。

## 已知架构债

- `src/main.ts` 同时承担编排、任务恢复、UI 与多条业务流程，后续应按转写、分析和 Memory 工作流拆分协调器。
- `tests/smoke-tests.ts` 和 `scripts/verify-settings-ui.mjs` 仍是大型测试入口；MemoryService 的 Vault 级故障恢复已有隔离 Obsidian 覆盖，但后续应按工作流拆分测试模块。
- 关系判断完全依赖人工选择，尚无可解释的候选发现、批量审核或多审核人身份。
- 项目与人物聚合及上下文包复用显式主体规范化，不做语义实体消歧；当前也没有主题视图、语义检索或外部 Agent 执行动作。
