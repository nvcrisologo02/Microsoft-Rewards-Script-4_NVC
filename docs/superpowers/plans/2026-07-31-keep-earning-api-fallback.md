# Keep-Earning API-children fallback — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** When a quest page (e.g. "Keep earning" / "Seguir ganando") renders 0 children but the API punchcard data carries `childPromotions`, solve those children through the existing activity dispatcher so quiz/urlreward cards (+5 quizzes, puzzles, cita del día) get claimed.

**Context (diagnosed live, account nvcrisologo02, run 2026-07-31 22:01):**
- `PUNCHCARD Found 1 incomplete quest(s) on /earn | api-matched=1` then `Quest snapshot | children=0` → `No actionable children rendered for "Keep earning"` → early return in `solvePunchCard` ([src/functions/Workers.ts](../../../src/functions/Workers.ts) ~L209).
- The cards ARE present in the /earn react snapshot (`offers=19 | reportable=4`), so `ensureOffer(offerId)` — which `UrlReward.doUrlReward` and `Quiz.doQuiz` already call internally — can resolve their live hashes.
- `solveActivities(activities: BasePromotion[])` (same class, private) already dispatches by `promotionType`: `urlreward`, `quiz` (config-gated), default-warn. `PunchCard.childPromotions` is `BasePromotion[]`.

## Global Constraints
- Style: 4-space indent, single quotes, logger shape `this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', '...')`.
- `npm run lint` (0 errors), `npm run build`, `npm test` (29 pass) before commit. Explicit `git add` paths. Commit body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

### Task 1: fallback in solvePunchCard

**Files:** Modify `src/functions/Workers.ts` only.

In `solvePunchCard`, replace the early-return block:

```typescript
        if (!questChildren.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `No actionable children rendered for "${title}"`)
            return
        }
```

with a fallback that goes through the API children when the page rendered nothing:

```typescript
        if (!questChildren.length) {
            const apiChildren = (apiCard?.childPromotions ?? []).filter(c => c.offerId && !c.complete)
            if (!apiChildren.length) {
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `No actionable children rendered for "${title}"`)
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `No children rendered for "${title}" - falling back to ${apiChildren.length} API child promotion(s) | ${apiChildren
                    .map(c => `${c.offerId}[type=${c.promotionType} points=${c.pointProgressMax} promo=${c.attributes?.promotional ?? '-'}]`)
                    .join(', ')}`
            )

            await this.solveActivities(apiChildren)
            return
        }
```

Notes for the implementer:
- `apiCard` param is `PunchCard | undefined`; `childPromotions` is `BasePromotion[]` (verify in `src/interface/DashboardData.ts` — mirror actual optionality with `?? []`).
- `solveActivities` is private on the same class — direct call is fine.
- Do NOT touch the rest of solvePunchCard (rendered-children path unchanged).
- No new unit test required (bot-coupled path); verification = lint/build/existing 29 tests + live VM run afterwards.

### Task 2 (controller): review, merge to main, deploy to VM, live-verify with a single-account run.
