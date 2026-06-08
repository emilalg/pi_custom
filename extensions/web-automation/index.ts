import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evaluate, navigate, sanitizeProfile, withBrowser } from "../../lib/browser.js";
import type { Page, Request, Response } from "patchright";

type TextPart = { type: "text"; text: string };
type NetworkEntry = {
	requestId: string;
	type?: string;
	method?: string;
	url?: string;
	requestHeaders?: Record<string, string>;
	requestBodyPreview?: string;
	requestBodyJson?: unknown;
	status?: number;
	mimeType?: string;
	responseHeaders?: Record<string, string>;
	bodyPreview?: string;
};

type ProbeInteraction = {
	action: "fill" | "click" | "press" | "wait" | "select";
	selector?: string;
	text?: string;
	key?: string;
	value?: string;
	waitMs?: number;
};

type DomSnapshot = {
	label: string;
	dom: Awaited<ReturnType<typeof collectDomEvidence>>;
};

const MAX_REQUESTS = 80;
const MAX_SNIPPET_CHARS = 1_500;
const MAX_BODY_PREVIEW = 4_000;
const GATEWAY_OUTPUT_CAP = 60_000;

function text(value: string): TextPart[] {
	return [{ type: "text", text: value }];
}

function inferProfile(paramsProfile: string | undefined, ctx: unknown): string {
	if (paramsProfile) return sanitizeProfile(paramsProfile);
	const anyCtx = ctx as any;
	return sanitizeProfile(anyCtx?.skill?.name ?? anyCtx?.activeSkill?.name ?? anyCtx?.currentSkill?.name ?? "web-automation");
}

function extractUrl(task: string): string | undefined {
	return task.match(/https?:\/\/\S+/i)?.[0].replace(/[),.;!?]+$/, "");
}

function redactHeaders(headers: Record<string, unknown> = {}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const lower = key.toLowerCase();
		if (["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token"].includes(lower)) {
			out[key] = "<redacted-present>";
		} else {
			out[key] = String(value).slice(0, 500);
		}
	}
	return out;
}

function interestingRequest(entry: NetworkEntry): boolean {
	if (!entry.url || !/^https?:/i.test(entry.url)) return false;
	if (["xhr", "fetch", "document"].includes((entry.type || "").toLowerCase())) return true;
	return /json|api|search|models|pricing|catalog|list|query|data|filter/i.test(`${entry.url} ${entry.mimeType || ""} ${entry.requestBodyPreview || ""}`);
}

