import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {Environment} from './types';
import {SSM} from './constants';
import {addAsgSchedule, AsgScheduleProps} from './haproxy-ec2-service';
import {addSwapCommands} from './ec2-userdata-fragments';

interface ValkeyStackV2Props extends cdk.StackProps {
  environment: Environment;
  vpc: ec2.Vpc;
  privateHostedZone?: route53.IPrivateHostedZone;
  schedule?: AsgScheduleProps;
}

/**
 * Alpine/OpenRC equivalent of ValkeyStack (lib/valkey-stack.ts), same
 * external contract: /ctech/{env}/valkey/url and cache.internal.aoctech.app.
 * The two cannot coexist — cut over the same way ValkeyStack/DragonflyStack
 * already do: delete the old stack, then deploy this one.
 */
export class ValkeyStackV2 extends cdk.Stack {
  public readonly urlSsmPath: string;

  constructor(scope: Construct, id: string, props: ValkeyStackV2Props) {
    super(scope, id, props);

    const {environment, vpc, privateHostedZone} = props;
    const isProd = environment === 'prod';
    const dnsName = privateHostedZone ? `cache.${privateHostedZone.zoneName}` : undefined;

    this.urlSsmPath = SSM.valkey(environment).url;

    const sg = new ec2.SecurityGroup(this, 'ValkeySg', {
      vpc,
      securityGroupName: `${environment}-ctech-valkey-v2-sg`,
      description: 'Shared Valkey (Alpine) - reachable from VPC only on port 6379',
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });
    sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6379), 'Valkey: VPC IPv4');

    const role = new iam.Role(this, 'ValkeyRole', {
      roleName: `${environment}-ctech-valkey-v2-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.urlSsmPath}`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/ctech/${environment}/valkey:*`],
    }));
    if (privateHostedZone) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:${this.partition}:route53:::hostedzone/${privateHostedZone.hostedZoneId}`],
      }));
    }

    const instanceProfile = new iam.InstanceProfile(this, 'ValkeyInstanceProfile', {
      instanceProfileName: `${environment}-ctech-valkey-v2-profile`,
      role,
    });

    const logGroup = new logs.LogGroup(this, 'ValkeyLogGroup', {
      logGroupName: `/ctech/${environment}/valkey-v2`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const scriptsBucket = ssm.StringParameter.valueForStringParameter(this, SSM.ec2ScriptsAlpine(environment).bucket);
    const scriptsVersion = ssm.StringParameter.valueForStringParameter(this, SSM.ec2ScriptsAlpine(environment).version);
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${scriptsBucket}/*`],
    }));

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      // No public IPv4 and no NAT gateway on this instance — every AWS API
      // call ctech-ec2-agent makes needs the dual-stack (IPv6-reachable)
      // endpoint from its very first invocation, not just from
      // setup-dualstack.sh onward (setup-dualstack.sh's job is persisting
      // this for services that start later, e.g. OpenRC's ctech-ec2-agent-logs).
      'export AWS_USE_DUALSTACK_ENDPOINT=true',
      // ctech-ec2-agent is baked into the AMI at build time (see
      // packer/alpine-arm64.pkr.hcl) — nothing here needs to fetch it, which
      // matters because there is no aws-cli on this image to bootstrap with.
      `CTECH_SCRIPTS_BUCKET="${scriptsBucket}"`,
      `CTECH_SCRIPTS_VERSION="${scriptsVersion}"`,
      'ctech_run(){ s=$1; shift; ctech-ec2-agent s3-cp -bucket "$CTECH_SCRIPTS_BUCKET" -key "$CTECH_SCRIPTS_VERSION/$s" -dest "/tmp/$s"; bash "/tmp/$s" "$@"; }',

      // Dualstack SSM config first: gives out-of-band SSM access to debug
      // anything that fails below, instead of losing both at once.
      'ctech_run setup-dualstack.sh',
      'ctech_run setup-base.sh valkey valkey valkey-openrc',
    );
    addSwapCommands(userData, 256);
    userData.addCommands(
      `cat > /etc/valkey/valkey.conf << 'VALKEYCONF'`,
      'bind 0.0.0.0 ::',
      'protected-mode no',
      'port 6379',
      'daemonize no',
      'loglevel notice',
      'databases 16',
      'save ""',
      'appendonly no',
      'maxmemory 128mb',
      'maxmemory-policy allkeys-lfu',
      'tcp-keepalive 60',
      'timeout 0',
      'logfile /var/log/valkey/valkey.log',
      'VALKEYCONF',
      // Unlike the AL2023 RPM, Alpine's valkey apk package never creates
      // /var/log/valkey — its openrc start_pre() only checkpath -f's the
      // logfile itself, which doesn't create a missing parent directory,
      // so valkey fails to start with "checkpath: ... could not open"
      // (confirmed live) unless this exists first.
      'mkdir -p /var/log/valkey',
      'chown valkey:valkey /var/log/valkey',
      'rc-update add valkey default',
      'rc-service valkey start',

      `cat > /tmp/ctech-logs.json << 'LOGSCFG'`,
      JSON.stringify({
        logGroup: logGroup.logGroupName,
        files: [{path: '/var/log/valkey/valkey.log', streamPrefix: 'valkey'}],
      }),
      'LOGSCFG',
      'ctech_run setup-ctech-ec2-agent.sh /tmp/ctech-logs.json',

      `cat > /opt/register-valkey.sh << 'REG'`,
      '#!/bin/bash',
      'export AWS_USE_DUALSTACK_ENDPOINT=true',
      `SSM_PATH="${this.urlSsmPath}"`,
      `DNS_NAME="${dnsName ?? ''}"`,
      'TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")',
      'LOCAL_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/local-ipv4")',
      ...(privateHostedZone ? [
        `HOSTED_ZONE_ID="${privateHostedZone.hostedZoneId}"`,
        `ctech-ec2-agent route53-upsert -zone-id "$HOSTED_ZONE_ID" -name "${dnsName}" -value "$LOCAL_IP"`,
      ] : []),
      'ENDPOINT_HOST="${DNS_NAME:-$LOCAL_IP}"',
      'ctech-ec2-agent ssm-put -name "$SSM_PATH" -value "redis://${ENDPOINT_HOST}:6379"',
      'echo "Registered Valkey base URL: redis://${ENDPOINT_HOST}:6379"',
      'REG',
      'chmod +x /opt/register-valkey.sh',
      'bash /opt/register-valkey.sh',
      // Alpine's cloud image does not enable a cron daemon by default;
      // busybox-openrc supplies /etc/init.d/crond over the busybox applet
      // that is already present. Hourly re-registration self-heals a stale
      // SSM/DNS entry the way setup-realip.sh's daily refresh does.
      'apk add --no-cache busybox-openrc',
      'rc-update add crond default',
      'rc-service crond start',
      // Append, don't overwrite: this runs on every boot (see
      // ctech-userdata), and blindly overwriting /etc/crontabs/root would
      // erase any other job a future consumer relies on (e.g.
      // setup-realip.sh's daily periodic run). The random minute changes
      // every boot, so strip any previous copy of this line by content
      // first instead of matching on the whole line.
      'touch /etc/crontabs/root',
      "sed -i '/register-valkey\\.sh/d' /etc/crontabs/root",
      'echo "$(( RANDOM % 60 )) * * * * root /opt/register-valkey.sh" >> /etc/crontabs/root',
    );

    const machineImage = ec2.MachineImage.fromSsmParameter(
      SSM.amiAlpine(environment).arm64,
      {os: ec2.OperatingSystemType.LINUX},
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'ValkeyLaunchTemplate', {
      launchTemplateName: `${environment}-ctech-valkey-v2-lt`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(1, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
          encrypted: true,
        }),
      }],
      userData,
      instanceProfile,
      requireImdsv2: true,
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
    cfnLT.addPropertyOverride(
      'LaunchTemplateData.TagSpecifications',
      [{ResourceType: 'instance', Tags: [{Key: 'Name', Value: `${environment}-ctech-valkey-v2`}]}],
    );

    const asg = new autoscaling.AutoScalingGroup(this, 'ValkeyASG', {
      autoScalingGroupName: `${environment}-ctech-valkey-v2`,
      vpc,
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      mixedInstancesPolicy: {
        launchTemplate,
        instancesDistribution: {
          onDemandPercentageAboveBaseCapacity: 0,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
        },
      },
      capacityRebalance: true,
      minCapacity: isProd ? 1 : 0,
      maxCapacity: 1,
      cooldown: cdk.Duration.minutes(5),
    });

    if (props.schedule) {
      addAsgSchedule(asg, {minCapacity: isProd ? 1 : 0, maxCapacity: 1}, props.schedule);
    }

    new ssm.StringParameter(this, 'ValkeyUrlPlaceholder', {
      parameterName: this.urlSsmPath,
      stringValue: 'pending-first-boot',
      description: `Shared Valkey base URL (Alpine) - overwritten by EC2 instance at boot (${environment})`,
    });

    new cdk.CfnOutput(this, 'ValkeyUrlSsmPath', {value: this.urlSsmPath, exportName: `${id}-url-ssm-path`});
    new cdk.CfnOutput(this, 'ValkeyAsgName', {value: asg.autoScalingGroupName, exportName: `${id}-asg-name`});
    if (dnsName) {
      new cdk.CfnOutput(this, 'ValkeyDnsName', {value: dnsName, exportName: `${id}-dns-name`});
    }
  }
}
