# Quiz Solver + Cross-Account Search Dedup + Spanish Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Solve `quiz`-type Rewards activities (hybrid API + browser fallback, config-gated), prevent search queries repeating across accounts on the same day, and make search topics Spanish/Spain-current-affairs.

**Architecture:** Three independent slices. (1) A `Quiz` solver following the existing v4 solver pattern (`Workers` subclass in `src/functions/activities/`), tried in three phases: dashboard `reportActivity` server action → legacy `bingqa/ReportActivity` loop → browser click-through. (2) A file-backed `SearchQueryLedger` (one NDJSON file per day under `<sessionPath>/search-history/`) merged into `SearchQueryQueue`'s `seenQueries`. (3) Spanish RSS feeds in `rssFeeds.ts` plus config/env reorientation.

**Tech Stack:** TypeScript (strict), Node 24, patchright (Playwright fork), Zod validation, node:test + ts-node for unit tests.

**Spec:** `docs/superpowers/specs/2026-07-31-quiz-solver-and-spanish-search-dedup-design.md`

## Global Constraints

- Follow existing code style: 4-space indent, no semicolons where absent, single quotes, logger calls shaped `this.bot.logger.info(this.bot.isMobile, 'CONTEXT', 'message')`.
- Solvers never throw out of their public method — catch and `logger.error` (match `UrlReward`).
- `npm run lint` and `npm run build` must pass after every task.
- Commit after every task. NEVER `git add .env_` (user's untracked local secrets) — name files explicitly in `git add`.
- Do not modify VM deployment files (`compose.yaml`, remote `.env`).

---

### Task 1: Config plumbing (`activities.quiz`, `searchSettings.crossAccountQueryDedup`)

**Files:**
- Modify: `src/interface/Config.ts` (interfaces `ConfigActivities` ~L73, `ConfigSearchSettings` ~L31)
- Modify: `src/util/Validator.ts` (`activities` ~L106, `searchSettings` ~L114; also the fallback default config object ~L186)
- Modify: `config.json` (root)
- Test: `src/util/Validator.test.ts` (new)

**Interfaces:**
- Consumes: existing `validateConfig(unverifiedConfig)` export from `src/util/Validator.ts`.
- Produces: `bot.config.activities.quiz: boolean` and `bot.config.searchSettings.crossAccountQueryDedup: boolean` — used by Tasks 3 and 6.

- [ ] **Step 1: Write the failing test**

Create `src/util/Validator.test.ts`. It loads the real root `config.json`, strips the new fields, and asserts the validator defaults them to `true`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import { validateConfig } from './Validator'

function loadRawConfig(): Record<string, unknown> {
    const file = path.join(__dirname, '../../config.json')
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

test('activities.quiz defaults to true when absent', () => {
    const raw = loadRawConfig()
    delete (raw.activities as Record<string, unknown>).quiz
    const config = validateConfig(raw)
    assert.strictEqual(config.activities.quiz, true)
})

test('activities.quiz=false is respected', () => {
    const raw = loadRawConfig()
    ;(raw.activities as Record<string, unknown>).quiz = false
    const config = validateConfig(raw)
    assert.strictEqual(config.activities.quiz, false)
})

test('searchSettings.crossAccountQueryDedup defaults to true when absent', () => {
    const raw = loadRawConfig()
    delete (raw.searchSettings as Record<string, unknown>).crossAccountQueryDedup
    const config = validateConfig(raw)
    assert.strictEqual(config.searchSettings.crossAccountQueryDedup, true)
})
```

Note: check the actual export name in `src/util/Validator.ts` first (`validateConfig` is called from `src/util/Load.ts:177`); adjust the import if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: the three new tests FAIL (TypeScript error: `quiz` not on type, or assertion failure `undefined !== true`). Pre-existing tests still pass.

- [ ] **Step 3: Implement config fields**

`src/interface/Config.ts` — extend both interfaces:

```typescript
export interface ConfigActivities {
    urlReward: boolean
    searchOnBing: boolean
    quiz: boolean
}
```

In `ConfigSearchSettings` add one line after `queryEngines: QueryEngineEntry[]`:

```typescript
    crossAccountQueryDedup: boolean
```

`src/util/Validator.ts` — update the `activities` schema (~L106):

```typescript
    activities: z
        .object({
            urlReward: z.boolean().default(true),
            searchOnBing: z.boolean().default(true),
            quiz: z.boolean().default(true)
        })
        .default({ urlReward: true, searchOnBing: true, quiz: true }),
```

In the `searchSettings` z.object (~L114) add after `queryEngines`:

```typescript
        crossAccountQueryDedup: z.boolean().default(true),
```

Also update the hardcoded fallback config object (~L186) if it enumerates `activities`/`searchSettings` fields — add `quiz: true` and `crossAccountQueryDedup: true` there for consistency.

`config.json` — in `"activities"` add `"quiz": true`; in `"searchSettings"` add `"crossAccountQueryDedup": true` (after `"queryEngines"`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Lint, build, commit**

```bash
npm run lint && npm run build
git add src/interface/Config.ts src/util/Validator.ts src/util/Validator.test.ts config.json
git commit -m "feat(config): add activities.quiz and searchSettings.crossAccountQueryDedup flags"
```

---

### Task 2: SearchQueryLedger (file-backed daily dedup store)

**Files:**
- Create: `src/functions/SearchQueryLedger.ts`
- Test: `src/functions/SearchQueryLedger.test.ts`
- Modify: `package.json` (test script glob)

**Interfaces:**
- Consumes: `normalizeQueryKey(query: string): string` from `src/functions/QueryEngine.ts`.
- Produces: `class SearchQueryLedger { constructor(baseDir: string); load(): Set<string>; record(query: string): void; cleanup(maxAgeDays?: number): void }` — used by Task 3.

- [ ] **Step 1: Extend the test glob**

In `package.json`, change:

```json
"test": "node --require ts-node/register --test \"src/util/*.test.ts\" \"src/functions/*.test.ts\""
```

- [ ] **Step 2: Write the failing tests**

Create `src/functions/SearchQueryLedger.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SearchQueryLedger } from './SearchQueryLedger'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'))
}

