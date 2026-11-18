-- Daily active users with rolling weekly and monthly windows, plus the
-- stickiness ratio (DAU/MAU) that tells you whether people come back or just
-- came once.
--
--   bq query --use_legacy_sql=false --parameter='days:INT64:90' < sql/active-users.sql
--
-- Stitched through the identity view (sql/identity.sql), a person who browses
-- signed out on one day and signed in on another is one active user, not two.
-- Replace the `daily` CTE with:
--
--   daily AS (
--     SELECT
--       DATE(e.timestamp) AS day,
--       COALESCE(e.user_id, i.user_id, e.anonymous_id) AS actor
--     FROM `analytics.events` e
--     LEFT JOIN `analytics.identity` i ON i.anonymous_id = e.anonymous_id
--     WHERE NOT e.is_test
--       AND e.timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL days + 30 DAY)
--       AND COALESCE(e.user_id, e.anonymous_id) IS NOT NULL
--     GROUP BY day, actor
--   ),

DECLARE days INT64 DEFAULT @days;

WITH daily AS (
  SELECT
    DATE(timestamp) AS day,
    COALESCE(user_id, anonymous_id) AS actor
  FROM `analytics.events`
  WHERE NOT is_test
    AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL days + 30 DAY)
    AND COALESCE(user_id, anonymous_id) IS NOT NULL
  GROUP BY day, actor
),
calendar AS (
  SELECT day
  FROM UNNEST(
    GENERATE_DATE_ARRAY(
      DATE_SUB(CURRENT_DATE(), INTERVAL days DAY),
      CURRENT_DATE()
    )
  ) AS day
)
SELECT
  c.day,
  (SELECT COUNT(DISTINCT actor) FROM daily d WHERE d.day = c.day) AS dau,
  (SELECT COUNT(DISTINCT actor) FROM daily d
    WHERE d.day BETWEEN DATE_SUB(c.day, INTERVAL 6 DAY) AND c.day) AS wau,
  (SELECT COUNT(DISTINCT actor) FROM daily d
    WHERE d.day BETWEEN DATE_SUB(c.day, INTERVAL 29 DAY) AND c.day) AS mau,
  ROUND(
    SAFE_DIVIDE(
      (SELECT COUNT(DISTINCT actor) FROM daily d WHERE d.day = c.day),
      (SELECT COUNT(DISTINCT actor) FROM daily d
        WHERE d.day BETWEEN DATE_SUB(c.day, INTERVAL 29 DAY) AND c.day)
    ) * 100,
    1
  ) AS stickiness_pct
FROM calendar c
ORDER BY c.day;
