import type { AnalyticsEvent } from './types.js'

export interface BrowserTrackerOptions {
  /** URL of your ingestion endpoint. Same-origin keeps it out of blocklists. */
  url: string
  /** Stamped on every event. Default `web`. */
  source?: string
  /** Marks traffic as test. Default: true unless the host looks like production. */
  isTest?: boolean
  /**
   * Marks this browser's traffic as internal (your own team browsing the
   * live site). Default: driven by the `?internal=1` / `?internal=0` URL
   * param, persisted per browser in localStorage, and checked on every event
   * so the param also works on client-side navigations. When true, every
   * event's properties carry `internal: true` — filter with
   * `JSON_VALUE(properties, '$.internal') IS NULL`.
   *
   * Passing a boolean forces what this tracker stamps and turns off the
   * automatic behaviour. `?internal=1` is still recorded while forced, so
   * removing the override later picks the mark back up — but a site that
   * always passes `false` will never stamp anything. Leave it undefined
   * unless you specifically need to force the state (SSR, tests).
   */
  internal?: boolean
  /** Minutes of inactivity before a new session id is minted. Default 30. */
  sessionTimeoutMinutes?: number
  /** Called on delivery failure. Default: console.error. */
  onError?: (error: Error) => void
}

export interface BrowserTracker {
  track(eventName: string, properties?: Record<string, unknown>): void
  page(properties?: Record<string, unknown>): void
  /** Attach the signed-in user to subsequent events. */
  identify(userId: string): void
  anonymousId(): string
  sessionId(): string
}

const ANON_KEY = 'ba_anonymous_id'
const SESSION_KEY = 'ba_session'
const USER_KEY = 'ba_user_id'
const INTERNAL_KEY = 'ba_internal'

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage
    const probe = '__ba__'
    store.setItem(probe, '1')
    store.removeItem(probe)
    return store
  } catch {
    // Private browsing and blocked third-party storage both land here. The
    // tracker keeps working; ids just don't survive the page.
    return null
  }
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
}

/**
 * Client-side tracker. Manages the anonymous and session ids, snapshots page
 * context, and posts to your own origin — no third-party script, so ordinary
 * content blockers have nothing to match on.
 *
 * Everything here is best-effort by design: it never throws into your UI.
 * Failures still surface through `onError` rather than disappearing.
 */
export function createBrowserTracker(options: BrowserTrackerOptions): BrowserTracker {
  const {
    url,
    source = 'web',
    sessionTimeoutMinutes = 30,
    onError = (error: Error) =>
      console.error(`[bq-analytics] event not delivered: ${error.message}`),
  } = options

  const isTest =
    options.isTest ??
    (typeof window === 'undefined' ||
      /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) ||
      window.location.hostname.endsWith('.vercel.app'))

  const memory = new Map<string, string>()
  const read = (store: Storage | null, key: string): string | null =>
    store ? store.getItem(key) : (memory.get(key) ?? null)
  const write = (store: Storage | null, key: string, value: string): void => {
    if (store) store.setItem(key, value)
    else memory.set(key, value)
  }

  function anonymousId(): string {
    const store = safeStorage('local')
    let id = read(store, ANON_KEY)
    if (!id) {
      id = uuid()
      write(store, ANON_KEY, id)
    }
    return id
  }

  function sessionId(): string {
    const store = safeStorage('session')
    const now = Date.now()
    const raw = read(store, SESSION_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { id: string; last: number }
        if (now - parsed.last < sessionTimeoutMinutes * 60_000) {
          write(store, SESSION_KEY, JSON.stringify({ id: parsed.id, last: now }))
          return parsed.id
        }
      } catch {
        /* fall through and mint a new one */
      }
    }
    const id = uuid()
    write(store, SESSION_KEY, JSON.stringify({ id, last: now }))
    return id
  }

  function pageContext(): Record<string, unknown> {
    if (typeof window === 'undefined') return {}
    return {
      page_url: window.location.href,
      page_path: window.location.pathname,
      page_title: document.title,
      // Same-origin referrers are reduced to a path so per-post attribution is
      // queryable without string-mangling a full URL in SQL.
      referrer: document.referrer || null,
      referrer_path: sameOriginPath(document.referrer),
      screen_width: window.screen?.width ?? null,
      locale: navigator.language ?? null,
      user_agent: navigator.userAgent ?? null,
    }
  }

  function sameOriginPath(referrer: string): string | null {
    if (!referrer || typeof window === 'undefined') return null
    try {
      const parsed = new URL(referrer)
      return parsed.origin === window.location.origin ? parsed.pathname : null
    } catch {
      return null
    }
  }

  function send(event: AnalyticsEvent): void {
    if (typeof window === 'undefined') return
    const body = JSON.stringify({ events: [event] })
    try {
      // sendBeacon survives the page being closed, which is where most
      // outbound-click and last-page-view events would otherwise be lost.
      if (navigator.sendBeacon) {
        const ok = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
        if (ok) return
      }
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      }).then((response) => {
        if (!response.ok) onError(new Error(`ingest returned ${response.status}`))
      }, onError)
    } catch (cause) {
      onError(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }

  function internalFlag(): boolean {
    if (typeof window === 'undefined') return options.internal ?? false
    const store = safeStorage('local')
    try {
      const param = new URLSearchParams(window.location.search).get('internal')
      if (param === '1') write(store, INTERNAL_KEY, '1')
      if (param === '0') write(store, INTERNAL_KEY, '0')
    } catch {
      /* a malformed URL never breaks tracking */
    }
    // The param is recorded above even when the option overrides the result.
    // Returning early instead would make `internal={false}` — the obvious way
    // to write a server-rendered default — turn ?internal=1 into a permanent
    // no-op for that site, and nothing about the failure is observable.
    return options.internal ?? read(store, INTERNAL_KEY) === '1'
  }

  function build(eventName: string, properties?: Record<string, unknown>): AnalyticsEvent {
    const store = safeStorage('local')
    // internal is spread first so a caller can still override it explicitly.
    const props = internalFlag() ? { internal: true, ...(properties ?? {}) } : (properties ?? null)
    return {
      event_name: eventName,
      user_id: read(store, USER_KEY),
      anonymous_id: anonymousId(),
      session_id: sessionId(),
      timestamp: new Date().toISOString(),
      properties: props,
      context: pageContext(),
      source,
      is_test: isTest,
    }
  }

  return {
    anonymousId,
    sessionId,
    identify(userId: string) {
      write(safeStorage('local'), USER_KEY, userId)
    },
    track(eventName, properties) {
      send(build(eventName, properties))
    },
    page(properties) {
      send(build('page_viewed', properties))
    },
  }
}
