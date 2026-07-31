# Quiz solver + cross-account search dedup + Spanish topics — Design

Date: 2026-07-31
Status: Approved by user

## Context

The v4 rewrite only handles `promotionType === 'urlreward'` in `Workers.solveActivities`
([src/functions/Workers.ts](../../../src/functions/Workers.ts) L346-398). Every `quiz`-type
activity ("Completa este puzzle", "¿Conoces la respuesta?", "cita del día"...) falls into the
`default` branch and is skipped with `Unsupported type "quiz"`. Upstream
(TheNetsky/Microsoft-Rewards-Script v4) has the same gap; PR #508 (modern UI quiz auto-click)
was closed without merging, so nothing to sync from upstream.

Search queries come from `QueryCore` sources configured in `searchSettings.queryEngines`
(mostly English/US-GB today). Dedup (`seenQueries` in `SearchQueryQueue`) is per-account,
per-session — nothing prevents two accounts searching the same queries the same day.

Accounts load `langCode`/`geoLocale` from env vars `ACCOUNT_N_LANG_CODE` (default `en`) and
`ACCOUNT_N_GEO_LOCALE` (default `auto`) in `src/util/Load.ts`.

## Decisions (user-confirmed)

1. Quiz solving: **hybrid** — API report first, browser click-through fallback.
2. Search dedup: **per-day, shared across accounts**, file-backed under `sessions/`.
3. Topics: **fully Spain-oriented** — Spanish RSS feeds, `langCode=es`, `geoLocale=ES`,
   reorder `queryEngines` to prioritize Spanish sources.

## 1. Quiz/puzzle solver (hybrid, config toggle)

- New config flag `activities.quiz: boolean` in `config.json`, sibling of
  `activities.urlReward` / `activities.searchOnBing`. Add to the Zod validator
  (`src/util/Validator.ts`) and the `Config` interface (`src/interface/Config.ts`).
  Default in shipped config: `true`.
- Extract the shared "report activity + verify points" flow currently inside
  `UrlReward.runUrlReward` into a reusable helper (e.g. a protected method on `Workers`
  or a shared module) so `Quiz` does not duplicate it. `UrlReward` behavior must not change.
- New `src/functions/activities/Quiz.ts`:
  - **Phase 1 (API)**: `ensureOffer(offerId)` → if reportable, call `reportActivity` server
    action with live hash + activityType (same shape as UrlReward). Check
    `getCurrentPoints()` delta.
  - **Phase 2 (browser fallback)**: only if API did not credit and the offer expected
    points. Open the promotion's destination/quiz page in the existing tab
    (`mainDesktopPage` / `mainMobilePage` depending on `bot.isMobile`):
    - Quiz: click any answer option (modern dashboard redirects every answer to the
      correct-answer page). Repeat while more questions render, bounded (max ~10 clicks).
    - Puzzle: click the "Skip puzzle" / "Omitir puzzle" link if present.
    - Re-check points delta afterwards; log outcome (green when credited).
  - All failures are logged warnings — never throw out of the solver (match sibling solvers).
- `Workers.solveActivities`: add `case 'quiz'` that respects `config.activities.quiz`
  (skip + info log when disabled), passes the correct page for the fallback, and logs like
  the other cases. Unknown types keep the existing `default` warning.
- New `Activities.doQuiz(promotion, page)` wiring in `src/functions/Activities.ts`.

## 2. Cross-account daily search dedup

- New `src/functions/SearchQueryLedger.ts`, file-backed shared ledger:
  - Path: `<sessionPath>/search-history/YYYY-MM-DD.ndjson` (one normalized query key per
    line, `normalizeQueryKey` from `QueryEngine.ts`).
  - `load()`: read today's file into a Set. `record(query)`: `fs.appendFileSync` one line
    (atomic enough across the parallel cluster processes). `cleanup()`: delete files older
    than 7 days.
- `SearchQueryQueue` integration (gated by new flag
  `searchSettings.crossAccountQueryDedup: boolean`, default `true` in shipped config):
  - `prepare()`: run `cleanup()`, then seed `seenQueries` from `load()`.
  - Before activating each new topic cluster: re-read the ledger (cheap) and merge into
    `seenQueries` to minimize races between concurrently-running accounts.
  - On dequeue (`next()` returning a query): `record(query)`.
- Applies to both browser and API search paths (both use `SearchQueryQueue`).
  `SearchOnBing` activity queries (`bing-search-activity-queries.json`) are out of scope.
- `sessions/` is already a persisted Docker volume on the VM — works there unchanged.

## 3. Spanish current-affairs topics

- `src/constants/rssFeeds.ts`: add
  - `googleTrends.es`: `https://trends.google.com/trending/rss?geo=ES`
  - `googleNews.es`: `https://news.google.com/rss?hl=es&gl=ES&ceid=ES:es`
  - `elPais` (portada), `elMundo` (portada), `rtve` (noticias), `veinteMinutos`
    (portada), `marca` (portada) — public RSS endpoints.
- `config.json` `queryEngines` reordered, Spanish-first:
  `["google", "rss.googleTrends.es", "rss.googleNews.es", "rss.elPais", "rss.rtve",
  "rss.elMundo", "rss.veinteMinutos", "rss.marca", "wikipedia", "local"]`
  (drop BBC/Guardian/Verge/HackerNews/reddit from the active list; feeds stay available).
  `google` uses the account geo → ES trends; `wikipedia` uses `langCode` → es.wikipedia.
- `.env_` (local): set `ACCOUNT_N_LANG_CODE=es` and `ACCOUNT_N_GEO_LOCALE=ES` for each
  account. VM `.env` must be updated manually on next deploy (deploy flow preserves it).

## Error handling

- Quiz solver: every phase wrapped; warnings on skip reasons (no hash, not reportable,
  no points credited); errors logged via `bot.logger.error` without aborting the account run.
- Ledger: all fs errors are caught and logged as debug — dedup silently degrades to
  per-session behavior if the file is unreadable/unwritable.

## Testing / verification

- `npm run build` and lint pass.
- Manual run with one account: quiz activity completes (API or fallback) with points
  credited in logs; queries are Spanish; second account's log shows `skippedSeen` > 0 and
  the day's ledger file contains the first account's queries.
