import { expect, test } from '@playwright/test'
import { openHarness, recordTransport, reset, waitForEvents } from './support.js'

test.beforeEach(async ({ request }) => {
  await reset(request)
})

test('a tracked event reaches the endpoint', async ({ page, request }) => {
  await openHarness(page)
  await page.evaluate(() => window.tracker.track('thing_happened', { a: 1 }))

  const [event] = await waitForEvents(request, 1)
  expect(event?.event_name).toBe('thing_happened')
  expect(event?.properties).toMatchObject({ a: 1 })
  expect(event?.anonymous_id).toBeTruthy()
  expect(event?.session_id).toBeTruthy()
  expect(event?.context?.page_path).toBe('/')
})

/**
 * The reason `send()` reaches for sendBeacon at all — see the comment at its
 * call site. If this ever regresses, every last-page-view and outbound-click
 * event silently disappears, which is exactly the failure a unit test with a
 * stubbed `navigator` cannot see.
 */
test('an event fired while the page unloads still arrives, over the beacon', async ({
  page,
  request,
}) => {
  await recordTransport(page)
  await openHarness(page)
  await page.evaluate(() => {
    window.addEventListener('pagehide', () => window.tracker.track('left_the_page'))
  })

  await page.goto('/other')

  const events = await waitForEvents(request, 1)
  const event = events.find((e) => e.event_name === 'left_the_page')
  expect(event, 'the unload event never reached the endpoint').toBeDefined()
  // Asserting arrival alone would pass even with beacons disabled, because a
  // same-origin fetch to localhost also completes before teardown.
  expect(event?._via, 'unload delivery must use sendBeacon, not fetch').toBe('beacon')
})

test('an event fired as the tab closes still arrives, over the beacon', async ({
  page,
  request,
}) => {
  await recordTransport(page)
  await openHarness(page)
  await page.evaluate(() => {
    window.addEventListener('pagehide', () => window.tracker.track('tab_closed'))
  })

  await page.close()

  const events = await waitForEvents(request, 1)
  const event = events.find((e) => e.event_name === 'tab_closed')
  expect(event, 'the tab-close event never reached the endpoint').toBeDefined()
  expect(event?._via, 'tab-close delivery must use sendBeacon, not fetch').toBe('beacon')
})

/**
 * A real browser refuses a beacon once its queue is full (~64KB), and `send()`
 * is written to fall through to fetch+keepalive when that happens. Forcing the
 * refusal is more deterministic than trying to hit the real size threshold.
 */
test('delivery falls back to fetch when sendBeacon refuses the payload', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const win = window as unknown as { beaconCalls: number }
    win.beaconCalls = 0
    navigator.sendBeacon = () => {
      win.beaconCalls += 1
      return false
    }
  })

  await openHarness(page)
  await page.evaluate(() => window.tracker.track('fell_back'))

  const [event] = await waitForEvents(request, 1)
  expect(event?.event_name).toBe('fell_back')
  expect(event?._via, 'a refused beacon must be retried over fetch').toBe('fetch')

  const calls = await page.evaluate(() => (window as unknown as { beaconCalls: number }).beaconCalls)
  expect(calls, 'the beacon path should have been attempted first').toBe(1)
})
