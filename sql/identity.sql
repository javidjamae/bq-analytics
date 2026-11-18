-- The identity view: which visitor (anonymous_id) became which user (user_id).
--
-- One row per (anonymous_id, user_id) pair, with first_linked_at, built only
-- from rows that carry both ids.
--
--   - A browser seen with more than one user is shared, and is LEFT OUT: a
--     wrong attribution is worse than a missing one.
--   - One user can have several anonymous_ids (phone, laptop, cleared
--     storage). The mapping is one-to-many by design, so count people with
--     COUNT(DISTINCT user_id), never COUNT(*).
--   - Each anonymous_id appears at most once, so a LEFT JOIN from the events
--     table on anonymous_id never multiplies event rows.
--   - It proves the browser was later used by that account, not that the
--     anonymous activity came first. Compare timestamps when order matters.
--   - Test rows are left out. identityViewDDL({ ..., includeTest: true })
--     renders a variant that keeps them.
--
-- Cost: the view reads four narrow columns (anonymous_id, user_id, timestamp,
-- is_test) across the table's whole history, because a link made a year ago
-- still holds. A query that joins through it pays for that scan on top of its
-- own date window. On a large table, materialise it on a schedule
-- (CREATE TABLE ... AS SELECT * FROM the view) and join to that instead.
--
-- scripts/provision.sh creates this next to each events table it creates,
-- with the names qualified for your project. By hand:
--
--   bq query --use_legacy_sql=false < sql/identity.sql
--
-- To stitch a visitor's signed-out events to the account they became, resolve
-- the actor through the view (see the notes in funnel.sql, attribution.sql and
-- active-users.sql):
--
--   SELECT COALESCE(e.user_id, i.user_id, e.anonymous_id) AS actor, ...
--   FROM `analytics.events` e
--   LEFT JOIN `analytics.identity` i ON i.anonymous_id = e.anonymous_id
--
-- Generated from identityViewDDL({ dataset: 'analytics' }); a test fails if the
-- statement below drifts from it.

CREATE VIEW IF NOT EXISTS `analytics.identity`
OPTIONS(description="Which anonymous_id became which user_id; shared browsers left out. See github.com/javidjamae/bq-analytics")
AS
SELECT
  anonymous_id,
  user_id,
  MIN(timestamp) AS first_linked_at
FROM `analytics.events`
WHERE anonymous_id IS NOT NULL AND anonymous_id != ''
    AND user_id IS NOT NULL AND user_id != ''
    AND NOT is_test
GROUP BY anonymous_id, user_id
-- A browser linked to more than one user is shared: leave it out entirely.
QUALIFY COUNT(*) OVER (PARTITION BY anonymous_id) = 1;
