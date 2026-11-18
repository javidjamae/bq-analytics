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

  await handler(post({ events: [{ event_name: 'call_booked', source: 'payment-webhook' }] }, SECRET))

  assert.equal(sink.events[0]?.source, 'payment-webhook')
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

test('allowPublic accepts secretless requests but forces the public source', async () => {
  const sink = recordingSink()
  const handler = createIngestHandler({ sink, secret: SECRET, allowPublic: true })

  const response = await handler(
    // A public caller claiming a trusted server source must not keep it.
    post({ events: [{ event_name: 'call_booked', source: 'payment-webhook' }] })
  )

  assert.equal(response.status, 202)
  assert.equal(sink.events[0]?.source, 'browser')
})

test('allowPublic still honours the secret path for trusted callers', async () => {
  const sink = recordingSink()
  const handler = createIngestHandler({ sink, secret: SECRET, allowPublic: true })

  await handler(post({ events: [{ event_name: 'call_booked', source: 'payment-webhook' }] }, SECRET))

  assert.equal(sink.events[0]?.source, 'payment-webhook')
})

test('a wrong secret is rejected even when the endpoint is public', async () => {
  const sink = recordingSink()
  const handler = createIngestHandler({ sink, secret: SECRET, allowPublic: true })

  const response = await handler(post({ events: [{ event_name: 'x' }] }, 'wrong'))

  assert.equal(response.status, 401)
  assert.equal(sink.events.length, 0)
})

test('production build is allowed with no secret when allowPublic is explicit', () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    assert.doesNotThrow(() => createIngestHandler({ sink: recordingSink(), allowPublic: true }))
  } finally {
    process.env.NODE_ENV = previous
  }
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

// --- resolveUserId -------------------------------------------------------

function quietReporter(): { messages: string[]; onError: (error: Error) => void } {
  const messages: string[] = []
  return { messages, onError: (error) => messages.push(error.message) }
}

test('no resolver: public and trusted rows are exactly what they were before the option existed', async () => {
  const sink = recordingSink()
  const handler = createIngestHandler({ sink, secret: SECRET, allowPublic: true, source: 'api' })

  await handler(post({ events: [{ event_name: 'a', user_id: 'from-body', anonymous_id: 'anon' }] }))
  await handler(post({ events: [{ event_name: 'b' }] }))
  await handler(post({ events: [{ event_name: 'c', user_id: 'server-user' }] }, SECRET))

  // deepEqual on the whole event: no user_id key appears where the body had
  // none, and a body-supplied one passes through untouched.
  assert.deepEqual(sink.events, [
    { event_name: 'a', user_id: 'from-body', anonymous_id: 'anon', source: 'browser' },
    { event_name: 'b', source: 'browser' },
    { event_name: 'c', user_id: 'server-user', source: 'api' },
  ])
})

test('resolveUserId stamps its answer on every event of a public request', async () => {
  const sink = recordingSink()
  const seen: Request[] = []
  const handler = createIngestHandler({
    sink,
    allowPublic: true,
    resolveUserId: async (request) => {
      seen.push(request)
      return request.headers.get('cookie') === 'session=abc' ? 'user-1' : null
    },
  })

  const request = new Request('https://example.test/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'session=abc' },
    body: JSON.stringify({ events: [{ event_name: 'a' }, { event_name: 'b' }] }),
  })
  const response = await handler(request)

  assert.equal(response.status, 202)
  assert.equal(seen.length, 1, 'called once per request, not once per event')
  assert.equal(seen[0], request, 'receives the incoming request')
  assert.deepEqual(
    sink.events.map((e) => e.user_id),
    ['user-1', 'user-1']
  )
})

test('resolveUserId discards a user_id the body supplied', async () => {
  const sink = recordingSink()
  const handler = createIngestHandler({ sink, allowPublic: true, resolveUserId: () => 'real-user' })

  await handler(post({ events: [{ event_name: 'a', user_id: 'forged-user' }] }))

  assert.equal(sink.events[0]?.user_id, 'real-user')
})

test('a signed-out request writes user_id null, even when the body named a user', async () => {
  const sink = recordingSink()
  for (const answer of [null, undefined, '']) {
    const handler = createIngestHandler({ sink, allowPublic: true, resolveUserId: () => answer })
    await handler(post({ events: [{ event_name: 'a', user_id: 'forged-user' }] }))
  }

  assert.deepEqual(
    sink.events.map((e) => e.user_id),
    [null, null, null]
  )
})

