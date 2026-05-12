import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AuthentikStack } from '../lib/stacks/authentik-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { SecretsStack } from '../lib/stacks/secrets-stack';

describe('AuthentikStack', () => {
  const app = new App();
  const network = new NetworkStack(app, 'TestNetworkStack');
  const secrets = new SecretsStack(app, 'TestSecretsStack');
  const stack = new AuthentikStack(app, 'TestAuthentikStack', {
    vpc: network.vpc,
    authentikSecretKey: secrets.authentikSecretKey,
  });
  const template = Template.fromStack(stack);

  it('crea una EC2 t4g.small', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.small',
    });
  });

  it('crea exactamente una Elastic IP asociada a la instancia', () => {
    template.resourceCountIs('AWS::EC2::EIP', 1);
    template.resourceCountIs('AWS::EC2::EIPAssociation', 1);
  });

  it('abre puerto 9000 al mundo en el security group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [
        {
          CidrIp: '0.0.0.0/0',
          FromPort: 9000,
          ToPort: 9000,
          IpProtocol: 'tcp',
        },
      ],
    });
  });

  it('configura volumen EBS encriptado de 20 GB', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          Ebs: {
            VolumeSize: 20,
            Encrypted: true,
          },
        },
      ],
    });
  });
});
