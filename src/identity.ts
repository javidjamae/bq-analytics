/**
 * The identity view: which visitor (`anonymous_id`) became which user
 * (`user_id`), one row per pair, with when they were first seen together.
 *
 * Built only from rows that carry both ids. Its rules:
 *
 * - An `anonymous_id` seen with more than one `user_id` is left out. That is a
 *   shared browser, and a wrong attribution is worse than a missing one.
 * - One user can have several `anonymous_id`s (devices, cleared storage), so
 *   the mapping is one-to-many by design: count users with
 *   `COUNT(DISTINCT user_id)`.
 * - Each `anonymous_id` appears at most once, so `LEFT JOIN ... USING
 *   (anonymous_id)` from the events table never multiplies event rows.
 * - It proves the browser was later used by that account. It does not prove
 *   the anonymous activity came first; compare timestamps when order matters.
 * - Test rows (`is_test`) are left out unless `includeTest` is set.
 */
export interface IdentityViewOptions {
  /** GCP project holding the dataset. Omit to leave names unqualified. */
  project?: string
  dataset: string
  /** The events table. Default `events`. */
  table?: string
  /** The view to create. Default `identity`. */
  view?: string
  /** Keep `is_test` rows. Default false, matching every query in `sql/`. */
  includeTest?: boolean
}

/** Every name is interpolated inside backticks, so none may contain one. */
function checkName(kind: string, value: string): string {
  if (!value || /[`\s\\]/.test(value)) {
    throw new Error(`identityViewDDL: invalid ${kind} name ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The view's query over `source`, a backticked table reference. Kept apart
 * from the DDL so the rules can be run against fixture rows with no table.
 */
export function identitySelect(source: string, includeTest = false): string {
  const testFilter = includeTest ? '' : '\n    AND NOT is_test'
  return `SELECT
  anonymous_id,
  user_id,
  MIN(timestamp) AS first_linked_at
FROM ${source}
WHERE anonymous_id IS NOT NULL AND anonymous_id != ''
    AND user_id IS NOT NULL AND user_id != ''${testFilter}
GROUP BY anonymous_id, user_id
-- A browser linked to more than one user is shared: leave it out entirely.
QUALIFY COUNT(*) OVER (PARTITION BY anonymous_id) = 1`
}

/**
 * `CREATE VIEW IF NOT EXISTS` for the identity view over an events table.
 * `scripts/provision.sh` runs the same statement (from `sql/identity.sql`)
 * next to each events table it creates.
 *
 *   identityViewDDL({ project: 'my-project', dataset: 'analytics' })
 */
export function identityViewDDL(options: IdentityViewOptions): string {
  const { project, dataset, table = 'events', view = 'identity', includeTest = false } = options
  const prefix = project === undefined ? '' : `${checkName('project', project)}.`
  const qualified = (name: string) => `\`${prefix}${checkName('dataset', dataset)}.${name}\``
  return `CREATE VIEW IF NOT EXISTS ${qualified(checkName('view', view))}
OPTIONS(description="Which anonymous_id became which user_id; shared browsers left out. See github.com/javidjamae/bq-analytics")
AS
${identitySelect(qualified(checkName('table', table)), includeTest)};
`
}
