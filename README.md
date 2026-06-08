# pi custom extensions

This repository is a pi package that can host multiple pi extensions.

## Extensions

- `extensions/web-use/` — pipe-driven browser web research extension. Registers `web_research` and `/web-use-status`.
- `extensions/placeholder/` — placeholder second extension with `/placeholder-extension`.

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
    "extensions": ["./extensions/*/index.ts"]
  }
}
```

## Development

Each extension should live in its own directory under `extensions/<name>/` and export a default factory from `index.ts`.