test('load() returns empty set when directory does not exist', () => {
    const ledger = new SearchQueryLedger(path.join(tmpDir(), 'missing'))
    assert.strictEqual(ledger.load().size, 0)
})

test('record() then load() round-trips normalized queries', () => {
    const ledger = new SearchQueryLedger(tmpDir())
    ledger.record('  Real  Madrid ')
    ledger.record('elecciones España')
    const seen = ledger.load()
    assert.strictEqual(seen.size, 2)
    assert.ok(seen.has('real madrid'))
    assert.ok(seen.has('elecciones españa'))
})

test('record() ignores empty queries', () => {
    const ledger = new SearchQueryLedger(tmpDir())
    ledger.record('   ')
    assert.strictEqual(ledger.load().size, 0)
})

test('two ledger instances share the same file (cross-account view)', () => {
    const dir = tmpDir()
    const a = new SearchQueryLedger(dir)
    const b = new SearchQueryLedger(dir)
    a.record('quijote')
    assert.ok(b.load().has('quijote'))
})

test('cleanup() removes files older than maxAgeDays and keeps today', () => {
    const dir = tmpDir()
    const ledger = new SearchQueryLedger(dir)
    ledger.record('hoy')
    fs.writeFileSync(path.join(dir, '2020-01-01.ndjson'), 'viejo\n', 'utf-8')
    ledger.cleanup(7)
    assert.ok(!fs.existsSync(path.join(dir, '2020-01-01.ndjson')))
    assert.ok(ledger.load().has('hoy'))
})

