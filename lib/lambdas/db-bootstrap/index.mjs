// Custom resource Lambda que crea las 4 databases logicas en el RDS compartido.
// Idempotente: si la DB ya existe, no hace nada.
//
// Trigger:
//   - CREATE / UPDATE: lee el secret de credenciales master + lista de DBs,
//     y ejecuta CREATE DATABASE para cada una que no exista.
//   - DELETE: no-op (no borramos las DBs por seguridad — si el operador quiere
//     que las DBs desaparezcan, basta con cdk destroy DataStack que se lleva
//     la instancia entera).

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

const { Client } = pg;

const secretsClient = new SecretsManagerClient({});

async function ensureDatabases({ host, port, secretArn, databases }) {
  const cmd = new GetSecretValueCommand({ SecretId: secretArn });
  const res = await secretsClient.send(cmd);
  const creds = JSON.parse(res.SecretString);

  const client = new Client({
    host,
    port: Number(port),
    user: creds.username,
    password: creds.password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
  });

  await client.connect();
  try {
    for (const db of databases) {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
      if (existing.rowCount === 0) {
        // No se pueden parametrizar identificadores; hardcodeamos un allowlist arriba.
        await client.query(`CREATE DATABASE "${db}"`);
        console.log(`created database ${db}`);
      } else {
        console.log(`database ${db} already exists`);
      }
    }
  } finally {
    await client.end();
  }
}

export const handler = async (event) => {
  console.log('event', JSON.stringify(event));
  const { RequestType, ResourceProperties } = event;

  if (RequestType === 'Delete') {
    return { PhysicalResourceId: ResourceProperties.PhysicalResourceId ?? 'db-bootstrap' };
  }

  const allowlist = new Set(['problems', 'users', 'submissions', 'contests']);
  const requested = ResourceProperties.Databases ?? [];
  const databases = requested.filter((d) => allowlist.has(d));
  if (databases.length !== requested.length) {
    throw new Error(`databases must be one of ${[...allowlist].join(', ')}`);
  }

  await ensureDatabases({
    host: ResourceProperties.DbHost,
    port: ResourceProperties.DbPort,
    secretArn: ResourceProperties.SecretArn,
    databases,
  });

  return {
    PhysicalResourceId: 'leetcode-db-bootstrap',
    Data: { Created: databases.join(',') },
  };
};
