# Visitor Handoff

Carrying the visitor through to the server. A signup or a purchase only joins the page views before it if the server-side
event carries the visitor's `anonymous_id`. The browser tracker keeps that id
in localStorage, which a server never sees, so it also mirrors it into a
first-party cookie, `ba_anonymous_id`. `readAnonymousId` reads it back:

```ts
import { readAnonymousId } from 'bq-analytics/server'

export async function POST(request: Request) {
  const user = await createAccount(request)
  await analytics.track('signed_up', { plan: 'pro' }, {
    user_id: user.id,
    anonymous_id: readAnonymousId(request), // null when the request has none
  })
  // ...
}
```

It returns the id only when it has the shape the tracker mints, and `null`
otherwise. The cookie is written by browser JavaScript, so treat it like any
other client input: validation keeps junk out of the table, it does not make
the id trustworthy. That is fine for analytics, where the worst case is a
visitor attributed to the wrong browser history.

The cookie reaches any request to the same origin. The flows below are the
ones that leave the site, or the device, and lose it unless you carry it.

## Cross-Origin Redirects

An OAuth or single sign-on login sends the browser to the provider and back to
your callback. The cookie is `SameSite=Lax`, so a browser sends it on the
top-level `GET` that brings the visitor back: read it in the callback as above.

A provider that returns with a cross-site `POST` (`response_mode=form_post`,
most SAML bindings) does not get Lax cookies. Put the id in the state you send
out and read it from the state that comes back:

```ts
// starting the login
const state = sign({ nonce, anonymous_id: readAnonymousId(request) })

// the callback
const { anonymous_id } = verify(params.state)
await analytics.track('signed_in', {}, { user_id: user.id, anonymous_id })
```

## Hosted Checkout

The page that starts a hosted checkout runs on your origin, but the payment
webhook that confirms it comes from the payment provider and has never seen
the browser. Hand the id to the provider as metadata when you create the
checkout, and read it back in the webhook:

```ts
// creating the checkout, from a request the visitor's browser made
const checkout = await payments.createCheckout({
  price: 'pro-monthly',
  metadata: { anonymous_id: readAnonymousId(request) ?? '' },
})

// the payment webhook, after verifying its signature
await analytics.track('purchase_completed', { plan: 'pro' }, {
  user_id: event.customer_reference,
  anonymous_id: event.metadata.anonymous_id || null,
  source: 'payment-webhook',
})
```

Send the webhook's event with the shared secret (or straight to the sink from
the service that owns the credentials). It is the row you would bet money on,
so it should not come through the public endpoint.

## Cross-Device Links

A link in an email (a sign-in link, an invite, a reminder about an abandoned
cart) is often opened on a different device than the one that asked for it.
That device has its own `anonymous_id`, or none yet, and its cookie says
nothing about the visitor who started the flow.

Sign the original id into the link, and on arrival let the link win over the
browser that opens it:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

const sig = (id: string) => createHmac('sha256', process.env.LINK_SECRET!).update(id).digest('hex')

// sending the email, from the visitor's request
const visitor = readAnonymousId(request)
const link = new URL('https://example.com/welcome')
if (visitor) {
  link.searchParams.set('v', visitor)
  link.searchParams.set('vs', sig(visitor))
}

// the link's landing route
function visitorFromLink(url: URL): string | null {
  const id = url.searchParams.get('v')
  const given = url.searchParams.get('vs')
  if (!id || !given) return null
  const expected = sig(id)
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    ? id
    : null
}

const anonymous_id = visitorFromLink(new URL(request.url)) ?? readAnonymousId(request)
```

The signature stops a recipient from editing the link to carry a different
id. It cannot make anonymous ids secret: any browser can send any id it knows,
in a link, a cookie or an event body. What keeps one person's browsing off
another's account is that the ids are random UUIDs nobody else sees, so never
put them anywhere public (a URL that gets shared, a page others can read). The
new device keeps its own id for its own page
views; once the user signs in there, the identity view links that id to the
same user too.

## Identity View

Every row that carries both ids links the browser to the account, and the
identity view (`sql/identity.sql`, created by `scripts/provision.sh`) turns
those links into one row per pair. The notes at the top of `sql/funnel.sql`,
`sql/attribution.sql` and `sql/active-users.sql` show how to resolve each
event to a person through it.

Two things the view does on purpose: a browser linked to more than one user
(a shared computer) is left out, because a wrong attribution is worse than a
missing one; and one user can have several browsers, so count people with
`COUNT(DISTINCT user_id)`. The first rule also bounds what a forged link can
do: a browser claimed by two accounts drops out rather than moving to the
second one.

## Server-Side User Resolution

The ingest handler can decide who is signed in on browser events from your own
session, so a browser event's `user_id` is never whatever the page claimed:

```ts
export const POST = createIngestHandler({
  sink: new BigQuerySink(),
  secret: process.env.ANALYTICS_API_SECRET,
  allowPublic: true,
  resolveUserId: async (request) => (await getSession(request))?.userId ?? null,
})
```

See `resolveUserId` in the README.
