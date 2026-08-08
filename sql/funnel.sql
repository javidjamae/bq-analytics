-- Step-by-step conversion through an ordered funnel.
--
-- Counts each step only when it happens at or after the previous step for the
-- same person, which is the difference between a funnel and four unrelated
-- COUNT DISTINCTs. Identity falls back to anonymous_id so pre-signup steps
-- aren't dropped.
--
--   bq query --use_legacy_sql=false \
--     --parameter='steps:ARRAY<STRING>:["page_viewed","cta_clicked","call_booked"]' \
--     --parameter='days:INT64:30' < sql/funnel.sql

DECLARE steps ARRAY<STRING> DEFAULT @steps;
DECLARE days INT64 DEFAULT @days;

WITH events AS (
  SELECT
    COALESCE(user_id, anonymous_id) AS actor,
    event_name,
    timestamp
  FROM `analytics.events`
  WHERE NOT is_test
    AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL days DAY)
    AND event_name IN UNNEST(steps)
    AND COALESCE(user_id, anonymous_id) IS NOT NULL
),
first_touch AS (
  SELECT actor, event_name, MIN(timestamp) AS first_at
  FROM events
  GROUP BY actor, event_name
),
ordered AS (
  SELECT
    f.actor,
    f.event_name,
    f.first_at,
    -- Position in the declared funnel, not in time.
    (SELECT idx FROM UNNEST(steps) AS s WITH OFFSET idx WHERE s = f.event_name) AS step_index
  FROM first_touch f
),
reached AS (
  SELECT
    actor,
    step_index,
    event_name,
    first_at,
    -- A step counts only if every earlier step happened no later than it.
    (
      SELECT LOGICAL_AND(prior.first_at <= o.first_at)
      FROM ordered prior
      WHERE prior.actor = o.actor AND prior.step_index < o.step_index
    ) IS NOT FALSE AS in_order,
    (SELECT COUNT(*) FROM ordered prior WHERE prior.actor = o.actor AND prior.step_index < o.step_index)
      = o.step_index AS has_all_prior
  FROM ordered o
)
SELECT
  step_index + 1 AS step,
  event_name,
  COUNT(DISTINCT actor) AS actors,
  ROUND(
    SAFE_DIVIDE(
      COUNT(DISTINCT actor),
      MAX(COUNT(DISTINCT actor)) OVER ()
    ) * 100,
    1
  ) AS pct_of_top,
  ROUND(
    SAFE_DIVIDE(
      COUNT(DISTINCT actor),
      LAG(COUNT(DISTINCT actor)) OVER (ORDER BY step_index)
    ) * 100,
    1
  ) AS pct_of_previous
FROM reached
WHERE in_order AND has_all_prior
GROUP BY step_index, event_name
ORDER BY step_index;
