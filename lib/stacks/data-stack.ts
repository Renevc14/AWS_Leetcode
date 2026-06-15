import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  SecurityGroup,
  SubnetType,
} from 'aws-cdk-lib/aws-ec2';
import { CfnCacheCluster, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
} from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DataStackProps extends StackProps {
  vpc: IVpc;
  dataSecurityGroup: SecurityGroup;
}

/**
 * Capa de datos compartida.
 *   - 1 RDS PostgreSQL t4g.micro con 4 databases lógicas (problems, users, submissions, contests).
 *     Cada microservicio se conecta solo a su DB con un user dedicado (gestionado por
 *     migraciones Prisma fuera de CDK). Acepta el trade-off: schema separado en una
 *     instancia compartida en lugar de 4 RDS separadas, por costo.
 *   - 1 ElastiCache Redis cache.t4g.micro compartido (caches y leaderboards).
 *
 * Para demo: deletion protection OFF, removal policy DESTROY.
 */
export class DataStack extends Stack {
  public readonly database: DatabaseInstance;
  public readonly dbCredentialsSecret: Secret;
  public readonly redisEndpoint: string;
  public readonly redisPort: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // Credenciales master del cluster (el resto de usuarios los crea Prisma).
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

    // ElastiCache Redis (subnet group + cluster).
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
