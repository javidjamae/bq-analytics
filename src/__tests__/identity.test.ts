import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { identitySelect, identityViewDDL } from '../identity.js'

// dist-test/__tests__ -> repo root
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('renders a fully qualified view for a project, dataset, table and view', () => {
  const ddl = identityViewDDL({
    project: 'my-project',
    dataset: 'analytics',
    table: 'raw_events',
    view: 'visitor_users',
  })

  assert.match(ddl, /^CREATE VIEW IF NOT EXISTS `my-project\.analytics\.visitor_users`/)
  assert.match(ddl, /FROM `my-project\.analytics\.raw_events`/)
})

test('defaults: events table, identity view, test rows left out', () => {
  const ddl = identityViewDDL({ dataset: 'analytics' })

  assert.match(ddl, /CREATE VIEW IF NOT EXISTS `analytics\.identity`/)
  assert.match(ddl, /FROM `analytics\.events`/)
  assert.match(ddl, /AND NOT is_test/)
  assert.match(ddl, /QUALIFY COUNT\(\*\) OVER \(PARTITION BY anonymous_id\) = 1/)
})

test('includeTest keeps test rows', () => {
  assert.doesNotMatch(identityViewDDL({ dataset: 'analytics', includeTest: true }), /is_test/)
})

test('refuses a name that would break out of its backticks', () => {
  for (const options of [
    { dataset: 'a`; DROP TABLE x; --' },
    { dataset: 'analytics', project: 'p q' },
    { dataset: 'analytics', table: '' },
    { dataset: 'analytics', view: 'v\\`' },
  ]) {
    assert.throws(() => identityViewDDL(options), /invalid/)
  }
})

test('sql/identity.sql has the exact line provision.sh deletes for the dev view', () => {
  // provision.sh keeps test rows in analytics_dev.identity by deleting this
  // line with sed; if it ever changes shape, the sed would silently miss.
  const file = readFileSync(join(root, 'sql', 'identity.sql'), 'utf8')
  const script = readFileSync(join(root, 'scripts', 'provision.sh'), 'utf8')
  assert.ok(file.split('\n').includes('    AND NOT is_test'))
  assert.ok(script.includes("'/^    AND NOT is_test$/d'"))
})

test('sql/identity.sql is the rendered statement, so the two cannot drift', () => {
  const file = readFileSync(join(root, 'sql', 'identity.sql'), 'utf8')
  assert.ok(
    file.endsWith(identityViewDDL({ dataset: 'analytics' })),
    'sql/identity.sql no longer ends with identityViewDDL({ dataset: "analytics" }); regenerate it'
  )
})

/**
 * The view's rules, run by BigQuery itself on fixture rows. The rows are an
 * inline CTE, so no table is created and the query bills nothing. Opt-in,
 * because it needs credentials and @google-cloud/bigquery installed:
 *
 *   BQ_ANALYTICS_TEST_PROJECT=my-project npm test
 */
test('rules on fixture rows, in BigQuery', { skip: !process.env.BQ_ANALYTICS_TEST_PROJECT }, async () => {
  const specifier = '@google-cloud/bigquery'
  const { BigQuery } = (await import(specifier)) as {
    BigQuery: new (o: object) => { query(o: object): Promise<[Record<string, unknown>[]]> }
  }
  const bq = new BigQuery({ projectId: process.env.BQ_ANALYTICS_TEST_PROJECT })
  const fixture = `(
    SELECT * FROM UNNEST([
      STRUCT('linked' AS anonymous_id, CAST(NULL AS STRING) AS user_id, TIMESTAMP '2026-01-01 10:00:00' AS timestamp, FALSE AS is_test),
      ('linked', 'u-linked', TIMESTAMP '2026-01-01 10:05:00', FALSE),
      ('linked', 'u-linked', TIMESTAMP '2026-01-02 09:00:00', FALSE),
      ('shared', 'u-first', TIMESTAMP '2026-01-01 11:00:00', FALSE),
      ('shared', 'u-second', TIMESTAMP '2026-01-03 11:00:00', FALSE),
      ('phone', 'u-multi', TIMESTAMP '2026-01-04 08:00:00', FALSE),
      ('laptop', 'u-multi', TIMESTAMP '2026-01-05 08:00:00', FALSE),
      ('test-only', 'u-test', TIMESTAMP '2026-01-06 08:00:00', TRUE),
      ('', 'u-empty', TIMESTAMP '2026-01-07 08:00:00', FALSE)
    ])
  )`
  const run = async (includeTest: boolean) => {
    const [rows] = await bq.query({
      query: `SELECT anonymous_id, user_id, STRING(first_linked_at) AS first_linked_at
              FROM (${identitySelect(fixture, includeTest)}) ORDER BY anonymous_id`,
    })
    return rows
  }

  assert.deepEqual(await run(false), [
    // multi-device: one user, two browsers, two rows
    { anonymous_id: 'laptop', user_id: 'u-multi', first_linked_at: '2026-01-05 08:00:00+00' },
    // linked pair: the earliest row carrying both ids
    { anonymous_id: 'linked', user_id: 'u-linked', first_linked_at: '2026-01-01 10:05:00+00' },
    { anonymous_id: 'phone', user_id: 'u-multi', first_linked_at: '2026-01-04 08:00:00+00' },
    // 'shared' (two users) left out; 'test-only' left out; '' left out
  ])
  assert.ok((await run(true)).some((row) => row.anonymous_id === 'test-only'))
})
