import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createIngestHandler } from '../handler.js'
import type { AnalyticsEvent, Sink } from '../types.js'

const SECRET = 'shared-secret'

function recordingSink(): Sink & { events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = []
  return {
    name: 'recording',
    events,
    async send(batch) {
      events.push(...batch)
    },
  }
}

function post(body: unknown, secret?: string): Request {
  return new Request('https://example.test/api/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-analytics-secret': secret } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('accepts a valid batch and stamps the default source', async () => {
  const sink = recordingSink()
  const handler = createIngestHandler({ sink, secret: SECRET, source: 'web' })

  const response = await handler(post({ events: [{ event_name: 'page_viewed' }] }, SECRET))

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { accepted: 1 })
  assert.equal(sink.events[0]?.source, 'web')
})

test('an event may override the default source', async () => {
  const sink = recordingSink()
  const handler = createIngestHandler({ sink, secret: SECRET, source: 'web' })

  await handler(post({ events: [{ event_name: 'call_booked', source: 'calendly-webhook' }] }, SECRET))

  assert.equal(sink.events[0]?.source, 'calendly-webhook')
})

test('rejects a wrong or missing secret without touching the sink', async () => {
  const sink = recordingSink()
  const handler = createIngestHandler({ sink, secret: SECRET })

  for (const request of [
    post({ events: [{ event_name: 'x' }] }, 'wrong'),
    post({ events: [{ event_name: 'x' }] }),
    // Same length as the real secret, to exercise the constant-time compare.
    post({ events: [{ event_name: 'x' }] }, 'shared-secreT'),
  ]) {
    const response = await handler(request)
    assert.equal(response.status, 401)
  }
  assert.equal(sink.events.length, 0)
})

test('rejects malformed JSON, empty batches, and nameless events', async () => {
  const handler = createIngestHandler({ sink: recordingSink(), secret: SECRET })

  assert.equal((await handler(post('{not json', SECRET))).status, 400)
  assert.equal((await handler(post({ events: [] }, SECRET))).status, 400)
  assert.equal((await handler(post({}, SECRET))).status, 400)
  assert.equal((await handler(post({ events: [{ properties: {} }] }, SECRET))).status, 400)
})

test('caps batch size so one caller cannot run up the bill', async () => {
  const handler = createIngestHandler({ sink: recordingSink(), secret: SECRET, maxEvents: 2 })

  const response = await handler(
    post({ events: [{ event_name: 'a' }, { event_name: 'b' }, { event_name: 'c' }] }, SECRET)
  )

  assert.equal(response.status, 413)
})

test('awaits the write by default, so serverless cannot drop it', async () => {
  let resolved = false
  const handler = createIngestHandler({
    sink: {
      name: 'slow',
      async send() {
        await new Promise((r) => setTimeout(r, 10))
        resolved = true
      },
    },
    secret: SECRET,
  })

  await handler(post({ events: [{ event_name: 'x' }] }, SECRET))

  assert.equal(resolved, true, 'handler returned before the write completed')
})

test('reports a failed write to the caller instead of a false 202', async () => {
  const reported: string[] = []
  const handler = createIngestHandler({
    sink: {
      name: 'broken',
      async send() {
        throw new Error('insert failed')
      },
    },
    secret: SECRET,
    onError: (error) => reported.push(error.message),
  })

  const response = await handler(post({ events: [{ event_name: 'x' }] }, SECRET))

  assert.equal(response.status, 502)
  assert.deepEqual(reported, ['insert failed'])
})

test('waitUntil hands the write to the platform and still reports failures', async () => {
  const pending: Promise<unknown>[] = []
  const reported: string[] = []
  const handler = createIngestHandler({
    sink: {
      name: 'broken',
      async send() {
        throw new Error('insert failed')
      },
    },
    secret: SECRET,
    onError: (error) => reported.push(error.message),
    waitUntil: (p) => pending.push(p),
  })

  const response = await handler(post({ events: [{ event_name: 'x' }] }, SECRET))

  assert.equal(response.status, 202)
  assert.equal(pending.length, 1)
  await Promise.all(pending)
  assert.deepEqual(reported, ['insert failed'])
})

test('refuses to build an unauthenticated endpoint in production', () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    assert.throws(
      () => createIngestHandler({ sink: recordingSink() }),
      /secret` is required in production/
    )
  } finally {
    process.env.NODE_ENV = previous
  }
})
