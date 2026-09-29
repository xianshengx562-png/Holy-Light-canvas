# Midjourney — Cross-Version Parameter Reference (shared)

**As-of date:** 2026-06-13
**Scope:** parameters that behave the same across V8.1 / V7 / niji 7. Version-exclusive flags live in `params-v81.md`, `params-v7.md`, `params-niji7.md`.

**Confidence legend:**
- `[C]` confirmed against official docs (docs.midjourney.com) or official changelog.
- `[S]` secondary source (reputable 2025–2026 guides); directionally reliable.
- `[L]` low-confidence / disputed / community-sourced — **state the uncertainty and tell the user to verify in-app.** Never present an `[L]` number as fact.

**Maintenance rule:** when MJ changes a shared param, edit THIS file's row, bump the As-of date above, and add a `CHANGELOG.md` entry. Do not edit `SKILL.md`.

---

## Core table

| Param | Range / Values | Default | Conf | Push which way | Notes / interactions |
|---|---|---|---|---|---|
| `--ar` / `--aspect` | `w:h`, **whole numbers only** (no decimals). Practical max ~`14:1` | `1:1` | `[C]` | first number ↑ = landscape; second ↑ = portrait | Set explicitly for any non-square use (9:16 reels, 16:9, 3:2, 2:3). Extreme ratios are "experimental." |
| `--stylize` / `--s` | `0`–`1000` | `100` | `[C]` | low (50–150) = literal / photoreal; high (400–1000) = artistic, drifts from prompt | `[L]` V7/V8.1 are recalibrated **higher** than V6 — old V6 numbers look flat; raise them. Don't reuse V6 values 1:1. |
| `--chaos` / `--c` | `0`–`100` | `0` | `[C]` | ↑ = more varied / divergent grid (lowers prompt adherence) | Web UI calls this "Variety." Keep 0–10 for series consistency; 25–40 to explore. |
| `--weird` / `--weird` | `0`–`3000` | `0` | `[C]` | ↑ = quirky / unconventional aesthetics | Experimental; interacts poorly with `--seed` reproducibility. |
| `--no` | comma-separated terms | — | `[C]` | list things to exclude | Each term read **independently** (`--no modern clothing` → "no modern" + "no clothing"). Mechanically equals a `::-0.5` weight. The **only** officially universal negative mechanism. |
| `--seed` | integer `0`–`4294967295` | random | `[C]` | lock to A/B-test one prompt change | Not a style/character lock. Unreliable in Turbo mode and across sessions. |
| `--tile` | flag | off | `[C]` | on = one seamless repeating tile | Wallpaper/fabric/pattern. Do not upscale (breaks the seam). |
| `--repeat` / `--r` | `2`–`40` (plan-capped: Basic 2–4, Standard 2–10, Pro/Mega 2–40) | — | `[C]` | run same prompt N times at once | Fast/Turbo modes only. Stripped from the finished prompt; re-add to rerun. |

## Style reference family (works V6 and later)

| Param | Range / Values | Default | Conf | Push which way | Notes |
|---|---|---|---|---|---|
| `--sref` | image URL(s) · numeric **style code(s)** · `random` | — | `[C]` | match the *look/vibe* (color, medium, texture, light) — **not** the subject | Blend codes by space-separating: `--sref 111 222`. `--sref random` invents a style and prints a reusable code. You cannot mint a code from your own upload. |
| `--sw` (style weight) | `0`–`1000` | `100` | `[C]` | ↑ = stronger style adherence | `[S]` natural sweet spot ≈ 65–175; many run ~250–500 for strong **code** transfer. `[S]` in V7 `--sw` affects codes more than image refs. **Incompatible with Moodboards.** |
| `--sv` (sref version) | `4` or `6` (V7) | `6` | `[C]` | which sref algorithm | `[S]` use `--sv 4` to revive pre-2025-06-16 style codes. `--sref random`/codes work with `--sv 4` and `--sv 6`. |
| `::` per-code weighting | `code::N` | — | `[L]` | weight one code vs another (`A::2 B::1`) | Widely reported but **not in official docs for V7/V8.1**. Tell the user to verify; prefer the web Style Explorer for blends. |

## Image prompt & personalization

| Param | Range / Values | Default | Conf | Push which way | Notes |
|---|---|---|---|---|---|
| `--iw` (image prompt weight) | `0`–`3` (niji 7: `0`–`2`) | `1` | `[S]` | ↑ = lean on the image prompt; ↓ = lean on text | This weights an **image prompt** (a URL pasted *in* the prompt), distinct from `--sref`/`--oref`. Ceiling differs by model — verify on the active model. |
| `--p` / personalization | `--p` (your default profile) · `--p <profileID>` · `--p <moodboardID>` | off | `[C]` | apply your learned taste / a moodboard | **NOT on by default** — unlock a Global Profile by rating images first. Personalization strength scales with `--stylize` (`--s 0` minimizes it) `[S]`. |
| Moodboards | curated image set → `--p <moodboardID>` | — | `[C]` | broader style than a single sref | **Cannot combine with `--sw` or `--sv`.** |

## Syntax features

- **Permutations `{}`** `[C]`: comma-separated options in braces, incl. inside params (`--ar {1:1, 2:3}`). Plan-capped (Basic 4 / Standard 10 / Pro·Mega 40). Fast/Turbo only.
- **Rendered text** `[C]`: wrap the literal text in **double quotes** (`"OPEN"`). Single quotes/apostrophes don't trigger it. Best with ≤3 words, common Latin fonts; add "with the text". If garbled, use `--raw` or lower `--stylize`.
- **Multi-prompt `::` weighting** `[L]`: officially documented only up to model 6.1; **not listed for V7/V8.1**. Treat raw `::N` weighting on current models as unverified — use `--no` for negatives (universal).

## GPU / privacy modes (any version)

| Flag | Meaning |
|---|---|
| `--fast` / `--relax` / `--turbo` | speed/credit modes. Seeds unreliable in Turbo; some features Fast-only. |
| `--stealth` / `--public` | private vs public on the website (plan-dependent). |
