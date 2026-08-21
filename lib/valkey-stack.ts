import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {Environment} from './types';
import {SSM} from './constants';
import {addAsgSchedule, AsgScheduleProps} from './haproxy-ec2-service';

// Shared CW namespace used by all services to signal cache unavailability.
// Services publish CacheUnavailable=1 when running on NoCacheBackend.
// Convention: consumers must use this exact namespace and metric name.
export const VALKEY_METRIC_NAMESPACE = (env: string) => `CTech/${env}/Valkey`;
export const CACHE_UNAVAILABLE_METRIC = 'CacheUnavailable';

interface ValkeyStackProps extends cdk.StackProps {
  environment: Environment;
  vpc: ec2.Vpc;
  privateHostedZone?: route53.IPrivateHostedZone;
  schedule?: AsgScheduleProps;
}

export class ValkeyStack extends cdk.Stack {
  // SSM path the instance writes at boot: redis://private-dns-or-ip:6379 (no DB).
  // Consumers append their DB number: /0 = cache, /1 = ws pub/sub, /2+ future services.
  public readonly urlSsmPath: string;

  constructor(scope: Construct, id: string, props: ValkeyStackProps) {
    super(scope, id, props);

    const {environment, vpc, privateHostedZone} = props;
    const isProd = environment === 'prod';
    const dnsName = privateHostedZone ? `cache.${privateHostedZone.zoneName}` : undefined;

    this.urlSsmPath = SSM.valkey(environment).url;

    // ── Security Group ─────────────────────────────────────────────────────────
    // TCP 6379 inbound from VPC CIDR only - no public IPv4 on the instance.
    const sg = new ec2.SecurityGroup(this, 'ValkeySg', {
      vpc,
      securityGroupName: `${environment}-ctech-valkey-sg`,
      description: 'Shared Valkey - reachable from VPC only on port 6379',
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });
    sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6379), 'Valkey: VPC IPv4');

    // ── IAM Role ───────────────────────────────────────────────────────────────
    const role = new iam.Role(this, 'ValkeyRole', {
      roleName: `${environment}-ctech-valkey-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.urlSsmPath}`],
    }));
    if (privateHostedZone) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:${this.partition}:route53:::hostedzone/${privateHostedZone.hostedZoneId}`],
      }));
    }
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {StringEquals: {'cloudwatch:namespace': VALKEY_METRIC_NAMESPACE(environment)}},
    }));

    const instanceProfile = new iam.InstanceProfile(this, 'ValkeyInstanceProfile', {
      instanceProfileName: `${environment}-ctech-valkey-profile`,
      role,
    });

    // ── CloudWatch Log Group ───────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'ValkeyLogGroup', {
      logGroupName: `/ctech/${environment}/valkey`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ── User Data ──────────────────────────────────────────────────────────────
    // AL2023 ships Valkey natively - no external download needed.
    const userData = ec2.UserData.forLinux();

    userData.addCommands(
      'set -euo pipefail',
      'dnf install -y valkey amazon-cloudwatch-agent amazon-ssm-agent cronie',
      'systemctl enable --now crond',
      // ── System-wide dual-stack endpoint (SSM agent, CW agent, boto3 CLI) ────
      'echo "AWS_USE_DUALSTACK_ENDPOINT=true" >> /etc/environment',

      // ── SSM agent: force IPv6 dual-stack endpoint ────────────────────────────
      // Without this the SSM agent fails to connect when the instance has no public IPv4.
      `mkdir -p /etc/amazon/ssm`,
      `cat > /etc/amazon/ssm/amazon-ssm-agent.json << 'SSM'`,
      `{ "Agent": { "UseDualStackEndpoint": true } }`,
      `SSM`,
      'systemctl enable amazon-ssm-agent',
      'systemctl restart amazon-ssm-agent',

      // ── Valkey config ───────────────────────────────────────────────────────────
      // Pure cache mode: no persistence, LRU eviction, 128 DBs for service isolation.
      // SG-level security replaces bind restriction; protected-mode disabled.
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
      'VALKEYCONF',
      'systemctl enable valkey',
      'systemctl start valkey',

      // ── CloudWatch agent: OS memory metrics ──────────────────────────────────────
      'mkdir -p /etc/systemd/system/amazon-cloudwatch-agent.service.d',
      `cat > /etc/systemd/system/amazon-cloudwatch-agent.service.d/override.conf << 'CWAENV'`,
      '[Service]',
      'Environment=AWS_USE_DUALSTACK_ENDPOINT=true',
      'CWAENV',
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CWA'`,
      '{',
      '  "metrics": {',
      `    "namespace": "${VALKEY_METRIC_NAMESPACE(environment)}",`,
      '    "metrics_collected": {',
      '      "mem": { "measurement": ["mem_used_percent"], "metrics_collection_interval": 60 }',
      '    }',
      '  },',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      `          {"file_path":"/var/log/valkey/valkey.log","log_group_name":"${logGroup.logGroupName}","log_stream_name":"{instance_id}"}`,
      '        ]',
      '      }',
      '    }',
      '  }',
      '}',
      'CWA',
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s',

      // ── Custom Valkey metrics (per minute via cron) ─────────────────────────
      `cat > /opt/valkey-metrics.sh << 'METRICS'`,
      '#!/bin/bash',
      'set -uo pipefail',
      'export AWS_USE_DUALSTACK_ENDPOINT=true',
      `REGION="${this.region}"`,
      `NS="${VALKEY_METRIC_NAMESPACE(environment)}"`,

      'INFO=$(valkey-cli --raw INFO 2>/dev/null || true)',
      '[ -z "$INFO" ] && exit 0',

      'metric() {',
      '  echo "$INFO" | awk -F: -v key="$1" \'$1 == key { gsub("\\r", "", $2); print $2; exit }\'',
      '}',

      'USED_MEMORY=$(metric used_memory)',
      'MAXMEMORY=$(metric maxmemory)',
      'CONNECTED_CLIENTS=$(metric connected_clients)',
      'OPS=$(metric instantaneous_ops_per_sec)',
      'HITS=$(metric keyspace_hits)',
      'MISSES=$(metric keyspace_misses)',
      'EVICTED_KEYS=$(metric evicted_keys)',
      'REJECTED_CONNECTIONS=$(metric rejected_connections)',

      'MEMORY_USAGE_PERCENT=0',
      'if [ "${MAXMEMORY:-0}" -gt 0 ]; then',
      '  MEMORY_USAGE_PERCENT=$(awk "BEGIN { printf \\"%.2f\\", (${USED_MEMORY:-0} / ${MAXMEMORY:-1}) * 100 }")',
      'fi',

      'aws cloudwatch put-metric-data --region "$REGION" \\',
      '  --namespace "$NS" \\',
      '  --metric-data "[' +
      '{\\"MetricName\\":\\"UsedMemoryBytes\\",\\"Value\\":${USED_MEMORY:-0},\\"Unit\\":\\"Bytes\\"},' +
      '{\\"MetricName\\":\\"MemoryUsagePercent\\",\\"Value\\":${MEMORY_USAGE_PERCENT:-0},\\"Unit\\":\\"Percent\\"},' +
      '{\\"MetricName\\":\\"ConnectedClients\\",\\"Value\\":${CONNECTED_CLIENTS:-0},\\"Unit\\":\\"Count\\"},' +
      '{\\"MetricName\\":\\"OperationsPerSecond\\",\\"Value\\":${OPS:-0},\\"Unit\\":\\"Count/Second\\"},' +
      '{\\"MetricName\\":\\"KeyspaceHits\\",\\"Value\\":${HITS:-0},\\"Unit\\":\\"Count\\"},' +
      '{\\"MetricName\\":\\"KeyspaceMisses\\",\\"Value\\":${MISSES:-0},\\"Unit\\":\\"Count\\"},' +
      '{\\"MetricName\\":\\"EvictedKeys\\",\\"Value\\":${EVICTED_KEYS:-0},\\"Unit\\":\\"Count\\"},' +
      '{\\"MetricName\\":\\"RejectedConnections\\",\\"Value\\":${REJECTED_CONNECTIONS:-0},\\"Unit\\":\\"Count\\"}' +
      ']"',

      'METRICS',
      'chmod +x /opt/valkey-metrics.sh',
      'echo "* * * * * root /opt/valkey-metrics.sh" > /etc/cron.d/valkey-metrics',
      'chmod 644 /etc/cron.d/valkey-metrics',

      // ── Register private DNS/IP in SSM (no DB - consumers append /0, /1, etc.) ────
      `cat > /opt/register-valkey.sh << 'REG'`,
      '#!/bin/bash',
      'export AWS_USE_DUALSTACK_ENDPOINT=true',
      `REGION="${this.region}"`,
      `SSM_PATH="${this.urlSsmPath}"`,
      `DNS_NAME="${dnsName ?? ''}"`,
      'TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")',
      'LOCAL_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/local-ipv4")',
      ...(privateHostedZone ? [
        `HOSTED_ZONE_ID="${privateHostedZone.hostedZoneId}"`,
        `cat > /tmp/valkey-dns-change.json << DNS`,
        '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"' + dnsName + '","Type":"A","TTL":10,"ResourceRecords":[{"Value":"' + '${LOCAL_IP}' + '"}]}}]}',
        'DNS',
        'aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch file:///tmp/valkey-dns-change.json',
        'rm -f /tmp/valkey-dns-change.json',
      ] : []),
      'ENDPOINT_HOST="${DNS_NAME:-$LOCAL_IP}"',
      'aws ssm put-parameter --region "$REGION" --name "$SSM_PATH" --value "redis://${ENDPOINT_HOST}:6379" --type String --overwrite',
      'echo "Registered Valkey base URL: redis://${ENDPOINT_HOST}:6379"',
      'REG',
      'chmod +x /opt/register-valkey.sh',
      'bash /opt/register-valkey.sh',
      'echo "@reboot root /opt/register-valkey.sh" > /etc/cron.d/valkey-register',
      'chmod 644 /etc/cron.d/valkey-register',
    );
    // ── Launch Template ───────────────────────────────────────────────────────
    const launchTemplate = new ec2.LaunchTemplate(this, 'ValkeyLaunchTemplate', {
      launchTemplateName: `${environment}-ctech-valkey-lt`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
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

    // ── Auto Scaling Group ─────────────────────────────────────────────────────
    // prod: minCapacity=1 - always on, scale-in disabled.
    // non-prod: minCapacity=0 - starts on demand, scales in when idle.
    const asg = new autoscaling.AutoScalingGroup(this, 'ValkeyASG', {
      autoScalingGroupName: `${environment}-ctech-valkey`,
      vpc,
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      mixedInstancesPolicy: {
        launchTemplate: launchTemplate,
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

    if (!isProd) {
      // ── Scale-out (0→1): triggered by services reporting CacheUnavailable ───────
      // Any service running on NoCacheBackend publishes CacheUnavailable=1 to this
      // namespace. The alarm fires after 2 consecutive minutes (fast response).
      // treatMissingData=NOT_BREACHING: no false alarms when all services are down.
      asg.scaleOnMetric('ScaleOutOnCacheUnavailable', {
        metric: new cloudwatch.Metric({
          namespace: VALKEY_METRIC_NAMESPACE(environment),
          metricName: CACHE_UNAVAILABLE_METRIC,
          statistic: 'Sum',
          period: cdk.Duration.minutes(1),
        }),
        // CDK requires at least two intervals: the 0 bucket is an explicit no-op.
        scalingSteps: [{upper: 0, change: 0}, {lower: 1, change: +1}],
        adjustmentType: autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
        cooldown: cdk.Duration.minutes(5),
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
      });

      // ── Scale-in (1→0): 0 connected clients for 30 min ───────────────────────
      // treatMissingData=NOT_BREACHING: missing metrics (no instance) don't trigger scale-in.
      asg.scaleOnMetric('ScaleInWhenIdle', {
        metric: new cloudwatch.Metric({
          namespace: VALKEY_METRIC_NAMESPACE(environment),
          metricName: 'ConnectedClients',
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
        scalingSteps: [{upper: 0, change: -1}, {lower: 1, change: 0}],
        adjustmentType: autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
        cooldown: cdk.Duration.minutes(30),
        evaluationPeriods: 6,
        datapointsToAlarm: 6,
      });
    }

    // Nightly stop/start. Applied to every environment, production included:
    // treat the cache as unavailable in the window, exactly as when the ASG is
    // being replaced. prod's minCapacity is 1, so enable restores one instance.
    if (props.schedule) {
      addAsgSchedule(asg, {minCapacity: isProd ? 1 : 0, maxCapacity: 1}, props.schedule);
    }

    // ── RAM monitoring alarm (informational for all environments) ─────────────
    // new cloudwatch.Alarm(this, 'ValkeyHighMemAlarm', {
    //   alarmName: `${environment}-ctech-valkey-high-mem`,
    //   alarmDescription: 'Valkey RAM > 80% - increase maxmemory or upgrade instance',
    //   metric: new cloudwatch.Metric({
    //     namespace: VALKEY_METRIC_NAMESPACE(environment),
    //     metricName: 'mem_used_percent',
    //     statistic: 'Average',
    //     period: cdk.Duration.minutes(5),
    //   }),
    //   threshold: 80,
    //   comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    //   evaluationPeriods: 3,
    //   treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    // });

    // ── SSM placeholder (overwritten by instance at first boot) ──────────────
    new ssm.StringParameter(this, 'ValkeyUrlPlaceholder', {
      parameterName: this.urlSsmPath,
      stringValue: 'pending-first-boot',
      description: `Shared Valkey base URL - overwritten by EC2 instance at boot (${environment})`,
    });

    new cdk.CfnOutput(this, 'ValkeyUrlSsmPath', {value: this.urlSsmPath, exportName: `${id}-url-ssm-path`});
    new cdk.CfnOutput(this, 'ValkeyAsgName', {value: asg.autoScalingGroupName, exportName: `${id}-asg-name`});
    new cdk.CfnOutput(this, 'ValkeySgId', {value: sg.securityGroupId, exportName: `${id}-sg-id`});
    if (dnsName) {
      new cdk.CfnOutput(this, 'ValkeyDnsName', {value: dnsName, exportName: `${id}-dns-name`});
    }
  }
}
