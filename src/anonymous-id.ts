/**
 * The browser tracker's anonymous id, as the server sees it.
 *
 * The tracker keeps the id in localStorage, which never leaves the browser, so
 * it also mirrors the id into a first-party cookie of the same name. That
 * cookie is what lets a server-side event (a signup handler, an OAuth
 * callback, a checkout return page) carry the visitor it came from.
 */
export const ANONYMOUS_ID_COOKIE = 'ba_anonymous_id' // ANON_KEY in src/browser.ts

// The two shapes `src/browser.ts` mints: crypto.randomUUID(), and the
// `<ms-hex>-<random-hex>` fallback for browsers without it. Date.now() has
// been 11 hex digits since 2004, so a short first part is not one of ours.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FALLBACK = /^[0-9a-f]{10,16}-[0-9a-f]{1,8}$/

/** True when `value` has the shape the browser tracker mints. */
export function isAnonymousId(value: unknown): value is string {
  return typeof value === 'string' && (UUID.test(value) || FALLBACK.test(value))
}

/**
 * The visitor's anonymous id from an incoming request's cookies, or `null`
 * when the request has none or it is not one the tracker could have minted.
 * Needs the browser tracker's `anonymousIdCookie` option left on (the default).
 *
 * Use it to put the visitor on a server-side event, so the event joins the
 * page views before it:
 *
 *   await analytics.track('signed_up', { plan: 'pro' }, {
 *     user_id: user.id,
 *     anonymous_id: readAnonymousId(request),
 *   })
 *
 * The cookie is set by browser JavaScript and is as forgeable as any other
 * client input: validation keeps junk out of the table, it does not make the
 * id trustworthy.
 */
export function readAnonymousId(request: Request): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  // `;` separates pairs; `,` appears when separate cookie header fields were
  // joined (HTTP/2 sends cookies as crumbs). Neither can occur in an id.
  for (const pair of header.split(/[;,]/)) {
    const eq = pair.indexOf('=')
    if (eq === -1 || pair.slice(0, eq).trim() !== ANONYMOUS_ID_COOKIE) continue
    // A header can carry the name twice (a stale cookie at another path or
    // domain); a malformed one must not hide a valid one after it.
    const value = pair.slice(eq + 1).trim()
    if (isAnonymousId(value)) return value
  }
  return null
}