test('cleanup() on missing directory does not throw', () => {
    const ledger = new SearchQueryLedger(path.join(tmpDir(), 'missing'))
    assert.doesNotThrow(() => ledger.cleanup())
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: new tests FAIL (`Cannot find module './SearchQueryLedger'`).

- [ ] **Step 4: Implement SearchQueryLedger**

Create `src/functions/SearchQueryLedger.ts`:

```typescript
import fs from 'fs'
import path from 'path'

import { normalizeQueryKey } from './QueryEngine'

const FILE_EXT = '.ndjson'
const DAY_MS = 24 * 60 * 60 * 1000

function dateKey(date = new Date()): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

/**
 * Shared, file-backed record of search queries used today across all accounts.
 * One NDJSON file per day (one normalized query key per line); appends are
 * atomic enough for the parallel cluster processes. All fs errors degrade
 * silently to per-session dedup behavior.
 */
export class SearchQueryLedger {
    constructor(private readonly baseDir: string) {}

    private todayFile(): string {
        return path.join(this.baseDir, `${dateKey()}${FILE_EXT}`)
    }

    load(): Set<string> {
        const seen = new Set<string>()
        try {
            const raw = fs.readFileSync(this.todayFile(), 'utf-8')
            for (const line of raw.split('\n')) {
                const key = line.trim()
                if (key) seen.add(key)
            }
        } catch {
            // Missing file or unreadable: start empty
        }
        return seen
    }

    record(query: string): void {
        const key = normalizeQueryKey(query)
        if (!key) return
        try {
            fs.mkdirSync(this.baseDir, { recursive: true })
            fs.appendFileSync(this.todayFile(), `${key}\n`, 'utf-8')
        } catch {
            // Unwritable: dedup degrades to per-session
        }
    }

    cleanup(maxAgeDays = 7): void {
        try {
            const cutoff = Date.now() - maxAgeDays * DAY_MS
            for (const file of fs.readdirSync(this.baseDir)) {
                if (!file.endsWith(FILE_EXT)) continue
                const stamp = Date.parse(file.slice(0, -FILE_EXT.length))
                if (!Number.isNaN(stamp) && stamp < cutoff) {
                    fs.rmSync(path.join(this.baseDir, file), { force: true })
                }
            }
        } catch {
            // Directory missing: nothing to clean
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 6: Lint, build, commit**

```bash
npm run lint && npm run build
git add src/functions/SearchQueryLedger.ts src/functions/SearchQueryLedger.test.ts package.json
git commit -m "feat(search): add file-backed daily SearchQueryLedger for cross-account dedup"
```

---

### Task 3: Wire the ledger into SearchQueryQueue

**Files:**
- Modify: `src/functions/SearchQueryQueue.ts`

**Interfaces:**
- Consumes: `SearchQueryLedger` from Task 2; `bot.config.searchSettings.crossAccountQueryDedup` from Task 1; `bot.config.sessionPath: string`.
- Produces: no new public API — `SearchQueryQueue.prepare()/next()` behavior now consults/feeds the shared ledger.

- [ ] **Step 1: Implement the integration**

Modify `src/functions/SearchQueryQueue.ts`. Add imports at top:

```typescript
import path from 'path'
import { SearchQueryLedger } from './SearchQueryLedger'
```

Add a private field and initialize it in the constructor (session path resolution matches `src/util/SessionStore.ts:31`):

```typescript
    private readonly ledger: SearchQueryLedger | null

    constructor(
        private readonly bot: MicrosoftRewardsBot,
        private readonly queryCore = new QueryCore(bot)
    ) {
        this.ledger = bot.config.searchSettings.crossAccountQueryDedup
            ? new SearchQueryLedger(path.join(path.resolve(process.cwd(), bot.config.sessionPath), 'search-history'))
            : null
    }
```

Add a private sync method:

```typescript
    private syncLedger(): void {
        if (!this.ledger) return
        const before = this.seenQueries.size
        for (const key of this.ledger.load()) this.seenQueries.add(key)
        const added = this.seenQueries.size - before
        if (added > 0) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'QUERY-QUEUE',
                `Ledger sync | queriesUsedByOtherAccounts=${added} | totalSeen=${this.seenQueries.size}`
            )
        }
    }
```

In `prepare()`, before the existing `if (!this.topics.length)` line:

```typescript
        if (this.ledger) {
            this.ledger.cleanup()
            this.syncLedger()
        }
```

In `next()`, inside the `while (!this.activeCluster.length)` loop, right after `const mainTopic = await this.nextMainTopic()` succeeds (after the `if (!mainTopic)` return-null block), re-sync so concurrently running accounts are seen:

```typescript
            this.syncLedger()
```

Still in `next()`, after a query is successfully dequeued (after the `if (!query) return null` guard, before the final `return query`):

```typescript
        this.ledger?.record(query)
