# Echo Notes 测试交付与跨 agent 接续

本流程将源码开发、测试安装和正式发布分开：Codex 形成 Trellis 计划，Pi 在持久 worktree 实施并自动测试，部署到人工测试目录，人工重新加载验收，批准后由 Codex 或 Pi 合并及发布。

## 五阶段角色路由

固定分工以根目录 `AGENTS.md` 为准：**Codex 计划 → Pi 开发与自动测试 → Pi 部署 → 人工验证批准 → Codex 或 Pi 发布审核**。Codex 不因计划获批而自动接管开发和部署；Codex 子代理不能代替跨工具的 Pi 交接。用户明确指定本次例外时单独记录。

Codex 的计划交付至少包含 `prd.md`、所需 `design.md`、`implement.md`、`test-plan.md`、有效的 `implement.jsonl/check.jsonl` 和 `handoff.md`。handoff 写清源码基线、计划及原型批准情况、实际或拟用分支/worktree、执行命令、验收标准、已完成项、阻塞和下一负责人。不把待确认项写成通过。

## 规划完成后自动生成接手消息

Codex 每次完成或修订规划时，必须在任务 `handoff.md` 的“复制给 Pi Agent”章节保存接手消息，并在最终回复的同名位置附上完全相同的 `text` 代码块。收到新的需求或批准后同步更新。不得只提供链接，也不等待用户另问。

以下模板用于生成，实际输出必须填入已核实值，删除不适用项，不保留占位符。计划/原型批准状态按真实用户证据填写；没有原型要求时写“不适用”。涉及原型时提供实际绝对路径、SHA-256 和 review 入口。缺少必要批准时，执行句必须改成“请先只读核对交接；等待〔具体缺失的批准〕后再开始实施”，不得擅自代用户声明已批准。已有批准不重复询问。

可直接交给 Pi 的消息模板：

```text
请接手 Echo Notes 的 Trellis 任务：<任务绝对路径>。
交接入口：<handoff.md 绝对路径>。
本次范围：<已确认变更与重要边界>。
计划批准：<实际状态及证据>。原型批准：<实际状态及证据，或不适用>。
原型：<需要时填写绝对路径、SHA-256、review.md 入口>。
先读取项目 AGENTS.md、echo-notes-development Skill 和本任务 handoff、prd、design、implement、test-plan 及 JSONL 引用。
你负责第 2、3 阶段：在核实计划及必要原型已获批准后，按计划在 /Users/anbang/.local/share/echo-notes/worktrees/ 下的持久 worktree 实施，保存本地功能分支提交，同步未占用的新版本，运行 npm run package 完成完整验证与打包。
通过 npm run test-install -- deploy 部署到 /Users/anbang/笔记/Develop-obsidian/.obsidian/plugins/echo-notes，只替换 main.js、manifest.json、styles.css，保留配置；核实安装占用并遵守工具的锁、备份与恢复要求。
保留已确认需求和必要原型批准门槛。交付包、源码提交、验证证据与安装产物必须一致。
完成后提供版本、源码提交、ZIP 绝对路径及 SHA-256、安装文件哈希、验证报告、未验证项和功能验收步骤。告诉我在 Develop-obsidian 点击“重新加载第三方插件”验证，等待人工批准；不得提前合并主分支、推送、Tag、Release 或提交官方审核。
接手后记录实际执行者、worktree 和开始状态；发现计划缺口反馈给 Codex，普通实现问题自行继续修复。
```

“计划可交接”和“Pi 已启动”分别记录；未收到接手证据时统一标记“待 Pi 接手”。只有真正收到 Pi 的接手或执行证据才更新执行状态；没有可用启动通道时交付上述消息，不默认改由 Codex 实施。人工批准后可把同一任务交回 Codex，发布执行者先核实当前交付及批准记录。

## 目录与前置条件

| 用途 | 固定位置 |
| --- | --- |
| 功能 worktree | `/Users/anbang/.local/share/echo-notes/worktrees/<任务名>` |
| 持久交付 | `/Users/anbang/.local/share/echo-notes/deliveries/<交付ID>` |
| 安装备份 | `/Users/anbang/.local/share/echo-notes/backups/` |
| 人工插件安装 | `/Users/anbang/笔记/Develop-obsidian/.obsidian/plugins/echo-notes` |

安装位置必须是普通目录，主工作区和 worktree 均不作为安装目标。CLI 使用固定路径，不支持任意 `--target`。自动 UI 验证从当前源码工作区复制产物到隔离临时 Vault，不读取人工安装配置。唯一源码不能存放在系统临时目录。

先读取项目开发 Skill 及当前 Trellis 任务，核对实时 Git、版本和脚本。中央 Skill 的旧源码软链接要求及人工批准前禁止本地提交条款被项目新约定替代。中央发布门禁和生产 Vault 禁止访问规则仍有效。

## Codex 计划与 Pi 接手

1. Codex 在任务目录记录基线提交、已确认范围、原型和批准证据、实施步骤、验证矩阵及 `handoff.md`；不将计划批准视为原型批准。
2. Pi 核实已有分支用途，在持久目录创建或接续 worktree。将必要未跟踪的 AGENTS、Skill、Spec、任务与原型文件显式复制，检查普通文件和链接目标，运行任务 JSONL 验证；不复制其他会话运行态、其他任务、笔记、测试数据或凭据。
3. 原任务入口记录实际 worktree、分支、执行者和交接摘要。执行期间只在 worktree 内维护任务进度，阶段交接回传证据快照；不让两处同时修改计划。
4. Pi 在本地功能分支提交本任务实现，保留已批准原型和必要治理上下文。人工批准前可本地 stage/commit，不能合并主分支、推送、打 Tag 或发布。Trellis 的自动提交开关保持关闭。
5. 自动测试、人工验收及审核分别留证；不修改 Trellis 内置状态枚举，不用“完成”替代尚未执行的验收。

