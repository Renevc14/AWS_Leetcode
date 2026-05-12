import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

describe('DatabaseStack', () => {
  const app = new App();
  const network = new NetworkStack(app, 'TestNetworkStack');
  const stack = new DatabaseStack(app, 'TestDatabaseStack', { vpc: network.vpc });
  const template = Template.fromStack(stack);

  it('crea una instancia RDS PostgreSQL', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DBInstanceClass: 'db.t4g.micro',
      MultiAZ: false,
      PubliclyAccessible: false,
    });
  });

  it('crea credenciales gestionadas en Secrets Manager', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'authentik/db-credentials',
    });
  });

  it('configura rotacion automatica de credenciales', () => {
    template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
  });
});
