/**
 * Server-only entry point. Everything here either loads the BigQuery SDK or
 * uses node:crypto, so it is kept out of the root export to stay clear of
 * browser bundles.
 */
export { BigQuerySink, buildRow, defaultDataset } from './sinks/bigquery.js'
export type { BigQueryLike, BigQuerySinkOptions } from './sinks/bigquery.js'
export { createIngestHandler } from './handler.js'
export type { IngestHandlerOptions } from './handler.js'
