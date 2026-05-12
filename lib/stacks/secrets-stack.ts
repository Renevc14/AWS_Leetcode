import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class SecretsStack extends Stack {
  public readonly authentikSecretKey: Secret;
  public readonly authentikClientSecret: Secret;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.authentikSecretKey = new Secret(this, 'AuthentikSecretKey', {
      secretName: 'authentik/secret-key',
      description: 'Firma cookies de sesión en Authentik',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 50,
      },
    });

    this.authentikClientSecret = new Secret(this, 'AuthentikClientSecret', {
      secretName: 'authentik/leetcode-oidc-client-secret',
      description: 'Secreto del cliente OIDC `leetcode` (sobrescribir tras crear la app)',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    new CfnOutput(this, 'AuthentikSecretKeyArn', { value: this.authentikSecretKey.secretArn });
    new CfnOutput(this, 'AuthentikClientSecretArn', {
      value: this.authentikClientSecret.secretArn,
    });
  }
}
