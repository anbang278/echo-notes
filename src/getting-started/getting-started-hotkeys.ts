import type { Hotkey, Modifier } from "obsidian";
import {
	cloneHotkey,
	formatHotkey,
	parseHotkeyInput,
	type EchoNotesHotkeySetting
} from "../settings/settings";

export type GettingStartedHotkeyId = "start" | "stop" | "transcribe";
export type GettingStartedHotkeyPlatform = "macOS" | "windows";

export interface GettingStartedHotkeys {
	start: EchoNotesHotkeySetting;
	stop: EchoNotesHotkeySetting;
	transcribe: EchoNotesHotkeySetting;
}

export interface GettingStartedHotkeyValidation {
	valid: boolean;
	missing: GettingStartedHotkeyId[];
	duplicates: GettingStartedHotkeyId[][];
}

export interface HotkeyCommandAssignment<Id extends string = string> {
	id: Id;
	commandId: string;
	hotkey: EchoNotesHotkeySetting;
}

export interface HotkeyCommandDefinition {
	name?: string;
}

export interface HotkeyManagerReader {
	getHotkeys?: (commandId: string) => Hotkey[] | undefined;
	getDefaultHotkeys?: (commandId: string) => Hotkey[] | undefined;
}

export interface HotkeyManagerWriter extends HotkeyManagerReader {
	setHotkeys(commandId: string, hotkeys: Hotkey[]): void;
	save(): Promise<void> | void;
}

export interface HotkeyAssignmentSaveResult<Id extends string> {
	saved: boolean;
	conflicts: Partial<Record<Id, string[]>>;
	error?: unknown;
	rollbackError?: unknown;
	rollback?: () => Promise<void>;
}

export function getRecommendedGettingStartedHotkeys(
	platform: GettingStartedHotkeyPlatform
): GettingStartedHotkeys {
	return platform === "macOS"
		? {
			start: parseHotkeyInput("Ctrl+L") ?? null,
			stop: parseHotkeyInput("Ctrl+S") ?? null,
			transcribe: parseHotkeyInput("Ctrl+Z") ?? null
		}
		: {
			start: parseHotkeyInput("Alt+L") ?? null,
			stop: parseHotkeyInput("Alt+A") ?? null,
			transcribe: parseHotkeyInput("Alt+Z") ?? null
		};
}

export function fillMissingGettingStartedHotkeys(
	hotkeys: GettingStartedHotkeys,
	recommended: GettingStartedHotkeys
): GettingStartedHotkeys {
	return {
		start: cloneHotkey(hotkeys.start ?? recommended.start),
		stop: cloneHotkey(hotkeys.stop ?? recommended.stop),
		transcribe: cloneHotkey(hotkeys.transcribe ?? recommended.transcribe)
	};
}

export function captureHotkeyFromKeyboardEvent(event: KeyboardEvent): Hotkey | undefined {
	if (event.key === "Escape" || event.key === "Tab") {
		return undefined;
	}
	if (event.key === "Control" || event.key === "Meta" || event.key === "Shift" || event.key === "Alt") {
		return undefined;
	}

	const modifiers: Modifier[] = [];
	if (event.ctrlKey) {
		modifiers.push("Ctrl");
	}
	if (event.metaKey) {
		modifiers.push("Meta");
	}
	if (event.shiftKey) {
		modifiers.push("Shift");
	}
	if (event.altKey) {
		modifiers.push("Alt");
	}
	const parsed = parseHotkeyInput([...modifiers, event.key].join("+"));
	return parsed ?? undefined;
}

export function cloneGettingStartedHotkeys(hotkeys: GettingStartedHotkeys): GettingStartedHotkeys {
	return {
		start: cloneHotkey(hotkeys.start),
		stop: cloneHotkey(hotkeys.stop),
		transcribe: cloneHotkey(hotkeys.transcribe)
	};
}

