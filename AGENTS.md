# AGENTS.md

## Purpose

This repo is a pi package for custom pi extensions and skills. Extensions live in `extensions/<name>/index.ts` and are loaded explicitly via `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./extensions/web-use/index.ts",
      "./extensions/web-automation/index.ts"
    ],
    "skills": ["./skills/*"]
  }
}
```

## Current extensions

- `extensions/web-use/` — Patchright-driven Chrome-for-Testing web research with `web_research` and `/web-use-status`.
- `extensions/web-automation/` — manual loader for scraping/browser automation probing. It registers `/enable-web-automation-probe`; `web_automation_probe` is only registered after that command is run.

## Current skills

- `skills/web-search/` — automatic skill for using `web_research`.
- `skills/web-automation-gw/` — manual-only skill (`disable-model-invocation: true`), invoked with `/skill:web-automation-gw`.
- `skills/web-scraper-dev/` — manual-only skill (`disable-model-invocation: true`), invoked with `/skill:web-scraper-dev`.

## Web-use notes

- Browser control uses Patchright against the managed Chrome-for-Testing binary; avoid direct pipe/CDP control.
- Chrome-for-Testing stable is installed under `~/.pi/web-search/chromium`.
- Persistent global profiles live under `~/.pi/web-search/profiles/<profile>`.
- Raw page text stays out of tool details unless `rawOutput: true`.
- Source analysis is delegated to the internal skill at `extensions/web-use/skills/web-research-analyst/` using `openai-codex/gpt-5.4-mini`.

## Commands

```bash
npm install
npm run typecheck
pi -e /Users/emilalg/Projects/pi_custom
```

## Guidelines

- Keep each extension independent.
- Default-export a function accepting `ExtensionAPI`.
- Use `typebox` for tool schemas.
- Prefer type-only pi imports.
- Return clear tool errors with `isError: true`.
- Keep web behavior explicit, bounded, and unauthenticated unless requested.
- Run `npm run typecheck` before committing.

## New extension template

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // register tools, commands, or event handlers
}
```
