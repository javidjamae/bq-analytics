import { expect, type APIRequestContext, type Page } from '@playwright/test'

/** Shape the harness records. Loose on purpose — specs assert the fields they care about. */
export interface RecordedEvent {
  event_name: string
  anonymous_id: string
  session_id: string
  user_id: string | null
  properties: Record<string, unknown> | null
  context: Record<string, unknown>
  is_test: boolean
  source: string
  /** Stamped by the harness: which transport actually delivered this event. */
  _via?: 'beacon' | 'fetch'
}

export interface HarnessTracker {
  track(eventName: string, properties?: Record<string, unknown>): void
  page(properties?: Record<string, unknown>): void
  identify(userId: string): void
}

// What `e2e/harness/page.html` hangs off `window`. Declared globally so specs
// can write `window.tracker` inside page.evaluate — closure variables do not
// cross into the browser context, so everything the page needs must live there.
declare global {
  interface Window {
    harnessReady?: boolean
    tracker: HarnessTracker
    makeTracker(options?: Record<string, unknown>): HarnessTracker
  }
}

export async function reset(request: APIRequestContext): Promise<void> {
  await request.post('/_reset')
}

/**
 * Route beacons to `/collect?via=beacon` so the harness can report which
 * transport delivered each event. The spy forwards to the real sendBeacon —
 * it observes the choice rather than changing it. Must be installed before
 * the page loads, hence addInitScript.
 */
export async function recordTransport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = navigator.sendBeacon.bind(navigator)
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      const tagged = new URL(String(url), window.location.origin)
      tagged.searchParams.set('via', 'beacon')
      return real(tagged.toString(), data)
    }
  })
}

/** Load the harness page and wait for the tracker module to finish evaluating. */
export async function openHarness(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
  await page.waitForFunction(() => window.harnessReady === true)
}

async function fetchEvents(request: APIRequestContext): Promise<RecordedEvent[]> {
  return (await (await request.get('/_events')).json()) as RecordedEvent[]
}

/**
 * Delivery is fire-and-forget, so every assertion here is eventual. Polling
 * beats a fixed sleep: a beacon sent during unload can land after the page is
 * already gone, and the delay is not bounded by anything we control.
 */
export async function waitForEvents(
  request: APIRequestContext,
  count: number
): Promise<RecordedEvent[]> {
  await expect
    .poll(async () => (await fetchEvents(request)).length, {
      message: `expected at least ${count} event(s) to reach the harness`,
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(count)
  return fetchEvents(request)
}
