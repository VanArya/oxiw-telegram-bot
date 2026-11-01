'use strict';

const {
  createOperationalCatalogRuntime,
  readOperationalConfiguration,
} = require('./catalog-operational-runtime-factory');
const {
  IDENTITY_SOURCE,
  isServiceAccountPrincipal,
} = require('./google-cloud-adc-trusted-actor-provider');

const CONFIRMATION_VALUE = 'BOOTSTRAP_FIRST_ADMIN';
const SAFE_PROVIDER_CODES = new Set([
  'BOOTSTRAP_ALREADY_COMPLETED',
  'ROLE_CONTROL_MISSING',
  'ROLE_CONTROL_INVALID',
  'ROLE_CONTROL_INCONSISTENT',
  'ROLE_SOURCE_UNAVAILABLE',
  'INVALID_ASSIGNMENT',
]);
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

class CatalogAdminBootstrapError extends Error {
  constructor(code) {
    super('Catalog administrator bootstrap is disabled or could not be completed.');
    this.name = 'CatalogAdminBootstrapError';
    this.code = code;
  }
}

function isStableSubjectId(value) {
  return typeof value === 'string' && SUBJECT_ID_PATTERN.test(value);
}

function parseBootstrapArguments(argv = []) {
  if (!Array.isArray(argv)) throw new CatalogAdminBootstrapError('INVALID_ARGUMENTS');
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--target-subject-id') {
      const value = argv[index + 1];
      if (Object.hasOwn(options, 'targetSubjectId') || value === undefined ||
          typeof value !== 'string' || value.startsWith('--')) {
        throw new CatalogAdminBootstrapError('TARGET_REQUIRED');
      }
      options.targetSubjectId = value;
      index += 1;
      continue;
    }
    if (argument === '--confirm') {
      if (Object.hasOwn(options, 'confirmation')) {
        throw new CatalogAdminBootstrapError('INVALID_ARGUMENTS');
      }
      options.confirmation = argv[index + 1];
      index += 1;
      continue;
    }
    throw new CatalogAdminBootstrapError('INVALID_ARGUMENTS');
  }
  return Object.freeze(options);
}

function validateRequest({ env, targetSubjectId, confirmation }) {
  try {
    readOperationalConfiguration(env);
  } catch {
    throw new CatalogAdminBootstrapError('CONFIGURATION_INVALID');
  }
  if (!isStableSubjectId(targetSubjectId)) {
    throw new CatalogAdminBootstrapError('TARGET_INVALID');
  }
  if (confirmation !== CONFIRMATION_VALUE) {
    throw new CatalogAdminBootstrapError('CONFIRMATION_REQUIRED');
  }
}

async function resolveTrustedActor(trustedActorProvider) {
  // No default is intentional. An actor string from argv or env is not an
  // authentication mechanism and must never reach bootstrapAdministrator().
  if (typeof trustedActorProvider !== 'function') {
    throw new CatalogAdminBootstrapError('TRUSTED_ACTOR_SOURCE_UNCONFIGURED');
  }

  let actor;
  try {
    actor = await trustedActorProvider();
  } catch {
    throw new CatalogAdminBootstrapError('TRUSTED_ACTOR_UNAVAILABLE');
  }
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) ||
      Object.keys(actor).length !== 3 ||
      Object.keys(actor).some((key) => !['actorId', 'actorType', 'identitySource'].includes(key)) ||
      !isServiceAccountPrincipal(actor.actorId) || actor.actorType !== 'service_account' ||
      actor.identitySource !== IDENTITY_SOURCE) {
    throw new CatalogAdminBootstrapError('TRUSTED_ACTOR_INVALID');
  }
  return actor;
}

async function resolveTrustedApproval(trustedApprovalProvider) {
  if (typeof trustedApprovalProvider !== 'function') {
    throw new CatalogAdminBootstrapError('TRUSTED_APPROVAL_SOURCE_UNCONFIGURED');
  }
  let approval;
  try {
    approval = await trustedApprovalProvider();
  } catch {
    throw new CatalogAdminBootstrapError('TRUSTED_APPROVAL_UNAVAILABLE');
  }
  if (!approval || typeof approval !== 'object' || Array.isArray(approval) ||
      Object.keys(approval).length !== 3 ||
      Object.keys(approval).some((key) => !['ownerId', 'approverId', 'approvalReference'].includes(key)) ||
      !isStableSubjectId(approval.ownerId) || !isStableSubjectId(approval.approverId) ||
      approval.ownerId === approval.approverId ||
      typeof approval.approvalReference !== 'string' ||
      approval.approvalReference.trim() !== approval.approvalReference ||
      approval.approvalReference.length === 0 || approval.approvalReference.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(approval.approvalReference)) {
    throw new CatalogAdminBootstrapError('TRUSTED_APPROVAL_INVALID');
  }
  return approval;
}

async function executeCatalogAdminBootstrap({
  env = process.env,
  targetSubjectId,
  confirmation,
  trustedActorProvider,
  trustedApprovalProvider,
  runtimeFactory = createOperationalCatalogRuntime,
} = {}) {
  validateRequest({ env, targetSubjectId, confirmation });
  const actor = await resolveTrustedActor(trustedActorProvider);
  const approval = await resolveTrustedApproval(trustedApprovalProvider);
  if (typeof runtimeFactory !== 'function') {
    throw new CatalogAdminBootstrapError('RUNTIME_FACTORY_INVALID');
  }

  let runtime;
  try {
    runtime = await runtimeFactory({ env });
  } catch {
    throw new CatalogAdminBootstrapError('RUNTIME_UNAVAILABLE');
  }
  if (!runtime || runtime.runtimeMode !== 'operational' ||
      typeof runtime.roleProvider?.bootstrapAdministrator !== 'function') {
    throw new CatalogAdminBootstrapError('RUNTIME_NOT_OPERATIONAL');
  }

  try {
    return await runtime.roleProvider.bootstrapAdministrator({
      actor,
      approval,
      targetSubjectId,
    });
  } catch (error) {
    if (SAFE_PROVIDER_CODES.has(error?.code)) {
      throw new CatalogAdminBootstrapError(error.code);
    }
    throw new CatalogAdminBootstrapError('BOOTSTRAP_FAILED');
  }
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  runtimeFactory,
  trustedActorProvider,
  trustedApprovalProvider,
} = {}) {
  const argumentsObject = parseBootstrapArguments(argv);
  return executeCatalogAdminBootstrap({
    env,
    runtimeFactory,
    trustedActorProvider,
    trustedApprovalProvider,
    targetSubjectId: argumentsObject.targetSubjectId,
    confirmation: argumentsObject.confirmation,
  });
}

if (require.main === module) {
  main().catch((error) => {
    const code = error instanceof CatalogAdminBootstrapError
      ? error.code
      : 'BOOTSTRAP_FAILED';
    process.stderr.write(`Catalog administrator bootstrap blocked (${code}).\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CatalogAdminBootstrapError,
  CONFIRMATION_VALUE,
  executeCatalogAdminBootstrap,
  isStableSubjectId,
  main,
  parseBootstrapArguments,
  validateRequest,
};
