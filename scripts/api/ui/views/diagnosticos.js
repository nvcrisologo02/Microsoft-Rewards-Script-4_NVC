import { html, useEffect, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, authedUrl } from '../api.js'
import { toast } from '../toast.js'

function fmtDate(iso) {
    if (!iso) return ''
    return new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function Diagnosticos() {
    const [entries, setEntries] = useState(null)

    useEffect(() => {
        api('/diagnostics')
            .then(d => setEntries(d.entries ?? []))
            .catch(() => { setEntries([]); toast('No se pudieron cargar los diagnósticos', 'err') })
    }, [])

    if (entries === null) {
        return html`<section class="view"><h1>Diagnósticos</h1><p class="sub">Cargando…</p></section>`
    }

    return html`<section class="view">
        <h1>Diagnósticos</h1>
        <p class="sub">Capturas automáticas de errores · ${entries.length} captura(s).</p>
        ${entries.length === 0 && html`<div class="card" style="color:var(--ink-3)">
            No hay capturas de error. Se crean automáticamente cuando un run falla con errorDiagnostics activado.</div>`}
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">
            ${entries.map(e => html`<div key=${e.name} class="card">
                ${e.hasScreenshot
                    ? html`<a href=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/screenshot.png`)} target="_blank" rel="noopener">
                        <img src=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/screenshot.png`)} alt=${`Captura de ${e.name}`}
                            loading="lazy" style="width:100%;height:130px;object-fit:cover;object-position:top;border-radius:8px;border:1px solid var(--border);margin-bottom:10px" /></a>`
                    : html`<div style="height:130px;border-radius:8px;border:1px solid var(--border);margin-bottom:10px;display:grid;place-items:center;color:var(--ink-3);font-size:12px">sin captura</div>`}
                <div class="em" style="font-size:11.5px;color:var(--ink-3);margin-bottom:4px">${fmtDate(e.createdAt)}</div>
                ${e.error && html`<div style="font-size:12.5px;color:#ff8b8b;margin-bottom:10px;max-height:54px;overflow:hidden">${String(e.error).slice(0, 160)}</div>`}
                <div class="row" style="flex-wrap:wrap">
                    ${e.hasScreenshot && html`<a class="btn sm" style="text-decoration:none" target="_blank" rel="noopener"
                        href=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/screenshot.png`)}>Captura</a>`}
                    ${e.hasError && html`<a class="btn sm" style="text-decoration:none" target="_blank" rel="noopener"
                        href=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/error.txt`)}>error.txt</a>`}
                    ${e.hasHtml && html`<a class="btn sm" style="text-decoration:none" download
                        href=${authedUrl(`/diagnostics/${encodeURIComponent(e.name)}/dump.html`)}>HTML</a>`}
                </div>
            </div>`)}
        </div>
    </section>`
}