function parseMaybeJson(value: string | undefined): unknown {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed || !/^[{[]/.test(trimmed)) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

async function waitAfterInteraction(page: Page, waitMs?: number) {
	await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => undefined);
	await page.waitForTimeout(Math.max(100, Math.min(waitMs ?? 750, 10_000)));
}

async function performInteraction(page: Page, interaction: ProbeInteraction): Promise<string> {
	const action = interaction.action;
	if (action === "wait") {
		await page.waitForTimeout(Math.max(100, Math.min(interaction.waitMs ?? 1_000, 10_000)));
		return `wait ${interaction.waitMs ?? 1_000}ms`;
	}
	if (action === "press") {
		if (interaction.selector) await page.locator(interaction.selector).first().press(interaction.key || "Enter");
		else await page.keyboard.press(interaction.key || "Enter");
		await waitAfterInteraction(page, interaction.waitMs);
		return interaction.selector ? `press ${interaction.key || "Enter"} on ${interaction.selector}` : `press ${interaction.key || "Enter"}`;
	}
	if (!interaction.selector) throw new Error(`Interaction ${action} requires selector`);
	const locator = page.locator(interaction.selector).first();
	if (action === "fill") await locator.fill(interaction.text ?? interaction.value ?? "");
	else if (action === "click") await locator.click();
	else if (action === "select") await locator.selectOption(interaction.value ?? interaction.text ?? "");
	else throw new Error(`Unsupported interaction action: ${action}`);
	await waitAfterInteraction(page, interaction.waitMs);
	return `${action} ${interaction.selector}${interaction.text || interaction.value ? ` = ${JSON.stringify(interaction.text ?? interaction.value)}` : ""}`;
}

async function searchFirstResult(task: string, signal?: AbortSignal): Promise<string | undefined> {
	const html = await (await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(task)}`, { signal })).text();
	const match = html.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/i);
	if (!match) return undefined;
	const decoded = match[1].replace(/&amp;/g, "&");
	if (decoded.includes("/l/?")) return new URL(decoded, "https://duckduckgo.com").searchParams.get("uddg") || undefined;
	return /^https?:/i.test(decoded) ? decoded : undefined;
}

async function collectDomEvidence(page: Page) {
	return await evaluate(
		page,
		String.raw`(() => {
			const clean = s => (s || '').replace(/\s+/g, ' ').trim();
			const clip = s => clean(s).slice(0, ${MAX_SNIPPET_CHARS});
			const attrs = el => Array.from(el.attributes || []).slice(0, 12).map(a => a.name + '=' + JSON.stringify(a.value)).join(' ');
			const pick = (selector, limit) => Array.from(document.querySelectorAll(selector)).slice(0, limit).map(el => ({
				selector,
				tag: el.tagName.toLowerCase(),
				text: clip(el.innerText || el.textContent || ''),
				html: ('<' + el.tagName.toLowerCase() + (attrs(el) ? ' ' + attrs(el) : '') + '>' + clip(el.innerText || el.textContent || '') + '</' + el.tagName.toLowerCase() + '>').slice(0, ${MAX_SNIPPET_CHARS})
			})).filter(x => x.text || x.html);
			const embeddedJson = Array.from(document.querySelectorAll('script[type*="json"], script#__NEXT_DATA__, script[id*="data" i], script[id*="state" i]')).slice(0, 8).map(s => ({
				id: s.id || '', type: s.type || '', text: (s.textContent || '').trim().slice(0, ${MAX_SNIPPET_CHARS})
			})).filter(x => x.text);
			return {
				finalUrl: location.href,
				title: document.title,
				metaDescription: document.querySelector('meta[name="description"]')?.content || '',
				visibleTextSample: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 5000),
				links: Array.from(document.querySelectorAll('a[href]')).slice(0, 80).map(a => ({ text: clean(a.innerText || a.textContent || '').slice(0, 160), href: a.href })),
				forms: Array.from(document.querySelectorAll('form')).slice(0, 10).map(f => ({ action: f.action, method: f.method, text: clip(f.innerText || ''), inputs: Array.from(f.querySelectorAll('input, select, textarea, button')).slice(0, 30).map(i => ({ tag: i.tagName.toLowerCase(), id: i.id || null, name: i.getAttribute('name'), type: i.getAttribute('type'), role: i.getAttribute('role'), ariaLabel: i.getAttribute('aria-label'), placeholder: i.getAttribute('placeholder'), text: clean(i.innerText || i.value || '') })) })),
				controls: Array.from(document.querySelectorAll('input, select, textarea, button, [role="button"], [role="tab"], [contenteditable="true"]')).slice(0, 80).map((el, index) => ({
					index,
					tag: el.tagName.toLowerCase(),
					id: el.id || null,
					name: el.getAttribute('name'),
					type: el.getAttribute('type'),
					role: el.getAttribute('role'),
					ariaLabel: el.getAttribute('aria-label'),
					placeholder: el.getAttribute('placeholder'),
					text: clean(el.innerText || el.value || '').slice(0, 240),
					selectorHints: [el.id ? '#' + CSS.escape(el.id) : null, el.getAttribute('name') ? el.tagName.toLowerCase() + '[name="' + CSS.escape(el.getAttribute('name')) + '"]' : null, el.getAttribute('placeholder') ? el.tagName.toLowerCase() + '[placeholder="' + CSS.escape(el.getAttribute('placeholder')) + '"]' : null].filter(Boolean)
				})),
				snippets: [
					...pick('[data-testid], [data-test], [data-cy]', 20),
					...pick('table, [role="table"], [role="row"], article, main li, main [class]', 30)
				],
				embeddedJson
			};
		})()`,
	);
}

async function probeSite(task: string, url: string, profile: string, interactions: ProbeInteraction[] = [], signal?: AbortSignal) {
	return await withBrowser(profile, signal, async ({ page }) => {
		const byRequest = new Map<Request, NetworkEntry>();
		const responses = new Map<Request, Response>();
		const snapshots: DomSnapshot[] = [];
		const interactionLog: string[] = [];
		let nextRequestId = 1;

		page.on("request", (request) => {
			const entry: NetworkEntry = byRequest.get(request) ?? { requestId: String(nextRequestId++) };
			entry.method = request.method();
			entry.url = request.url();
			entry.requestHeaders = redactHeaders(request.headers());
			const postData = request.postData();
			if (postData) {
				entry.requestBodyPreview = postData.slice(0, MAX_BODY_PREVIEW);
				entry.requestBodyJson = parseMaybeJson(postData);
			}
			byRequest.set(request, entry);
		});
		page.on("response", (response) => {
			const request = response.request();
			const entry: NetworkEntry = byRequest.get(request) ?? { requestId: String(nextRequestId++) };
			entry.type = request.resourceType();
			entry.method = request.method();
			entry.url = response.url();
			entry.status = response.status();
			entry.mimeType = response.headers()["content-type"];
			entry.responseHeaders = redactHeaders(response.headers());
			byRequest.set(request, entry);
			responses.set(request, response);
		});

		await navigate(page, url);
		const dom = await collectDomEvidence(page);
		snapshots.push({ label: "after initial load", dom });

		for (const [index, interaction] of interactions.slice(0, 20).entries()) {
			const label = await performInteraction(page, interaction);
			interactionLog.push(`[${index + 1}] ${label}`);
			snapshots.push({ label: `after interaction ${index + 1}: ${label}`, dom: await collectDomEvidence(page) });
		}

		const finalDom = snapshots[snapshots.length - 1]?.dom ?? dom;
		const requests = [...byRequest.entries()].map(([request, entry]) => ({ request, entry })).filter(({ entry }) => interestingRequest(entry)).slice(0, MAX_REQUESTS);
		for (const { request, entry } of requests) {
			if (!/json|text|html|javascript/i.test(entry.mimeType || "") || !["xhr", "fetch", "document"].includes((entry.type || "").toLowerCase())) continue;
			try {
				const response = responses.get(request);
				entry.bodyPreview = response ? (await response.text()).slice(0, MAX_BODY_PREVIEW) : undefined;
			} catch {
				// Body may be unavailable after navigation; metadata is still useful.
			}
		}

		return { task, requestedUrl: url, dom: finalDom, snapshots, interactions: interactionLog, requests: requests.map(({ entry }) => entry) };
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function requestRelevanceScore(r: NetworkEntry, task: string): number {
	let score = 0;
	const haystack = `${r.url || ""} ${r.mimeType || ""} ${r.requestBodyPreview || ""}`.toLowerCase();
	if (["xhr", "fetch"].includes((r.type || "").toLowerCase())) score += 4;
	if ((r.method || "").toUpperCase() !== "GET") score += 2;
	if (r.requestBodyPreview) score += 5;
	if (r.bodyPreview) score += 2;
	if (/search|query|filter|list|data|api|items|results|page|cursor|offset|limit/i.test(haystack)) score += 4;
	for (const token of task.toLowerCase().match(/[a-z0-9_.-]{3,}/g) || []) {
		if (haystack.includes(token)) score += 1;
	}
	return score;
}

function summarizeProbe(result: Awaited<ReturnType<typeof probeSite>>): string {
	const apiish = result.requests
		.filter((r) => ["xhr", "fetch"].includes((r.type || "").toLowerCase()) || /json|api|search|data|filter/i.test(`${r.url} ${r.mimeType} ${r.requestBodyPreview || ""}`))
		.sort((a, b) => requestRelevanceScore(b, result.task) - requestRelevanceScore(a, result.task));
	const formatPayload = (r: NetworkEntry) => {
		const parts: string[] = [];
		if (r.requestBodyJson !== undefined) parts.push(`- request payload JSON: ${JSON.stringify(r.requestBodyJson).slice(0, 1_200)}`);
		else if (r.requestBodyPreview) parts.push(`- request payload preview: ${r.requestBodyPreview.slice(0, 1_200)}`);
		if (r.bodyPreview) parts.push(`- response body preview: ${r.bodyPreview.slice(0, 1_200)}`);
		return parts.length ? `\n${parts.join("\n")}` : "";
	};
	const lines = [
		"## Web Automation Probe",
		`URL: ${result.dom.finalUrl || result.requestedUrl}`,
		`Title: ${result.dom.title || "unknown"}`,
		`Network requests captured: ${result.requests.length}`,
		`API/XHR/fetch-like requests: ${apiish.length}`,
		`Interactions performed: ${result.interactions.length}`,
		...(result.interactions.length ? ["", "### Interaction Log", ...result.interactions] : []),
		"",
		"### Likely Relevant Requests",
		...(apiish.slice(0, 12).map((r, i) => `[#${i + 1}] ${r.method || "GET"} ${r.url}\n- type/status/mime: ${r.type || "?"} / ${r.status || "?"} / ${r.mimeType || "?"}${formatPayload(r)}`) || []),
		"",
		"### DOM Evidence",
		`- Links: ${result.dom.links?.length ?? 0}`,
		`- Forms: ${result.dom.forms?.length ?? 0}`,
		`- Controls: ${result.dom.controls?.length ?? 0}`,
		`- Embedded JSON/script data blocks: ${result.dom.embeddedJson?.length ?? 0}`,
		`- Candidate snippets: ${result.dom.snippets?.length ?? 0}`,
		...(result.snapshots.length > 1 ? ["", "### DOM Snapshots", ...result.snapshots.map((s) => `- ${s.label}: ${s.dom.links?.length ?? 0} links, ${s.dom.forms?.length ?? 0} forms, ${s.dom.controls?.length ?? 0} controls`)] : []),
	];
	return lines.join("\n");
}

