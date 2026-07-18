import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import {AdditionalHealthCheckType} from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import {Construct} from 'constructs';

// HTTP status buckets parsed out of the nginx JSON access log. Every service's
// nginx.conf emits `"status":$status` in the same `log_format json_log`, so the
// filter patterns themselves never vary per service — only the log group and
// metric namespace they're attached to do.
const HTTP_STATUS_METRIC_PATTERNS: ReadonlyArray<[string, string]> = [
  ['HTTP2XX', '{ ($.status >= 200) && ($.status < 300) }'],
  ['HTTP3XX', '{ ($.status >= 300) && ($.status < 400) }'],
  ['HTTP4XX', '{ ($.status >= 400) && ($.status < 500) }'],
  ['HTTP5XX', '{ $.status >= 500 }'],
];

export interface PrivateIpv4Ec2ServiceProps {
  vpc: ec2.IVpc;
  /** Shared ALB security group (imported from `/ctech/{env}/network/alb-sg-id`). */
  albSg: ec2.ISecurityGroup;
  /** Shared HTTPS listener (imported from `/ctech/{env}/alb/https-listener-arn`). */
  httpsListener: elbv2.IApplicationListener;

  securityGroupName: string;
  securityGroupDescription: string;
  /** Port nginx listens on inside the instance; the ALB and health check hit this port. */
  appPort: number;

  instanceProfileName: string;
  /** Built by the caller — nginx.conf, start.sh and static env vars are service-specific. */
  userData: ec2.UserData;

  logGroupAppName: string;
  logGroupNginxName: string;
  logRetention: logs.RetentionDays;
  logRemovalPolicy: cdk.RemovalPolicy;
  /** CloudWatch namespace for the HTTP2XX/3XX/4XX/5XX metric filters, e.g. `CtechWallet/prod`. */
  metricNamespace: string;

  targetGroupName: string;
  healthCheckPath: string;
  /** Default: `'200'`. */
  healthyHttpCodes?: string;

  /** Physical ASG name — kept explicit rather than derived so a future migration can preserve it. */
  asgName: string;
  minCapacity: number;
  maxCapacity: number;
  /** Default: 120s. */
  cooldown?: cdk.Duration;

  /** ALB listener rule host header. */
  domainName: string;
  /** Must be unique across every service sharing the listener. */
  listenerRulePriority: number;
}

/**
 * The "no NAT Gateway" EC2/ASG pattern shared by every CTech service behind the
 * shared ALB: private-IPv4-only instances (IPv6 + ALB only), combined EC2+ELB
 * health checks, nginx-log-derived HTTP status metrics, and a listener rule on
 * the shared HTTPS listener.
 *
 * Extracted after the AssociatePublicIpAddress/NetworkInterfaces CFN override this
 * depends on was hand-copied into 4 stacks and independently paired with the same
 * DynamoDB throughput mistake in two of them — see `_analysis/cross-stack-duplication.md`
 * in the ctech monorepo-analysis for the full history.
 */
export class PrivateIpv4Ec2Service extends Construct {
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly appLogGroup: logs.LogGroup;
  public readonly nginxLogGroup: logs.LogGroup;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly asgName: string;

  constructor(scope: Construct, id: string, props: PrivateIpv4Ec2ServiceProps) {
    super(scope, id);

    const {vpc, albSg, httpsListener} = props;

    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      securityGroupName: props.securityGroupName,
      description: props.securityGroupDescription,
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });
    sg.addIngressRule(albSg, ec2.Port.tcp(props.appPort), 'ALB to app');

    const appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: props.logGroupAppName,
      retention: props.logRetention,
      removalPolicy: props.logRemovalPolicy,
    });

    const nginxLogGroup = new logs.LogGroup(this, 'NginxLogGroup', {
      logGroupName: props.logGroupNginxName,
      retention: props.logRetention,
      removalPolicy: props.logRemovalPolicy,
    });

    for (const [name, pattern] of HTTP_STATUS_METRIC_PATTERNS) {
      new logs.MetricFilter(this, `${name}Filter`, {
        logGroup: nginxLogGroup,
        metricNamespace: props.metricNamespace,
        metricName: name,
        filterPattern: logs.FilterPattern.literal(pattern),
        metricValue: '1',
        defaultValue: 0,
      });
    }

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: `${props.asgName}-lt`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        edition: ec2.AmazonLinuxEdition.MINIMAL,
      }),
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(3, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
        }),
      }],
      userData: props.userData,
      instanceProfile: iam.InstanceProfile.fromInstanceProfileName(
        this, 'InstanceProfile', props.instanceProfileName,
      ),
      requireImdsv2: true,
      // securityGroup is passed so CDK can resolve IConnectable for
      // attachToApplicationTargetGroup. The generated SecurityGroupIds property is
      // deleted below and moved into NetworkInterfaces — the only place
      // AssociatePublicIpAddress and Ipv6AddressCount can be set. AWS rejects a
      // launch template that sets both fields simultaneously.
      securityGroup: sg,
    });

    const cfnLT = launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLT.addPropertyDeletionOverride('LaunchTemplateData.SecurityGroupIds');
    cfnLT.addPropertyOverride('LaunchTemplateData.NetworkInterfaces', [{
      DeviceIndex: 0,
      Groups: [sg.securityGroupId],
      AssociatePublicIpAddress: false,
      Ipv6AddressCount: 1,
    }]);

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: props.targetGroupName,
      vpc,
      port: props.appPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        path: props.healthCheckPath,
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        healthyHttpCodes: props.healthyHttpCodes ?? '200',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      autoScalingGroupName: props.asgName,
      vpc,
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      launchTemplate,
      minCapacity: props.minCapacity,
      maxCapacity: props.maxCapacity,
      cooldown: props.cooldown ?? cdk.Duration.seconds(120),
      // ELB health check added alongside the default EC2 check: the ASG replaces
      // an instance nginx/app has stopped responding on, not just one AWS marked
      // stopped/crashed. gracePeriod covers cold boot + first deploy.
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [AdditionalHealthCheckType.ELB],
        gracePeriod: cdk.Duration.seconds(120),
      }),
    });
    asg.attachToApplicationTargetGroup(targetGroup);

    new elbv2.ApplicationListenerRule(this, 'ListenerRule', {
      listener: httpsListener,
      priority: props.listenerRulePriority,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.domainName]),
        elbv2.ListenerCondition.pathPatterns(['/*']),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    this.securityGroup = sg;
    this.appLogGroup = appLogGroup;
    this.nginxLogGroup = nginxLogGroup;
    this.targetGroup = targetGroup;
    this.autoScalingGroup = asg;
    this.asgName = props.asgName;
  }
}
