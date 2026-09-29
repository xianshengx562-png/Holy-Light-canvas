# Failure-Mode → Fix Playbook

Symptom → likely cause → specific fix. Indexed by ID so `grading-rubric.md` can route to an entry. Apply **one** fix at a time (highest-priority first), re-render, re-grade. Defaults: `--stylize 100`, `--ar 1:1`, `--chaos 0`, `--sw 100`, `--ow 100`.

Families: `ADH` adherence · `SUBJ` subject/anatomy · `COMP` composition · `LIGHT` lighting/color · `STYLE` style/medium · `COH` coherence/artifacts · `REF` reference images · `VER` version mismatch.

---

### [ADH-01] A named object is missing or merged
- **Symptom:** you asked for X; the render omits it or fuses it into something else.
- **Likely cause:** X is buried late, under-specified, or out-competed by a dominant subject / high `--chaos`.
- **Fix:** 1) move X **earlier** in the element order. 2) make X concrete (material + color + size). 3) lower `--chaos` toward 0; cut competing modifiers. 4) (V7) pin X with `--oref` if it's the recurring subject.
- **Version notes:** `--oref` step is V7-only; on V8.1 rely on ordering + specificity.
- **Confidence:** `[S]` ordering/specificity well-attested; exact `--chaos` thresholds `[L]`.

### [ADH-02] Part of the prompt is ignored / contradicted
- **Symptom:** a clause (pose, color, count) is dropped or reversed.
- **Likely cause:** overloaded or self-contradicting prompt; the clause buried under hype words; `--stylize`/`--exp` too high (aesthetics override instructions).
- **Fix:** 1) one idea per clause; delete contradictions and filler ("masterpiece, 8k"). 2) front-load the ignored clause. 3) lower `--stylize` (and `--exp` if used).
- **Version notes:** V7/V8.1 parse description well — prefer phrases over tag soup.
- **Confidence:** `[S]`.

---

### [SUBJ-01] Distorted hands / extra fingers
- **Symptom:** mangled hands, 6+ fingers.
- **Likely cause:** complex hand pose, hands small/off-center, cluttered scene.
- **Fix:** 1) simplify the hand action; describe it ("hands resting, relaxed"). 2) bring hands into focus / tighter shot. 3) regenerate. 4) **Vary Region** to inpaint just the hand. 5) `--no extra fingers, deformed hands` as a last nudge.
- **Version notes:** none version-specific; tighter framing helps on all.
- **Confidence:** `[S]`.

### [SUBJ-02] Distorted / asymmetric face
- **Symptom:** melted or off face, especially in wide shots or crowds.
- **Likely cause:** small face in a wide composition; too many people.
- **Fix:** 1) tighter shot ("portrait, close-up, 85mm"). 2) single subject. 3) **Vary Region** + Creative Upscale on the face. 4) (V7) `--oref` for a specific identity.
- **Version notes:** `--oref` = V7 only.
- **Confidence:** `[S]`.

### [SUBJ-03] Wrong count / duplicated or merged subjects
- **Symptom:** asked for 2, got 3; figures blend together.
- **Likely cause:** attention spreads across many subjects; models count poorly above ~4–5.
- **Fix:** 1) limit to 1–2 subjects; composite extras separately. 2) avoid exact high counts ("a pile of" not "exactly seven"). 3) `--no duplicate, clone, twin` if it persists. 4) lower `--chaos`.
- **Confidence:** `[S]`.

---

### [COMP-01] Wrong aspect ratio / bad crop
- **Symptom:** unwanted square, subject cut off.
- **Likely cause:** no `--ar`, or composition not planned.
- **Fix:** 1) set `--ar` to target (9:16, 16:9, 3:2). 2) for an otherwise-good image cropped wrong, use **Pan / Zoom Out** (outpaint) rather than re-rolling. 3) name the shot size in the prompt.
- **Confidence:** `[C]` for `--ar`; editor steps `[S]`.

### [COMP-02] Composition too busy for text / logo overlay
- **Symptom:** no clean area to place a headline or logo.
- **Likely cause:** detail spread full-frame.
- **Fix:** 1) prompt `negative space`, `minimalist`, `centered subject on plain background`. 2) keep the center ~60% uniform, push detail to corners. 3) low `--chaos`. 4) pick a layout-appropriate `--ar`.
- **Confidence:** `[S]`.

---

### [LIGHT-01] Flat, moodless lighting
- **Symptom:** even, lifeless light; no depth.
- **Likely cause:** no lighting cue given.
- **Fix:** 1) specify **source + direction + quality** ("golden-hour side-light, warm rim from left"). 2) add time-of-day/weather. 3) consider lower `--stylize` so the named light survives.
- **Confidence:** `[S]`.

### [LIGHT-02] Oversaturated / "AI-glossy" / over-processed
- **Symptom:** plasticky, HDR-ish, too punchy.
- **Likely cause:** default beautifying aesthetic + high stylize.
- **Fix:** 1) add `--raw`. 2) drop `--stylize` to ~100–150. 3) name a realistic medium ("35mm film, natural color"). 4) reduce `--exp` if used.
- **Version notes:** it's `--raw` (not "--style raw") on current models.
- **Confidence:** `[S]`.

---

