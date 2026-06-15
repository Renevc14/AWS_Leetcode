import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export const MICROSERVICE_NAMES = [
  'problems-service',
  'users-service',
  'submissions-service',
  'contests-service',
  'executor-service',
] as const;

export type MicroserviceName = (typeof MICROSERVICE_NAMES)[number];

/**
 * Repositorios ECR para las imagenes Docker de los 5 microservicios.
 * Para una demo, removalPolicy DESTROY + emptyOnDelete.
 */
export class EcrStack extends Stack {
  public readonly repositories: Record<MicroserviceName, Repository>;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const repos: Partial<Record<MicroserviceName, Repository>> = {};

    for (const name of MICROSERVICE_NAMES) {
      const repo = new Repository(this, `Repo-${name}`, {
        repositoryName: `leetcode/${name}`,
        imageTagMutability: TagMutability.MUTABLE,
        emptyOnDelete: true,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      repos[name] = repo;

      new CfnOutput(this, `Uri-${name}`, {
        value: repo.repositoryUri,
        exportName: `LeetCodeEcrUri-${name}`,
      });
    }

    this.repositories = repos as Record<MicroserviceName, Repository>;
  }
}
