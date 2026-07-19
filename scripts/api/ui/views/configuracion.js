import { html, useEffect, useMemo, useState } from '../vendor/htm-preact-standalone.module.js'
import { api, ApiError } from '../api.js'
import { toast } from '../toast.js'

const REDACTED = '***REDACTED***'

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

function setAt(obj, pathArr, value) {
    let node = obj
    for (const key of pathArr.slice(0, -1)) node = node[key]
    node[pathArr[pathArr.length - 1]] = value
}

// List of {path: string[], from, to} for primitives/arrays that differ.
function diffConfig(base, draft, prefix = []) {
    const out = []
    const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(draft ?? {})])
    for (const key of keys) {
        const a = base?.[key]
        const b = draft?.[key]
        const p = [...prefix, key]
        const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
        if (bothObjects) {
            out.push(...diffConfig(a, b, p))
        } else if (JSON.stringify(a) !== JSON.stringify(b)) {
            out.push({ path: p, from: a, to: b })
        }
    }
    return out
}

// Nested object containing only the changed paths (skipping redacted values).
function buildPatch(diffs) {
    const patch = {}
    for (const d of diffs) {
        if (d.to === REDACTED) continue
        let node = patch
        for (const key of d.path.slice(0, -1)) {
            node[key] = node[key] ?? {}
            node = node[key]
        }
        node[d.path[d.path.length - 1]] = d.to
    }
    return patch
}

function Field({ path, value, onChange }) {
    const name = path[path.length - 1]
    const id = `cfg-${path.join('-')}`
    if (typeof value === 'boolean') {
        return html`<div class="frow2">
            <label for=${id}>${name}</label>
            <input id=${id} type="checkbox" checked=${value} onInput=${e => onChange(path, e.target.checked)} />
        </div>`
    }
    if (typeof value === 'number') {
        return html`<div class="frow2">
            <label for=${id}>${name}</label>
            <input id=${id} type="number" value=${value} style="width:110px"
                onInput=${e => onChange(path, e.target.value === '' ? 0 : Number(e.target.value))} />
        </div>`
    }
    if (typeof value === 'string') {
        if (value === REDACTED) {
            return html`<div class="frow2"><label>${name}</label>
                <span style="font:12px var(--mono);color:var(--ink-3)">oculto · edítalo en config.json</span></div>`
        }
        return html`<div class="frow2">
            <label for=${id}>${name}</label>
            <input id=${id} value=${value} onInput=${e => onChange(path, e.target.value)} />
        </div>`
    }
    if (Array.isArray(value)) {
        return html`<div class="frow2"><label>${name}</label>
            <span style="font-size:12px;color:var(--ink-3)">lista · editar en la pestaña JSON</span></div>`
    }
    return null
}

function Section({ path, value, onChange, depth = 0 }) {
    const entries = Object.entries(value ?? {})
    const primitives = entries.filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v))
    const objects = entries.filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
    return html`<div>
        ${primitives.map(([k, v]) => html`<${Field} key=${k} path=${[...path, k]} value=${v} onChange=${onChange} />`)}
        ${objects.map(([k, v]) => html`<div key=${k} style=${`margin:${depth ? 8 : 14}px 0 0 ${depth * 14}px`}>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3);margin:10px 0 4px">${k}</div>
            <${Section} path=${[...path, k]} value=${v} onChange=${onChange} depth=${depth + 1} />
        </div>`)}
    </div>`
}

