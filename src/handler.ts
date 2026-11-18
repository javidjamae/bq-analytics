import { timingSafeEqual } from 'node:crypto'
import type { AnalyticsEvent, ErrorReporter, Sink } from './types.js'

export interface IngestHandlerOptions {
  /** Where accepted events go — normally a BigQuerySink. */
  sink: Sink
  /**
   * Shared secret callers must present as `x-analytics-secret`. Omitting it
   * leaves the endpoint open, which is refused outright in production unless
   * `allowPublic` is set.
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
  /**
   * Accept requests that present no secret — browser traffic, which cannot
   * hold one. Public events get `source` forced to `publicSource`, so a
   * request without the secret can never impersonate a trusted server source
   * (a forged `payment-webhook` row would poison conversion queries).
   *
   * Like all client-side analytics, a public endpoint accepts forgeable
   * events; keep anything you'd bet money on (conversions) coming from a
   * secret-bearing server caller, and treat public rows as directional.
   */
  allowPublic?: boolean
  /** Source stamped on public (no-secret) events. Default `browser`. */
  publicSource?: string
  /**
   * Who is signed in, decided by your own session rather than by the request
   * body. Called once per public (no-secret) request, after the body has been
   * validated and read, so read the session from headers or cookies. Its
   * answer becomes every event's `user_id`, and any `user_id` the body
   * carried is discarded: a public endpoint cannot trust a client to say who
   * it is. Return `null` for a signed-out request.
   *
   * A resolver that throws or takes longer than `resolveUserIdTimeoutMs`
   * writes the events signed out and is reported through `onError`; the
   * events are never dropped for it. Requests that present the secret are
   * trusted to name their own user and never reach the resolver.
   *
   *   resolveUserId: async (request) => (await getSession(request))?.userId ?? null
   */
  resolveUserId?: (request: Request) => string | null | undefined | Promise<string | null | undefined>
  /**
   * How long `resolveUserId` may take before the events are written signed
   * out. Default 1000. Capped at setTimeout's limit (about 24.8 days), so
   * `Infinity` means no practical limit rather than an instant timeout.
   */
  resolveUserIdTimeoutMs?: number
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
    allowPublic = false,
    publicSource = 'browser',
    resolveUserId,
    resolveUserIdTimeoutMs = 1000,
  } = options

  // setTimeout fires after 1ms for anything above 2^31-1, Infinity included.
  const resolveTimeout = Math.min(resolveUserIdTimeoutMs, 2_147_483_647)

  function report(error: Error, events: AnalyticsEvent[], consolePrefix = ''): void {
    if (onError) onError(error, { sink: sink.name, events })
    else console.error(`[bq-analytics] ${consolePrefix}${error.message}`)
  }

  /** The resolver's answer, or null when it fails or runs out of time. */
  async function resolveUser(
    resolver: NonNullable<IngestHandlerOptions['resolveUserId']>,
    request: Request,
    events: AnalyticsEvent[]
  ): Promise<string | null> {
    const timedOut = Symbol('timed out')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race([
        // Wrapped so a resolver that throws synchronously is caught here too.
        Promise.resolve().then(() => resolver(request)),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), resolveTimeout)
        }),
      ])
      if (answer === timedOut) {
        report(new Error(`resolveUserId timed out after ${resolveUserIdTimeoutMs}ms`), events)
        return null
      }
      if (answer === null || answer === undefined || answer === '') return null
      if (typeof answer === 'string') return answer
      // A numeric primary key is a user id too; anything else is a bug in the
      // resolver, and silently writing it signed out would hide that.
      if (typeof answer === 'number' || typeof answer === 'bigint') return String(answer)
      report(new Error(`resolveUserId returned a ${typeof answer}, expected a string or null`), events)
      return null
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      report(new Error(`resolveUserId failed: ${error.message}`, { cause: error }), events)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  if (!secret && !allowPublic && process.env.NODE_ENV === 'production') {
    throw new Error(
      'createIngestHandler: `secret` is required in production — an open ingest endpoint lets anyone write rows into your analytics table. Pass allowPublic: true only if you mean to accept unauthenticated browser traffic.'
    )
  }

  return async function handleIngest(request: Request): Promise<Response> {
    const provided = request.headers.get('x-analytics-secret')
    // A wrong secret is always rejected, even on a public endpoint — an
    // explicit failed auth attempt must not silently downgrade to public.
    if (provided !== null && (!secret || !secretMatches(provided, secret))) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    const trusted = provided !== null && secret !== undefined
    if (!trusted && !allowPublic) {
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

    let stamped: AnalyticsEvent[]
    if (trusted) {
      stamped = events.map((e) => ({ ...e, source: e.source ?? body.source ?? source }))
    } else if (resolveUserId) {
      const userId = await resolveUser(resolveUserId, request, events)
      stamped = events.map((e) => ({ ...e, source: publicSource, user_id: userId }))
    } else {
      stamped = events.map((e) => ({ ...e, source: publicSource }))
    }
    const write = sink.send(stamped)

    if (waitUntil) {
      // The platform keeps the function alive; report failures out of band.
      waitUntil(
        write.catch((cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          report(error, stamped, 'ingest write failed: ')
        })
      )
      return Response.json({ accepted: stamped.length }, { status: 202 })
    }

    try {
      await write
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      report(error, stamped, 'ingest write failed: ')
      // The caller is told the truth. Its own tracker decides whether to retry
      // or drop; that choice does not belong to the collector.
      return Response.json({ error: 'write failed' }, { status: 502 })
    }

    return Response.json({ accepted: stamped.length }, { status: 202 })
  }
}
