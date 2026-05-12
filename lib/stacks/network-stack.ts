import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { IVpc, IpAddresses, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends Stack {
  public readonly vpc: IVpc;
  public readonly albSecurityGroup: SecurityGroup;
  public readonly authentikSecurityGroup: SecurityGroup;
  public readonly databaseSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, 'Vpc', {
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.albSecurityGroup = new SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'ALB de Authentik (HTTPS desde Internet)',
      allowAllOutbound: true,
    });

    this.authentikSecurityGroup = new SecurityGroup(this, 'AuthentikSg', {
      vpc: this.vpc,
      description: 'Tareas ECS de Authentik',
      allowAllOutbound: true,
    });

    this.databaseSecurityGroup = new SecurityGroup(this, 'DatabaseSg', {
      vpc: this.vpc,
      description: 'RDS PostgreSQL para Authentik',
      allowAllOutbound: false,
    });

    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
