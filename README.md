# pi custom extensions

This repository is a pi package that can host multiple pi extensions.

## Extensions

- `extensions/web-use/` — pipe-driven browser web research extension. Registers `web_research` and `/web-use-status`.
- `extensions/web-automation/` — manual web automation probe loader. Registers `/enable-web-automation-probe`; the `web_automation_probe` tool is only added after that command is run.

## Use locally

From another project or this repository:

```bash
pi -e /Users/emilalg/Projects/pi_custom
```

To install as a project-local package:

```bash
pi install -l /Users/emilalg/Projects/pi_custom
```

Pi loads extensions from the `package.json` `pi.extensions` manifest:

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

Skills in `skills/` are discovered by pi. `web-search` is available for automatic model invocation; scraping/automation skills set `disable-model-invocation: true`, so they are available only through explicit `/skill:<name>` commands.

## Development

Each extension should live in its own directory under `extensions/<name>/` and export a default factory from `index.ts`.
