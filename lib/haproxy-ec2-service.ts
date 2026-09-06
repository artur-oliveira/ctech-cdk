import * as cdk from 'aws-cdk-lib';
import {CfnScalableTarget} from "aws-cdk-lib/aws-applicationautoscaling";
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as hooktargets from 'aws-cdk-lib/aws-autoscaling-hooktargets';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';

export interface HaproxyRouteRegistrationProps {
  parameterName: string;
  hostname: string;
  internalHostname?: string;
  healthPath: string;
  healthyStatuses?: number[];
  autoHeal?: boolean;
  privateHostedZone?: route53.IHostedZone;
  internalLoadBalancerHostname?: string;
}

export interface AsgScheduleProps {
  /** UNIX cron, 5 fields. Default '0 22 * * *' (01:00 UTC). */
  disableCron?: string;
  /** UNIX cron, 5 fields. Default '0 10 * * *' (13:00 UTC). */
  enableCron?: string;
  /** IANA time zone. Default 'America/Sao_Paulo' — AWS defaults to UTC. */
  timeZone?: string;
}

export const DEFAULT_ASG_SCHEDULE = {
  disableCron: '0 22 * * *',
  enableCron: '0 10 * * *',
  timeZone: 'America/Sao_Paulo',
} as const;

/**
 * Registers the nightly stop/start pair.
 *
 * `enable` restores the capacity the ASG was configured with; a scheduled action
 * that leaves min/max at 0 is a one-way switch, not a schedule.
 */
export function addAsgSchedule(
  asg: autoscaling.AutoScalingGroup,
  capacity: { minCapacity: number; maxCapacity: number; desiredCapacity?: number },
  schedule: AsgScheduleProps,
): void {
  const timeZone = schedule.timeZone ?? DEFAULT_ASG_SCHEDULE.timeZone;

  const disabledTarget = asg.scaleOnSchedule('ScheduledDisable', {
    schedule: autoscaling.Schedule.expression(schedule.disableCron ?? DEFAULT_ASG_SCHEDULE.disableCron),
    timeZone,
    minCapacity: 0,
    maxCapacity: 0,
    desiredCapacity: 0,
  });

  const enabledTarget = asg.scaleOnSchedule('ScheduledEnable', {
    schedule: autoscaling.Schedule.expression(schedule.enableCron ?? DEFAULT_ASG_SCHEDULE.enableCron),
    timeZone,
    minCapacity: capacity.minCapacity,
    maxCapacity: capacity.maxCapacity,
    desiredCapacity: capacity.desiredCapacity ?? capacity.minCapacity,
  });

  const cfnDisabledAction = disabledTarget.node.defaultChild as CfnScalableTarget;
  cfnDisabledAction.addPropertyOverride('ScheduledActionName', 'asg-scheduled-disable');

  const enabledAction = enabledTarget.node.defaultChild as CfnScalableTarget;
  enabledAction.addPropertyOverride('ScheduledActionName', 'asg-scheduled-enable');
}

export interface AsgSpotProps {
  /**
   * Instance types that the ASG may use to diversify Spot capacity.
   * Every type must be compatible with the configured machine image.
   *
   * @default - Use only HaproxyEc2ServiceProps.instanceType.
   */
  instanceTypes?: readonly ec2.InstanceType[];

  /**
   * Percentage of capacity that should use Spot.
   * Default: 100.
   */
  percentage?: number;

  /**
   * Spot allocation strategy.
   * Default: price-capacity-optimized.
   */
  allocationStrategy?: autoscaling.SpotAllocationStrategy;

  /**
   * Enable Capacity Rebalancing.
   * Default: true.
   */
  capacityRebalance?: boolean;
}

export interface TerminationDrainProps {
  /**
   * Opt-in. When false or omitted, no lifecycle hook is created and
   * termination behaves exactly as it does today (no drain window).
   */
  enabled: boolean;

  /**
   * Shell command run via SSM RunShellScript on the instance once it enters
   * `Terminating:Wait`, e.g. `'rc-service app stop'` or `'systemctl stop app'`.
   * This construct doesn't own the app process, so it can't guess how to stop
   * it — required whenever `enabled` is true. Use this to stop the app so
   * HAProxy's health check starts failing and traffic drains away (the
   * construct's existing health-reporting path — see class doc — already
   * covers new-traffic deregistration once the app stops responding; nothing
   * new is needed for that half).
   */
  drainCommand: string;

