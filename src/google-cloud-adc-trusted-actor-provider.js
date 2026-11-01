'use strict';

const IDENTITY_SOURCE = 'google_cloud_adc_service_account_impersonation';
const SERVICE_ACCOUNT_PATTERN = /^[A-Za-z0-9-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/;

class TrustedActorProviderError extends Error {
  constructor(code) {
    super('Trusted bootstrap actor could not be verified.');
    this.name = 'TrustedActorProviderError';
    this.code = code;
  }
}

function isServiceAccountPrincipal(value) {
  return typeof value === 'string' && SERVICE_ACCOUNT_PATTERN.test(value);
}

function createGoogleCloudAdcTrustedActorProvider({
  googleAuthFactory,
  impersonatedClientClass,
  expectedServiceAccount,
} = {}) {
  if (typeof googleAuthFactory !== 'function' ||
      typeof impersonatedClientClass !== 'function' ||
      !isServiceAccountPrincipal(expectedServiceAccount) ||
      expectedServiceAccount.split('@', 1)[0] === 'oxiw-catalog-runtime') {
    throw new TypeError('Invalid Google Cloud ADC trusted actor provider configuration.');
  }

  return async function trustedActorProvider() {
    try {
      const googleAuth = await googleAuthFactory();
      if (!googleAuth || typeof googleAuth.getClient !== 'function') {
        throw new TrustedActorProviderError('ADC_CLIENT_UNAVAILABLE');
      }
      const client = await googleAuth.getClient();
      if (!(client instanceof impersonatedClientClass) ||
          typeof client.getTargetPrincipal !== 'function' ||
          typeof client.getAccessToken !== 'function') {
        throw new TrustedActorProviderError('ADC_IMPERSONATION_REQUIRED');
      }

      const effectivePrincipal = client.getTargetPrincipal();
      if (effectivePrincipal !== expectedServiceAccount) {
        throw new TrustedActorProviderError('ADC_IMPERSONATED_SERVICE_ACCOUNT_MISMATCH');
      }

      // Force the Google IAM impersonation exchange. Never return or log the token.
      const tokenResponse = await client.getAccessToken();
      if (!tokenResponse || typeof tokenResponse.token !== 'string' || !tokenResponse.token) {
        throw new TrustedActorProviderError('ADC_IMPERSONATION_TOKEN_UNAVAILABLE');
      }

      return Object.freeze({
        actorId: effectivePrincipal,
        actorType: 'service_account',
        identitySource: IDENTITY_SOURCE,
      });
    } catch (error) {
      if (error instanceof TrustedActorProviderError) throw error;
      throw new TrustedActorProviderError('ADC_VERIFICATION_FAILED');
    }
  };
}

module.exports = {
  IDENTITY_SOURCE,
  TrustedActorProviderError,
  createGoogleCloudAdcTrustedActorProvider,
  isServiceAccountPrincipal,
};
