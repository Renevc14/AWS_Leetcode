import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import {
  AmazonLinuxCpuType,
  CfnEIP,
  CfnEIPAssociation,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  MachineImage,
  SecurityGroup,
  SubnetType,
  UserData,
} from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { CfnInstance, CfnService, PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface ExecutorStackProps extends StackProps {
  vpc: IVpc;
  servicesSecurityGroup: SecurityGroup;
  namespace: PrivateDnsNamespace;
  repository: Repository;
  imageTag: string;
  authJwksUrl: string;
}

/**
 * executor-service en EC2 (Fargate no expone /var/run/docker.sock).
 *
 * UserData:
 *   1. Instala Docker y AWS CLI.
 *   2. ECR login + pull de la imagen.
 *   3. docker run con el socket montado.
 *
 * Para que el resto del cluster lo encuentre por DNS:
 *   - Se crea una entrada CName "executor" en el namespace Cloud Map apuntando
 *     a la EIP via CfnInstance(IPV4=eip).
 *
 * Asi, `http://executor.leetcode.local:8080` resuelve para los servicios Fargate.
 */
export class ExecutorStack extends Stack {
  public readonly publicIp: string;
  public readonly internalUrl: string;

  constructor(scope: Construct, id: string, props: ExecutorStackProps) {
    super(scope, id, props);

    const role = new Role(this, 'InstanceRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });

    const imageUri = `${props.repository.repositoryUri}:${props.imageTag}`;

    const userData = UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      `export AWS_DEFAULT_REGION=${this.region}`,
      'dnf update -y',
      'dnf install -y docker',
      'systemctl enable --now docker',
      'usermod -aG docker ec2-user',
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
      // Pre-pull runners (no fatal si fallan, el container los pull on-demand)
      'docker pull gcc:13-bookworm || true',
      'docker pull eclipse-temurin:21-jdk-noble || true',
      'docker pull node:22-alpine || true',
      'docker pull python:3.12-slim || true',
      `docker pull ${imageUri}`,
      `docker run -d --name executor --restart unless-stopped -p 8080:8080 \
         -v /var/run/docker.sock:/var/run/docker.sock \
         -e PORT=8080 \
         -e AUTH_JWKS_URL="${props.authJwksUrl}" \
         ${imageUri}`,
    );

    const instance = new Instance(this, 'ExecutorInstance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.SMALL),
      machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.X86_64 }),
      securityGroup: props.servicesSecurityGroup,
      role,
      userData,
    });

    const eip = new CfnEIP(this, 'ExecutorEip');
    new CfnEIPAssociation(this, 'EipAssoc', {
      eip: eip.ref,
      instanceId: instance.instanceId,
    });
    this.publicIp = eip.ref;
    this.internalUrl = `http://executor.${props.namespace.namespaceName}:8080`;

    // Registra "executor" en Cloud Map apuntando a la EIP.
    // CfnService nos permite controlar el tipo de servicio (DNS_HTTP).
    const dnsService = new CfnService(this, 'CmService', {
      name: 'executor',
      namespaceId: props.namespace.namespaceId,
      dnsConfig: {
        namespaceId: props.namespace.namespaceId,
        routingPolicy: 'WEIGHTED',
        dnsRecords: [{ ttl: 60, type: 'A' }],
      },
    });

    // CfnInstance registra una IP arbitraria como instancia del servicio.
    new CfnInstance(this, 'CmInstance', {
      serviceId: dnsService.ref,
      instanceId: 'executor-eip',
      instanceAttributes: {
        AWS_INSTANCE_IPV4: eip.ref,
        AWS_INSTANCE_PORT: '8080',
      },
    });

    new CfnOutput(this, 'ExecutorPublicIp', { value: eip.ref });
    new CfnOutput(this, 'ExecutorInstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'ExecutorInternalUrl', { value: this.internalUrl });
  }
}
