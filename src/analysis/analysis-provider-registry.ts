import type { EchoNotesSettings } from "../settings/settings";
import type { AnalysisProvider } from "./analysis-provider";
import { OpenAICompatibleAnalysisProvider } from "./openai-compatible-analysis-provider";

export function createAnalysisProvider(settings: EchoNotesSettings, apiKey: string): AnalysisProvider {
	return new OpenAICompatibleAnalysisProvider(settings, apiKey);
}
