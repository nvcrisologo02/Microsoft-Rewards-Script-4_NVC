import type { BasePromotion } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'
import { reportOfferActivity } from './ReportPromotion'
import type { UrlRewardOptions } from './UrlRewardOptions'

export class UrlReward extends Workers {
    public async doUrlReward(promotion: BasePromotion, options: UrlRewardOptions = {}) {
        await this.runUrlReward(promotion, true, options)
    }

    private async runUrlReward(promotion: BasePromotion, allowSessionRepair: boolean, options: UrlRewardOptions = {}) {
        const offerId = promotion.offerId
        const tag = options.tag ?? 'URL-REWARD'
        const source = options.source ?? 'activity'

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(
                this.bot.isMobile,
                tag,
                `Skipping ${offerId}: "reportActivity" not discovered in bundle`
            )
            return
        }

        const live = await this.bot.browser.func.ensureOffer(offerId)
        if (!live) {
            this.bot.logger.warn(
                this.bot.isMobile,
                tag,
                `Skipping ${offerId}: not present in page snapshot, even after refetching /earn and /dashboard`
            )
            return
        }
        if (!live.reportable) {
            this.bot.logger.warn(
                this.bot.isMobile,
                tag,
                `Skipping ${offerId}: not reportable (completed/locked/no-hash/future-dated)`
            )
            return
        }

        if (this.bot.config.skipNonPointTasks && this.isNonCrediting(live.points, live.promotionSubtype, live.title)) {
            this.bot.logger.info(
                this.bot.isMobile,
                tag,
                `Skipping ${offerId}: awards no points (points=${live.points}${live.promotionSubtype ? ` subtype=${live.promotionSubtype}` : ''}) - likely a free trial/non-crediting offer. Set skipNonPointTasks=false to attempt anyway.`
            )
            return
        }

        const oldBalance = this.bot.userData.currentPoints
        const expectedPoints = live.points

        this.bot.logger.info(
            this.bot.isMobile,
            tag,
            `Starting ${tag} | offerId=${offerId} | geo=${this.bot.userData.geoLocale} | currentBalance=${oldBalance}`
        )

        try {
            const { status, acknowledged, gained: gainedPoints, newBalance } = await reportOfferActivity(this.bot, live, promotion, source)

            this.bot.logger.debug(
                this.bot.isMobile,
                tag,
                `Response | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | pointsGained=${gainedPoints} | currentBalance=${newBalance}`
            )

            if (gainedPoints > 0) {
                const shortfall = expectedPoints > 0 && gainedPoints < expectedPoints
                this.bot.logger.info(
                    this.bot.isMobile,
                    tag,
                    `Completed ${tag} | offerId=${offerId} | pointsGained=${gainedPoints} | currentBalance=${newBalance}${shortfall ? ' | WARNING: credited less than advertised' : ''}`,
                    'green'
                )
            } else if (acknowledged && expectedPoints === 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    tag,
                    `Completed ${tag} (no points by design) | offerId=${offerId} | acknowledged=true | pointsGained=0 | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    tag,
                    `${tag} credited no points | offerId=${offerId} | acknowledged=${acknowledged} | expected=${expectedPoints} | pointsGained=0 | currentBalance=${newBalance}`
                )

                if (allowSessionRepair && !acknowledged && expectedPoints > 0 && this.bot.currentSessionWasRestored) {
                    const repaired = await this.bot.repairCurrentBrowserSession(`${tag}:${offerId}`)
                    if (repaired) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            tag,
                            `Retrying ${tag} once with the refreshed session | offerId=${offerId}`
                        )
                        await this.runUrlReward(promotion, false, options)
                        return
                    }
                }
            }

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                tag,
                `Error in doUrlReward | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private isNonCrediting(points: number, subtype: string | null, title: string): boolean {
        if (points > 0) return false
        const haystack = `${subtype ?? ''} ${title ?? ''}`.toLowerCase()

        // Make proper language independant
        return points === 0 || /free trial|trial|subscription|sign up|sign-up|signup/.test(haystack)
    }
}
