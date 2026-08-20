#!/usr/bin/env node
/**
 * Test harness for the browser tracker.
 *
 * Deliberately dumb: it serves one page, serves the built tracker, and records
 * whatever gets POSTed to it. It does NOT mount `createHandler` — the server
 * side already has unit coverage, and routing the e2e suite through it would
 * mean a browser-side regression could be masked by a server-side change.
 * What is under test here is `src/browser.ts` running in a real browser.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = Number(process.env.HARNESS_PORT ?? 4319)

/** Every event the browser has delivered, in arrival order. */
let received = []

// An allowlist rather than static-directory serving: the harness binds a port
// on a developer machine and in CI, and there is no reason for it to be able
// to read anything outside these files.
const FILES = {
  '/': ['e2e/harness/page.html', 'text/html; charset=utf-8'],
  '/other': ['e2e/harness/other.html', 'text/html; charset=utf-8'],
  '/dist/browser.js': ['dist/browser.js', 'text/javascript; charset=utf-8'],
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    // The suite polls this endpoint; a cached 200 would make it read stale state.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

  if (req.method === 'POST' && pathname === '/collect') {
    // `?via=` is stamped by the transport spy in support.ts, never by the
    // tracker. Asserting on server receipt alone cannot tell beacon from fetch
    // — on localhost an ordinary fetch also completes before teardown — so the
    // transport has to be reported out of band for the unload tests to mean
    // anything.
    const via = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).searchParams.get('via')
    try {
      const parsed = JSON.parse(await readBody(req))
      received.push(...(parsed.events ?? []).map((event) => ({ ...event, _via: via ?? 'fetch' })))
    } catch {
      // A malformed body is itself a test signal — record nothing, still 202,
      // and let the assertion that expected an event be the thing that fails.
    }
    res.writeHead(202).end()
    return
  }

  if (req.method === 'GET' && pathname === '/_events') {
    json(res, 200, received)
    return
  }

  if (req.method === 'POST' && pathname === '/_reset') {
    received = []
    res.writeHead(204).end()
    return
  }

  const file = FILES[pathname]
  if (file) {
    const [relative, type] = file
    try {
      const body = await readFile(join(root, relative))
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(500).end(`harness could not read ${relative} — run "npm run build" first`)
    }
    return
  }

  res.writeHead(404).end()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`harness listening on http://127.0.0.1:${port}`)
})
