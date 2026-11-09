import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

export const requests: RequestUrlParam[] = [];
type MockResponse = RequestUrlResponse | Error | (() => Promise<RequestUrlResponse>);
const responses: MockResponse[] = [];

export function resetRequests(): void {
	requests.length = 0;
	responses.length = 0;
}

export function queueResponse(response: MockResponse): void {
	responses.push(response);
}

export async function requestUrl(request: RequestUrlParam): Promise<RequestUrlResponse> {
	requests.push(request);
	const response = responses.shift();
	if (!response) throw new Error("Unexpected OpenAI mock request");
	if (response instanceof Error) throw response;
	return typeof response === "function" ? response() : response;
}
