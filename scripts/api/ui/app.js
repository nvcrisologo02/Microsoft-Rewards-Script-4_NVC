import { html, render, useState } from './vendor/htm-preact-standalone.module.js'
import { Placeholder } from './views/placeholder.js'

const VIEWS = [
    { id: 'resumen', label: 'Resumen', component: props => html`<${Placeholder} title="Resumen" phase="Fase 1 (Task 5)" ...${props} />` },
    { id: 'cuentas', label: 'Cuentas', component: props => html`<${Placeholder} title="Cuentas" phase="Fase 1 (Task 7)" ...${props} />` },
    { id: 'runs', label: 'Ejecuciones', component: props => html`<${Placeholder} title="Ejecuciones" phase="Fase 3" ...${props} />` },
    { id: 'logs', label: 'Logs', component: props => html`<${Placeholder} title="Logs" phase="Fase 1 (Task 6)" ...${props} />` },
    { id: 'config', label: 'Configuración', component: props => html`<${Placeholder} title="Configuración" phase="Fase 2" ...${props} />` },
    { id: 'schedule', label: 'Programación', component: props => html`<${Placeholder} title="Programación" phase="Fase 2" ...${props} />` },
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

function Topbar() {
    return html`<header class="top">
        <span class="pill"><span class="dot"></span>SIN CONEXIÓN</span>
        <div class="pts"><b>— pts</b><small> </small></div>
    </header>`
}

function App() {
    const [current, setCurrent] = useState('resumen')
    const View = VIEWS.find(v => v.id === current).component
    return html`<div class="app">
        <${Sidebar} current=${current} onNav=${setCurrent} />
        <${Topbar} />
        <main class="main"><${View} state=${null} /></main>
    </div>`
}

render(html`<${App} />`, document.getElementById('root'))
