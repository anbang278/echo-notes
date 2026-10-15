# 本机服务与控制台切换记录

仅在插件和本地服务的当前验收范围通过后执行。准备包、生成计划不会停止或更新已安装服务。正式切换由主执行者完成；本次实现子代理未更新 `18080` 或 `~/Applications/MLX ASR 控制台.app`。

固定目标：

- 运行目录：`/Users/anbang/.local/share/echonotes-asr`
- 控制台：`/Users/anbang/Applications/MLX ASR 控制台.app`
- 备份：`/Users/anbang/.local/share/echo-notes/backups`
- 解释器：运行目录既有 `.venv/bin/python`

脚本仅更新服务包明确列出的 Python、Shell、说明、依赖锁、模型清单及控制台。`.venv`、Hugging Face 缓存、日志、配置、现存任务与其他文件保留。它不安装依赖、不修改 Obsidian 配置，也不启动或停止进程。旧代码与 App 按文件哈希备份；计划绑定包 SHA-256、原安装哈希及新哈希。

## 1. 核验并暂停

保存 `service-package-evidence.json` 和完整验证报告，并记录原服务运行/停止状态。先停止独立 `18081` 实例，避免两个实例占用 MLX；关闭已打开的控制台窗口，防止旧程序触发启动。

```
/Users/anbang/.local/share/echonotes-asr/.venv/bin/python /Users/anbang/.local/share/echo-notes/worktrees/local-openai-transcription/integrations/local-mlx-asr/control.py stop --root /Users/anbang/.local/share/echo-notes/local-openai-test --port 18081
```

检查 `18080` 的进程身份与当前任务；没有监听时直接准备。已有任务时先请求取消并等待终态，不截断进行中的推理。旧运行目录尚未升级，需使用其原 `control.py stop`，不要用新脚本猜测旧的整数 PID 文件。调用旧停止命令前，核实记录 PID 的实际 argv 指向 `/Users/anbang/.local/share/echonotes-asr/service.py 18080`；不匹配时不得发送信号。停止后确认 `18080` 空闲。

```
/Users/anbang/.local/share/echonotes-asr/.venv/bin/python /Users/anbang/.local/share/echonotes-asr/control.py stop
```

## 2. 准备可审查事务

以下 `PACKAGE`、`SHA256` 替换为同一份 `service-package-evidence.json` 的真实值，不填旧包摘要；所有路径必须为普通目录。

```
/Users/anbang/.local/share/echonotes-asr/.venv/bin/python deploy_service.py prepare --package PACKAGE --sha256 SHA256 --runtime /Users/anbang/.local/share/echonotes-asr --app '/Users/anbang/Applications/MLX ASR 控制台.app' --backups /Users/anbang/.local/share/echo-notes/backups --port 18080
```

命令打印独立 `plan.json` 路径。回读它，核对 `state=prepared`、目标路径、包摘要、版本及 `before/after`。`original/` 为回退副本，`staged/` 是已校验的新文件；这一步不会更新安装文件。

## 3. 执行与核验

```
/Users/anbang/.local/share/echonotes-asr/.venv/bin/python deploy_service.py apply --plan PLAN_JSON
/Users/anbang/.local/share/echonotes-asr/.venv/bin/python /Users/anbang/.local/share/echonotes-asr/control.py start --port 18080
/Users/anbang/.local/share/echonotes-asr/.venv/bin/python /Users/anbang/.local/share/echonotes-asr/control.py status --port 18080
```

`apply` 获取运行目录锁和全实例 MLX 锁，拒绝被占用的端口、准备后发生的文件变化和包变化；逐文件原子替换，完成后复核全部哈希。异常时尝试恢复所有原文件；进程中断时下一步使用下方 `rollback` 恢复。`state=applied` 只证明文件安装，启动 `status=ready`、服务标识、协议与两个模型 ID 需另行核验。调用 `/health`、`/v1/local-asr/capabilities`、`/v1/models` 只读取状态，不新增长推理。保留完整事务目录。

若原服务处于停止状态，以上启动仅用于健康检查；检查后立即执行 `control.py stop --port 18080`，保留原来的停止状态，避免人工验收前占用模型内存。后续由用户手动启动控制台。

## 4. 回退

先用新运行目录的 `control.py stop --port 18080` 正常停止新服务，再执行：

```
/Users/anbang/.local/share/echonotes-asr/.venv/bin/python deploy_service.py rollback --plan PLAN_JSON
/Users/anbang/.local/share/echonotes-asr/.venv/bin/python /Users/anbang/.local/share/echonotes-asr/control.py start
```

回退脚本只接受本事务已安装的哈希、原哈希或中断留下的缺失文件；检测到其他修改即停止，防止覆盖后续成果。恢复后要求 `state=rolled_back` 且全部原哈希匹配。旧控制台与服务再次启动的健康状态独立验证。不要删除缓存、旧源码或备份来处理启动失败。
