# Image Grading Rubric (multimodal loop)

**Trigger:** the user pastes a Midjourney-generated image — with or without "why does this look off / how do I improve it?"

You can see the image. Score it on **7 independent dimensions**, call out the **single weakest** one, then route to `failure-modes.md` and propose **one** revised prompt that changes **one lever**. Changing one thing at a time turns the loop into a controlled experiment that actually converges.

## The 7 dimensions (score each 1–5)

| # | Dimension | What you're judging | Routes to |
|---|---|---|---|
| 1 | **Prompt adherence** | Are all named subjects/objects/attributes present and correct? | `ADH-*` |
| 2 | **Subject fidelity** | Anatomy, faces, hands, correct counts | `SUBJ-*` |
| 3 | **Composition & framing** | Matches requested shot/aspect; balanced; subject placement | `COMP-*` |
| 4 | **Lighting & color** | Light direction/quality and palette match intent | `LIGHT-*` |
| 5 | **Style & medium match** | Reads as the requested medium/aesthetic | `STYLE-*` (or `REF-*` if a `--sref`/`--oref` was used) |
| 6 | **Coherence & artifacts** | Warping, melted/duplicated detail, garbled text | `COH-*` |
| 7 | **Aesthetic quality** | Overall polish, independent of adherence | usually `STYLE-*` / `LIGHT-*` |

## Score anchors (keep grading reproducible)
- **1** — broken / absent (e.g. six-fingered hand; requested object missing).
- **2** — clearly wrong, distracting.
- **3** — acceptable, minor issues.
- **4** — good, small polish remains.
- **5** — excellent, nothing to fix on this axis.

## Output format
A compact scorecard, then the diagnosis and one next prompt:

```
| Dimension          | Score | Note                              |
|--------------------|:-----:|-----------------------------------|
| Prompt adherence   |  4    | all elements present              |
| Subject fidelity   |  2    | left hand has 6 fingers           |
| Composition        |  4    | framing matches 3:2 request       |
| Lighting & color   |  4    | golden-hour read is good          |
| Style & medium     |  3    | a bit glossier than "film" asked  |
| Coherence          |  3    | minor warping in background       |
| Aesthetic          |  4    | strong overall                    |

Weakest: Subject fidelity (2) → failure-modes SUBJ-01.
```

## Routing rule
1. Pick the **lowest-scoring** dimension (tie-break toward the one most central to the user's stated goal).
2. Open its `failure-modes.md` family, choose the matching entry.
3. Apply **one** fix from that entry's priority list to the current prompt.
4. Re-emit the full revised prompt (English, **description only — no flags**, tuned for the target version) + one line on what changed and why. If the chosen fix is a **parameter** (e.g. lower `--stylize`, add `--no`), state it as advice **outside** the prompt block — the user applies it (see the SKILL output contract).
5. If the user re-pastes, grade again — the weakest dimension should move.

## Cross-cutting routes
- If a **`--sref`/`--oref`/`--iw`** was in play and style/subject is off → use `REF-*` regardless of which dimension scored low.
- If a flag seems **ignored** (e.g. `--q` on V8.1, `--oref` on niji) → `VER-*` first; it's a version mismatch, not a prompt problem.
