import { html, useEffect, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, ApiError } from '../api.js'
import { toast } from '../toast.js'

function fmt(n) {
    return n == null ? '—' : n.toLocaleString('es')
}

export function Cuentas({ state }) {
    const [accounts, setAccounts] = useState(null)
    const [sessions, setSessions] = useState([])
    const [query, setQuery] = useState('')
    const busy = ['starting', 'running', 'stopping'].includes(state?.status?.state)

    const load = () => {
        api('/accounts').then(d => setAccounts(d.accounts ?? [])).catch(() => setAccounts([]))
        api('/sessions').then(d => setSessions(d.sessions ?? [])).catch(() => setSessions([]))
    }
    useEffect(load, [])

    const sessionsFor = email => {
        const mine = sessions.filter(s => s.email?.toLowerCase() === email.toLowerCase())
        return {
            desktop: mine.some(s => s.platform === 'desktop'),
            mobile: mine.some(s => s.platform === 'mobile')
        }
    }

    const runOne = async a => {
        try {
            await api('/start', { method: 'POST', body: { accountIndex: a.index } })
            toast(`Run iniciado solo para ${a.email}`)
        } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Sin conexión con la API', 'err')
        }
    }

    const deleteSessions = async a => {
        if (!confirm(`¿Borrar las sesiones guardadas de ${a.email}? Tendrá que iniciar sesión de nuevo en el próximo run.`)) return
        try {
            const res = await api(`/sessions/${encodeURIComponent(a.email)}`, { method: 'DELETE' })
            toast(`Sesiones borradas (${res.removed})`)
            load()
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) toast('No se puede borrar con un run activo.', 'err')
            else if (err instanceof ApiError && err.status === 404) toast('Esta cuenta no tiene sesiones guardadas.', 'err')
            else toast('Error al borrar las sesiones.', 'err')
        }
    }

    const list = (accounts ?? []).filter(a => a.email.toLowerCase().includes(query.trim().toLowerCase()))

    return html`<section class="view">
        <h1>Cuentas</h1>
        <p class="sub">${accounts ? `${accounts.length} cuentas configuradas en .env` : 'Cargando…'} · edición disponible en la Fase 2.</p>
        <div class="card" style="padding:16px 6px 6px">
            <div class="toolbar" style="padding:0 10px">
                <input placeholder="Buscar cuenta…" aria-label="Buscar cuenta"
                    value=${query} onInput=${e => setQuery(e.target.value)} />
                <span style="flex:1"></span>
                <button class="btn sm" onClick=${load}>↻ Recargar</button>
            </div>
            <table>
                <thead><tr><th>Cuenta</th><th>Región</th><th class="num">Recogido</th><th class="num">Racha</th>
                    <th>Sesiones</th><th>Último run</th><th></th></tr></thead>
                <tbody>
                ${list.map(a => {
                    const s = sessionsFor(a.email)
                    return html`<tr key=${a.index}>
                        <td class="em">${a.email}</td>
                        <td>${a.geoLocale ?? '—'}</td>
                        <td class="num">${fmt(a.totalCollected)}</td>
                        <td class="num">${fmt(a.successStreak)}</td>
                        <td><span class=${'sess' + (s.desktop ? ' has' : '')}>D</span>${' '}
                            <span class=${'sess' + (s.mobile ? ' has' : '')}>M</span></td>
                        <td>${a.lastSuccess === true ? html`<span class="badge ok">✓ ${a.lastCollected != null ? `+${fmt(a.lastCollected)}` : 'ok'}</span>`
                            : a.lastSuccess === false ? html`<span class="badge err">✕ ${a.lastError ?? 'falló'}</span>`
                            : html`<span class="badge mut">sin datos</span>`}</td>
                        <td class="acts">
                            <button class="icon-btn" title="Ejecutar solo esta cuenta" disabled=${busy}
                                onClick=${() => runOne(a)}>▶</button>
                            <button class="icon-btn danger" title="Borrar sesiones guardadas" disabled=${busy}
                                onClick=${() => deleteSessions(a)}>🗑</button>
                        </td>
                    </tr>`
                })}
                </tbody>
            </table>
            ${accounts && accounts.length === 0 && html`<p style="padding:0 10px;color:var(--ink-3)">
                No hay cuentas en .env. Añade bloques ACCOUNT_1_* siguiendo env.example.</p>`}
        </div>
    </section>`
}
