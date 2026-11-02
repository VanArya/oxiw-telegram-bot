'use strict';

class CatalogEntrypointError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogEntrypointError';
  }
}

function hasOperationalProviderKinds(runtime) {
  const { getCatalogProviderKind } = require('./catalog-provider-kind');
  return getCatalogProviderKind(runtime.provider) === 'google-sheets' &&
    getCatalogProviderKind(runtime.metadataProvider) === 'firestore-read' &&
    getCatalogProviderKind(runtime.writableProvider) === 'firestore-write';
}

async function createOperationalCatalogApp({
  env = process.env,
  runtimeFactory,
} = {}) {
  if (typeof runtimeFactory !== 'function') {
    throw new CatalogEntrypointError(
      'Catalog API startup blocked: operational runtime factory is not configured.',
    );
  }

  let runtime;
  try {
    runtime = await runtimeFactory({ env });
  } catch {
    throw new CatalogEntrypointError('Catalog API startup blocked: runtime initialization failed.');
  }
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime) ||
      runtime.runtimeMode !== 'operational') {
    throw new CatalogEntrypointError(
      'Catalog API startup blocked: runtime must explicitly declare operational configuration.',
    );
  }
  if (!hasOperationalProviderKinds(runtime)) {
    throw new CatalogEntrypointError(
      'Catalog API startup blocked: runtime providers are not approved operational adapters.',
    );
  }
  if (typeof runtime.app !== 'function') {
    throw new CatalogEntrypointError(
      'Catalog API startup blocked: operational runtime HTTP app is invalid.',
    );
  }

  return runtime.app;
}

async function startCatalogEntrypoint({ env = process.env, runtimeFactory, serverFactory } = {}) {
  const app = await createOperationalCatalogApp({ env, runtimeFactory });
  try {
    const { createCatalogHttpServer } = require('./catalog-http-server');
    const listener = createCatalogHttpServer({
      app,
      port: env.PORT,
      host: '0.0.0.0',
      ...(serverFactory === undefined ? {} : { serverFactory }),
    });
    await listener.start();
    return listener;
  } catch (error) {
    if (error instanceof TypeError && /^PORT must be an integer/.test(error.message)) {
      throw new CatalogEntrypointError(error.message);
    }
    const safeCodes = new Set([
      'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL', 'BIND_FAILED',
    ]);
    if (error?.name === 'CatalogHttpServerError' && safeCodes.has(error.code)) {
      throw new CatalogEntrypointError(`Catalog API listener could not start (${error.code}).`);
    }
    throw new CatalogEntrypointError('Catalog API listener could not start due to invalid configuration.');
  }
}

function attachShutdownHandlers(listener, processObject = process) {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    listener.stop().catch(() => {
      processObject.exitCode = 1;
    });
  };
  processObject.once('SIGINT', shutdown);
  processObject.once('SIGTERM', shutdown);
  return () => {
    processObject.removeListener('SIGINT', shutdown);
    processObject.removeListener('SIGTERM', shutdown);
  };
}

async function main(options) {
  const listener = await startCatalogEntrypoint(options);
  attachShutdownHandlers(listener);
  console.info('Catalog API listener started.');
  return listener;
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof CatalogEntrypointError
      ? error.message
      : 'Catalog API startup failed due to invalid configuration or listener error.';
    console.error(message);
    process.exitCode = 1;
  });
}

module.exports = {
  CatalogEntrypointError,
  attachShutdownHandlers,
  createOperationalCatalogApp,
  main,
  startCatalogEntrypoint,
};
