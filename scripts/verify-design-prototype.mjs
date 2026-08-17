import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const featureSlug = process.argv[2];
const featureDir = featureSlug ? path.join(PROJECT_ROOT, "design-lab", featureSlug) : null;
const prototypePath = featureDir ? path.join(featureDir, "index.html") : null;
const reviewPath = featureDir ? path.join(featureDir, "review.md") : null;
const outputDir = featureSlug ? path.join(PROJECT_ROOT, "output", "playwright", "design-lab", featureSlug) : null;
const chromePath = process.env.ECHO_NOTES_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const viewports = [
	{ name: "desktop-1280", width: 1280, height: 900 },
	{ name: "desktop-768", width: 768, height: 900 },
	{ name: "mobile-375", width: 375, height: 812 }
];
const themes = ["light", "dark"];

function fail(message) {
	console.error(`原型验证失败：${message}`);
	process.exitCode = 1;
}

function parseFrontmatter(source) {
	const match = source.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	return Object.fromEntries(match[1].split("\n").flatMap((line) => {
		const separator = line.indexOf(":");
		if (separator < 0) return [];
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
		return [[key, value]];
	}));
}

function sha256(buffer) {
	return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
	if (!featureSlug) {
		fail("请提供功能目录，例如：npm run verify:prototype -- memory-settings-review");
		return;
	}
	if (!await exists(prototypePath)) {
		fail(`找不到 ${path.relative(PROJECT_ROOT, prototypePath)}。方向确认前不要创建正式 index.html。`);
		return;
	}
	if (!await exists(reviewPath)) {
		fail(`找不到 ${path.relative(PROJECT_ROOT, reviewPath)}。`);
		return;
	}
	if (!await exists(chromePath)) {
		fail(`找不到 Chrome：${chromePath}。可通过 ECHO_NOTES_CHROME_PATH 指定本机浏览器。`);
		return;
	}

	await fs.mkdir(outputDir, { recursive: true });
	const html = await fs.readFile(prototypePath);
	const review = parseFrontmatter(await fs.readFile(reviewPath, "utf8"));
	const currentHash = sha256(html);
	if (["approved", "implemented"].includes(review.status) && review.prototype_sha256 && review.prototype_sha256 !== currentHash) {
		fail(`原型已冻结，但 SHA-256 已变化：记录为 ${review.prototype_sha256}，当前为 ${currentHash}。`);
		return;
	}

	const browser = await chromium.launch({ headless: true, executablePath: chromePath });
	const results = [];
	try {
		for (const theme of themes) {
			for (const viewport of viewports) {
				const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
				const consoleErrors = [];
				const pageErrors = [];
				page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
				page.on("pageerror", (error) => pageErrors.push(String(error)));
				await page.goto(pathToFileURL(prototypePath).href, { waitUntil: "load" });
				await page.evaluate((nextTheme) => {
					document.documentElement.dataset.theme = nextTheme;
					document.documentElement.style.colorScheme = nextTheme;
				}, theme);
				const metrics = await page.evaluate((isMobile) => {
					const root = document.querySelector("[data-echo-prototype]");
					const buttons = [...document.querySelectorAll("button")].filter((button) => {
						const rect = button.getBoundingClientRect();
						return getComputedStyle(button).display !== "none" && rect.width > 0 && rect.height > 0;
					});
					const unnamedButtons = buttons.filter((button) => !(button.textContent?.trim() || button.getAttribute("aria-label")));
					const touchTargets = buttons.map((button) => Math.round(button.getBoundingClientRect().height));
					return {
						root: Boolean(root),
						documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
						bodyOverflow: document.body.scrollWidth - window.innerWidth,
						unnamedButtons: unnamedButtons.length,
						allTouchTargetsMeetMinimum: !isMobile || touchTargets.every((height) => height >= 44),
						stateControls: document.querySelectorAll("[data-demo-state]").length
					};
				}, viewport.width <= 375);
				if (!metrics.root) throw new Error("缺少 [data-echo-prototype] 根节点。");
				if (metrics.documentOverflow > 1 || metrics.bodyOverflow > 1) throw new Error("存在横向溢出。");
				if (metrics.unnamedButtons > 0) throw new Error(`存在 ${metrics.unnamedButtons} 个没有文字或 aria-label 的按钮。`);
				if (!metrics.allTouchTargetsMeetMinimum) throw new Error("移动端主要按钮高度小于 44px。");

				const stateControls = page.locator("[data-demo-state]");
				for (let index = 0; index < await stateControls.count(); index += 1) {
					await stateControls.nth(index).click();
				}
				const screenshotPath = path.join(outputDir, `${viewport.name}-${theme}.png`);
				await page.screenshot({ path: screenshotPath, fullPage: true });
				results.push({ theme, viewport: viewport.name, metrics, consoleErrors, pageErrors, screenshot: path.relative(PROJECT_ROOT, screenshotPath) });
				await page.close();
			}
		}
	} finally {
		await browser.close();
	}

	const failed = results.filter((result) => result.consoleErrors.length || result.pageErrors.length);
	const summary = { featureSlug, prototypeHash: currentHash, generatedAt: new Date().toISOString(), results, failedCount: failed.length };
	await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	if (failed.length > 0) {
		fail(`存在运行时错误，请查看 ${path.relative(PROJECT_ROOT, path.join(outputDir, "summary.json"))}。`);
		return;
	}
	console.log(`原型验证通过：${featureSlug}，${results.length} 个视口/主题组合，SHA-256 ${currentHash}`);
}

async function exists(target) {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

await main();
