# Welcometour en navegador — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cobrar el offer `welcometour` (50 pts por cuenta nueva) visitando su `destinationUrl` en el navegador, y —si no cobra— registrar la URL final, el título y los contenedores de tour detectados para que la siguiente iteración sea quirúrgica.

**Architecture:** Un módulo nuevo `browser/WelcomeTour.ts` que orquesta dos fases: reintentar en silencio la acción de servidor (por si Microsoft añade el offer al snapshot algún día) y, si no suma, navegar al destino, asentar y medir el delta de puntos. El `case 'welcometour'` de `Workers` deja de llamar a `doUrlReward` y llama a este módulo.

**Tech Stack:** TypeScript estricto, patchright (`Page`), `node:test` + `node:assert/strict`.

Spec: [`docs/superpowers/specs/2026-08-06-welcometour-browser-phase-design.md`](../specs/2026-08-06-welcometour-browser-phase-design.md)

## Global Constraints

- **Logs del bot en inglés**; nombres de prueba en `src/functions/*.test.ts` en español, como `LinkOffers.test.ts` y `WelcomeTour.test.ts`.
- **La etiqueta de log es `WELCOME-TOUR` y el origen de atribución `welcomeTour`**, ambos ya definidos en `welcomeTourOptions()` de `src/functions/activities/api/UrlRewardOptions.ts`. No dupliques esos literales.
- **`welcomeTourOptions` y `UrlRewardOptions` viven en `UrlRewardOptions.ts`, no en `UrlReward.ts`.** `UrlReward` extiende `Workers`, así que importar desde `UrlReward.ts` en `Workers.ts` cierra un ciclo y deja `Workers` a `undefined`. El módulo nuevo puede importar de `UrlReward.ts` sin problema porque nada de `UrlReward` lo importa a él.
- **Nada puede abortar el run de la cuenta**: todo el módulo va envuelto en `try/catch`.
- Formato: 4 espacios, comillas simples, sin punto y coma final.
- Verificación antes del commit: `npm run lint`, `npm run build`, `npm test`.

---

### Task 1: Resolver el destino del tour

El helper puro que decide si hay una URL a la que navegar. Es la única parte del módulo que se puede probar sin navegador, así que se hace primero y por separado.

**Files:**
- Create: `src/functions/activities/browser/WelcomeTour.ts`
- Test: `src/functions/WelcomeTour.test.ts` (ya existe, se amplía)

**Interfaces:**
- Consumes: `BasePromotion` de `src/interface/DashboardData.ts`, que declara `destinationUrl: string`.
- Produces:
  ```typescript
  export function resolveTourDestination(
      promotion: Pick<BasePromotion, 'destinationUrl'> & Partial<Pick<BasePromotion, 'offerId'>>
  ): string | null
  ```
  Devuelve la URL recortada si es `http:` o `https:` absoluta; `null` en cualquier otro caso.

- [ ] **Step 1: Escribe las pruebas que fallan**

Amplía el import de `src/functions/WelcomeTour.test.ts` y añade las pruebas al final del fichero:

```typescript
import { resolveTourDestination } from './activities/browser/WelcomeTour'

test('una URL https absoluta se acepta tal cual', () => {
    assert.equal(
        resolveTourDestination({ destinationUrl: 'https://rewards.bing.com/welcome' }),
        'https://rewards.bing.com/welcome'
    )
})

test('http tambien vale', () => {
    assert.equal(resolveTourDestination({ destinationUrl: 'http://example.com/a' }), 'http://example.com/a')
})

test('recorta los espacios alrededor', () => {
    assert.equal(resolveTourDestination({ destinationUrl: '  https://a.test/b  ' }), 'https://a.test/b')
})

test('sin destino no hay nada que visitar', () => {
    assert.equal(resolveTourDestination({ destinationUrl: '' }), null)
    assert.equal(resolveTourDestination({ destinationUrl: '   ' }), null)
    assert.equal(resolveTourDestination({ destinationUrl: undefined as unknown as string }), null)
})

test('una URL relativa no basta: no sabemos contra que origen resolverla', () => {
    assert.equal(resolveTourDestination({ destinationUrl: '/earn/tour' }), null)
})

test('rechaza esquemas que no son http', () => {
    assert.equal(resolveTourDestination({ destinationUrl: 'javascript:alert(1)' }), null)
    assert.equal(resolveTourDestination({ destinationUrl: 'file:///etc/passwd' }), null)
})
```

- [ ] **Step 2: Ejecuta y comprueba que fallan**

