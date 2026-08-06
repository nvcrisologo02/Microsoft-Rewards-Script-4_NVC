import type { Page } from 'patchright'

import type { BasePromotion } from '../../../interface/DashboardData'
import { URLs } from '../../../constants/urls'
import { Workers } from '../../Workers'
import { UrlReward } from '../api/UrlReward'
import { welcomeTourOptions } from '../api/UrlRewardOptions'

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
