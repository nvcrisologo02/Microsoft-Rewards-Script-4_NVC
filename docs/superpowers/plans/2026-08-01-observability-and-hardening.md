# Observability & Hardening Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Close the gaps found while debugging the "Keep earning" cards: a stale-locale fingerprint risk, no visibility into which mechanism earns what, no alert when a mechanism silently breaks, no signal when a new claimable activity type appears, plus assorted config/efficiency/test debt.

**Architecture:** Eight independent slices over the existing bot. Points attribution introduces one small helper on the bot (`creditPoints`) that existing credit sites call instead of mutating `userData.gainedPoints` directly; everything else is local to one or two files.

**Tech Stack:** TypeScript (strict), Node 24, patchright, Zod, node:test + ts-node, bash (Docker entrypoint).

## Global Constraints

- Style: 4-space indent, single quotes, logger shape `this.bot.logger.info(this.bot.isMobile, 'TAG', 'message')`.
- Never throw out of a solver/worker: catch and log.
- `npm run lint` (0 errors), `npm run build`, `npm test` must pass before each commit.
- Explicit paths in `git add`; NEVER stage `config.json`, `.env`, or `.env_`.
- Config changes go to `config.example.json` (tracked) AND the local `config.json` (never committed), plus a `_cfg` line and doc-block entry in `scripts/docker/entrypoint.sh` and a README table row.
- Commit message bodies end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Regenerate fingerprints whose locale no longer matches the account

**Problem (verified live):** every stored fingerprint on the deployment still carries `navigator.languages = en-US` and `Accept-Language: en-US` while the browser context is now created with `es-ES`. `saveFingerprint` defaults to `true`, so the mismatch is permanent, it contradicts what a real browser presents, and a later locale change never reaches the fingerprint.

**Files:**
- Modify: `src/browser/Browser.ts`
- Test: `src/browser/Browser.test.ts` (create)

**Interfaces:**
- Consumes: `resolveAccountLocale(account)` (already private on `Browser`), `session.fingerprint` from `loadSession`.
- Produces: exported pure helper `fingerprintMatchesLocale(fingerprint, locale)` used by the test.

- [ ] **Step 1: Write the failing test**

Create `src/browser/Browser.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprintMatchesLocale } from './Browser'

const fpWith = (languages: string[], header: string) =>
    ({
        fingerprint: { navigator: { language: languages[0], languages } },
        headers: { 'accept-language': header }
    }) as never

test('matches when no locale is requested', () => {
    assert.equal(fingerprintMatchesLocale(fpWith(['en-US'], 'en-US'), undefined), true)
})

test('matches when the fingerprint language shares the requested language', () => {
    assert.equal(fingerprintMatchesLocale(fpWith(['es-ES'], 'es-ES,es;q=0.9'), 'es-ES'), true)
    assert.equal(fingerprintMatchesLocale(fpWith(['es-419'], 'es-419'), 'es'), true)
})

test('does not match a different language', () => {
    assert.equal(fingerprintMatchesLocale(fpWith(['en-US'], 'en-US'), 'es-ES'), false)
})

test('does not match when the accept-language header disagrees', () => {
    assert.equal(fingerprintMatchesLocale(fpWith(['es-ES'], 'en-US,en;q=0.9'), 'es-ES'), false)
})

test('treats a missing fingerprint as a mismatch', () => {
    assert.equal(fingerprintMatchesLocale(null as never, 'es-ES'), false)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `fingerprintMatchesLocale` is not exported.

- [ ] **Step 3: Implement**

In `src/browser/Browser.ts`, add the exported helper at module scope (above the class):

```typescript
/**
 * A saved fingerprint predates any later locale change, so reusing it would
 * advertise a different language than the browser context does - an
 * inconsistency no real browser shows. Compare on the primary subtag only:
 * es-419 still satisfies a request for es.
 */
