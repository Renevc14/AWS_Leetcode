import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import { Cluster, ICluster } from 'aws-cdk-lib/aws-ecs';
import { PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface EcsClusterStackProps extends StackProps {
  vpc: IVpc;
}

/**
 * Cluster Fargate + Cloud Map. El ALB y las reglas viven en ServicesStack para
 * evitar dependency cycles.
 */
export class EcsClusterStack extends Stack {
  public readonly cluster: ICluster;
  public readonly namespace: PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: EcsClusterStackProps) {
    super(scope, id, props);

    this.cluster = new Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'leetcode-cluster',
    });

    this.namespace = new PrivateDnsNamespace(this, 'Namespace', {
      name: 'leetcode.local',
      vpc: props.vpc,
      description: 'Service discovery para microservicios',
    });

    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new CfnOutput(this, 'NamespaceName', { value: this.namespace.namespaceName });
  }
}
