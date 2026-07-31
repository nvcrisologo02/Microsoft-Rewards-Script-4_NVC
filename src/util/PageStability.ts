// Playwright's page.content() throws if a navigation commits while the DOM is
// being serialized ("Unable to retrieve content because the page is navigating
// and changing the content"). SPAs like rewards.bing.com redirect shortly after
// domcontentloaded, so this race is expected and worth retrying.

export function isNavigationRaceError(error: unknown): boolean {
    const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
    if (!msg) return false
    return msg.includes('navigating and changing the content') || msg.includes('unable to retrieve content')
}

export interface RetryOnNavigationOptions {
    attempts?: number
    delayMs?: number
    wait?: (delayMs: number) => Promise<void>
}

export async function retryOnNavigation<T>(fn: () => Promise<T>, options: RetryOnNavigationOptions = {}): Promise<T> {
    const attempts = options.attempts ?? 3
    const delayMs = options.delayMs ?? 2000
    const wait = options.wait ?? ((waitMs: number) => new Promise<void>(resolve => setTimeout(resolve, waitMs)))

    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await fn()
        } catch (error) {
            if (!isNavigationRaceError(error)) throw error
            lastError = error
            if (attempt < attempts - 1) await wait(delayMs)
        }
    }
    throw lastError
}
