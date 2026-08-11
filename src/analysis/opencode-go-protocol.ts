import {
	OPENCODE_GO_ANALYSIS_MODELS,
	type OpenCodeGoAnalysisModelOption,
	type OpenCodeGoAnalysisProtocol
} from "../settings/settings";

export interface OpenCodeGoRequest {
	path: OpenCodeGoAnalysisProtocol;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

export function getOpenCodeGoAnalysisModelOption(model: string): OpenCodeGoAnalysisModelOption | undefined {
	return OPENCODE_GO_ANALYSIS_MODELS.find((option) => option.id === model.trim());
}

export function buildOpenCodeGoAnalysisRequest(
	model: string,
	apiKey: string,
	messages: { system: string; user: string }
): OpenCodeGoRequest {
	const option = getOpenCodeGoAnalysisModelOption(model);
	if (!option) {
		throw new Error(`OpenCode Go 不支持模型 ${model.trim() || "（空）"}。`);
	}

	const key = apiKey.trim();
	switch (option.protocol) {
		case "chat-completions":
			return {
				path: "chat-completions",
				headers: createBearerHeaders(key),
				body: {
					model: option.id,
					stream: false,
					messages: [
						{ role: "system", content: messages.system },
						{ role: "user", content: messages.user }
					]
				}
			};
		case "responses":
			return {
				path: "responses",
				headers: createBearerHeaders(key),
				body: {
					model: option.id,
					stream: false,
					instructions: messages.system,
					input: messages.user
				}
			};
		case "messages":
			return {
				path: "messages",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": key,
					"anthropic-version": "2023-06-01"
				},
				body: {
					model: option.id,
					max_tokens: 8192,
					stream: false,
					system: messages.system,
					messages: [{ role: "user", content: messages.user }]
				}
			};
	}
}

export function parseOpenCodeGoAnalysisResponse(model: string, data: unknown): string | undefined {
	const option = getOpenCodeGoAnalysisModelOption(model);
	if (!option || !isRecord(data)) {
		return undefined;
	}

	switch (option.protocol) {
		case "chat-completions":
			return getChatCompletionText(data);
		case "responses":
			return getResponsesText(data);
		case "messages":
			return getMessagesText(data);
	}
}

function createBearerHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`
	};
}

function getChatCompletionText(data: Record<string, unknown>): string | undefined {
	const choices = Array.isArray(data.choices) ? (data.choices as unknown[]) : [];
	const choice = choices[0];
	if (!isRecord(choice) || !isRecord(choice.message)) {
		return undefined;
	}
	return getContentText(choice.message.content);
}

function getResponsesText(data: Record<string, unknown>): string | undefined {
	if (typeof data.output_text === "string" && data.output_text.trim()) {
		return data.output_text;
	}
	if (!Array.isArray(data.output)) {
		return undefined;
	}
	return joinText(
		data.output.flatMap((item) =>
			isRecord(item) ? getContentTextParts(item.content, ["output_text"]) : []
		)
	);
}

function getMessagesText(data: Record<string, unknown>): string | undefined {
	return joinText(getContentTextParts(data.content, ["text"]));
}

function getContentText(content: unknown): string | undefined {
	if (typeof content === "string" && content.trim()) {
		return content;
	}
	return joinText(getContentTextParts(content, ["text", "output_text"]));
}

function getContentTextParts(content: unknown, supportedTypes: readonly string[]): string[] {
	if (!Array.isArray(content)) {
		return [];
	}
	return content.flatMap((part) => {
		if (!isRecord(part) || typeof part.text !== "string" || !part.text.trim()) {
			return [];
		}
		if (typeof part.type === "string" && !supportedTypes.includes(part.type)) {
			return [];
		}
		return [part.text];
	});
}

function joinText(parts: readonly string[]): string | undefined {
	const text = parts.join("\n").trim();
	return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
