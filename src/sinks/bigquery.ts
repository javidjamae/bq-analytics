import { randomUUID } from 'node:crypto'
import type { AnalyticsEvent, AnalyticsRow, Sink } from '../types.js'

export interface BigQuerySinkOptions {
  /**
   * Defaults to $BQ_DATASET, then to `analytics` in production and
   * `analytics_dev` everywhere else. Production is opt-in on purpose.
   */
  dataset?: string
  /** Defaults to $BQ_TABLE, then `events`. */
  table?: string
  /** Defaults to the ambient GCP project (ADC / $GOOGLE_CLOUD_PROJECT). */
  projectId?: string
  /**
   * A pre-built @google-cloud/bigquery client, or any object exposing the same
   * `dataset(name).table(name).insert(rows)` shape. Supply one in tests to
   * assert on rows without touching the network.
   */
  client?: BigQueryLike
}

/** The slice of @google-cloud/bigquery this sink actually uses. */
export interface BigQueryLike {
  dataset(id: string): {
    table(id: string): { insert(rows: AnalyticsRow[]): Promise<unknown> }
  }
}

export function defaultDataset(): string {
  return (
    process.env.BQ_DATASET ||
    (process.env.NODE_ENV === 'production' ? 'analytics' : 'analytics_dev')
  )
}

export function buildRow(event: AnalyticsEvent): AnalyticsRow {
  const now = new Date().toISOString()
  return {
    event_id: randomUUID(),
    event_name: event.event_name,
    user_id: event.user_id ?? null,
    anonymous_id: event.anonymous_id ?? null,
    session_id: event.session_id ?? null,
    timestamp: event.timestamp ?? now,
    properties: event.properties ? JSON.stringify(event.properties) : null,
    context: event.context ? JSON.stringify(event.context) : null,
    source: event.source ?? 'unknown',
    created_at: now,
    is_test: event.is_test ?? false,
  }
}

/**
 * Streams rows straight into BigQuery. Use this wherever the GCP credentials
 * live — one service should own them, and everything else should reach that
 * service over HTTP (see HttpSink).
 *
 * @google-cloud/bigquery is an optional peer dependency, imported lazily, so
 * browser and HTTP-only consumers never pull it into their bundle.
 */
export class BigQuerySink implements Sink {
  readonly name = 'bigquery'
  private readonly dataset: string
  private readonly table: string
  private readonly projectId?: string
  private clientPromise?: Promise<BigQueryLike>

  constructor(options: BigQuerySinkOptions = {}) {
    this.dataset = options.dataset ?? defaultDataset()
    this.table = options.table ?? process.env.BQ_TABLE ?? 'events'
    this.projectId = options.projectId
    if (options.client) {
      this.clientPromise = Promise.resolve(options.client)
    }
  }

  private async client(): Promise<BigQueryLike> {
    if (!this.clientPromise) {
      // The specifier is held in a variable so TypeScript does not try to
      // resolve the module at build time — it is an optional peer dependency,
      // and consumers that only use HttpSink never install it.
      const specifier = '@google-cloud/bigquery'
      this.clientPromise = import(specifier)
        .then((mod: { BigQuery: new (opts?: Record<string, unknown>) => BigQueryLike }) => {
          const BigQuery = mod.BigQuery
          return new BigQuery(this.projectId ? { projectId: this.projectId } : {})
        })
        .catch((cause) => {
          // Reset so a later call can retry rather than reusing a rejection.
          this.clientPromise = undefined
          throw new Error(
            `@google-cloud/bigquery is required by BigQuerySink but could not be loaded: ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          )
        })
    }
    return this.clientPromise
  }

  async send(events: AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) return
    const client = await this.client()
    await client
      .dataset(this.dataset)
      .table(this.table)
      .insert(events.map(buildRow))
  }
}