### [STYLE-01] Over-stylized vs too literal
- **Symptom:** too artsy and off-prompt, or flat and uninspired.
- **Likely cause:** `--stylize`/`--exp` mismatched to intent.
- **Fix:** photoreal → `--s 50–150 --raw`; illustration → `--s 400–700`. Never reuse V6 stylize numbers (V7/V8.1 read higher). Adjust `--exp` in small steps.
- **Confidence:** `[L]` exact bands (recalibration is single-source).

### [STYLE-02] Generic / stock-photo subject
- **Symptom:** bland, anonymous result.
- **Likely cause:** vague noun ("a man", "a city").
- **Fix:** add 3–5 concrete descriptors (age, wardrobe, expression, distinguishing feature, era). Replace evaluative words with sensory ones.
- **Confidence:** `[S]`.

### [STYLE-03] Muddy / indecisive aesthetic
- **Symptom:** looks like several styles averaged together.
- **Likely cause:** 5+ conflicting style modifiers.
- **Fix:** cap at **2–3 modifiers from different categories** (medium + lighting + era). Remove words before adding.
- **Confidence:** `[S]`.

---

### [COH-01] Warping / melted detail / extra limbs in background
- **Symptom:** nonsense geometry, duplicated limbs, dissolving detail.
- **Likely cause:** `--weird`/`--chaos` too high, or overloaded scene.
- **Fix:** 1) lower `--weird` and `--chaos`. 2) simplify the scene. 3) `--raw` for more literal structure. 4) Vary Region to repair a local area.
- **Confidence:** `[S]`.

### [COH-02] Garbled / misspelled text
- **Symptom:** letters wrong or gibberish.
- **Likely cause:** phrase too long, odd font, no quotes.
- **Fix:** 1) wrap text in **double quotes**, ≤3 words. 2) common font ("bold sans-serif"). 3) `--raw` or lower `--stylize`. 4) finish real typography in a design tool. (Chinese text: don't rely on MJ — add it in post.)
- **Version notes:** newer models render text better, but still limited.
- **Confidence:** `[C]` quotes mechanism; rest `[S]`.

---

### [REF-01] Style not transferring (`--sref` too weak)
- **Symptom:** the reference's look barely shows.
- **Likely cause:** `--sw` too low, or using an image ref (weaker than codes in V7).
- **Fix:** 1) raise `--sw` (250–500). 2) prefer a **numeric style code** over an image. 3) ensure `--sv 6` (or `--sv 4` for legacy codes).
- **Confidence:** `[S]`.

### [REF-02] Style too dominant / subject lost
- **Symptom:** everything looks like the reference; your subject is gone.
- **Likely cause:** `--sw` too high; too many stacked codes.
- **Fix:** 1) lower `--sw` toward 65–175. 2) reduce the number of sref codes. 3) strengthen the subject description.
- **Confidence:** `[S]`.

### [REF-03] Character drift across a series
- **Symptom:** the "same" character changes face/outfit between images.
- **Likely cause:** no subject lock; inconsistent descriptors; new style cues mid-series; chaos too high.
- **Fix:** 1) (V7) `--oref <url> --ow 200–400`. 2) keep **identical** wardrobe/hair wording every prompt. 3) reuse the same `--sref` + lock `--seed`. 4) `--chaos 0`.
- **Version notes:** `--oref` is V7-only; on V8.1/niji rely on descriptors + shared `--sref` + seed.
- **Confidence:** `[S]`.

### [REF-04] Omni-Reference character present but warped / over-baked
- **Symptom:** the referenced subject appears but looks distorted or pasted-on.
- **Likely cause:** `--ow` too high relative to `--stylize`.
- **Fix:** 1) drop `--ow` below ~400. 2) to re-style the character (e.g. photo→anime), lower `--ow` to 25–50. 3) raise `--stylize` if you need high `--ow`.
- **Version notes:** V7 only.
- **Confidence:** `[S]`.

---

### [VER-01] `--q` seems ignored
- **Symptom:** `--q 2`/`--q 4` has no effect.
- **Likely cause:** you're on **V8.1**, which has no `--q` knob.
- **Fix:** use `--hd` / `--sd` for resolution/detail on V8.1; `--q` only works on V6/V7.
- **Confidence:** `[C]`.

### [VER-02] `--oref` / `--ow` seems ignored
- **Symptom:** the omni reference does nothing.
- **Likely cause:** you're on **V8.1 or niji** — Omni Reference is **V7-only**.
- **Fix:** add `--v 7` to use `--oref`; or, staying on V8.1, approximate with repeated descriptors + shared `--sref` + locked `--seed`.
- **Confidence:** `[C]`.

### [VER-03] Using `--cref` / `--cw`
- **Symptom:** character reference flags do nothing on current models.
- **Likely cause:** `--cref`/`--cw` are **deprecated**; replaced by Omni Reference in V7.
- **Fix:** never emit `--cref`. Use `--oref`/`--ow` on V7.
- **Confidence:** `[C]`.

### [VER-04] An old V6 prompt looks flat in V7 / V8.1
- **Symptom:** a prompt that used to pop now looks dull.
- **Likely cause:** stylize was recalibrated higher on V7/V8.1.
- **Fix:** raise `--stylize` (e.g. old v6 `--s 100` ≈ v7 `--s 300–400`) and/or add modest `--exp 10–25`. Verify the exact mapping in-app.
- **Confidence:** `[L]` (recalibration map is single-source).
