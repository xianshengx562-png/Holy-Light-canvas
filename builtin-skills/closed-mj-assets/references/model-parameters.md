# Midjourney V8.1 — Parameter Reference (DEFAULT target)

**As-of date:** 2026-06-13
**Default model since:** 2026-06-10 (V8.1 released 2026-04-30)
**Select with:** `--v 8.1` (this is the default; you usually omit it)

**Confidence legend:** `[C]` official · `[S]` secondary · `[L]` low-confidence — verify in-app, never assert as fact.
**Maintenance rule:** edit this file + bump As-of date + `CHANGELOG.md` when V8.1 changes. Do not edit `SKILL.md`.

> Load this file **plus** `params-shared.md` whenever V8.1 is the target. Use them to recommend flags **on request** (cite only flags that appear in these two files) — never write flags into the prompt body (see the SKILL output contract).

---

## V8.1-only parameters

| Param | Range / Values | Default | Conf | Push which way | Notes |
|---|---|---|---|---|---|
| `--hd` / `--sd` | toggle | **`--sd` is the temporary default** during the server transition | `[C]` | `--sd` = fast/cheap drafts (1024px, ~0.8 GPU-min); `--hd` = native 2K finals (~1.3 GPU-min) | V8.1 renders HD **without upscaling**. Switch the default in settings if you want HD-by-default. |

## What V8.1 does NOT have (route accordingly)

| Flag | Status on V8.1 | What to do instead |
|---|---|---|
| `--q` / `--quality` | `[C]` **not a V8.1 user knob** | Use `--hd` / `--sd` for resolution/detail. If a user pastes `--q` on V8.1, tell them it's a V6/V7 knob and is ignored here. |
| `--oref` / `--ow` (Omni Reference, subject lock) | `[C]` **V7-only** | For a recurring specific person/object, **switch the target to V7** (`params-v7.md`). On V8.1 approximate consistency via precise repeated descriptors + a shared `--sref` + a locked `--seed`. |
| `--draft` (Draft Mode) | `[C]` **V7-only** | Use `--sd` for cheap fast iteration on V8.1. |
| `--cref` / `--cw` | `[C]` deprecated everywhere current | Never emit. (Subject lock = `--oref` on V7.) |

## Shared params worth a V8.1 note

| Param | V8.1 behavior |
|---|---|
| `--seed` | `[C]` ~99% reproducible on V8.1 (tighter than older models). Still not a style/character lock. |
| `--stylize` / `--s` | `[L]` recalibrated higher than V6; default 100. Photoreal → `--s 50–150 --raw`; illustration → `--s 400–700`. |
| `--raw` | `[C]` strips MJ's default beautifying aesthetic → more literal/photographic. Pair with low `--stylize`. |
| `--exp` (experimental aesthetics) | `[L]` range **disputed** (`0–100` per most guides; some say higher); default `0`. Small values (~10–25) add detail/energy; high values override `--stylize`/`--p` and hurt prompt accuracy. **Tell the user to verify the ceiling in-app.** |

## V8.1 headline behavior (for guidance, not flags)

- ~4–5× faster than V7; better prompt comprehension and small-detail retention `[C]`.
- Native HD (2K) is the marquee feature; the old "quality" mental model is replaced by SD/HD.
- Prefer **natural-language descriptive phrases** over comma-keyword soup — V8.1's parser rewards description. Front-load the core subject.


# Midjourney V7 — Parameter Reference (first-class, not default)

**As-of date:** 2026-06-13
**Status:** default 2025-04-03 → 2026-06-10; now selectable but **not default**. **Select with `--v 7`.**
**Pick V7 when:** you need **subject/character lock** (`--oref`), **Draft Mode** (`--draft`), or `--q` quality control. Otherwise prefer V8.1.

**Confidence legend:** `[C]` official · `[S]` secondary · `[L]` low-confidence — verify in-app.
**Maintenance rule:** edit this file + bump As-of date + `CHANGELOG.md`. Do not edit `SKILL.md`.

> Load this file **plus** `params-shared.md` whenever V7 is the target. Use them to recommend the right flags **on request** (cite only flags that appear in these two files) — but never write flags into the prompt body (see the SKILL output contract). **Tell the user to select V7 in-app** so they don't silently render on V8.1.

---

## V7-only parameters

