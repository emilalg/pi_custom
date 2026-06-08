import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ROOT = path.join(os.homedir(), ".pi", "web-search");
export const BROWSER_DIR = path.join(ROOT, "chromium");
export const PROFILE_DIR = path.join(ROOT, "profiles");
export const MANIFEST = path.join(BROWSER_DIR, "manifest.json");
export const CDP_TIMEOUT_MS = 15_000;

export type ChromeManifest = { version: string; executablePath: string; installedAt: string };

type PendingRequest = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type EventHandler = (params: any, sessionId?: string) => void;

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

export class PipeCdp {
	private nextId = 1;
	private buffer = "";
	private closed = false;
	private pending = new Map<number, PendingRequest>();
	private handlers = new Map<string, Set<EventHandler>>();

	constructor(private child: ReturnType<typeof spawn>) {
		const pipeRead = child.stdio[4] as NodeJS.ReadableStream | undefined;
		pipeRead?.setEncoding("utf8");
		pipeRead?.on("data", (chunk) => this.onData(String(chunk)));
		pipeRead?.on("error", (error) => this.close(error instanceof Error ? error : new Error(String(error))));
		child.on("error", (error) => this.close(error));
		child.on("exit", (code, sig) => this.close(new Error(`Chrome exited before CDP request completed (${sig ?? code ?? "unknown"})`)));
	}

	on(method: string, handler: EventHandler): () => void {
		const set = this.handlers.get(method) ?? new Set<EventHandler>();
		set.add(handler);
		this.handlers.set(method, set);
		return () => set.delete(handler);
	}

	private emit(method: string, params: any, sessionId?: string) {
		for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId);
	}

	private close(error: Error) {
		if (this.closed) return;
		this.closed = true;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}

	private onData(chunk: string) {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\0")) >= 0) {
			const raw = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (!raw) continue;
			let msg: any;
			try {
				msg = JSON.parse(raw);
			} catch (error) {
				this.close(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			if (msg.method) this.emit(msg.method, msg.params, msg.sessionId);
			if (!msg.id) continue;
			const pending = this.pending.get(msg.id);
			if (!pending) continue;
			this.pending.delete(msg.id);
			clearTimeout(pending.timer);
			msg.error ? pending.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : pending.resolve(msg.result);
		}
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CDP_TIMEOUT_MS): Promise<any> {
		if (this.closed) return Promise.reject(new Error("Chrome CDP pipe is closed"));
		const pipeWrite = this.child.stdio[3] as NodeJS.WritableStream | undefined;
		if (!pipeWrite?.writable) return Promise.reject(new Error("Chrome CDP write pipe is unavailable"));

		const id = this.nextId++;
		const payload = JSON.stringify({ id, method, params, sessionId }) + "\0";
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Chrome CDP request timed out after ${timeoutMs}ms: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			pipeWrite.write(payload, "utf8", (err?: Error | null) => {
				if (err) {
					const pending = this.pending.get(id);
					if (pending) clearTimeout(pending.timer);
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}
}

export async function withBrowser<T>(
	profile: string,
	signal: AbortSignal | undefined,
	fn: (cdp: PipeCdp, sessionId: string) => Promise<T>,
): Promise<T> {
	const chrome = await ensureStableChrome(signal);
	const userDataDir = path.join(PROFILE_DIR, profile);
	await fs.mkdir(userDataDir, { recursive: true });
	const child = spawn(
		chrome.executablePath,
		[
			"--remote-debugging-pipe",
			`--user-data-dir=${userDataDir}`,
			"--headless=new",
			"--disable-background-networking",
			"--disable-default-apps",
			"--no-first-run",
			"--no-default-browser-check",
			"about:blank",
		],
		{ stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], signal },
	);
	let stderr = "";
	child.stderr?.on("data", (d) => (stderr += String(d)));
	try {
		const cdp = new PipeCdp(child);
		const target = await cdp.send("Target.createTarget", { url: "about:blank" });
		const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
		const sessionId = attached.sessionId;
		await cdp.send("Page.enable", {}, sessionId);
		await cdp.send("Runtime.enable", {}, sessionId);
		return await fn(cdp, sessionId);
	} catch (error) {
		if (stderr && error instanceof Error) error.message += `\nChrome stderr: ${stderr.slice(-2000)}`;
		throw error;
	} finally {
		child.kill("SIGTERM");
	}
}

export async function evaluate(cdp: PipeCdp, sessionId: string, expression: string): Promise<any> {
	const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
	if (result.exceptionDetails) {
		const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.exception?.value || result.exceptionDetails.text;
		throw new Error(detail || "Runtime.evaluate failed");
	}
	return result.result?.value;
}

export async function navigate(cdp: PipeCdp, sessionId: string, url: string): Promise<void> {
	await cdp.send("Page.navigate", { url }, sessionId);
	for (let i = 0; i < 40; i++) {
		await new Promise((r) => setTimeout(r, 250));
		const ready = await evaluate(cdp, sessionId, "document.readyState").catch(() => "loading");
		if (ready === "complete") break;
	}
	await new Promise((r) => setTimeout(r, 750));
}
