#!/usr/bin/env bash
# Create the analytics datasets and events table for a project, and grant the
# app's writer service account what it needs.
#
#   ./scripts/provision.sh <gcp-project-id> [location] [--writer <sa-email>]
#
# Creates BOTH `analytics` and `analytics_dev` with the same table, because the
# dev dataset is what keeps local runs out of real numbers. Safe to re-run:
# every step is create-if-missing, and every grant is an idempotent binding.
#
# --writer grants that service account, on the project:
#   roles/bigquery.dataEditor  insert events
#   roles/bigquery.jobUser     run queries (freshness checks, backfills)
# Project scope, so give analytics its own GCP project: dataEditor here reaches
# every dataset in it. (Dataset-scoped IAM through `bq add-iam-policy-binding
# -d` needs Google to allowlist the project, so it is not used.)
# Without jobUser the account can write rows but cannot read them back with a
# query, so any check that runs as it (a freshness alert, say) fails.
set -euo pipefail

usage() {
  echo "usage: $0 <gcp-project-id> [location] [--writer <sa-email>]" >&2
  exit 64
}

WRITER=""
WRITER_GIVEN=0
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --writer)   [[ $# -ge 2 ]] || usage; WRITER="$2"; WRITER_GIVEN=1; shift 2 ;;
    --writer=*) WRITER="${1#--writer=}"; WRITER_GIVEN=1; shift ;;
    -*)         echo "unknown option: $1" >&2; usage ;;
    *)          POSITIONAL+=("$1"); shift ;;
  esac
done
[[ ${#POSITIONAL[@]} -ge 1 && ${#POSITIONAL[@]} -le 2 ]] || usage
PROJECT="${POSITIONAL[0]}"
LOCATION="${POSITIONAL[1]:-US}"

# A grant was asked for: an empty or malformed account must fail, never be
# skipped on the way to printing "done".
if [[ $WRITER_GIVEN -eq 1 && "$WRITER" != *@*.iam.gserviceaccount.com ]]; then
  echo "--writer needs a service account email (…@….iam.gserviceaccount.com), got '$WRITER'" >&2
  exit 64
fi

SCHEMA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/schema/events.schema.json"
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

if [[ -n "$WRITER" ]]; then
  for ROLE in roles/bigquery.dataEditor roles/bigquery.jobUser; do
    echo "granting $ROLE on project $PROJECT to $WRITER"
    gcloud projects add-iam-policy-binding "$PROJECT" \
      --member="serviceAccount:$WRITER" --role="$ROLE" \
      --condition=None --quiet >/dev/null
  done
fi

echo
echo "done. Point your app at it with:"
echo "  GOOGLE_CLOUD_PROJECT=$PROJECT"
echo "  BQ_DATASET=analytics        # omit locally to default to analytics_dev"
