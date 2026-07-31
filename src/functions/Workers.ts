import type { Page } from 'patchright'

import { URLs } from '../constants/urls'
import type { MicrosoftRewardsBot } from '../index'
import type { DashboardData, PunchCard, BasePromotion } from '../interface/DashboardData'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import type { QuestChild, ParentQuest } from '../browser/ReactFunc'
import { reportOfferActivity } from './activities/api/ReportPromotion'
import { SearchQueryLedger } from './SearchQueryLedger'

const MAX_SWEEP_OFFERS = 10
const MAX_LINK_OFFERS = 6

// "Seguir ganando" cards are plain links to Bing daily offers (PROGRAMNAME=BingDailyOfferIN,
// QuoteOfTheDay...). They carry no offerId/hash - Bing credits them on visiting the URL with
// the form code while logged in. Completed ones are marked with rnoreward=1 in the href.
const LINK_OFFER_PATTERN = /https:\/\/(?:www\.)?bing\.com\/[^"'\s\\<>]*PROGRAMNAME=[^"'\s\\<>]*/g

export class Workers {
    public bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async doDailySet(data: DashboardData) {
        const todayKey = this.bot.utils.getFormattedDate()
        const todayData = data.dashboard.dailySetPromotions[todayKey]

        const activitiesUncompleted = todayData?.filter(x => !x?.complete && x.pointProgressMax > 0) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have already been completed')
            return
        }

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Started solving "Daily Set" items')

        await this.solveActivities(activitiesUncompleted)

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have been completed')
    }

    public async doMorePromotions(data: DashboardData) {
        const morePromotions: BasePromotion[] = [
            ...new Map(
                [
                    ...(data.dashboard.morePromotions ?? []),
                    ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
                ]
                    .filter(Boolean)
                    .map(p => [p.offerId, p as BasePromotion] as const)
            ).values()
        ]

        const activitiesUncompleted: BasePromotion[] =
            morePromotions?.filter(x => {
                if (x.complete) return false
                if (x.pointProgressMax <= 0) return false
                if (x.exclusiveLockedFeatureStatus === 'locked') return false
                if (!x.promotionType) return false
                if (x.priority < 0 && x.exclusiveLockedFeatureStatus !== 'unlocked') return false
                if (x.attributes?.promotional === 'True') return false
                return true
            }) ?? []

        if (!activitiesUncompleted.length) {
            const excluded = morePromotions.filter(x => !x.complete && x.pointProgressMax > 0)
            if (excluded.length) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'MORE-PROMOTIONS',
                    `No actionable items, but ${excluded.length} incomplete point-carrying item(s) were excluded by filters | ${excluded
                        .map(
                            x =>
                                `${x.offerId}[type=${x.promotionType} points=${x.pointProgressMax} promo=${x.attributes?.promotional ?? '-'} prio=${x.priority} lock=${x.exclusiveLockedFeatureStatus ?? '-'}]`
                        )
                        .join(', ')}`
                )
            }
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                'All "More Promotion" items have already been completed'
            )
            await this.sweepEarnSnapshotOffers(data)
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            `Started solving ${activitiesUncompleted.length} "More Promotions" items`
        )

        await this.solveActivities(activitiesUncompleted)

        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have been completed')

        await this.sweepEarnSnapshotOffers(data)
    }

    public async sweepEarnSnapshotOffers(data: DashboardData) {
        try {
            const refreshed = await this.bot.browser.func.refreshEarnSnapshot()
            if (refreshed && (!this.bot.reactSnapshot || refreshed.offers.length >= this.bot.reactSnapshot.offers.length)) {
                this.bot.reactSnapshot = refreshed
            }

            const knownIds = new Set<string>()
            const todayKey = this.bot.utils.getFormattedDate()
            for (const promo of data.dashboard.dailySetPromotions[todayKey] ?? []) knownIds.add(promo.offerId)
            for (const promo of data.dashboard.morePromotions ?? []) knownIds.add(promo.offerId)
            for (const promo of data.dashboard.morePromotionsWithoutPromotionalItems ?? []) knownIds.add(promo.offerId)
            for (const card of data.dashboard.punchCards ?? []) {
                for (const child of card.childPromotions ?? []) knownIds.add(child.offerId)
            }

            const offers = this.bot.reactSnapshot?.offers ?? []
            const reportableOffers = offers.filter(offer => offer.reportable && !offer.isCompleted)
            let skippedKnown = 0
            let skippedZeroPoints = 0
            const candidates = reportableOffers
                .filter(offer => {
                    if (knownIds.has(offer.offerId)) {
                        skippedKnown++
                        return false
                    }
                    if (this.bot.config.skipNonPointTasks && offer.points <= 0) {
                        skippedZeroPoints++
                        return false
                    }
                    return true
                })
                .slice(0, MAX_SWEEP_OFFERS)

            this.bot.logger.info(
                this.bot.isMobile,
                'EARN-SWEEP',
                `Sweep summary | snapshotOffers=${offers.length} | reportable=${reportableOffers.length} | candidates=${candidates.length} | skippedKnown=${skippedKnown} | skippedZeroPoints=${skippedZeroPoints}`
            )

            if (!candidates.length) {
                if (reportableOffers.length) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'EARN-SWEEP',
                        `Reportable but excluded | ${reportableOffers
                            .map(
                                offer =>
                                    `${offer.offerId}[points=${offer.points} known=${knownIds.has(offer.offerId)}] "${offer.title}"`
                            )
                            .join(', ')}`
                    )
                }
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'EARN-SWEEP',
                `Found ${candidates.length} reportable offer(s) on /earn not covered by dashboard data | ${candidates
                    .map(offer => `${offer.offerId}[points=${offer.points}]`)
                    .join(', ')}`
            )

            for (const offer of candidates) {
                try {
                    const { status, acknowledged, gained, newBalance } = await reportOfferActivity(
                        this.bot,
                        offer,
                        { offerId: offer.offerId },
                        'earnSweep'
                    )

                    if (gained > 0) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'EARN-SWEEP',
                            `Claimed "${offer.title}" | offerId=${offer.offerId} | pointsGained=${gained} | currentBalance=${newBalance}`,
                            'green'
                        )
                    } else {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'EARN-SWEEP',
                            `Offer not credited | offerId=${offer.offerId} | title="${offer.title}" | status=${status} | acknowledged=${acknowledged}`
                        )
                    }
                } catch (error) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'EARN-SWEEP',
                        `Error reporting offer | offerId=${offer.offerId} | message=${error instanceof Error ? error.message : String(error)}`
                    )
                }

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'EARN-SWEEP',
                `Sweep failed | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    public async doBingLinkOffers() {
        if (this.bot.isMobile) return
        if (!this.bot.config.activities.quiz) {
            this.bot.logger.info(this.bot.isMobile, 'LINK-OFFERS', 'Skipping Bing link offers (activities.quiz=false)')
            return
        }

        const page = this.bot.mainDesktopPage
        if (!page || page.isClosed()) {
            this.bot.logger.debug(this.bot.isMobile, 'LINK-OFFERS', 'No desktop page available, skipping')
            return
        }

        try {
            // Completed cards keep rendering without their rnoreward=1 marker for a while,
            // so remember which offers each account already visited today
            const path = await import('path')
            const visitedLedger = new SearchQueryLedger(
                path.join(path.resolve(process.cwd(), this.bot.config.sessionPath), 'link-offers-history')
            )
            visitedLedger.cleanup()
            const visitedToday = visitedLedger.load()
            const accountEmail = (this.bot.currentAccountEmail ?? '').toLowerCase()

            const collected = await this.collectLinkOfferUrls(page)
            const urls = collected.filter(url => !visitedToday.has(this.linkOfferVisitKey(accountEmail, url)))

            if (!urls.length) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LINK-OFFERS',
                    collected.length
                        ? `All ${collected.length} link offer(s) already visited today, skipping`
                        : 'No pending Bing link offers found on /earn'
                )
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'LINK-OFFERS',
                `Found ${urls.length} pending link offer(s) | ${urls.join(' | ')}`
            )

            let oldBalance = await this.bot.browser.func.getCurrentPoints()
            const startBalance = oldBalance

            for (const url of urls) {
                try {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
                    visitedLedger.record(this.linkOfferVisitKey(accountEmail, url))
                    await this.bot.utils.wait(this.bot.utils.randomDelay(8000, 12000))

                    const newBalance = await this.bot.browser.func.getCurrentPoints()
                    const gained = newBalance - oldBalance

                    if (gained > 0) {
                        this.bot.creditPoints('linkOffers', gained, newBalance)
                        oldBalance = newBalance
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LINK-OFFERS',
                            `Link offer credited | pointsGained=${gained} | currentBalance=${newBalance} | url=${url}`,
                            'green'
                        )
                    } else {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LINK-OFFERS',
                            `Link offer visited, credit not reflected yet (offers credit with delay) | url=${url}`
                        )
                    }
                } catch (error) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LINK-OFFERS',
                        `Error visiting link offer | url=${url} | ${error instanceof Error ? error.message : String(error)}`
                    )
                }

                await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 8000))
            }

            await page.goto(URLs.bing.origin).catch(() => {})

            // Bing daily offers credit asynchronously - settle, then report the batch outcome
            await this.bot.utils.wait(this.bot.utils.randomDelay(20000, 30000))
            const settledBalance = await this.bot.browser.func.getCurrentPoints()
            const batchGained = settledBalance - startBalance
            if (batchGained > 0) {
                // Keep the balance in sync even if the settle read came back lower than the
                // last per-offer read: later activities seed their old balance from it
                this.bot.userData.currentPoints = settledBalance
                this.bot.creditPoints('linkOffers', settledBalance - oldBalance)
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LINK-OFFERS',
                    `Link offers batch complete | offersVisited=${urls.length} | pointsGained=${batchGained} | currentBalance=${settledBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LINK-OFFERS',
                    `Link offers batch did not credit | offersVisited=${urls.length} | currentBalance=${settledBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LINK-OFFERS',
                `Link offer sweep failed | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async collectLinkOfferUrls(page: Page): Promise<string[]> {
        const html = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn, '/earn')
        let urls = this.filterLinkOfferUrls(
            (html ?? '').replace(/&amp;/g, '&').replace(/\\u0026/gi, '&').match(LINK_OFFER_PATTERN) ?? []
        )
        if (urls.length) return urls

        // Section only exists in the hydrated DOM, below the fold and lazily rendered -
        // render /earn, scroll through the page to trigger it, then scrape hrefs
        try {
            await page.goto(URLs.rewards.earn, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await this.bot.utils.wait(3000)

            for (let step = 0; step < 8; step++) {
                await page.mouse.wheel(0, 1200).catch(() => {})
                await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {})
                await this.bot.utils.wait(800)
                const found = await page
                    .locator('a[href*="PROGRAMNAME="]')
                    .count()
                    .catch(() => 0)
                if (found > 0) break
            }
            await page.waitForSelector('a[href*="PROGRAMNAME="]', { timeout: 10000 }).catch(() => {})

            const hrefs = await page.$$eval('a[href*="PROGRAMNAME="]', links =>
                links.map(link => (link as HTMLAnchorElement).href)
            )
            urls = this.filterLinkOfferUrls(hrefs)

            const totalAnchors = await page
                .locator('a')
                .count()
                .catch(() => -1)
            this.bot.logger.info(
                this.bot.isMobile,
                'LINK-OFFERS',
                `DOM scrape | url=${page.url()} | totalAnchors=${totalAnchors} | programAnchors=${hrefs.length} | pending=${urls.length}`
            )
            if (!urls.length) {
                const path = await import('path')
                const shotPath = path.join(
                    path.resolve(process.cwd(), this.bot.config.sessionPath),
                    'link-offers-debug.png'
                )
                await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {})
                this.bot.logger.info(this.bot.isMobile, 'LINK-OFFERS', `Debug screenshot saved | ${shotPath}`)
            }
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'LINK-OFFERS',
                `DOM scrape failed | ${error instanceof Error ? error.message : String(error)}`
            )
        }
        return urls
    }

    private linkOfferVisitKey(email: string, url: string): string {
        const form = /[?&]form=([A-Za-z0-9]+)/i.exec(url)?.[1] ?? url
        return `${email}|${form}`.toLowerCase()
    }

    private filterLinkOfferUrls(rawUrls: string[]): string[] {
        const seen = new Set<string>()
        const out: string[] = []

        for (const raw of rawUrls) {
            const url = raw.trim()
            if (!/PROGRAMNAME=/i.test(url)) continue
            if (/rnoreward=1/i.test(url)) continue

            // Cards can share the same offer (e.g. both puzzles use form=ML2BF0) - dedupe by form code
            const key = /[?&]form=([A-Za-z0-9]+)/i.exec(url)?.[1]?.toUpperCase() ?? url
            if (seen.has(key)) continue
            seen.add(key)
            out.push(url)
        }

        return out.slice(0, MAX_LINK_OFFERS)
    }

    public async doAppPromotions(data: AppDashboardData) {
        const appRewards = data.response.promotions.filter(x => {
            if (x.attributes['complete']?.toLowerCase() !== 'false') return false
            if (!x.attributes['offerid']) return false
            if (!x.attributes['type']) return false
            if (x.attributes['type'] !== 'sapphire') return false

            return true
        })

        if (!appRewards.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-PROMOTIONS',
                'All "App Promotions" items have already been completed'
            )
            return
        }

        for (const reward of appRewards) {
            await this.bot.activities.doAppReward(reward)
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
        }

        this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'All "App Promotions" items have been completed')
    }

    public async doPunchCards(data: DashboardData) {
        let parents: ParentQuest[]

        try {
            const earn = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn, '/earn')
            if (!earn) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', '/earn unavailable - cannot list quests')
                return
            }
            parents = this.bot.browser.react.snapshotQuestList(earn)

            if (!parents.length) {
                const dashboard = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.dashboard, '/dashboard')
                if (dashboard) parents = this.bot.browser.react.snapshotQuestList(earn, dashboard)
            }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Failed fetching /earn for quest list | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        const apiById = new Map(
            (data.dashboard.punchCards ?? [])
                .filter(c => c.parentPromotion?.offerId)
                .map(c => [c.parentPromotion.offerId, c] as const)
        )

        const seen = new Set(parents.map(p => p.offerId))
        for (const card of apiById.values()) {
            const pp = card.parentPromotion
            if (!pp?.offerId || seen.has(pp.offerId)) continue
            parents.push({
                offerId: pp.offerId,
                title: pp.title ?? '',
                pointProgressMax: pp.pointProgressMax ?? 0,
                complete: !!pp.complete
            })
            seen.add(pp.offerId)
        }

        for (const p of parents) {
            if (p.pointProgressMax <= 0) {
                p.pointProgressMax = apiById.get(p.offerId)?.parentPromotion?.pointProgressMax ?? p.pointProgressMax
            }
        }

        const incomplete = parents.filter(p => {
            if (p.complete) return false
            if (this.bot.config.skipNonPointTasks && p.pointProgressMax <= 0) return false
            return true
        })
        if (!incomplete.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'No actionable quests')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Found ${incomplete.length} incomplete quest(s) on /earn | api-matched=${incomplete.filter(p => apiById.has(p.offerId)).length}`
        )

        for (const parent of incomplete) {
            try {
                await this.solvePunchCard(parent, apiById.get(parent.offerId))
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `Error solving quest "${parent.title || parent.offerId}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'Finished processing quests')
    }

    public async doClaimBonusPoints() {
        // Let's just always try to do this
        await this.bot.activities.doClaimBonusPoints()
    }

    private async solvePunchCard(parent: ParentQuest, apiCard: PunchCard | undefined) {
        const parentId = parent.offerId
        const title = parent.title || apiCard?.parentPromotion?.title || parentId

        let questChildren: QuestChild[]
        try {
            const questUrl = URLs.rewards.quest(parentId)
            const html = await this.bot.browser.func.getRewardsPageHtml(questUrl, `/earn/quest/${parentId}`)
            if (!html) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Quest page unavailable for "${title}" - skipping`)
                return
            }
            questChildren = this.bot.browser.react.snapshotQuestPage(html)
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Failed fetching quest page for "${title}" | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        if (!questChildren.length) {
            const apiChildren = (apiCard?.childPromotions ?? []).filter(c => c.offerId && !c.complete)
            if (!apiChildren.length) {
                const raw = apiCard?.childPromotions ?? []
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `No actionable children rendered for "${title}" | apiCard=${apiCard ? 'yes' : 'no'} | apiChildren=${raw.length} (complete=${raw.filter(c => c.complete).length})`
                )
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `No children rendered for "${title}" - falling back to ${apiChildren.length} API child promotion(s) | ${apiChildren
                    .map(c => `${c.offerId}[type=${c.promotionType} points=${c.pointProgressMax} promo=${c.attributes?.promotional ?? '-'}]`)
                    .join(', ')}`
            )

            await this.solveActivities(apiChildren)
            return
        }

        const apiChildById = new Map(
            (apiCard?.childPromotions ?? []).filter(c => c.offerId).map(c => [c.offerId, c] as const)
        )
        const ordered = [...questChildren].sort(
            (a, b) =>
                (apiChildById.get(a.offerId)?.priority ?? Number.MAX_SAFE_INTEGER) -
                (apiChildById.get(b.offerId)?.priority ?? Number.MAX_SAFE_INTEGER)
        )

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Solving "${title}" | children=${ordered.length} | reportable=${ordered.filter(c => c.reportable).length}`
        )

        const startBalance = this.bot.userData.currentPoints
        let reported = 0
        let remaining = 0

        for (const child of ordered) {
            const offerId = child.offerId
            const api = apiChildById.get(offerId)

            if (!child.reportable) {
                remaining++
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `Skip ${offerId}: not reportable (locked=${child.isLocked} disabled=${child.isDisabled} done=${child.isCompleted} hash=${!!child.hash})`
                )
                continue
            }

            if (this.isSearchQuotaChild(offerId, api)) {
                remaining++
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: multi-day search task`)
                continue
            }

            if (this.isClaimChild(offerId, api)) {
                if (!this.bot.config.autoClaimPunchcardRewards) {
                    remaining++
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `Reward for "${title}" ready to claim - left for manual redemption (autoClaimPunchcardRewards=false) | ${offerId}`
                    )
                    continue
                }
                await this.bot.activities.doClaimReward(child, parentId)
                reported++
                continue
            }

            await this.reportQuestChild(child, parentId)
            reported++
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
        }

        const gained = this.bot.userData.currentPoints - startBalance
        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Quest "${title}" ${remaining === 0 ? 'COMPLETE' : 'in progress'} | reported=${reported}${remaining ? ` | remaining=${remaining}` : ''} | pointsGained=${gained} | currentBalance=${this.bot.userData.currentPoints}${parent.pointProgressMax > 0 ? ` | targetPoints=${parent.pointProgressMax}` : ''}`,
            gained > 0 ? 'green' : undefined
        )
    }

    private async reportQuestChild(child: QuestChild, parentId: string) {
        const offerId = child.offerId
        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: "reportActivity" not discovered`)
            return
        }
        if (!child.hash) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: no live hash on quest child`)
            return
        }

        const oldBalance = this.bot.userData.currentPoints
        try {
            const questUrl = URLs.rewards.quest(parentId)
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    child.hash,
                    11,
                    { offerid: offerId, isPromotional: '$undefined', timezoneOffset: this.bot.userData.timezoneOffset }
                ],
                {
                    url: questUrl,
                    referer: questUrl,
                    routerStateTree: this.bot.browser.react.questRouterStateTree(parentId)
                }
            )

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            const gained = newBalance - oldBalance
            if (gained > 0) {
                this.bot.creditPoints('punchcard', gained, newBalance)
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `Reported child | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | pointsGained=${gained} | currentBalance=${newBalance}`,
                gained > 0 || acknowledged ? 'green' : undefined
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'PUNCHCARD',
                `Error reporting child | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async solveActivities(activities: BasePromotion[]) {
        for (const activity of activities) {
            try {
                const type = activity.promotionType?.toLowerCase() ?? ''
                const name = activity.name?.toLowerCase() ?? ''
                const offerId = (activity as BasePromotion).offerId

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type}`
                )

                switch (type) {
                    case 'urlreward': {
                        const basePromotion = activity as BasePromotion

                        // Search on Bing are subtypes of "urlreward"
                        const isSearchOnBing = name.includes('exploreonbing')

                        if (isSearchOnBing && !this.bot.config.activities.searchOnBing) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Skipping "SearchOnBing" (disabled in config) | offerId=${offerId}`
                            )
                            continue
                        }
                        if (!isSearchOnBing && !this.bot.config.activities.urlReward) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Skipping "UrlReward" (disabled in config) | offerId=${offerId}`
                            )
                            continue
                        }

                        if (isSearchOnBing) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "SearchOnBing" | title="${activity.title}" | offerId=${offerId}`
                            )

                            const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                            await this.bot.activities.doSearchOnBing(basePromotion, page)
                        } else {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "UrlReward" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doUrlReward(basePromotion)
                        }
                        break
                    }

                    case 'quiz': {
                        const basePromotion = activity as BasePromotion

                        if (!this.bot.config.activities.quiz) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Skipping "Quiz" (disabled in config) | offerId=${offerId}`
                            )
                            continue
                        }

                        this.bot.logger.info(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Found activity type "Quiz" | title="${activity.title}" | offerId=${offerId}`
                        )

                        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                        await this.bot.activities.doQuiz(basePromotion, page)
                        break
                    }

                    default: {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Skipped activity "${activity.title}" | offerId=${offerId} | Reason: Unsupported type "${activity.promotionType}"`
                        )
                        break
                    }
                }

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Error while solving activity "${activity.title}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    // Util
    private isSearchQuotaChild(offerId: string, api?: BasePromotion): boolean {
        if (api) {
            const type = (api.promotionType ?? '').toLowerCase()
            const attrType = String(api.attributes?.type ?? '').toLowerCase()
            const progressMax = Number(api.activityProgressMax ?? 0)
            if (type === 'search' || attrType === 'search' || progressMax > 1) {
                return true
            }
        }

        return /search/i.test(offerId) && /(day|streak|\dx)/i.test(offerId)
    }

    private isClaimChild(offerId: string, api?: BasePromotion): boolean {
        const dest = (api?.destinationUrl ?? '').toLowerCase()
        if (/\/redeem\//.test(dest)) return true
        return /(redeem|claim|(?<!url)reward)/i.test(offerId)
    }
}
