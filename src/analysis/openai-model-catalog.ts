export const OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_OFFICIAL_DEFAULT_MODEL = "gpt-6.1-sol";
export const OPENAI_OFFICIAL_PRICE_CHECKED_AT = "2026-11-09";
export const OPENAI_OFFICIAL_PRICING_URL = "https://developers.openai.com/api/docs/pricing";

export interface OpenAIOfficialModelOption {
	id: string;
	/** Standard short-context price in USD per million text tokens. */
	inputPrice: number;
	outputPrice: number;
}

export const OPENAI_OFFICIAL_MODELS: readonly OpenAIOfficialModelOption[] = [
	{ id: "gpt-6.1-sol", inputPrice: 2, outputPrice: 10 },
	{ id: "gpt-6.1-terra", inputPrice: 1, outputPrice: 5 },
	{ id: "gpt-6-luna", inputPrice: 0.1, outputPrice: 0.5 },
	{ id: "gpt-6-astra", inputPrice: 10, outputPrice: 50 }
];

export function getOpenAIOfficialModelOption(model: string): OpenAIOfficialModelOption | undefined {
	return OPENAI_OFFICIAL_MODELS.find((option) => option.id === model.trim());
}

export function formatOpenAIOfficialModelLabel(option: OpenAIOfficialModelOption): string {
	return `${option.id} · 输入 $${formatPrice(option.inputPrice)} / 输出 $${formatPrice(option.outputPrice)}`;
}

export function isOpenAIOfficialBaseUrl(value: string): boolean {
	return value.trim().replace(/\/+$/, "") === OPENAI_OFFICIAL_BASE_URL;
}

function formatPrice(value: number): string {
	return value < 1 ? value.toFixed(2) : String(value);
}
