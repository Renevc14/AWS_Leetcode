import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
} from 'aws-cdk-lib/aws-ec2';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
} from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends StackProps {
  vpc: IVpc;
}

export class DatabaseStack extends Stack {
  public readonly instance: DatabaseInstance;
  public readonly securityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    this.securityGroup = new SecurityGroup(this, 'DbSg', {
      vpc: props.vpc,
      description: 'RDS PostgreSQL para Authentik',
      allowAllOutbound: false,
    });

    this.instance = new DatabaseInstance(this, 'AuthentikDb', {
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16_3 }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      credentials: Credentials.fromGeneratedSecret('authentik', {
        secretName: 'authentik/db-credentials',
      }),
      databaseName: 'authentik',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      multiAz: false,
      publiclyAccessible: false,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      backupRetention: Duration.days(7),
    });

    this.instance.addRotationSingleUser({
      automaticallyAfter: Duration.days(30),
    });

    this.securityGroup.addIngressRule(
      Peer.ipv4(props.vpc.vpcCidrBlock),
      Port.tcp(5432),
      'Permite acceso a Postgres desde dentro de la VPC (acotar en Feature 2)',
    );

    new CfnOutput(this, 'DbEndpoint', { value: this.instance.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DbSecretArn', { value: this.instance.secret?.secretArn ?? '' });
  }
}
