import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createTracker } from '../tracker.js'
import { buildRow } from '../sinks/bigquery.js'
import { HttpSink } from '../sinks/http.js'
import { eventsDDL, EVENTS_SCHEMA } from '../schema.js'
import { VERSION } from '../version.js'
import type { AnalyticsEvent, Sink } from '../types.js'

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

function failingSink(message = 'boom'): Sink {
  return {
    name: 'failing',
    async send() {
      throw new Error(message)
    },
  }
}

test('stamps source and marks non-production traffic as test', async () => {
  const sink = recordingSink()
  const tracker = createTracker({ sink, source: 'web', isTest: true })

  await tracker.track('call_booked', { cta_source: '/blog/why-ab-tests-lie' })

  assert.equal(sink.events.length, 1)
  assert.equal(sink.events[0]?.event_name, 'call_booked')
  assert.equal(sink.events[0]?.source, 'web')
  assert.equal(sink.events[0]?.is_test, true)
  assert.deepEqual(sink.events[0]?.properties, { cta_source: '/blog/why-ab-tests-lie' })
})

test('event-supplied context wins over the tracker default', async () => {
  const sink = recordingSink()
  const tracker = createTracker({
    sink,
    context: () => ({ app: 'user-growth', release: 'abc123' }),
  })

  await tracker.trackEvent({ event_name: 'page_viewed', context: { release: 'override' } })

  assert.deepEqual(sink.events[0]?.context, { app: 'user-growth', release: 'override' })
})

test('a failing sink never throws into the caller, but is always reported', async () => {
  const reported: string[] = []
  const tracker = createTracker({
    sink: failingSink('bigquery unavailable'),
    onError: (error, ctx) => reported.push(`${ctx.sink}: ${error.message}`),
  })

  await tracker.track('signed_up')

  assert.deepEqual(reported, ['failing: bigquery unavailable'])
  assert.equal(tracker.stats().failed, 1)
  assert.equal(tracker.stats().sent, 0)
  assert.equal(tracker.stats().lastError?.message, 'bigquery unavailable')
})

test('a reporter that throws still cannot break the caller', async () => {
  const tracker = createTracker({
    sink: failingSink(),
    onError: () => {
      throw new Error('logger is down too')
    },
  })

  await assert.doesNotReject(() => tracker.track('signed_up'))
  assert.equal(tracker.stats().failed, 1)
})

test('throwOnError surfaces failures for backfills and tests', async () => {
  const tracker = createTracker({ sink: failingSink('insert rejected'), throwOnError: true })

  await assert.rejects(() => tracker.track('signed_up'), /insert rejected/)
})

test('an empty batch is a no-op, not a round trip', async () => {
  let calls = 0
  const tracker = createTracker({
    sink: {
      name: 'counting',
      async send() {
        calls++
      },
    },
  })

  await tracker.trackEvents([])

  assert.equal(calls, 0)
  assert.equal(tracker.stats().sent, 0)
})

test('buildRow serializes JSON columns and fills the required fields', () => {
  const row = buildRow({
    event_name: 'call_booked',
    properties: { cta_source: '/blog/post' },
    source: 'web',
    is_test: false,
  })

  assert.match(row.event_id, /^[0-9a-f-]{36}$/)
  assert.equal(row.properties, '{"cta_source":"/blog/post"}')
  assert.equal(row.context, null)
  assert.equal(row.user_id, null)
  assert.equal(row.is_test, false)
  assert.ok(Date.parse(row.timestamp) > 0)
  assert.ok(Date.parse(row.created_at) > 0)
})

test('buildRow defaults is_test to false so server events are never mislabelled', () => {
  assert.equal(buildRow({ event_name: 'x' }).is_test, false)
})

test('HttpSink raises a non-2xx response rather than reporting success', async () => {
  const sink = new HttpSink({
    url: 'https://example.test/api/events',
    secret: 's3cret',
    fetchImpl: (async () =>
      new Response('nope', { status: 500, statusText: 'Server Error' })) as typeof fetch,
  })

  await assert.rejects(() => sink.send([{ event_name: 'x' }]), /500/)
})

test('HttpSink sends the shared secret and the event envelope', async () => {
  let seenHeader: string | null = null
  let seenBody: unknown = null
  const sink = new HttpSink({
    url: 'https://example.test/api/events',
    secret: 's3cret',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seenHeader = (init.headers as Record<string, string>)['x-analytics-secret'] ?? null
      seenBody = JSON.parse(init.body as string)
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch,
  })

  await sink.send([{ event_name: 'call_booked' }])

  assert.equal(seenHeader, 's3cret')
  assert.deepEqual(seenBody, { events: [{ event_name: 'call_booked' }] })
})

test('the DDL covers every column in the schema and partitions by day', () => {
  const ddl = eventsDDL('analytics')
  for (const field of EVENTS_SCHEMA) {
    assert.ok(ddl.includes(field.name), `DDL is missing ${field.name}`)
  }
  assert.ok(ddl.includes('PARTITION BY DATE(timestamp)'))
  assert.ok(ddl.includes('is_test BOOL NOT NULL'))
})

test('the exported VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(
    VERSION,
    pkg.version,
    'src/version.ts drifted from package.json — run `npm run release` rather than editing either by hand'
  )
})
