const KEY = 'rc.apiToken'

export function getToken() {
    return localStorage.getItem(KEY) ?? ''
}
export function setToken(t) {
    localStorage.setItem(KEY, t)
}
export function clearToken() {
    localStorage.removeItem(KEY)
}

export class ApiError extends Error {
    constructor(status, body) {
        super(body?.error ?? `HTTP ${status}`)
        this.status = status
        this.body = body
    }
}

export async function api(path, { method = 'GET', body } = {}) {
    const headers = {}
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    })
    let data = null
    try {
        data = await res.json()
    } catch { /* non-JSON response (e.g. empty) */ }
    if (!res.ok) throw new ApiError(res.status, data)
    return data
}
