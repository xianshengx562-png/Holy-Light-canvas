---
name: closed-mj-assets
description: 为 Midjourney 生成和优化角色、场景及道具资产提示词，提供中英双语正文、参考图一致性建议与图片问题诊断。适用于用户明确要求 MJ 资产提示词或选用此技能。
license: MIT
metadata:
  version: 1.6.0
  params_as_of: 2026-06-13
---

# MJ 资产指导

本技能使用 MJ 专用的双语正文与构图规则。人物、场景和道具均围绕用户当前创作要求；已有形象与明确构图优先。其他官方技能的通用资产模板保持各自原有行为。

以下资料由用户提供，参数资料日期为 2026-06-13；版本能力以当前目标服务为准。选择技能只准备提示词，不发送生成任务。

This skill writes, debugs, and grades Midjourney prompts. It is **version-aware** (default **V8.1**; also V7 and niji 7) and **methodology-first**. Detailed, volatile facts live in `references/` files — load them on demand rather than reciting from memory.

> **Hard rule:** Midjourney consumes **English** — the prompt the user pastes into MJ is **always English**. Output is **bilingual by default**: a **中文版** of the prompt **and** an English version (the MJ-ready one) of the *same* image. Never paste the 中文版 into MJ (unless the user is on a Chinese-language tool). See `references/translation-zh.md` for Chinese users.

> **Operating discipline:** never recite a parameter from memory — always read the loaded `params-*.md`. Never present a `[L]` (low-confidence) fact as certain; tell the user to verify in-app. Generation is **manual** — never attempt Discord/web automation. State the `params_as_of` date when parameters materially affect the answer.

> **Output contract — the user owns the flags:** the copy-ready prompt is **pure English description only**. Never write parameter flags (`--ar` `--s` `--no` `--seed` `--v` `--hd` `--sref` `--oref` …) into it. Param + version knowledge exists to **choose/recommend the target version** and to **answer param questions on request** — never to append to the prompt. The user sets every flag themselves in-app. (If they explicitly ask for a ready-to-run string *with* flags, put it on a **separate line outside** the prompt block, labelled as an editable suggestion.)

> **Standing user preference — character-design defaults.** When the user asks to design a character, default to a **portrait**, and keep what's *fixed* strictly separate from what must *vary*:
>
> **A. Structural defaults — stable (apply every time unless the user overrides):**
> - **Crop:** one tight **head-and-shoulders / chest-up portrait ("半身大头照")** — not full-body, not a wide scene; subject facing or near-facing camera.
> - **Background:** strongly **blurred / bokeh**, shallow depth of field — pure mood, no competing detail.
> - **Name overlay:** if the user gives a name, **add it** as bold title text in a corner (CJK may render imperfectly — still add it; don't lecture).
> - **Output:** bilingual (中文版 + English), description-only — per the contracts above.
>
> **B. Per-character variables — CHOOSE to fit each character, never lock a default:**
> - **Lighting *type* & intensity** (`references/vocabulary.md §2`): soft natural backlight/rim, golden-hour, window/overcast, hard noir, neon, moonlight, dappled, god rays… — **soft or hard, dramatic or flat, including shadowless / high-key when the character calls for it. No minimum "drama" requirement.**
> - **Color temperature & palette** (`references/vocabulary.md §4`): warm, cool, or neutral — whatever suits the character.
> - **Mood, facial features, styling** (`references/vocabulary.md §6` etc.): per the character's concept.
> - **Vary these across characters** so two different characters never come out identically lit / graded.
>
> **Root rule (why this is split):** defaults govern **structure** (crop / background / output format) — **never a specific aesthetic** (a fixed temperature, one light type, a "drama" level, a face type).
> - **Placement test (mechanical):** if you can imagine a legitimate character for whom the *opposite* choice is right, it's an **aesthetic → put it in B**. Only put a trait in **A** if its opposite would *always* be a defect (e.g. a full-body wide scene, or a sharp busy background, defeats the 大头照 portrait itself).
> - Baking an aesthetic into the template is what made every character look the same. So when the user corrects the **same aesthetic** again, move it into **B**, do **not** add another fixed rule.

---

## 1. First move: pick the version, then load its params

Decide the target model **before** writing anything:

| Target | Choose when | Load |
|---|---|---|
| **V8.1** (default) | general image generation; newest, native HD | `references/model-parameters.md` + `references/params-shared.md` |
| **V7** | need subject/character lock (`--oref`), Draft Mode, or `--q` | `references/model-parameters.md` + `references/params-shared.md` |
| **niji 7** | anime / manga / Eastern-illustration | `references/model-parameters.md` + `references/params-shared.md` |

If unclear, default to **V8.1** and say so. Still load the version's params file — its flag knowledge keeps your **version recommendation and any param advice** correct (e.g. don't suggest `--oref` on V8.1, or `--q` where it does nothing). Per the output contract, none of these flags go into the prompt body.

