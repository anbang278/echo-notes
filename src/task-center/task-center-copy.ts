import type { GettingStartedStatus } from "../getting-started/getting-started-state";
import type { EchoNotesTask, EchoNotesTaskKind, EchoNotesTaskStatus } from "./task-center-store";

export type TaskCenterSection = "guide" | "tasks";

export interface TaskFailureGuidance {
	causedBy: string;
	nextStep: string;
}

export interface TaskCenterFilters {
	status: EchoNotesTaskStatus | "all";
	kind: EchoNotesTaskKind | "all";
	query: string;
}

export function filterTaskCenterTasks(
	tasks: readonly EchoNotesTask[],
	filters: TaskCenterFilters
): EchoNotesTask[] {
	const query = filters.query.trim().toLocaleLowerCase();
	return tasks.filter((task) => {
		if (filters.status !== "all" && task.status !== filters.status) {
			return false;
		}
		if (filters.kind !== "all" && task.kind !== filters.kind) {
			return false;
		}
		if (!query) {
			return true;
		}
		return [task.title, task.stage, task.sourcePath, task.targetPath, task.outputPath, task.error]
			.filter((value): value is string => Boolean(value))
			.some((value) => value.toLocaleLowerCase().includes(query));
	});
}

export function getTaskNextStep(task: EchoNotesTask): string {
	if (task.status === "running") {
		return task.totalSegments ? `等待完成（${task.currentSegment ?? 0}/${task.totalSegments}）` : "等待完成，可在这里查看实时进度";
	}
	if (task.status === "paused") {
		return "点击“继续跟踪”恢复原百炼任务；云端可能仍在执行并计费";
	}
	if (task.status === "cancelled") {
		return "云端任务已取消，无需继续处理";
	}
	if (task.status === "failed") {
		return task.retry ? "按“重试”重新执行；仍失败时展开技术详情" : "检查输入和设置，再回到命令重试";
	}
	if (task.status === "skipped") {
		return "确认跳过原因，需要时打开目标文件继续处理";
	}
	return task.kind === "memory" ? "点击“立即审核”确认候选记忆" : "打开输出文件查看结果";
}

export function getDefaultTaskCenterSection(status: GettingStartedStatus): TaskCenterSection {
	return status === "not-started" || status === "in-progress" ? "guide" : "tasks";
}

export function getTaskPathDisplayName(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

export function formatTaskDetailsForClipboard(task: EchoNotesTask): string {
	const lines = [
		`任务：${task.title}`,
		`类型：${getKindLabel(task.kind)}`,
		`状态：${getTaskStatusLabel(task.status)}`,
		`阶段：${task.stage}`,
		`服务商：${task.provider ?? "未记录"}`,
		`模型：${task.model ?? "未记录"}`,
		`目标：${task.targetPath}`
	];
	if (task.sourcePath) {
		lines.push(`完整来源路径：${task.sourcePath}`);
	}
	if (task.outputPath) {
		lines.push(`完整输出路径：${task.outputPath}`);
	}
	if (task.traceId) {
		lines.push(`Trace ID：${task.traceId}`);
	}
	if (task.error) {
		lines.push(`错误：${task.error}`);
	}
	return lines.join("\n");
}

export function getTaskFailureGuidance(kind: EchoNotesTaskKind, error: string): TaskFailureGuidance {
	const normalized = error.toLocaleLowerCase();
	if (normalized.includes("api key") || normalized.includes("apikey") || error.includes("密钥") || error.includes("API Key")) {
		return {
			causedBy: "当前阶段没有可用的服务商密钥，或密钥未被 Obsidian SecretStorage 读取。",
			nextStep: `打开 Echo Notes 设置的${getKindLabel(kind)}配置，保存对应 API Key 后重试。`
		};
	}
	if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("network") || normalized.includes("fetch") || normalized.includes("http")) {
		return {
			causedBy: "服务商请求没有在限定时间内完成，可能是网络、地址或服务端暂时不可用。",
			nextStep: "检查网络和 Base URL，确认模型可用后稍等片刻再重试；原始错误可在技术详情中查看。"
		};
	}
	if (error.includes("格式不支持") || normalized.includes("unsupported") || error.includes("仅支持")) {
		return {
			causedBy: "当前文件或运行环境不满足该服务商的输入要求。",
			nextStep: "确认音频格式、Vault 类型和设备支持范围，必要时切换到兼容的离线服务商。"
		};
	}
	return {
		causedBy: `${getKindLabel(kind)}没有完成，插件已保留本次任务和原始错误。`,
		nextStep: "先查看下方下一步提示，完成配置或检查输入后重试；不确定时展开技术详情。"
	};
}

export function getTaskFailureNotice(kind: EchoNotesTaskKind, error: string): string {
	const guidance = getTaskFailureGuidance(kind, error);
	return `${getKindLabel(kind)}未完成：${guidance.causedBy} 已在任务中心保留“${guidance.nextStep}”和技术详情。`;
}

function getKindLabel(kind: EchoNotesTaskKind): string {
	switch (kind) {
		case "transcription":
			return "转写";
		case "analysis":
			return "AI 分析";
		case "memory":
			return "记忆提取";
	}
}

function getTaskStatusLabel(status: EchoNotesTaskStatus): string {
	switch (status) {
		case "running":
			return "进行中";
		case "success":
			return "成功";
		case "failed":
			return "失败";
		case "skipped":
			return "已跳过";
		case "paused":
			return "已暂停跟踪";
		case "cancelled":
			return "已取消";
	}
}