```

- [ ] **Step 2: Verify build and tests**

Run: `npm run lint && npm run build && npm test`
Expected: all pass. (No new unit test — `SearchQueryQueue` requires a full bot; ledger logic is covered by Task 2 tests. End-to-end check happens in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add src/functions/SearchQueryQueue.ts
git commit -m "feat(search): dedupe queries across accounts via shared daily ledger"
```

---

### Task 4: Extract shared `reportOfferActivity` helper (refactor, no behavior change)

**Files:**
- Create: `src/functions/activities/api/ReportPromotion.ts`
- Modify: `src/functions/activities/api/UrlReward.ts`

**Interfaces:**
- Consumes: `bot.nextActions.reportActivity`, `bot.browser.func.reportServerAction(...)`, `bot.browser.func.getCurrentPoints()`, `bot.browser.react.routerStateTree('dashboard')`, `ParsedOffer` from `src/browser/ReactFunc.ts`.
- Produces: `reportOfferActivity(bot, live, promotion): Promise<ReportOutcome>` with `ReportOutcome = { status: number; acknowledged: boolean; gained: number; newBalance: number }` — used by Task 5.

- [ ] **Step 1: Create the helper**

Create `src/functions/activities/api/ReportPromotion.ts`:

```typescript
import { URLs } from '../../../constants/urls'
import type { ParsedOffer } from '../../../browser/ReactFunc'
import type { BasePromotion } from '../../../interface/DashboardData'
import type { MicrosoftRewardsBot } from '../../../index'

export interface ReportOutcome {
    status: number
    acknowledged: boolean
    gained: number
    newBalance: number
}

/**
 * Reports a dashboard promotion via the "reportActivity" server action and
 * verifies the points delta. Throws if the action id was not discovered;
 * callers handle skip logging and retries.
 */
export async function reportOfferActivity(
    bot: MicrosoftRewardsBot,
    live: ParsedOffer,
    promotion: BasePromotion
): Promise<ReportOutcome> {
    const actionId = bot.nextActions.reportActivity
    if (!actionId) {
        throw new Error('"reportActivity" not discovered in bundle')
    }

    const oldBalance = bot.userData.currentPoints

    const dashboardActivityType = Number(promotion.activityType)
    const activityType =
        live.activityType ??
        (Number.isInteger(dashboardActivityType) && dashboardActivityType > 0 ? dashboardActivityType : 11)

    const { status, acknowledged } = await bot.browser.func.reportServerAction(
        actionId,
        [
            live.hash,
            activityType,
            {
                offerid: promotion.offerId,
                isPromotional: live.isPromotional ? true : '$undefined',
                timezoneOffset: bot.userData.timezoneOffset
            }
        ],
        {
            url: URLs.rewards.dashboard,
            referer: URLs.rewards.dashboard,
            routerStateTree: bot.browser.react.routerStateTree('dashboard')
        }
    )

    const newBalance = await bot.browser.func.getCurrentPoints()
    const gained = newBalance - oldBalance
    if (gained > 0) {
        bot.userData.currentPoints = newBalance
        bot.userData.gainedPoints = (bot.userData.gainedPoints ?? 0) + gained
    }

    return { status, acknowledged, gained, newBalance }
}
```

Note: verify `promotion.activityType` exists on `BasePromotion` (UrlReward already uses it at `src/functions/activities/api/UrlReward.ts:53`; if the field is typed differently there, mirror exactly what UrlReward does today).

- [ ] **Step 2: Refactor UrlReward to use it**

In `src/functions/activities/api/UrlReward.ts`:
- Add import: `import { reportOfferActivity } from './ReportPromotion'`.
- Keep everything up to and including the `skipNonPointTasks` check unchanged (including the early `actionId` warn-and-return at L13-21 — it prevents pointless `ensureOffer` work).
- Replace the body of the `try` block from the `reportServerAction` call through the `gained > 0` bookkeeping (L65-94) with:

```typescript
            const { status, acknowledged, gained: gainedPoints, newBalance } = await reportOfferActivity(this.bot, live, promotion)

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Response | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | pointsGained=${gainedPoints} | currentBalance=${newBalance}`
            )
