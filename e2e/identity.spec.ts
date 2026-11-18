import { expect, test, type APIRequestContext } from '@playwright/test'
import { openHarness, reset } from './support.js'

interface Row {
  event_name: string
  user_id: string | null
  anonymous_id: string | null
  source: string
}

test.beforeEach(async ({ request }) => {
  await reset(request)
})

/**
 * The whole identity story in one browser: a signed-out page view, a
 * signed-in one whose user comes from the server's session (not from the
 * forged id the page put in the body), and a server-side event that only
 * knows the visitor through the tracker's cookie. These are the three rows
 * the identity view joins: the signed-in rows link the anonymous id to the
 * user, and the signed-out view stitches to that user through it.
 */
test('signed out, signed in, then a server event, all carrying one visitor', async ({
  page,
  request,
}) => {
  await openHarness(page)
  const anonymousId = await page.evaluate(() => {
    const tracker = window.makeTracker({ url: '/identity/ingest' })
    tracker.page({ step: 'signed_out' })
    return tracker.anonymousId()
  })

  await expect.poll(async () => (await rowsOf(request)).length).toBe(1)

  await page.evaluate(async () => {
    await fetch('/identity/login', { method: 'POST' })
    const tracker = window.makeTracker({ url: '/identity/ingest' })
    // A page claiming to be someone else: the resolver must overrule it.
    tracker.identify('someone-else')
    tracker.page({ step: 'signed_in' })
  })
  await expect.poll(async () => (await rowsOf(request)).length).toBe(2)

  const purchase = await page.evaluate(async () => {
    const response = await fetch('/identity/purchase', { method: 'POST' })
    return response.status
  })
  expect(purchase).toBe(202)

  const rows = await rowsOf(request)
  expect(rows.map(({ event_name, user_id, anonymous_id, source }) => ({
    event_name,
    user_id,
    anonymous_id,
    source,
  }))).toEqual([
    { event_name: 'page_viewed', user_id: null, anonymous_id: anonymousId, source: 'browser' },
    { event_name: 'page_viewed', user_id: 'user-42', anonymous_id: anonymousId, source: 'browser' },
    { event_name: 'purchase_completed', user_id: 'user-42', anonymous_id: anonymousId, source: 'api' },
  ])
})

async function rowsOf(request: APIRequestContext): Promise<Row[]> {
  return (await (await request.get('/identity/_rows')).json()) as Row[]
}
