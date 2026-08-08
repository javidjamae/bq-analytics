-- Which page or post produced a conversion.
--
-- Attributes each conversion to the referring path recorded on the event, and
-- pairs it with that page's traffic so you get a rate rather than a raw count
-- — otherwise your most-trafficked page always "wins".
--
--   bq query --use_legacy_sql=false \
--     --parameter='conversion:STRING:call_booked' \
--     --parameter='days:INT64:30' < sql/attribution.sql

DECLARE conversion STRING DEFAULT @conversion;
DECLARE days INT64 DEFAULT @days;

WITH window_events AS (
  SELECT *
  FROM `analytics.events`
  WHERE NOT is_test
    AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL days DAY)
),
conversions AS (
  SELECT
    -- cta_source is set by the app; referrer_path is set by the browser
    -- tracker. Preferring the explicit one keeps server-side conversions
    -- (webhooks) attributable, since they have no referrer at all.
    COALESCE(
      JSON_VALUE(properties, '$.cta_source'),
      JSON_VALUE(context, '$.referrer_path'),
      '(unattributed)'
    ) AS source_path,
    COALESCE(user_id, anonymous_id) AS actor
  FROM window_events
  WHERE event_name = conversion
),
traffic AS (
  SELECT
    JSON_VALUE(context, '$.page_path') AS page_path,
    COUNT(DISTINCT COALESCE(user_id, anonymous_id)) AS visitors
  FROM window_events
  WHERE event_name = 'page_viewed'
    AND JSON_VALUE(context, '$.page_path') IS NOT NULL
  GROUP BY page_path
)
SELECT
  c.source_path,
  COUNT(DISTINCT c.actor) AS conversions,
  t.visitors,
  ROUND(SAFE_DIVIDE(COUNT(DISTINCT c.actor), t.visitors) * 100, 2) AS conversion_rate_pct
FROM conversions c
LEFT JOIN traffic t ON t.page_path = c.source_path
GROUP BY c.source_path, t.visitors
ORDER BY conversions DESC, t.visitors DESC;