```

- Delete the now-unused local `dashboardActivityType` / `activityType` computation (L53-56) and the `if (gainedPoints > 0) { userData bookkeeping }` block (the helper does it) — but KEEP the logging branches (`if (gainedPoints > 0) { info green ... }` etc.); they only log now. The `oldBalance` variable is still needed for the start log; keep it.
- Session-repair logic (L117-128) stays exactly as is.

- [ ] **Step 3: Verify no behavior change**

Run: `npm run lint && npm run build && npm test`
Expected: all pass. Diff review: `git diff` — confirm UrlReward's log lines and control flow are unchanged (only where the report happens moved).

- [ ] **Step 4: Commit**

```bash
git add src/functions/activities/api/ReportPromotion.ts src/functions/activities/api/UrlReward.ts
git commit -m "refactor(activities): extract reportOfferActivity helper from UrlReward"
```

---

### Task 5: Quiz solver (3-phase hybrid) + Activities wiring

**Files:**
- Create: `src/functions/activities/Quiz.ts`
- Modify: `src/constants/urls.ts` (bing section ~L52)
- Modify: `src/functions/Activities.ts`

**Interfaces:**
- Consumes: `reportOfferActivity` (Task 4); `bot.browser.func.ensureOffer(offerId)`; `bot.browser.func.buildCookieHeader(cookies, allowedDomains)` (`src/browser/BrowserFunc.ts:865`); `bot.cookies.{mobile,desktop}`; `bot.http.request(request)` (`src/util/Http.ts` — check the exact signature: QueryEngine calls it as `this.bot.http.request<T>(request, proxyFlag)`; for the quiz call pass the request only, or `false` for the proxy flag if it is required — the quiz must use the account session, not the query-engine proxy setting); `bot.utils.wait/randomDelay`.
- Produces: `Activities.doQuiz(promotion: BasePromotion, page: Page): Promise<void>` — used by Task 6.

- [ ] **Step 1: Add the legacy quiz endpoint to urls.ts**

In `src/constants/urls.ts`, `bing` section:

```typescript
    bing: {
        origin: BING,
        quizReport: `${BING}/bingqa/ReportActivity?ajaxreq=1`,
        search: (query: string, cvid: string) =>
            `${BING}/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`
    },
```

- [ ] **Step 2: Create the Quiz solver**

Create `src/functions/activities/Quiz.ts`:

```typescript
import type { Page } from 'patchright'

import { URLs } from '../../constants/urls'
import { Workers } from '../Workers'
import { reportOfferActivity } from './api/ReportPromotion'
import type { HttpRequestConfig } from '../../util/Http'
import type { BasePromotion } from '../../interface/DashboardData'

const MAX_QUIZ_REPORTS = 20
const MAX_ANSWER_CLICKS = 10

const SKIP_PUZZLE_SELECTORS = [
    'a:has-text("Omitir")',
    'button:has-text("Omitir")',
    'a:has-text("Skip")',
    'button:has-text("Skip")'
]
const ANSWER_OPTION_SELECTOR = '[id^="rqAnswerOption"], #btoption0, #btoption1, .btOptionCard'

export class Quiz extends Workers {
    public async doQuiz(promotion: BasePromotion, page: Page): Promise<void> {
        const offerId = promotion.offerId
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'QUIZ',
            `Starting quiz | offerId=${offerId} | title="${promotion.title}" | pointProgressMax=${promotion.pointProgressMax} | currentBalance=${startBalance}`
        )

