# Holy Light Canvas

> An infinite canvas — I took AIFISHER as a reference and mixed in ideas of my own.

A canvas-style desktop app for AI creation workflows: it turns "text → image → video" into a graph you can re-run over and over. All data stays on your own machine (`%APPDATA%\holy-light-canvas`); there is no cloud dependency beyond the account system.

---

## What it does

**Canvas and nodes.** Drag nodes onto an infinite canvas, connect them, and compose a generation pipeline. Node types include text, image generation, video generation, prompt optimization, first/last frame, video joining, assets and references. Every node can be individually **bypassed** (context menu, or press `B`) — a bypassed node just passes the upstream value through without running its own step, so debugging a long chain does not mean unplugging wires over and over.

**Four image sources.**

| Source | Notes |
| --- | --- |
| Local ComfyUI | Talks to the ComfyUI you already run (bundled extensions included) and binds workflow fields onto canvas nodes |
| RunningHub | Cloud workflow apps, submitted asynchronously and polled |
| Custom endpoint | Any OpenAI-compatible gateway (`/v1/images/generations` and `/v1/images/edits`); aspect ratio + resolution are turned into a pixel string |
| Video | Video generation nodes, again local / RunningHub / custom endpoint |

**Built-in skills.** Freeze your methodology into reusable prompt-rewrite rules: a skill is a directory (`skill.json` plus a few prompt files), and the prompt-optimize node rewrites the upstream text according to the selected skill.

**The rest.** Asset library (categories / batch actions / orphan cleanup), workflow library, director stage (batch storyboards), tool pages (video join, video split), site account and quota, in-app updates.

**Codex integration.** `tools/frame-mcp` is an MCP server that lets Codex read and write the projects / nodes / edges / workflows / tasks on the canvas (triggering a generation is denied by default and has to be switched on explicitly).

## Stack

- **Electron 44** + **electron-vite** (single-process layout, the backend runs in a utility process)
- **React 19** + **TypeScript 5** + **@xyflow/react** (canvas) + **zustand** (state)
- **zod** for the API layer, **Tailwind 4** plus a hand-written set of CSS tokens for theming
- Data layer: local **SQLite** (`node:sqlite`), with `HOLYLIGHT_DB_ENGINE=json` falling back to a JSON engine
- **electron-updater** for in-app updates

## Layout

```
src/            renderer: pages (app/), canvas and components (components/)
electron/       main process: window / tray / backend process management / updates / bundled extensions
server/api/     route layer (dispatched directly by the main process, not a real HTTP server)
lib/            domain code shared by both sides: workflows, providers, database, skills, media…
tools/frame-mcp MCP toolkit for Codex
builtin-skills/ skills shipped with the app
integrations/   ComfyUI extensions shipped with the app
resources/      bundled native runtime (llama.cpp; binaries are not in the repo)
```

## Development

```bash
npm install
npm run dev          # start in dev mode
npm run typecheck    # tsc, both projects
```

## Packaging

```bash
npm run dist         # portable directory dist/win-unpacked
npm run installer    # NSIS installer
```

Output lands in `dist/`. Installer and portable file names come from `build.nsis.artifactName` and `build.portable.artifactName` in `package.json`.

## Where data lives

By default under `%APPDATA%\holy-light-canvas`:

```
data/       SQLite database (projects, canvases, tasks, asset metadata, users and keys)
storage/    media files (generated images / videos, uploaded references)
skills/     skills you imported
logs/       runtime logs
```

Three ways to move it: **portable mode** (drop a `data/portable.json` marker next to the program directory), the `HOLYLIGHT_DATA_DIR` environment variable, or changing the output directory in Settings.

Latents are stored under `storage/latents/` as plain `.safetensors` files (before 1.0.87 they were gzipped `.latent.gz`; old archives are still read fine) — the file on disk is a standard safetensors file you can hand to a local ComfyUI or to the upstream node as-is.

## In-app updates

Through GitHub Releases (a `generic` provider pointing at this repo's `releases/latest/download/`). When releasing, upload the installer together with `latest.yml`; the URL can be pointed somewhere else in Settings · Updates.

## License

MIT, see [LICENSE](LICENSE). Use it, change it, redistribute it — attribution is enough.

Skill contents under `builtin-skills/` (prompt methodologies, reference libraries) are MIT as well.
