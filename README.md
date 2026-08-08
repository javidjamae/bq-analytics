# bq-analytics

Use BigQuery as a product analytics backend: one events table, typed tracking,
and an ingestion endpoint you can mount in any framework.

It is the pipeline that has been running FFmpeg Micro's product analytics since
2025, pulled out so other projects can use the same table shape and the same
queries. No vendor, no per-event pricing, no sampling — your events, in your
warehouse, queryable in SQL.

## Why not a product analytics SaaS

You already pay for BigQuery, and the free tier (10 GB stored, 1 TB scanned per
month) covers more traffic than most products ever see. What you give up is a
prebuilt UI; what you get back is every event at full fidelity, joinable against
anything else in your warehouse, with no sampling and no retention cliff.

Ad blockers are the other reason. A first-party ingestion endpoint on your own
domain has nothing for a blocklist to match on, and server-side events —
webhooks, cron jobs, background workers — never touch a browser at all.

## Install

Consumers install straight from GitHub. There is no npm registry involved.

```jsonc
// package.json
"dependencies": {
  "bq-analytics": "github:javidjamae/bq-analytics#v0.1.0"
}
```

**Always pin a tag.** `#main` will move under you, and a build that
can't be reproduced is worse than one version behind. See [Versioning](#versioning).

`@google-cloud/bigquery` is an optional peer dependency — install it only in
the app that owns the credentials.

**Install scripts must be allowed.** TypeScript is compiled by a `prepare`
script when the git dependency is installed, so `npm ci --ignore-scripts` (and
npm's newer `allowScripts` gate) will leave the package with no `dist/` and
fail at import. Either allow the script, or vendor a build. This is the one
sharp edge of installing from git rather than a registry.

## Architecture

One service owns the GCP service account and writes to BigQuery. Everything
else posts to that service over HTTP with a shared secret. That keeps
credentials in one place and means a browser, a cron job, and a webhook handler
all use the same interface.

```
browser ──┐
cron ─────┼──► HttpSink ──► /api/events (createIngestHandler) ──► BigQuerySink ──► BigQuery
webhook ──┘                                                   ▲
                                                              └── or call BigQuerySink directly
                                                                  from the credential holder
```

## Quickstart

### 1. Provision the tables

```bash
./scripts/provision.sh my-gcp-project
```

Creates `analytics` and `analytics_dev`, each with an `events` table
day-partitioned on `timestamp`. Safe to re-run.

### 2. Mount an ingestion endpoint

```ts
// app/api/events/route.ts  (Next.js App Router)
import { createIngestHandler } from 'bq-analytics/server'
import { BigQuerySink } from 'bq-analytics/server'

export const POST = createIngestHandler({
  sink: new BigQuerySink(),
  secret: process.env.ANALYTICS_API_SECRET,
})
```

### 3. Track from the server

```ts
import { createTracker } from 'bq-analytics'
import { BigQuerySink } from 'bq-analytics/server'

const analytics = createTracker({
  sink: new BigQuerySink(),
  source: 'api',
  onError: (error, { events }) => logger.error({ error, events }, 'analytics lost'),
})

await analytics.track('call_booked', { cta_source: '/blog/why-ab-tests-lie' })
```

### 3b. Serving browser traffic on the same endpoint

The browser cannot hold a secret, so a page-facing endpoint needs
`allowPublic`. Public (secretless) events get their `source` forced to
`browser`, so they can never impersonate a trusted server source; requests
that do present the secret keep their declared source. Treat public rows as
directional and keep money-grade events (conversions) coming from
secret-bearing server callers such as webhooks.

```ts
export const POST = createIngestHandler({
  sink: new BigQuerySink(),
  secret: process.env.ANALYTICS_API_SECRET, // trusted server callers
  allowPublic: true,                        // browser beacons, same URL
})
```

### 4. Track from the browser

```ts
import { createBrowserTracker } from 'bq-analytics/browser'

const analytics = createBrowserTracker({ url: '/api/events' })
analytics.page()
analytics.track('cta_clicked', { location: 'nav' })
```

The browser tracker manages `anonymous_id` (localStorage, stable across visits)
and `session_id` (30 minutes of inactivity by default), captures page context
including a same-origin `referrer_path`, and delivers with `sendBeacon` so
events survive the page being closed.

## Failures are reported, never swallowed

Tracking must not break the request it rides along with — a broken analytics
pipeline should never take down a checkout. But swallowing the error outright is
the worse bug, because a total outage then looks exactly like a quiet week, and
the one tool you would use to notice is the tool that is down.

So `createTracker` never throws into your code, and always reports:

```ts
createTracker({
  sink,
  onError: (error, { sink, events }) => logger.error({ error, sink, events }),
  // For backfills and tests, where losing events silently defeats the point:
  throwOnError: true,
})

tracker.stats() // { sent, failed, lastError, lastErrorAt } — assert on it in tests
```

The ingest handler is equally blunt: a failed write returns 502 rather than a
202 that lies to the caller.

## Test traffic

`is_test` defaults to `true` unless `NODE_ENV === 'production'`, and
`BigQuerySink` writes to `analytics_dev` unless `BQ_DATASET` says otherwise.
Polluting real analytics from a laptop is therefore an explicit choice, not an
accident — which matters, because the damage is silent and permanent. Every
query in `sql/` filters `WHERE NOT is_test`.

## Environment

| Variable | Used by | Default |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | `BigQuerySink` | Application Default Credentials |
| `BQ_DATASET` | `BigQuerySink` | `analytics` in production, else `analytics_dev` |
| `BQ_TABLE` | `BigQuerySink` | `events` |
| `ANALYTICS_API_SECRET` | ingest handler, `HttpSink` | none — **required in production** |

## Querying

`sql/` holds the recipes that make this feel like a product analytics tool
rather than an event log:

- `funnel.sql` — ordered step-by-step conversion, counting a step only when it
  follows the previous one for the same person
- `attribution.sql` — which page or post produced a conversion, as a rate
  against that page's own traffic
- `active-users.sql` — DAU, WAU, MAU and the stickiness ratio

```bash
bq query --use_legacy_sql=false \
  --parameter='steps:ARRAY<STRING>:["page_viewed","cta_clicked","call_booked"]' \
  --parameter='days:INT64:30' < sql/funnel.sql
```

## Event naming

The schema is generic on purpose, so the discipline has to live in convention.
Across projects, keep to:

- **snake_case, past tense**: `signed_up`, `call_booked`, `job_completed`
- **the event names the thing that happened, not the UI that caused it** —
  `call_booked`, not `calendly_iframe_success`
- **`properties` for what varies, `context` for ambient facts.** Plan, amount,
  and source path are properties; page, referrer, device, and locale are context
- **never put PII in `properties`.** Hash identifiers before they go in

Two projects that disagree on names can never answer a question that spans both,
and no library can enforce that for you.

## Versioning

The git tag is the version. `package.json` alone changes nothing for a consumer
installing from a git URL, so releases keep four things in agreement:
`package.json`, `src/version.ts` (exported as `VERSION`, and asserted against
`package.json` by the test suite), the CHANGELOG entry, and the annotated tag.

```bash
npm run release -- patch   # or minor, major, or an explicit 1.2.3
git push && git push --tags
```

Pre-1.0, minor versions may change the public API; the CHANGELOG says so when
they do. Upgrade a consumer by bumping the `#vX.Y.Z` in its `package.json`,
which keeps the upgrade visible in that repo's diff and revertible on its own.

## Development

```bash
npm install
npm test        # compiles, then runs node:test against dist/
```