export function Configuracion() {
    const [baseline, setBaseline] = useState(null)
    const [draft, setDraft] = useState(null)
    const [group, setGroup] = useState(null)
    const [tab, setTab] = useState('form')
    const [jsonText, setJsonText] = useState('')
    const [showDiff, setShowDiff] = useState(false)
    const [saveErrors, setSaveErrors] = useState([])
    const [saving, setSaving] = useState(false)

    const load = () => {
        api('/config').then(d => {
            setBaseline(d.config)
            setDraft(clone(d.config))
            setJsonText(JSON.stringify(d.config, null, 2))
        }).catch(() => toast('No se pudo cargar config.json', 'err'))
    }
    useEffect(load, [])

    const groups = useMemo(() => {
        if (!draft) return []
        const objectKeys = Object.keys(draft).filter(k => draft[k] && typeof draft[k] === 'object' && !Array.isArray(draft[k]))
        return ['general', ...objectKeys]
    }, [draft])
    const activeGroup = group ?? groups[0]

    if (!baseline || !draft) {
        return html`<section class="view"><h1>Configuración</h1><p class="sub">Cargando…</p></section>`
    }

    const diffs = diffConfig(baseline, draft)
    const onChange = (path, value) => setDraft(d => {
        const next = clone(d)
        setAt(next, path, value)
        return next
    })

    const applyJson = () => {
        try {
            const parsed = JSON.parse(jsonText)
            setDraft(parsed)
            setTab('form')
            toast('JSON aplicado al borrador (sin guardar todavía)')
        } catch (err) {
            toast(`JSON no válido: ${err.message}`, 'err')
        }
    }

    const save = async () => {
        const patch = buildPatch(diffs)
        if (Object.keys(patch).length === 0) {
            toast('No hay cambios que guardar')
            return
        }
        setSaving(true)
        setSaveErrors([])
        try {
            await api('/config', { method: 'PATCH', body: patch })
            toast('Configuración guardada · se aplica en el próximo run')
            load()
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) toast('Escritura desactivada: pon API_ALLOW_CONFIG_WRITE=true y reinicia la API', 'err')
            else if (err instanceof ApiError && err.status === 422) {
                setSaveErrors(err.body?.errors ?? [err.message])
                toast('La validación rechazó los cambios', 'err')
            } else toast(err instanceof ApiError ? err.message : 'Sin conexión con la API', 'err')
        } finally {
            setSaving(false)
        }
    }

    const generalValue = Object.fromEntries(Object.entries(draft).filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v)))

    return html`<section class="view">
        <h1>Configuración</h1>
        <p class="sub">Edición validada de config.json · los cambios se aplican en el próximo run.</p>
        <div class="toolbar">
            <button class=${'fchip' + (tab === 'form' ? ' on' : '')} onClick=${() => setTab('form')}>Formulario</button>
            <button class=${'fchip' + (tab === 'json' ? ' on' : '')} onClick=${() => {
                setJsonText(JSON.stringify(draft, null, 2))
                setTab('json')
            }}>JSON avanzado</button>
            <span style="flex:1"></span>
            <span style="font-size:12px;color:var(--ink-3)">${diffs.length ? `${diffs.length} cambio(s) sin guardar` : 'sin cambios'}</span>
        </div>
        ${tab === 'form' ? html`
            <div class="cfg2">
                <div class="cfg-nav2">
                    ${groups.map(g => html`<button key=${g} class=${activeGroup === g ? 'on' : ''}
                        onClick=${() => setGroup(g)}>${g}</button>`)}
                </div>
                <div class="card">
                    ${activeGroup === 'general'
                        ? html`<${Section} path=${[]} value=${generalValue} onChange=${onChange} />`
                        : html`<${Section} path=${[activeGroup]} value=${draft[activeGroup]} onChange=${onChange} />`}
                </div>
            </div>`
        : html`
            <div class="card">
                <textarea style="width:100%;box-sizing:border-box;min-height:50vh;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--ink);padding:12px;font:12.5px var(--mono)"
                    value=${jsonText} onInput=${e => setJsonText(e.target.value)} aria-label="config.json"></textarea>
                <div class="savebar"><button class="btn" onClick=${applyJson}>Aplicar JSON al borrador</button></div>
            </div>`}
        ${saveErrors.length > 0 && html`<div class="card" style="margin-top:12px;border-color:rgba(239,68,68,.4)">
            <b style="font-size:13px;color:#ff8b8b">Errores de validación</b>
            <ul class="next">${saveErrors.map((e, i) => html`<li key=${i}><span style="color:#ff8b8b">${e}</span></li>`)}</ul>
        </div>`}
        <div class="savebar">
            <button class="btn" disabled=${diffs.length === 0} onClick=${() => setShowDiff(true)}>Ver diff</button>
            <button class="btn" disabled=${diffs.length === 0} onClick=${() => { setDraft(clone(baseline)); setSaveErrors([]) }}>Descartar</button>
            <button class="btn primary" disabled=${diffs.length === 0 || saving} onClick=${save}>Guardar cambios</button>
        </div>
        ${showDiff && html`<div class="overlay" onClick=${e => { if (e.target === e.currentTarget) setShowDiff(false) }}>
            <div class="modal" role="dialog" aria-label="Cambios pendientes" style="width:min(560px,92vw)">
                <h2>Cambios pendientes</h2>
                <ul class="next">${diffs.map((d, i) => html`<li key=${i}>
                    <span class="em">${d.path.join('.')}</span>
                    <b>${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}</b></li>`)}</ul>
                <div class="savebar"><button class="btn" onClick=${() => setShowDiff(false)}>Cerrar</button></div>
            </div>
        </div>`}
    </section>`
}
