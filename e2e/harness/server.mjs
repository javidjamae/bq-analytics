#!/usr/bin/env node
/**
 * Test harness for the browser tracker.
 *
 * Deliberately dumb: it serves one page, serves the built tracker, and records
 * whatever gets POSTed to `/collect`. That path does NOT mount
 * `createIngestHandler` — the server side already has unit coverage, and
 * routing the browser specs through it would mean a browser-side regression
 * could be masked by a server-side change.
 *
 * The one exception is `/identity/*`, kept apart from `/collect`, because
 * what identity.spec.ts tests IS the seam: a real browser's cookies reaching
 * `resolveUserId` and `readAnonymousId` in the built server entry.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = Number(process.env.HARNESS_PORT ?? 4319)

/** Every event the browser has delivered, in arrival order. */
let received = []

// --- /identity: the ingest handler with a resolver, over a fake session ---

const IDENTITY_SECRET = 'e2e-secret'
/** Rows exactly as BigQuerySink would insert them, in arrival order. */
let rows = []

/** The app's own session, which is all `resolveUserId` should trust. */
function sessionUser(request) {
  const match = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get('cookie') ?? '')
  return match ? match[1] : null
}

// Loaded lazily so a missing build reaches the "run npm run build first"
// answer below instead of crashing the harness before it can say so.
let library
async function loadLibrary() {
  library ??= await import('../../dist/server.js')
  return library
}

let ingestHandler
async function ingest(request) {
  const { buildRow, createIngestHandler } = await loadLibrary()
  ingestHandler ??= createIngestHandler({
    sink: {
      name: 'harness-rows',
      async send(events) {
        rows.push(...events.map(buildRow))
      },
    },
    secret: IDENTITY_SECRET,
    allowPublic: true,
    resolveUserId: (request) => sessionUser(request),
  })
  return ingestHandler(request)
}

/** node:http to the web-standard Request the library speaks. */
function toRequest(req, body) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  })
}

async function send(res, response) {
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/plain' })
  res.end(Buffer.from(await response.arrayBuffer()))
}

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

  if (pathname.startsWith('/identity/')) {
    try {
      await loadLibrary()
    } catch {
      res.writeHead(500).end('harness could not load dist/server.js — run "npm run build" first')
      return
    }
  }

  if (req.method === 'POST' && pathname === '/identity/ingest') {
    await send(res, await ingest(toRequest(req, await readBody(req))))
    return
  }

  if (req.method === 'POST' && pathname === '/identity/login') {
    res.writeHead(204, { 'set-cookie': 'session=user-42; Path=/; SameSite=Lax; HttpOnly' }).end()
    return
  }

  // A server-side event, as an app's purchase handler would emit it: it knows
  // the user from its session and the visitor only from readAnonymousId.
  if (req.method === 'POST' && pathname === '/identity/purchase') {
    const request = toRequest(req, await readBody(req))
    const event = {
      event_name: 'purchase_completed',
      user_id: sessionUser(request),
      anonymous_id: (await loadLibrary()).readAnonymousId(request),
      source: 'api',
      properties: { plan: 'pro' },
    }
    await send(
      res,
      await ingest(
        new Request(`http://127.0.0.1:${port}/identity/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-analytics-secret': IDENTITY_SECRET },
          body: JSON.stringify({ events: [event] }),
        })
      )
    )
    return
  }

  if (req.method === 'GET' && pathname === '/identity/_rows') {
    json(res, 200, rows)
    return
  }

  if (req.method === 'GET' && pathname === '/_events') {
    json(res, 200, received)
    return
  }

  if (req.method === 'POST' && pathname === '/_reset') {
    received = []
    rows = []
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