        try {
            // Phase 1: dashboard "reportActivity" server action (same flow as UrlReward)
            const live = await this.bot.browser.func.ensureOffer(offerId)
            if (!live) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Skipping ${offerId}: not present in page snapshot, even after refetching /earn and /dashboard`
                )
                return
            }
            if (!live.reportable) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Skipping ${offerId}: not reportable (completed/locked/no-hash/future-dated)`
                )
                return
            }
            if (this.bot.config.skipNonPointTasks && live.points <= 0 && promotion.pointProgressMax <= 0) {
                this.bot.logger.info(this.bot.isMobile, 'QUIZ', `Skipping ${offerId}: awards no points`)
                return
            }

            const outcome = await reportOfferActivity(this.bot, live, promotion)
            if (outcome.gained > 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUIZ',
                    `Completed quiz via server action | offerId=${offerId} | pointsGained=${outcome.gained} | currentBalance=${outcome.newBalance}`,
                    'green'
                )
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'QUIZ',
                `Server action credited nothing | offerId=${offerId} | status=${outcome.status} | acknowledged=${outcome.acknowledged} - trying legacy quiz API`
            )

            // Phase 2: legacy bingqa/ReportActivity loop (one call per question)
            const gainedApi = await this.legacyQuizLoop(offerId)
            if (gainedApi > 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUIZ',
                    `Completed quiz via legacy API | offerId=${offerId} | pointsGained=${gainedApi} | currentBalance=${this.bot.userData.currentPoints}`,
                    'green'
                )
                return
            }

            // Phase 3: browser click-through fallback
            const gainedBrowser = await this.browserFallback(promotion, page)
            if (gainedBrowser > 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUIZ',
                    `Completed quiz via browser fallback | offerId=${offerId} | pointsGained=${gainedBrowser} | currentBalance=${this.bot.userData.currentPoints}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Quiz not credited by any phase | offerId=${offerId} | title="${promotion.title}" - leaving for manual completion`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'QUIZ',
                `Error in doQuiz | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async legacyQuizLoop(offerId: string): Promise<number> {
        const cookieHeader = this.bot.browser.func.buildCookieHeader(
            this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop,
            ['bing.com', 'live.com', 'microsoftonline.com']
        )
        const fingerprintHeaders = { ...this.bot.fingerprint.headers }
        delete fingerprintHeaders['Cookie']
        delete fingerprintHeaders['cookie']

        let oldBalance = this.bot.userData.currentPoints
        let totalGained = 0

        for (let attempt = 1; attempt <= MAX_QUIZ_REPORTS; attempt++) {
            try {
                const request: HttpRequestConfig = {
                    url: URLs.bing.quizReport,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        cookie: cookieHeader,
                        ...fingerprintHeaders
                    },
                    data: JSON.stringify({
                        UserId: null,
                        timeZone: this.bot.userData.timezoneOffset,
                        OfferId: offerId,
                        ActivityCount: 1,
                        QuestionIndex: '-1'
                    })
                }

                await this.bot.http.request(request)

                const newBalance = await this.bot.browser.func.getCurrentPoints()
                const gained = newBalance - oldBalance
                if (gained <= 0) break

                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
                totalGained += gained
                oldBalance = newBalance

                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUIZ',
                    `Legacy ReportActivity ${attempt} | offerId=${offerId} | pointsGained=${gained} | currentBalance=${newBalance}`,
                    'green'
                )

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))
            } catch (error) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'QUIZ',
                    `Legacy ReportActivity failed | attempt=${attempt} | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`
                )
                break
            }
        }

        return totalGained
    }

    private async browserFallback(promotion: BasePromotion, page: Page): Promise<number> {
        const destination = promotion.destinationUrl
        if (!destination) return 0

        const oldBalance = this.bot.userData.currentPoints

        try {
            this.bot.logger.debug(this.bot.isMobile, 'QUIZ', `Browser fallback | navigating to ${destination}`)
            await page.goto(destination, { waitUntil: 'domcontentloaded' })
            await this.bot.utils.wait(3000)

            // Puzzle: "Omitir puzzle" / "Skip puzzle" link
            for (const selector of SKIP_PUZZLE_SELECTORS) {
                const link = page.locator(selector).first()
                if (await link.isVisible().catch(() => false)) {
                    await link.click().catch(() => {})
                    this.bot.logger.debug(this.bot.isMobile, 'QUIZ', `Clicked skip-puzzle element "${selector}"`)
                    await this.bot.utils.wait(2000)
                    break
                }
            }

            // Legacy quiz overlay: start button then answer options
            const start = page.locator('#rqStartQuiz').first()
            if (await start.isVisible().catch(() => false)) {
                await start.click().catch(() => {})
                await this.bot.utils.wait(2000)
            }

            for (let i = 0; i < MAX_ANSWER_CLICKS; i++) {
                const option = page.locator(ANSWER_OPTION_SELECTOR).first()
                if (!(await option.isVisible().catch(() => false))) break
                await option.click().catch(() => {})
                await this.bot.utils.wait(this.bot.utils.randomDelay(2000, 4000))
            }
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'QUIZ',
                `Browser fallback error | offerId=${promotion.offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
        } finally {
            await page.goto(URLs.bing.origin).catch(() => {})
        }

        const newBalance = await this.bot.browser.func.getCurrentPoints()
        const gained = newBalance - oldBalance
        if (gained > 0) {
            this.bot.userData.currentPoints = newBalance
            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
        }
        return gained
    }
}
```

Adjustment note: if `bot.http.request` requires a second argument (check `src/util/Http.ts`), pass `false` (do NOT route the quiz call through the query-engine proxy setting). If `promotion.destinationUrl` is not on `BasePromotion`'s type, use `live.destination` from the Phase-1 `ensureOffer` result instead (pass it into `browserFallback`).

- [ ] **Step 3: Wire into Activities**

In `src/functions/Activities.ts`:
- Import: `import { Quiz } from './activities/Quiz'` (place beside the Browser imports).
- Add after `doUrlReward` (~L63):

```typescript
    doQuiz = async (promotion: BasePromotion, page: Page): Promise<void> => {
        const quiz = new Quiz(this.bot)
        await quiz.doQuiz(promotion, page)
    }
