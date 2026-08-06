[![Discord](https://img.shields.io/badge/Join%20Our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/8BxYbV4pkj)
[![Latest Build](https://img.shields.io/github/actions/workflow/status/TheNetsky/Microsoft-Rewards-Script/auto-release.yml?branch=v4&style=for-the-badge&label=Latest%20Build)](https://github.com/TheNetsky/Microsoft-Rewards-Script/actions/workflows/auto-release.yml)
[![Docker](https://img.shields.io/badge/Docker-GHCR-blue?style=for-the-badge&logo=docker)](https://github.com/TheNetsky/Microsoft-Rewards-Script/pkgs/container/microsoft-rewards-script)

> [!TIP]
> This version supports the **new, modern Bing Rewards dashboard only** - it does **not** support the legacy dashboard.
> If your account still uses the old dashboard, use the [v3 branch](https://github.com/TheNetsky/Microsoft-Rewards-Script/tree/v3) and v3.x releases instead!
>
> Use at your own risk - some features may not work as expected.

---

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Quick Setup](#quick-setup)
    - [Bare metal](#bare-metal)
        - [Get the script](#get-the-script)
- [Account Setup](#account-setup)
- [Config Setup](#config-setup)
    - [Build and run the script (bare metal version)](#build-and-run-the-script-bare-metal-version)
- [Docker](#docker)
- [Control API and Dashboard](#control-api-and-dashboard)
- [Nix Setup](#nix-setup)
- [How activities are claimed](#how-activities-are-claimed)
    - [Daily set and more promotions](#daily-set-and-more-promotions)
    - [Quizzes and puzzles](#quizzes-and-puzzles)
    - ["Keep earning" daily offers](#keep-earning-daily-offers)
    - [Earn snapshot sweep](#earn-snapshot-sweep)
    - [Punchcards and quests](#punchcards-and-quests)
- [Configuration Options](#configuration-options)
    - [Core](#core)
    - [Workers](#workers)
    - [Activities](#activities)
    - [Search Settings](#search-settings)
        - [Query sources](#query-sources)
        - [Cross-account query dedup](#cross-account-query-dedup)
    - [Experimental](#experimental)
    - [Logging](#logging)
    - [Proxy](#proxy)
    - [Webhooks](#webhooks)
- [Troubleshooting](#troubleshooting)
    - [Session management](#session-management)
- [Disclaimer](#disclaimer)

---

## Quick Setup

### Bare metal

**Requirements:** Node.js >= 24 and Git  
Works on Windows, Linux, macOS, and WSL.

#### Get the script

```bash
git clone https://github.com/TheNetsky/Microsoft-Rewards-Script.git
cd Microsoft-Rewards-Script
```

Or, download the latest release ZIP and extract it.

## Account Setup

- Copy and rename [`env.example`](env.example) to `.env` and add your account credentials:

```env
ACCOUNT_1_EMAIL=email@example.com
ACCOUNT_1_PASSWORD=your_password
```

> [!NOTE]
> Add one `ACCOUNT_N_*` block per account. Account slots do not need to be contiguous: `ACCOUNT_2` or `ACCOUNT_4` can be configured even when earlier slots are missing. Accounts run in ascending slot order. Optional per-account fields cover recovery email, locale (`ACCOUNT_N_GEO_LOCALE` defaults to `auto`, the locale of your Microsoft profile), language, proxy, and fingerprint persistence - see [`env.example`](env.example) for all of them.

> [!IMPORTANT]
> **Set `ACCOUNT_N_LANG_CODE` and `ACCOUNT_N_GEO_LOCALE` to your real market.** They do more than pick search topics: the browser context and fingerprint are created with that locale (e.g. `es` + `ES` → `es-ES`), and Rewards only serves some offers - notably the ["Keep earning" daily offers](#keep-earning-daily-offers) - to a browser whose locale matches the account's market. An account left on the default `en` may silently never see those cards.
>
> ```env
> ACCOUNT_1_LANG_CODE=es
> ACCOUNT_1_GEO_LOCALE=ES
> ```

> [!TIP]
> For 2FA accounts, set `ACCOUNT_N_TOTP_SECRET` and the script will generate and enter the 6-digit code automatically. To get the secret: in your Microsoft Security settings open 'Manage how you sign in', add an Authenticator app, and when the QR code appears choose 'enter code manually' - use that code as the value in your `.env`.

> [!WARNING]
> You must rebuild your script after making any changes to the `.env`.

## Config Setup

> [!WARNING]
> Do **not** skip this step if you are running the script bare metal.

- **Bare metal:** Copy or rename `config.example.json` to `config.json` (in the project root) and customize your preferences.
- **Docker:** A valid `config.json` is automatically created on first run and saved locally to `./config/`. You can optionally manually create a `config.json` (e.g., if you need to specify regex values) using the provided `config.example.json`

> [!CAUTION]
> Prior versions of accounts.json and config.json are not compatible with current release.

### Build and run the script (bare metal version)

```bash
npm run pre-build
npm run build
npm run start
```

## Docker

- Copy the sample [`compose.yaml`](compose.yaml)
- Copy and rename [`env.example`](env.example) to `.env` and add your account credentials:

```env
ACCOUNT_1_EMAIL=email@example.com
ACCOUNT_1_PASSWORD=your_password
```

- Review `compose.yaml` to adjust scheduling, timezone, and config options.

> [!NOTE]
> A valid `config.json` is auto-generated on first run using default values, and saved locally to `./config/`.
> Optionally, use `CONFIG_*` variables in the `environment:` section of the `compose.yaml` to customise your options (e.g., clusters, webhook, etc.).
> A full list of available options are in the [table below](#configuration-options).
> `CONFIG_*` variables are applied on every startup and always take precedence over `./config/config.json`.

> [!TIP]
> If a new image adds config options you're missing, a warning will appear in the container logs.
> To update, delete `./config/config.json` and restart - a fresh one will be generated from the latest example, with your `compose.yaml` overrides re-applied.

- Start the container: `docker compose up -d`

> [!TIP]
> Monitor logs with `docker logs microsoft-rewards-script`, useful for viewing passwordless login codes or diagnosing issues.
> You can also enable a webhook in `compose.yaml` for notifications.

---

## Control API and Dashboard

The optional Control API lets a local dashboard or another trusted tool monitor
and control the script over HTTP. See the [complete Control API
documentation](scripts/api/README.md) for setup, authentication, every endpoint,
request fields, response examples, and security guidance.

Common uses include:

- checking API health and the current run state with `GET /health` and
  `GET /status`;
- reading live points, logs, errors, account summaries, run history, and error
  diagnostics;
- listing safe stored-session metadata and deleting the mobile/desktop sessions
  for one account;
- starting all accounts with `POST /start` and an empty JSON body;
- running only one account with `POST /start` and `{"accountIndex":2}`;
- running all accounts except selected slots with `POST /start` and
  `{"excludedAccountIndexes":[2,4]}`;
- stopping or restarting a run with `POST /stop` or `POST /restart`;
- streaming live logs and status updates from `GET /events` using
  Server-Sent Events (SSE);
- reading the active configuration and schedule, with config and schedule
  changes available only when their explicit `API_ALLOW_*` options are enabled.

For example, start only `ACCOUNT_2` with cURL:

```bash
curl --request POST \
  --url http://127.0.0.1:3010/start \
  --header 'Authorization: Bearer YOUR_API_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{"accountIndex":2}'
```

The API also ships a built-in dashboard: with the API running, open
`http://127.0.0.1:3010/ui` in a browser to start/stop runs, watch live logs and
points, and manage stored sessions. See `scripts/api/README.md` for details.

For a ready-made web interface, use the supported and endorsed
[Rewards Dashboard](https://github.com/mgrimace/rewards-dashboard). It connects
to this Control API to manage runs, accounts, schedules, logs, points, and
related script settings.

---

## Nix Setup

If using Nix: `bash scripts/nix/run.sh`

---

## How activities are claimed

Rewards exposes the same offers through several different surfaces, and each one needs its own claiming mechanism. This section describes what the script does with each, so you can tell from the logs which path earned (or skipped) a given item.

### Daily set and more promotions

`doDailySet` and `doMorePromotions` read the dashboard API (`dailySetPromotions`, `morePromotions`) and dispatch each incomplete item by `promotionType`. Log tag: `DAILY-SET`, `MORE-PROMOTIONS`, `ACTIVITY`.

| Type                            | Handled by                                      | Config flag               |
| ------------------------------- | ----------------------------------------------- | ------------------------- |
| `urlreward`                     | Reported through the server action              | `activities.urlReward`    |
| `urlreward` named ExploreOnBing | Bing searches for the offer's terms             | `activities.searchOnBing` |
| `quiz`                          | See [Quizzes and puzzles](#quizzes-and-puzzles) | `activities.quiz`         |
| anything else                   | Skipped with a warning naming the type          | -                         |

### Quizzes and puzzles

Quiz-type activities ("Do you know the answer?", image puzzles, quote of the day when they appear in the daily set) are solved by a three-phase solver that stops as soon as points are credited. Log tag: `QUIZ`.

1. **Server action** - reports the offer exactly like a URL reward, using the live hash from the `/earn` React snapshot. Waits a few seconds and re-reads the balance before deciding it failed, so a slow credit is not mistaken for a failure.
2. **Legacy quiz API** - one `bingqa/ReportActivity` call per question, using the same cookie jar, IG token and headers as the proven search-report path. Stops as soon as a call earns nothing.
3. **Browser fallback** - opens the offer's destination and clicks through: "skip puzzle" if present, otherwise any answer option (on the modern dashboard every answer leads to the completed state).

If the session turns out to be stale (reported but not acknowledged), the solver repairs the session once and retries phase 1 before descending. Set `activities.quiz` to `false` to disable the whole solver.

### "Keep earning" daily offers

The "Keep earning" / "Seguir ganando" cards (news quiz, homepage quiz, image puzzle, quote of the day - typically +5 each) are **not** dashboard promotions: they are plain links to Bing daily offers (`PROGRAMNAME=BingDailyOfferIN`, `PROGRAMNAME=QuoteOfTheDay`) with no offerId and no hash. Bing credits them a few seconds after you _visit_ the URL while signed in. Log tag: `LINK-OFFERS`.

During the desktop pass the script renders `/earn`, scrolls until the lazily-rendered section appears, collects the offer links, and visits the pending ones. Notes:

- **Locale matters.** These cards are market-gated - see the warning in [Account Setup](#account-setup). With a mismatched locale the section renders without them and the log reads `No pending Bing link offers found on /earn`.
- Completed offers are filtered two ways: the `rnoreward=1` marker Rewards adds to the href, and a per-account daily ledger at `<sessionPath>/link-offers-history/YYYY-MM-DD.ndjson` (so a second run the same day logs `already visited today, skipping`).
- Credits arrive asynchronously, so the per-offer line often says "credit not reflected yet" and the real outcome is the `Link offers batch complete` summary logged after a settle delay.
- Gated by `activities.linkOffers`.

### Earn snapshot sweep

Some offers appear in the `/earn` React snapshot with a live hash but never show up in the dashboard API. After more-promotions finishes (mobile pass, and again in the desktop pass) the script refreshes the snapshot and reports up to 10 such offers that no other flow owns. Log tag: `EARN-SWEEP`; the summary line reports how many candidates were found and why the rest were excluded.

### Punchcards and quests

Quests are solved from their own quest page. When a quest page renders no actionable children but the API punchcard data still carries incomplete children (as "Keep earning" does), those children are dispatched through the normal activity dispatcher instead of being dropped. Log tag: `PUNCHCARD`. Reward claiming is gated by `autoClaimPunchcardRewards`.

### Reading the run for problems

Two log tags help spot when Rewards changes something under you:

- `ACTIVITY-GAPS` — one line per account listing activity types this build cannot claim. It is a warning (and reaches your webhooks) only when the skipped items carry points, which is the signal that a new claimable surface has appeared and needs support.
- `EARNINGS-ALERT` — a warning when an account earns nothing for three consecutive runs, i.e. a claiming mechanism has probably broken. History lives per account under `<sessionPath>/earnings-history/`.

The per-account "Points collected" line also carries a `bySource=` breakdown (e.g. `search 120 | quiz 20 | linkOffers 30`) so you can see at a glance which mechanism produced the points - and which stopped.

### Automatic rerun passes

Some credits arrive asynchronously — Bing daily offers in particular can land half a minute after the account has already been closed — so a single pass regularly leaves points behind. When running with `API_MODE=true`, the control API chains extra passes: once a run finishes it waits `delayMinutes`, then runs again with only the accounts that gained points or failed, up to `maxPasses` **total** passes counting the initial run. The chain ends as soon as a pass leaves nothing pending. A run stopped by hand never chains.

Configured under `autoRerun` in `config/schedule.json`, or via the `AUTO_RERUN`, `AUTO_RERUN_DELAY_MINUTES` and `AUTO_RERUN_MAX_PASSES` environment variables:

```json
"autoRerun": { "enabled": true, "delayMinutes": 5, "maxPasses": 3 }
```

Each pass is a separate run in the history and carries `RERUN_PASS` in its environment, which the bot echoes into its `RUN-START` line and into the summary email subject. While a pass is pending, the API reports `state: "cooldown"` — see [the API README](scripts/api/README.md) for the full contract.

### Pausing an account

`excludedAccountIndexes` in `config/schedule.json` — the *Cuentas pausadas* chips in the dashboard's Programación view, or the per-account toggle in Cuentas — keeps an account out of every run: cron, the dashboard's start button and the automatic rerun passes alike. Starting a run with an explicit `accountIndex` still runs that account, since naming a slot is a deliberate override.

## Configuration Options

Edit `config.json` to customize behavior, or set `CONFIG_*` environment variables in `compose.yaml` (Docker). Below are all currently available options.

> [!WARNING]
> Rebuild the script (bare metal), or recreate the container (Docker) after all config changes.

### Core

| Setting                     | Type    | Default      | Description                                                        | Docker environment variable           |
| --------------------------- | ------- | ------------ | ------------------------------------------------------------------ | ------------------------------------- |
| `sessionPath`               | string  | `"sessions"` | Directory to store browser sessions                                |                                       |
| `headless`                  | boolean | `false`      | Run browser invisibly                                              | Always `true` in Docker               |
| `clusters`                  | number  | `1`          | Number of concurrent account clusters                              | `CONFIG_CLUSTERS`                     |
| `errorDiagnostics`          | boolean | `false`      | Save error and unknown-login page diagnostics under `diagnostics/` | `CONFIG_ERROR_DIAGNOSTICS`            |
| `ensureStreakProtection`    | boolean | `true`       | Ensure streak protection is enabled                                | `CONFIG_ENSURE_STREAK_PROTECTION`     |
| `autoClaimPunchcardRewards` | boolean | `false`      | Auto-claim completed punchcard rewards                             | `CONFIG_AUTO_CLAIM_PUNCHCARD_REWARDS` |
| `skipNonPointTasks`         | boolean | `true`       | Skip tasks that award no points                                    | `CONFIG_SKIP_NON_POINT_TASKS`         |
| `accountDelay.min`          | string  | `"1min"`     | Minimum delay before starting the next configured account          | `CONFIG_ACCOUNT_DELAY_MIN`            |
| `accountDelay.max`          | string  | `"3min"`     | Maximum delay before starting the next configured account          | `CONFIG_ACCOUNT_DELAY_MAX`            |
| `searchOnBingLocalQueries`  | boolean | `false`      | Use the local query list for ExploreOnBing                         | `CONFIG_SEARCH_ON_BING_LOCAL`         |
| `globalTimeout`             | string  | `"30sec"`    | Timeout for all actions                                            | `CONFIG_GLOBAL_TIMEOUT`               |

### Workers

| Setting                        | Type    | Default | Description                                                                | Docker environment variable          |
| ------------------------------ | ------- | ------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `workers.doDailySet`           | boolean | `true`  | Complete daily set                                                         | `CONFIG_WORKER_DAILY_SET`            |
| `workers.doClaimBonusPoints`   | boolean | `true`  | Claim bonus points                                                         | `CONFIG_WORKER_CLAIM_BONUS_POINTS`   |
| `workers.doMorePromotions`     | boolean | `true`  | Complete "more activities"                                                 | `CONFIG_WORKER_MORE_PROMOTIONS`      |
| `workers.doPunchCards`         | boolean | `true`  | Complete punchcards                                                        | `CONFIG_WORKER_PUNCH_CARDS`          |
| `workers.doAppPromotions`      | boolean | `true`  | Complete app promotions                                                    | `CONFIG_WORKER_APP_PROMOTIONS`       |
| `workers.doDesktopSearch`      | boolean | `true`  | Perform desktop searches                                                   | `CONFIG_WORKER_DESKTOP_SEARCH`       |
| `workers.doMobileSearch`       | boolean | `true`  | Perform mobile searches                                                    | `CONFIG_WORKER_MOBILE_SEARCH`        |
| `workers.doBonusSearches`      | boolean | `false` | Farm bonus searches beyond the cap                                         | `CONFIG_WORKER_BONUS_SEARCHES`       |
| `workers.doDailyCheckIn`       | boolean | `true`  | Complete daily check-in                                                    | `CONFIG_WORKER_DAILY_CHECKIN`        |
| `workers.doReadToEarn`         | boolean | `true`  | Complete Read-to-Earn                                                      | `CONFIG_WORKER_READ_TO_EARN`         |
| `workers.doActivateSearchPerk` | boolean | `true`  | Activate the "search Nx more" perk when present (runs after the daily set) | `CONFIG_WORKER_ACTIVATE_SEARCH_PERK` |
| `workers.doVisualSearch`       | boolean | `false` | Activate the visual-search streak and perform visual searches              | `CONFIG_WORKER_VISUAL_SEARCH`        |

### Activities

| Setting                   | Type    | Default | Description                                                     | Docker environment variable      |
| ------------------------- | ------- | ------- | --------------------------------------------------------------- | -------------------------------- |
| `activities.urlReward`    | boolean | `true`  | Complete URL reward activities                                  | `CONFIG_ACTIVITY_URL_REWARD`     |
| `activities.searchOnBing` | boolean | `true`  | Complete ExploreOnBing offers                                   | `CONFIG_ACTIVITY_SEARCH_ON_BING` |
| `activities.quiz`         | boolean | `true`  | Solve [quiz/puzzle activities](#quizzes-and-puzzles)            | `CONFIG_ACTIVITY_QUIZ`           |
| `activities.linkOffers`   | boolean | `true`  | Claim ["Keep earning" daily offers](#keep-earning-daily-offers) | `CONFIG_ACTIVITY_LINK_OFFERS`    |
| `activities.welcomeTour`  | boolean | `true`  | Claim the one-off welcome tour offer (50 pts, new accounts)     | `CONFIG_ACTIVITY_WELCOME_TOUR`   |

### Search Settings

| Setting                                 | Type     | Default                             | Description                                                               | Docker environment variable         |
| --------------------------------------- | -------- | ----------------------------------- | ------------------------------------------------------------------------- | ----------------------------------- |
| `searchSettings.scrollRandomResults`    | boolean  | `false`                             | Scroll randomly on results                                                | `CONFIG_SEARCH_SCROLL_RANDOM`       |
| `searchSettings.clickRandomResults`     | boolean  | `false`                             | Click random links                                                        | `CONFIG_SEARCH_CLICK_RANDOM`        |
| `searchSettings.runOnZeroPoints`        | boolean  | `false`                             | Run searches even when no search points remain                            | `CONFIG_SEARCH_RUN_ON_ZERO_POINTS`  |
| `searchSettings.maxBonusSearches`       | number   | `110`                               | Max bonus searches per run (when `doBonusSearches` is on)                 | `CONFIG_SEARCH_MAX_BONUS_SEARCHES`  |
| `searchSettings.parallelSearching`      | boolean  | `true`                              | Run searches in parallel                                                  | `CONFIG_SEARCH_PARALLEL`            |
| `searchSettings.clusterSearch`          | boolean  | `true`                              | Cluster each main topic with Bing suggestions                             | `CONFIG_SEARCH_CLUSTER`             |
| `searchSettings.queryEngines`           | string[] | see [Query sources](#query-sources) | Sources used to build the search query pool                               | `CONFIG_SEARCH_QUERY_ENGINES` \*    |
| `searchSettings.crossAccountQueryDedup` | boolean  | `true`                              | Prevent the same search query being used by more than one account per day | `CONFIG_SEARCH_CROSS_ACCOUNT_DEDUP` |
| `searchSettings.searchResultVisitTime`  | string   | `"10sec"`                           | Time to spend on each search result                                       | `CONFIG_SEARCH_VISIT_TIME`          |
| `searchSettings.searchDelay.min`        | string   | `"30sec"`                           | Minimum delay between searches                                            | `CONFIG_SEARCH_DELAY_MIN`           |
| `searchSettings.searchDelay.max`        | string   | `"1min"`                            | Maximum delay between searches                                            | `CONFIG_SEARCH_DELAY_MAX`           |
| `searchSettings.readDelay.min`          | string   | `"30sec"`                           | Minimum delay for reading                                                 | `CONFIG_SEARCH_READ_DELAY_MIN`      |
| `searchSettings.readDelay.max`          | string   | `"1min"`                            | Maximum delay for reading                                                 | `CONFIG_SEARCH_READ_DELAY_MAX`      |

> [!NOTE]
> \* Docker `CONFIG_*` array values are comma-separated strings e.g. `"error,warn"`. Regex patterns must be set directly in `config.json`.

#### Query sources

`searchSettings.queryEngines` controls where the main search topics come from. Pick any combination; topics from all selected sources are pooled and de-duplicated. When `searchSettings.clusterSearch` is enabled, each main topic is expanded on demand with Bing suggestions, that topic cluster is shuffled and completed, and only then does searching move to the next main topic.

Core sources:

| Selector     | Source                                           |
| ------------ | ------------------------------------------------ |
| `google`     | Google Trends (trending searches)                |
| `wikipedia`  | Wikipedia most-read articles (previous day)      |
| `wikirandom` | Random Wikipedia articles                        |
| `hackernews` | Hacker News front-page stories                   |
| `reddit`     | Reddit r/popular post titles                     |
| `local`      | Bundled `src/functions/search-queries.json` list |

RSS feeds use a dotted path - `rss` for every feed, `rss.<site>` for a whole site, or `rss.<site>.<endpoint>` for a single feed:

| Selector            | Feeds                                                             |
| ------------------- | ----------------------------------------------------------------- |
| `rss.googleTrends`  | Google Trends RSS (`gb`, `us`, `es`)                              |
| `rss.googleNews`    | Google News (`gb`, `us`, `es`, `world`, `technology`, `business`) |
| `rss.bbc`           | BBC News (`top`, `world`, `technology`, `business`, `science`)    |
| `rss.guardian`      | The Guardian (`international`, `world`, `technology`)             |
| `rss.theVerge`      | The Verge (`all`)                                                 |
| `rss.arsTechnica`   | Ars Technica (`all`)                                              |
| `rss.reddit`        | Reddit listing feeds (`popular`, `worldnews`, `technology`)       |
| `rss.elPais`        | El País (`portada`)                                               |
| `rss.elMundo`       | El Mundo (`portada`)                                              |
| `rss.rtve`          | RTVE noticias (`noticias`)                                        |
| `rss.veinteMinutos` | 20minutos (`portada`)                                             |
| `rss.marca`         | Marca - deportes (`portada`)                                      |

Add your own feeds in `src/constants/rssFeeds.ts`.

Default (Spanish current affairs first - swap the `rss.*` entries for `rss.bbc`, `rss.guardian.world` etc. for an English pool):

```json
[
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
]
```

> [!NOTE]
> `google` and `wikipedia` follow the account itself: Google Trends uses `ACCOUNT_N_GEO_LOCALE` and Wikipedia uses `ACCOUNT_N_LANG_CODE`. Setting those two per account is what makes the pool genuinely local, whichever feeds you pick.

#### Cross-account query dedup

With `searchSettings.crossAccountQueryDedup` enabled (the default), every query handed out is appended to a shared daily file at `<sessionPath>/search-history/YYYY-MM-DD.ndjson`, and each account loads that file before building its own pool. Accounts running the same day - including parallel clusters - therefore search different terms instead of repeating each other. Files older than 7 days are deleted automatically, and any filesystem error silently degrades to per-session dedup rather than failing the run. Turn the flag off to restore the previous per-account behaviour.

### Experimental

Opt-in features that may change. Disabled by default.

| Setting                        | Type    | Default | Description                                                       | Docker environment variable              |
| ------------------------------ | ------- | ------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `experimental.apiSearch`       | boolean | `false` | Perform Bing searches over HTTP instead of driving a browser page | `CONFIG_EXPERIMENTAL_API_SEARCH`         |
| `experimental.apiSearchOnBing` | boolean | `false` | Complete ExploreOnBing offers over HTTP instead of the browser    | `CONFIG_EXPERIMENTAL_API_SEARCH_ON_BING` |

> [!NOTE]
> The API paths are faster but depend on the modern dashboard's endpoints. If an ExploreOnBing offer ever fails to be credited, turn `apiSearchOnBing` off to fall back to the browser path.

### Logging

| Setting                          | Type     | Default                | Description                       | Docker environment variable     |
| -------------------------------- | -------- | ---------------------- | --------------------------------- | ------------------------------- |
| `debugLogs`                      | boolean  | `false`                | Enable debug logging              | `CONFIG_DEBUG_LOGS`             |
| `consoleLogFilter.enabled`       | boolean  | `false`                | Enable console log filtering      | `CONFIG_LOG_FILTER_ENABLED`     |
| `consoleLogFilter.mode`          | string   | `"whitelist"`          | Filter mode (whitelist/blacklist) | `CONFIG_LOG_FILTER_MODE`        |
| `consoleLogFilter.levels`        | string[] | `["error", "warn"]`    | Log levels to filter              | `CONFIG_LOG_FILTER_LEVELS` \*   |
| `consoleLogFilter.keywords`      | string[] | `["starting account"]` | Keywords to filter                | `CONFIG_LOG_FILTER_KEYWORDS` \* |
| `consoleLogFilter.regexPatterns` | string[] | `[]`                   | Regex patterns for filtering      |                                 |

> [!NOTE]
> \* Docker `CONFIG_*` array values are comma-separated strings e.g. `"error,warn"`. Regex patterns must be set directly in `config.json`.

### Proxy

| Setting             | Type    | Default | Description                 | Docker environment variable |
| ------------------- | ------- | ------- | --------------------------- | --------------------------- |
| `proxy.queryEngine` | boolean | `true`  | Proxy query engine requests | `CONFIG_PROXY_QUERY_ENGINE` |

### Webhooks

| Setting                                  | Type     | Default                                              | Description                       | Docker environment variable             |
| ---------------------------------------- | -------- | ---------------------------------------------------- | --------------------------------- | --------------------------------------- |
| `webhook.discord.enabled`                | boolean  | `false`                                              | Enable Discord webhook            | `CONFIG_DISCORD_ENABLED`                |
| `webhook.discord.url`                    | string   | `""`                                                 | Discord webhook URL               | `CONFIG_DISCORD_URL`                    |
| `webhook.telegram.enabled`               | boolean  | `false`                                              | Enable Telegram webhook           | `CONFIG_TELEGRAM_ENABLED`               |
| `webhook.telegram.botToken`              | string   | `""`                                                 | Telegram bot token                | `CONFIG_TELEGRAM_BOTTOKEN`              |
| `webhook.telegram.chatId`                | string   | `""`                                                 | Telegram chat id                  | `CONFIG_TELEGRAM_CHATID`                |
| `webhook.ntfy.enabled`                   | boolean  | `false`                                              | Enable ntfy notifications         | `CONFIG_NTFY_ENABLED`                   |
| `webhook.ntfy.url`                       | string   | `""`                                                 | ntfy server URL                   | `CONFIG_NTFY_URL`                       |
| `webhook.ntfy.topic`                     | string   | `""`                                                 | ntfy topic                        | `CONFIG_NTFY_TOPIC`                     |
| `webhook.ntfy.token`                     | string   | `""`                                                 | ntfy authentication token         | `CONFIG_NTFY_TOKEN`                     |
| `webhook.ntfy.title`                     | string   | `"Microsoft-Rewards-Script"`                         | Notification title                | `CONFIG_NTFY_TITLE`                     |
| `webhook.ntfy.tags`                      | string[] | `["bot", "notify"]`                                  | Notification tags                 | `CONFIG_NTFY_TAGS` \*                   |
| `webhook.ntfy.priority`                  | number   | `3`                                                  | Notification priority (1-5)       | `CONFIG_NTFY_PRIORITY`                  |
| `webhook.webhookLogFilter.enabled`       | boolean  | `false`                                              | Enable webhook log filtering      | `CONFIG_WEBHOOK_LOG_FILTER_ENABLED`     |
| `webhook.webhookLogFilter.mode`          | string   | `"whitelist"`                                        | Filter mode (whitelist/blacklist) | `CONFIG_WEBHOOK_LOG_FILTER_MODE`        |
| `webhook.webhookLogFilter.levels`        | string[] | `["error"]`                                          | Log levels to send                | `CONFIG_WEBHOOK_LOG_FILTER_LEVELS` \*   |
| `webhook.webhookLogFilter.keywords`      | string[] | `["starting account", "select number", "collected"]` | Keywords to filter                | `CONFIG_WEBHOOK_LOG_FILTER_KEYWORDS` \* |
| `webhook.webhookLogFilter.regexPatterns` | string[] | `[]`                                                 | Regex patterns for filtering      |                                         |

> [!NOTE]
> \* Docker `CONFIG_*` array values are comma-separated strings e.g. `"error,warn"`. Regex patterns must be set directly in `config.json`.

> [!WARNING]
> **NTFY** users set the `webhookLogFilter` to `enabled`, or you will receive push notifications for _all_ logs.
> When enabled, only account start, 2FA codes, and account completion summaries are delivered as push notifications.
> Customize which notifications you receive with the `keywords` options.

---

## Troubleshooting

> [!TIP]
> Most login issues can be fixed by deleting your /sessions folder, and redeploying the script

### Session management

The session utility requires an explicit command, so running it without an
argument only displays help and never deletes anything.

```bash
# List stored mobile and desktop sessions
npm run clear-sessions -- list

# Delete the sessions belonging to one account
npm run clear-sessions -- email user@example.com

# Delete every stored session
npm run clear-sessions -- all
```

```bash
# List safe session metadata
curl --request GET \
  --url http://127.0.0.1:3010/sessions \
  --header 'Authorization: Bearer YOUR_API_TOKEN'

# Delete only user@example.com's mobile and desktop sessions
curl --request DELETE \
  --url http://127.0.0.1:3010/sessions/user%40example.com \
  --header 'Authorization: Bearer YOUR_API_TOKEN'
```

See the [Control API session documentation](scripts/api/README.md#session-management)
for response data, Axios examples, and error behavior.

#### What lives under `sessionPath`

| Path                                    | Contents                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sessions.db`                           | Browser storage state and fingerprints per account (managed by `npm run clear-sessions`)                         |
| `search-history/YYYY-MM-DD.ndjson`      | Queries already used today, shared across accounts - see [Cross-account query dedup](#cross-account-query-dedup) |
| `link-offers-history/YYYY-MM-DD.ndjson` | Which "Keep earning" offers each account already visited today                                                   |
| `earnings-history/<account>.ndjson`     | Points earned per run per account, used for the `EARNINGS-ALERT` zero-streak warning                             |

Both history directories are self-pruning (7 days) and safe to delete: the worst consequence is that accounts may repeat a query or re-visit an already-claimed offer once.

---

## Disclaimer

Use at your own risk.  
Automation of Microsoft Rewards may lead to account suspension or bans.  
This software is provided for educational purposes only.  
The authors are not responsible for any actions taken by Microsoft.