| Param | Range / Values | Default | Conf | Push which way | Notes / interactions |
|---|---|---|---|---|---|
| `--oref` (Omni Reference) | one image URL/upload | — | `[C]` | put a **specific** person / object / creature into the image | The V7 successor to character reference. Handles characters **and** objects/props. One reference per generation. Auto-forces V7. Costs ~2× GPU. **Incompatible with** Fast/Draft/Conversational modes, `--q 4`, Vary Region, Pan, Zoom Out `[S]`. |
| `--ow` (Omni Weight) | `1`–`1000` | `100` | `[C]` | ↑ = stronger likeness lock | `[S]` bands: 25–50 = re-style the character (photo→anime); ~100 = balanced; 200–400 = strong face/clothing likeness (most popular); 400+ = max fidelity. Keep **below ~400 unless `--stylize` is very high**, or output gets unpredictable. |
| `--draft` (Draft Mode) | flag | off | `[C]` | fast rough iteration | ~10× faster, ~half GPU cost. "Enhance" to finalize. V7-only. Not compatible with Omni Reference. |
| `--q` / `--quality` | `1`, `2`, `4` (no `3` → snaps to `4`) | `1` | `[C]` | ↑ = more GPU/detail on the first grid | `--q 4` is **not compatible with Omni Reference**. (V8.1 has no `--q` — uses `--hd`/`--sd`.) |

## Deprecated — never emit

| Flag | Status | Replacement |
|---|---|---|
| `--cref` / `--cw` | `[C]` **deprecated for V7+** — official docs say "use Omni Reference instead" | `--oref` + `--ow` |

## Shared params worth a V7 note

| Param | V7 behavior |
|---|---|
| `--stylize` / `--s` | `[L]` recalibrated higher than V6 (v6 `--s 100` ≈ v7 `--s 300–400`). If an old V6 prompt looks flat, raise stylize or add `--exp 10–25`. |
| `--sw` / `--sv` | `[C]` V7 sref default `--sv 6`; `--sv 4` revives old codes. `--sw` impacts numeric codes more than image refs `[S]`. |
| `--exp` | `[L]` present on V7; range disputed; keep small (≤25–50) or it overrides params. Verify in-app. |
| `::` multi-prompt weighting | `[L]` not officially documented for V7. Use `--no` for negatives. |

## Consistency strategy on V7 (guidance)

- **Same character across scenes:** `--oref <url> --ow 200–400` + keep **identical** wardrobe/hair wording every prompt + reuse the same `--sref` + lock `--seed`.
- **Re-style an existing character** (e.g. photo → illustration): same `--oref` but drop `--ow` to 25–50.


# niji 7 — Parameter Reference (anime / Eastern-aesthetic model)

**As-of date:** 2026-06-13
**Status:** niji 7 released 2026-01-09. **Select with `--niji 7`.** (A separate model line, built with Spellbrush.)
**Pick niji when:** the target is anime / manga / Eastern-illustration aesthetics. For photoreal or Western-illustration, use V8.1.

**Confidence legend:** `[C]` official · `[S]` secondary · `[L]` low-confidence — verify in-app.
**Maintenance rule:** edit this file + bump As-of date + `CHANGELOG.md`. Do not edit `SKILL.md`.

> Load this file **plus** `params-shared.md` whenever niji 7 is the target. Use them to recommend flags **on request** (never write flags into the prompt body — see the SKILL output contract). **Tell the user to select the niji 7 model (`--niji 7`) in-app.** niji shares most of the shared table; the deltas are below.

---

## niji 7 selection & behavior

| Item | Value | Conf | Notes |
|---|---|---|---|
| `--niji` | `7` (older: `6`) | `[C]` | Anime/Eastern-aesthetic model. niji 6 released 2024-06-07; niji 7 is current. |
| Aesthetic deltas vs niji 6 | flatter, cleaner linework; sharper/more expressive eyes; more literal prompt reading | `[S]` | Lean on character/pose/expression description; anime tropes (chibi, cel-shading, key visual) land well. |
| `--iw` ceiling | `0`–`2` (not `0`–`3`) | `[S]` | Image-prompt weight ceiling is lower on niji 7 than V7/V8.1. Verify in-app. |

## What differs from V8.1 / V7

| Flag | Status on niji 7 | What to do |
|---|---|---|
| `--oref` / `--ow` | `[C]` **V7-only**, not a niji flag | For consistent anime characters use repeated precise descriptors + shared `--sref` + locked `--seed`. |
| `--cref` / `--cw` | `[L]` worked on niji 6; **niji 7 support uncertain** | Do not rely on it; verify in-app. Prefer `--sref` + seed for consistency. |
| `--hd` / `--sd` | `[L]` V8.1-only resolution flags; niji 7 status unconfirmed | Don't emit on niji; verify if the user asks for HD anime. |
| `--p` personalization / moodboards | `[L]` timing on niji 7 unconfirmed | Usable broadly per docs (V6/V7/V8.1 listed); confirm niji 7 before relying. |

## Shared params (apply as in `params-shared.md`)

`--ar`, `--stylize/--s`, `--chaos/--c`, `--weird`, `--raw`, `--sref/--sw/--sv`, `--no`, `--seed`, `--tile`, `--repeat/--r` all behave per the shared file. Anime work usually wants **lower `--chaos`** (clean, consistent) and `--stylize` tuned to taste (higher for illustrative flair, lower for model-sheet flatness).
