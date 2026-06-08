# AGENTS.md

## Purpose

This repo is a pi package for custom pi extensions. Extensions live in `extensions/<name>/index.ts` and are loaded via `package.json`:

```json
{
  "pi": { "extensions": ["./extensions/*/index.ts"] }
}
```

## Current extensions

- `extensions/web-use/` — pipe-driven Chrome-for-Testing web research with `web_research` and `/web-use-status`.
- `extensions/placeholder/` — placeholder extension with `/placeholder-extension`.

## Web-use notes

- Browser control is direct CDP over `--remote-debugging-pipe`; do not add Puppeteer/Playwright drivers.
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