export function fingerprintMatchesLocale(
    fingerprint: BrowserFingerprintWithHeaders | null | undefined,
    locale: string | undefined
): boolean {
    if (!locale) return true
    if (!fingerprint) return false

    const want = locale.split('-')[0]?.toLowerCase()
    if (!want) return true

    const navigator = fingerprint.fingerprint?.navigator as
        | { language?: string; languages?: string[] }
        | undefined
    const languages = [navigator?.language, ...(navigator?.languages ?? [])].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
    )
    if (!languages.length) return false
    if (!languages.some(value => value.split('-')[0]?.toLowerCase() === want)) return false

    const headers = (fingerprint.headers ?? {}) as Record<string, string>
    const acceptLanguage = headers['accept-language'] ?? headers['Accept-Language']
    if (acceptLanguage && acceptLanguage.split(',')[0]?.split('-')[0]?.trim().toLowerCase() !== want) {
        return false
    }

    return true
}
```

Then change the fingerprint selection inside `createBrowser` (currently `(shouldUseFingerprint && session?.fingerprint) || (await this.generateFingerprint(...))`) to:

```typescript
            const savedFingerprint = shouldUseFingerprint ? session?.fingerprint : null
            const savedFingerprintUsable = !!savedFingerprint && fingerprintMatchesLocale(savedFingerprint, contextLocale)

            if (savedFingerprint && !savedFingerprintUsable) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'BROWSER',
                    `Saved fingerprint predates the account locale (${contextLocale}) - regenerating so the context and fingerprint agree`
                )
            }

            const fingerprint = savedFingerprintUsable
                ? savedFingerprint
                : await this.generateFingerprint(this.bot.isMobile, contextLocale)
```

Keep everything downstream (`screen`, `newInjectedContext`, saving) unchanged.

- [ ] **Step 4: Verify**

Run: `npm test` (all pass), `npm run lint`, `npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/browser/Browser.ts src/browser/Browser.test.ts
git commit -m "fix(browser): regenerate saved fingerprints whose locale no longer matches the account"
```

---

### Task 2: Attribute earned points to the mechanism that earned them

**Files:**
- Modify: `src/index.ts` (UserData/bot: add `pointsBySource` + `creditPoints`)
- Modify: every current credit site — `src/functions/activities/api/ReportPromotion.ts`, `ClaimBonusPoints.ts`, `ClaimReward.ts`, `Search.ts` (api), `SearchOnBing.ts` (api), `src/functions/activities/browser/Search.ts`, `src/functions/activities/browser/SearchOnBing.ts`, `src/functions/activities/api/VisualSearch.ts`, `src/functions/activities/app/*.ts`, `src/functions/Workers.ts` (EARN-SWEEP, LINK-OFFERS, punchcard children), `src/functions/activities/Quiz.ts`
- Test: `src/util/RunSummary.test.ts` (extend)

**Interfaces:**
- Produces: `bot.pointsBySource: Record<string, number>`, `bot.creditPoints(source: string, amount: number, newBalance?: number): void`, and `formatPointsBySource(points: Record<string, number>): string` exported from `src/util/RunSummary.ts`.
- Consumed by Task 3.

- [ ] **Step 1: Add the helper on the bot**

In `src/index.ts`, on the `MicrosoftRewardsBot` class:

```typescript
    public pointsBySource: Record<string, number> = {}

    /**
     * Records a credit and attributes it to the mechanism that earned it, so a
     * run summary can show which channel is (or is no longer) producing points.
     */
    public creditPoints(source: string, amount: number, newBalance?: number): void {
        if (!Number.isFinite(amount) || amount <= 0) return
        if (typeof newBalance === 'number') this.userData.currentPoints = newBalance
        this.userData.gainedPoints = (this.userData.gainedPoints ?? 0) + amount
        this.pointsBySource[source] = (this.pointsBySource[source] ?? 0) + amount
    }