```bash
node --require ts-node/register --test src/functions/WelcomeTour.test.ts
```

Esperado: FAIL, el módulo `./activities/browser/WelcomeTour` no existe.

- [ ] **Step 3: Crea el módulo con el helper**

Crea `src/functions/activities/browser/WelcomeTour.ts`:

```typescript
import type { BasePromotion } from '../../../interface/DashboardData'

/**
 * Decides whether the promotion names somewhere we can actually navigate.
 *
 * A relative path is rejected on purpose: the offer is served on both the
 * rewards and the bing origin, so resolving it against the wrong one would send
 * the browser somewhere meaningless. Anything that is not http(s) is refused
 * outright - navigating a `javascript:` or `file:` URL is never something this
 * flow should do.
 */
export function resolveTourDestination(
    promotion: Pick<BasePromotion, 'destinationUrl'> & Partial<Pick<BasePromotion, 'offerId'>>
): string | null {
    const raw = typeof promotion?.destinationUrl === 'string' ? promotion.destinationUrl.trim() : ''
    if (!raw) return null

    try {
        const parsed = new URL(raw)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
        return raw
    } catch {
        // Not absolute, so `new URL` throws - a relative path lands here.
        return null
    }
}
```

- [ ] **Step 4: Ejecuta y comprueba que pasan**

```bash
node --require ts-node/register --test src/functions/WelcomeTour.test.ts
```

Esperado: PASS, 8 pruebas (las 2 que ya había más 6 nuevas).

- [ ] **Step 5: Commit**

```bash
git add src/functions/activities/browser/WelcomeTour.ts src/functions/WelcomeTour.test.ts
git commit -m "feat: resolve the welcome tour destination url"
```

---

### Task 2: Visitar el tour y medir el crédito

**Files:**
- Modify: `src/functions/activities/browser/WelcomeTour.ts`
- Modify: `src/functions/Activities.ts`
- Modify: `src/functions/Workers.ts` (el `case 'welcometour'`)

**Interfaces:**
- Consumes: `resolveTourDestination` de la Task 1; `welcomeTourOptions()` de `src/functions/activities/api/UrlRewardOptions.ts`; `UrlReward.doUrlReward(promotion, options)`.
- Produces:
  - `class WelcomeTour extends Workers` con `public async doWelcomeTour(promotion: BasePromotion, page: Page): Promise<void>`
  - `Activities.doWelcomeTour(promotion: BasePromotion, page: Page): Promise<void>`

- [ ] **Step 1: Implementa la clase**

Añade a `src/functions/activities/browser/WelcomeTour.ts`, después del helper. Sustituye la línea de import inicial por el bloque completo:

```typescript
import type { Page } from 'patchright'

import type { BasePromotion } from '../../../interface/DashboardData'
import { URLs } from '../../../constants/urls'
import { Workers } from '../../Workers'
import { UrlReward } from '../api/UrlReward'
import { welcomeTourOptions } from '../api/UrlRewardOptions'
```

y añade tras `resolveTourDestination`:

