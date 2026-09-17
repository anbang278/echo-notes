import type { TranscriptionResult } from "../providers/transcription-provider";

export const DUAL_MODEL_PROOFREADING_MODELS = [
	"Qwen/Qwen3-ASR-1.7B",
	"XingChenAGI/XingChenASR-V3.2-Ultra",
	"XingChenAGI/XingChenASR-Diarize-V3.0",
	"XingChenAGI/XingChenGSR-V1.0"
] as const;

export type DualModelProofreadingModel = (typeof DUAL_MODEL_PROOFREADING_MODELS)[number];
export type ProofreadingDecision = "primary" | "auxiliary" | "manual" | "rejected" | "auto";
export type ProofreadingRisk = "low" | "high";

export interface ProofreadingIssue {
	id: string;
	primary: string;
	auxiliary: string;
	reason: string;
	risk: ProofreadingRisk;
	decision?: ProofreadingDecision;
	manualText?: string;
}

export interface DualModelProofreadingSession {
	schemaVersion: 2;
	sessionId: string;
	readingRevision: number;
	status: "running" | "partial" | "ready" | "failed" | "interrupted";
	primary: Pick<TranscriptionResult, "text" | "provider" | "model" | "traceId">;
	auxiliary?: Pick<TranscriptionResult, "text" | "provider" | "model" | "traceId">;
	readingText: string;
	issues: ProofreadingIssue[];
	events: Array<{ at: string; issueId: string; decision: ProofreadingDecision; text: string }>;
	configurationFingerprint: string;
}

export function isDualModelProofreadingModel(value: string): value is DualModelProofreadingModel {
	return (DUAL_MODEL_PROOFREADING_MODELS as readonly string[]).includes(value);
}

export function validateDualModelConfiguration(primaryModel: string, auxiliaryModel: string): string | null {
	if (!isDualModelProofreadingModel(primaryModel)) return "启用双模型前，请将主模型切换为硅基流动支持的四款模型之一。";
	if (!isDualModelProofreadingModel(auxiliaryModel)) return "辅助模型必须从硅基流动支持的四款模型中选择。";
	if (primaryModel === auxiliaryModel) return "主模型和辅助模型必须不同。";
	return null;
}

export function createDualModelProofreadingSession(input: {
	sessionId: string;
	primary: TranscriptionResult;
	auxiliary?: TranscriptionResult;
	configurationFingerprint: string;
	status?: DualModelProofreadingSession["status"];
}): DualModelProofreadingSession {
	const primary = compact(input.primary);
	const auxiliary = input.auxiliary ? compact(input.auxiliary) : undefined;
	return {
		schemaVersion: 2,
		sessionId: input.sessionId,
		readingRevision: 1,
		status: input.status ?? (auxiliary ? "ready" : "partial"),
		primary,
		auxiliary,
		readingText: primary.text,
		issues: auxiliary ? buildProofreadingIssues(primary.text, auxiliary.text) : [],
		events: [],
		configurationFingerprint: input.configurationFingerprint
	};
}

export function applyProofreadingDecision(
	session: DualModelProofreadingSession,
	issueId: string,
	decision: ProofreadingDecision,
	manualText?: string
): DualModelProofreadingSession {
	const issue = session.issues.find((item) => item.id === issueId);
	if (!issue) throw new Error("校对项不存在或已失效。");
	const text = decision === "primary" ? issue.primary : decision === "auxiliary" ? issue.auxiliary : manualText?.trim() ?? "";
	if (decision === "manual" && !text) throw new Error("请先填写修正后的文本。");
	const nextIssue = { ...issue, decision, manualText: decision === "manual" ? text : undefined };
	const nextIssues = session.issues.map((item) => item.id === issueId ? nextIssue : item);
	const readingText = replaceOnce(session.readingText, issue.primary, text);
	return {
		...session,
		readingText,
		readingRevision: session.readingRevision + 1,
		issues: nextIssues,
		events: [...session.events, { at: new Date().toISOString(), issueId, decision, text }]
	};
}

export function undoProofreadingDecision(session: DualModelProofreadingSession, issueId: string): DualModelProofreadingSession {
	const issue = session.issues.find((item) => item.id === issueId);
	if (!issue?.decision) throw new Error("该校对项没有可撤销的处理。");
	const selected = issue.decision === "auxiliary" ? issue.auxiliary : issue.manualText ?? issue.primary;
	return {
		...session,
		readingText: replaceOnce(session.readingText, selected, issue.primary),
		readingRevision: session.readingRevision + 1,
		issues: session.issues.map((item) => item.id === issueId ? { ...item, decision: undefined, manualText: undefined } : item),
		events: [...session.events, { at: new Date().toISOString(), issueId, decision: "rejected", text: issue.primary }]
	};
}

export function buildProofreadingIssues(primary: string, auxiliary: string): ProofreadingIssue[] {
	if (normalize(primary) === normalize(auxiliary)) return [];
	const primaryLines = primary.split(/\r?\n/).filter(Boolean);
	const auxiliaryLines = auxiliary.split(/\r?\n/).filter(Boolean);
	const total = Math.max(primaryLines.length, auxiliaryLines.length);
	const issues: ProofreadingIssue[] = [];
	for (let index = 0; index < total; index += 1) {
		const left = primaryLines[index] ?? "";
		const right = auxiliaryLines[index] ?? "";
		if (normalize(left) === normalize(right)) continue;
		issues.push({ id: `C${String(issues.length + 1).padStart(2, "0")}`, primary: left, auxiliary: right, reason: "两路转写存在差异，需要人工确认。", risk: looksHighRisk(left, right) ? "high" : "low" });
	}
	return issues.length > 0 ? issues : [{ id: "C01", primary, auxiliary, reason: "两路转写无法可靠逐行对齐，需要人工确认。", risk: "high" }];
}

function compact(result: TranscriptionResult): Pick<TranscriptionResult, "text" | "provider" | "model" | "traceId"> {
	return { text: result.text, provider: result.provider, model: result.model, traceId: result.traceId };
}
function normalize(value: string): string { return value.replace(/\s+/g, "").trim(); }
function replaceOnce(value: string, target: string, replacement: string): string { const index = value.indexOf(target); return index < 0 ? value : `${value.slice(0, index)}${replacement}${value.slice(index + target.length)}`; }
function looksHighRisk(...values: string[]): boolean { return /\d|[零一二三四五六七八九十百千万亿]|不|未|否|负责|日期|金额/.test(values.join(" ")); }