```

Reset it per account where `userData.gainedPoints` is reset (search `gainedPoints: 0` in the account-start path) with `this.pointsBySource = {}`.

- [ ] **Step 2: Route every credit site through it**

For each file listed above, replace the pair

```typescript
this.bot.userData.currentPoints = newBalance
this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
```

with a single call, using these exact source names:

| Site | Source string |
| --- | --- |
| `ReportPromotion.reportOfferActivity` | `'activity'` |
| `Quiz.ts` (all three phases) | `'quiz'` |
| `Workers.doBingLinkOffers` | `'linkOffers'` |
| `Workers.sweepEarnSnapshotOffers` | `'earnSweep'` |
| `Workers.reportQuestChild` / `ClaimReward.ts` | `'punchcard'` |
| `ClaimBonusPoints.ts` | `'bonusPoints'` |
| browser + api `Search.ts` (main searches) | `'search'` |
| browser + api `Search.ts` bonus loop, `SearchBonus.ts` consumers | `'bonusSearch'` |
| browser + api `SearchOnBing.ts` | `'searchOnBing'` |
| `VisualSearch.ts` | `'visualSearch'` |
| `app/DailyCheckIn.ts`, `app/ReadToEarn.ts`, `app/AppReward.ts` | `'dailyCheckIn'`, `'readToEarn'`, `'appReward'` |

e.g. `this.bot.creditPoints('quiz', gained, newBalance)`. In `ReportPromotion.ts` (a free function) use `bot.creditPoints('activity', gained, newBalance)`. Do not change any log message. If a site only updates `gainedPoints` without a balance, pass no third argument.

- [ ] **Step 3: Format the breakdown**

In `src/util/RunSummary.ts` add:

```typescript
/** Breakdown line for the run summary: `search 120 | quiz 20 | linkOffers 30`. */
export function formatPointsBySource(points: Record<string, number>): string {
    const entries = Object.entries(points)
        .filter(([, value]) => value > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    if (!entries.length) return 'none'
    return entries.map(([source, value]) => `${source} ${value}`).join(' | ')
}
```

Add to `src/util/RunSummary.test.ts`:

```typescript
test('formatPointsBySource ordena por puntos y omite ceros', () => {
    assert.equal(formatPointsBySource({ quiz: 20, search: 120, earnSweep: 0 }), 'search 120 | quiz 20')
})

test('formatPointsBySource devuelve none cuando no hay puntos', () => {
    assert.equal(formatPointsBySource({}), 'none')
    assert.equal(formatPointsBySource({ quiz: 0 }), 'none')
})
```

(Adjust the import line of the existing test file to include `formatPointsBySource`.)

- [ ] **Step 4: Log it per account**

In `src/index.ts`, in the account-completion path that already logs `Points collected | pointsGained=... | currentBalance=... | account=...`, append ` | bySource=${formatPointsBySource(this.pointsBySource)}` to that same message (import `formatPointsBySource` alongside `formatRunSummary`).

- [ ] **Step 5: Verify and commit**

`npm test` (all pass), `npm run lint`, `npm run build`.

```bash
git add src/index.ts src/util/RunSummary.ts src/util/RunSummary.test.ts src/functions src/browser
git commit -m "feat(points): attribute credits to the mechanism that earned them"
```

---

### Task 3: Warn when an account stops earning (silent-breakage alert)

**Files:**
- Create: `src/util/EarningsHistory.ts`
- Create: `src/util/EarningsHistory.test.ts`
- Modify: `src/index.ts` (account-completion path)

**Interfaces:**
- Consumes: `bot.config.sessionPath`, `bot.pointsBySource` (Task 2).
- Produces: `class EarningsHistory { constructor(baseDir: string); record(email: string, gained: number): void; zeroStreak(email: string): number }` and `const ZERO_STREAK_ALERT_THRESHOLD = 3`.

- [ ] **Step 1: Write the failing tests**

Create `src/util/EarningsHistory.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EarningsHistory } from './EarningsHistory'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'earnings-test-'))

test('zeroStreak es 0 sin historial', () => {
    assert.equal(new EarningsHistory(tmpDir()).zeroStreak('a@b.com'), 0)
})

test('cuenta ejecuciones consecutivas a cero', () => {
    const h = new EarningsHistory(tmpDir())
    h.record('a@b.com', 0)
    h.record('a@b.com', 0)
    assert.equal(h.zeroStreak('a@b.com'), 2)
})

