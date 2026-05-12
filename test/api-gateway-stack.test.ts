import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiGatewayStack } from '../lib/stacks/api-gateway-stack';

describe('ApiGatewayStack', () => {
  const app = new App();
  const stack = new ApiGatewayStack(app, 'TestApiGatewayStack', {
    authentikPublicIp: '203.0.113.10',
  });
  const template = Template.fromStack(stack);

  it('crea un HTTP API llamado leetcode-api', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'leetcode-api',
      ProtocolType: 'HTTP',
    });
  });

  it('configura un Lambda authorizer con response type SIMPLE', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      AuthorizerPayloadFormatVersion: '2.0',
      EnableSimpleResponses: true,
      IdentitySource: ['$request.header.Authorization'],
    });
  });

  it('crea dos Lambdas: authorizer y MeHandler', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
    });
  });

  it('crea la ruta GET /v1/me con el authorizer', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/me',
      AuthorizationType: 'CUSTOM',
    });
  });

  it('declara el integration target apuntando a Lambda', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: Match.anyValue(),
    });
  });

  it('pasa la URL del JWKS y el issuer como variables de entorno al authorizer', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          JWKS_URI: 'http://203.0.113.10:9000/application/o/leetcode/jwks/',
          ISSUER: 'http://203.0.113.10:9000/application/o/leetcode/',
          AUDIENCE: 'leetcode',
        },
      },
    });
  });
});
