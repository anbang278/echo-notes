import type { EchoNotesSettings } from "../settings/settings";
import type { AnalysisProvider } from "./analysis-provider";
import { OpenAICompatibleAnalysisProvider } from "./openai-compatible-analysis-provider";
import { OpenCodeGoAnalysisProvider } from "./opencode-go-analysis-provider";

export function createAnalysisProvider(settings: EchoNotesSettings, apiKey: string): AnalysisProvider {
	if (settings.analysisProvider === "opencode-go") {
		return new OpenCodeGoAnalysisProvider(settings, apiKey);
	}
	return new OpenAICompatibleAnalysisProvider(settings, apiKey);
}