test('una ejecución con puntos rompe la racha', () => {
    const h = new EarningsHistory(tmpDir())
    h.record('a@b.com', 0)
    h.record('a@b.com', 30)
    h.record('a@b.com', 0)
    assert.equal(h.zeroStreak('a@b.com'), 1)
})

test('las cuentas no se mezclan', () => {
    const h = new EarningsHistory(tmpDir())
    h.record('a@b.com', 0)
    h.record('c@d.com', 50)
    assert.equal(h.zeroStreak('a@b.com'), 1)
    assert.equal(h.zeroStreak('c@d.com'), 0)
})

test('un directorio no escribible no lanza', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'collide')
    fs.writeFileSync(file, 'x', 'utf-8')
    const h = new EarningsHistory(file)
    assert.doesNotThrow(() => h.record('a@b.com', 0))
    assert.equal(h.zeroStreak('a@b.com'), 0)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test` — FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/util/EarningsHistory.ts`:

```typescript
import fs from 'fs'
import path from 'path'

const FILE = 'earnings.ndjson'
const MAX_ENTRIES_PER_ACCOUNT = 30

export const ZERO_STREAK_ALERT_THRESHOLD = 3

interface Entry {
    email: string
    gained: number
}

/**
 * Append-only record of what each account earned per run, used to notice when a
 * mechanism silently stops producing points. All filesystem errors degrade to
 * "no history" rather than failing a run.
 */
export class EarningsHistory {
    constructor(private readonly baseDir: string) {}

    private get file(): string {
        return path.join(this.baseDir, FILE)
    }

    private read(): Entry[] {
        try {
            return fs
                .readFileSync(this.file, 'utf-8')
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => JSON.parse(line) as Entry)
                .filter(entry => entry && typeof entry.email === 'string' && typeof entry.gained === 'number')
        } catch {
            return []
        }
    }

    record(email: string, gained: number): void {
        const key = email.trim().toLowerCase()
        if (!key) return
        try {
            fs.mkdirSync(this.baseDir, { recursive: true })
            fs.appendFileSync(this.file, `${JSON.stringify({ email: key, gained })}\n`, 'utf-8')
            this.prune()
        } catch {
            // History is best-effort
        }
    }

    /** Consecutive most-recent runs where this account earned nothing. */
    zeroStreak(email: string): number {
        const key = email.trim().toLowerCase()
        const mine = this.read().filter(entry => entry.email === key)
        let streak = 0
        for (let i = mine.length - 1; i >= 0; i--) {
            const entry = mine[i]
            if (!entry || entry.gained > 0) break
            streak++
        }
        return streak
    }

    private prune(): void {
        try {
            const entries = this.read()
            const perAccount = new Map<string, Entry[]>()
            for (const entry of entries) {
                const list = perAccount.get(entry.email) ?? []
                list.push(entry)
                perAccount.set(entry.email, list)
            }
            let trimmed = false
            for (const [email, list] of perAccount) {
                if (list.length > MAX_ENTRIES_PER_ACCOUNT) {
                    perAccount.set(email, list.slice(-MAX_ENTRIES_PER_ACCOUNT))
                    trimmed = true
                }
            }
            if (!trimmed) return
            const kept = entries.filter(entry => perAccount.get(entry.email)?.includes(entry))
            fs.writeFileSync(this.file, kept.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf-8')
        } catch {
            // Pruning is best-effort
        }
    }
}
```

- [ ] **Step 4: Wire the alert**

In `src/index.ts`, in the same account-completion path touched in Task 2 (after `collectedPoints` is known and before returning), add:

```typescript
                const earnings = new EarningsHistory(
                    path.join(path.resolve(process.cwd(), this.config.sessionPath), 'earnings-history')
                )
                earnings.record(accountEmail, collectedPoints)
                const zeroStreak = earnings.zeroStreak(accountEmail)
                if (zeroStreak >= ZERO_STREAK_ALERT_THRESHOLD) {
                    this.logger.warn(
                        'main',
                        'EARNINGS-ALERT',
                        `${accountEmail} has earned no points for ${zeroStreak} consecutive runs - a claiming mechanism may have broken (check QUIZ / LINK-OFFERS / SEARCH log lines)`
                    )
                }
```

