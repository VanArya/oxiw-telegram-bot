'use strict';

(function expose(factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else globalThis.OXIWAuthSessionCoordinator = factory();
}(function createModule() {
  function isAbortError(error) {
    return error?.name === 'AbortError';
  }

  function createAuthSessionCoordinator({
    loadSession,
    onAuthenticated,
    onUnauthenticated,
    onSession,
    onError,
  } = {}) {
    if (typeof loadSession !== 'function' || typeof onAuthenticated !== 'function' ||
        typeof onUnauthenticated !== 'function' || typeof onSession !== 'function' ||
        typeof onError !== 'function') {
      throw new TypeError('Auth session coordinator requires complete callbacks.');
    }

    let generation = 0;
    let active = null;

    function isCurrent(entry) {
      return active === entry && entry.generation === generation && !entry.controller.signal.aborted;
    }

    function cancelActive() {
      if (active) active.controller.abort();
      active = null;
    }

    function invalidate() {
      generation += 1;
      cancelActive();
      onUnauthenticated();
    }

    function transition(user) {
      generation += 1;
      cancelActive();
      if (!user) {
        onUnauthenticated();
        return;
      }

      const entry = {
        generation,
        user,
        controller: new AbortController(),
      };
      active = entry;
      onAuthenticated(user);
      Promise.resolve()
        .then(() => loadSession({ user, signal: entry.controller.signal }))
        .then((data) => {
          if (isCurrent(entry)) onSession(user, data);
        })
        .catch((error) => {
          if (isCurrent(entry) && !isAbortError(error)) onError(error, user);
        });
    }

    return Object.freeze({
      invalidate,
      isCurrent: () => Boolean(active && isCurrent(active)),
      transition,
    });
  }

  return { createAuthSessionCoordinator };
}));
