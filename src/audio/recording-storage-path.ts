import type { RecordingStorageSettings } from "../settings/settings";

/** 路径校验必须发生在任何 normalizePath 之前，避免吞掉越界输入。 */
export function validateRecordingFolder(value: string, allowRoot = false): string | null {
	if (!value.trim()) return "录音目录不能为空。";
	if (allowRoot && value === ".") return null;
	if (/^[~/\\]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) return "录音目录必须是库内相对路径，不能使用绝对路径或 URL。";
	if (/[\\<>:"|?*]/.test(value) || Array.from(value).some((char) => char.charCodeAt(0) < 32)) return "录音目录包含非法字符。";
	const parts = value.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part !== part.trim() || /[. ]$/.test(part))) return "录音目录不能包含空路径段、父级跳转或末尾空格和句点。";
	if (parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return "录音目录不能使用系统保留名称。";
	return null;
}

export function validateRecordingStorage(settings: RecordingStorageSettings): string | null {
	if (settings.strategy === "note-subfolder") return validateRecordingFolder(settings.subfolder);
	if (settings.strategy === "custom-folder") return validateRecordingFolder(settings.customFolder, true);
	return null;
}

/** null 表示由 Obsidian 附件设置解析；空字符串表示库根目录。 */
export function resolveRecordingFolder(settings: RecordingStorageSettings, sourcePath = ""): string | null {
	const error = validateRecordingStorage(settings);
	if (error) throw new Error(error);
	const parent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
	switch (settings.strategy) {
		case "same-folder": return parent;
		case "note-subfolder": return parent ? `${parent}/${settings.subfolder}` : settings.subfolder;
		case "custom-folder": return settings.customFolder === "." ? "" : settings.customFolder;
		default: return null;
	}
}
