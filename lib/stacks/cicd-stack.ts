import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  Effect,
  FederatedPrincipal,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { MicroserviceName } from './ecr-stack';

export interface CicdStackProps extends StackProps {
  /**
   * Owner/repo del repo que contiene el codigo y los Dockerfiles.
   * Ej: 'Renevc14/Leetcode'.
   */
  githubOwnerRepo: string;
  /**
   * Repos ECR donde se publican las imagenes.
   */
  repositories: Record<MicroserviceName, Repository>;
}

/**
 * CI/CD basico:
 *   - OIDC Identity Provider para GitHub Actions en AWS.
 *   - IAM Role que GitHub Actions puede asumir via OIDC (sin long-lived keys).
 *   - El role tiene permisos justos: push a los 5 repos ECR y nada mas.
 *
 * El workflow real vive en .github/workflows/build-push.yml del repo de codigo.
 */
export class CicdStack extends Stack {
  public readonly githubActionsRole: Role;

  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);

    const oidcProvider = new OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // Condicion: el role solo puede ser asumido por workflows del repo declarado.
    // ref:refs/heads/main -> push a main; pull_request -> tambien acepta PRs si querés.
    const principal = new FederatedPrincipal(
      oidcProvider.openIdConnectProviderArn,
      {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${props.githubOwnerRepo}:*`,
        },
      },
      'sts:AssumeRoleWithWebIdentity',
    );

    this.githubActionsRole = new Role(this, 'GitHubActionsRole', {
      assumedBy: principal,
      description: 'Role asumido por GitHub Actions del repo de codigo para pushear a ECR',
      roleName: 'leetcode-github-actions',
    });

    // Permisos: ecr:GetAuthorizationToken (necesario antes del docker login)
    this.githubActionsRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // Permisos: push/pull a los 5 repos ECR
    const repoArns = Object.values(props.repositories).map((r) => r.repositoryArn);
    this.githubActionsRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:DescribeRepositories',
          'ecr:GetDownloadUrlForLayer',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
        ],
        resources: repoArns,
      }),
    );

    new CfnOutput(this, 'GitHubActionsRoleArn', {
      value: this.githubActionsRole.roleArn,
      description: 'Configurá este ARN como secret AWS_DEPLOY_ROLE en GitHub Actions',
    });
    new CfnOutput(this, 'OidcProviderArn', {
      value: oidcProvider.openIdConnectProviderArn,
    });
  }
}
