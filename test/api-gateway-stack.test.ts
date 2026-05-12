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

  it('configura un JWT authorizer con issuer apuntando a Authentik', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      JwtConfiguration: {
        Audience: ['leetcode'],
        Issuer: 'http://203.0.113.10:9000/application/o/leetcode/',
      },
      IdentitySource: ['$request.header.Authorization'],
    });
  });

  it('crea la ruta GET /v1/me con el authorizer', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/me',
      AuthorizationType: 'JWT',
    });
  });

  it('crea la Lambda handler con runtime Node 20', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
    });
  });

  it('declara el integration target apuntando a la Lambda', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: Match.anyValue(),
    });
  });
});
