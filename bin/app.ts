#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ApiGatewayStack } from '../lib/stacks/api-gateway-stack';
import { AuthentikStack } from '../lib/stacks/authentik-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { EcsClusterStack } from '../lib/stacks/ecs-cluster-stack';
import { ExecutorStack } from '../lib/stacks/executor-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { SecretsStack } from '../lib/stacks/secrets-stack';
import { CicdStack } from '../lib/stacks/cicd-stack';
import { ServicesStack } from '../lib/stacks/services-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Tag de imagen para los microservicios. Se setea por contexto en deploy:
//   cdk deploy --all --context imageTag=v1
const imageTag = app.node.tryGetContext('imageTag') ?? 'latest';

// ─── Infra base + Authentik (ya existian) ─────────────────────────────────────
const network = new NetworkStack(app, 'NetworkStack', { env });
const secrets = new SecretsStack(app, 'SecretsStack', { env });

const authentik = new AuthentikStack(app, 'AuthentikStack', {
  env,
  vpc: network.vpc,
  authentikSecretKey: secrets.authentikSecretKey,
});

// ─── Datos compartidos (RDS + Redis) ──────────────────────────────────────────
const data = new DataStack(app, 'DataStack', {
  env,
  vpc: network.vpc,
  dataSecurityGroup: network.dataSecurityGroup,
});

// ─── Registro de imagenes ─────────────────────────────────────────────────────
const ecr = new EcrStack(app, 'EcrStack', { env });

// ─── Cluster + Cloud Map + ALB compartido ─────────────────────────────────────
const ecsCluster = new EcsClusterStack(app, 'EcsClusterStack', {
  env,
  vpc: network.vpc,
});

const authJwksUrl = `http://${authentik.publicIp}:9000/application/o/leetcode/jwks/`;

// ─── 4 servicios Fargate ──────────────────────────────────────────────────────
const services = new ServicesStack(app, 'ServicesStack', {
  env,
  vpc: network.vpc,
  servicesSecurityGroup: network.servicesSecurityGroup,
  cluster: ecsCluster.cluster,
  namespace: ecsCluster.namespace,
  
  repositories: ecr.repositories,
  imageTag,
  database: data.database,
  dbCredentialsSecret: data.dbCredentialsSecret,
  redisEndpoint: data.redisEndpoint,
  redisPort: data.redisPort,
  authJwksUrl,
});
services.addDependency(data);
services.addDependency(ecsCluster);
services.addDependency(ecr);

// ─── executor-service en EC2 (necesita docker socket) ─────────────────────────
const executor = new ExecutorStack(app, 'ExecutorStack', {
  env,
  vpc: network.vpc,
  servicesSecurityGroup: network.servicesSecurityGroup,
  namespace: ecsCluster.namespace,
  repository: ecr.repositories['executor-service'],
  imageTag,
  authJwksUrl,
});
executor.addDependency(ecsCluster);
executor.addDependency(ecr);

// ─── Frontend (S3 + CloudFront) ───────────────────────────────────────────────
const frontend = new FrontendStack(app, 'FrontendStack', { env });

// ─── API Gateway con VPC Link al ALB de servicios ─────────────────────────────
const apiGw = new ApiGatewayStack(app, 'ApiGatewayStack', {
  env,
  authentikPublicIp: authentik.publicIp,
  vpc: network.vpc,
  servicesSecurityGroup: network.servicesSecurityGroup,
  servicesAlb: services.alb,
  servicesListener: services.listener,
  frontendOrigin: `https://${frontend.distribution.distributionDomainName}`,
});
apiGw.addDependency(services);
apiGw.addDependency(authentik);

// CI/CD: OIDC provider + role para GitHub Actions del repo de codigo
new CicdStack(app, 'CicdStack', {
  env,
  githubOwnerRepo: app.node.tryGetContext('githubOwnerRepo') ?? 'Renevc14/Leetcode',
  repositories: ecr.repositories,
});
