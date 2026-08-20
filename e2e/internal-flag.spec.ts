import { expect, test } from '@playwright/test'
import { openHarness, reset, waitForEvents } from './support.js'

test.beforeEach(async ({ request }) => {
  await reset(request)
})

/**
 * The mechanic's whole promise is that marking a browser once keeps working
 * afterwards. The unit tests fake that by mutating a stub `location` in place,
 * which never actually reloads anything — so persistence across a real
 * document load had no coverage until this.
 */
test('?internal=1 marks the browser and survives a real page load', async ({ page, request }) => {
  await openHarness(page, '/?internal=1')
  await page.evaluate(() => window.tracker.track('marked_here'))

  // A genuine navigation: new document, new tracker instance, no query param.
  await openHarness(page, '/')
  await page.evaluate(() => window.tracker.track('later_page'))

  const events = await waitForEvents(request, 2)
  expect(events.find((e) => e.event_name === 'marked_here')?.properties).toMatchObject({
    internal: true,
  })
  expect(events.find((e) => e.event_name === 'later_page')?.properties).toMatchObject({
    internal: true,
  })
})

test('?internal=0 clears the mark for good', async ({ page, request }) => {
  await openHarness(page, '/?internal=1')
  await openHarness(page, '/?internal=0')
  await openHarness(page, '/')
  await page.evaluate(() => window.tracker.track('after_clear'))

  const events = await waitForEvents(request, 1)
  const event = events.find((e) => e.event_name === 'after_clear')
  expect(event?.properties?.internal).toBeUndefined()
})

test('ordinary visitors are never marked', async ({ page, request }) => {
  await openHarness(page)
  await page.evaluate(() => window.tracker.track('ordinary'))

  const [event] = await waitForEvents(request, 1)
  expect(event?.properties?.internal).toBeUndefined()
})

/**
 * Guards the trap this option used to set: forcing the flag off must not stop
 * the URL param from being recorded, or a site passing a server-rendered
 * `internal={false}` would silently make ?internal=1 useless forever.
 */
test('forcing the flag off still records the mark for later', async ({ page, request }) => {
  await page.goto('/?internal=1')
  await page.waitForFunction(() => window.harnessReady === true)
  await page.evaluate(() => window.makeTracker({ internal: false }).track('forced_off'))

  await openHarness(page, '/')
  await page.evaluate(() => window.tracker.track('override_dropped'))

  const events = await waitForEvents(request, 2)
  expect(events.find((e) => e.event_name === 'forced_off')?.properties?.internal).toBeUndefined()
  expect(events.find((e) => e.event_name === 'override_dropped')?.properties).toMatchObject({
    internal: true,
  })
})
