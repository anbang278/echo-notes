import type { MemoryPaths, MemoryUserCategory } from "./memory-types";

export const MEMORY_USER_PROFILE_TITLES: Record<MemoryUserCategory, { zh: string; en: string }> = {
	"mission-goal": { zh: "使命与目标", en: "Mission and Goals" },
	"decision-principle": { zh: "决策原则", en: "Decision Principles" },
	"mental-model": { zh: "思维模型", en: "Mental Models" },
	lesson: { zh: "叙事与教训", en: "Stories and Lessons" },
	"idea-challenge": { zh: "想法与挑战", en: "Ideas and Challenges" },
	"writing-collaboration": { zh: "写作与协作偏好", en: "Writing and Collaboration Preferences" },
	background: { zh: "个人背景与成长", en: "Background and Growth" },
	"privacy-boundary": { zh: "隐私与授权边界", en: "Privacy and Authorization Boundaries" }
};

export function buildMemoryPaths(rootFolder: string, language: "zh" | "en"): MemoryPaths {
	const root = normalizeMemoryRoot(rootFolder);
	const names = language === "en"
		? {
			home: "00 Home.md",
			meetings: "01 Meetings",
			candidates: "02 Memory Candidates",
			entities: "03 Entities",
			people: "People",
			organizations: "Organizations",
			projects: "Projects",
			user: "04 User",
			system: "99 System",
			logs: "Run Logs"
		}
		: {
			home: "00 首页.md",
			meetings: "01 会议",
			candidates: "02 记忆候选",
			entities: "03 实体",
			people: "人物",
			organizations: "组织",
			projects: "项目",
			user: "04 User",
			system: "99 系统",
			logs: "运行日志"
		};
	const userDir = joinVaultPath(root, names.user);
	const userProfiles = Object.fromEntries(
		(Object.entries(MEMORY_USER_PROFILE_TITLES) as Array<[MemoryUserCategory, { zh: string; en: string }]>).map(
			([category, title], index) => [
				category,
				joinVaultPath(userDir, `${String(index + 1).padStart(2, "0")} ${title[language]}.md`)
			]
		)
	) as Record<MemoryUserCategory, string>;
	const entitiesDir = joinVaultPath(root, names.entities);
	const systemDir = joinVaultPath(root, names.system);
	return {
		home: joinVaultPath(root, names.home),
		meetingsDir: joinVaultPath(root, names.meetings),
		candidatesDir: joinVaultPath(root, names.candidates),
		peopleDir: joinVaultPath(entitiesDir, names.people),
		organizationsDir: joinVaultPath(entitiesDir, names.organizations),
		projectsDir: joinVaultPath(entitiesDir, names.projects),
		userDir,
		soul: joinVaultPath(userDir, "SOUL.md"),
		userProfiles,
		systemDir,
		manifest: joinVaultPath(systemDir, "echo-memory.json"),
		logsDir: joinVaultPath(systemDir, names.logs)
	};
}

export function normalizeMemoryRoot(value: string): string {
	const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
	if (!normalized || normalized.split("/").some((part) => part === "." || part === "..")) {
		throw new Error("Echo Memory 根目录必须是 Vault 内的相对文件夹路径。");
	}
	return normalized;
}

function joinVaultPath(...parts: string[]): string {
	return parts.join("/").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}
