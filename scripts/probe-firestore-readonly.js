'use strict';

const { Firestore } = require('@google-cloud/firestore');

const DEFAULT_TIMEOUT_MS = 15000;
const TERMINATE_TIMEOUT_MS = 2000;
const PROJECT_ID_ENV = 'CATALOG_GCP_PROJECT_ID';
const DATABASE_ID_ENV = 'CATALOG_FIRESTORE_DATABASE_ID';

class ProbeTimeoutError extends Error {
  constructor() {
    super('Firestore read-only probe timed out.');
    this.name = 'ProbeTimeoutError';
  }
}

function isProjectId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

function isDatabaseId(value) {
  return value === '(default)' ||
    (typeof value === 'string' && /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(value));
}

function getExplicitTarget(env) {
  const projectId = env?.[PROJECT_ID_ENV];
  const databaseId = env?.[DATABASE_ID_ENV];
  if (!isProjectId(projectId) || !isDatabaseId(databaseId)) return null;
  return { projectId, databaseId };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function isCode(code, numeric, symbolic) {
  return code === numeric || code === String(numeric) || code === symbolic;
}

function classifyError(error) {
  if (error instanceof ProbeTimeoutError) return 'NETWORK_OR_TIMEOUT';
  const code = error && (error.code ?? error.status ?? error.statusCode);
  if (isCode(code, 7, 'PERMISSION_DENIED')) return 'PERMISSION_DENIED';
  if (isCode(code, 16, 'UNAUTHENTICATED')) return 'AUTHENTICATION_FAILED';
  if (isCode(code, 4, 'DEADLINE_EXCEEDED') || isCode(code, 14, 'UNAVAILABLE')) {
    return 'NETWORK_OR_TIMEOUT';
  }

  const text = [error?.name, error?.code, error?.message]
    .filter((part) => typeof part === 'string')
    .join(' ');
  if (/could not load the default credentials|no application default credentials|invalid_grant|invalid jwt|unauthenticated|authentication failed/i.test(text)) {
    return 'AUTHENTICATION_FAILED';
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|deadline exceeded|timed out|unavailable/i.test(text)) {
    return 'NETWORK_OR_TIMEOUT';
  }
  return 'UNKNOWN_ERROR';
}

async function terminateClient(client) {
  if (!client || typeof client.terminate !== 'function') return;
  try {
    await withTimeout(Promise.resolve().then(() => client.terminate()), TERMINATE_TIMEOUT_MS);
  } catch {
    // The diagnostic result must stay generic if client cleanup fails.
  }
}

async function probeFirestoreReadOnly({
  env = process.env,
  FirestoreClass = Firestore,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const target = getExplicitTarget(env);
  if (!target || typeof FirestoreClass !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Object.freeze({ category: 'INCOMPLETE_CONFIGURATION' });
  }

  let client;
  let result;
  try {
    // Explicit target IDs prevent SDK project/database inference. The SDK uses ADC.
    client = new FirestoreClass(target);
    if (!client || typeof client.listCollections !== 'function') {
      return Object.freeze({ category: 'UNKNOWN_ERROR' });
    }
    const collections = await withTimeout(client.listCollections(), timeoutMs);
    if (!Array.isArray(collections)) return Object.freeze({ category: 'UNKNOWN_ERROR' });
    result = Object.freeze({ category: 'SUCCESS', collectionCount: collections.length });
  } catch (error) {
    result = Object.freeze({ category: classifyError(error) });
  } finally {
    await terminateClient(client);
  }
  return result;
}

async function main() {
  const result = await probeFirestoreReadOnly();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.category !== 'SUCCESS') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write('{"category":"UNKNOWN_ERROR"}\n');
    process.exitCode = 1;
  });
}

module.exports = {
  DATABASE_ID_ENV,
  DEFAULT_TIMEOUT_MS,
  PROJECT_ID_ENV,
  probeFirestoreReadOnly,
};
