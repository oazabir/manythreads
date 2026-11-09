# Screenshot review checklist

Version: 1 (copied from PLAN.md phase 13, "The fixed checklist", on 2026-11-09). A change to the PLAN text means a new version here; `tools/review/test/checklist.test.ts` compares the rows below with PLAN.md.

How to review: look at the contact sheet first, then each full-size picture of your batch. Report only what you can point to in the image. Use `tokens.txt` to judge colours, radii and fonts. Return only table rows in the `ISSUES.md` format below (one row per issue; a component seen on several screens is one row listing every screenshot), then one last line: `Reviewed N screenshots; M rows`.

**The fixed checklist.**

| Id | Category | Look for |
|---|---|---|
| C01 | Broken images | Missing image, broken glyph, empty avatar frame, wrong aspect ratio |
| C02 | Spacing | Uneven padding or margin between like elements; gaps off the 4 px scale |
| C03 | Consistency | The same component styled differently on different screens |
| C04 | Tokens and branding | Colours, fonts or radii outside the tokens; agent colour used for a human or the reverse |
| C05 | Overflow | Content spilling out of its container; horizontal page scroll |
| C06 | Alignment | Text, icons, controls off baseline or edge; mixed left and centre in one block |
| C07 | Mobile | At 390×844: cut off, overlapping, tap target under 44 px |
| C08 | Clipping | A `box-shadow` or focus ring clipped by `overflow: hidden`; a dropdown cut by its parent |
| C09 | Truncation | A label cut so meaning is lost, with no tooltip or full-text path |
| C10 | Contrast | Below WCAG AA (4.5:1 text, 3:1 large text and UI) |
| C11 | Focus | No visible focus state, or a ring hidden by another element |
| C12 | Empty states | Layout, tone or action differs from the pattern used elsewhere |

**Severity.** **High:** blocks or misleads use (unreadable text, hidden or overlapped control, unusable mobile, contrast far below AA). **Medium:** visibly wrong or inconsistent in a main flow, contrast just below AA, missing focus state. **Low:** cosmetic, rare screens, a few pixels off scale.

**`ISSUES.md` row format.** One table row per issue; the file starts with `Open: H n · M n · L n`.

| id | screenshot path | persona / journey / step | category | severity | description | suggested fix | status |
|---|---|---|---|---|---|---|---|
| `UI-0007` | `docs/journeys/nadia/11-N2-answer.png`, `…/mobile/11-N2-answer.png` | nadia / N2 / answer | C03 | medium | "Hand to a bot" chips use a 6 px radius; the same chips on the Approvals card use 12 px | Use the shared `Chip` with the `chip` radius token | open · fixed in `a1b2c3d` · verified |

Rules: `id` is `UI-NNNN`, never reused; `category` is a checklist id; an issue may list several screenshots; `status` moves open → fixed (with commit) → verified (after regeneration and re-review); closed rows move to a "Closed" section.
