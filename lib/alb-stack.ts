import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {IpAddressType} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {Construct} from 'constructs';
import {Environment} from './types';
import {SSM} from './constants';

interface AlbStackProps extends cdk.StackProps {
  environment: Environment;
  vpc: ec2.Vpc;
  securityGroup: ec2.SecurityGroup;
  certArn: string;
}

export class AlbStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpsListener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: AlbStackProps) {
    super(scope, id, props);

    const {environment, vpc, securityGroup, certArn} = props;

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${environment}-ctech`,
      vpc,
      ipAddressType: IpAddressType.DUAL_STACK_WITHOUT_PUBLIC_IPV4,
      internetFacing: true,
      securityGroup,
    });

    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
        permanent: true,
      }),
    });

    this.httpsListener = this.alb.addListener('HttpsListener', {
      port: 443,
      certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', certArn)],
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        contentType: 'application/json',
        messageBody: '{"message":"Unknown service"}',
      }),
    });

    // ── SSM exports consumed by service CDKs ─────────────────────────────────
    const albParams = SSM.alb(environment);

    new ssm.StringParameter(this, 'AlbArnParam', {
      parameterName: albParams.arn,
      stringValue: this.alb.loadBalancerArn,
      description: `Shared ALB ARN - ${environment}`,
    });

    new ssm.StringParameter(this, 'AlbDnsNameParam', {
      parameterName: albParams.dnsName,
      stringValue: this.alb.loadBalancerDnsName,
      description: `Shared ALB DNS name - ${environment}`,
    });

    new ssm.StringParameter(this, 'HttpsListenerArnParam', {
      parameterName: albParams.httpsListenerArn,
      stringValue: this.httpsListener.listenerArn,
      description: `Shared ALB HTTPS listener ARN - ${environment}`,
    });

    new cdk.CfnOutput(this, 'AlbArn', {value: this.alb.loadBalancerArn, exportName: `${id}-arn`});
    new cdk.CfnOutput(this, 'AlbDns', {value: this.alb.loadBalancerDnsName, exportName: `${id}-dns`});
    new cdk.CfnOutput(this, 'HttpsListenerArn', {
      value: this.httpsListener.listenerArn,
      exportName: `${id}-https-listener-arn`
    });
  }
}
