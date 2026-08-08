import type { AnalyticsEvent, Sink } from '../types.js'

export interface HttpSinkOptions {
  /** Full URL of an ingestion endpoint built with createIngestHandler. */
  url: string
  /** Shared secret, sent as `x-analytics-secret`. */
  secret?: string
  /** Milliseconds before the request is aborted. Default 5000. */
  timeoutMs?: number
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Posts events to an ingestion endpoint instead of to BigQuery directly. This
 * is what every app that isn't the credential holder should use: one service
 * owns the GCP service account, everything else owns a URL and a secret.
 */
export class HttpSink implements Sink {
  readonly name = 'http'
  private readonly url: string
  private readonly secret?: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: HttpSinkOptions) {
    this.url = options.url
    this.secret = options.secret
    this.timeoutMs = options.timeoutMs ?? 5000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  async send(events: AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) return
    // An unreachable collector must not hold a request open indefinitely.
    const signal = AbortSignal.timeout(this.timeoutMs)
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.secret ? { 'x-analytics-secret': this.secret } : {}),
      },
      body: JSON.stringify({ events }),
      signal,
    })
    if (!response.ok) {
      throw new Error(
        `ingest endpoint returned ${response.status} ${response.statusText}`
      )
    }
  }
}
