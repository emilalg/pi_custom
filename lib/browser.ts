import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "patchright";

export const ROOT = path.join(os.homedir(), ".pi", "web-search");
export const BROWSER_DIR = path.join(ROOT, "chromium");
export const PROFILE_DIR = path.join(ROOT, "profiles");
export const MANIFEST = path.join(BROWSER_DIR, "manifest.json");
export const BROWSER_TIMEOUT_MS = 15_000;

export type ChromeManifest = { version: string; executablePath: string; installedAt: string };
export type BrowserSession = { context: BrowserContext; page: Page };

export function sanitizeProfile(input?: string): string {
	const normalized = (input || "default")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "default";
}

function platformKey(): string {
	if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
	if (process.platform === "linux") return "linux64";
	if (process.platform === "win32") return "win64";
	throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
}

function executableInExtract(platform: string): string {
	if (platform === "mac-arm64" || platform === "mac-x64") {
		return path.join(`chrome-${platform}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
	}
	if (platform === "linux64") return path.join("chrome-linux64", "chrome");
	return path.join("chrome-win64", "chrome.exe");
}

export async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
	return (await res.json()) as T;
}

async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
	const res = await fetch(url, { signal });
	if (!res.ok || !res.body) throw new Error(`Download failed ${res.status}: ${url}`);
	await fs.mkdir(path.dirname(dest), { recursive: true });
	const file = await fs.open(dest, "w");
	try {
		const writer = file.createWriteStream();
		for await (const chunk of res.body as any) {
			if (signal?.aborted) throw new Error("Download aborted");
			if (!writer.write(chunk)) await new Promise((resolve) => writer.once("drain", resolve));
		}
		await new Promise<void>((resolve, reject) => writer.end((err?: Error) => (err ? reject(err) : resolve())));
	} finally {
		await file.close().catch(() => undefined);
	}
}

async function run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], signal });
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += String(d)));
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`))));
	});
}

export async function ensureStableChrome(signal?: AbortSignal): Promise<ChromeManifest> {
	await fs.mkdir(BROWSER_DIR, { recursive: true });
	const platform = platformKey();
	const latest = await fetchJson<any>(
		"https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
		signal,
	);
	const stable = latest.channels.Stable;
	const download = stable.downloads.chrome.find((d: any) => d.platform === platform);
	if (!download) throw new Error(`No Chrome for Testing stable download for ${platform}`);

	const existing = await readJson<ChromeManifest>(MANIFEST);
	if (existing && existing.version === stable.version && existsSync(existing.executablePath)) return existing;

	const installRoot = path.join(BROWSER_DIR, `chrome-${stable.version}`);
	const executablePath = path.join(installRoot, executableInExtract(platform));
	if (!existsSync(executablePath)) {
		await fs.rm(installRoot, { recursive: true, force: true });
		await fs.mkdir(installRoot, { recursive: true });
		const zipPath = path.join(BROWSER_DIR, `chrome-${stable.version}-${platform}.zip`);
		await downloadFile(download.url, zipPath, signal);
		await run("unzip", ["-q", zipPath, "-d", installRoot], signal);
		await fs.rm(zipPath, { force: true });
	}

	const manifest = { version: stable.version, executablePath, installedAt: new Date().toISOString() };
	await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
	return manifest;
}

export async function withBrowser<T>(
	profile: string,
	signal: AbortSignal | undefined,
	fn: (session: BrowserSession) => Promise<T>,
): Promise<T> {
	const chrome = await ensureStableChrome(signal);
	const userDataDir = path.join(PROFILE_DIR, profile);
	await fs.mkdir(userDataDir, { recursive: true });

	let context: BrowserContext | undefined;
	const abort = () => void context?.close().catch(() => undefined);
	if (signal?.aborted) throw new Error("Browser launch aborted");
	signal?.addEventListener("abort", abort, { once: true });
	try {
		context = await chromium.launchPersistentContext(userDataDir, {
			executablePath: chrome.executablePath,
			headless: true,
			viewport: null,
			acceptDownloads: false,
			timeout: BROWSER_TIMEOUT_MS,
			args: [
				"--disable-background-networking",
				"--disable-default-apps",
				"--no-first-run",
				"--no-default-browser-check",
			],
		});
		const page = context.pages()[0] ?? (await context.newPage());
		page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
		page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS);
		return await fn({ context, page });
	} finally {
		signal?.removeEventListener("abort", abort);
		await context?.close().catch(() => undefined);
	}
}

export async function evaluate(page: Page, expression: string): Promise<any> {
	return await page.evaluate(expression as any);
}

export async function navigate(page: Page, url: string): Promise<void> {
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_TIMEOUT_MS });
	await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => undefined);
	await page.waitForTimeout(750);
}
