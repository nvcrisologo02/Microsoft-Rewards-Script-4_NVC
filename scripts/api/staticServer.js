import fs from 'node:fs'
import path from 'node:path'

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
}

function sendJsonError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: message }))
}

/**
 * Static handler for the dashboard SPA under the /ui prefix.
 * Returns true when it handled the request (even for errors inside /ui),
 * false when the path is not a /ui path so normal routing continues.
 * Intentionally auth-free: the SPA shell contains no secrets and every
 * data endpoint it calls still requires the API token.
 */
export function createUiHandler({ root }) {
    const absRoot = path.resolve(root)

    return function serveUi(req, res, pathname) {
        if (pathname !== '/ui' && !pathname.startsWith('/ui/')) return false

        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD') {
            sendJsonError(res, 405, 'Method not allowed')
            return true
        }

        let rel
        try {
            rel = decodeURIComponent(pathname.slice('/ui'.length)).replace(/^\/+/, '')
        } catch {
            sendJsonError(res, 400, 'Bad request path')
            return true
        }
        if (rel === '') rel = 'index.html'

        const full = path.resolve(absRoot, rel)
        if (full !== absRoot && !full.startsWith(absRoot + path.sep)) {
            sendJsonError(res, 404, 'Not found')
            return true
        }

        let stat
        try {
            stat = fs.statSync(full)
        } catch {
            sendJsonError(res, 404, 'Not found')
            return true
        }
        if (!stat.isFile()) {
            sendJsonError(res, 404, 'Not found')
            return true
        }

        const ext = path.extname(full).toLowerCase()
        const type = MIME[ext] ?? 'application/octet-stream'
        const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=300'
        res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': stat.size,
            'Cache-Control': cacheControl
        })
        if (method === 'HEAD') {
            res.end()
            return true
        }
        fs.createReadStream(full).pipe(res)
        return true
    }
}
