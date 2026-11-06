'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAuthSessionCoordinator } = require('../admin-web/auth-session-coordinator');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function makeCoordinator(loadSession, events) {
  return createAuthSessionCoordinator({
    loadSession,
    onAuthenticated: (user) => events.push(['authenticated', user.id]),
    onUnauthenticated: () => events.push(['unauthenticated']),
    onSession: (user, data) => events.push(['session', user.id, data]),
    onError: (error, user) => events.push(['error', user.id, error.code]),
  });
}

test('ignores a late /me success after logout and aborts the old request', async () => {
  const pending = deferred();
  const events = [];
  const coordinator = makeCoordinator(() => pending.promise, events);
  const user = { id: 'first' };

  coordinator.transition(user);
  await flush();
  coordinator.transition(null);
  pending.resolve({ roles: ['administrator'] });
  await flush();

  assert.deepEqual(events, [['authenticated', 'first'], ['unauthenticated']]);
  assert.equal(coordinator.isCurrent(), false);
});

test('ignores the first account when a second account becomes current', async () => {
  const first = deferred();
  const second = deferred();
  const pending = new Map([['first', first], ['second', second]]);
  const events = [];
  const coordinator = makeCoordinator(({ user }) => pending.get(user.id).promise, events);

  coordinator.transition({ id: 'first' });
  await flush();
  coordinator.transition({ id: 'second' });
  first.resolve({ roles: ['administrator'] });
  await flush();
  second.resolve({ roles: ['observer'] });
  await flush();

  assert.deepEqual(events, [
    ['authenticated', 'first'],
    ['authenticated', 'second'],
    ['session', 'second', { roles: ['observer'] }],
  ]);
});

test('ignores a late error from a previous account', async () => {
  const first = deferred();
  const second = deferred();
  const events = [];
  const coordinator = makeCoordinator(({ user }) => (user.id === 'first' ? first.promise : second.promise), events);

  coordinator.transition({ id: 'first' });
  await flush();
  coordinator.transition({ id: 'second' });
  first.reject(Object.assign(new Error('stale'), { code: 'STALE' }));
  await flush();
  second.resolve({ roles: ['observer'] });
  await flush();

  assert.deepEqual(events, [
    ['authenticated', 'first'],
    ['authenticated', 'second'],
    ['session', 'second', { roles: ['observer'] }],
  ]);
});

test('applies an error for the current account', async () => {
  const pending = deferred();
  const events = [];
  const coordinator = makeCoordinator(() => pending.promise, events);
  coordinator.transition({ id: 'current' });
  await flush();
  pending.reject(Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }));
  await flush();

  assert.deepEqual(events, [
    ['authenticated', 'current'],
    ['error', 'current', 'FORBIDDEN'],
  ]);
});

test('explicit invalidation blocks a late response even without a Firebase callback', async () => {
  const pending = deferred();
  const events = [];
  const coordinator = makeCoordinator(() => pending.promise, events);
  coordinator.transition({ id: 'current' });
  await flush();
  coordinator.invalidate();
  pending.resolve({ roles: ['administrator'] });
  await flush();

  assert.deepEqual(events, [['authenticated', 'current'], ['unauthenticated']]);
});
