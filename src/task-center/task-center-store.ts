export type EchoNotesTaskKind = "transcription" | "analysis" | "memory";
export type EchoNotesTaskStatus = "running" | "success" | "failed" | "skipped";

export type EchoNotesTaskRecovery =
	| {
		kind: "transcription";
		audioPath: string;
		sourcePath?: string;
		audioLinkPath?: string;
	}
	| {
		kind: "analysis";
		transcriptPath: string;
		templateId: string;
	}
	| {
		kind: "memory-extraction";
		transcriptPath: string;
		analysisTemplateIds?: string[];
	}
	| {
		kind: "memory-rebuild";
	};

export interface EchoNotesTaskRetry {
	label: string;
	run: () => Promise<void> | void;
	allowWhileRunning?: boolean;
}

export interface EchoNotesTask {
	id: string;
	kind: EchoNotesTaskKind;
	title: string;
	status: EchoNotesTaskStatus;
	stage: string;
	provider?: string;
	model?: string;
	targetPath: string;
	sourcePath?: string;
	outputPath?: string;
	bytes?: number;
	currentSegment?: number;
	totalSegments?: number;
	error?: string;
	traceId?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	recovery?: EchoNotesTaskRecovery;
	retry?: EchoNotesTaskRetry;
}

export type PersistedEchoNotesTask = Omit<EchoNotesTask, "retry">;

export interface TaskCenterState {
	schemaVersion: 1;
	tasks: PersistedEchoNotesTask[];
}

export const EMPTY_TASK_CENTER_STATE: TaskCenterState = {
	schemaVersion: 1,
	tasks: []
};

const MAX_PERSISTED_TASKS = 100;
const MAX_PERSISTED_ERROR_LENGTH = 4000;

export interface EchoNotesTaskCounts {
	running: number;
	success: number;
	failed: number;
	skipped: number;
	total: number;
}

type EchoNotesTaskInput = Omit<EchoNotesTask, "createdAt" | "updatedAt"> & Partial<Pick<EchoNotesTask, "createdAt" | "updatedAt">>;
type EchoNotesTaskPatch = Partial<Omit<EchoNotesTask, "id" | "kind" | "targetPath" | "createdAt">>;
type TaskCenterListener = () => void;

export class TaskCenterStore {
	private tasks = new Map<string, EchoNotesTask>();
	private listeners = new Set<TaskCenterListener>();
	private retryingTasks = new Set<string>();

	upsertTask(input: EchoNotesTaskInput): EchoNotesTask {
		const now = Date.now();
		const existing = this.tasks.get(input.id);
		const task: EchoNotesTask = {
			...existing,
			...input,
			createdAt: existing?.createdAt ?? input.createdAt ?? now,
			updatedAt: input.updatedAt ?? now
		};
		this.tasks.set(task.id, task);
		this.notify();
		return task;
	}

	restartTask(input: EchoNotesTaskInput): EchoNotesTask {
		const now = Date.now();
		const task: EchoNotesTask = {
			...input,
			createdAt: input.createdAt ?? now,
			updatedAt: input.updatedAt ?? now
		};
		this.tasks.set(task.id, task);
		this.notify();
		return task;
	}

	updateTask(id: string, patch: EchoNotesTaskPatch): EchoNotesTask | null {
		const existing = this.tasks.get(id);
		if (!existing) {
			return null;
		}

		const task: EchoNotesTask = {
			...existing,
			...patch,
			updatedAt: Date.now()
		};
		this.tasks.set(id, task);
		this.notify();
		return task;
	}

	getTasks(): EchoNotesTask[] {
		return Array.from(this.tasks.values()).sort((left, right) => right.updatedAt - left.updatedAt);
	}

	restoreTasks(tasks: readonly EchoNotesTask[]): void {
		this.tasks = new Map(tasks.map((task) => [task.id, task]));
		this.notify();
	}

