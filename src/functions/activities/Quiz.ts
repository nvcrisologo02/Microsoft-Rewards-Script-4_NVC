import type { Page } from 'patchright'

import { URLs } from '../../constants/urls'
import { Workers } from '../Workers'
import { reportOfferActivity } from './api/ReportPromotion'
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
        await this.runQuiz(promotion, page, true)
    }

    private async runQuiz(promotion: BasePromotion, page: Page, allowSessionRepair: boolean): Promise<void> {
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

            const oldBalance = this.bot.userData.currentPoints
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

            if (outcome.acknowledged) {
                // The dashboard sometimes credits a few seconds after acknowledging.
                // Let it settle before escalating, otherwise phase 2 claims phase 1's points.
                await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 5000))
                const settledBalance = await this.bot.browser.func.getCurrentPoints()
                const settledGain = settledBalance - oldBalance

                if (settledGain > 0) {
                    this.bot.creditPoints('quiz', settledGain, settledBalance)
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'QUIZ',
                        `Completed quiz via server action (credited after settle) | offerId=${offerId} | pointsGained=${settledGain} | currentBalance=${settledBalance}`,
                        'green'
                    )
                    return
                }

                if (live.points === 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'QUIZ',
                        `Completed quiz (no points by design) | offerId=${offerId} | acknowledged=true | pointsGained=0 | currentBalance=${settledBalance}`,
                        'green'
                    )
                    return
                }
            }

            if (allowSessionRepair && !outcome.acknowledged && live.points > 0 && this.bot.currentSessionWasRestored) {
                const repaired = await this.bot.repairCurrentBrowserSession(`QUIZ:${offerId}`)
                if (repaired) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'QUIZ',
                        `Retrying quiz once with the refreshed session | offerId=${offerId}`
                    )
                    const freshPage = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                    await this.runQuiz(promotion, freshPage, false)
                    return
                }
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
        let oldBalance = this.bot.userData.currentPoints
        let totalGained = 0
        let ig: string | null = null

        for (let attempt = 1; attempt <= MAX_QUIZ_REPORTS; attempt++) {
            try {
                const report = await this.bot.browser.func.reportQuizActivity(offerId, { ig, questionIndex: -1 })
                ig = report.ig

                if (report.status < 200 || report.status >= 300) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'QUIZ',
                        `Legacy ReportActivity returned a non-2xx status | attempt=${attempt} | offerId=${offerId} | status=${report.status}`
                    )
                    break
                }

                const newBalance = await this.bot.browser.func.getCurrentPoints()
                const gained = newBalance - oldBalance
                if (gained <= 0) break

                this.bot.creditPoints('quiz', gained, newBalance)
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
                // Http throws on any non-2xx, so failed statuses land here with the code in the message
                const status = (error as { status?: number })?.status
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'QUIZ',
                    `Legacy ReportActivity failed | attempt=${attempt} | offerId=${offerId} | status=${status ?? 'n/a'} | ${error instanceof Error ? error.message : String(error)}`
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
            this.bot.creditPoints('quiz', gained, newBalance)
        }
        return gained
    }
}
