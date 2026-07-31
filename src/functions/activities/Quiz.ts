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
