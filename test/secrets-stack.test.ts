import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SecretsStack } from '../lib/stacks/secrets-stack';

describe('SecretsStack', () => {
  const app = new App();
  const stack = new SecretsStack(app, 'TestSecretsStack');
  const template = Template.fromStack(stack);

  it('crea exactamente 2 secretos', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
  });

  it('crea AUTHENTIK_SECRET_KEY con nombre esperado', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'authentik/secret-key',
    });
  });

  it('crea el client secret OIDC con nombre esperado', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'authentik/leetcode-oidc-client-secret',
    });
  });
});
