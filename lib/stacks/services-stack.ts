import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { IVpc, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { ICluster, Secret as EcsSecret } from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { DatabaseInstance } from 'aws-cdk-lib/aws-rds';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import {
  MicroserviceFargate,
  MicroserviceFargateProps,
} from '../constructs/microservice-fargate';
import { MicroserviceName } from './ecr-stack';

export interface ServicesStackProps extends StackProps {
  vpc: IVpc;
  servicesSecurityGroup: SecurityGroup;
  cluster: ICluster;
  namespace: PrivateDnsNamespace;
  repositories: Record<MicroserviceName, Repository>;
  imageTag: string;
  database: DatabaseInstance;
  dbCredentialsSecret: ISecret;
  redisEndpoint: string;
  redisPort: string;
  authJwksUrl: string;
}

export class ServicesStack extends Stack {
  public readonly alb: ApplicationLoadBalancer;
  public readonly listener: ApplicationListener;

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    this.alb = new ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroup: props.servicesSecurityGroup,
    });

    this.listener = this.alb.addListener('Http', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'application/json',
        messageBody: '{"error":"route not configured"}',
      }),
    });

    const dbHost = props.database.dbInstanceEndpointAddress;
    const dbPort = props.database.dbInstanceEndpointPort;

    const dbUrl = (dbName: string) =>
      `postgresql://leetcode:\${DB_PASSWORD}@${dbHost}:${dbPort}/${dbName}`;

    const redisUrl = `redis://${props.redisEndpoint}:${props.redisPort}`;

    const baseEnv: Record<string, string> = {
      PORT: '8080',
      REDIS_URL: redisUrl,
      AUTH_JWKS_URL: props.authJwksUrl,
      PROBLEMS_SERVICE_URL: 'http://problems.leetcode.local:8080',
      USERS_SERVICE_URL: 'http://users.leetcode.local:8080',
      SUBMISSIONS_SERVICE_URL: 'http://submissions.leetcode.local:8080',
      CONTESTS_SERVICE_URL: 'http://contests.leetcode.local:8080',
      EXECUTOR_SERVICE_URL: 'http://executor.leetcode.local:8080',
    };

    const dbSecret = EcsSecret.fromSecretsManager(props.dbCredentialsSecret, 'password');

    const services: Array<{
      name: MicroserviceName;
      priority: number;
      pathPattern: string;
      dbName: string;
    }> = [
      { name: 'problems-service', priority: 10, pathPattern: '/v1/problems*', dbName: 'problems' },
      { name: 'users-service', priority: 20, pathPattern: '/v1/users*', dbName: 'users' },
      {
        name: 'submissions-service',
        priority: 30,
        pathPattern: '/v1/submissions*',
        dbName: 'submissions',
      },
      { name: 'contests-service', priority: 40, pathPattern: '/v1/contests*', dbName: 'contests' },
    ];

    for (const cfg of services) {
      const svcProps: MicroserviceFargateProps = {
        serviceName: cfg.name,
        cluster: props.cluster,
        namespace: props.namespace,
        repository: props.repositories[cfg.name],
        imageTag: props.imageTag,
        vpc: props.vpc,
        securityGroup: props.servicesSecurityGroup,
        listener: this.listener,
        routePriority: cfg.priority,
        routePathPattern: cfg.pathPattern,
        environment: {
          ...baseEnv,
          DATABASE_URL: dbUrl(cfg.dbName),
        },
        secrets: {
          DB_PASSWORD: dbSecret,
        },
      };
      new MicroserviceFargate(this, `Svc-${cfg.name}`, svcProps);
    }

    new CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
    new CfnOutput(this, 'ListenerArn', { value: this.listener.listenerArn });
  }
}