	subscribe(listener: TaskCenterListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async retryTask(id: string): Promise<boolean> {
		const task = this.tasks.get(id);
		if (
			!task?.retry ||
			(task.status === "running" && !task.retry.allowWhileRunning) ||
			this.retryingTasks.has(id)
		) {
			return false;
		}

		this.retryingTasks.add(id);
		try {
			await task.retry.run();
			return true;
		} finally {
			this.retryingTasks.delete(id);
		}
	}

	clearFinishedTasks(): void {
		for (const [id, task] of this.tasks) {
			if (task.status !== "running") {
				this.tasks.delete(id);
			}
		}
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export function createTaskCenterState(tasks: readonly EchoNotesTask[]): TaskCenterState {
	return {
		schemaVersion: 1,
		tasks: [...tasks]
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.slice(0, MAX_PERSISTED_TASKS)
			.map(({ retry: _retry, ...task }) => {
				const persisted: PersistedEchoNotesTask = { ...task };
				if (task.error) {
					persisted.error = task.error.slice(0, MAX_PERSISTED_ERROR_LENGTH);
				} else {
					delete persisted.error;
				}
				const recovery = cloneRecovery(task.recovery);
				if (recovery) {
					persisted.recovery = recovery;
				} else {
					delete persisted.recovery;
				}
				return persisted;
			})
	};
}

export function normalizeTaskCenterState(value: unknown): TaskCenterState {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.tasks)) {
		return { schemaVersion: 1, tasks: [] };
	}

	const tasks = value.tasks
		.map(parsePersistedTask)
		.filter((task): task is PersistedEchoNotesTask => Boolean(task))
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, MAX_PERSISTED_TASKS);
	return { schemaVersion: 1, tasks };
}

export function markInterruptedTasks(
	tasks: readonly PersistedEchoNotesTask[],
	now = Date.now()
): PersistedEchoNotesTask[] {
	return tasks.map((task) => {
		if (task.status !== "running") {
			return task;
		}
		return {
			...task,
			status: "failed",
			stage: "插件重启前任务已中断",
			error: "任务在 Echo Notes 插件停止或 Obsidian 重启时仍未完成，请确认已有输出后重试。",
			updatedAt: now,
			completedAt: now
		};
	});
}

export function createTaskId(kind: EchoNotesTaskKind, targetPath: string, qualifier?: string): string {
	return [kind, normalizeTaskIdPart(targetPath), qualifier ? normalizeTaskIdPart(qualifier) : ""].join(":");
}

export function summarizeTaskCounts(tasks: EchoNotesTask[]): EchoNotesTaskCounts {
	return tasks.reduce(
		(counts, task) => {
			counts[task.status] += 1;
			counts.total += 1;
			return counts;
		},
		{ running: 0, success: 0, failed: 0, skipped: 0, total: 0 }
	);
}

