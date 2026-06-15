# Guía de despliegue para la demo

> Solo infra AWS. El código vive en [Renevc14/Leetcode](https://github.com/Renevc14/Leetcode).

## Costo estimado para 2 h de demo: ~$2 USD

| Recurso | 2 h |
|---|---|
| RDS db.t4g.micro + ElastiCache | $0.06 |
| 4 Fargate (0.25 vCPU, 0.5 GB) | $0.20 |
| 2 EC2 (Authentik t3.small, executor t3.small) | $0.10 |
| ALB compartido | $0.05 |
| CloudFront + S3 | ~$0 |
| **Total** | **~$0.50 + buffer** |

`cdk destroy --all` apenas termine.

## Prerrequisitos

```bash
node --version   # >= 22
aws --version    # >= 2.x
npm install -g aws-cdk

aws sts get-caller-identity
export AWS_REGION=us-east-1
export CDK_DEFAULT_REGION=us-east-1
```

En git-bash en Windows si falla:

```bash
export AWS_SHARED_CREDENTIALS_FILE="/c/Users/<usuario>/.aws/credentials"
export AWS_CONFIG_FILE="/c/Users/<usuario>/.aws/config"
```

## Bootstrap CDK (una sola vez)

```bash
cdk bootstrap
```

## Orden de deploy

### Fase 1 — Infra base + Authentik + datos

```bash
cdk deploy NetworkStack SecretsStack AuthentikStack DataStack EcrStack FrontendStack
```

~10 min. El custom resource Lambda de `DataStack` crea automáticamente las 4 DBs en el RDS (`problems`, `users`, `submissions`, `contests`). No hay que hacer `CREATE DATABASE` manual.

Outputs importantes:

- `AuthentikStack.PublicIp` — EIP de Authentik.
- `DataStack.DbEndpoint`, `DataStack.DbSecretArn`, `DataStack.RedisEndpoint`.
- `EcrStack.Uri-<service>` — URIs para `docker push`.
- `FrontendStack.BucketName`, `FrontendStack.CloudFrontUrl`.

### Fase 2 — Authentik post-deploy

1. Esperá ~3 min después de CREATE_COMPLETE.
2. Reset password de `akadmin` vía SSM:
   ```bash
   aws ssm send-command --instance-ids <id> \
     --document-name "AWS-RunShellScript" \
     --parameters 'commands=["cd /opt/authentik && docker compose exec -T worker ak create_recovery_key 24 akadmin"]'
   ```
3. Verificá que el blueprint corrió:
   ```bash
   curl -s http://<EIP>:9000/application/o/leetcode/.well-known/openid-configuration | head
   ```

### Fase 3 — Build y push de las 5 imágenes Docker

En el repo `Leetcode`:

```bash
export ACCOUNT_ID=<tu-aws-account-id>
export REGION=us-east-1

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

# Los 4 servicios estándar
for svc in problems-service users-service submissions-service contests-service; do
  docker build -f Dockerfile.service --build-arg SERVICE=$svc \
    -t $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/leetcode/$svc:latest .
  docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/leetcode/$svc:latest
done

# Executor
docker build -f microservices/executor-service/Dockerfile \
  -t $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/leetcode/executor-service:latest .
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/leetcode/executor-service:latest
```

### Fase 4 — Cluster + servicios + executor + API Gateway

De vuelta en el repo de infra:

```bash
cdk deploy EcsClusterStack ServicesStack ExecutorStack ApiGatewayStack
```

~8 min. Cuando termine los Fargate tasks estarán `PROVISIONING` → `RUNNING` pero algunos pueden estar `UNHEALTHY` hasta que las migraciones corran. Eso lo arreglamos en la fase 5.

### Fase 5 — Migraciones Prisma

Cada servicio trae sus migrations en `microservices/<svc>/prisma/migrations/`. Las corremos como tarea Fargate one-off override del comando:

```bash
export CLUSTER=leetcode-cluster
export SUBNET=$(aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=NetworkStack/Vpc/publicSubnet1" \
  --query "Subnets[0].SubnetId" --output text)
export SVCS_SG=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=*ServicesSg*" \
  --query "SecurityGroups[0].GroupId" --output text)

for svc in problems users submissions contests; do
  TASK_DEF=$(aws ecs list-task-definitions \
    --family-prefix ServicesStack-Svc${svc}service \
    --status ACTIVE --sort DESC --max-items 1 \
    --query "taskDefinitionArns[0]" --output text | sed 's|.*/||')

  aws ecs run-task \
    --cluster $CLUSTER \
    --launch-type FARGATE \
    --task-definition $TASK_DEF \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SVCS_SG],assignPublicIp=ENABLED}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"app\",\"command\":[\"sh\",\"-c\",\"npx prisma migrate deploy --schema=./prisma/schema.prisma\"]}]}"
done
```

Espera ~30 s cada una, después chequeá:

```bash
aws ecs list-tasks --cluster $CLUSTER --query "taskArns" --output text
aws ecs describe-tasks --cluster $CLUSTER --tasks <arn> --query "tasks[].containers[].exitCode"
```

> Las migraciones son idempotentes; si ya están aplicadas, no hace nada y sale con código 0.

Tras esto, los servicios principales se vuelven `HEALTHY` (los healthchecks del ALB pasan).

### Fase 6 — Frontend al CloudFront + sync de Authentik

Antes de subir el frontend, **necesitamos que Authentik conozca el dominio CloudFront exacto** (el blueprint solo acepta el regex generico, esto lo afina con un strict match).

#### 6a — API token de Authentik

En la UI de Authentik: Directory -> Tokens -> Create. Copy el valor. Despues guardarlo en el secret:

```bash
aws secretsmanager put-secret-value   --secret-id authentik/api-token   --secret-string '<el-token>'
```

#### 6b — Sync del redirect_uri

```bash
cdk deploy AuthentikSyncStack
```

#### 6c — Build del frontend y subida al CloudFront

#### 6c — Frontend al CloudFront

En `Leetcode`:

```bash
cd frontend
cat > .env.production <<ENV
VITE_AUTH_AUTHORITY=http://<EIP>:9000/application/o/leetcode/
VITE_AUTH_CLIENT_ID=leetcode
VITE_AUTH_REDIRECT_URI=https://<cloudfront-url>/auth/callback
VITE_API_BASE_URL=<api-gateway-url>
ENV
pnpm build

aws s3 sync dist/ s3://<bucket-name> --delete
aws cloudfront create-invalidation --distribution-id <dist-id> --paths "/*"
```

**Registrá el `redirect_uri` del CloudFront en Authentik** (UI → Applications → Providers → leetcode-provider → editar redirect URIs) o el callback fallará tras el login.

## Validación post-deploy

```bash
curl -i <api-url>/v1/me                      # 401 sin token
curl -i <api-url>/v1/problems                # debería pegar al ALB y devolver JSON
open <cloudfront-url>                        # frontend
```

Usuarios de prueba (vienen del blueprint):

| User | Password | Roles |
|---|---|---|
| `test-user` | `Test123!` | USER |
| `test-setter` | `Test123!` | USER, SETTER |
| `test-admin` | `Test123!` | USER, SETTER, ADMIN |

## Cleanup post-demo

```bash
cdk destroy --all
```

~15 min. Si algo queda colgado: ECR repos (`--force` para borrarlos con imágenes), CloudFront tarda ~10 min en eliminarse, secrets entran en scheduled deletion con 7 días de recovery.

## Mapa de stacks

| Stack | Recursos | Tiempo deploy |
|---|---|---|
| `NetworkStack` | VPC 2 AZ + SGs | 2 min |
| `SecretsStack` | Secrets para Authentik | 30 s |
| `AuthentikStack` | EC2 + EIP + EBS + blueprint OIDC | 5 min |
| `DataStack` | RDS PostgreSQL + ElastiCache Redis + **Lambda que crea las 4 DBs** | 8 min |
| `EcrStack` | 5 repos ECR | 30 s |
| `EcsClusterStack` | Cluster Fargate + Cloud Map | 1 min |
| `ServicesStack` | ALB + listener + 4 Fargate services | 5 min |
| `ExecutorStack` | EC2 con Docker + EIP | 3 min |
| `FrontendStack` | S3 + CloudFront | 4 min |
| `ApiGatewayStack` | HTTP API + Lambda Authorizer + VPC Link | 2 min |

## Troubleshooting

- **Migration task se queda en `PROVISIONING`**: el subnet ID o el SG ID están mal. Verificá con `describe-subnets` y `describe-security-groups`.
- **Servicio Fargate en `UNHEALTHY` después de migrations**: revisar logs del task en CloudWatch (`/ecs/<service-name>`). Causa común: `DATABASE_URL` malformada (revisar variables de entorno del task definition).
- **CORS error desde el frontend**: registrar el CloudFront URL en `ApiGatewayStack.frontendOrigin` (rebuild de ese stack) **y** en el provider de Authentik.
