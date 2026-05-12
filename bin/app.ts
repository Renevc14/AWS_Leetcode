#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AuthentikStack } from '../lib/stacks/authentik-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { SecretsStack } from '../lib/stacks/secrets-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const network = new NetworkStack(app, 'NetworkStack', { env });
const secrets = new SecretsStack(app, 'SecretsStack', { env });

new AuthentikStack(app, 'AuthentikStack', {
  env,
  vpc: network.vpc,
  authentikSecretKey: secrets.authentikSecretKey,
});
