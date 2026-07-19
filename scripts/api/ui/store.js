import { getToken } from './api.js'

const MAX_LOGS = 500

const state = {
    connected: false,
    status: null,
    logs: []
}

const subs = new Set()
let lastLogId = 0

export function getState() {
    return state
}

export function subscribe(fn) {
    subs.add(fn)
    return () => subs.delete(fn)
}

function emit() {
    for (const fn of subs) fn(state)
}

let es = null
let retryMs = 1000
let retryTimer = null
let started = false
let authLostCb = null
let probing = false

function open() {
    const token = getToken()
    const qs = new URLSearchParams({ replay: '200' })
    if (token) qs.set('token', token)
    es = new EventSource(`/events?${qs}`)

    es.addEventListener('hello', e => {
        state.connected = true
        retryMs = 1000
        state.status = JSON.parse(e.data)
        if ((state.status.latestLogId ?? 0) < lastLogId) {
            lastLogId = 0
            state.logs = []
        }
        emit()
    })
    es.addEventListener('status', e => {
        state.status = JSON.parse(e.data)
        emit()
    })
    es.addEventListener('log', e => {
        const entry = JSON.parse(e.data)
        if (typeof entry.id === 'number') {
            if (entry.id <= lastLogId) return
            lastLogId = entry.id
        }
        state.logs.push(entry)
        if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS)
        emit()
    })
    es.onerror = () => {
        state.connected = false
        emit()
        es.close()
        es = null
        if (probing) return
        probing = true
        const token = getToken()
        const headers = token ? { Authorization: `Bearer ${token}` } : {}
        fetch('/health', { headers }).then(res => {
            probing = false
            if (!started) return
            if (res.status === 401) {
                started = false
                authLostCb?.()
                return
            }
            retryTimer = setTimeout(open, retryMs)
            retryMs = Math.min(retryMs * 2, 30000)
        }).catch(() => {
            probing = false
            if (!started) return
            retryTimer = setTimeout(open, retryMs)
            retryMs = Math.min(retryMs * 2, 30000)
        })
    }
}

export function connect({ onAuthLost } = {}) {
    if (started) return
    started = true
    authLostCb = onAuthLost ?? null
    open()
}

export function disconnect() {
    started = false
    authLostCb = null
    if (retryTimer) clearTimeout(retryTimer)
    if (es) es.close()
    es = null
    state.connected = false
    emit()
}
