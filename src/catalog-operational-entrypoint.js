'use strict';

const {
  CatalogEntrypointError,
  attachShutdownHandlers,
  main: startWithRuntimeFactory,
  startCatalogEntrypoint,
} = require('./catalog-http-entrypoint');
const {
  createOperationalCatalogRuntime,
} = require('./catalog-operational-runtime-factory');

async function startOperationalCatalogEntrypoint({
  env = process.env,
  runtimeFactory = createOperationalCatalogRuntime,
  serverFactory,
} = {}) {
  return startCatalogEntrypoint({ env, runtimeFactory, serverFactory });
}

async function main(options = {}) {
  return startWithRuntimeFactory({
    ...options,
    runtimeFactory: options.runtimeFactory || createOperationalCatalogRuntime,
  });
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
  createOperationalCatalogRuntime,
  main,
  startOperationalCatalogEntrypoint,
};