```

- [ ] **Step 4: Verify build**

Run: `npm run lint && npm run build && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/functions/activities/Quiz.ts src/functions/Activities.ts src/constants/urls.ts
git commit -m "feat(activities): add 3-phase hybrid quiz solver (server action, legacy API, browser)"
```

---

### Task 6: Dispatch `quiz` activities in Workers

**Files:**
- Modify: `src/functions/Workers.ts` (`solveActivities` switch, ~L346)

**Interfaces:**
- Consumes: `Activities.doQuiz(promotion, page)` (Task 5); `bot.config.activities.quiz` (Task 1).
- Produces: quiz-type Daily Set / More Promotions items are now solved instead of skipped.

- [ ] **Step 1: Add the case**

In `src/functions/Workers.ts` `solveActivities`, insert a new case between the `'urlreward'` case's closing brace and `default:`:

```typescript
                    case 'quiz': {
                        const basePromotion = activity as BasePromotion

                        if (!this.bot.config.activities.quiz) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Skipping "Quiz" (disabled in config) | offerId=${offerId}`
                            )
                            continue
                        }

                        this.bot.logger.info(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Found activity type "Quiz" | title="${activity.title}" | offerId=${offerId}`
                        )

                        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                        await this.bot.activities.doQuiz(basePromotion, page)
                        break
                    }
```

(The `page` retrieval mirrors the existing `'urlreward'` case at ~L377.)

- [ ] **Step 2: Verify build**

Run: `npm run lint && npm run build && npm test`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/functions/Workers.ts
git commit -m "feat(workers): solve quiz-type activities (config-gated) instead of skipping"
```

---

### Task 7: Spanish sources — RSS feeds, queryEngines order, account locale

**Files:**
- Modify: `src/constants/rssFeeds.ts`
- Modify: `config.json` (`searchSettings.queryEngines`)
- Modify: `.env_` (local account env — NEVER committed)

**Interfaces:**
- Consumes: `RSS_FEEDS` catalog structure (`Record<string, Record<string, string>>`).
- Produces: Spanish-first topic pool for all accounts.

- [ ] **Step 1: Add Spanish feeds**

In `src/constants/rssFeeds.ts`, extend `googleTrends` and `googleNews`, and append new sites before the closing brace:

```typescript
    // Trending search terms
    googleTrends: {
        gb: 'https://trends.google.com/trending/rss?geo=GB',
        us: 'https://trends.google.com/trending/rss?geo=US',
        es: 'https://trends.google.com/trending/rss?geo=ES'
    },

    // Aggregated headlines
    googleNews: {
        gb: 'https://news.google.com/rss?hl=en-GB&gl=GB&ceid=GB:en',
        us: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
        es: 'https://news.google.com/rss?hl=es&gl=ES&ceid=ES:es',
        world: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en',
        technology: 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en',
        business: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en'
    },
```

