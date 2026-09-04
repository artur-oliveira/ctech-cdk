import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {IpProtocol} from 'aws-cdk-lib/aws-ec2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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
      // Preserve the original subnet positions (1b/1c/1d) and append the
      // remaining pinned AZs. Reordering would replace existing subnets.
      availabilityZones: [
        'us-east-1b',
        'us-east-1c',
        'us-east-1d',
        'us-east-1a',
        'us-east-1e',
        'us-east-1f',
      ],
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      ipProtocol: IpProtocol.DUAL_STACK,
      ipv6Addresses: ec2.Ipv6Addresses.amazonProvided(),
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 20,
          ipv6AssignAddressOnCreation: true,
        },
      ],
    });

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

    // Compatibility name: this SG is now the edge identity attached to
    // ctech-lbalancer and referenced by service SGs. Keep the physical/SSM
    // names stable until all consumers can be migrated together.
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: `${environment}-ctech-alb-sg`,
      // Preserve this legacy property as well as the physical name: changing a
      // named SG description can require replacement and collide with itself.
      description: 'Shared ALB - allows 80/443 from internet',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Private HTTPS from VPC',
    );
    // Cloudflare origin traffic is IPv6-only. nftables on ctech-lbalancer
    // narrows this further to Cloudflare's published ranges and AOP mTLS.
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'Public HTTPS IPv6');

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
      description: `Shared edge security group ID (legacy ALB-compatible path) - ${environment}`,
    });

    new cdk.CfnOutput(this, 'VpcId', {value: this.vpc.vpcId, exportName: `${id}-vpc-id`});
    new cdk.CfnOutput(this, 'AlbSgId', {value: this.albSecurityGroup.securityGroupId, exportName: `${id}-alb-sg-id`});
  }
}
