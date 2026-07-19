import { getToken } from './api.js'

const MAX_LOGS = 500

const state = {
    connected: false,
    status: null,
    logs: []
}

const subs = new Set()

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

function open() {
    const token = getToken()
    const qs = new URLSearchParams({ replay: '200' })
    if (token) qs.set('token', token)
    es = new EventSource(`/events?${qs}`)

    es.addEventListener('hello', e => {
        state.connected = true
        retryMs = 1000
        state.status = JSON.parse(e.data)
        emit()
    })
    es.addEventListener('status', e => {
        state.status = JSON.parse(e.data)
        emit()
    })
    es.addEventListener('log', e => {
        state.logs.push(JSON.parse(e.data))
        if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS)
        emit()
    })
    es.onerror = () => {
        state.connected = false
        emit()
        es.close()
        es = null
        retryTimer = setTimeout(open, retryMs)
        retryMs = Math.min(retryMs * 2, 30000)
    }
}

export function connect() {
    if (started) return
    started = true
    open()
}

export function disconnect() {
    started = false
    if (retryTimer) clearTimeout(retryTimer)
    if (es) es.close()
    es = null
    state.connected = false
    emit()
}
