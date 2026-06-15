// Custom resource Lambda que agrega un redirect_uri "strict" al provider OIDC
// 'leetcode' en Authentik. Reemplaza el wildcard regex del blueprint por el
// dominio CloudFront exacto.
//
// Idempotente: si el URI ya está en la lista, no hace nada.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});

async function getApiToken(secretArn) {
  const cmd = new GetSecretValueCommand({ SecretId: secretArn });
  const res = await secrets.send(cmd);
  // El secret guarda el token raw o un JSON {token: ...}; aceptamos los dos.
  try {
    const parsed = JSON.parse(res.SecretString);
    return parsed.token ?? parsed.value ?? res.SecretString;
  } catch {
    return res.SecretString;
  }
}

async function authentikRequest(baseUrl, token, path, method = 'GET', body = null) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Authentik ${method} ${path} -> ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function findProvider(baseUrl, token, name) {
  const data = await authentikRequest(
    baseUrl,
    token,
    `/api/v3/providers/oauth2/?name=${encodeURIComponent(name)}`,
  );
  const provider = data.results?.find((p) => p.name === name);
  if (!provider) throw new Error(`OAuth2 provider "${name}" not found in Authentik`);
  return provider;
}

async function ensureRedirectUri(baseUrl, token, providerName, callbackUrl) {
  const provider = await findProvider(baseUrl, token, providerName);
  const existing = provider.redirect_uris ?? [];

  const already = existing.some(
    (r) => r.matching_mode === 'strict' && r.url === callbackUrl,
  );
  if (already) {
    console.log(`redirect_uri ${callbackUrl} ya está, skip`);
    return;
  }

  const updated = [...existing, { matching_mode: 'strict', url: callbackUrl }];
  await authentikRequest(baseUrl, token, `/api/v3/providers/oauth2/${provider.pk}/`, 'PATCH', {
    redirect_uris: updated,
  });
  console.log(`agregado strict redirect_uri ${callbackUrl}`);
}

export const handler = async (event) => {
  console.log('event', JSON.stringify(event));
  const { RequestType, ResourceProperties } = event;

  if (RequestType === 'Delete') {
    return { PhysicalResourceId: 'leetcode-authentik-redirect-sync' };
  }

  const {
    AuthentikBaseUrl,
    ApiTokenSecretArn,
    ProviderName = 'leetcode-provider',
    CloudFrontDomain,
  } = ResourceProperties;

  if (!AuthentikBaseUrl || !ApiTokenSecretArn || !CloudFrontDomain) {
    throw new Error('Missing required props');
  }

  const callbackUrl = `https://${CloudFrontDomain}/auth/callback`;
  const token = await getApiToken(ApiTokenSecretArn);

  await ensureRedirectUri(AuthentikBaseUrl, token, ProviderName, callbackUrl);

  return {
    PhysicalResourceId: 'leetcode-authentik-redirect-sync',
    Data: { CallbackUrl: callbackUrl },
  };
};
