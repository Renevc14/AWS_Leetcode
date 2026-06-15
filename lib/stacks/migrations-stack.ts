import { CustomResource, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { IVpc, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { ICluster } from 'aws-cdk-lib/aws-ecs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';
import { MicroserviceFargate } from '../constructs/microservice-fargate';

export interface MigrationsStackProps extends StackProps {
  vpc: IVpc;
  cluster: ICluster;
  servicesSecurityGroup: SecurityGroup;
  serviceConstructs: Map<string, MicroserviceFargate>;
  imageTag: string;
}

/**
 * Dispara `prisma migrate deploy` para cada microservicio como tarea Fargate
 * one-off. Idempotente. Re-corre cuando cambia el imageTag (para que un nuevo
 * deploy con migraciones nuevas las aplique automaticamente).
 */
export class MigrationsStack extends Stack {
  constructor(scope: Construct, id: string, props: MigrationsStackProps) {
    super(scope, id, props);

    const handler = new LambdaFunction(this, 'MigrationsRunnerFn', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.minutes(15), // 4 servicios x ~3 min cada uno como worst case
      memorySize: 256,
      code: Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'prisma-migrations-runner')),
      logRetention: RetentionDays.ONE_DAY,
    });

    handler.addToRolePolicy(
      new PolicyStatement({
        actions: ['ecs:RunTask', 'ecs:DescribeTasks'],
        resources: ['*'], // restrict-by-cluster requiere ARN match parametrizado
      }),
    );
    handler.addToRolePolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: ['*'],
        conditions: {
          StringLike: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
        },
      }),
    );

    const provider = new Provider(this, 'MigrationsProvider', {
      onEventHandler: handler,
      logRetention: RetentionDays.ONE_DAY,
    });

    const subnetIds = props.vpc.publicSubnets.map((s) => s.subnetId);
    const services = Array.from(props.serviceConstructs.entries()).map(([name, svc]) => ({
      serviceName: name,
      cluster: props.cluster.clusterArn,
      taskDefinition: svc.taskDefinition.taskDefinitionArn,
      subnets: subnetIds,
      securityGroups: [props.servicesSecurityGroup.securityGroupId],
    }));

    new CustomResource(this, 'MigrationsRunner', {
      serviceToken: provider.serviceToken,
      properties: {
        Services: services,
        // Cambiar el tag dispara una re-ejecucion (Prisma ignora migrations ya aplicadas)
        ImageTag: props.imageTag,
      },
    });
  }
}
