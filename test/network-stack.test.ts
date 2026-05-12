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

  it('crea solo una subnet publica', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 1);
  });

  it('no crea NAT Gateways', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });
});
