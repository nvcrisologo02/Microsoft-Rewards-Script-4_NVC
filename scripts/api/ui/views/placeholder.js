import { html } from '../vendor/htm-preact-standalone.module.js'

export function Placeholder({ title, phase }) {
    return html`<section class="view">
        <h1>${title}</h1>
        <p class="sub">Disponible en la ${phase} del dashboard.</p>
        <div class="card" style="color:var(--ink-3)">
            Esta sección aún no está implementada. La API ya expone los datos;
            la vista llegará en la ${phase}.
        </div>
    </section>`
}
