import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/stacks/network-stack';

describe('NetworkStack', () => {
  const app = new App();
  const stack = new NetworkStack(app, 'TestNetworkStack');
  const template = Template.fromStack(stack);

  it('crea una VPC con CIDR 10.0.0.0/16', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
    });
  });

  it('crea 6 subnets (2 publicas, 2 app, 2 data)', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  it('crea exactamente 1 NAT Gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });
});
