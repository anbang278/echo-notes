import type { IconName } from "obsidian";

export type StatusIndicatorTone = "running" | "success" | "failed" | "warning" | "neutral";

interface StatusIndicatorDefinition {
	icon: IconName;
	label: string;
}

interface StatusIndicatorOptions {
	tone: StatusIndicatorTone;
	text?: string;
	live?: "polite" | "assertive";
}

type StatusIconRenderer = (parent: HTMLElement, iconId: IconName) => void;

const STATUS_INDICATOR_DEFINITIONS: Record<StatusIndicatorTone, StatusIndicatorDefinition> = {
	running: { icon: "loader-circle", label: "进行中" },
	success: { icon: "circle-check", label: "成功" },
	failed: { icon: "circle-x", label: "失败" },
	warning: { icon: "triangle-alert", label: "警告" },
	neutral: { icon: "circle-minus", label: "未开始" }
};

const STATUS_TONE_CLASSES = Object.keys(STATUS_INDICATOR_DEFINITIONS).map((tone) => `is-${tone}`);

export function getStatusIndicatorDefinition(tone: StatusIndicatorTone): StatusIndicatorDefinition {
	return { ...STATUS_INDICATOR_DEFINITIONS[tone] };
}

export function clearStatusIndicator(containerEl: HTMLElement): void {
	containerEl.empty();
	containerEl.removeClass("echo-notes-status-indicator");
	for (const className of STATUS_TONE_CLASSES) {
		containerEl.removeClass(className);
	}
	delete containerEl.dataset.statusTone;
	containerEl.removeAttribute("role");
	containerEl.removeAttribute("aria-live");
}

export function renderStatusIndicator(
	containerEl: HTMLElement,
	options: StatusIndicatorOptions,
	renderIcon: StatusIconRenderer
): HTMLElement {
	containerEl.empty();
	containerEl.addClass("echo-notes-status-indicator");
	for (const className of STATUS_TONE_CLASSES) {
		containerEl.removeClass(className);
	}
	containerEl.addClass(`is-${options.tone}`);
	containerEl.dataset.statusTone = options.tone;

	if (options.live) {
		containerEl.setAttribute("role", options.live === "assertive" ? "alert" : "status");
		containerEl.setAttribute("aria-live", options.live);
	} else {
		containerEl.removeAttribute("role");
		containerEl.removeAttribute("aria-live");
	}

	const definition = STATUS_INDICATOR_DEFINITIONS[options.tone];
	const iconEl = containerEl.createSpan({ cls: "echo-notes-status-indicator-icon" });
	iconEl.setAttribute("aria-hidden", "true");
	renderIcon(iconEl, definition.icon);
	containerEl.createSpan({
		cls: "echo-notes-status-indicator-text",
		text: options.text ?? definition.label
	});
	return containerEl;
}