Add the imports (`path` is likely already imported; if not, `import path from 'path'`). Warnings already reach configured webhooks through the existing filter, so no webhook code changes.

- [ ] **Step 5: Verify and commit**

`npm test`, `npm run lint`, `npm run build`.

```bash
git add src/util/EarningsHistory.ts src/util/EarningsHistory.test.ts src/index.ts
git commit -m "feat(alerts): warn when an account earns nothing for several consecutive runs"
```

---

### Task 4: Summarise skipped/unsupported activity types

**Files:**
- Modify: `src/functions/Workers.ts`

- [ ] **Step 1: Collect and report**

In `Workers`, add a private field `private skippedTypes: { type: string; title: string; points: number }[] = []`.

In `solveActivities`, in the `default:` branch (which already warns), also push:

```typescript
                        this.skippedTypes.push({
                            type: activity.promotionType ?? 'unknown',
                            title: activity.title ?? '',
                            points: activity.pointProgressMax ?? 0
                        })
```

Add a public method:

```typescript
    /** One line per run listing activity types this build cannot claim yet. */
    public reportSkippedTypes(): void {
        if (!this.skippedTypes.length) return

        const byType = new Map<string, { count: number; points: number; example: string }>()
        for (const item of this.skippedTypes) {
            const entry = byType.get(item.type) ?? { count: 0, points: 0, example: item.title }
            entry.count++
            entry.points += item.points
            byType.set(item.type, entry)
        }

        const claimable = [...byType.entries()].filter(([, entry]) => entry.points > 0)
        const summary = [...byType.entries()]
            .map(([type, entry]) => `${type} x${entry.count} (${entry.points}pts, e.g. "${entry.example}")`)
            .join(' | ')

        const message = `Unsupported activity types this run | ${summary}`
        if (claimable.length) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'ACTIVITY-GAPS',
                `${message} - these award points and are not claimed by any current mechanism`
            )
        } else {
            this.bot.logger.info(this.bot.isMobile, 'ACTIVITY-GAPS', message)
        }

        this.skippedTypes = []
    }
```

- [ ] **Step 2: Call it once per account**

In `src/index.ts`, in the account-completion path (next to the Task 3 alert), add `this.workers.reportSkippedTypes()`.

- [ ] **Step 3: Verify and commit**

`npm run lint`, `npm run build`, `npm test`.

```bash
git add src/functions/Workers.ts src/index.ts
git commit -m "feat(activity): summarise unsupported activity types once per account"
```

---

### Task 5: Split the link-offer flag and skip the scrape when nothing is pending

**Files:**
- Modify: `src/interface/Config.ts`, `src/util/Validator.ts`, `config.example.json`, local `config.json` (NOT committed), `scripts/docker/entrypoint.sh`, `README.md`
- Modify: `src/functions/Workers.ts`

- [ ] **Step 1: Add `activities.linkOffers`**

Mirror `activities.quiz` exactly: interface field, Zod `z.boolean().default(true)` (also in the object `.default({...})` and the hardcoded fallback config), `"linkOffers": true` in `config.example.json` and in the local `config.json`, a `_cfg "${CONFIG_ACTIVITY_LINK_OFFERS:-}" '.activities.linkOffers' bool` line plus doc-block entry in `scripts/docker/entrypoint.sh`, and a README Activities table row: `activities.linkOffers` / boolean / `true` / "Claim [\"Keep earning\" daily offers](#keep-earning-daily-offers)" / `CONFIG_ACTIVITY_LINK_OFFERS`.

In `Workers.doBingLinkOffers`, change the gate from `this.bot.config.activities.quiz` to `this.bot.config.activities.linkOffers` (message: `Skipping Bing link offers (activities.linkOffers=false)`). In `README.md`, update the "Keep earning" section's last bullet to say it is gated by `activities.linkOffers`, and the `activities.quiz` row back to quizzes only.

- [ ] **Step 2: Skip the render when the day is already done**

Today `collectLinkOfferUrls` renders and scrolls `/earn` before the visited-ledger filter runs, so the second run of the day pays the full cost for nothing. Record what was discovered so a later run can decide up front.

