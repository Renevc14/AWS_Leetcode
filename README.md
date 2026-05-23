# AWS_Leetcode — Infraestructura

Stacks de AWS CDK para el sistema de autenticación y autorización del proyecto **Leetcode** (materia Arquitectura y Microservicios, Maestría FullStack UCB).

El frontend, los docs y el resto del proyecto viven en el repo principal: https://github.com/Renevc14/Leetcode

## Stacks

| Stack | Qué hace | Costo aprox/mes |
|---|---|---|
| **NetworkStack** | VPC con 1 AZ + 1 subnet pública (sin NAT Gateway). | $0 |
| **SecretsStack** | `AUTHENTIK_SECRET_KEY` y client secret OIDC en Secrets Manager. | ~$0.80 |
| **AuthentikStack** | EC2 `t4g.small` con `docker-compose` corriendo Authentik server + worker + Postgres + Redis. Blueprint YAML aplicado en boot. | ~$16.6 |
| **ApiGatewayStack** | HTTP API V2 + Lambda Authorizer que valida JWT contra el JWKS de Authentik. Endpoint mock `GET /v1/me`. | ~$0 (free tier) |

**Total: ~$17.40/mes corriendo 24/7.**

## Quick start

```bash
git clone https://github.com/Renevc14/AWS_Leetcode.git
cd AWS_Leetcode
npm install

# Bootstrap (una sola vez por cuenta/región)
npx cdk bootstrap

# Sintetizar templates sin desplegar
npx cdk synth --all

# Desplegar todo (~5 min incluyendo arranque de Authentik)
npx cdk deploy NetworkStack SecretsStack AuthentikStack --require-approval never
# Esperar ~3 min al arranque del container, después:
npx cdk deploy ApiGatewayStack --require-approval never
```

## Validación local

```bash
npm run lint
npm run format:check
npm test                 # 16/16
npx cdk synth --all
```

## Bajar la infra

```bash
npx cdk destroy --all --force
```

## Docs

La documentación completa (arquitectura, flow OIDC, setup paso a paso, configuración manual de Authentik, troubleshooting) está en el repo principal:

- [docs/architecture.md](https://github.com/Renevc14/Leetcode/blob/main/docs/architecture.md)
- [docs/setup.md](https://github.com/Renevc14/Leetcode/blob/main/docs/setup.md)
- [docs/authentik-config.md](https://github.com/Renevc14/Leetcode/blob/main/docs/authentik-config.md)
- [docs/troubleshooting.md](https://github.com/Renevc14/Leetcode/blob/main/docs/troubleshooting.md)

## Notas

- Región AWS sugerida: `us-east-1`.
- En git-bash en Windows puede ser necesario exportar `AWS_SHARED_CREDENTIALS_FILE` y `AWS_CONFIG_FILE` apuntando a `/c/Users/<user>/.aws/`. Detalle en el doc de troubleshooting.
- El primer arranque requiere generar el password de `akadmin` con SSM (ver doc de setup).
