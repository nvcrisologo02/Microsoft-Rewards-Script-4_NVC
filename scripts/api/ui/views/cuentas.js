import { html, useEffect, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, ApiError } from '../api.js'
import { toast } from '../toast.js'

function fmt(n) {
    return n == null ? '—' : n.toLocaleString('es')
}

function AccountModal({ initial, onClose, onSaved }) {
    // initial: null for create, or the GET /accounts/:index detail for edit
    const isEdit = Boolean(initial)
    const [form, setForm] = useState({
        email: initial?.email ?? '',
        password: '',
        totpSecret: '',
        recoveryEmail: initial?.recoveryEmail ?? '',
        geoLocale: initial?.geoLocale ?? '',
        langCode: initial?.langCode ?? '',
        proxyUrl: initial?.proxy?.url ?? '',
        proxyPort: initial?.proxy?.port ?? '',
        proxyUsername: initial?.proxy?.username ?? '',
        proxyPassword: '',
        proxyHttp: initial?.proxy?.http ?? false
    })
    const [saving, setSaving] = useState(false)
    const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }))

    const save = async () => {
        setSaving(true)
        const body = {
            email: form.email,
            password: form.password,
            totpSecret: form.totpSecret,
            recoveryEmail: form.recoveryEmail,
            geoLocale: form.geoLocale,
            langCode: form.langCode,
            proxy: {
                http: form.proxyHttp,
                url: form.proxyUrl,
                port: form.proxyPort,
                username: form.proxyUsername,
                password: form.proxyPassword
            }
        }
        try {
            if (isEdit) await api(`/accounts/${initial.index}`, { method: 'PUT', body })
            else await api('/accounts', { method: 'POST', body })
            toast(isEdit ? 'Cuenta actualizada' : 'Cuenta añadida')
            onSaved()
            onClose()
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) toast('Escritura desactivada: pon API_ALLOW_ACCOUNT_WRITE=true en .env y reinicia la API', 'err')
            else if (err instanceof ApiError && err.status === 409) toast('No se puede editar con el bot en ejecución', 'err')
            else toast(err instanceof ApiError ? err.message : 'Sin conexión con la API', 'err')
        } finally {
            setSaving(false)
        }
    }

    const secretPlaceholder = has => (isEdit && has ? '•••••• (sin cambios)' : '')

    return html`<div class="overlay" onClick=${e => { if (e.target === e.currentTarget) onClose() }}>
        <div class="modal" role="dialog" aria-label=${isEdit ? 'Editar cuenta' : 'Añadir cuenta'} style="width:min(520px,92vw)">
            <h2>${isEdit ? `Editar cuenta ${initial.index}` : 'Añadir cuenta'}</h2>
            <label for="f-email">Email</label>
            <input id="f-email" value=${form.email} onInput=${set('email')} placeholder="cuenta@outlook.com" />
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div>
                    <label for="f-pass">Contraseña</label>
                    <input id="f-pass" type="password" value=${form.password} onInput=${set('password')}
                        placeholder=${secretPlaceholder(initial?.hasPassword)} />
                </div>
                <div>
                    <label for="f-totp">Secreto TOTP</label>
                    <input id="f-totp" type="password" value=${form.totpSecret} onInput=${set('totpSecret')}
                        placeholder=${secretPlaceholder(initial?.hasTotp)} />
                </div>
            </div>
            <label for="f-rec">Email de recuperación</label>
            <input id="f-rec" value=${form.recoveryEmail} onInput=${set('recoveryEmail')} />
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div><label for="f-geo">Región</label><input id="f-geo" value=${form.geoLocale} onInput=${set('geoLocale')} placeholder="auto" /></div>
                <div><label for="f-lang">Idioma</label><input id="f-lang" value=${form.langCode} onInput=${set('langCode')} placeholder="es" /></div>
            </div>
            <label>Proxy (opcional)</label>
            <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
                <input value=${form.proxyUrl} onInput=${set('proxyUrl')} placeholder="http://proxy.ejemplo.com" aria-label="Proxy URL" />
                <input value=${form.proxyPort} onInput=${set('proxyPort')} placeholder="8080" aria-label="Proxy puerto" />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px">
                <input value=${form.proxyUsername} onInput=${set('proxyUsername')} placeholder="usuario" aria-label="Proxy usuario" />
                <input type="password" value=${form.proxyPassword} onInput=${set('proxyPassword')}
                    placeholder=${secretPlaceholder(initial?.proxy?.hasPassword)} aria-label="Proxy contraseña" />
            </div>
            <p style="font-size:11.5px;color:var(--ink-3);margin:14px 0 0;border-top:1px solid var(--border);padding-top:10px">
                Se reescribe .env de forma atómica con copia previa en .env.bak. Los secretos nunca se vuelven a mostrar.
            </p>
            <div class="savebar">
                <button class="btn" onClick=${onClose}>Cancelar</button>
                <button class="btn primary" disabled=${saving} onClick=${save}>${isEdit ? 'Guardar cambios' : 'Guardar cuenta'}</button>
            </div>
        </div>
    </div>`
}

