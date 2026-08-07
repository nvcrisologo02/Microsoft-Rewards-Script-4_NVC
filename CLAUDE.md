## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Fork-specific notes

This fork tracks `upstream/v4` (TheNetsky/Microsoft-Rewards-Script). Upstream sync runs through `scripts/sync-upstream.ps1`.

### Claiming paths beyond upstream

`README.md` → "How activities are claimed" is the reference. Four mechanisms coexist, each with its own log tag:

- `ACTIVITY` / `QUIZ` — dashboard promotions dispatched by `promotionType` in `Workers.solveActivities`. Quizzes use a three-phase solver (`src/functions/activities/Quiz.ts`): server action → legacy `bingqa/ReportActivity` → browser click-through.
- `LINK-OFFERS` — `Workers.doBingLinkOffers` scrapes the hydrated `/earn` DOM for Bing daily-offer links (`PROGRAMNAME=`) and visits the pending ones. **These cards are market-gated**: the browser context locale comes from `ACCOUNT_N_LANG_CODE`/`GEO_LOCALE` via `Browser.resolveAccountLocale`, and a mismatched locale makes them invisible.
- `EARN-SWEEP` — `Workers.sweepEarnSnapshotOffers` reports `/earn` snapshot offers that no dashboard flow owns.
- `PUNCHCARD` — quest children; falls back to API `childPromotions` when the quest page renders none.
- `WELCOME-TOUR` — offer único de gamificación (`welcometour`, 50 pts, `Gamification_FRE_Offer6nonwindows`), aparece en móvil en cuentas nuevas. **No está en el snapshot de `/earn`**, así que la acción de servidor no puede reclamarlo (no hay hash): `browser/WelcomeTour.ts` la intenta igualmente —se auto-cura si Microsoft lo añade— y si no suma, navega al `destinationUrl`, asienta y mide el delta. Cuando no acredita, el aviso vuelca URL final, título y contenedores de tour detectados, que es lo que hace falta para clicar el tour en vez de adivinar. `welcomeTourOptions` vive en `UrlRewardOptions.ts` porque `UrlReward` extiende `Workers` y el import cruzado cerraría un ciclo.

Credits from link offers and from the server action arrive asynchronously — code that checks a points delta must settle first, or it will misreport which phase earned the points.

### Repesca automática y pausa de cuentas

`scripts/api/rerunController.js` encadena pasadas tras cada run (solo en `API_MODE=true`): repite las cuentas que ganaron puntos o fallaron, hasta `autoRerun.maxPasses` pasadas **totales** (por defecto 3 = run inicial + 2 repescas). `decideNextPass` es puro y concentra todas las reglas; `RerunController` sólo orquesta. `ProcessManager` no se toca — su máquina de estados describe un proceso hijo, y el estado `cooldown` lo compone `server.js` al publicar el estado.

**La repesca sólo ve lo que el padre parsea del log**, no un resumen que el hijo emita al final: `logParser` marca `success` a `true` con `ACCOUNT-END` y a `false` con `ACCOUNT-ERROR`, y una cuenta sin ninguna de las dos se queda en `success: null`, que `decideNextPass` no reintentaba. Por eso todo camino de fallo de cuenta **debe** loguear `ACCOUNT-ERROR` (el fallo de flujo lo logueaba como `FLOW` y la cuenta se perdía en silencio). Como red final, `decideNextPass` recibe `runFinished` (`entry.run.finished`) y trata la ausencia de resultado como fallo **sólo** si el run no llegó a `RUN-END`, es decir, si el hijo murió a medias.

Un error que se escapa al event loop (throw dentro de un callback de EventEmitter, promesa rechazada sin await) esquiva el try/catch por cuenta de `runTasks`. `src/util/FatalErrorGuard.ts` lo reconvierte en rechazo de la cuenta en vuelo, así que el run sigue con la siguiente en lugar de morir entero. Absorbe como mucho 3 por run: Node no garantiza el estado del proceso tras un `uncaughtException`, y el trabajo abandonado se deja el navegador abierto hasta el final.

`excludedAccountIndexes` de `config/schedule.json` es la única fuente de verdad de "cuenta pausada", y la aplican `POST /start` y `POST /restart` cuando la petición no trae selección explícita (`scripts/api/startSelection.js`). Un `accountIndex` explícito la ignora a propósito.

**El proceso hijo renumera los slots a `ACCOUNT_1..N`**, así que el índice que aparece en sus logs no es el real: la única clave de unión válida entre un run y la configuración es el email.

Cada registro del historial lleva `chainId` (compartido por las pasadas de una cadena) y `pass`. `mergeAccountStats` agrupa por cadena antes de calcular, porque leer la última pasada es leer justo la que ya no encontró nada — sin eso «Último run» sale 0 casi todos los días. Los registros anteriores a `chainId` no lo llevan y cuentan como cadena de uno, así que no hay migración.

En `mergeAccountStats`, `streakProtection` y `streakCounter` se buscan **por separado**: un registro puede traer el objeto de protección con el contador a `null` dentro, y una sola búsqueda dejaría oculto un contador que sigue estando unos registros más atrás.

Las pruebas de `scripts/api/**` ya no están huérfanas: `npm test` = `test:unit` (src) + `test:api`.

### Conventions

- `config.json` is gitignored user-local state. Config changes go to `config.example.json` (tracked) **and** the local `config.json`; never commit the latter. New flags also need a `_cfg` line plus doc-block entry in `scripts/docker/entrypoint.sh` and a README table row.
- Daily NDJSON ledgers under `<sessionPath>` (`search-history/`, `link-offers-history/`) both use `SearchQueryLedger`; all filesystem errors degrade silently by design.
- Verification before committing: `npm run lint`, `npm run build`, `npm test`.

### Deployment

Runs 24/7 in Docker on an Oracle VM. Deploy flow: `git archive main` → `scp` → `tar -xzf --exclude=compose.yaml` in `~/rewards` → `docker compose build && up -d`. The VM's `compose.yaml`, `.env` and `config/config.json` are machine-local and preserved — a changed default in `config.example.json` does **not** reach the VM (the entrypoint only warns about missing keys), so update the VM config or set the matching `CONFIG_*` variable.
