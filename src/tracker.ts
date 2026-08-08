import type {
  AnalyticsEvent,
  DeliveryStats,
  ErrorReporter,
  Sink,
} from './types.js'

export interface TrackerOptions {
  sink: Sink
  /** Default `source` for events that don't set one. */
  source?: string
  /**
   * Marks everything this tracker emits as test traffic. Default: true unless
   * NODE_ENV === 'production'. Local runs are opt-in to real analytics, never
   * opt-out, because the failure is silent and permanent — you only find out
   * when a funnel looks wrong months later.
   */
  isTest?: boolean
  /**
   * Where delivery failures go. Defaults to console.error, NOT to silence.
   *
   * Tracking must not throw into the caller — a broken pipeline should never
   * take down a checkout. But swallowing the error outright is the worse bug:
   * a total outage then looks exactly like a quiet week, and the one tool you
   * would use to notice is the tool that is down. Route this at your logger.
   */
  onError?: ErrorReporter
  /**
   * Re-throw delivery failures instead of reporting them. For backfills,
   * migrations, and tests, where losing events silently defeats the point.
   */
  throwOnError?: boolean
  /** Merged into every event's `context`; event-supplied keys win. */
  context?: () => Record<string, unknown>
}

export interface Tracker {
  /** Record one event. Resolves once the sink has accepted it. */
  track(
    eventName: string,
    properties?: Record<string, unknown>,
    overrides?: Partial<AnalyticsEvent>
  ): Promise<void>
  /** Record a fully-formed event. */
  trackEvent(event: AnalyticsEvent): Promise<void>
  /** Record many at once — one round trip, one failure report. */
  trackEvents(events: AnalyticsEvent[]): Promise<void>
  /** Delivery counters since process start. */
  stats(): DeliveryStats
}

const defaultReporter: ErrorReporter = (error, { sink, events }) => {
  const names = events.map((e) => e.event_name).join(', ')
  console.error(
    `[bq-analytics] ${events.length} event(s) lost via ${sink} sink [${names}]: ${error.message}`
  )
}

export function createTracker(options: TrackerOptions): Tracker {
  const {
    sink,
    source,
    isTest = process.env.NODE_ENV !== 'production',
    onError = defaultReporter,
    throwOnError = false,
    context,
  } = options

  const stats: DeliveryStats = { sent: 0, failed: 0 }

  const prepare = (event: AnalyticsEvent): AnalyticsEvent => ({
    ...event,
    source: event.source ?? source,
    is_test: event.is_test ?? isTest,
    context: context ? { ...context(), ...(event.context ?? {}) } : event.context,
  })

  async function trackEvents(events: AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) return
    const prepared = events.map(prepare)
    try {
      await sink.send(prepared)
      stats.sent += prepared.length
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      stats.failed += prepared.length
      stats.lastError = error
      stats.lastErrorAt = new Date().toISOString()
      if (throwOnError) throw error
      // A reporter that throws would defeat the guarantee this whole method
      // exists to provide, so it is contained too.
      try {
        onError(error, { sink: sink.name, events: prepared })
      } catch {
        /* a broken reporter must not break the caller either */
      }
    }
  }

  return {
    trackEvents,
    trackEvent: (event) => trackEvents([event]),
    track: (eventName, properties, overrides) =>
      trackEvents([{ event_name: eventName, properties, ...overrides }]),
    stats: () => ({ ...stats }),
  }
}