In `doBingLinkOffers`, after a successful collection, also record a discovery marker per offer:

```typescript
            for (const url of collected) visitedLedger.record(this.linkOfferDiscoveryKey(url))
```

and before collecting, short-circuit:

```typescript
            const discovered = [...visitedToday].filter(key => key.startsWith('discovered|'))
            if (discovered.length) {
                const pendingKnown = discovered.filter(
                    key => !visitedToday.has(`${accountEmail}|${key.slice('discovered|'.length)}`)
                )
                if (!pendingKnown.length) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LINK-OFFERS',
                        `All ${discovered.length} link offer(s) discovered today were already visited by this account, skipping the /earn render`
                    )
                    return
                }
            }
```

Add the helper next to `linkOfferVisitKey`:

```typescript
    private linkOfferDiscoveryKey(url: string): string {
        const form = /[?&]form=([A-Za-z0-9]+)/i.exec(url)?.[1] ?? url
        return `discovered|${form}`.toLowerCase()
    }
```

(`linkOfferVisitKey` already produces `email|form`, so the two key spaces cannot collide.)

- [ ] **Step 3: Verify and commit**

`npm run lint`, `npm run build`, `npm test`.

```bash
git add src/interface/Config.ts src/util/Validator.ts src/functions/Workers.ts config.example.json scripts/docker/entrypoint.sh README.md
git commit -m "feat(link-offers): own config flag and skip the /earn render once the day is done"
```

---

### Task 6: Record search queries as used only when the search succeeds

**Files:**
- Modify: `src/functions/SearchQueryQueue.ts`
- Modify: `src/functions/activities/browser/Search.ts`, `src/functions/activities/api/Search.ts`

**Interfaces:**
- Produces: `SearchQueryQueue.markSucceeded(query: string): void`; `next()` no longer records to the ledger.

- [ ] **Step 1: Move the write**

In `SearchQueryQueue`, delete the `this.ledger?.record(query)` line in `next()` and add:

```typescript
    /**
     * A query is only burned for other accounts once it actually produced a
     * search; otherwise a failed attempt would waste it for everyone.
     */
    markSucceeded(query: string): void {
        this.ledger?.record(query)
    }
```

- [ ] **Step 2: Call it from both search paths**

In `src/functions/activities/api/Search.ts`, in both loops (main `doSearch` and the bonus loop), call `queryQueue.markSucceeded(query)` immediately after a search is accepted — i.e. after the `if (!res.ig) { ...; continue }` guard, on the path where the search actually ran.

In `src/functions/activities/browser/Search.ts`, call `queryQueue.markSucceeded(query)` right after the search request completes successfully (after the result page is confirmed loaded and before the points/stagnation bookkeeping). Read the file and place it on the path taken by a successful search only; a query that threw or was retried must not be recorded.

- [ ] **Step 3: Verify and commit**

`npm run lint`, `npm run build`, `npm test`.

```bash
git add src/functions/SearchQueryQueue.ts src/functions/activities/api/Search.ts src/functions/activities/browser/Search.ts
git commit -m "fix(search): only burn a query for other accounts once its search succeeded"
```

---

### Task 7: Report config-default drift on Docker startup

**Files:**
- Modify: `scripts/docker/entrypoint.sh`

**Problem:** the entrypoint only warns about keys *missing* from the user's `config.json`. When a shipped default changes (as `searchSettings.queryEngines` did), the existing VM config silently keeps the old value.

- [ ] **Step 1: Snapshot the example and diff it**

Read the existing `_find_new_keys` implementation and follow its style (jq-based, tolerant when jq is absent).

After the existing new-key check, add a defaults-drift check:

- Snapshot path: `config/.config.example.snapshot.json`.
- If the snapshot is missing, copy the current `config.example.json` there and print nothing (first run establishes the baseline).
- If it exists, compute leaf paths whose value differs between the snapshot and the current `config.example.json` (`jq` walk over both, comparing scalars and arrays as JSON strings).
- For each such path, report only when the user's `config/config.json` still holds the *old* snapshot value — that is exactly the "shipped default changed and you never picked it up" case; a value the user deliberately customised differs from both and stays silent.
- Print a banner in the same style as the existing new-key warning, listing `path: old -> new`, and telling the user to edit `config/config.json` or set the matching `CONFIG_*` variable.
- Refresh the snapshot to the current example afterwards so each change is reported once.

