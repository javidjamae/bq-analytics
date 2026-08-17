# Per-event schema versioning, stamped in BigQuery

**Status:** 📋 Proposed (Javid, 2026-08-16). Not scheduled — captured so the
requirement survives until it is.
**Origin:** FFmpeg Micro pricing-v2 work added several new events in one day
(`job_token_overflow`, `auto_topup_*`), which surfaced the question this PRD
answers.

## The problem

When how an event is fired changes — its name, its properties, the meaning of
a property — rows written before and after the change coexist in the same
table. Today nothing on the ROW says which contract it was written under:

- A user journey that spans code releases mixes old-shape and new-shape rows
  with no marker separating them. Interpreting it means correlating row
  timestamps against deploy times against git history — archaeology that has
  to be redone for every analysis, by whoever is doing it, forever.
- The consumers' event catalogs (e.g. FFmpeg Micro's `docs/event-catalog.md`)
  document the CURRENT contract, not which rows follow which historical one.
- Transition periods make it worse: during a rolling deploy, old and new
  writers emit concurrently, so even "before time T / after time T" is wrong.

The fix must live **in BigQuery itself**, on every row — the data has to be
self-describing, because the git history won't be sitting next to the
analyst (or the LLM) reading the table in two years.

## Proposal

### 1. `event_version` column (per-event, not global)

Add to `EVENTS_SCHEMA`:

```
{ name: 'event_version', type: 'STRING', mode: 'NULLABLE',
  description: 'Version of this event_name\'s contract (name + properties shape). NULL = pre-versioning.' }
```

- **Per-event, not catalog-global**: `(event_name, event_version)` identifies
  a properties contract. A global catalog version would force every event's
  interpretation to change whenever any one event does.
- NULLABLE and additive: existing tables adopt it without migration; all
  history is honestly `NULL` (= "pre-versioning contract, see catalog
  archaeology"), never backfilled with a guess.
- STRING, not INT: allows `'2'` but also `'2024-06-form'`-style tags if a
  consumer prefers; comparisons are by equality, not ordering.

### 2. The tracker stamps it; the registry declares it

Consumers today call `trackEvent({event_name, properties, ...})` free-form.
The version must not be one more thing to hand-maintain at every call site —
that recreates the drift problem one field over. Instead:

- `createTracker({ eventVersions?: Record<string, string> })` — a consumer
  passes its event→version map once (generated or hand-kept next to its
  catalog); the tracker stamps `event_version` on every row automatically.
- An event not in the map is stamped `'1'` (a declared-once default beats
  NULL-forever).
- Optionally (follow-up, not this PRD): a typed event registry per consumer
  (event name → TS properties interface + version) that both web and server
  emitters import, making a property rename a compile error and the
  version bump a reviewable one-line diff in the same file as the shape
  change.

### 3. Renames are new events, versions are shape changes

Convention, documented in the README when this ships:

- **Renaming** an event = retiring one `event_name` and starting another
  (the old name's rows keep their meaning forever).
- **Changing properties** (add with changed semantics, remove, retype,
  re-mean) = bump that event's version.
- **Purely additive** properties MAY keep the version (analyst reads NULLs),
  but bumping is cheap and removes the judgment call.

### 4. Writer provenance (cheap, same change)

Stamp the library's existing `VERSION` constant into `context.lib_version`
on every row (context is already a JSON catch-all). Near-free, and answers
"which writer produced this row" without a schema change.

## What this buys

- `SELECT event_name, event_version, COUNT(*) ... GROUP BY 1,2` shows every
  contract cohabiting in the table, with sizes — the transition period is
  *visible* instead of inferred.
- A journey query can pin `event_version` per event or branch on it,
  and an analysis written today still runs correctly over next year's rows.
- Catalog docs gain a natural changelog structure: one section per
  `(event_name, event_version)`.

## Non-goals

- No backfill of historical rows (NULL is the honest value).
- No enforcement that properties actually match the declared version (that
  is the typed-registry follow-up).
- No table-level migration machinery beyond the additive column.

## Sketch of the work (~1 session)

1. `schema.ts`: add the column to `EVENTS_SCHEMA` + DDL; additive `ALTER
   TABLE` snippet in `sql/` for existing tables.
2. `tracker.ts`: `eventVersions` option; stamp on insert; default `'1'`.
3. `context.lib_version` stamp.
4. README: the rename-vs-version convention above.
5. Consumers (FFmpeg Micro first): pass the map, source it from
   `docs/event-catalog.md`'s front matter or a small module.
