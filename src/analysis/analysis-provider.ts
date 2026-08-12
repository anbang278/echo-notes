import type { AnalysisTemplateConfig, CopyLanguage } from "../settings/settings";
import type { DiagnosticSink } from "../diagnostics/diagnostic-types";

export interface AnalysisInput {
	template: AnalysisTemplateConfig;
	transcriptTitle: string;
	transcriptText: string;
	copyLanguage: CopyLanguage;
	diagnostics?: DiagnosticSink;
}

export interface AnalysisResult {
	text: string;
	provider: string;
	model: string;
	traceId?: string;
	raw?: unknown;
}

export interface AnalysisProvider {
	id: string;
	name: string;
	analyze(input: AnalysisInput): Promise<AnalysisResult>;
}

export interface ChunkedAnalysisProvider extends AnalysisProvider {
	analyzeChunk(input: AnalysisInput, chunkIndex: number, totalChunks: number): Promise<AnalysisResult>;
	synthesizeChunks(input: AnalysisInput, chunkResults: AnalysisResult[]): Promise<AnalysisResult>;
}

export type AnalysisErrorCode = "missing_api_key" | "api_error" | "invalid_response" | "network_error" | "timeout";

export class AnalysisError extends Error {
	code: AnalysisErrorCode;
	traceId?: string;

	constructor(code: AnalysisErrorCode, message: string, traceId?: string) {
		super(message);
		this.name = "AnalysisError";
		this.code = code;
		this.traceId = traceId;
	}
}
