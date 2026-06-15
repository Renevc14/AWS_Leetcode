import { Duration } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { IRepository } from 'aws-cdk-lib/aws-ecr';
import {
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  ICluster,
  LogDriver,
  OperatingSystemFamily,
  Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationListener,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerCondition,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { DnsRecordType, PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface MicroserviceFargateProps {
  serviceName: string;
  cluster: ICluster;
  namespace: PrivateDnsNamespace;
  repository: IRepository;
  imageTag: string;
  vpc: IVpc;
  securityGroup: ISecurityGroup;
  listener: ApplicationListener;
  routePriority: number;
  routePathPattern: string;
  environment?: Record<string, string>;
  secrets?: Record<string, EcsSecret>;
  cpu?: number;
  memoryLimitMiB?: number;
  port?: number;
  healthCheckPath?: string;
}

/**
 * Microservicio Fargate con todo lo necesario:
 *   - Task definition desde una imagen en ECR.
 *   - Service registrado en Cloud Map (DNS interno {name}.leetcode.local).
 *   - Target group en el ALB compartido con path-based routing.
 *   - Log group dedicado (1 dia de retencion para demo).
 */
export class MicroserviceFargate extends Construct {
  public readonly service: FargateService;
  public readonly taskDefinition: FargateTaskDefinition;
  public readonly targetGroup: ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: MicroserviceFargateProps) {
    super(scope, id);

    const port = props.port ?? 8080;

    this.taskDefinition = new FargateTaskDefinition(this, 'Task', {
      cpu: props.cpu ?? 256,
      memoryLimitMiB: props.memoryLimitMiB ?? 512,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
        cpuArchitecture: CpuArchitecture.X86_64,
      },
    });

    const logGroup = new LogGroup(this, 'Logs', {
      logGroupName: `/ecs/${props.serviceName}`,
      retention: RetentionDays.ONE_DAY,
    });

    this.taskDefinition.addContainer('app', {
      image: ContainerImage.fromEcrRepository(props.repository, props.imageTag),
      essential: true,
      environment: props.environment,
      secrets: props.secrets,
      portMappings: [{ containerPort: port }],
      logging: LogDriver.awsLogs({
        streamPrefix: props.serviceName,
        logGroup,
      }),
    });

    this.service = new FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [props.securityGroup],
      cloudMapOptions: {
        cloudMapNamespace: props.namespace,
        name: props.serviceName.replace('-service', ''),
        dnsRecordType: DnsRecordType.A,
      },
    });

    this.targetGroup = new ApplicationTargetGroup(this, 'Tg', {
      vpc: props.vpc,
      port,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      healthCheck: {
        path: props.healthCheckPath ?? '/',
        interval: Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        healthyHttpCodes: '200,404',
      },
      deregistrationDelay: Duration.seconds(10),
    });
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    props.listener.addTargetGroups(`${props.serviceName}-tg`, {
      priority: props.routePriority,
      conditions: [ListenerCondition.pathPatterns([props.routePathPattern])],
      targetGroups: [this.targetGroup],
    });
  }
}
