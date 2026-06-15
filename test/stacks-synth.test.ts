import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiGatewayStack } from '../lib/stacks/api-gateway-stack';
import { AuthentikStack } from '../lib/stacks/authentik-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { EcsClusterStack } from '../lib/stacks/ecs-cluster-stack';
import { ExecutorStack } from '../lib/stacks/executor-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { SecretsStack } from '../lib/stacks/secrets-stack';
import { ServicesStack } from '../lib/stacks/services-stack';

describe('CDK stacks sintetizan sin errores', () => {
  const app = new App();

  const network = new NetworkStack(app, 'TestNetworkStack');
  const secrets = new SecretsStack(app, 'TestSecretsStack');
  new AuthentikStack(app, 'TestAuthentikStack', {
    vpc: network.vpc,
    authentikSecretKey: secrets.authentikSecretKey,
  });
  const data = new DataStack(app, 'TestDataStack', {
    vpc: network.vpc,
    dataSecurityGroup: network.dataSecurityGroup,
  });
  const ecr = new EcrStack(app, 'TestEcrStack');
  const ecsCluster = new EcsClusterStack(app, 'TestEcsClusterStack', { vpc: network.vpc });
  const services = new ServicesStack(app, 'TestServicesStack', {
    vpc: network.vpc,
    servicesSecurityGroup: network.servicesSecurityGroup,
    cluster: ecsCluster.cluster,
    namespace: ecsCluster.namespace,
    repositories: ecr.repositories,
    imageTag: 'test',
    database: data.database,
    dbCredentialsSecret: data.dbCredentialsSecret,
    redisEndpoint: 'redis.test',
    redisPort: '6379',
    authJwksUrl: 'http://authentik.test/jwks',
  });
  const executor = new ExecutorStack(app, 'TestExecutorStack', {
    vpc: network.vpc,
    servicesSecurityGroup: network.servicesSecurityGroup,
    namespace: ecsCluster.namespace,
    repository: ecr.repositories['executor-service'],
    imageTag: 'test',
    authJwksUrl: 'http://authentik.test/jwks',
  });
  const frontend = new FrontendStack(app, 'TestFrontendStack');
  const apiGw = new ApiGatewayStack(app, 'TestApiGatewayStack', {
    authentikPublicIp: '203.0.113.10',
    vpc: network.vpc,
    servicesSecurityGroup: network.servicesSecurityGroup,
    servicesAlb: services.alb,
    servicesListener: services.listener,
  });

  it('NetworkStack tiene 1 VPC y 2 SGs', () => {
    const t = Template.fromStack(network);
    t.resourceCountIs('AWS::EC2::VPC', 1);
    t.resourceCountIs('AWS::EC2::SecurityGroup', 2);
  });

  it('SecretsStack tiene 2 secrets', () => {
    const t = Template.fromStack(secrets);
    t.resourceCountIs('AWS::SecretsManager::Secret', 2);
  });

  it('DataStack tiene RDS + Redis + Lambda bootstrap', () => {
    const t = Template.fromStack(data);
    t.resourceCountIs('AWS::RDS::DBInstance', 1);
    t.resourceCountIs('AWS::ElastiCache::CacheCluster', 1);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });

  it('EcrStack tiene 5 repos', () => {
    const t = Template.fromStack(ecr);
    t.resourceCountIs('AWS::ECR::Repository', 5);
  });

  it('EcsClusterStack tiene Cluster + Cloud Map namespace', () => {
    const t = Template.fromStack(ecsCluster);
    t.resourceCountIs('AWS::ECS::Cluster', 1);
    t.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 1);
  });

  it('ServicesStack tiene ALB + 4 services + 4 task definitions', () => {
    const t = Template.fromStack(services);
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    t.resourceCountIs('AWS::ECS::Service', 4);
    t.resourceCountIs('AWS::ECS::TaskDefinition', 4);
  });

  it('ExecutorStack tiene EC2 + EIP + Cloud Map service e instance registrada', () => {
    const t = Template.fromStack(executor);
    t.resourceCountIs('AWS::EC2::Instance', 1);
    t.resourceCountIs('AWS::EC2::EIP', 1);
    t.resourceCountIs('AWS::ServiceDiscovery::Service', 1);
    t.resourceCountIs('AWS::ServiceDiscovery::Instance', 1);
  });

  it('FrontendStack tiene S3 bucket + CloudFront distribution', () => {
    const t = Template.fromStack(frontend);
    t.resourceCountIs('AWS::S3::Bucket', 1);
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('ApiGatewayStack tiene HTTP API + VPC Link + Lambda authorizer', () => {
    const t = Template.fromStack(apiGw);
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    t.resourceCountIs('AWS::ApiGatewayV2::VpcLink', 1);
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
    });
  });
});
