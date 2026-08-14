import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53 from 'aws-cdk-lib/aws-route53';
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
  public readonly privateHostedZone?: route53.PrivateHostedZone;

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

    // One shared private namespace. It is owned by prod so future environments
    // can be associated with this same zone instead of creating another $0.50/mo
    // hosted zone. The zone is retained if the production network stack is removed.
    if (environment === 'prod') {
      this.privateHostedZone = new route53.PrivateHostedZone(this, 'PrivateHostedZone', {
        zoneName: 'internal.aoctech.app',
        vpc: this.vpc,
        comment: 'Private service discovery for CTech workloads',
      });
      this.privateHostedZone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

      new ssm.StringParameter(this, 'PrivateHostedZoneIdParam', {
        parameterName: SSM.global.privateHostedZoneId,
        stringValue: this.privateHostedZone.hostedZoneId,
        description: 'Shared Route 53 private hosted zone ID',
      });

      new ssm.StringParameter(this, 'PrivateHostedZoneNameParam', {
        parameterName: SSM.global.privateHostedZoneName,
        stringValue: this.privateHostedZone.zoneName,
        description: 'Shared Route 53 private hosted zone name',
      });

      new cdk.CfnOutput(this, 'PrivateHostedZoneId', {
        value: this.privateHostedZone.hostedZoneId,
        exportName: 'Ctech-private-hosted-zone-id',
      });
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
