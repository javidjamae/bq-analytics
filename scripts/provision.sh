#!/usr/bin/env bash
# Create the analytics datasets and events table for a project.
#
#   ./scripts/provision.sh <gcp-project-id> [location]
#
# Creates BOTH `analytics` and `analytics_dev` with the same table, because the
# dev dataset is what keeps local runs out of real numbers. Safe to re-run:
# every step is create-if-missing.
set -euo pipefail

PROJECT="${1:-}"
LOCATION="${2:-US}"
SCHEMA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/schema/events.schema.json"

if [[ -z "$PROJECT" ]]; then
  echo "usage: $0 <gcp-project-id> [location]" >&2
  exit 64
fi

if [[ ! -f "$SCHEMA" ]]; then
  echo "schema not found at $SCHEMA" >&2
  exit 66
fi

for DATASET in analytics analytics_dev; do
  if bq --project_id="$PROJECT" show --dataset "$DATASET" >/dev/null 2>&1; then
    echo "dataset $DATASET already exists"
  else
    echo "creating dataset $DATASET"
    bq --project_id="$PROJECT" --location="$LOCATION" mk --dataset \
      --description="Product analytics events (bq-analytics)" "$DATASET"
  fi

  if bq --project_id="$PROJECT" show "$DATASET.events" >/dev/null 2>&1; then
    echo "table $DATASET.events already exists"
  else
    echo "creating table $DATASET.events"
    bq --project_id="$PROJECT" mk --table \
      --time_partitioning_field=timestamp \
      --time_partitioning_type=DAY \
      --description="Product analytics events — see github.com/javidjamae/bq-analytics" \
      "$DATASET.events" "$SCHEMA"
  fi
done

echo
echo "done. Point your app at it with:"
echo "  GOOGLE_CLOUD_PROJECT=$PROJECT"
echo "  BQ_DATASET=analytics        # omit locally to default to analytics_dev"
