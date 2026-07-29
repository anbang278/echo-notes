export type EchoNotesTaskKind = "transcription" | "analysis" | "memory";
export type EchoNotesTaskStatus = "running" | "success" | "failed" | "skipped";

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
	retry?: EchoNotesTaskRetry;
}

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
