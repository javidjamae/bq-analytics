# Changelog

Consumers install this package from a git URL, so **the git tag is the version**.
Every entry below corresponds to a `vX.Y.Z` tag you can pin.

This project follows [semantic versioning](https://semver.org). Before 1.0.0,
minor versions may still change the public API; the entries say so when they do.

## Unreleased

_Nothing yet._

## 0.2.0 — 2026-08-08

### Added
- `createIngestHandler` accepts `allowPublic` (+ `publicSource`, default
  `browser`): accept secretless browser traffic on the same endpoint that
  serves secret-bearing server callers. Public events get their `source`
  forced, so an unauthenticated request can never impersonate a trusted
  server source; a wrong secret is still rejected rather than downgraded to
  public. Browser analytics cannot hold a secret, so without this the
  handler's production guard made `createBrowserTracker` unusable against it.

## 0.1.0 — 2026-08-08

First cut. Extracted from a production SaaS product's BigQuery analytics
pipeline, running since 2025, generalised so any project can use the same
table and tools.

### Added
- `createTracker()` — typed `track` / `trackEvent` / `trackEvents`, with a
  `source` and `is_test` default per tracker and delivery counters via `stats()`.
- `BigQuerySink` — streaming inserts, with `@google-cloud/bigquery` as a lazily
  imported optional peer dependency so browser and HTTP-only consumers never
  bundle it.
- `HttpSink` — posts to an ingestion endpoint with a shared secret and a
  request timeout, so only one service needs GCP credentials.
- `createIngestHandler()` — a web-standard `Request`/`Response` endpoint that
  drops into Next.js route handlers, Hono, Bun, or Deno. Constant-time secret
  comparison, batch size cap, and it refuses to build without a secret in
  production.
- `createBrowserTracker()` — anonymous and session id management, page context
  capture, and `sendBeacon` delivery that survives page unload.
- The canonical `events` schema, as TypeScript, as a BigQuery schema JSON, and
  as generated DDL. Matches the originating table column for column, so an
  existing dataset can adopt this library with no migration.
- `scripts/provision.sh` — creates `analytics` and `analytics_dev` with the
  events table, day-partitioned on `timestamp`. Safe to re-run.
- SQL recipes for funnels, per-page conversion attribution, and active users
  with stickiness.

### Notes on defaults
- Delivery failures are reported through `onError` (defaulting to
  `console.error`), never swallowed. `throwOnError` opts into raising them for
  backfills and tests.
- `is_test` defaults to true outside `NODE_ENV=production`, so writing to real
  analytics from a laptop is an explicit choice rather than an accident.
- The ingest handler awaits the write by default; pass `waitUntil` only on a
  platform that keeps the function alive after the response.