## Pi：一次迁移

```bash
npm run test-install -- migrate
npm run test-install -- status
```

迁移只接受已核实的旧布局，沿用原安装版本。按 obsidian-cli Skill 核实 CLI 能力，显式指定 `vault=Develop-obsidian` 安全暂停 Echo Notes；若不能安全暂停，请人工关闭该测试库，不退出其他 Vault。备份原软链接、三个插件产物和配置，再改为普通安装目录，核对一致性并恢复原启用状态。

仅在本次迁移中原样复制可选的 `data.json`，不解析、不输出、不上传，备份仅存本地，不打入交付包；SecretStorage 保留原 Vault。其他文件先核实插件归属，不复制整个源码仓库。失败恢复原软链接及配置。迁移完成只表示安装位置已分离，不表示任何旧任务功能已经开发完成。

## Pi：构建与部署

Pi 先完成实现及版本同步，保存本地功能分支提交，再在对应 worktree 执行：

```bash
npm run package
npm run test-install -- deploy --task .trellis/tasks/<任务目录> --zip dist/echo-notes-<版本>.zip
npm run test-install -- status
```

- 使用真实任务及 ZIP 路径替换示例；以打包命令实际返回位置为准。部署验证源码已保存、完整验证报告有效、版本一致、ZIP 清单和路径安全，且包内三个文件与已验证产物一致。
- 命令将源码 bundle、必要上下文、ZIP、验证报告和来源记录保存到持久交付目录；后续清理 `dist` 不应影响该交付。
- 只替换 `main.js`、`manifest.json`、`styles.css`，绝不部署配置或向主工作区复制产物。副作用命令互斥，使用暂存、旧产物备份和事务恢复；中断后先恢复一致状态。
- 人工安装一次只承载一个待验收任务。同一任务修复后可更新包；不同任务须等当前交付存在完整发布记录，不能自动抢占。更新、回退及源码或产物变化使旧批准失效。

持久工作根的 `current.json` 指向当前交付；`transaction.json` 表示未完成事务。每个交付目录包含：

| 工件 | 用途 |
| --- | --- |
| `delivery.json` | 任务、worktree、源码提交、版本、ZIP 和三个文件哈希及部署来源 |
| `verification.json` | 本次完整自动验证记录 |
| `source.bundle` | 已保存的源码提交 |
| `context/` | 必要治理与任务工件快照 |
| `echo-notes-<版本>.zip` | 与验证记录绑定的测试包 |
| `approval.json` | 当前交付的真实人工批准，批准前不存在 |
| `release.json` | 实际完成的发布与审核状态记录，发布前不存在 |

`status` 是只读检查，须用于交接时核对当前安装、交付记录和批准绑定；不能把文件存在当作人工批准有效。

## 人工验证、恢复与批准

交付时提供 ZIP 绝对路径、版本、SHA-256、实际安装路径和一致性结果、验证报告、未验证范围以及功能入口、触发条件和预期结果。统一状态为“测试包及测试库加载产物已就绪，待人工重新加载插件验证”。

人工在 Develop-obsidian 设置中关闭再启用 Echo Notes，无需解压 ZIP；版本未刷新时重启 Obsidian。agent 不代替人工最终验收，不把磁盘部署成功表述为运行中已经加载。

```bash
npm run test-install -- rollback
npm run test-install -- status
```

`rollback` 优先恢复未完成事务；正常情况下恢复 previous 指针对应的三个产物，保留当前配置，不恢复旧配置。恢复旧功能包后仍需新的人工批准；回退到迁移基线只表示恢复原安装版本，不生成虚假的源码验证或人工批准。发现文件异常或恢复失败时保持失败状态和备份，不报告就绪，不手工删除事务以绕过保护。

人工发现问题后，由 Pi 在原 worktree 修复、升版本、重新完整验证及部署，再次等待批准。接续 agent 只能根据用户对当前交付的真实批准写入 `approval.json`，不得自动制造批准。字段为：

- `deliveryId`、`sourceCommit`、`zipSha256`、`fileHashes`：对应批准的交付及三个文件。
- `approvedAt`、`approvedBy`、`userQuote`：批准时间、批准者和真实用户原话。

## 批准后 Codex 或 Pi 发布

1. 接续同一任务，读取交付记录、实际安装状态及人工批准，核实绑定一致且没有后续修改。
2. 若主分支变化，先在功能分支整合并重新验证；改变待发布源码、依赖或产物后重新部署和取得人工批准。不能把旧包批准用于新包。
3. 按中央发布流程连续执行必要合并、推送、新 Tag、GitHub Release、三个远端资产及 attestation 核验，然后按版本和提交幂等触发 Obsidian 官方审核。不得仅凭本地测试声称发布或审核通过。
4. 发布后记录 `release.json` 的 `deliveryId`、`sourceCommit`、`tag`、`releaseUrl`、`reviewStatus`、`completedAt`。时间和状态按真实证据填写；审核 Pending 不等于通过。
5. 登录、权限、资产不一致和审核 Required 等实质阻塞按中央流程报告。发布及源码留存核实前保留 worktree 与交付；不自动清理待人工验收成果。

本次流程建设不恢复丢失的五模型源码，不追认其原型或测试通过，也不自动执行任何旧任务的外部发布。