```typescript
/** Containers Rewards has used for coach-mark style tours. Presence is logged, not clicked. */
const TOUR_MARKERS = [
    '[class*="coachmark" i]',
    '[class*="teachingbubble" i]',
    '[class*="onboarding" i]',
    '[class*="welcome" i]',
    '[data-bi-name*="tour" i]'
]

export class WelcomeTour extends Workers {
    public async doWelcomeTour(promotion: BasePromotion, page: Page): Promise<void> {
        const { tag, source } = welcomeTourOptions()
        const offerId = promotion.offerId

        try {
            const startBalance = await this.bot.browser.func.getCurrentPoints()

            // Phase 1: the server action, quietly. It cannot work today - this
            // offer is absent from the /earn snapshot, so there is no hash to
            // report with - but it costs nothing and self-heals the day
            // Microsoft starts including it.
            await new UrlReward(this.bot).doUrlReward(promotion, welcomeTourOptions())

            const afterReport = await this.bot.browser.func.getCurrentPoints()
            if (afterReport > startBalance) {
                const gained = afterReport - startBalance
                this.bot.creditPoints(source, gained, afterReport)
                this.bot.logger.info(
                    this.bot.isMobile,
                    tag,
                    `Completed via server action | offerId=${offerId} | pointsGained=${gained} | currentBalance=${afterReport}`,
                    'green'
                )
                return
            }

            // Phase 2: visit the destination and see whether it credits.
            const destination = resolveTourDestination(promotion)
            if (!destination) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    tag,
                    `No usable destinationUrl | offerId=${offerId} | destinationUrl="${promotion.destinationUrl ?? ''}" - cannot visit, leaving for manual completion`
                )
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                tag,
                `Visiting tour | offerId=${offerId} | url=${destination} | currentBalance=${afterReport}`
            )

            await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await this.bot.utils.wait(this.bot.utils.randomDelay(8000, 12000))

            const observed = await this.observePage(page)
            this.bot.logger.info(
                this.bot.isMobile,
                tag,
                `Landed | offerId=${offerId} | finalUrl=${observed.url} | title="${observed.title}" | tourMarkers=${observed.markers.length ? observed.markers.join(', ') : 'none'}`
            )

            // FRE offers can credit with a delay, the same way Bing daily offers do.
            await this.bot.utils.wait(this.bot.utils.randomDelay(20000, 30000))

            const settled = await this.bot.browser.func.getCurrentPoints()
            const gained = settled - afterReport

            if (gained > 0) {
                this.bot.creditPoints(source, gained, settled)
                this.bot.logger.info(
                    this.bot.isMobile,
                    tag,
                    `Completed by visiting the tour | offerId=${offerId} | pointsGained=${gained} | currentBalance=${settled}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    tag,
                    `Visiting credited nothing | offerId=${offerId} | expected=${promotion.pointProgressMax} | finalUrl=${observed.url} | title="${observed.title}" | tourMarkers=${observed.markers.length ? observed.markers.join(', ') : 'none'} - the tour likely needs clicking through`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                tag,
                `Error in doWelcomeTour | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        } finally {
            await page.goto(URLs.bing.origin).catch(() => {})
        }
    }

    /**
     * What we landed on. This is the whole point of the visit-and-observe step:
     * if it does not credit, this line is what tells the next iteration which
     * element to click instead of guessing again.
     */
    private async observePage(page: Page): Promise<{ url: string; title: string; markers: string[] }> {
        // page.url() is synchronous, so it needs a plain try/catch rather than
        // the .catch() the async calls below use.
        let url = 'unknown'
        try {
            url = page.url()
        } catch {
            /* keep 'unknown' */
        }
        const title = await page.title().catch(() => 'unknown')

        const markers: string[] = []
        for (const selector of TOUR_MARKERS) {
            const visible = await page
                .locator(selector)
                .first()
                .isVisible()
                .catch(() => false)
            if (visible) markers.push(selector)
        }

        return { url, title, markers }
    }
}
```

- [ ] **Step 2: Expón el método en `Activities.ts`**

En `src/functions/Activities.ts`, añade el import junto a los demás de la sección Browser:

```typescript
import { WelcomeTour } from './activities/browser/WelcomeTour'
```

y el método, tras `doQuiz`:

```typescript
    doWelcomeTour = async (promotion: BasePromotion, page: Page): Promise<void> => {
        const welcomeTour = new WelcomeTour(this.bot)
        await welcomeTour.doWelcomeTour(promotion, page)
    }
```

- [ ] **Step 3: Enruta el switch al módulo nuevo**

En `src/functions/Workers.ts`, dentro del `case 'welcometour'`, sustituye la línea:

```typescript
                        await this.bot.activities.doUrlReward(basePromotion, welcomeTourOptions())
```

por:

```typescript
                        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                        await this.bot.activities.doWelcomeTour(basePromotion, page)
```

El import de `welcomeTourOptions` en `Workers.ts` queda sin uso: elimínalo, o `npm run lint` fallará por variable no usada.

- [ ] **Step 4: Compila y comprueba que no hay ciclo de imports**

```bash
npm run build
node -e "
const W = require('./dist/functions/Workers.js')
const { WelcomeTour, resolveTourDestination } = require('./dist/functions/activities/browser/WelcomeTour.js')
console.log('WelcomeTour es clase ->', typeof WelcomeTour === 'function')
console.log('resolveTourDestination ->', resolveTourDestination({ destinationUrl: 'https://a.test/b' }))
"
```

Esperado:

```
WelcomeTour es clase -> true
resolveTourDestination -> https://a.test/b
```

Si sale `Class extends value undefined`, hay un ciclo: comprueba que `WelcomeTour.ts` importa `welcomeTourOptions` de `../api/UrlRewardOptions` y **no** de `../api/UrlReward`.

- [ ] **Step 5: Verifica la suite completa**

```bash
npm run lint
npm test
```

Esperado: lint sin errores (queda 1 warning preexistente en `src/interface/DashboardData.ts`), 57 pruebas en `src` y 99 en `scripts/api`.

