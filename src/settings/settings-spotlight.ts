import { setIcon } from "obsidian";

export interface SettingsSpotlightStep {
	targetEl: HTMLElement;
	focusEl?: HTMLElement | null;
	stepLabel: string;
	title: string;
	description: string;
	actionLabel: string;
	actionDisabled?: boolean;
}

export class SettingsSpotlight {
	private layerEl: HTMLElement | null = null;
	private popoverEl: HTMLElement | null = null;
	private actionButtonEl: HTMLButtonElement | null = null;
	private closeButtonEl: HTMLButtonElement | null = null;
	private targetEl: HTMLElement | null = null;
	private focusEl: HTMLElement | null = null;
	private focusGuardEl: HTMLElement | null = null;
	private targetPreviousTabIndex: string | null = null;
	private describedElement: HTMLElement | null = null;
	private previousDescribedBy: string | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private animationFrame: number | null = null;
	private moveFocusOnNextLayout = false;
	private sequence = 0;
	private onAction: (() => void) | null = null;
	private onClose: (() => void) | null = null;

	present(step: SettingsSpotlightStep, onAction: () => void, onClose: () => void): void {
		this.clearStep();
		this.targetEl = step.targetEl;
		this.focusEl = this.resolveFocusableElement(step);
		this.focusGuardEl = this.focusEl;
		this.onAction = onAction;
		this.onClose = onClose;

		const ownerDocument = step.targetEl.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) {
			return;
		}

		const reducedMotion = ownerWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
		step.targetEl.scrollIntoView({
			block: "center",
			inline: "nearest",
			behavior: reducedMotion ? "auto" : "smooth"
		});
		step.targetEl.addClass("is-echo-notes-spotlight-target");

		const layerEl = ownerDocument.body.createDiv({ cls: "echo-notes-settings-spotlight-layer" });
		layerEl.dataset.spotlightStep = step.stepLabel;
		this.layerEl = layerEl;
		for (const side of ["top", "right", "bottom", "left"] as const) {
			const maskEl = layerEl.createDiv({ cls: `echo-notes-settings-spotlight-mask is-${side}` });
			maskEl.setAttribute("aria-hidden", "true");
			maskEl.addEventListener("click", this.handleClose);
		}

		const popoverEl = layerEl.createDiv({
			cls: "echo-notes-settings-spotlight-popover",
			attr: { role: "dialog", "aria-modal": "false" }
		});
		this.popoverEl = popoverEl;
		const contentId = `echo-notes-settings-spotlight-description-${++this.sequence}`;
		const titleId = `echo-notes-settings-spotlight-title-${this.sequence}`;
		popoverEl.setAttribute("aria-labelledby", titleId);
		popoverEl.setAttribute("aria-describedby", contentId);

		const headerEl = popoverEl.createDiv({ cls: "echo-notes-settings-spotlight-header" });
		const headingEl = headerEl.createDiv({ cls: "echo-notes-settings-spotlight-heading" });
		const iconEl = headingEl.createSpan({ cls: "echo-notes-settings-spotlight-icon" });
		iconEl.setAttribute("aria-hidden", "true");
		setIcon(iconEl, "mouse-pointer-2");
		const headingTextEl = headingEl.createDiv();
		headingTextEl.createDiv({ cls: "echo-notes-settings-spotlight-step", text: step.stepLabel });
		headingTextEl.createDiv({
			cls: "echo-notes-settings-spotlight-title",
			text: step.title,
			attr: { id: titleId }
		});
		const closeButtonEl = headerEl.createEl("button", {
			cls: "echo-notes-settings-spotlight-close clickable-icon",
			attr: { type: "button", "aria-label": "关闭配置指引" }
		});
		setIcon(closeButtonEl, "x");
		closeButtonEl.addEventListener("click", this.handleClose);
		this.closeButtonEl = closeButtonEl;

		popoverEl.createEl("p", {
			cls: "echo-notes-settings-spotlight-description",
			text: step.description,
			attr: { id: contentId }
		});
		const footerEl = popoverEl.createDiv({ cls: "echo-notes-settings-spotlight-footer" });
		const actionButtonEl = footerEl.createEl("button", {
			cls: "mod-cta echo-notes-settings-spotlight-action",
			text: step.actionLabel,
			attr: { type: "button" }
		});
		actionButtonEl.disabled = step.actionDisabled === true;
		actionButtonEl.addEventListener("click", this.handleAction);
		this.actionButtonEl = actionButtonEl;

