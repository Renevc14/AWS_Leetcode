import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import {
  IVpc,
  IpAddresses,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Red base optimizada para una demo corta.
 *   - 2 AZ (RDS requiere subnet group con al menos 2 AZ).
 *   - Solo subnets PUBLIC para evitar el costo del NAT Gateway (~$32/mes).
 *   - SGs restrictivos compensan que todo esté en public.
 */
export class NetworkStack extends Stack {
  public readonly vpc: IVpc;
  public readonly servicesSecurityGroup: SecurityGroup;
  public readonly dataSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, 'Vpc', {
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
    });

    this.servicesSecurityGroup = new SecurityGroup(this, 'ServicesSg', {
      vpc: this.vpc,
      description: 'SG compartido para los microservicios (Fargate + executor EC2)',
      allowAllOutbound: true,
    });
    this.servicesSecurityGroup.addIngressRule(
      this.servicesSecurityGroup,
      Port.allTraffic(),
      'Comunicacion interna entre servicios',
    );

    this.dataSecurityGroup = new SecurityGroup(this, 'DataSg', {
      vpc: this.vpc,
      description: 'SG para RDS y ElastiCache',
      allowAllOutbound: false,
    });
    // Self-reference: permite que la Lambda de bootstrap (que vive en este mismo SG)
    // pueda conectar al RDS.
    this.dataSecurityGroup.addIngressRule(
      this.dataSecurityGroup,
      Port.tcp(5432),
      'Self-reference para Lambda de bootstrap',
    );
    this.dataSecurityGroup.addIngressRule(
      this.servicesSecurityGroup,
      Port.tcp(5432),
      'PostgreSQL desde servicios',
    );
    this.dataSecurityGroup.addIngressRule(
      this.servicesSecurityGroup,
      Port.tcp(6379),
      'Redis desde servicios',
    );

    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new CfnOutput(this, 'ServicesSgId', { value: this.servicesSecurityGroup.securityGroupId });
    new CfnOutput(this, 'DataSgId', { value: this.dataSecurityGroup.securityGroupId });
  }
}
