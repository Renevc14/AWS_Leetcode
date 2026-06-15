import { CustomResource, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

export interface AuthentikSyncStackProps extends StackProps {
  /**
   * Base URL de Authentik (ej: http://<EIP>:9000).
   */
  authentikBaseUrl: string;
  /**
   * Secret de Secrets Manager que contiene el API token de akadmin.
   * El operador lo rellena post-deploy (Directory -> Tokens en la UI).
   */
  apiTokenSecret: ISecret;
  /**
   * Dominio CloudFront del frontend (ej: dXXXX.cloudfront.net).
   */
  cloudFrontDomain: string;
  /**
   * Nombre del provider OIDC en Authentik.
   */
  providerName?: string;
}

/**
 * Sincroniza el redirect_uri exacto del frontend (https://<cloudfront>/auth/callback)
 * con el provider OIDC de Authentik via su API REST.
 *
 * Esto reemplaza el regex `*.cloudfront.net` del blueprint por un strict match.
 * Pre-condicion: el operador debe haber guardado el API token de Authentik en
 * el secret correspondiente antes de hacer cdk deploy AuthentikSyncStack.
 */
export class AuthentikSyncStack extends Stack {
  constructor(scope: Construct, id: string, props: AuthentikSyncStackProps) {
    super(scope, id, props);

    const handler = new LambdaFunction(this, 'AuthentikSyncFn', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      code: Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'authentik-redirect-sync')),
      logRetention: RetentionDays.ONE_DAY,
    });

    props.apiTokenSecret.grantRead(handler);

    const provider = new Provider(this, 'AuthentikSyncProvider', {
      onEventHandler: handler,
      logRetention: RetentionDays.ONE_DAY,
    });

    new CustomResource(this, 'AuthentikSync', {
      serviceToken: provider.serviceToken,
      properties: {
        AuthentikBaseUrl: props.authentikBaseUrl,
        ApiTokenSecretArn: props.apiTokenSecret.secretArn,
        ProviderName: props.providerName ?? 'leetcode-provider',
        CloudFrontDomain: props.cloudFrontDomain,
      },
    });
  }
}