		this.describedElement = this.focusEl ?? step.targetEl;
		this.previousDescribedBy = this.describedElement.getAttribute("aria-describedby");
		this.describedElement.setAttribute(
			"aria-describedby",
			[this.previousDescribedBy, contentId].filter(Boolean).join(" ")
		);
		if (!this.focusEl) {
			this.targetPreviousTabIndex = step.targetEl.getAttribute("tabindex");
			step.targetEl.tabIndex = -1;
			this.focusEl = step.targetEl;
		}

		ownerWindow.addEventListener("keydown", this.handleKeydown, true);
		ownerWindow.addEventListener("focusin", this.handleFocusIn, true);
		ownerDocument.addEventListener("scroll", this.handleViewportChange, true);
		ownerWindow.addEventListener("resize", this.handleViewportChange);
		this.resizeObserver = new ownerWindow.ResizeObserver(this.handleViewportChange);
		this.resizeObserver.observe(step.targetEl);
		this.resizeObserver.observe(popoverEl);
		this.scheduleLayout(true);
	}

	close(): void {
		this.clearStep();
	}

	private resolveFocusableElement(step: SettingsSpotlightStep): HTMLElement | null {
		const candidate = step.focusEl;
		if (!candidate || !candidate.isConnected || this.isDisabled(candidate)) {
			return null;
		}
		return candidate;
	}

	private isDisabled(element: HTMLElement): boolean {
		return element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
	}

	private readonly handleAction = (): void => {
		this.onAction?.();
	};

	private readonly handleClose = (): void => {
		this.onClose?.();
	};

	private readonly handleViewportChange = (): void => {
		this.scheduleLayout(false);
	};

	private readonly handleKeydown = (event: KeyboardEvent): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.onClose?.();
			return;
		}
		if (event.key !== "Tab") {
			return;
		}

		const focusable = [this.focusEl, this.actionButtonEl, this.closeButtonEl]
			.filter((element): element is HTMLElement => Boolean(
				element && element.isConnected && !this.isDisabled(element)
			));
		if (focusable.length === 0) {
			return;
		}

		const currentIndex = focusable.indexOf(event.target as HTMLElement);
		const nextIndex = event.shiftKey
			? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
			: (currentIndex === -1 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
		event.preventDefault();
		event.stopImmediatePropagation();
		this.focusGuardEl = focusable[nextIndex];
		this.focusGuardEl.focus();
	};

	private readonly handleFocusIn = (event: FocusEvent): void => {
		const focusedElement = event.target;
		if (!(focusedElement instanceof HTMLElement)) {
			return;
		}
		if (this.targetEl?.contains(focusedElement) || this.popoverEl?.contains(focusedElement)) {
			this.focusGuardEl = focusedElement;
			return;
		}
		const fallback = this.focusGuardEl;
		if (!fallback || !fallback.isConnected || this.isDisabled(fallback)) {
			return;
		}
		event.stopImmediatePropagation();
		fallback.focus({ preventScroll: true });
	};

	private scheduleLayout(moveFocus: boolean): void {
		const ownerWindow = this.targetEl?.ownerDocument.defaultView;
		if (!ownerWindow) {
			return;
		}
		this.moveFocusOnNextLayout ||= moveFocus;
		if (this.animationFrame !== null) {
			ownerWindow.cancelAnimationFrame(this.animationFrame);
		}
		this.animationFrame = ownerWindow.requestAnimationFrame(() => {
			this.animationFrame = ownerWindow.requestAnimationFrame(() => {
				this.animationFrame = null;
				this.layout();
				if (this.moveFocusOnNextLayout) {
					this.moveFocusOnNextLayout = false;
					this.focusGuardEl = this.focusEl;
					this.focusEl?.focus({ preventScroll: true });
				}
			});
		});
	}

	private layout(): void {
		const targetEl = this.targetEl;
		const layerEl = this.layerEl;
		const popoverEl = this.popoverEl;
		const ownerWindow = targetEl?.ownerDocument.defaultView;
		if (!targetEl || !targetEl.isConnected || !layerEl || !popoverEl || !ownerWindow) {
			return;
		}

		const viewportWidth = ownerWindow.innerWidth;
		const viewportHeight = ownerWindow.innerHeight;
		const padding = 8;
		const targetRect = targetEl.getBoundingClientRect();
		const holeLeft = Math.max(0, targetRect.left - padding);
		const holeTop = Math.max(0, targetRect.top - padding);
		const holeRight = Math.min(viewportWidth, targetRect.right + padding);
		const holeBottom = Math.min(viewportHeight, targetRect.bottom + padding);
		const holeHeight = Math.max(0, holeBottom - holeTop);

		this.placeMask(layerEl, ".is-top", 0, 0, viewportWidth, holeTop);
		this.placeMask(layerEl, ".is-right", holeRight, holeTop, viewportWidth - holeRight, holeHeight);
		this.placeMask(layerEl, ".is-bottom", 0, holeBottom, viewportWidth, viewportHeight - holeBottom);
		this.placeMask(layerEl, ".is-left", 0, holeTop, holeLeft, holeHeight);

		const narrow = viewportWidth <= 720;
		popoverEl.toggleClass("is-mobile", narrow);
		if (narrow) {
			popoverEl.style.removeProperty("top");
			popoverEl.style.removeProperty("left");
			const popoverRect = popoverEl.getBoundingClientRect();
			const safeTargetBottom = viewportHeight - popoverRect.height - 32;
			if (targetRect.bottom > safeTargetBottom) {
				targetEl.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
			}
			return;
		}

		const gap = 12;
		const edge = 16;
		const popoverRect = popoverEl.getBoundingClientRect();
		const top = holeBottom + gap + popoverRect.height <= viewportHeight - edge
			? holeBottom + gap
			: Math.max(edge, holeTop - gap - popoverRect.height);
		const left = Math.min(
			Math.max(edge, holeLeft),
			Math.max(edge, viewportWidth - popoverRect.width - edge)
		);
		popoverEl.style.top = `${Math.round(top)}px`;
		popoverEl.style.left = `${Math.round(left)}px`;
	}

	private placeMask(
		layerEl: HTMLElement,
		selector: string,
		left: number,
		top: number,
		width: number,
		height: number
	): void {
		const maskEl = layerEl.querySelector<HTMLElement>(selector);
		if (!maskEl) {
			return;
		}
		maskEl.style.left = `${Math.round(left)}px`;
		maskEl.style.top = `${Math.round(top)}px`;
		maskEl.style.width = `${Math.max(0, Math.round(width))}px`;
		maskEl.style.height = `${Math.max(0, Math.round(height))}px`;
	}

	private clearStep(): void {
		const ownerDocument = this.targetEl?.ownerDocument;
		const ownerWindow = ownerDocument?.defaultView;
		const restoreFocusEl = ownerDocument &&
			this.layerEl?.contains(ownerDocument.activeElement) &&
			this.focusEl?.isConnected &&
			!this.isDisabled(this.focusEl)
			? this.focusEl
			: null;
		if (ownerDocument) {
			ownerDocument.removeEventListener("scroll", this.handleViewportChange, true);
		}
		ownerWindow?.removeEventListener("keydown", this.handleKeydown, true);
		ownerWindow?.removeEventListener("focusin", this.handleFocusIn, true);
		ownerWindow?.removeEventListener("resize", this.handleViewportChange);
		if (ownerWindow && this.animationFrame !== null) {
			ownerWindow.cancelAnimationFrame(this.animationFrame);
		}
		this.animationFrame = null;
		this.moveFocusOnNextLayout = false;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;

		this.targetEl?.removeClass("is-echo-notes-spotlight-target");
		if (this.describedElement?.isConnected) {
			if (this.previousDescribedBy) {
				this.describedElement.setAttribute("aria-describedby", this.previousDescribedBy);
			} else {
				this.describedElement.removeAttribute("aria-describedby");
			}
		}
		this.layerEl?.remove();
		restoreFocusEl?.focus({ preventScroll: true });
		if (this.targetEl?.isConnected && this.targetPreviousTabIndex !== null) {
			this.targetEl.setAttribute("tabindex", this.targetPreviousTabIndex);
		} else if (this.targetEl?.isConnected && this.targetPreviousTabIndex === null && this.focusEl === this.targetEl) {
			this.targetEl.removeAttribute("tabindex");
		}
		this.layerEl = null;
		this.popoverEl = null;
		this.actionButtonEl = null;
		this.closeButtonEl = null;
		this.targetEl = null;
		this.focusEl = null;
		this.focusGuardEl = null;
		this.targetPreviousTabIndex = null;
		this.describedElement = null;
		this.previousDescribedBy = null;
		this.onAction = null;
		this.onClose = null;
	}
}
