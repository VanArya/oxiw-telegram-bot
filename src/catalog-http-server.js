'use strict';

const http = require('node:http');
const { parseCatalogPort } = require('./catalog-http-service');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SAFE_BIND_CODES = new Set([
  'EACCES',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
  'EINVAL',
]);

class CatalogHttpServerError extends Error {
  constructor(code) {
    const safeCode = SAFE_BIND_CODES.has(code) ? code : 'BIND_FAILED';
    super(`Catalog HTTP server could not start (${safeCode}).`);
    this.name = 'CatalogHttpServerError';
    this.code = safeCode;
  }
}

function resolvePort(port, host, allowEphemeralPort) {
  if ((port === 0 || port === '0') && allowEphemeralPort === true && LOOPBACK_HOSTS.has(host)) {
    return 0;
  }
  return parseCatalogPort(port);
}

function createCatalogHttpServer({
  app,
  port = process.env.PORT,
  host = '0.0.0.0',
  serverFactory = http.createServer,
  allowEphemeralPort = false,
} = {}) {
  if (typeof app !== 'function') {
    throw new TypeError('Catalog HTTP server requires an application.');
  }
  if (typeof host !== 'string' || host.trim() === '') {
    throw new TypeError('Catalog HTTP server host is invalid.');
  }
  if (typeof serverFactory !== 'function') {
    throw new TypeError('Catalog HTTP server factory is invalid.');
  }
  const listenPort = resolvePort(port, host, allowEphemeralPort);

  let server;
  try {
    server = serverFactory(app);
  } catch {
    throw new CatalogHttpServerError('BIND_FAILED');
  }
  if (!server || typeof server.listen !== 'function' || typeof server.close !== 'function') {
    throw new TypeError('Catalog HTTP server factory must return a server.');
  }

  let startPromise;
  let stopPromise;

  function start() {
    if (server.listening) return Promise.resolve(server);
    if (startPromise) return startPromise;

    startPromise = new Promise((resolve, reject) => {
      const cleanup = () => {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
      };
      const onError = (error) => {
        cleanup();
        reject(new CatalogHttpServerError(error?.code));
      };
      const onListening = () => {
        cleanup();
        resolve(server);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(listenPort, host);
      } catch (error) {
        onError(error);
      }
    }).finally(() => {
      startPromise = undefined;
    });

    return startPromise;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    if (startPromise) {
      try {
        await startPromise;
      } catch {
        return;
      }
    }
    if (!server.listening) return;

    stopPromise = new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(new CatalogHttpServerError(error?.code));
          return;
        }
        resolve();
      });
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    }).finally(() => {
      stopPromise = undefined;
    });

    return stopPromise;
  }

  return Object.freeze({
    address: () => server.address(),
    server,
    start,
    stop,
  });
}

module.exports = { CatalogHttpServerError, createCatalogHttpServer };
