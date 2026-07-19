import { html, render, useState, useEffect } from './vendor/htm-preact-standalone.module.js'
import { api, ApiError, setToken, clearToken } from './api.js'
import { connect, subscribe, disconnect, getState } from './store.js'
import { Placeholder } from './views/placeholder.js'
import { Resumen } from './views/resumen.js'
import { Cuentas } from './views/cuentas.js'
import { Ejecuciones } from './views/ejecuciones.js'
import { Logs } from './views/logs.js'
import { Programacion } from './views/programacion.js'
import { Configuracion } from './views/configuracion.js'

const VIEWS = [
    { id: 'resumen', label: 'Resumen', component: Resumen },
    { id: 'cuentas', label: 'Cuentas', component: Cuentas },
    { id: 'runs', label: 'Ejecuciones', component: Ejecuciones },
    { id: 'logs', label: 'Logs', component: Logs },
    { id: 'config', label: 'Configuración', component: Configuracion },
    { id: 'schedule', label: 'Programación', component: Programacion },
    { id: 'diag', label: 'Diagnósticos', component: props => html`<${Placeholder} title="Diagnósticos" phase="Fase 3" ...${props} />` }
]

function Sidebar({ current, onNav }) {
    return html`<aside class="side">
        <div class="logo">
            <div class="mark">RC</div>
            <div><b>Rewards Control</b><small>${location.host}</small></div>
        </div>
        <nav class="nav">
            ${VIEWS.map(v => html`<button key=${v.id} class=${current === v.id ? 'on' : ''}
                onClick=${() => onNav(v.id)}><span>${v.label}</span></button>`)}
        </nav>
        <div class="foot">Fase 1</div>
    </aside>`
}

const PILL = {
    running: ['run', 'EN EJECUCIÓN'],
    starting: ['run', 'ARRANCANDO'],
    stopping: ['stopping', 'DETENIENDO'],
    idle: ['', 'INACTIVO']
}

function Topbar({ state, onLogout }) {
    const st = state?.status?.state ?? 'idle'
    const [cls, label] = state?.connected ? (PILL[st] ?? PILL.idle) : ['off', 'SIN CONEXIÓN']
    const live = state?.status?.run?.live
    const collected = state?.status?.run?.collected ?? 0
    return html`<header class="top">
        <span class=${`pill ${cls}`}><span class="dot"></span>${label}</span>
        ${live?.currentAccount && html`<span style="color:var(--ink-3);font-size:12.5px">
            <span class="em" style="color:var(--ink-2)">${live.currentAccount}</span></span>`}
        <div class="pts">
            <b>${live?.currentBalance != null ? live.currentBalance.toLocaleString('es') : '—'} pts</b>
            <small>${collected > 0 ? `+${collected.toLocaleString('es')} en esta sesión` : ' '}</small>
        </div>
        <button class="btn sm" onClick=${onLogout}>Salir</button>
    </header>`
}

function Login({ onOk }) {
    const [value, setValue] = useState('')
    const [error, setError] = useState('')
    const submit = async e => {
        e.preventDefault()
        setToken(value.trim())
        try {
            await api('/health')
            onOk()
        } catch (err) {
            clearToken()
            setError(err instanceof ApiError && err.status === 401
                ? 'Token incorrecto.'
                : 'No se puede conectar con la API.')
        }
    }
    return html`<div class="login"><form class="modal" onSubmit=${submit}>
        <h2>Rewards Control</h2>
        <label for="tok">Token de la API</label>
        <input id="tok" type="password" autofocus value=${value}
            onInput=${e => setValue(e.target.value)} placeholder="API_TOKEN" />
        ${error && html`<div class="err">${error}</div>`}
        <div class="savebar"><button class="btn primary" type="submit">Entrar</button></div>
    </form></div>`
}

function App() {
    // authed: null = probing, false = needs token, true = in
    const [authed, setAuthed] = useState(null)
    const [current, setCurrent] = useState('resumen')
    const [, force] = useState(0)

    useEffect(() => {
        api('/health')
            .then(() => setAuthed(true))
            .catch(err => setAuthed(err instanceof ApiError && err.status === 401 ? false : true))
    }, [])

    useEffect(() => {
        if (authed !== true) return
        connect({ onAuthLost: () => { clearToken(); setAuthed(false) } })
        const unsub = subscribe(() => force(n => n + 1))
        return () => {
            unsub()
            disconnect()
        }
    }, [authed])

    const onLogout = () => {
        clearToken()
        disconnect()
        setAuthed(false)
    }

    if (authed === null) return html`<div class="login"><div style="color:var(--ink-3)">Conectando…</div></div>`
    if (authed === false) return html`<${Login} onOk=${() => setAuthed(true)} />`

    const View = VIEWS.find(v => v.id === current).component
    const st = getState()
    return html`<div class="app">
        <${Sidebar} current=${current} onNav=${setCurrent} />
        <${Topbar} state=${st} onLogout=${onLogout} />
        <main class="main"><${View} state=${st} /></main>
    </div>`
}

render(html`<${App} />`, document.getElementById('root'))
