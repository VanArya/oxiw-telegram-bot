'use strict';

const { Firestore } = require('@google-cloud/firestore');
const { createFirestoreCatalogAuditEventSink } = require('../src/firestore-catalog-audit-event-sink');
const { repairInvalidMetadataVersions } = require('../src/firestore-metadata-version-migration');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  return { apply };
}

function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const actorId = process.env.CATALOG_MIGRATION_TRUSTED_ACTOR_ID;
  const projectId = process.env.CATALOG_GCP_PROJECT_ID;
  const databaseId = process.env.CATALOG_FIRESTORE_DATABASE_ID || '(default)';
  if (typeof projectId !== 'string' || projectId.trim() === '' ||
      (apply && (process.env.CATALOG_MIGRATION_CONFIRM !== 'REPAIR_INVALID_METADATA_VERSIONS' || !actorId))) {
    process.stdout.write(JSON.stringify({ category: 'INCOMPLETE_CONFIGURATION', dryRun: !apply }) + '\n');
    process.exitCode = 1;
    return;
  }
  const firestore = new Firestore({ projectId, databaseId });
  const sink = createFirestoreCatalogAuditEventSink({ firestore });
  repairInvalidMetadataVersions({ firestore, auditEventSink: sink, actorId, dryRun: !apply })
    .then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); })
    .catch(() => { process.stdout.write('{"category":"MIGRATION_FAILED"}\n'); process.exitCode = 1; });
}

if (require.main === module) main();

module.exports = { parseArgs };
