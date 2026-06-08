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
	status?: number;
	mimeType?: string;
	responseHeaders?: Record<string, string>;
	bodyPreview?: string;
};

const MAX_REQUESTS = 80;
const MAX_SNIPPET_CHARS = 1_500;
const MAX_BODY_PREVIEW = 4_000;

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
	return /json|graphql|api|search|models|pricing|catalog|list|query/i.test(`${entry.url} ${entry.mimeType || ""}`);
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
				forms: Array.from(document.querySelectorAll('form')).slice(0, 10).map(f => ({ action: f.action, method: f.method, text: clip(f.innerText || ''), inputs: Array.from(f.querySelectorAll('input, select, textarea')).slice(0, 25).map(i => ({ tag: i.tagName.toLowerCase(), name: i.getAttribute('name'), type: i.getAttribute('type'), placeholder: i.getAttribute('placeholder') })) })),
				snippets: [
					...pick('[data-testid], [data-test], [data-cy]', 20),
					...pick('table, [role="table"], [role="row"], article, main li, main [class]', 30)
				],
				embeddedJson
			};
		})()`,
	);
}

async function probeSite(task: string, url: string, profile: string, signal?: AbortSignal) {
	return await withBrowser(profile, signal, async ({ page }) => {
		const byRequest = new Map<Request, NetworkEntry>();
		const responses = new Map<Request, Response>();
		let nextRequestId = 1;

		page.on("request", (request) => {
			const entry: NetworkEntry = byRequest.get(request) ?? { requestId: String(nextRequestId++) };
			entry.method = request.method();
			entry.url = request.url();
			entry.requestHeaders = redactHeaders(request.headers());
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

		const requests = [...byRequest.entries()].map(([request, entry]) => ({ request, entry })).filter(({ entry }) => interestingRequest(entry)).slice(0, MAX_REQUESTS);
		for (const { request, entry } of requests) {
			if (!/json|graphql|javascript/i.test(entry.mimeType || "") || !/xhr|fetch/i.test(entry.type || "")) continue;
			try {
				const response = responses.get(request);
				entry.bodyPreview = response ? (await response.text()).slice(0, MAX_BODY_PREVIEW) : undefined;
			} catch {
				// Body may be unavailable after navigation; metadata is still useful.
			}
		}

		return { task, requestedUrl: url, dom, requests: requests.map(({ entry }) => entry) };
	});
}

function summarizeProbe(result: Awaited<ReturnType<typeof probeSite>>): string {
	const apiish = result.requests.filter((r) => ["xhr", "fetch"].includes((r.type || "").toLowerCase()) || /json|graphql|api/i.test(`${r.url} ${r.mimeType}`));
	const lines = [
		"## Web Automation Probe",
		`URL: ${result.dom.finalUrl || result.requestedUrl}`,
		`Title: ${result.dom.title || "unknown"}`,
		`Network requests captured: ${result.requests.length}`,
		`API/XHR/fetch-like requests: ${apiish.length}`,
		"",
		"### Likely Relevant Requests",
		...(apiish.slice(0, 12).map((r, i) => `[#${i + 1}] ${r.method || "GET"} ${r.url}\n- type/status/mime: ${r.type || "?"} / ${r.status || "?"} / ${r.mimeType || "?"}`) || []),
		"",
		"### DOM Evidence",
		`- Links: ${result.dom.links?.length ?? 0}`,
		`- Forms: ${result.dom.forms?.length ?? 0}`,
		`- Embedded JSON/script data blocks: ${result.dom.embeddedJson?.length ?? 0}`,
		`- Candidate snippets: ${result.dom.snippets?.length ?? 0}`,
	];
	return lines.join("\n");
}

export default function webAutomationExtension(pi: ExtensionAPI) {
	let probeRegistered = false;

	function registerProbeTool() {
		if (probeRegistered) return false;
		probeRegistered = true;

		pi.registerTool({
			name: "web_automation_probe",
			label: "Web Automation Probe",
			description: "Inspect a website through Chrome for automation handoff evidence: DOM structure, embedded data, forms/links, and network requests/headers.",
			promptSnippet: "Probe a target website for automation evidence including DOM, embedded JSON, forms, links, and network API calls.",
			promptGuidelines: [
				"Use web_automation_probe only after the user manually enables web automation probing for a scraping, extraction, QA, monitoring, or browser-workflow task.",
				"Use web_automation_probe to gather evidence only; do not use it to bypass authentication, CAPTCHA, paywalls, or bot protections.",
			],
			parameters: Type.Object({
				task: Type.String({ description: "Scraping directive, ideally including a target URL." }),
				url: Type.Optional(Type.String({ description: "Explicit target URL. If omitted, the first URL in task is used; as a last resort a search result may be used." })),
				profile: Type.Optional(Type.String({ description: "Persistent browser profile key. Default web-automation or active skill if detectable." })),
				rawOutput: Type.Optional(Type.Boolean({ description: "Include detailed DOM/network evidence in details. Default true for this probe." })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				try {
					const profile = inferProfile(params.profile, ctx);
					const url = params.url || extractUrl(params.task) || (await searchFirstResult(params.task, signal));
					if (!url) throw new Error("No target URL found. Provide a URL or a task specific enough to search.");
					const result = await probeSite(params.task, url, profile, signal);
					return {
						content: text(summarizeProbe(result)),
						details: {
							profile,
							requestedUrl: result.requestedUrl,
							finalUrl: result.dom.finalUrl,
							title: result.dom.title,
							requests: result.requests,
							dom: params.rawOutput === false ? undefined : result.dom,
						},
					};
				} catch (error) {
					return { content: text(error instanceof Error ? error.message : String(error)), details: undefined, isError: true };
				}
			},
		});
		return true;
	}

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
