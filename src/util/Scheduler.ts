export interface SchedulerOptions {
    /** Máximo de tareas en vuelo simultáneas. */
    maxConcurrent: number
    /** Si true, procesa los ítems en orden aleatorio. */
    shuffle: boolean
    /** Delay (ms) a esperar ANTES de cada lanzamiento. Se evalúa una vez por ítem. */
    jitterMs: () => number
    /** Espera asíncrona; inyectable para test. */
    wait: (ms: number) => Promise<void>
    /** Baraja inyectable (para test determinista). Por defecto Fisher-Yates interno. */
    shuffleArray?: <T>(a: T[]) => T[]
    /** Notifica un fallo de `runOne` sin detener el pool. */
    onError?: (item: unknown, error: unknown) => void
}

function defaultShuffle<T>(input: T[]): T[] {
    const a = [...input]
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = a[i] as T
        a[i] = a[j] as T
        a[j] = tmp
    }
    return a
}

/**
 * Procesa `items` con como mucho `opts.maxConcurrent` tareas en vuelo.
 * - Antes de cada lanzamiento espera `opts.wait(opts.jitterMs())`.
 * - Al terminar una tarea, rellena con el siguiente ítem de la cola.
 * - Los errores de `runOne` se capturan (reportados por `opts.onError`) y NO
 *   detienen el pool ni rechazan esta promesa.
 * - Resuelve cuando la cola está vacía y no queda ninguna tarea en vuelo.
 */
export async function runScheduled<T>(
    items: T[],
    runOne: (item: T, index: number) => Promise<void>,
    opts: SchedulerOptions
): Promise<void> {
    const shuffle = opts.shuffleArray ?? defaultShuffle
    const queue: Array<{ item: T; index: number }> = (opts.shuffle ? shuffle(items) : [...items]).map(
        (item, index) => ({ item, index })
    )

    const concurrency = Math.max(1, Math.min(opts.maxConcurrent, queue.length || 1))

    const worker = async (): Promise<void> => {
        // Pop SÍNCRONO antes de cualquier await, para evitar carreras por el mismo ítem.
        for (;;) {
            const next = queue.shift()
            if (!next) return

            await opts.wait(opts.jitterMs())

            try {
                await runOne(next.item, next.index)
            } catch (error) {
                opts.onError?.(next.item, error)
            }
        }
    }

    const runners: Array<Promise<void>> = []
    for (let i = 0; i < concurrency; i++) {
        runners.push(worker())
    }

    await Promise.all(runners)
}
