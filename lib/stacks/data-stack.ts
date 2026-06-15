import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  SecurityGroup,
  SubnetType,
} from 'aws-cdk-lib/aws-ec2';
import { CfnCacheCluster, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
} from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

export interface DataStackProps extends StackProps {
  vpc: IVpc;
  dataSecurityGroup: SecurityGroup;
}

/**
 * Capa de datos compartida + bootstrap automatico de las 4 databases logicas.
 *   - 1 RDS PostgreSQL t4g.micro con 4 databases (problems, users, submissions,
 *     contests). Cada microservicio se conecta a su DB; Prisma maneja el schema.
 *   - 1 ElastiCache Redis cache.t4g.micro compartido.
 *   - Custom resource Lambda que ejecuta CREATE DATABASE para cada una al hacer
 *     cdk deploy DataStack (idempotente, no falla si ya existen).
 */
export class DataStack extends Stack {
  public readonly database: DatabaseInstance;
  public readonly dbCredentialsSecret: Secret;
  public readonly redisEndpoint: string;
  public readonly redisPort: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.dbCredentialsSecret = new Secret(this, 'DbMasterCreds', {
      secretName: 'leetcode/db-master',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'leetcode' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    this.database = new DatabaseInstance(this, 'Postgres', {
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_17_2 }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [props.dataSecurityGroup],
      credentials: Credentials.fromSecret(this.dbCredentialsSecret),
      databaseName: 'leetcode',
      allocatedStorage: 20,
      multiAz: false,
      publiclyAccessible: false,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      backupRetention: Duration.days(0),
    });

    // ─── Lambda custom resource: crea las 4 DBs logicas ─────────────────────
    const bootstrapHandler = new LambdaFunction(this, 'DbBootstrapFn', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.minutes(2),
      memorySize: 256,
      // VPC para alcanzar el RDS (en public, mismo SG de datos)
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      allowPublicSubnet: true,
      securityGroups: [props.dataSecurityGroup],
      code: Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'db-bootstrap')),
      logRetention: RetentionDays.ONE_DAY,
    });

    this.dbCredentialsSecret.grantRead(bootstrapHandler);

    const provider = new Provider(this, 'DbBootstrapProvider', {
      onEventHandler: bootstrapHandler,
      logRetention: RetentionDays.ONE_DAY,
    });

    const bootstrap = new CustomResource(this, 'DbBootstrap', {
      serviceToken: provider.serviceToken,
      properties: {
        DbHost: this.database.dbInstanceEndpointAddress,
        DbPort: this.database.dbInstanceEndpointPort,
        SecretArn: this.dbCredentialsSecret.secretArn,
        Databases: ['problems', 'users', 'submissions', 'contests'],
        // Trigger update si cambia el secret (rotacion) o se requiere re-run manual
        Version: '1',
      },
    });
    bootstrap.node.addDependency(this.database);

    // ─── ElastiCache Redis ──────────────────────────────────────────────────
    const redisSubnetGroup = new CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group para Redis',
      subnetIds: props.vpc.publicSubnets.map((s) => s.subnetId),
    });

    const redis = new CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      vpcSecurityGroupIds: [props.dataSecurityGroup.securityGroupId],
      cacheSubnetGroupName: redisSubnetGroup.ref,
    });

    this.redisEndpoint = redis.attrRedisEndpointAddress;
    this.redisPort = redis.attrRedisEndpointPort;

    new CfnOutput(this, 'DbEndpoint', { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DbSecretArn', { value: this.dbCredentialsSecret.secretArn });
    new CfnOutput(this, 'RedisEndpoint', { value: this.redisEndpoint });
    new CfnOutput(this, 'RedisPort', { value: this.redisPort });
  }
}
