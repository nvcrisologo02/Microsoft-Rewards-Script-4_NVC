export interface AccountSummary {
    /** Puntos ganados en esta ejecución. */
    collectedPoints: number
    /** Total de puntos al que ha llegado la cuenta. */
    finalPoints: number
    /** Duración de esta cuenta, en segundos. */
    durationSeconds: number
    email: string
    success: boolean
}

/** Inserta '.' cada 3 dígitos desde la derecha. Determinista, sin Intl. */
function groupThousands(value: number): string {
    const sign = value < 0 ? '-' : ''
    const digits = Math.abs(Math.trunc(value)).toString()
    let out = ''
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) {
            out += '.'
        }
        out += digits[i]
    }
    return sign + out
}

/** Ganados con signo: `+N` para >=0, `-N` para negativos. */
function formatGained(value: number): string {
    return value < 0 ? groupThousands(value) : `+${groupThousands(value)}`
}

function formatMinutes(seconds: number): string {
    return `${(seconds / 60).toFixed(1)}m`
}

function padLeft(text: string, width: number): string {
    return text.padStart(width)
}

function padRight(text: string, width: number): string {
    return text.padEnd(width)
}

/**
 * Devuelve el bloque de resumen (multilínea) listo para una sola llamada al
 * logger. Columnas: Cuenta (izq.), Ganados/Total/Dur (der.), Estado (izq.).
 * La fila TOTAL usa `totalRuntimeSeconds` para la duración (no la suma de
 * duraciones, que en cluster se solapan).
 */
export function formatRunSummary(rows: AccountSummary[], totalRuntimeSeconds: number): string {
    const GAP = '   ' // 3 espacios

    const H_ACCOUNT = 'Cuenta'
    const H_GAINED = 'Ganados'
    const H_TOTAL = 'Total'
    const H_DUR = 'Dur'
    const H_STATUS = 'Estado'
    const TOTAL_LABEL = 'TOTAL'

    const accountCells = rows.map(r => r.email)
    const gainedCells = rows.map(r => formatGained(r.collectedPoints))
    const totalCells = rows.map(r => groupThousands(r.finalPoints))
    const durCells = rows.map(r => formatMinutes(r.durationSeconds))
    const statusCells = rows.map(r => (r.success ? 'OK' : 'FALLO'))

    const okCount = rows.filter(r => r.success).length
    const sumCollected = rows.reduce((sum, r) => sum + r.collectedPoints, 0)
    const sumFinal = rows.reduce((sum, r) => sum + r.finalPoints, 0)

    const totalGained = formatGained(sumCollected)
    const totalTotal = groupThousands(sumFinal)
    const totalDur = formatMinutes(totalRuntimeSeconds)
    const totalStatus = `${okCount}/${rows.length} OK`

    const wAccount = Math.max(H_ACCOUNT.length, TOTAL_LABEL.length, ...accountCells.map(c => c.length))
    const wGained = Math.max(H_GAINED.length, totalGained.length, ...gainedCells.map(c => c.length))
    const wTotal = Math.max(H_TOTAL.length, totalTotal.length, ...totalCells.map(c => c.length))
    const wDur = Math.max(H_DUR.length, totalDur.length, ...durCells.map(c => c.length))
    const wStatus = Math.max(H_STATUS.length, totalStatus.length, ...statusCells.map(c => c.length))

    const rowLine = (account: string, gained: string, total: string, dur: string, status: string): string =>
        padRight(account, wAccount) +
        GAP +
        padLeft(gained, wGained) +
        GAP +
        padLeft(total, wTotal) +
        GAP +
        padLeft(dur, wDur) +
        GAP +
        padRight(status, wStatus)

    const header = rowLine(H_ACCOUNT, H_GAINED, H_TOTAL, H_DUR, H_STATUS)
    const separator = '-'.repeat(header.length)

    const title = `===== RESUMEN DE EJECUCIÓN (${rows.length} cuentas) =====`

    const body = rows.map((r, i) =>
        rowLine(
            accountCells[i] as string,
            gainedCells[i] as string,
            totalCells[i] as string,
            durCells[i] as string,
            statusCells[i] as string
        )
    )

    const totalRow = rowLine(TOTAL_LABEL, totalGained, totalTotal, totalDur, totalStatus)

    return [title, header, ...body, separator, totalRow].join('\n')
}