test('a resolver that outlasts its time limit writes the row signed out and reports it', async () => {
  const sink = recordingSink()
  const { messages, onError } = quietReporter()
  const handler = createIngestHandler({
    sink,
    allowPublic: true,
    onError,
    resolveUserIdTimeoutMs: 20,
    resolveUserId: () => new Promise((resolve) => setTimeout(() => resolve('too-late'), 200)),
  })

  const started = Date.now()
  const response = await handler(post({ events: [{ event_name: 'a', user_id: 'forged-user' }] }))

  assert.equal(response.status, 202)
  assert.ok(Date.now() - started < 150, 'the handler waited past the time limit')
  assert.equal(sink.events.length, 1)
  assert.equal(sink.events[0]?.user_id, null)
  assert.deepEqual(messages, ['resolveUserId timed out after 20ms'])
})

test('the resolver time limit defaults to one second', async () => {
  const sink = recordingSink()
  const { messages, onError } = quietReporter()
  const handler = createIngestHandler({
    sink,
    allowPublic: true,
    onError,
    resolveUserId: () => new Promise(() => {}),
  })

  await handler(post({ events: [{ event_name: 'a' }] }))

  assert.equal(sink.events[0]?.user_id, null)
  assert.deepEqual(messages, ['resolveUserId timed out after 1000ms'])
})

test('a resolver that throws or rejects writes the row signed out and reports it', async () => {
  const sink = recordingSink()
  const { messages, onError } = quietReporter()
  const resolvers = [
    () => {
      throw new Error('session store down')
    },
    async () => {
      throw new Error('token expired')
    },
  ]
  for (const resolveUserId of resolvers) {
    const handler = createIngestHandler({ sink, allowPublic: true, onError, resolveUserId })
    const response = await handler(post({ events: [{ event_name: 'a' }] }))
    assert.equal(response.status, 202)
  }

  assert.deepEqual(
    sink.events.map((e) => e.user_id),
    [null, null]
  )
  assert.deepEqual(messages, [
    'resolveUserId failed: session store down',
    'resolveUserId failed: token expired',
  ])
})

test('secret-authenticated requests never reach the resolver and keep their user_id', async () => {
  const sink = recordingSink()
  let calls = 0
  const handler = createIngestHandler({
    sink,
    secret: SECRET,
    allowPublic: true,
    resolveUserId: () => {
      calls += 1
      return 'from-resolver'
    },
  })

  await handler(post({ events: [{ event_name: 'paid', user_id: 'server-user' }] }, SECRET))
  await handler(post({ events: [{ event_name: 'job_ran' }] }, SECRET))

  assert.equal(calls, 0)
  assert.deepEqual(sink.events, [
    { event_name: 'paid', user_id: 'server-user', source: 'web' },
    { event_name: 'job_ran', source: 'web' },
  ])
})

test('the resolver is not called for a request that fails validation', async () => {
  let calls = 0
  const handler = createIngestHandler({
    sink: recordingSink(),
    allowPublic: true,
    resolveUserId: () => {
      calls += 1
      return 'u'
    },
  })

  assert.equal((await handler(post('{not json'))).status, 400)
  assert.equal((await handler(post({ events: [] }))).status, 400)
  assert.equal((await handler(post({ events: [{ properties: {} }] }))).status, 400)
  assert.equal(calls, 0)
})

test('a numeric user id from the resolver is stored as its string', async () => {
  const sink = recordingSink()
  const handler = createIngestHandler({
    sink,
    allowPublic: true,
    // An untyped session whose primary key is a number.
    resolveUserId: () => 42 as unknown as string,
  })

  await handler(post({ events: [{ event_name: 'a' }] }))

  assert.equal(sink.events[0]?.user_id, '42')
})

test('a resolver answer of any other type is reported, not silently dropped', async () => {
  const sink = recordingSink()
  const { messages, onError } = quietReporter()
  const handler = createIngestHandler({
    sink,
    allowPublic: true,
    onError,
    resolveUserId: () => ({ id: 'u' }) as unknown as string,
  })

  const response = await handler(post({ events: [{ event_name: 'a' }] }))

  assert.equal(response.status, 202)
  assert.equal(sink.events[0]?.user_id, null)
  assert.deepEqual(messages, ['resolveUserId returned a object, expected a string or null'])
})

test('an Infinity time limit means no limit, not an instant timeout', async () => {
  const sink = recordingSink()
  const { messages, onError } = quietReporter()
  const handler = createIngestHandler({
    sink,
    allowPublic: true,
    onError,
    resolveUserIdTimeoutMs: Infinity,
    resolveUserId: () => new Promise((resolve) => setTimeout(() => resolve('slow-but-fine'), 30)),
  })

  await handler(post({ events: [{ event_name: 'a' }] }))

  assert.equal(sink.events[0]?.user_id, 'slow-but-fine')
  assert.deepEqual(messages, [])
})