export function validateGettingStartedHotkeys(
	hotkeys: GettingStartedHotkeys
): GettingStartedHotkeyValidation {
	const ids: GettingStartedHotkeyId[] = ["start", "stop", "transcribe"];
	const missing = ids.filter((id) => !hotkeys[id]);
	const groups = new Map<string, GettingStartedHotkeyId[]>();
	for (const id of ids) {
		const formatted = formatHotkey(hotkeys[id]);
		if (!formatted) {
			continue;
		}
		const group = groups.get(formatted) ?? [];
		group.push(id);
		groups.set(formatted, group);
	}
	const duplicates = [...groups.values()].filter((group) => group.length > 1);
	return {
		valid: missing.length === 0 && duplicates.length === 0,
		missing,
		duplicates
	};
}

export function hotkeysEqual(
	left: EchoNotesHotkeySetting,
	right: EchoNotesHotkeySetting
): boolean {
	return formatHotkey(left) === formatHotkey(right);
}

/**
 * 统一检查待写入快捷键与其他命令的有效绑定。批量写入时忽略本批次内会被
 * 一并替换的命令；批次内部重复由 validateGettingStartedHotkeys 单独处理。
 */
export function findHotkeyAssignmentConflicts<Id extends string>(
	assignments: readonly HotkeyCommandAssignment<Id>[],
	commands: Readonly<Record<string, HotkeyCommandDefinition>>,
	manager: HotkeyManagerReader
): Partial<Record<Id, string[]>> {
	const replacedCommandIds = new Set(assignments.map((assignment) => assignment.commandId));
	const result: Partial<Record<Id, string[]>> = {};
	for (const assignment of assignments) {
		const formatted = formatHotkey(assignment.hotkey);
		if (!formatted) {
			continue;
		}
		const labels = Object.entries(commands)
			.filter(([commandId]) => !replacedCommandIds.has(commandId))
			.filter(([commandId]) => getEffectiveHotkeys(manager, commandId)
				.some((hotkey) => formatHotkey(hotkey) === formatted))
			.map(([commandId, command]) => command.name?.trim() || commandId);
		const uniqueLabels = [...new Set(labels)].slice(0, 3);
		if (uniqueLabels.length > 0) {
			result[assignment.id] = uniqueLabels;
		}
	}
	return result;
}

/**
 * 在任何 setHotkeys 调用前完成整批冲突检查。失败时恢复原绑定；成功结果
 * 暴露 rollback，供后续设置持久化失败时恢复快捷键管理器状态。
 */
export async function saveHotkeyAssignments<Id extends string>(
	assignments: readonly HotkeyCommandAssignment<Id>[],
	commands: Readonly<Record<string, HotkeyCommandDefinition>>,
	manager: HotkeyManagerWriter
): Promise<HotkeyAssignmentSaveResult<Id>> {
	const conflicts = findHotkeyAssignmentConflicts(assignments, commands, manager);
	if (Object.keys(conflicts).length > 0) {
		return { saved: false, conflicts };
	}

	const originalHotkeys = new Map(
		assignments.map((assignment) => [
			assignment.commandId,
			getEffectiveHotkeys(manager, assignment.commandId).map((hotkey) => cloneHotkey(hotkey)!)
		])
	);
	let rolledBack = false;
	const rollback = async (): Promise<void> => {
		if (rolledBack) {
			return;
		}
		rolledBack = true;
		for (const [commandId, hotkeys] of originalHotkeys) {
			manager.setHotkeys(commandId, hotkeys.map((hotkey) => cloneHotkey(hotkey)!));
		}
		await manager.save();
	};

	try {
		for (const assignment of assignments) {
			manager.setHotkeys(
				assignment.commandId,
				assignment.hotkey ? [cloneHotkey(assignment.hotkey)!] : []
			);
		}
		await manager.save();
		return { saved: true, conflicts, rollback };
	} catch (error) {
		try {
			await rollback();
			return { saved: false, conflicts, error };
		} catch (rollbackError) {
			return { saved: false, conflicts, error, rollbackError };
		}
	}
}

function getEffectiveHotkeys(manager: HotkeyManagerReader, commandId: string): Hotkey[] {
	const customHotkeys = manager.getHotkeys?.(commandId);
	if (Array.isArray(customHotkeys)) {
		return customHotkeys;
	}
	return manager.getDefaultHotkeys?.(commandId) ?? [];
}
