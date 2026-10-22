import { defaultLocalAsrReadinessUrl } from "./lifecycle-settings";

export type AsrDiscoveryField = "startCommand" | "stopCommand" | "workingDirectory" | "readinessUrl";
export interface AsrDiscoveryValue { value: string; source: string; status: "identified" | "candidate" | "missing" }
export interface AsrDiscoveryCandidate {
	id: string;
	directory: string;
	label: string;
	fields: Record<AsrDiscoveryField, AsrDiscoveryValue>;
	complete: boolean;
	issues: string[];
}
export interface AsrDiscoveryFile { relative: string; directory: string; name: string; text: string; sha256: string }
export interface AsrDiscoverySnapshot { files: AsrDiscoveryFile[]; pythonDirectories: string[] }
export const ASR_DISCOVERY_FIELDS: readonly AsrDiscoveryField[] = ["startCommand", "stopCommand", "workingDirectory", "readinessUrl"];
export const ASR_DISCOVERY_LABELS: Record<AsrDiscoveryField, string> = {
	startCommand: "启动命令", stopCommand: "关闭命令", workingDirectory: "工作目录", readinessUrl: "就绪检查地址"
};
export const MLX_LIFECYCLE_SIGNATURES: Readonly<Record<string, string>> = Object.freeze({
	"start.sh": "be8f2984b72136f292f583d079ad33ebd70c3b0306181fe9f99f23564d0516d9",
	"stop.sh": "2dbdd9ef4d3a73b41c2f58f60947a05ef55e0a2b023e70aa8affad78c7728532",
	"control.py": "757a014afc68a38ac195f7c8f3b2c3f725495eedb1fa5eb66ad492339cde56d0"
});

export function quotePosixArgument(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function emptyFields(): Record<AsrDiscoveryField, AsrDiscoveryValue> {
	const missing = (): AsrDiscoveryValue => ({ value: "", source: "未找到可确认的配置", status: "missing" });
	return { startCommand: missing(), stopCommand: missing(), workingDirectory: missing(), readinessUrl: missing() };
}

/** Pure, static identification. Neither manifest text nor script names authorize execution. */
export function identifyAsrInstallations(
	snapshot: AsrDiscoverySnapshot, context: { baseUrl: string; platform: string; arch: string }
): AsrDiscoveryCandidate[] {
	const readiness = defaultLocalAsrReadinessUrl(context.baseUrl);
	const endpoint = new URL(readiness);
	const port = endpoint.port || "80";
	const groups = new Map<string, AsrDiscoveryFile[]>();
	for (const file of snapshot.files) {
		const group = groups.get(file.directory) ?? [];
		group.push(file); groups.set(file.directory, group);
	}
	const candidates: AsrDiscoveryCandidate[] = [];
	for (const [directory, files] of groups) {
		const byName = new Map(files.map(file => [file.name.toLowerCase(), file]));
		const signed = Object.entries(MLX_LIFECYCLE_SIGNATURES).every(([name, hash]) => byName.get(name)?.sha256 === hash);
		const fields = emptyFields();
		const issues: string[] = [];
		let complete = false;
		if (signed) {
			if (context.platform !== "darwin" || context.arch !== "arm64") issues.push("配套 MLX 服务的自动配置仅支持 Apple Silicon macOS；请手动核对当前平台。" );
			if (!snapshot.pythonDirectories.includes(directory)) issues.push("缺少可执行的 .venv/bin/python，请先完成服务运行环境安装。" );
			if (!byName.has("service.py")) issues.push("缺少 service.py，请选择完整的服务安装目录。" );
			const manifest = byName.get("bundle-manifest.json");
			if (manifest) {
				try {
					const value: unknown = JSON.parse(manifest.text);
					const hashes = value && typeof value === "object" && "files" in value ? value.files : null;
					if (!hashes || typeof hashes !== "object" || Object.entries(MLX_LIFECYCLE_SIGNATURES).some(([name, hash]) => !(name in hashes) || (hashes as Record<string, unknown>)[name] !== hash)) {
						issues.push("目录中的服务清单与已支持的启停脚本不一致，请手动核对。" );
					}
				} catch { issues.push("服务清单无法解析，请手动核对安装内容。" ); }
			}
			complete = issues.length === 0;
			if (complete) {
				for (const [field, action] of [["startCommand", "start"], ["stopCommand", "stop"]] as const) {
					fields[field] = { value: `/bin/sh ${quotePosixArgument(`${directory}/${action}.sh`)} --root ${quotePosixArgument(directory)} --port ${port}`,
						source: `${action}.sh / control.py：已支持的脚本摘要匹配`, status: "identified" };
				}
				fields.readinessUrl = { value: readiness, source: "配套服务 /health；端口取自当前 Base URL", status: "identified" };
			}
		} else {
			const docs = files.filter(file => /^(?:readme|deployment)(?:\.[\w-]+)*\.(?:md|txt)$/i.test(file.name));
			const startScripts = files.filter(file => /^(?:start|run|launch|serve)(?:[._-].*)?\.(?:sh|cmd|bat|ps1)$/i.test(file.name));
			for (const doc of docs) {
				// Only explicitly labelled launch sections and fenced command lines are candidates.
				const match = doc.text.match(/(?:^|\n)#{1,6}\s*(?:启动|start|launch)[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/i);
				const fenced = match?.[1].match(/```(?:sh|bash|shell|powershell|cmd)?\s*\n([^\n]+)\n```/i);
				const command = fenced?.[1].trim().replace(/^\$\s+/, "");
				if (command && command.length <= 2048 && !command.includes("\0") && !/[\r\n]/.test(command) && !/\b(?:pkill|killall|sudo|curl|wget)\b/i.test(command)) {
					fields.startCommand = { value: command, source: `${doc.relative}：启动命令段，参数仍需核对`, status: "candidate" };
					break;
				}
			}
			if (!startScripts.length && !fields.startCommand.value && !byName.has("control.py")) continue;
			issues.push("未匹配完整适配器；脚本名称不能证明参数或停止范围，请按服务文档补充。" );
			if (startScripts.length && !fields.startCommand.value) fields.startCommand.source = `${startScripts.map(file => file.relative).join("、")}；需核对启动参数`;
			const stop = files.find(file => /^(?:stop|shutdown)(?:[._-].*)?\.(?:sh|cmd|bat|ps1)$/i.test(file.name));
			if (stop) fields.stopCommand.source = `${stop.relative}：仅作为文件线索，停止范围尚未确认`;
		}
		fields.workingDirectory = { value: directory, source: "所选目录内的服务文件位置", status: "identified" };
		candidates.push({ id: directory, directory, label: signed ? "配套 MLX ASR 服务" : "其他 ASR 服务 · 配置待补充", fields, complete, issues });
	}
	return candidates.sort((a, b) => Number(b.complete) - Number(a.complete) || a.directory.localeCompare(b.directory));
}
