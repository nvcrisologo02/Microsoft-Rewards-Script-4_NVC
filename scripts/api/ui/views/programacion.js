import { html, useEffect, useMemo, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, ApiError } from '../api.js'
import { toast } from '../toast.js'
import { nextRuns, parseCron } from '../cron.js'

const PRESETS = [
    { label: 'Diario 07:00', cron: '0 7 * * *' },
    { label: 'Dos veces al día', cron: '0 7,19 * * *' },
    { label: 'Solo laborables', cron: '0 7 * * 1-5' }
]

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

function fmtRun(d) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${hh}:${mm}`
}

export function Programacion() {
    const [schedule, setSchedule] = useState(null)
    const [accounts, setAccounts] = useState([])
    const [draft, setDraft] = useState(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        api('/schedule').then(s => {
            setSchedule(s)
            setDraft({
                enabled: Boolean(s.enabled),
                cron: s.cron ?? '',
                skipIfRunning: s.skipIfRunning !== false,
                excludedAccountIndexes: s.excludedAccountIndexes ?? []
            })
        }).catch(() => toast('No se pudo cargar la programación', 'err'))
        api('/accounts').then(d => setAccounts(d.accounts ?? [])).catch(() => {})
    }, [])

    // Hooks must run in the same order on every render, so cronValid and the
    // upcoming-runs useMemo are computed here - above the loading-state early
    // return below - with null-safe guards while schedule/draft haven't
    // loaded yet.
    const cronValid = draft ? draft.cron !== '' && parseCron(draft.cron) !== null : false
    const upcoming = useMemo(
        () => (draft && cronValid && draft.enabled ? nextRuns(draft.cron, new Date(), 5) : []),
        [draft?.cron, draft?.enabled, cronValid]
    )

    if (!schedule || !draft) {
        return html`<section class="view"><h1>Programación</h1>
            <p class="sub">Cargando…</p></section>`
    }

    const writable = Boolean(schedule.writable)
    const setField = patch => setDraft(d => ({ ...d, ...patch }))

    const toggleExcluded = index => setDraft(d => ({
        ...d,
        excludedAccountIndexes: d.excludedAccountIndexes.includes(index)
            ? d.excludedAccountIndexes.filter(i => i !== index)
            : [...d.excludedAccountIndexes, index].sort((a, b) => a - b)
    }))

    const save = async () => {
        if (draft.enabled && !cronValid) {
            toast('La expresión cron no es válida', 'err')
            return
        }
        setSaving(true)
        try {
            // Omit cron when invalid or blank — server rejects invalid cron
            // even when schedule is disabled.
            const body = { ...draft }
            if (!cronValid) delete body.cron
            const updated = await api('/schedule', { method: 'PATCH', body })
            setSchedule(updated)
            toast('Programación aplicada')
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) toast('Escritura desactivada: pon API_ALLOW_SCHEDULE_WRITE=true y reinicia la API', 'err')
            else toast(err instanceof ApiError ? err.message : 'Sin conexión con la API', 'err')
        } finally {
            setSaving(false)
        }
    }

    return html`<section class="view">
        <h1>Programación</h1>
        <p class="sub">Cron efectivo (${schedule.source === 'override' ? 'guardado desde la API' : 'variable CRON_SCHEDULE'}) · zona horaria ${schedule.timezone ?? 'UTC'}.</p>
        ${!writable && html`<div class="card" style="margin-bottom:12px;color:var(--ink-2)">
            Solo lectura: la escritura del cron requiere <span class="em">API_ALLOW_SCHEDULE_WRITE=true</span>
            (disponible en el modo Docker de la API).</div>`}
        <div class="cols">
            <div class="card">
                <div class="row" style="justify-content:space-between">
                    <b style="font-size:13.5px">Horario</b>
                    <label class="row" style="gap:6px;font-size:12.5px;color:var(--ink-2)">
                        <input type="checkbox" checked=${draft.enabled} disabled=${!writable}
                            onInput=${e => setField({ enabled: e.target.checked })} /> activado
                    </label>
                </div>
                <div class="chips mt">
                    ${PRESETS.map(p => html`<button key=${p.cron}
                        class=${'fchip' + (draft.cron === p.cron ? ' on' : '')} disabled=${!writable}
                        onClick=${() => setField({ cron: p.cron, enabled: true })}>${p.label}</button>`)}
                </div>
                <div class="row mt">
                    <input class="em" style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--ink);padding:8px 12px;letter-spacing:.1em;min-width:160px"
                        value=${draft.cron} disabled=${!writable} aria-label="Expresión cron"
                        onInput=${e => setField({ cron: e.target.value.trim() })} placeholder="0 7 * * *" />
                    ${draft.cron !== '' && html`<span style=${`font-size:12px;color:${cronValid ? 'var(--good)' : 'var(--crit)'}`}>
                        ${cronValid ? 'expresión válida' : 'expresión no válida'}</span>`}
                </div>
                <div class="row mt" style="justify-content:space-between">
                    <label class="row" style="gap:6px;font-size:12.5px;color:var(--ink-2)">
                        <input type="checkbox" checked=${draft.skipIfRunning} disabled=${!writable}
                            onInput=${e => setField({ skipIfRunning: e.target.checked })} /> omitir si ya hay un run activo
                    </label>
                </div>
                <div class="mt">
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3);margin-bottom:6px">
                        Excluir cuentas del run programado</div>
                    <div class="chips">
                        ${accounts.length === 0 ? html`<span style="font-size:12.5px;color:var(--ink-3)">sin cuentas</span>` : ''}
                        ${accounts.map(a => html`<button key=${a.index} disabled=${!writable}
                            class=${'fchip' + (draft.excludedAccountIndexes.includes(a.index) ? ' on' : '')}
                            onClick=${() => toggleExcluded(a.index)}>${a.email}</button>`)}
                    </div>
                </div>
                <div class="savebar">
                    <button class="btn primary" disabled=${!writable || saving} onClick=${save}>Aplicar horario</button>
                </div>
            </div>
            <div class="card">
                <b style="font-size:13.5px">Próximas 5 ejecuciones</b>
                ${upcoming.length === 0
                    ? html`<p style="color:var(--ink-3);font-size:13px">
                        ${draft.enabled ? 'Introduce una expresión cron válida.' : 'La programación está desactivada.'}</p>`
                    : html`<ul class="next">${upcoming.map(d => html`<li key=${d.getTime()}>
                        <span></span><b>${fmtRun(d)}</b></li>`)}</ul>`}
                <p style="font-size:11.5px;color:var(--ink-3);margin-top:10px">
                    Calculadas en tu zona horaria local; el contenedor usa ${schedule.timezone ?? 'UTC'}.</p>
            </div>
        </div>
    </section>`
}
