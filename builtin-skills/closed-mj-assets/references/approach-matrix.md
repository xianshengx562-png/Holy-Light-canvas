# Approach Selection Matrix

Before writing the prompt, choose **how** you'll achieve the look. Picking the wrong approach is why results drift. Match the user's goal to a method, and watch the **version gotcha** column — some methods force a specific model.

| Goal | Recommended approach | Key flags | Version gotcha |
|---|---|---|---|
| One-off novel concept, max control | **Prompt-only** | construction method + `--stylize`/`--raw` | None. Cheapest, most flexible. Default starting point. |
| Same *look / mood* across different subjects (brand, series) | **Style reference** | `--sref <code or url>` + `--sw` (+ `--sv`) | Numeric codes transfer more reliably than image refs in V7+. Does **not** lock a character. |
| Same *specific character/object* recurring across scenes | **Omni Reference** | `--oref <url>` + `--ow 200–400` | **V7-only** → forces `--v 7`. Not available on V8.1/niji. On V8.1, approximate with repeated descriptors + shared `--sref` + locked `--seed`. |
| Anime / manga look | **niji model** | `--niji 7` + shared params | Switches model line. `--oref` unavailable; use `--sref` + seed for consistency. |
| Your personal taste applied to everything | **Personalization** | `--p` (after unlocking a profile) | Not on by default; strength scales with `--stylize`. Stackable with the above. |
| Match a broad style from many images you collected | **Moodboard** | `--p <moodboardID>` | Cannot combine with `--sw`/`--sv`. |
| Brand character + brand look + new scene (the powerful combo) | **Hybrid** | `--oref` (who) + `--sref` (look) + prompt (scene) + optional `--p` | Hybrid with `--oref` forces **V7**. Example: `... --oref URL --ow 250 --sref 123456 --sw 200 --v 7` |
| Cheap, fast iteration before committing GPU | **Draft / SD** | V7: `--draft` · V8.1: `--sd` | `--draft` is V7-only; `--sd` is V8.1-only. Pick by target version. |
| Seamless pattern / texture | **Tile** | `--tile` | Don't upscale (breaks seam). |

## Decision shortcuts
- **"I just want a good image of X"** → Prompt-only (V8.1 default).
- **"Make it look like THIS reference"** → is it the *subject* or the *style*? Subject → `--oref` (V7). Style → `--sref`.
- **"Keep my character consistent"** → `--oref` on V7 (+ identical descriptors + seed).
- **"Anime"** → `--niji 7`.
- **"It should match my brand's vibe every time"** → build a Moodboard / Personalization profile.

> When a chosen approach forces a version change (e.g. user is on V8.1 but needs `--oref`), **tell the user the trade-off and confirm the switch**, then reload that version's `params-*.md`.
