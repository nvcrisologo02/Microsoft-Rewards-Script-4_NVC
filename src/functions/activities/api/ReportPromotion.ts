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
    promotion: Pick<BasePromotion, 'offerId'> & Partial<Pick<BasePromotion, 'activityType'>>
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
