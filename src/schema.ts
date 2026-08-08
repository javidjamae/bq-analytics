/**
 * The events table, defined once. `scripts/provision.sh` creates the table
 * from EVENTS_SCHEMA, and the DDL below is the same thing for anyone
 * provisioning by hand or through Terraform.
 *
 * The shape deliberately matches the table FFmpeg Micro has been writing to
 * since 2025, so an existing dataset can adopt this library without a
 * migration.
 */
export interface BigQueryField {
  name: string
  type: 'STRING' | 'TIMESTAMP' | 'JSON' | 'BOOLEAN'
  mode: 'REQUIRED' | 'NULLABLE'
  description: string
}

export const EVENTS_SCHEMA: BigQueryField[] = [
  { name: 'event_id', type: 'STRING', mode: 'REQUIRED', description: 'UUID dedupe key' },
  { name: 'event_name', type: 'STRING', mode: 'REQUIRED', description: 'Event name, e.g. quickstart_step_completed' },
  { name: 'user_id', type: 'STRING', mode: 'NULLABLE', description: 'Auth user ID, once known' },
  { name: 'anonymous_id', type: 'STRING', mode: 'NULLABLE', description: 'Client-side ID for pre-auth tracking' },
  { name: 'session_id', type: 'STRING', mode: 'NULLABLE', description: 'Browser session ID' },
  { name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED', description: 'When the event occurred' },
  { name: 'properties', type: 'JSON', mode: 'NULLABLE', description: 'Arbitrary event properties (step_number, job_id, etc.)' },
  { name: 'context', type: 'JSON', mode: 'NULLABLE', description: 'Device, page, referrer metadata' },
  { name: 'source', type: 'STRING', mode: 'NULLABLE', description: 'Event source: web, api-gateway, cron' },
  { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED', description: 'Server receipt time' },
  { name: 'is_test', type: 'BOOLEAN', mode: 'REQUIRED', description: 'True for test events — filter with WHERE NOT is_test' },
]

/** Partitioning keeps a full-table scan off every query, and the bill down. */
export const PARTITION_FIELD = 'timestamp'

export function eventsDDL(dataset: string, table = 'events'): string {
  const columns = EVENTS_SCHEMA.map((field) => {
    const type = field.type === 'BOOLEAN' ? 'BOOL' : field.type
    const nullability = field.mode === 'REQUIRED' ? ' NOT NULL' : ''
    return `  ${field.name} ${type}${nullability} OPTIONS(description="${field.description.replace(/"/g, "'")}")`
  }).join(',\n')

  return `CREATE TABLE IF NOT EXISTS \`${dataset}.${table}\` (\n${columns}\n)\nPARTITION BY DATE(${PARTITION_FIELD})\nOPTIONS(description="Product analytics events — see github.com/javidjamae/bq-analytics");\n`
}
