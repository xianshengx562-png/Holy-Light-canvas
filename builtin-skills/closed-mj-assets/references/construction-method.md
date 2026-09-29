# Prompt Construction Method (version-independent)

A repeatable procedure for building a Midjourney prompt. This is **methodology** — it does not change across model versions. Pull concrete words from `vocabulary.md`. Parameters are the user's to set — `params-*.md` is for version choice and on-request advice, **not** for appending flags to the prompt.

## The element order (front-loaded)

Midjourney weights the **start** of the prompt most. Build in this order:

> **subject → environment → lighting → style/medium → camera**

The prompt body ends there — **parameters are the user's to set and never go into the prompt** (see the SKILL output contract). Write as natural descriptive phrases (V7/V8.1 reward description over bare comma-tags). Keep it tight — every word competes for attention.

---

### 1. Subject — *what is this, concretely?*
- **Ask:** Who/what is the single focus? What are they doing? What 2–3 concrete details make them specific?
- **Good:** `a weathered fisherman mending a green net`, `a single matte-black ceramic teapot, steam rising`, `a snow leopard mid-leap`
- **Replaces:** `a man`, `a nice object`, `an animal` (generic noun → stock-photo result).
- **Rule:** add 2–3 concrete descriptors (age, material, action, distinguishing feature). One clear subject beats three competing ones.

### 2. Environment — *where, and what's around it?*
- **Ask:** Setting, era, background density, foreground props?
- **Good:** `on a fog-wrapped stone pier at dawn`, `against a seamless warm-grey studio backdrop`, `in a neon-soaked rain-slick alley`
- **Replaces:** `in a cool place`, `nice background`.
- **Rule:** for text/logo overlays, specify `negative space` / `minimal centered composition on plain background`.

### 3. Lighting — *one light source + its quality?*
- **Ask:** Source, direction, hardness, mood?
- **Good:** `golden-hour side-light`, `overcast softbox diffusion`, `hard noir key-light from below`, `warm rim light from behind`
- **Replaces:** `good lighting`, `well lit`.
- **Rule:** name **source + direction + quality**. Lighting is the biggest lever on mood and realism.

### 4. Style / medium — *what is it made of, aesthetically?*
- **Ask:** Medium (photo, oil, 3D render, cel-shaded), and at most one aesthetic movement or technique?
- **Good:** `35mm film photograph`, `gouache illustration, visible brush texture`, `cel-shaded anime key visual`
- **Replaces:** `beautiful`, `masterpiece`, `award-winning`, `8k` (hype words that add nothing in V7/V8.1).
- **Rule:** **cap style modifiers at 2–3, each from a different category** (e.g. medium + lighting + era). 5+ conflicting modifiers average into mush.

### 5. Camera — *how is it framed (if it matters)?*
- **Ask:** Shot size, lens/DoF, angle?
- **Good:** `tight portrait, 85mm, shallow depth of field`, `wide establishing shot, low angle`, `flat-lay top-down`
- **Replaces:** `cool angle`.
- **Rule:** for faces/hands, prefer a **tighter shot** — small faces in wide shots are where anatomy breaks.

### 6. Parameters — *the user's to set; never emitted by the skill*
- The prompt body carries **no flags**. The user picks `--ar`, `--stylize`, `--no`, `--seed`, model, mode — all of it.
- Use `params-<version>.md` + `params-shared.md` only to **recommend the target version** and to **answer param questions on request** (version-correct: cite flags only from the loaded files; never mix version-exclusive flags).
- Tell the user to **select the model in-app** (e.g. V7 or niji 7) so they don't silently render on V8.1 — but don't write `--v` / `--niji` into the prompt.
- When you do give param advice, mark any `[L]` value: e.g. `--exp 20  (experimental; verify range in-app)`, and keep it **outside** the copy-ready prompt block.

---

## Two rules that carry the whole method

1. **Concrete over abstract.** Replace every evaluative word with a sensory one: `smooth` → `matte ceramic`; `good lighting` → `golden-hour side-light`; `detailed` → name the actual details.
2. **One subject, few modifiers.** A focused prompt with 2–3 deliberate modifiers beats a long wishlist. If the result is muddy, **remove** words before adding them.
