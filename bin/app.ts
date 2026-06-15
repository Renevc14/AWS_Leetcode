#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ApiGatewayStack } from '../lib/stacks/api-gateway-stack';
import { AuthentikStack } from '../lib/stacks/authentik-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { EcsClusterStack } from '../lib/stacks/ecs-cluster-stack';
import { ExecutorStack } from '../lib/stacks/executor-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';
import { MigrationsStack } from '../lib/stacks/migrations-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { SecretsStack } from '../lib/stacks/secrets-stack';
import { CicdStack } from '../lib/stacks/cicd-stack';
import { ServicesStack } from '../lib/stacks/services-stack';
import { AuthentikSyncStack } from '../lib/stacks/authentik-sync-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const imageTag = app.node.tryGetContext('imageTag') ?? 'latest';

const network = new NetworkStack(app, 'NetworkStack', { env });
const secrets = new SecretsStack(app, 'SecretsStack', { env });

const authentik = new AuthentikStack(app, 'AuthentikStack', {
  env,
  vpc: network.vpc,
  authentikSecretKey: secrets.authentikSecretKey,
});

const data = new DataStack(app, 'DataStack', {
  env,
  vpc: network.vpc,
  dataSecurityGroup: network.dataSecurityGroup,
});

const ecr = new EcrStack(app, 'EcrStack', { env });

const ecsCluster = new EcsClusterStack(app, 'EcsClusterStack', {
  env,
  vpc: network.vpc,
});

const authJwksUrl = `http://${authentik.publicIp}:9000/application/o/leetcode/jwks/`;

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

const migrations = new MigrationsStack(app, 'MigrationsStack', {
  env,
  vpc: network.vpc,
  cluster: ecsCluster.cluster,
  servicesSecurityGroup: network.servicesSecurityGroup,
  serviceConstructs: services.serviceConstructs,
  imageTag,
});
migrations.addDependency(services);
migrations.addDependency(data);

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

const frontend = new FrontendStack(app, 'FrontendStack', { env });

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

new AuthentikSyncStack(app, 'AuthentikSyncStack', {
  env,
  authentikBaseUrl: `http://${authentik.publicIp}:9000`,
  apiTokenSecret: secrets.authentikApiToken,
  cloudFrontDomain: frontend.distribution.distributionDomainName,
}).addDependency(authentik);

new CicdStack(app, 'CicdStack', {
  env,
  githubOwnerRepo: app.node.tryGetContext('githubOwnerRepo') ?? 'Renevc14/Leetcode',
  repositories: ecr.repositories,
});