New sites (append after `reddit`):

```typescript
    // El País
    elPais: {
        portada: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada'
    },

    // El Mundo
    elMundo: {
        portada: 'https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml'
    },

    // RTVE
    rtve: {
        noticias: 'https://api2.rtve.es/rss/temas_noticias.xml'
    },

    // 20minutos
    veinteMinutos: {
        portada: 'https://www.20minutos.es/rss/'
    },

    // Marca (deportes)
    marca: {
        portada: 'https://e00-marca.uecdn.es/rss/portada.xml'
    }
```

- [ ] **Step 2: Reorder config.json queryEngines**

Replace the `"queryEngines"` array in `config.json` with:

```json
    "queryEngines": [
      "google",
      "rss.googleTrends.es",
      "rss.googleNews.es",
      "rss.elPais",
      "rss.rtve",
      "rss.elMundo",
      "rss.veinteMinutos",
      "rss.marca",
      "wikipedia",
      "local"
    ],
```

(`google` uses the account's geoLocale → ES trends; `wikipedia` uses langCode → es.wikipedia. English feeds stay in the catalog but out of the active list.)

- [ ] **Step 3: Set Spanish locale on accounts in .env_**

Read `.env_` at the repo root. For every account index `N` that has `ACCOUNT_N_EMAIL`, ensure these two lines exist (add or update in place, next to that account's other vars):

```
ACCOUNT_N_LANG_CODE=es
ACCOUNT_N_GEO_LOCALE=ES
```

Do NOT stage or commit `.env_`.

- [ ] **Step 4: Smoke-test the feeds**

Run this quick Node check that each new feed URL returns titles (no bot needed):

```bash
node -e "
const { XMLParser } = require('fast-xml-parser');
const urls = [
  'https://trends.google.com/trending/rss?geo=ES',
  'https://news.google.com/rss?hl=es&gl=ES&ceid=ES:es',
  'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada',
  'https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml',
  'https://api2.rtve.es/rss/temas_noticias.xml',
  'https://www.20minutos.es/rss/',
  'https://e00-marca.uecdn.es/rss/portada.xml'
];
(async () => {
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const xml = await res.text();
      const doc = new XMLParser({ ignoreAttributes: true }).parse(xml);
      const items = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
      const count = Array.isArray(items) ? items.length : items ? 1 : 0;
      console.log(res.status, count + ' items', url);
    } catch (e) { console.log('FAIL', url, e.message); }
  }
})();
"
```

Expected: every line shows `200` and `> 0 items`. If any feed fails or returns 0 items, find that outlet's current public RSS URL and substitute it in `rssFeeds.ts` (keep the same site key), then re-run.

- [ ] **Step 5: Lint, build, commit**

```bash
npm run lint && npm run build && npm test
git add src/constants/rssFeeds.ts config.json
git commit -m "feat(search): Spanish current-affairs sources (ES trends/news feeds, Spanish-first engine order)"
```

---

### Task 8: Final verification

**Files:** none created — verification only.

- [ ] **Step 1: Full check suite**

```bash
npm run lint && npm run build && npm test
```

Expected: all pass with zero warnings-as-errors.

- [ ] **Step 2: Update the knowledge graph**

```bash
graphify update .
```

(If `graphify` is not on PATH, run via the saved interpreter: `"$(cat graphify-out/.graphify_python)" -m graphify update .`)

- [ ] **Step 3: Report manual-verification checklist to the user**

The implementer cannot run real accounts. Report these as the user's remaining verification steps:
1. `npm start` with one account → logs show `Found activity type "Quiz"` and one of the three completion phases crediting points.
2. Queries in `SEARCH-BING` logs are Spanish/current (El País/RTVE/Trends ES titles).
3. After a second account runs, `sessions/search-history/<today>.ndjson` exists and the second account's logs show `skippedSeen` / `queriesUsedByOtherAccounts` > 0.
4. On the VM: update `.env` there with `ACCOUNT_N_LANG_CODE=es` / `ACCOUNT_N_GEO_LOCALE=ES` on next deploy (deploy flow preserves the VM `.env`).
