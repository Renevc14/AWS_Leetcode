import * as path from 'path';
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import {
  AmazonLinuxCpuType,
  BlockDeviceVolume,
  CfnEIP,
  CfnEIPAssociation,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  MachineImage,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  UserData,
} from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AuthentikStackProps extends StackProps {
  vpc: IVpc;
  authentikSecretKey: ISecret;
}

export class AuthentikStack extends Stack {
  public readonly publicIp: string;
  public readonly authentikUrl: string;

  constructor(scope: Construct, id: string, props: AuthentikStackProps) {
    super(scope, id, props);

    const sg = new SecurityGroup(this, 'AuthentikSg', {
      vpc: props.vpc,
      description: 'EC2 con Authentik (UI en :9000)',
      allowAllOutbound: true,
    });
    sg.addIngressRule(Peer.anyIpv4(), Port.tcp(9000), 'Authentik UI HTTP');

    const role = new Role(this, 'AuthentikRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    props.authentikSecretKey.grantRead(role);

    const composeAsset = new Asset(this, 'ComposeAsset', {
      path: path.join(__dirname, '..', '..', 'assets', 'authentik', 'docker-compose.yml'),
    });
    composeAsset.grantRead(role);

    const blueprintAsset = new Asset(this, 'BlueprintAsset', {
      path: path.join(__dirname, '..', '..', 'assets', 'authentik', 'blueprints', 'leetcode.yaml'),
    });
    blueprintAsset.grantRead(role);

    const userData = UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      `export AWS_DEFAULT_REGION=${this.region}`,
      'dnf update -y',
      'dnf install -y docker',
      'systemctl enable --now docker',
      'usermod -aG docker ec2-user',
      'mkdir -p /usr/local/lib/docker/cli-plugins',
      'curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 ' +
        '-o /usr/local/lib/docker/cli-plugins/docker-compose',
      'chmod +x /usr/local/lib/docker/cli-plugins/docker-compose',
      'install -d -o root -g root -m 0750 /opt/authentik',
      'install -d -o 1000 -g 1000 -m 0755 /opt/authentik/blueprints',
      `aws s3 cp ${composeAsset.s3ObjectUrl} /opt/authentik/docker-compose.yml`,
      `aws s3 cp ${blueprintAsset.s3ObjectUrl} /opt/authentik/blueprints/leetcode.yaml`,
      'chmod 0644 /opt/authentik/blueprints/leetcode.yaml',
      'SECRET_KEY=$(aws secretsmanager get-secret-value --secret-id ' +
        `${props.authentikSecretKey.secretName} --query SecretString --output text)`,
      'if [ ! -f /opt/authentik/.pgpass ]; then openssl rand -base64 32 | tr -d "=+/" | cut -c1-40 > /opt/authentik/.pgpass; fi',
      'PG_PASS=$(cat /opt/authentik/.pgpass)',
      'cat > /opt/authentik/.env <<ENVEOF',
      'PG_PASS=$PG_PASS',
      'AUTHENTIK_SECRET_KEY=$SECRET_KEY',
      'ENVEOF',
      'chmod 600 /opt/authentik/.env /opt/authentik/.pgpass',
      '(cd /opt/authentik && docker compose --env-file .env up -d)',
    );

    const instance = new Instance(this, 'AuthentikInstance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
      machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.ARM_64 }),
      securityGroup: sg,
      role,
      userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(20, { encrypted: true }),
        },
      ],
    });

    const eip = new CfnEIP(this, 'AuthentikEip');
    new CfnEIPAssociation(this, 'EipAssoc', {
      eip: eip.ref,
      instanceId: instance.instanceId,
    });

    this.publicIp = eip.ref;
    this.authentikUrl = `http://${eip.ref}:9000`;

    new CfnOutput(this, 'PublicIp', { value: eip.ref });
    new CfnOutput(this, 'AuthentikUrl', { value: this.authentikUrl });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
  }
}