  /**
   * Lifecycle hook heartbeat timeout: the bounded window the instance gets
   * before AWS proceeds with termination regardless of drain progress.
   * @default 150
   */
  timeoutSeconds?: number;
}

export interface HaproxyEc2ServiceProps {
  vpc: ec2.IVpc;
  edgeSecurityGroup: ec2.ISecurityGroup;
  appPort: number;
  userData: ec2.UserData;
  instanceProfileName: string;
  securityGroupName: string;
  securityGroupDescription: string;
  appLogGroupName: string;
  nginxLogGroupName?: string;
  logRetention: logs.RetentionDays;
  logRemovalPolicy: cdk.RemovalPolicy;
  asgName: string;
  minCapacity: number;
  maxCapacity: number;
  enableCpuAutoScaling?: boolean;
  desiredCapacity?: number;
  instanceType?: ec2.InstanceType;
  machineImage?: ec2.IMachineImage;
  rootVolumeGiB?: number;
  healthGracePeriod?: cdk.Duration;
  cooldown?: cdk.Duration;
  cpuTargetUtilizationPercent?: number;
  route?: HaproxyRouteRegistrationProps;
  schedule?: AsgScheduleProps;
  spot?: AsgSpotProps;

  /**
   * Graceful termination drain on spot reclaim / scale-in / instance refresh.
   * Opt-in and backward-compatible — omitting it keeps today's behavior
   * (instance terminates immediately, no warning to in-flight work).
   *
   * Wires an ASG lifecycle hook (`EC2_INSTANCE_TERMINATING`) to a Lambda that
   * runs `drainCommand` on the instance via SSM RunCommand and then completes
   * the lifecycle action — CONTINUE either on success or once its own bounded
   * wait elapses, so a stuck SSM agent can never strand an instance in
   * `Terminating:Wait`. This covers both spot reclamation (Capacity
   * Rebalance/interruption) and ordinary scale-in/instance-refresh with one
   * mechanism, per AWS's recommended lifecycle-hook pattern.
   */
  terminationDrain?: TerminationDrainProps;
}

/**
 * Current no-NAT EC2 service pattern behind CTech HAProxy.
 *
 * The ASG intentionally uses EC2 health. HAProxy owns the application probe and,
 * when route.autoHeal is true, reports repeated failures with SetInstanceHealth.
 * The ASG, launch template, log groups and route are exposed so callers can add
 * service-specific alarms, lifecycle drains and outputs without widening this
 * construct's contract.
 *
 * `terminationDrain` is this construct's own opt-in lifecycle drain (spot
 * reclaim, scale-in, instance refresh) — see `TerminationDrainProps`. Callers
 * needing something beyond a single shell command can still build their own
 * lifecycle hook against the exposed `autoScalingGroup` instead.
 */
