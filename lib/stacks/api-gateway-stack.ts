import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface ApiGatewayStackProps extends StackProps {
  authentikPublicIp: string;
  authentikAppSlug?: string;
}

export class ApiGatewayStack extends Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    const appSlug = props.authentikAppSlug ?? 'leetcode';
    const issuer = `http://${props.authentikPublicIp}:9000/application/o/${appSlug}/`;

    const authorizer = new HttpJwtAuthorizer('JwtAuthorizer', issuer, {
      jwtAudience: [appSlug],
      identitySource: ['$request.header.Authorization'],
    });

    const meHandler = new LambdaFunction(this, 'MeHandler', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: Duration.seconds(5),
      code: Code.fromInline(
        [
          'exports.handler = async (event) => {',
          '  const claims = event.requestContext.authorizer.jwt.claims;',
          '  return {',
          '    statusCode: 200,',
          "    headers: { 'content-type': 'application/json' },",
          '    body: JSON.stringify({',
          '      sub: claims.sub,',
          '      email: claims.email,',
          '      name: claims.name,',
          '      roles: claims.roles,',
          '    }),',
          '  };',
          '};',
        ].join('\n'),
      ),
    });

    const api = new HttpApi(this, 'Api', {
      apiName: 'leetcode-api',
      description: 'API LeetCode con JWT Authorizer apuntando a Authentik',
    });

    api.addRoutes({
      path: '/v1/me',
      methods: [HttpMethod.GET],
      authorizer,
      integration: new HttpLambdaIntegration('MeIntegration', meHandler),
    });

    this.apiUrl = api.apiEndpoint;

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'IssuerUrl', { value: issuer });
  }
}