export function Cuentas({ state }) {
    const [accounts, setAccounts] = useState(null)
    const [sessions, setSessions] = useState([])
    const [query, setQuery] = useState('')
    const [loadFailed, setLoadFailed] = useState(false)
    const [modal, setModal] = useState(null)
    const busy = ['starting', 'running', 'stopping'].includes(state?.status?.state)

    const load = () => {
        setLoadFailed(false)
        api('/accounts').then(d => setAccounts(d.accounts ?? [])).catch(() => {
            setAccounts([])
            setLoadFailed(true)
            toast('No se pudieron cargar las cuentas', 'err')
        })
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

    const openNew = () => setModal('new')

    const openEdit = async a => {
        try {
            setModal(await api(`/accounts/${a.index}`))
        } catch {
            toast('No se pudo cargar el detalle de la cuenta', 'err')
        }
    }

    const removeAccount = async a => {
        if (!confirm(`¿Eliminar la cuenta ${a.email} de .env? Esta acción reescribe el fichero (copia previa en .env.bak).`)) return
        try {
            await api(`/accounts/${a.index}?email=${encodeURIComponent(a.email)}`, { method: 'DELETE' })
            toast('Cuenta eliminada')
            load()
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) toast('Escritura desactivada: pon API_ALLOW_ACCOUNT_WRITE=true en .env y reinicia la API', 'err')
            else if (err instanceof ApiError && err.status === 409 && err.body?.code === 'ACCOUNT_MISMATCH') {
                toast('La lista estaba desactualizada; recarga e inténtalo de nuevo', 'err')
                load()
            }
            else if (err instanceof ApiError && err.status === 409) toast('No se puede eliminar con el bot en ejecución', 'err')
            else toast('Error al eliminar la cuenta', 'err')
        }
    }

    const list = (accounts ?? []).filter(a => a.email.toLowerCase().includes(query.trim().toLowerCase()))

    return html`<section class="view">
        <h1>Cuentas</h1>
        <p class="sub">${accounts ? `${accounts.length} cuentas configuradas en .env` : 'Cargando…'} · los secretos nunca se muestran.</p>
        <div class="card" style="padding:16px 6px 6px">
            <div class="toolbar" style="padding:0 10px">
                <input placeholder="Buscar cuenta…" aria-label="Buscar cuenta"
                    value=${query} onInput=${e => setQuery(e.target.value)} />
                <span style="flex:1"></span>
                <button class="btn sm" onClick=${load}>↻ Recargar</button>
                <button class="btn primary" onClick=${openNew}>+ Añadir cuenta</button>
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
                            <button class="icon-btn" title="Editar cuenta" disabled=${busy} onClick=${() => openEdit(a)}>✎</button>
                            <button class="icon-btn danger" title="Eliminar cuenta de .env" disabled=${busy} onClick=${() => removeAccount(a)}>✕</button>
                            <button class="icon-btn danger" title="Borrar sesiones guardadas" disabled=${busy}
                                onClick=${() => deleteSessions(a)}>🗑</button>
                        </td>
                    </tr>`
                })}
                </tbody>
            </table>
            ${accounts && accounts.length === 0 && !loadFailed && html`<p style="padding:0 10px;color:var(--ink-3)">
                No hay cuentas en .env. Añade bloques ACCOUNT_1_* siguiendo env.example.</p>`}
            ${loadFailed && html`<p style="padding:0 10px;color:var(--ink-3)">
                No se pudieron cargar las cuentas. Comprueba la conexión con la API y pulsa Recargar.</p>`}
        </div>
        ${modal && html`<${AccountModal}
            initial=${modal === 'new' ? null : modal}
            onClose=${() => setModal(null)}
            onSaved=${load} />`}
    </section>`
}
