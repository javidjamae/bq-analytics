/**
 * The canonical event. Mirrors the BigQuery table column for column, so a row
 * in `analytics.events` and an AnalyticsEvent are the same thing.
 */
export interface AnalyticsEvent {
  /** Snake_case, past tense, product-agnostic: `signed_up`, `call_booked`. */
  event_name: string
  /** Your auth system's user id, once known. */
  user_id?: string | null
  /** Stable per-browser id, for stitching pre-auth activity to a user later. */
  anonymous_id?: string | null
  /** Resets on a new visit; the unit most funnel questions are asked in. */
  session_id?: string | null
  /** ISO 8601. Defaults to now, at track time rather than receipt time. */
  timestamp?: string
  /** Event-specific fields: `{ plan: 'pro', cta_source: '/blog/post' }`. */
  properties?: Record<string, unknown> | null
  /** Ambient facts: page, referrer, device, locale. */
  context?: Record<string, unknown> | null
  /** What emitted it: `web`, `api`, `cron`. Defaults to the tracker's source. */
  source?: string
  /** Test traffic. Every canonical query filters with `WHERE NOT is_test`. */
  is_test?: boolean
}

/** A row exactly as it is inserted into BigQuery. */
export interface AnalyticsRow {
  event_id: string
  event_name: string
  user_id: string | null
  anonymous_id: string | null
  session_id: string | null
  timestamp: string
  properties: string | null
  context: string | null
  source: string
  created_at: string
  is_test: boolean
}

/** Somewhere events go. Implement this to add a destination. */
export interface Sink {
  /** Stable name, used in error reports. */
  readonly name: string
  send(events: AnalyticsEvent[]): Promise<void>
}

/**
 * Called whenever delivery fails. Analytics must never break the calling
 * request, but a failure must never be invisible either — see `onError` in
 * TrackerOptions for why there is no silent default.
 */
export type ErrorReporter = (
  error: Error,
  context: { sink: string; events: AnalyticsEvent[] }
) => void

/** Counters for asserting delivery in tests and health checks. */
export interface DeliveryStats {
  sent: number
  failed: number
  lastError?: Error
  lastErrorAt?: string
}