Guard the whole block so a missing `jq` or unreadable file skips it silently, exactly like the existing checks.

- [ ] **Step 2: Verify**

Run: `bash -n scripts/docker/entrypoint.sh` (syntax OK).

If `jq` is available locally, exercise the logic manually with a temporary snapshot where one default differs, and confirm: (a) drift the user still holds is reported; (b) a value the user customised is not; (c) the snapshot is refreshed.

- [ ] **Step 3: Commit**

```bash
git add scripts/docker/entrypoint.sh
git commit -m "feat(docker): report shipped-default changes the local config never picked up"
```

---

### Task 8: Pin the link-offer helpers with tests

**Files:**
- Modify: `src/functions/Workers.ts` (export the two pure helpers)
- Create: `src/functions/LinkOffers.test.ts`

- [ ] **Step 1: Extract the pure helpers**

Move `filterLinkOfferUrls` and `linkOfferVisitKey` out of the class into exported module-scope functions in `src/functions/Workers.ts` (`export function filterLinkOfferUrls(rawUrls: string[]): string[]` and `export function linkOfferVisitKey(email: string, url: string): string`), keeping the bodies identical, and update the call sites to the free functions. `MAX_LINK_OFFERS` stays module-scope.

- [ ] **Step 2: Write the tests**

Create `src/functions/LinkOffers.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterLinkOfferUrls, linkOfferVisitKey } from './Workers'

const NEWS = 'https://www.bing.com/search?q=Bing%20news%20quiz&form=ML2BF3&PROGRAMNAME=BingDailyOfferIN'
const PUZZLE = 'https://www.bing.com/spotlight/imagepuzzle?form=ML2BF0&PROGRAMNAME=BingDailyOfferIN'
const DONE = 'https://www.bing.com/search?q=coral&form=ML2UYA&PROGRAMNAME=BingDailyOfferIN&rnoreward=1'

test('mantiene las ofertas pendientes', () => {
    assert.deepEqual(filterLinkOfferUrls([NEWS, PUZZLE]), [NEWS, PUZZLE])
})

test('descarta las ya completadas (rnoreward=1)', () => {
    assert.deepEqual(filterLinkOfferUrls([DONE]), [])
})

test('ignora enlaces sin PROGRAMNAME', () => {
    assert.deepEqual(filterLinkOfferUrls(['https://www.bing.com/search?q=algo']), [])
})

test('deduplica por código form', () => {
    const other = 'https://www.bing.com/spotlight/imagepuzzle?form=ML2BF0&PROGRAMNAME=BingDailyOfferIN&x=1'
    assert.deepEqual(filterLinkOfferUrls([PUZZLE, other]), [PUZZLE])
})

test('la clave de visita combina cuenta y form, en minúsculas', () => {
    assert.equal(linkOfferVisitKey('User@Example.com', NEWS), 'user@example.com|ml2bf3')
})

test('la clave distingue cuentas', () => {
    assert.notEqual(linkOfferVisitKey('a@b.com', NEWS), linkOfferVisitKey('c@d.com', NEWS))
})
```

- [ ] **Step 3: Verify and commit**

`npm test` (all pass), `npm run lint`, `npm run build`.

```bash
git add src/functions/Workers.ts src/functions/LinkOffers.test.ts
git commit -m "test(link-offers): pin URL filtering and visit-key behaviour"
```

---

### Task 9 (controller): whole-branch review, docs, deploy

Update `README.md` (new `activities.linkOffers` row already added in Task 5; add the `earnings-history/` row to the sessionPath table and a line about the `EARNINGS-ALERT` / `ACTIVITY-GAPS` log tags in "How activities are claimed"), run the full check suite, `graphify update .`, merge, push, deploy to the VM, and validate with a single-account run.