## 2. Intake + clarifying gate

Collect the 6 intake dimensions: **subject, purpose/use, environment, mood, style references, aspect/constraints**.

**Gate:** if **≥2** of {subject, style direction, aspect/use} are unspecified, ask **up to 3** targeted questions before generating. Otherwise proceed and **surface your assumptions** in one line.

**Character-design shortcut:** the character-design default profile (above) sets framing & background and tells you how to **pick** lighting/palette per character — for character work **don't re-ask those**; only clarify genuinely missing subject specifics, then proceed.

## 3. Choose the approach

Read `references/approach-matrix.md` to pick prompt-only vs `--sref` (look) vs `--oref` (subject, V7) vs personalization vs hybrid. If the chosen approach is version-exclusive (e.g. `--oref` forces V7), tell the user the trade-off, confirm, and **reload** that version's params (back to §1).

## 4. Construct (methodology-first)

Follow `references/construction-method.md`. Element order, front-loaded:

> **subject → environment → lighting → style/medium → camera**  *(the prompt ends here — parameters are the user's, never appended)*

Write descriptive phrases (not tag soup). Apply the **concrete-descriptor rule** ("matte ceramic" > "smooth") and the **modifier cap** (2–3 style modifiers, different categories). Pull concrete words from `references/vocabulary.md`.

## 5. Parameters are the user's to set (don't emit them)

Per the output contract, **never append flags to the prompt** — the user picks all of them. Use the loaded version file + `params-shared.md` only to:
- **recommend the target version** in prose, and tell the user to select it in-app (e.g. set the model to V7 / niji 7 — don't assume it's already active);
- **answer param questions on request**, version-correct: cite flags only from the loaded files, never mix version-exclusive flags, and flag any `[L]` value as "verify in-app" (e.g. `--exp` range).

If the user explicitly asks for a ready-to-run string *with* flags, give it on a **separate line outside** the copy-ready prompt block, labelled as a suggestion they can change.

## 6. Output format

Deliver, in this order:
1. **Two versions of the prompt, each in its own copy-ready code block — description only, no parameter flags:**
   - **中文版** — a full Chinese version of the prompt (for the user to read / edit).
   - **English version** — the **MJ-ready** one to paste into Midjourney (MJ consumes English).
   Both describe the *same* image; translate imagery, not word-for-word (see `references/translation-zh.md`). Never paste the 中文版 into MJ.
2. One line of rationale (中文 when conversing in Chinese) — what the prompt is doing / how you read their intent.
3. The **recommended target version** in prose (the wording is tuned for it; the user sets the model + all flags). Add the `params_as_of` date and a "verify in-app" note only when you actually gave param advice.

## 7. Grading loop (when the user pastes a rendered image)

You are multimodal — when the user pastes a Midjourney output, run `references/grading-rubric.md`: score 7 dimensions (1–5), name the **weakest**, route to `references/failure-modes.md`, and propose **one** revised prompt that changes **one** lever. Re-grade on the next paste.

## 8. Debugging (something looks wrong, no image needed)

Use `references/failure-modes.md` — match the symptom to an entry (`ADH/SUBJ/COMP/LIGHT/STYLE/COH/REF/VER`), apply the highest-priority fix, explain why.

## 9. Chinese users

Converse and run intake in 中文, and output **both a 中文版 and an English version** of the prompt (the English one is what goes into MJ). Use `references/translation-zh.md` to translate aesthetic intent (国风/水墨/电影感…) into concrete description — **translate the imagery, not the words** — keeping the two versions describing the same image. Never mix Chinese into the **English** MJ prompt itself. For an in-image name/text, follow the character-design name-overlay default (add it; CJK may need a post pass — don't lecture the user).

## 10. Always-on rules

- Never hardcode a parameter from memory; read the loaded `params-*.md`.
- Never assert a `[L]` fact as certain — flag "verify in-app".
- Generation is manual; no Discord/browser automation (ToS/ban risk).
- When a param is version-specific, double-check it's in the loaded version's file before **recommending** it — you never emit flags into the prompt (see the output contract).
