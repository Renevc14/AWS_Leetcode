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
import { PrivateDnsNamespace, Service } from 'aws-cdk-lib/aws-servicediscovery';
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
 * executor-service desplegado en EC2 (no Fargate) porque necesita acceso al
 * socket de Docker en runtime para los sandboxes de codigo.
 *
 * UserData:
 *   1. Instala Docker y AWS CLI.
 *   2. Login en ECR.
 *   3. Pull de la imagen.
 *   4. docker run con el socket montado.
 *
 * Para resolverlo por DNS desde los otros servicios via Cloud Map, registra una
 * entrada A en el namespace apuntando a la EIP.
 */
export class ExecutorStack extends Stack {
  public readonly publicIp: string;

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
      // Login ECR
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
      // Pre-pull runners (cpp, java, node, python) — el executor los espera disponibles
      'docker pull gcc:13-bookworm || true',
      'docker pull eclipse-temurin:21-jdk-noble || true',
      'docker pull node:22-alpine || true',
      'docker pull python:3.12-slim || true',
      // Pull and run executor service
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

    // Registra en Cloud Map (DNS interno) — los otros servicios lo resuelven
    // como http://executor.leetcode.local:8080.
    const dnsService = new Service(this, 'DnsService', {
      namespace: props.namespace,
      name: 'executor',
      dnsRecordType: undefined, // default A
      loadBalancer: false,
    });
    // No hay un helper directo para registrar una IP arbitraria en CDK Service
    // (esta pensado para instancias ECS). Lo dejamos como informacion para
    // que el operador lo cree manualmente con `aws servicediscovery register-instance`
    // o se actualice por hook del UserData. Para demo, los servicios pueden
    // usar la EIP directa via env var EXECUTOR_SERVICE_URL.

    new CfnOutput(this, 'ExecutorPublicIp', { value: eip.ref });
    new CfnOutput(this, 'ExecutorInstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'ExecutorDnsServiceId', { value: dnsService.serviceId });
  }
}
