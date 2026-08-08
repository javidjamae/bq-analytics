import { timingSafeEqual } from 'node:crypto'
import type { AnalyticsEvent, ErrorReporter, Sink } from './types.js'

export interface IngestHandlerOptions {
  /** Where accepted events go — normally a BigQuerySink. */
  sink: Sink
  /**
   * Shared secret callers must present as `x-analytics-secret`. Omitting it
   * leaves the endpoint open, which is refused outright in production.
   */
  secret?: string
  /** Stamped onto events that don't declare their own. Default `web`. */
  source?: string
  /** Cap on events per request, to bound the cost of a bad caller. */
  maxEvents?: number
  /** Where write failures are reported. Default: console.error. */
  onError?: ErrorReporter
  /**
   * Hand the write to a platform keep-alive (Vercel's `waitUntil`) so the
   * response returns before the insert finishes.
   *
   * Without this the handler AWAITS the write, which is the safe default on
   * serverless: a fire-and-forget promise is killed the moment the response is
   * returned, so events vanish under exactly the conditions you'd never test.
   */
  waitUntil?: (promise: Promise<unknown>) => void
}

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch, which itself leaks length.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Builds a framework-agnostic ingestion endpoint over the web-standard
 * Request/Response pair, so it drops into a Next.js route handler, Hono, Bun,
 * Deno, or anything else that speaks fetch.
 *
 *   // app/api/events/route.ts
 *   export const POST = createIngestHandler({
 *     sink: new BigQuerySink(),
 *     secret: process.env.ANALYTICS_API_SECRET,
 *   })
 */
export function createIngestHandler(options: IngestHandlerOptions) {
  const {
    sink,
    secret,
    source = 'web',
    maxEvents = 100,
    onError,
    waitUntil,
  } = options

  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error(
      'createIngestHandler: `secret` is required in production — an open ingest endpoint lets anyone write rows into your analytics table.'
    )
  }

  return async function handleIngest(request: Request): Promise<Response> {
    if (secret && !secretMatches(request.headers.get('x-analytics-secret'), secret)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    let body: { events?: AnalyticsEvent[]; source?: string }
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 })
    }

    const events = body?.events
    if (!Array.isArray(events) || events.length === 0) {
      return Response.json({ error: '`events` must be a non-empty array' }, { status: 400 })
    }
    if (events.length > maxEvents) {
      return Response.json(
        { error: `too many events: ${events.length} > ${maxEvents}` },
        { status: 413 }
      )
    }
    if (events.some((e) => typeof e?.event_name !== 'string' || !e.event_name)) {
      return Response.json({ error: 'every event needs an event_name' }, { status: 400 })
    }

    const stamped = events.map((e) => ({ ...e, source: e.source ?? body.source ?? source }))
    const write = sink.send(stamped)

    if (waitUntil) {
      // The platform keeps the function alive; report failures out of band.
      waitUntil(
        write.catch((cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          if (onError) onError(error, { sink: sink.name, events: stamped })
          else console.error(`[bq-analytics] ingest write failed: ${error.message}`)
        })
      )
      return Response.json({ accepted: stamped.length }, { status: 202 })
    }

    try {
      await write
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (onError) onError(error, { sink: sink.name, events: stamped })
      else console.error(`[bq-analytics] ingest write failed: ${error.message}`)
      // The caller is told the truth. Its own tracker decides whether to retry
      // or drop; that choice does not belong to the collector.
      return Response.json({ error: 'write failed' }, { status: 502 })
    }

    return Response.json({ accepted: stamped.length }, { status: 202 })
  }
}
