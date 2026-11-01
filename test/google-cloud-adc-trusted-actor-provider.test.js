'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  IDENTITY_SOURCE,
  TrustedActorProviderError,
  createGoogleCloudAdcTrustedActorProvider,
} = require('../src/google-cloud-adc-trusted-actor-provider');

const EXPECTED = 'catalog-bootstrap@oxiw-provisioning.iam.gserviceaccount.com';

class FakeImpersonatedClient {
  constructor(principal = EXPECTED, tokenResponse = { token: 'synthetic-token' }, error) {
    this.principal = principal;
    this.tokenResponse = tokenResponse;
    this.error = error;
  }

  getTargetPrincipal() { return this.principal; }

  async getAccessToken() {
    if (this.error) throw this.error;
    return this.tokenResponse;
  }
}

function makeProvider(client) {
  return createGoogleCloudAdcTrustedActorProvider({
    googleAuthFactory: async () => ({ getClient: async () => client }),
    impersonatedClientClass: FakeImpersonatedClient,
    expectedServiceAccount: EXPECTED,
  });
}

test('accepts only a usable ADC impersonated client for the allowlisted service account', async () => {
  const actor = await makeProvider(new FakeImpersonatedClient())();
  assert.deepEqual(actor, {
    actorId: EXPECTED,
    actorType: 'service_account',
    identitySource: IDENTITY_SOURCE,
  });
  assert.equal(JSON.stringify(actor).includes('synthetic-token'), false);
});

test('rejects ADC clients that are not the SDK impersonated credential type', async () => {
  const provider = createGoogleCloudAdcTrustedActorProvider({
    googleAuthFactory: async () => ({ getClient: async () => ({ getAccessToken: async () => ({ token: 'x' }) }) }),
    impersonatedClientClass: FakeImpersonatedClient,
    expectedServiceAccount: EXPECTED,
  });
  await assert.rejects(provider(), (error) => error instanceof TrustedActorProviderError &&
    error.code === 'ADC_IMPERSONATION_REQUIRED');
});

test('rejects a different impersonated service account before exchanging a token', async () => {
  const client = new FakeImpersonatedClient('oxiw-catalog-runtime@oxiw.iam.gserviceaccount.com');
  let tokenCalls = 0;
  client.getAccessToken = async () => { tokenCalls += 1; return { token: 'synthetic-token' }; };
  await assert.rejects(makeProvider(client)(), (error) => error instanceof TrustedActorProviderError &&
    error.code === 'ADC_IMPERSONATED_SERVICE_ACCOUNT_MISMATCH');
  assert.equal(tokenCalls, 0);
});

test('fails closed when ADC construction, exchange, or token response fails', async (t) => {
  await t.test('ADC lookup error', async () => {
    const provider = createGoogleCloudAdcTrustedActorProvider({
      googleAuthFactory: async () => { throw new Error('private credential detail'); },
      impersonatedClientClass: FakeImpersonatedClient,
      expectedServiceAccount: EXPECTED,
    });
    await assert.rejects(provider(), (error) => error.code === 'ADC_VERIFICATION_FAILED' &&
      !error.message.includes('private credential detail'));
  });
  await t.test('impersonation exchange error', async () => {
    await assert.rejects(
      makeProvider(new FakeImpersonatedClient(EXPECTED, undefined, new Error('private exchange detail')))(),
      (error) => error.code === 'ADC_VERIFICATION_FAILED' &&
        !error.message.includes('private exchange detail'),
    );
  });
  await t.test('missing token', async () => {
    await assert.rejects(makeProvider(new FakeImpersonatedClient(EXPECTED, {}))(),
      (error) => error.code === 'ADC_IMPERSONATION_TOKEN_UNAVAILABLE');
  });
});

test('requires an explicit allowlisted principal and SDK dependencies', () => {
  assert.throws(() => createGoogleCloudAdcTrustedActorProvider({}), TypeError);
  assert.throws(() => createGoogleCloudAdcTrustedActorProvider({
    googleAuthFactory: async () => ({}),
    impersonatedClientClass: FakeImpersonatedClient,
    expectedServiceAccount: 'oxiw-catalog-runtime@project.iam.gserviceaccount.com',
  }), TypeError);
});
