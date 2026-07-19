import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createUiHandler } from './staticServer.js'

function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ui-'))
    fs.writeFileSync(path.join(root, 'index.html'), '<title>Rewards Control</title>')
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{color:red}')
    fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'secret')
    return root
}

async function withServer(fn) {
    const root = makeRoot()
    const serveUi = createUiHandler({ root })
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const pathname = url.pathname.replace(/\/+$/, '') || '/'
        if (serveUi(req, res, pathname)) return
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
        await fn(base)
    } finally {
        server.close()
        fs.rmSync(root, { recursive: true, force: true })
    }
}

test('GET /ui serves index.html without auth', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui`)
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type'), /text\/html/)
        assert.match(await res.text(), /Rewards Control/)
    })
})

test('GET /ui/ (trailing slash, normalized upstream) serves index.html', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui/`)
        assert.equal(res.status, 200)
        assert.match(await res.text(), /Rewards Control/)
    })
})

test('GET /ui/styles.css serves css MIME', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui/styles.css`)
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type'), /text\/css/)
    })
})

test('GET /ui/missing.js returns 404 JSON', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui/missing.js`)
        assert.equal(res.status, 404)
    })
})

test('encoded path traversal is blocked', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui/%2e%2e/outside.txt`)
        assert.equal(res.status, 404)
    })
})

test('POST /ui is rejected with 405', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/ui`, { method: 'POST' })
        assert.equal(res.status, 405)
    })
})

test('non-/ui paths are not handled', async () => {
    await withServer(async base => {
        const res = await fetch(`${base}/status`)
        assert.equal(res.status, 401)
    })
})
