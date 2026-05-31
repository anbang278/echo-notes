import type { AnalysisTemplateId, CopyLanguage } from "../settings/settings";

export interface AnalysisTemplate {
	id: AnalysisTemplateId;
	commandName: string;
	title: Record<CopyLanguage, string>;
	sections: Record<CopyLanguage, string[]>;
	purpose: Record<CopyLanguage, string>;
}

export const ANALYSIS_TEMPLATE_ORDER: AnalysisTemplateId[] = [
	"work-minutes",
	"study-notes",
	"product-requirement-mining"
];

export const ANALYSIS_TEMPLATES: Record<AnalysisTemplateId, AnalysisTemplate> = {
	"work-minutes": {
		id: "work-minutes",
		commandName: "work minutes",
		title: {
			zh: "工作纪要",
			en: "Work minutes"
		},
		sections: {
			zh: ["摘要", "关键结论", "行动项", "风险/阻塞", "待确认问题"],
			en: ["Summary", "Key decisions", "Action items", "Risks/Blockers", "Open questions"]
		},
		purpose: {
			zh: "将转写稿整理成适合工作同步、会议复盘和任务追踪的纪要。",
			en: "Turn the transcript into minutes suitable for work sync, meeting review, and task tracking."
		}
	},
	"study-notes": {
		id: "study-notes",
		commandName: "study notes",
		title: {
			zh: "学习纪要",
			en: "Study notes"
		},
		sections: {
			zh: ["核心概念", "知识要点", "案例/例子", "易混淆点", "复习清单"],
			en: ["Core concepts", "Key points", "Examples", "Common confusions", "Review checklist"]
		},
		purpose: {
			zh: "将转写稿整理成适合学习、复盘和后续复习的结构化笔记。",
			en: "Turn the transcript into structured notes for learning, review, and later study."
		}
	},
	"product-requirement-mining": {
		id: "product-requirement-mining",
		commandName: "product requirement mining",
		title: {
			zh: "产品需求挖掘纪要",
			en: "Product requirement mining"
		},
		sections: {
			zh: ["用户/场景", "痛点", "需求机会", "功能建议", "优先级", "验收标准", "开放问题"],
			en: [
				"Users/Scenarios",
				"Pain points",
				"Requirement opportunities",
				"Feature suggestions",
				"Priority",
				"Acceptance criteria",
				"Open questions"
			]
		},
		purpose: {
			zh: "从转写稿中挖掘用户场景、痛点、需求机会和可落地的产品建议。",
			en: "Mine user scenarios, pain points, requirement opportunities, and actionable product ideas from the transcript."
		}
	}
};

export interface AnalysisPromptInput {
	templateId: AnalysisTemplateId;
	transcriptTitle: string;
	transcriptText: string;
	copyLanguage: CopyLanguage;
}

export function getAnalysisTemplate(templateId: AnalysisTemplateId): AnalysisTemplate {
	return ANALYSIS_TEMPLATES[templateId] ?? ANALYSIS_TEMPLATES["work-minutes"];
}

export function getAnalysisTemplateTitle(templateId: AnalysisTemplateId, copyLanguage: CopyLanguage): string {
	return getAnalysisTemplate(templateId).title[copyLanguage];
}

export function buildAnalysisMessages(input: AnalysisPromptInput): { system: string; user: string } {
	const template = getAnalysisTemplate(input.templateId);
	const sections = template.sections[input.copyLanguage].map((section) => `- ${section}`).join("\n");
	const languageName = input.copyLanguage === "en" ? "English" : "简体中文";

	return {
		system: [
			"你是 Echo Notes 的转写稿分析助手。",
			`请始终使用${languageName}输出。`,
			template.purpose[input.copyLanguage],
			"只依据用户提供的转写稿内容分析；信息不足时明确写“未提及”或“待确认”。",
			"输出 Markdown，不要使用代码块包裹，不要编造转写稿中不存在的事实。"
		].join("\n"),
		user: [
			`转写稿标题：${input.transcriptTitle}`,
			"",
			`请按以下固定结构生成「${template.title[input.copyLanguage]}」：`,
			sections,
			"",
			"转写稿正文：",
			input.transcriptText.trim()
		].join("\n")
	};
}
