import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {IpProtocol} from 'aws-cdk-lib/aws-ec2';
import {Construct} from 'constructs';
import {Environment} from './types';
import {SSM} from './constants';

interface NetworkStackProps extends cdk.StackProps {
  environment: Environment;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const {environment} = props;

    // Dual-stack VPC: instances use IPv6 public addresses, no public IPv4.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${environment}-ctech-vpc`,
      maxAzs: 2,
      ipProtocol: IpProtocol.DUAL_STACK,
      ipv6Addresses: ec2.Ipv6Addresses.amazonProvided(),
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    for (const subnet of this.vpc.publicSubnets) {
      const cfnSubnet = subnet.node.defaultChild as ec2.CfnSubnet;
      cfnSubnet.assignIpv6AddressOnCreation = true;
    }

    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: `${environment}-ctech-alb-sg`,
      description: 'Shared ALB - allows 80/443 from internet',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80),  'HTTP IPv4');
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS IPv4');
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80),  'HTTP IPv6');
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS IPv6');

    // ── SSM exports consumed by service CDKs ─────────────────────────────────
    const net = SSM.network(environment);

    new ssm.StringParameter(this, 'VpcIdParam', {
      parameterName: net.vpcId,
      stringValue: this.vpc.vpcId,
      description: `Shared VPC ID - ${environment}`,
    });

    new ssm.StringParameter(this, 'AlbSgIdParam', {
      parameterName: net.albSgId,
      stringValue: this.albSecurityGroup.securityGroupId,
      description: `Shared ALB security group ID - ${environment}`,
    });

    new cdk.CfnOutput(this, 'VpcId',  {value: this.vpc.vpcId,                      exportName: `${id}-vpc-id`});
    new cdk.CfnOutput(this, 'AlbSgId',{value: this.albSecurityGroup.securityGroupId, exportName: `${id}-alb-sg-id`});
  }
}
