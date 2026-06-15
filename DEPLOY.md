# Guía de despliegue para la demo

> Este repo solo despliega infraestructura AWS. El código de los microservicios y el frontend vive en [Renevc14/Leetcode](https://github.com/Renevc14/Leetcode). Antes de desplegar acá, asegurate de tener las imágenes Docker buildeadas y subidas a ECR (ver paso 3).

## Costo estimado

Para una demo de **2 horas con tráfico controlado**: ~$2-3 USD. Detalle:

| Recurso | Costo aprox 2 h |
|---|---|
| RDS db.t4g.micro | $0.03 |
| ElastiCache cache.t4g.micro | $0.03 |
| 4 Fargate tasks (0.25 vCPU, 0.5 GB) | $0.20 |
| EC2 t3.small para Authentik + executor | $0.05 |
| ALB compartido | $0.05 |
| CloudFront + S3 | ~$0 |
| Data transfer | < $0.50 |
| **Total** | **< $1** + buffer |

Hacer `cdk destroy --all` apenas termine la demo. RDS no tiene deletion protection ni backup retention.

## Prerrequisitos

```bash
# CLI tools
aws --version    # >= 2.x
node --version   # >= 22
npm install -g aws-cdk  # >= 2.180

# AWS creds configuradas
aws sts get-caller-identity   # devuelve tu account
export AWS_REGION=us-east-1
export CDK_DEFAULT_REGION=us-east-1
```

En git-bash en Windows si hay problemas de credenciales:

```bash
export AWS_SHARED_CREDENTIALS_FILE="/c/Users/<usuario>/.aws/credentials"
export AWS_CONFIG_FILE="/c/Users/<usuario>/.aws/config"
```

## Bootstrap CDK (una sola vez)

```bash
cdk bootstrap
```

## Orden de deploy

El despliegue tiene 3 fases.

### Fase 1 — Infra base y Authentik

```bash
cdk deploy NetworkStack SecretsStack AuthentikStack DataStack EcrStack EcsClusterStack FrontendStack
```

Tarda ~10 min. Los outputs importantes:

- `AuthentikStack.PublicIp` — IP pública de la EC2 con Authentik.
- `DataStack.DbSecretArn`, `DataStack.DbEndpoint`, `DataStack.RedisEndpoint`.
- `EcrStack.Uri-<service>` — URI ECR para cada uno de los 5 servicios.
- `FrontendStack.BucketName`, `FrontendStack.CloudFrontUrl`.

### Fase 2 — Authentik post-deploy

1. **Authentik tarda ~3 min** en levantar tras CREATE_COMPLETE. Verifica:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://<EIP>:9000
   # 302 = listo
   ```
2. **Reset password de `akadmin`** vía SSM:
   ```bash
   aws ssm send-command --instance-ids <id> \
     --document-name "AWS-RunShellScript" \
     --parameters 'commands=["cd /opt/authentik && docker compose exec -T worker ak create_recovery_key 24 akadmin"]'
   # Tomá el command-id, esperá 5s, leé el output con get-command-invocation
   ```
3. **Verifica que el blueprint corrió** (provider OIDC `leetcode` debe existir):
   ```bash
   curl -s http://<EIP>:9000/application/o/leetcode/.well-known/openid-configuration | head
   ```

### Fase 3 — Build y push de las imágenes Docker

En el repo de aplicación (`Leetcode`):

```bash
# Login a ECR
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com

# Build y push de los 5 servicios
for svc in problems-service users-service submissions-service contests-service; do
  docker build -f Dockerfile.service --build-arg SERVICE=$svc \
    -t <account>.dkr.ecr.us-east-1.amazonaws.com/leetcode/$svc:latest .
  docker push <account>.dkr.ecr.us-east-1.amazonaws.com/leetcode/$svc:latest
done

# Executor con su Dockerfile dedicado
docker build -f microservices/executor-service/Dockerfile \
  -t <account>.dkr.ecr.us-east-1.amazonaws.com/leetcode/executor-service:latest .
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/leetcode/executor-service:latest
```

### Fase 4 — Servicios + API Gateway

De regreso en el repo de infra:

```bash
cdk deploy ServicesStack ExecutorStack ApiGatewayStack
```

Tarda ~8 min. Cuando termine:

- Los 4 Fargate tasks deben estar `RUNNING` y `HEALTHY` (verificá en consola ECS).
- El executor (EC2) tarda ~2 min adicionales en bajar la imagen y arrancar.
- `ApiGatewayStack.ApiUrl` te da la URL pública.

### Fase 5 — Frontend al CloudFront

En el repo de aplicación:

```bash
cd frontend
cat > .env.production <<ENV
VITE_AUTH_AUTHORITY=http://<EIP>:9000/application/o/leetcode/
VITE_AUTH_CLIENT_ID=leetcode
VITE_AUTH_REDIRECT_URI=https://<cloudfront-url>/auth/callback
VITE_API_BASE_URL=<api-gateway-url>
ENV
pnpm build

# Subir a S3
aws s3 sync dist/ s3://<bucket-name> --delete
aws cloudfront create-invalidation --distribution-id <dist-id> --paths "/*"
```

Recordá registrar el redirect URI nuevo en Authentik (UI → Applications → Providers → leetcode-provider) o agregarlo al blueprint.

## Validación post-deploy

```bash
# Sin token: 401
curl -i <api-url>/v1/me

# Login al frontend
open <cloudfront-url>
# Usar test-user / Test123! (creados por blueprint)
# Navegar a /problems, /submit, etc.
```

## Cleanup post-demo

**Hacelo apenas termines.** RDS y NAT son los más caros si quedan corriendo.

```bash
cdk destroy --all
```

Tarda ~15 min. Si algo queda colgado (stuck DELETE), revisar:

- ECR: `aws ecr delete-repository --repository-name leetcode/<svc> --force`
- S3: el bucket del frontend tiene `autoDeleteObjects: true`.
- Secrets: entran en `scheduled deletion` con 7 días de recovery (~$0.30 total).
- CloudFront: tarda ~10 min en eliminarse aunque el stack ya esté DELETE_COMPLETE.

## Mapa de stacks

| Stack | Recursos |
|---|---|
| `NetworkStack` | VPC 1 AZ public + SGs (services, data) |
| `SecretsStack` | Secrets para Authentik |
| `DataStack` | RDS PostgreSQL t4g.micro + ElastiCache Redis t4g.micro |
| `EcrStack` | 5 repos ECR |
| `EcsClusterStack` | Cluster Fargate + Cloud Map namespace |
| `ServicesStack` | ALB + listener + 4 Fargate services (problems, users, submissions, contests) |
| `ExecutorStack` | EC2 t3.small con Docker para executor-service |
| `AuthentikStack` | EC2 con Authentik + blueprint |
| `FrontendStack` | S3 + CloudFront |
| `ApiGatewayStack` | HTTP API + Lambda Authorizer + VPC Link al ALB |