- [ ] **Step 6: Commit**

```bash
git add src/functions/activities/browser/WelcomeTour.ts src/functions/Activities.ts src/functions/Workers.ts
git commit -m "feat: claim the welcome tour by visiting its destination"
```

---

### Task 3: Documentación

**Files:**
- Modify: `README.md` (sección "How activities are claimed")
- Modify: `CLAUDE.md`

- [ ] **Step 1: Documenta el mecanismo en el README**

En `README.md`, en la sección "How activities are claimed", añade tras la subsección de punchcards:

```markdown
### Welcome tour

`welcometour` (`Gamification_FRE_Offer6nonwindows`, 50 points) is the one-off
onboarding tour Rewards offers a newly created account, and it appears on mobile
only. Log tag: `WELCOME-TOUR`.

Unlike every other dashboard promotion, this offer is **absent from the `/earn`
snapshot**, so there is no hash to report with and the server action cannot claim
it. The flow therefore tries the server action first — free, and it self-heals if
Microsoft ever starts including the offer — and otherwise navigates to the
promotion's `destinationUrl`, settles, and checks the points delta.

When visiting does not credit, the warning line carries the final URL, the page
title and any tour containers found, which is what a follow-up needs in order to
click through the tour rather than guess at it.

Gated by `activities.welcomeTour`.
```

- [ ] **Step 2: Actualiza `CLAUDE.md`**

Sustituye la línea de `WELCOME-TOUR` de la lista de mecanismos por:

```markdown
- `WELCOME-TOUR` — offer único de gamificación (`welcometour`, 50 pts, `Gamification_FRE_Offer6nonwindows`), aparece en móvil en cuentas nuevas. **No está en el snapshot de `/earn`**, así que la acción de servidor no puede reclamarlo (no hay hash): `browser/WelcomeTour.ts` la intenta igualmente —se auto-cura si Microsoft lo añade— y si no suma, navega al `destinationUrl`, asienta y mide el delta. Cuando no acredita, el aviso vuelca URL final, título y contenedores de tour detectados, que es lo que hace falta para clicar el tour en vez de adivinar. `welcomeTourOptions` vive en `UrlRewardOptions.ts` porque `UrlReward` extiende `Workers` y el import cruzado cerraría un ciclo.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document the welcome tour browser phase"
```

---

## Despliegue y verificación

Antes de desplegar, comprueba que no hay un run ni una repesca pendiente, o los matarás:

```bash
ssh -i ~/.ssh/oci_vm.key opc@82.70.87.42 'TOKEN=$(docker exec microsoft-rewards-script printenv API_TOKEN); curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3010/status | grep -o "\"state\":\"[a-z]*\""'
```

Debe decir `idle`. Si dice `running` o `cooldown`, espera.

```bash
git archive --format=tar.gz main > /tmp/deploy3.tar.gz
scp -i ~/.ssh/oci_vm.key /tmp/deploy3.tar.gz opc@82.70.87.42:/tmp/deploy3.tar.gz
ssh -i ~/.ssh/oci_vm.key opc@82.70.87.42 "cd ~/rewards && tar -xzf /tmp/deploy3.tar.gz --exclude=compose.yaml && docker compose build && docker compose up -d"
```

No hacen falta cambios de configuración: `activities.welcomeTour` ya está en el `config.json` del VM desde el despliegue anterior.

Lanza un run sobre una de las tres cuentas que tienen el offer (pepelu997, pepelu998 o pepelu999) en lugar de sobre las nueve, que tarda horas. Busca su índice con `GET /accounts` y usa `accountIndex`:

```bash
ssh -i ~/.ssh/oci_vm.key opc@82.70.87.42 'TOKEN=$(docker exec microsoft-rewards-script printenv API_TOKEN); curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"accountIndex\":N}" http://127.0.0.1:3010/start'
```

Qué buscar en el log:

- `[WELCOME-TOUR] Visiting tour | ... url=…` — confirma que hay `destinationUrl` y cuál es.
- `[WELCOME-TOUR] Landed | ... finalUrl=… | title="…" | tourMarkers=…` — el diagnóstico.
- Si sale `Completed by visiting the tour | ... pointsGained=50`, cobrado.
- Si sale `Visiting credited nothing`, el tour exige clics: la propia línea trae la URL y los contenedores detectados con los que construir la fase de clics.
- `No usable destinationUrl` significa que la promoción no trae destino y hay que buscar el tour por otra vía.
