import { expect, test } from '@playwright/test'
import { openHarness, reset, waitForEvents } from './support.js'

test.beforeEach(async ({ request }) => {
  await reset(request)
})

/**
 * `safeStorage()` probes with a setItem/removeItem pair and falls back to an
 * in-process Map when that throws — the case it was written for is Safari
 * private browsing, which throws on write rather than reporting storage as
 * unavailable. Nothing verified the fallback until this ran in a real browser.
 */
test('tracking survives storage that throws on write', async ({ page, request }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = function throwing() {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    }
  })

  await openHarness(page)
  await page.evaluate(() => window.tracker.track('storage_blocked'))

  const [event] = await waitForEvents(request, 1)
  expect(event?.event_name).toBe('storage_blocked')
  // Ids still get minted; they just do not survive the page.
  expect(event?.anonymous_id).toBeTruthy()
  expect(event?.session_id).toBeTruthy()
})

/**
 * The anonymous id lives in localStorage and the session in sessionStorage.
 * That split is the whole reason a returning visitor is recognisable while a
 * new tab starts a new session, and it cannot be checked against a fake Map
 * that has neither lifetime.
 */
test('a new tab keeps the anonymous id but starts a new session', async ({ context, request }) => {
  const first = await context.newPage()
  await openHarness(first)
  await first.evaluate(() => window.tracker.track('first_tab'))
  await waitForEvents(request, 1)
  await first.close()

  const second = await context.newPage()
  await openHarness(second)
  await second.evaluate(() => window.tracker.track('second_tab'))

  const events = await waitForEvents(request, 2)
  const one = events.find((e) => e.event_name === 'first_tab')
  const two = events.find((e) => e.event_name === 'second_tab')

  expect(one, 'first tab event missing').toBeDefined()
  expect(two, 'second tab event missing').toBeDefined()
  expect(two?.anonymous_id).toBe(one?.anonymous_id)
  expect(two?.session_id).not.toBe(one?.session_id)
})
