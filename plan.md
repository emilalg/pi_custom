# Web Automation Gateway Plan

## Problem

`web_automation_probe` is a powerful browser/network inspection tool. It should not be visible during normal pi sessions, but it should become available automatically when a user explicitly invokes a web automation gateway workflow. The gateway/probing layer should also remain separate from scraper implementation so it can support scraping, form workflows, QA/browser automation, monitoring, or other browser-related tasks.

## Design Goal

Keep the system lightweight and non-invasive:

- Normal pi usage: no `web_automation_probe` visible.
- Gateway invocation: probe is available automatically.
- Gateway model: only allowed to inspect/analyze; no `bash`, `write`, `edit`, or scraper coding.
- Downstream implementation skills: receive the gateway handoff and use normal coding tools, but do not directly use the probe.
- Avoid building a large scraper pipeline/orchestrator unless usage grows.

## Recommended Approach

Implement a single reusable extension-level tool:

```text
web_automation_gateway
```

This tool becomes the public interface for browser/site investigation. Internally it runs a restricted pi subagent with:

```text
skills/web-automation-gw
web_automation_probe
```

and no general coding/shell tools.

The raw probe remains hidden from the normal model prompt.

## User Workflow

For investigation only:

```text
Use web_automation_gateway to investigate how this form/page/API works: <url/task>
```

For scraper development:

```text
/skill:web-scraper-dev
Use this gateway handoff to build the scraper: ...
```

For other automation tasks later:

```text
/skill:form-automation-dev
Use this gateway handoff to build a form submission script: ...
```

The gateway output is reusable across multiple downstream skills.

## Why This Is Cleaner Than `/enable-web-automation-probe`

The current manual enable command is easy to forget and exposes the wrong abstraction. The user should not need to know that the probe exists.

Instead:

- `web_automation_gateway` is visible/usable when needed.
- `web_automation_probe` is an implementation detail.
- The gateway can be locked to probe-only behavior.
- Scraper/form/QA skills consume the gateway handoff rather than owning browser probing.

## Why Not Build a Full Pipeline Yet

A full pipeline like:

```text
gateway -> scraper-dev -> validator -> final dataset
```

would be ideal for frequent scraper work, but it is more complexity than needed right now.

The lightweight version gives the important separation:

```text
probe/investigate separately from implement/code
```

without creating a large orchestration framework.

## Implementation Sketch

### 1. Keep `web_automation_probe` registered internally or lazily

Do not expose it through `promptSnippet` during normal sessions, or keep it inactive by default.

### 2. Add `web_automation_gateway` tool

The tool accepts:

```ts
{
  task: string;
  url?: string;
  profile?: string;
  rawOutput?: boolean;
}
```

It spawns a restricted pi subprocess roughly like:

```bash
pi --print \
  --no-session \
  --no-context-files \
  --no-skills \
  --skill skills/web-automation-gw \
  --tools web_automation_probe \
  --model openai-codex/gpt-5.5 \
  "/skill:web-automation-gw <task>"
```

Exact flags may need adjustment because the subprocess must load the extension that provides `web_automation_probe`.

### 3. Restrict gateway tool access

The gateway subagent should have only:

```text
web_automation_probe
```

No:

```text
bash
read
write
edit
```

If pi CLI tool allowlisting is insufficient for extension tools, enforce with an extension `tool_call` block in gateway mode.

### 4. Gateway output format

Require the gateway subagent to return a structured handoff:

```md
## Web Automation Handoff

### Objective
### Access / Gating
### Delivery Mechanism
### Candidate Endpoints / Requests
### DOM / Form / Selector Evidence
### Headers / Cookies / Auth Signals
### Pagination / Interaction Flow
### Recommended Implementation Approach
### Confidence Labels
### Risks / Unknowns
```

It must distinguish:

- live-observed evidence
- documentation-derived evidence
- third-party/example-derived evidence
- hypotheses

### 5. Downstream skills consume the handoff

`web-scraper-dev` should not probe directly unless explicitly asked. It should prefer receiving a gateway handoff.

Future skills can do the same:

```text
form-automation-dev
qa-browser-workflow-dev
monitoring-script-dev
```

All can share the same gateway.

## Near-Term Tasks

1. Add `web_automation_gateway` tool to `extensions/web-automation/index.ts`.
2. Make `web_automation_probe` hidden/inactive by default.
3. Have `web_automation_gateway` run a restricted subagent using the existing `web-automation-gw` skill.
4. Update `web-automation-gw` wording so it assumes probe-only access.
5. Update `web-scraper-dev` to say: use gateway handoffs when available; do not own browser investigation.
6. Test with:
   - `https://example.com`
   - OpenRouter models/pricing
   - a simple public form page

## Later, Only If Needed

If this becomes frequently used, add a higher-level optional pipeline:

```text
web_automation_gateway -> implementation skill -> validation
```

But keep that separate from the gateway itself.

## Final Recommendation

Build the reusable `web_automation_gateway` tool now. Do not build the full scraper pipeline yet. Keep probing as a small, isolated subagent capability that can feed scraper development or any future browser automation skill without leaking `web_automation_probe` into normal model context.
