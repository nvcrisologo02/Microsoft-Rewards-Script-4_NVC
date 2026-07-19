import { html, useRef, useState } from './vendor/htm-preact-standalone.module.js'

const ACCENT = '#3b82f6'
const GRID = '#232834'

function niceMax(value) {
    if (value <= 0) return 10
    const magnitude = 10 ** Math.floor(Math.log10(value))
    for (const m of [1, 2, 5, 10]) {
        if (value <= m * magnitude) return m * magnitude
    }
    return 10 * magnitude
}

export function AreaChart({ data, height = 220, ariaLabel }) {
    const [hover, setHover] = useState(null)
    const svgRef = useRef(null)
    if (!data || data.length === 0 || data.every(d => d.points === 0)) {
        return html`<div style="color:var(--ink-3);font-size:13px;padding:24px 0;text-align:center">
            Sin datos todavía. Completa algún run para ver la gráfica.</div>`
    }
    const w = 800
    const padL = 46
    const padR = 10
    const padT = 10
    const padB = 22
    const max = niceMax(Math.max(...data.map(d => d.points)))
    const X = i => padL + i * (w - padL - padR) / Math.max(1, data.length - 1)
    const Y = v => padT + (1 - v / max) * (height - padT - padB)
    const points = data.map((d, i) => `${X(i)},${Y(d.points)}`).join(' ')
    const area = `M${X(0)},${Y(data[0].points)} ` + data.map((d, i) => `L${X(i)},${Y(d.points)}`).join(' ')
        + ` L${X(data.length - 1)},${height - padB} L${X(0)},${height - padB} Z`
    const gridLines = [0.5, 1].map(f => Math.round(max * f))
    const labelEvery = Math.max(1, Math.round(data.length / 4))

    const onMove = e => {
        const rect = svgRef.current.getBoundingClientRect()
        const x = (e.clientX - rect.left) * (w / rect.width)
        const i = Math.max(0, Math.min(data.length - 1,
            Math.round((x - padL) / ((w - padL - padR) / Math.max(1, data.length - 1)))))
        setHover(i)
    }

    return html`<div style="position:relative">
        <svg ref=${svgRef} viewBox=${`0 0 ${w} ${height}`} style="width:100%;display:block"
            role="img" aria-label=${ariaLabel}
            onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
            ${gridLines.map(v => html`<g key=${v}>
                <line x1=${padL} y1=${Y(v)} x2=${w - padR} y2=${Y(v)} stroke=${GRID} stroke-width="1" />
                <text x=${padL - 8} y=${Y(v) + 3.5} text-anchor="end"
                    style="font:10.5px var(--mono);fill:var(--ink-3)">${v.toLocaleString('es')}</text>
            </g>`)}
            ${data.map((d, i) => i % labelEvery === 0 ? html`<text key=${d.key} x=${X(i)} y=${height - 6}
                text-anchor="middle" style="font:10.5px var(--mono);fill:var(--ink-3)">${d.label}</text>` : null)}
            <path d=${area} fill=${ACCENT} opacity="0.14" />
            <polyline points=${points} fill="none" stroke=${ACCENT} stroke-width="2" stroke-linejoin="round" />
            ${hover != null && html`
                <line x1=${X(hover)} y1=${padT} x2=${X(hover)} y2=${height - padB}
                    stroke="#39404f" stroke-dasharray="3 3" />
                <circle cx=${X(hover)} cy=${Y(data[hover].points)} r="4" fill=${ACCENT}
                    stroke="var(--surface)" stroke-width="2" />`}
        </svg>
        ${hover != null && html`<div style=${`position:absolute;pointer-events:none;left:${X(hover) / w * 100}%;top:0;transform:translate(-50%,-4px);background:#0b0d11;border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11.5px var(--mono);white-space:nowrap`}>
            ${data[hover].label} · <b style="color:#8ab4ff">+${data[hover].points.toLocaleString('es')} pts</b>
        </div>`}
    </div>`
}

export function BarList({ items, ariaLabel }) {
    if (!items || items.length === 0) {
        return html`<div style="color:var(--ink-3);font-size:13px;padding:12px 0">Sin datos todavía.</div>`
    }
    const max = Math.max(...items.map(i => i.points), 1)
    return html`<div role="img" aria-label=${ariaLabel} style="display:flex;flex-direction:column;gap:8px">
        ${items.map(item => html`<div key=${item.email} class="row" style="gap:10px">
            <span class="em" style="flex:0 0 220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.email}</span>
            <div style="flex:1;height:10px;border-radius:99px;background:var(--surface-2);overflow:hidden">
                <div style=${`height:100%;width:${Math.max(2, item.points / max * 100)}%;background:${ACCENT};border-radius:99px`}></div>
            </div>
            <span class="num" style="flex:0 0 90px;font-size:12.5px">${item.points.toLocaleString('es')}
                ${item.failures > 0 ? html`<span style="color:#ff8b8b"> ·${item.failures}✕</span>` : ''}</span>
        </div>`)}
    </div>`
}
