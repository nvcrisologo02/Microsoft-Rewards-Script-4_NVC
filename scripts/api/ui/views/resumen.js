import { html, useEffect, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, ApiError } from '../api.js'
import { toast } from '../toast.js'

function fmt(n) {
    return n == null ? '—' : n.toLocaleString('es')
}

async function control(path, body, okMsg) {
    try {
        await api(path, { method: 'POST', body: body ?? {} })
        toast(okMsg)
    } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Sin conexión con la API'
        toast(msg, 'err')
    }
}

function AccountPicker({ accounts, onClose }) {
    const [index, setIndex] = useState(accounts[0]?.index ?? 1)
    return html`<div class="overlay" onClick=${e => { if (e.target === e.currentTarget) onClose() }}>
        <div class="modal" role="dialog" aria-label="Ejecutar una sola cuenta">
            <h2>Ejecutar una sola cuenta</h2>
            <label for="acc">Cuenta</label>
            <select id="acc" value=${index} onInput=${e => setIndex(Number(e.target.value))}>
                ${accounts.map(a => html`<option key=${a.index} value=${a.index}>${a.email}</option>`)}
            </select>
            <div class="savebar">
                <button class="btn" onClick=${onClose}>Cancelar</button>
                <button class="btn primary" onClick=${async () => {
                    await control('/start', { accountIndex: index }, 'Run de una cuenta iniciado')
                    onClose()
                }}>Iniciar</button>
            </div>
        </div>
    </div>`
}

export function Resumen({ state }) {
    const status = state?.status
    const run = status?.run
    const live = run?.live
    const [schedule, setSchedule] = useState(null)
    const [errors, setErrors] = useState([])
    const [accounts, setAccounts] = useState([])
    const [picker, setPicker] = useState(false)

    useEffect(() => {
        api('/schedule').then(setSchedule).catch(() => {})
        api('/accounts').then(d => setAccounts(d.accounts ?? [])).catch(() => {})
    }, [])
    useEffect(() => {
        api('/errors?limit=8').then(d => setErrors(d.errors ?? [])).catch(() => {})
    }, [status?.state])

    const busy = ['starting', 'running', 'stopping'].includes(status?.state)
    const accs = run?.accounts ?? []
    const okCount = accs.filter(a => a.success === true).length
    const failCount = accs.filter(a => a.success === false).length
    const seen = run?.accountsSeen ?? 0
    const total = run?.accountsTotal ?? 0
    const pct = total > 0 ? Math.round(seen / total * 100) : 0

    return html`<section class="view">
        <h1>Resumen</h1>
        <p class="sub">Estado del bot, progreso del run y últimos avisos.</p>
        <div class="grid-kpi">
            <div class="card kpi"><div class="lbl">Puntos esta sesión</div>
                <div class="val">${run?.collected ? `+${fmt(run.collected)}` : '0'}</div>
                <div class="d">${busy ? 'run en curso' : 'sin run activo'}</div></div>
            <div class="card kpi"><div class="lbl">Balance actual</div>
                <div class="val">${fmt(live?.currentBalance)}</div>
                <div class="d">${live?.currentAccount ?? 'cuenta activa'}</div></div>
            <div class="card kpi"><div class="lbl">Cuentas</div>
                <div class="val">${total ? `${okCount}/${total}` : '—'}</div>
                <div class="d ${failCount ? 'down' : ''}">${failCount ? `${failCount} con error` : 'sin errores'}</div></div>
            <div class="card kpi"><div class="lbl">Próximo run</div>
                <div class="val">${schedule?.enabled && schedule?.cron ? schedule.cron : '—'}</div>
                <div class="d">${schedule?.timezone ?? 'cron no configurado'}</div></div>
        </div>
        <div class="cols">
            <div class="card">
                <div class="row" style="justify-content:space-between;margin-bottom:12px">
                    <b style="font-size:13.5px">Run</b>
                    ${status?.startedAt && html`<span style="font:12px var(--mono);color:var(--ink-3)">
                        iniciado ${new Date(status.startedAt).toLocaleTimeString('es')}</span>`}
                </div>
                ${busy ? html`
                    <div class="row" style="margin-bottom:12px">
                        <span class="em">${live?.currentAccount ?? '…'}</span>
                        <div class="bar"><i style=${`width:${pct}%`}></i></div>
                        <span class="num" style="font-size:12px;color:var(--ink-2)">${seen}/${total}</span>
                    </div>
                    <div class="chips">
                        ${accs.map(a => html`<span key=${a.email} class=${
                            'chip ' + (a.success === true ? 'ok' : a.success === false ? 'err' : a.email === live?.currentAccount ? 'now' : '')
                        }>${a.email}${a.collectedPoints != null ? ` · +${fmt(a.collectedPoints)}` : ''}</span>`)}
                    </div>`
                : html`<p style="color:var(--ink-3);margin:0 0 6px">
                    No hay ningún run en marcha.${status?.lastExit ? ` Último proceso terminó con código ${status.lastExit.code}.` : ''}</p>`}
                <div class="savebar">
                    <button class="btn" disabled=${busy} onClick=${() => setPicker(true)}>Solo una cuenta…</button>
                    <button class="btn" disabled=${!busy} onClick=${() => {
                        if (confirm('¿Reiniciar el run actual?')) control('/restart', {}, 'Reinicio solicitado')
                    }}>Reiniciar</button>
                    ${busy
                        ? html`<button class="btn danger" onClick=${() => control('/stop', {}, 'Parada solicitada')}>Detener</button>`
                        : html`<button class="btn primary" onClick=${() => control('/start', {}, 'Run iniciado')}>Iniciar run</button>`}
                </div>
            </div>
            <div class="card">
                <b style="font-size:13.5px">Últimos avisos</b>
                ${errors.length === 0
                    ? html`<p style="color:var(--ink-3);font-size:13px">Sin warnings ni errores recientes.</p>`
                    : html`<ul class="next">${errors.slice(-8).reverse().map(e => html`<li key=${e.id}>
                        <span style=${e.level === 'error' ? 'color:#ff8b8b' : 'color:var(--warn)'}>
                            ${e.level === 'error' ? '✕' : '⚠'} ${e.title ?? ''} · ${e.message}</span>
                    </li>`)}</ul>`}
            </div>
        </div>
        ${picker && html`<${AccountPicker} accounts=${accounts} onClose=${() => setPicker(false)} />`}
    </section>`
}