export class HaproxyEc2Service extends Construct {
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly appLogGroup: logs.LogGroup;
  public readonly nginxLogGroup?: logs.LogGroup;
  public readonly launchTemplate: ec2.LaunchTemplate;
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly routeParameter?: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: HaproxyEc2ServiceProps) {
    super(scope, id);

    if (props.minCapacity < 0 || props.maxCapacity < props.minCapacity) {
      throw new Error('ASG capacity must satisfy 0 <= minCapacity <= maxCapacity');
    }
    if (props.appPort < 1 || props.appPort > 65535) {
      throw new Error('appPort must be between 1 and 65535');
    }
    if (props.terminationDrain?.enabled && !props.terminationDrain.drainCommand?.trim()) {
      throw new Error('terminationDrain.drainCommand is required when terminationDrain.enabled is true');
    }

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      securityGroupName: props.securityGroupName,
      description: props.securityGroupDescription,
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });
    this.securityGroup.addIngressRule(
      props.edgeSecurityGroup,
      ec2.Port.tcp(props.appPort),
      'CTech HAProxy edge to service',
    );

    this.appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: props.appLogGroupName,
      retention: props.logRetention,
      removalPolicy: props.logRemovalPolicy,
    });
    if (props.nginxLogGroupName) {
      this.nginxLogGroup = new logs.LogGroup(this, 'NginxLogGroup', {
        logGroupName: props.nginxLogGroupName,
        retention: props.logRetention,
        removalPolicy: props.logRemovalPolicy,
      });
    }
    const instanceType = (
      props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO)
    );
    const machineImage = (
      props.machineImage ?? ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        edition: ec2.AmazonLinuxEdition.MINIMAL,
      })
    );
    this.launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: `${props.asgName}-lt`,
      instanceType,
      machineImage,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(props.rootVolumeGiB ?? 3, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
          encrypted: true,
        }),
      }],
      userData: props.userData,
      instanceProfile: iam.InstanceProfile.fromInstanceProfileName(
        this,
        'InstanceProfile',
        props.instanceProfileName,
      ),
      requireImdsv2: true,
      securityGroup: this.securityGroup,
    });
    const cfnLaunchTemplate = this.launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLaunchTemplate.addPropertyDeletionOverride('LaunchTemplateData.SecurityGroupIds');
    cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.NetworkInterfaces', [{
      DeviceIndex: 0,
      Groups: [this.securityGroup.securityGroupId],
      AssociatePublicIpAddress: false,
      Ipv6AddressCount: 1,
    }]);
    cfnLaunchTemplate.addPropertyOverride(
      'LaunchTemplateData.TagSpecifications',
      [{
        ResourceType: 'instance',
        Tags: [{
          Key: 'Name',
          Value: props.asgName,
        }],
      }],
    );

    const spotPercentage = props.spot?.percentage ?? 100;
    if (spotPercentage < 0 || spotPercentage > 100) {
      throw new Error('Spot percentage must be between 0 and 100');
    }
    if (props.spot?.instanceTypes?.length === 0) {
      throw new Error('Spot instanceTypes must contain at least one instance type');
    }
    if ((props.spot?.instanceTypes?.length ?? 0) > 40) {
      throw new Error('Spot instanceTypes cannot contain more than 40 instance types');
    }
    const onDemandPercentageAboveBaseCapacity = 100 - spotPercentage;

    const spotAllocationStrategy = (
      props.spot?.allocationStrategy ?? autoscaling.SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED
    );

    this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'AutoScalingGroup', {
      autoScalingGroupName: props.asgName,
      vpc: props.vpc,
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      mixedInstancesPolicy: {
        launchTemplate: this.launchTemplate,
        launchTemplateOverrides: props.spot?.instanceTypes?.map((overrideInstanceType) => ({
          instanceType: overrideInstanceType,
        })),
        instancesDistribution: {
          onDemandPercentageAboveBaseCapacity,
          spotAllocationStrategy
        },
      },
      capacityRebalance: props.spot ? props.spot.capacityRebalance ?? true : undefined,
      minCapacity: props.minCapacity,
      maxCapacity: props.maxCapacity,
      desiredCapacity: props.desiredCapacity,
      cooldown: props.cooldown ?? cdk.Duration.seconds(120),
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: props.healthGracePeriod ?? cdk.Duration.seconds(120),
      }),
    });
    if (props.maxCapacity > props.minCapacity && props.enableCpuAutoScaling) {
      this.autoScalingGroup.scaleOnCpuUtilization('CpuTargetTracking', {
        targetUtilizationPercent: props.cpuTargetUtilizationPercent ?? 60,
        cooldown: cdk.Duration.minutes(3),
      });
    }

    if (props.schedule) {
      addAsgSchedule(this.autoScalingGroup, props, props.schedule);
    }

    if (props.route) {
      this.routeParameter = this.createRoute(props.route, props.appPort, props.asgName);
    }

    if (props.terminationDrain?.enabled) {
      this.addTerminationDrain(props.terminationDrain, props.asgName);
    }
  }

  /**
   * Wires the opt-in graceful-termination lifecycle hook. See
   * `TerminationDrainProps` for the shape and `HaproxyEc2ServiceProps.terminationDrain`
   * for the overall design note.
   */
  private addTerminationDrain(drain: TerminationDrainProps, asgName: string): void {
    const heartbeatTimeout = cdk.Duration.seconds(drain.timeoutSeconds ?? 150);
    // Leave the SSM command itself a bounded window inside the hook's own
    // timeout, so the Lambda's `finally` has time to call
    // CompleteLifecycleAction before AWS times the hook out regardless.
    const commandTimeoutSeconds = Math.max(30, heartbeatTimeout.toSeconds() - 30);

    const drainFunction = new lambda.Function(this, 'TerminationDrainFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(Math.min(commandTimeoutSeconds + 15, 900)),
      code: lambda.Code.fromInline(`
import boto3, json, time
asg = boto3.client("autoscaling")
ssm = boto3.client("ssm")

def handler(event, context):
    message = json.loads(event["Records"][0]["Sns"]["Message"])
    if message.get("Event") == "autoscaling:TEST_NOTIFICATION":
        return
    instance_id = message["EC2InstanceId"]
    try:
        result = ssm.send_command(
            InstanceIds=[instance_id],
            DocumentName="AWS-RunShellScript",
            Parameters={"commands": [${JSON.stringify(drain.drainCommand)}]},
            TimeoutSeconds=${commandTimeoutSeconds},
        )
        command_id = result["Command"]["CommandId"]
        deadline = time.time() + ${commandTimeoutSeconds}
        while time.time() < deadline:
            try:
                status = ssm.get_command_invocation(
                    CommandId=command_id, InstanceId=instance_id)["Status"]
                if status in ("Success", "Cancelled", "Failed", "TimedOut"):
                    break
            except ssm.exceptions.InvocationDoesNotExist:
                pass
            time.sleep(2)
    finally:
        asg.complete_lifecycle_action(
            LifecycleHookName=message["LifecycleHookName"],
            AutoScalingGroupName=message["AutoScalingGroupName"],
            LifecycleActionToken=message["LifecycleActionToken"],
            LifecycleActionResult="CONTINUE",
        )
`),
    });

    // SendCommand has no resource-level support for the document itself
    // beyond its own ARN; the instance target is scoped to instances tagged
    // Name=asgName — the tag this construct's launch template already stamps
    // on every instance it launches (see LaunchTemplateData.TagSpecifications
    // above), so this can never reach an instance outside this ASG.
    drainFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [`arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/*`],
      conditions: {StringEquals: {'ssm:resourceTag/Name': asgName}},
    }));
    drainFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [`arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}::document/AWS-RunShellScript`],
    }));
    // Command-status polling has no resource-level scoping in IAM.
    drainFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));
    drainFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['autoscaling:CompleteLifecycleAction'],
      resources: [this.autoScalingGroup.autoScalingGroupArn],
    }));

    this.autoScalingGroup.addLifecycleHook('TerminationDrainHook', {
      lifecycleHookName: `${asgName}-termination-drain`,
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      // Fail open: if the drain path never fires (Lambda broken, SNS delivery
      // lost), the instance still terminates once the heartbeat elapses
      // rather than getting stuck in Terminating:Wait forever.
      defaultResult: autoscaling.DefaultResult.CONTINUE,
      heartbeatTimeout,
      notificationTarget: new hooktargets.FunctionHook(drainFunction),
    });
  }

  private createRoute(
    route: HaproxyRouteRegistrationProps,
    appPort: number,
    asgName: string,
  ): ssm.StringParameter {
    if (!route.parameterName.startsWith('/')) {
      throw new Error('HAProxy route parameterName must be an absolute SSM path');
    }
    if (!route.healthPath.startsWith('/')) {
      throw new Error('HAProxy healthPath must start with /');
    }
    const healthyStatuses = route.healthyStatuses ?? [200];
    if (healthyStatuses.length === 0 || healthyStatuses.some((status) => status < 100 || status > 599)) {
      throw new Error('HAProxy healthyStatuses must contain valid HTTP status codes');
    }
    const hasAnyPrivateDns = Boolean(
      route.internalHostname || route.privateHostedZone || route.internalLoadBalancerHostname,
    );
    const hasAllPrivateDns = Boolean(
      route.internalHostname && route.privateHostedZone && route.internalLoadBalancerHostname,
    );
    if (hasAnyPrivateDns && !hasAllPrivateDns) {
      throw new Error(
        'internalHostname, privateHostedZone and internalLoadBalancerHostname must be provided together',
      );
    }

    const parameter = new ssm.StringParameter(this, 'RouteParameter', {
      parameterName: route.parameterName,
      tier: ssm.ParameterTier.STANDARD,
      stringValue: JSON.stringify({
        hostname: route.hostname,
        ...(route.internalHostname ? {internalHostname: route.internalHostname} : {}),
        asg: asgName,
        port: appPort,
        healthPath: route.healthPath,
        healthyStatuses,
        autoHeal: route.autoHeal ?? true,
      }),
      description: `HAProxy route for ${route.hostname}`,
    });

    if (hasAllPrivateDns) {
      const zone = route.privateHostedZone!;
      const suffix = `.${zone.zoneName}`;
      const recordName = route.internalHostname!.endsWith(suffix)
        ? route.internalHostname!.slice(0, -suffix.length)
        : route.internalHostname!;
      new route53.CnameRecord(this, 'InternalAlias', {
        zone,
        recordName,
        domainName: route.internalLoadBalancerHostname!,
        ttl: cdk.Duration.seconds(30),
        comment: `Private M2M alias for ${route.hostname}`,
      });
    }
    return parameter;
  }
}