async function runGatewaySubagent(task: string, url: string | undefined, profile: string, rawOutput: boolean | undefined, signal?: AbortSignal): Promise<{ output: string; stderr: string; exitCode: number }> {
	const skillPath = path.resolve(process.cwd(), "skills/web-automation-gw/SKILL.md");
	const prompt = [
		"/skill:web-automation-gw",
		"Investigate this target and return exactly the required Web Automation Handoff format.",
		url ? `URL: ${url}` : undefined,
		`Profile for browser probing: ${profile}`,
		`Raw probe output requested: ${rawOutput ? "yes" : "no"}`,
		"Task:",
		task,
	].filter(Boolean).join("\n");

	const extensionPath = fileURLToPath(import.meta.url);
	const args = [
		"--no-extensions",
		"-e", extensionPath,
		"--mode", "json",
		"-p",
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--skill", skillPath,
		"--tools", "web_automation_probe",
	];
	const model = process.env.PI_WEB_AUTOMATION_GATEWAY_MODEL;
	if (model) args.push("--model", model);
	args.push(prompt);

	const invocation = getPiInvocation(args);
	return await new Promise((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: process.cwd(),
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_WEB_AUTOMATION_GATEWAY: "1" },
		});
		let stdoutBuffer = "";
		let stderr = "";
		let finalOutput = "";
		let exitCode = 0;
		let wasAborted = false;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				const message = event.message;
				if ((event.type === "message_end" || event.type === "tool_result_end") && message?.role === "assistant") {
					for (const part of message.content || []) {
						if (part.type === "text") finalOutput = String(part.text || "");
					}
					if (message.errorMessage) finalOutput = String(message.errorMessage);
				}
			} catch {
				// Ignore non-JSON progress output.
			}
		};

		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => { stderr += data.toString(); });
		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			exitCode = wasAborted ? 130 : (code ?? 0);
			resolve({ output: finalOutput, stderr, exitCode });
		});
		proc.on("error", (error) => resolve({ output: "", stderr: `${stderr}\n${error.message}`, exitCode: 1 }));
		if (signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}
	});
}

