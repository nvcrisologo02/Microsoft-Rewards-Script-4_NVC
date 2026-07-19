import { html, useEffect, useMemo, useState } from '../vendor/htm-preact-standalone.module.js'
import { api } from '../api.js'
import { toast } from '../toast.js'
import { aggregateDaily, totalsByAccount } from '../chartData.js'
import { AreaChart, BarList } from '../chart.js'

const RANGES = [
    { label: '30 días', days: 30 },
    { label: '90 días', days: 90 },
    { label: 'Todo', days: 365 }
]

function fmtDate(iso) {
    const d = new Date(iso)
    return d.toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function fmtDuration(run) {
    if (!run.startedAt || !run.endedAt) return '—'
    const secs = Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000)
    if (secs < 90) return `${secs} s`
    return `${Math.round(secs / 60)} min`
}

export function Ejecuciones({ state }) {
    const [runs, setRuns] = useState(null)
    const [persisted, setPersisted] = useState(true)
    const [range, setRange] = useState(RANGES[0])
    const [open, setOpen] = useState(null)

    const load = () => {
        api('/history?persisted=1&limit=500')
            .then(d => { setRuns(d.runs ?? []); setPersisted(true) })
            .catch(() => {
                api('/history')
                    .then(d => { setRuns(d.runs ?? []); setPersisted(false) })
                    .catch(() => { setRuns([]); toast('No se pudo cargar el historial', 'err') })
            })
    }
    useEffect(load, [])
    // Refresh when a run finishes (state returns to idle).
    useEffect(() => {
        if (state?.status?.state === 'idle') load()
    }, [state?.status?.state])

    const inRange = useMemo(() => {
        if (!runs) return []
        const cutoff = Date.now() - range.days * 24 * 3600 * 1000
        return runs.filter(r => new Date(r.startedAt).getTime() >= cutoff)
    }, [runs, range])

    const daily = useMemo(() => aggregateDaily(inRange, Math.min(range.days, 90)), [inRange, range])
    const totals = useMemo(() => totalsByAccount(inRange), [inRange])

    if (runs === null) {
        return html`<section class="view"><h1>Ejecuciones</h1><p class="sub">Cargando…</p></section>`
    }

    return html`<section class="view">
        <h1>Ejecuciones</h1>
        <p class="sub">${persisted
            ? 'Historial persistente · data/history.ndjson'
            : 'Historial en memoria (se pierde al reiniciar la API)'} · ${runs.length} runs</p>
        <div class="card" style="margin-bottom:12px">
            <div class="row" style="justify-content:space-between;margin-bottom:10px">
                <b style="font-size:13.5px">Puntos ganados por día</b>
                <div class="chips">${RANGES.map(r => html`<button key=${r.days}
                    class=${'fchip' + (range.days === r.days ? ' on' : '')}
                    onClick=${() => setRange(r)}>${r.label}</button>`)}</div>
            </div>
            <${AreaChart} data=${daily} ariaLabel=${`Puntos ganados por día, últimos ${range.days} días`} />
        </div>
        <div class="cols">
            <div class="card" style="padding:16px 6px 6px">
                <b style="font-size:13.5px;padding:0 10px">Runs</b>
                <table>
                    <thead><tr><th>Inicio</th><th>Duración</th><th class="num">Puntos</th><th>Cuentas</th><th>Resultado</th></tr></thead>
                    <tbody>
                    ${inRange.slice(0, 50).map((r, i) => {
                        const ok = (r.accounts ?? []).filter(a => a.success === true).length
                        const fail = (r.accounts ?? []).filter(a => a.success === false).length
                        return html`<tr key=${r.startedAt} style="cursor:pointer"
                            onClick=${() => setOpen(open === i ? null : i)}>
                            <td class="em">${fmtDate(r.startedAt)}</td>
                            <td>${fmtDuration(r)}</td>
                            <td class="num">+${(r.collected ?? 0).toLocaleString('es')}</td>
                            <td>${ok}/${(r.accounts ?? []).length}</td>
                            <td>${fail > 0
                                ? html`<span class="badge err">✕ ${fail} fallo${fail > 1 ? 's' : ''}</span>`
                                : r.exit?.code === 0
                                    ? html`<span class="badge ok">✓ completado</span>`
                                    : html`<span class="badge mut">código ${r.exit?.code ?? '?'}</span>`}</td>
                        </tr>
                        ${open === i && html`<tr key=${r.startedAt + '-d'}><td colspan="5" style="background:var(--surface-2)">
                            ${(r.accounts ?? []).map(a => html`<div key=${a.email} class="row" style="padding:4px 8px;font-size:12.5px">
                                <span class="em" style="flex:1">${a.email}</span>
                                <span class="num">+${(a.collected ?? 0).toLocaleString('es')}</span>
                                ${a.success === false
                                    ? html`<span style="color:#ff8b8b;font-size:12px">${a.error ?? 'falló'}</span>`
                                    : html`<span style="color:var(--good);font-size:12px">✓</span>`}
                            </div>`)}
                        </td></tr>`}`
                    })}
                    </tbody>
                </table>
                ${inRange.length === 0 && html`<p style="padding:0 10px;color:var(--ink-3)">Sin runs en este rango.</p>`}
            </div>
            <div class="card">
                <b style="font-size:13.5px">Total por cuenta (${range.label})</b>
                <div class="mt"><${BarList} items=${totals} ariaLabel="Puntos totales por cuenta" /></div>
            </div>
        </div>
    </section>`
}
