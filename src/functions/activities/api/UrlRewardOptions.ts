/**
 * Lives apart from UrlReward.ts on purpose. `UrlReward` extends `Workers`, and
 * `Workers` needs these options to dispatch a welcome tour - importing them
 * from UrlReward.ts would close a require cycle and leave `Workers` undefined
 * at the moment `class UrlReward extends Workers` is evaluated.
 */
export interface UrlRewardOptions {
    /** Attributes the credit in the bySource breakdown. */
    source?: string
    /** Log tag, so a caller-specific mechanism is greppable on its own. */
    tag?: string
}

/**
 * The welcome tour is a one-off Gamification FRE offer (50 points) that claims
 * exactly like a urlreward - the same reportActivity server action - so it
 * reuses that path rather than duplicating it. Its own source keeps it
 * distinguishable in the points breakdown, which is how we find out whether the
 * server action alone is enough.
 */
export function welcomeTourOptions(): { source: string; tag: string } {
    return { source: 'welcomeTour', tag: 'WELCOME-TOUR' }
}