export default function webAutomationExtension(pi: ExtensionAPI) {
	let probeRegistered = false;

	function registerProbeTool() {
		if (probeRegistered) return false;
		probeRegistered = true;

		pi.registerTool({
			name: "web_automation_probe",
			label: "Web Automation Probe",
			description: "Inspect a website through Chrome for automation handoff evidence: DOM structure, embedded data, forms/links/controls, interaction effects, and network requests/headers/payloads.",
			promptSnippet: "Probe a target website for automation evidence including DOM, embedded data, forms, controls, links, interaction effects, and network calls with request/response payload previews.",
			promptGuidelines: [
				"Use web_automation_probe only after the user manually enables web automation probing for a scraping, extraction, QA, monitoring, or browser-workflow task.",
				"For search/filter/form/listing tasks, first probe the page, then run a second probe with safe interactions such as filling a public search box, pressing Enter, clicking a load-more button, or opening a result link; report what changed.",
				"Use interaction probes to capture the request parameters, payloads, URLs, response shapes, selectors, and DOM states needed by an implementer.",
				"Use web_automation_probe to gather evidence only; do not use it to bypass authentication, CAPTCHA, paywalls, or bot protections.",
			],
			parameters: Type.Object({
				task: Type.String({ description: "Automation investigation directive, ideally including a target URL and what evidence is needed." }),
				url: Type.Optional(Type.String({ description: "Explicit target URL. If omitted, the first URL in task is used; as a last resort a search result may be used." })),
				profile: Type.Optional(Type.String({ description: "Persistent browser profile key. Default web-automation or active skill if detectable." })),
				rawOutput: Type.Optional(Type.Boolean({ description: "Include detailed DOM/network evidence in details. Default true for this probe." })),
				interactions: Type.Optional(Type.Array(Type.Object({
					action: Type.Union([
						Type.Literal("fill"),
						Type.Literal("click"),
						Type.Literal("press"),
						Type.Literal("wait"),
						Type.Literal("select"),
					], { description: "Safe browser action to perform after initial load." }),
					selector: Type.Optional(Type.String({ description: "CSS selector for the target control/link/button. Not needed for wait or page-level press." })),
					text: Type.Optional(Type.String({ description: "Text to fill, or select option text/value." })),
					key: Type.Optional(Type.String({ description: "Key to press, e.g. Enter, Tab, Escape. Default Enter." })),
					value: Type.Optional(Type.String({ description: "Select option value or alternate fill text." })),
					waitMs: Type.Optional(Type.Number({ description: "Extra wait after the action, milliseconds. Capped at 10000." })),
				}), { description: "Optional safe interactions to perform after page load to expose search/filter/result/detail behavior and associated network requests." })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				try {
					const profile = inferProfile(params.profile, ctx);
					const url = params.url || extractUrl(params.task) || (await searchFirstResult(params.task, signal));
					if (!url) throw new Error("No target URL found. Provide a URL or a task specific enough to search.");
					const result = await probeSite(params.task, url, profile, params.interactions ?? [], signal);
					return {
						content: text(summarizeProbe(result)),
						details: {
							profile,
							requestedUrl: result.requestedUrl,
							finalUrl: result.dom.finalUrl,
							title: result.dom.title,
							interactions: result.interactions,
							requests: result.requests,
							dom: params.rawOutput === false ? undefined : result.dom,
							snapshots: params.rawOutput === false ? undefined : result.snapshots,
						},
					};
				} catch (error) {
					return { content: text(error instanceof Error ? error.message : String(error)), details: undefined, isError: true };
				}
			},
		});
		return true;
	}

	if (process.env.PI_WEB_AUTOMATION_GATEWAY === "1") {
		registerProbeTool();
	}

	pi.registerTool({
		name: "web_automation_gateway",
		label: "Web Automation Gateway",
		description: "Run a restricted browser-investigation subagent and return a structured handoff for scraping, form, QA, monitoring, or other web automation work.",
		promptSnippet: "Use web_automation_gateway to investigate websites for automation handoffs. The raw probe is internal and the gateway cannot edit files or run shell commands.",
		promptGuidelines: [
			"Use web_automation_gateway for explicit website automation/scraping/form/workflow investigation requests before implementing code when site behavior is unknown.",
			"The gateway is evidence-gathering only; use its handoff as input to downstream implementation work.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Investigation directive, including the automation/scraping goal and target URL if known." }),
			url: Type.Optional(Type.String({ description: "Explicit target URL. If omitted, the gateway uses URLs in the task or its own search/probing judgment." })),
			profile: Type.Optional(Type.String({ description: "Persistent browser profile key. Default web-automation-gateway or active skill if detectable." })),
			rawOutput: Type.Optional(Type.Boolean({ description: "Ask the internal probe to include detailed DOM/network evidence in subagent tool details. Default false." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			try {
				const profile = params.profile ? sanitizeProfile(params.profile) : sanitizeProfile("web-automation-gateway");
				onUpdate?.({ content: text("Running restricted web automation gateway subagent..."), details: { profile } });
				const result = await runGatewaySubagent(params.task, params.url, profile, params.rawOutput, signal);
				if (result.exitCode !== 0) {
					return {
						content: text(result.output || result.stderr || `Gateway subagent failed with exit code ${result.exitCode}`),
						details: { profile, exitCode: result.exitCode, stderr: result.stderr },
						isError: true,
					};
				}
				const output = result.output || "Gateway subagent completed without a textual handoff.";
				const truncated = output.length > GATEWAY_OUTPUT_CAP ? `${output.slice(0, GATEWAY_OUTPUT_CAP)}\n\n[Gateway output truncated in content; see details.fullOutput.]` : output;
				return { content: text(truncated), details: { profile, exitCode: result.exitCode, stderr: result.stderr, fullOutput: output } };
			} catch (error) {
				return { content: text(error instanceof Error ? error.message : String(error)), details: undefined, isError: true };
			}
		},
	});

	pi.registerCommand("enable-web-automation-probe", {
		description: "Manually enable the scraping/web automation probe tool for this session",
		handler: async (_args, ctx) => {
			const registered = registerProbeTool();
			if (registered && !pi.getActiveTools().includes("web_automation_probe")) {
				pi.setActiveTools([...pi.getActiveTools(), "web_automation_probe"]);
			}
			ctx.ui.notify(
				registered ? "web_automation_probe enabled for this session" : "web_automation_probe is already enabled",
				"info",
			);
		},
	});
}
