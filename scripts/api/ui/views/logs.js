import { html, useEffect, useMemo, useRef, useState } from '../vendor/htm-preact-standalone.module.js'

const LEVELS = ['todos', 'info', 'warn', 'error']
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 }

function levelClass(level) {
    if (level === 'error') return 'lg-e'
    if (level === 'warn') return 'lg-w'
    return 'lg-i'
}

export function Logs({ state }) {
    const [level, setLevel] = useState('todos')
    const [query, setQuery] = useState('')
    const [paused, setPaused] = useState(false)
    const frozen = useRef([])
    const boxRef = useRef(null)

    const source = paused ? frozen.current : (state?.logs ?? [])
    const lastId = source.length ? source[source.length - 1].id : 0

    const entries = useMemo(() => {
        const min = level === 'todos' ? 0 : LEVEL_RANK[level]
        const q = query.trim().toLowerCase()
        return source.filter(e => {
            if ((LEVEL_RANK[e.level] ?? 1) < min) return false
            if (!q) return true
            return [e.user, e.title, e.message, e.platform]
                .some(f => typeof f === 'string' && f.toLowerCase().includes(q))
        })
    }, [source, lastId, level, query])

    useEffect(() => {
        const box = boxRef.current
        if (box && !paused) box.scrollTop = box.scrollHeight
    }, [entries, paused])

    const togglePause = () => {
        if (!paused) frozen.current = [...(state?.logs ?? [])]
        setPaused(!paused)
    }

    const download = () => {
        const text = (state?.logs ?? []).map(e => e.raw ?? e.message).join('\n')
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
        a.download = `rewards-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`
        a.click()
        URL.revokeObjectURL(a.href)
    }

    return html`<section class="view">
        <h1>Logs</h1>
        <p class="sub">Stream en vivo por SSE · búfer local de 500 entradas.</p>
        <div class="toolbar">
            ${LEVELS.map(l => html`<button key=${l} class=${'fchip' + (level === l ? ' on' : '')}
                onClick=${() => setLevel(l)}>${l[0].toUpperCase() + l.slice(1)}</button>`)}
            <input placeholder="Filtrar… (cuenta, título, texto)" aria-label="Filtrar logs"
                value=${query} onInput=${e => setQuery(e.target.value)} />
            <button class="btn sm" onClick=${togglePause}>${paused ? '▶ Reanudar' : '⏸ Pausar'}</button>
            <button class="btn sm" onClick=${download}>↓ Descargar</button>
        </div>
        <div class="console" ref=${boxRef}>
            ${entries.length === 0
                ? html`<span style="color:var(--ink-3)">Sin entradas todavía. Inicia un run para ver logs.</span>`
                : entries.map(e => html`<div key=${e.id}><span class="lg-t">[${e.ts ?? ''}]</span>${' '}
                    ${e.user && html`<span class="lg-u">[${e.user}]</span> `}
                    <span class=${levelClass(e.level)}>[${e.platform ?? ''}${e.platform && e.title ? ' ' : ''}${e.title ?? ''}]</span>${' '}
                    <span class="lg-m">${e.message}</span></div>`)}
        </div>
    </section>`
}