export function formatTaskBytes(bytes: number | undefined): string {
	if (bytes === undefined) {
		return "未知大小";
	}

	if (bytes < 1024) {
		return `${bytes} B`;
	}

	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatTaskElapsedTime(task: EchoNotesTask, now = Date.now()): string {
	const endTime = task.completedAt ?? now;
	const elapsedMs = Math.max(0, endTime - task.createdAt);
	const elapsedSeconds = Math.round(elapsedMs / 1000);
	if (elapsedSeconds < 60) {
		return `${elapsedSeconds}s`;
	}

	const minutes = Math.floor(elapsedSeconds / 60);
	const seconds = elapsedSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

function normalizeTaskIdPart(value: string): string {
	return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function parsePersistedTask(value: unknown): PersistedEchoNotesTask | null {
	if (!isRecord(value)) {
		return null;
	}
	const kind = readEnum(value.kind, ["transcription", "analysis", "memory"] as const);
	const status = readEnum(value.status, ["running", "success", "failed", "skipped"] as const);
	const id = readRequiredString(value.id);
	const title = readRequiredString(value.title);
	const stage = readRequiredString(value.stage);
	const targetPath = readRequiredString(value.targetPath);
	const createdAt = readTimestamp(value.createdAt);
	const updatedAt = readTimestamp(value.updatedAt);
	if (!kind || !status || !id || !title || !stage || !targetPath || createdAt === null || updatedAt === null) {
		return null;
	}

	const task: PersistedEchoNotesTask = {
		id,
		kind,
		title,
		status,
		stage,
		targetPath,
		createdAt,
		updatedAt
	};
	assignOptionalString(task, "provider", value.provider);
	assignOptionalString(task, "model", value.model);
	assignOptionalString(task, "sourcePath", value.sourcePath);
	assignOptionalString(task, "outputPath", value.outputPath);
	assignOptionalString(task, "traceId", value.traceId);
	assignOptionalString(task, "error", value.error, MAX_PERSISTED_ERROR_LENGTH);
	assignOptionalNumber(task, "bytes", value.bytes);
	assignOptionalNumber(task, "currentSegment", value.currentSegment);
	assignOptionalNumber(task, "totalSegments", value.totalSegments);
	assignOptionalNumber(task, "completedAt", value.completedAt);
	const recovery = parseRecovery(value.recovery);
	if (recovery) {
		task.recovery = recovery;
	}
	return task;
}

function parseRecovery(value: unknown): EchoNotesTaskRecovery | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	switch (value.kind) {
		case "transcription": {
			const audioPath = readRequiredString(value.audioPath);
			if (!audioPath) {
				return undefined;
			}
			return {
				kind: "transcription",
				audioPath,
				sourcePath: readOptionalString(value.sourcePath),
				audioLinkPath: readOptionalString(value.audioLinkPath)
			};
		}
		case "analysis": {
			const transcriptPath = readRequiredString(value.transcriptPath);
			const templateId = readRequiredString(value.templateId);
			return transcriptPath && templateId
				? { kind: "analysis", transcriptPath, templateId }
				: undefined;
		}
		case "memory-extraction": {
			const transcriptPath = readRequiredString(value.transcriptPath);
			if (!transcriptPath) {
				return undefined;
			}
			const analysisTemplateIds = Array.isArray(value.analysisTemplateIds)
				? value.analysisTemplateIds
					.map(readRequiredString)
					.filter((item): item is string => Boolean(item))
					.slice(0, 20)
				: undefined;
			return {
				kind: "memory-extraction",
				transcriptPath,
				analysisTemplateIds: analysisTemplateIds?.length ? analysisTemplateIds : undefined
			};
		}
		case "memory-rebuild":
			return { kind: "memory-rebuild" };
		default:
			return undefined;
	}
}

function cloneRecovery(recovery: EchoNotesTaskRecovery | undefined): EchoNotesTaskRecovery | undefined {
	if (!recovery) {
		return undefined;
	}
	return recovery.kind === "memory-extraction"
		? { ...recovery, analysisTemplateIds: recovery.analysisTemplateIds ? [...recovery.analysisTemplateIds] : undefined }
		: { ...recovery };
}

function assignOptionalString(
	task: PersistedEchoNotesTask,
	key: "provider" | "model" | "sourcePath" | "outputPath" | "traceId" | "error",
	value: unknown,
	maxLength = 1000
): void {
	const parsed = readOptionalString(value, maxLength);
	if (parsed !== undefined) {
		task[key] = parsed;
	}
}

function assignOptionalNumber(
	task: PersistedEchoNotesTask,
	key: "bytes" | "currentSegment" | "totalSegments" | "completedAt",
	value: unknown
): void {
	const parsed = readTimestamp(value);
	if (parsed !== null) {
		task[key] = parsed;
	}
}

function readRequiredString(value: unknown): string | null {
	const parsed = readOptionalString(value);
	return parsed ?? null;
}

function readOptionalString(value: unknown, maxLength = 1000): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function readTimestamp(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
	return typeof value === "string" && allowed.includes(value as T) ? value as T : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
