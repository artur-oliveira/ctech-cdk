import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';

import {Environment} from './types';
import {SSM} from './constants';
import {addAsgSchedule, AsgScheduleProps} from './haproxy-ec2-service';
import {buildCloudWatchAgentConfig} from './cloudwatch-agent-config';
import {Ec2ScriptRunner} from './ec2-script-runner';

export const DRAGONFLY_METRIC_NAMESPACE = (env: string) => `CTech/${env}/Dragonfly`;

/**
 * Dataset cap, not process RSS. Dragonfly sits at roughly dataset + 20-40% once
 * connection buffers and the proactor arena are counted, and it shares a 512 MiB
 * t4g.nano with the SSM and CloudWatch agents. 64 MiB is the working-set size the
 * CTech services actually need; the rest of the box is headroom on purpose.
 */
const MAXMEMORY = '64mb';

/** /0 cache, /1 ws pub/sub, /2+ per service. 8 leaves room without paying for 128. */
const DBNUM = 8;

interface DragonflyStackProps extends cdk.StackProps {
  environment: Environment;
  vpc: ec2.Vpc;
  privateHostedZone?: route53.IPrivateHostedZone;
  schedule?: AsgScheduleProps;
}

/**
 * Shared Dragonfly cache and pub/sub endpoint - the Valkey replacement.
 *
 * It deliberately keeps the Valkey contract: the same `/ctech/{env}/valkey/url`
 * parameter and the same `cache.{zone}` record, so no service repository has to
 * change. The two stacks therefore cannot be deployed side by side; the Valkey
 * stack has to be deleted first.
 */
export class DragonflyStack extends cdk.Stack {
  public readonly urlSsmPath: string;

  constructor(scope: Construct, id: string, props: DragonflyStackProps) {
    super(scope, id, props);

    const {environment, vpc, privateHostedZone} = props;
    const isProd = environment === 'prod';
    const dnsName = privateHostedZone ? `cache.${privateHostedZone.zoneName}` : undefined;
    const asgName = `${environment}-ctech-dragonfly`;
    this.urlSsmPath = SSM.valkey(environment).url;

    // The bundling container only downloads and checksums the published aarch64
    // release, so it needs no toolchain and no platform emulation. See
    // assets/dragonfly/install.sh for why the version lives in the asset.
    const dragonflyAsset = new s3assets.Asset(this, 'DragonflyBinaryAsset', {
      path: path.join(__dirname, '../assets/dragonfly'),
      bundling: {
        user: 'root',
        image: cdk.DockerImage.fromRegistry('public.ecr.aws/amazonlinux/amazonlinux:2023'),
        command: ['bash', '/asset-input/install.sh'],
        outputType: cdk.BundlingOutput.NOT_ARCHIVED,
      },
    });

    const scripts = new Ec2ScriptRunner(this, 'Scripts', {environment});

    const sg = new ec2.SecurityGroup(this, 'DragonflySg', {
      vpc,
      securityGroupName: `${environment}-ctech-dragonfly-sg`,
      description: 'Shared Dragonfly - reachable from VPC only on port 6379',
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });
    sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6379), 'Dragonfly: VPC IPv4');

    const role = new iam.Role(this, 'DragonflyRole', {
      roleName: `${environment}-ctech-dragonfly-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    dragonflyAsset.grantRead(role);
    scripts.grantRead(role);

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
      conditions: {StringEquals: {'cloudwatch:namespace': DRAGONFLY_METRIC_NAMESPACE(environment)}},
    }));
    // Lets a boot that never reached a healthy PING mark itself for replacement.
    // The group ARN embeds a generated id, so only the name segment can be pinned.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['autoscaling:SetInstanceHealth'],
      resources: [
        `arn:${this.partition}:autoscaling:${this.region}:${this.account}:autoScalingGroup:*:autoScalingGroupName/${asgName}`,
      ],
    }));

    const instanceProfile = new iam.InstanceProfile(this, 'DragonflyInstanceProfile', {
      instanceProfileName: `${environment}-ctech-dragonfly-profile`,
      role,
    });

    const logGroup = new logs.LogGroup(this, 'DragonflyLogGroup', {
      logGroupName: `/ctech/${environment}/dragonfly`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'export AWS_USE_DUALSTACK_ENDPOINT=true',
    );
    scripts.install(userData);

    userData.addCommands(
      // zlib is the only shared library the release binary needs beyond glibc.
      'dnf install -y amazon-cloudwatch-agent amazon-ssm-agent cronie python3 zlib',
      'systemctl enable --now crond',
    );
    scripts.run(userData, 'setup-dualstack.sh');
    // 512 MiB of swap on a 512 MiB box. Without it the OOM killer picks the
    // largest RSS - Dragonfly - and Restart=always brings it back empty, which
    // looks like a healthy cache that silently lost everything.
    scripts.run(userData, 'setup-swap.sh', '512');

    userData.addCommands(
      'id dragonfly >/dev/null 2>&1 || useradd --system --home-dir /var/lib/dragonfly --shell /sbin/nologin dragonfly',
      'install -d -o dragonfly -g dragonfly -m 0750 /var/lib/dragonfly',
      'install -d -o dragonfly -g dragonfly -m 0750 /var/log/dragonfly',
      'install -d -o root -g dragonfly -m 0750 /etc/dragonfly',

      `aws s3 cp "s3://${dragonflyAsset.s3BucketName}/${dragonflyAsset.s3ObjectKey}" /tmp/dragonfly-asset.zip`,
      'rm -rf /tmp/dragonfly-asset',
      'mkdir -p /tmp/dragonfly-asset',
      // AL2023 minimal ships no unzip; python3 is already here for the metrics poller.
      'python3 - << \'PY\'',
      'import zipfile',
      'with zipfile.ZipFile("/tmp/dragonfly-asset.zip") as z:',
      '    z.extractall("/tmp/dragonfly-asset")',
      'PY',
      'install -m 0755 /tmp/dragonfly-asset/dragonfly /usr/local/bin/dragonfly',
      'rm -rf /tmp/dragonfly-asset /tmp/dragonfly-asset.zip',
      '/usr/local/bin/dragonfly --version',

      'cat > /etc/dragonfly/dragonfly.flags << \'FLAGS\'',
      '--bind=0.0.0.0',
      '--port=6379',
      '--cache_mode=true',
      `--maxmemory=${MAXMEMORY}`,
      `--dbnum=${DBNUM}`,
      // Default is one proactor per core; the nano has two, and a second thread
      // only buys a second set of arenas on a box this size.
      '--proactor_threads=1',
      // Dragonfly snapshots to its working directory on SIGTERM by default. This
      // is an ephemeral cache scaled to zero every night, so the dump would only
      // slow shutdown down.
      '--dbfilename=',
      // Pub/Sub back-pressure. The defaults are sized for a large host: the soft
      // limit is 196 MB per IO thread and the hard limit is 4x that, so a single
      // slow PSUBSCRIBE - which is exactly what ctech-go-common/ws does, one per
      // API instance - could queue more than the whole box before a publisher is
      // ever parked. None of it counts against --maxmemory.
      '--publish_buffer_limit=16mb',
      '--pipeline_buffer_limit=32mb',
      // Off by default. Without it a subscriber that stops draining parks every
      // publisher instead of being dropped; the ws registry resubscribes on close.
      '--pubsub_slow_subscriber_timeout_ms=5000',
      '--primary_port_http_enabled=false',
      '--tcp_keepalive=60',
      '--timeout=0',
      '--logtostderr',
      'FLAGS',
      'chown root:dragonfly /etc/dragonfly/dragonfly.flags',
      'chmod 0640 /etc/dragonfly/dragonfly.flags',

      'cat > /etc/systemd/system/dragonfly.service << \'UNIT\'',
      '[Unit]',
      'Description=Dragonfly in-memory datastore',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=dragonfly',
      'Group=dragonfly',
      'WorkingDirectory=/var/lib/dragonfly',
      'ExecStart=/usr/local/bin/dragonfly --flagfile=/etc/dragonfly/dragonfly.flags',
      'Restart=always',
      'RestartSec=2',
      'LimitNOFILE=1048576',
      'LimitMEMLOCK=infinity',
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'StandardOutput=append:/var/log/dragonfly/dragonfly.log',
      'StandardError=append:/var/log/dragonfly/dragonfly.log',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'UNIT',
      'systemctl daemon-reload',
      'systemctl enable dragonfly',
      'systemctl start dragonfly',

      'cat > /opt/dragonfly-ping.py << \'PY\'',
      'import socket',
      'import sys',
      '',
      'try:',
      '    with socket.create_connection(("127.0.0.1", 6379), timeout=2) as s:',
      '        s.sendall(b"*1\\r\\n$4\\r\\nPING\\r\\n")',
      '        reply = s.recv(128)',
      '        sys.exit(0 if reply.startswith(b"+PONG") else 1)',
      'except Exception:',
      '    sys.exit(1)',
      'PY',

      'for i in $(seq 1 60); do',
      '  if python3 /opt/dragonfly-ping.py; then',
      '    break',
      '  fi',
      '  sleep 1',
      'done',
      // A boot that gets here without a PONG must not stay InService: the ASG
      // health check is EC2-level and would keep an empty instance serving the
      // DNS record forever.
      'if ! python3 /opt/dragonfly-ping.py; then',
      '  echo "dragonfly did not answer PING within 60s" >&2',
      '  IMDS_TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")',
      '  INSTANCE_ID=$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/instance-id")',
      `  aws autoscaling set-instance-health --region ${this.region} --instance-id "$INSTANCE_ID" --health-status Unhealthy --no-should-respect-grace-period || true`,
      '  exit 1',
      'fi',

      'cat > /tmp/cwagent.json << \'CWA\'',
      buildCloudWatchAgentConfig({
        metricNamespace: DRAGONFLY_METRIC_NAMESPACE(environment),
        appProcessPattern: 'dragonfly --flagfile',
        logFiles: [{
          filePath: '/var/log/dragonfly/dragonfly.log',
          logGroupName: logGroup.logGroupName,
          logStreamName: '{instance_id}',
        }],
      }),
      'CWA',
    );
    scripts.run(userData, 'setup-cloudwatch-agent.sh', '/tmp/cwagent.json');

    userData.addCommands(
      'cat > /opt/dragonfly-metrics.py << \'PY\'',
      'import socket',
      '',
      'def command(*args):',
      '    request = f"*{len(args)}\\r\\n".encode()',
      '    for arg in args:',
      '        encoded = str(arg).encode()',
      '        request += f"${len(encoded)}\\r\\n".encode()',
      '        request += encoded + b"\\r\\n"',
      '    with socket.create_connection(("127.0.0.1", 6379), timeout=2) as s:',
      '        s.sendall(request)',
      '        chunks = []',
      '        while True:',
      '            chunk = s.recv(65536)',
      '            if not chunk:',
      '                break',
      '            chunks.append(chunk)',
      '            if len(chunk) < 65536:',
      '                break',
      '        return b"".join(chunks).decode(errors="replace")',
      '',
      'def info(section):',
      '    raw = command("INFO", section)',
      '    first = raw.find("\\r\\n")',
      '    if raw.startswith("$") and first >= 0:',
      '        raw = raw[first + 2:]',
      '    result = {}',
      '    for line in raw.splitlines():',
      '        if ":" not in line:',
      '            continue',
      '        key, value = line.split(":", 1)',
      '        result[key] = value',
      '    return result',
      '',
      'try:',
      '    clients = info("clients")',
      '    memory = info("memory")',
      '    print(int(clients.get("connected_clients", "0")))',
      '    print(int(memory.get("used_memory", "0")))',
      'except Exception:',
      '    print(0)',
      '    print(0)',
      'PY',

      'cat > /opt/dragonfly-metrics.sh << \'METRICS\'',
      '#!/bin/bash',
      'set -u',
      'export AWS_USE_DUALSTACK_ENDPOINT=true',
      `REGION="${this.region}"`,
      `NS="${DRAGONFLY_METRIC_NAMESPACE(environment)}"`,
      '',
      'mapfile -t VALUES < <(python3 /opt/dragonfly-metrics.py)',
      'CLIENTS="${VALUES[0]:-0}"',
      'MEM="${VALUES[1]:-0}"',
      '',
      'aws cloudwatch put-metric-data \\',
      '  --region "$REGION" \\',
      '  --namespace "$NS" \\',
      '  --metric-data "[',
      '    {\\"MetricName\\":\\"ConnectedClients\\",\\"Value\\":${CLIENTS:-0},\\"Unit\\":\\"Count\\"},',
      '    {\\"MetricName\\":\\"UsedMemoryBytes\\",\\"Value\\":${MEM:-0},\\"Unit\\":\\"Bytes\\"}',
      '  ]"',
      'METRICS',
      'chmod +x /opt/dragonfly-metrics.sh',
      'echo "* * * * * root /opt/dragonfly-metrics.sh" > /etc/cron.d/dragonfly-metrics',
      'chmod 0644 /etc/cron.d/dragonfly-metrics',

      'cat > /opt/register-dragonfly.sh << \'REG\'',
      '#!/bin/bash',
      'set -euo pipefail',
      'export AWS_USE_DUALSTACK_ENDPOINT=true',
      `REGION="${this.region}"`,
      `SSM_PATH="${this.urlSsmPath}"`,
      `DNS_NAME="${dnsName ?? ''}"`,
      '',
      'TOKEN=$(curl -sf -X PUT \\',
      '  "http://169.254.169.254/latest/api/token" \\',
      '  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")',
      'LOCAL_IP=$(curl -sf \\',
      '  -H "X-aws-ec2-metadata-token: $TOKEN" \\',
      '  "http://169.254.169.254/latest/meta-data/local-ipv4")',
      ...(privateHostedZone ? [
        `HOSTED_ZONE_ID="${privateHostedZone.hostedZoneId}"`,
        'cat > /tmp/dragonfly-dns-change.json << DNS',
        JSON.stringify({
          Changes: [{
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: dnsName,
              Type: 'A',
              TTL: 10,
              ResourceRecords: [{Value: '${LOCAL_IP}'}],
            },
          }],
        }),
        'DNS',
        'aws route53 change-resource-record-sets \\',
        '  --hosted-zone-id "$HOSTED_ZONE_ID" \\',
        '  --change-batch file:///tmp/dragonfly-dns-change.json',
        'rm -f /tmp/dragonfly-dns-change.json',
      ] : []),
      '',
      'ENDPOINT_HOST="${DNS_NAME:-$LOCAL_IP}"',
      'aws ssm put-parameter \\',
      '  --region "$REGION" \\',
      '  --name "$SSM_PATH" \\',
      '  --value "redis://${ENDPOINT_HOST}:6379" \\',
      '  --type String \\',
      '  --overwrite',
      'echo "Registered Dragonfly base URL: redis://${ENDPOINT_HOST}:6379"',
      'REG',
      'chmod +x /opt/register-dragonfly.sh',
      'bash /opt/register-dragonfly.sh',
      'echo "@reboot root /opt/register-dragonfly.sh" > /etc/cron.d/dragonfly-register',
      'chmod 0644 /etc/cron.d/dragonfly-register',
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'DragonflyLaunchTemplate', {
      launchTemplateName: `${environment}-ctech-dragonfly-lt`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        edition: ec2.AmazonLinuxEdition.MINIMAL,
      }),
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(4, {
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

    // One instance in every environment. Scaling from zero on demand needs a
    // metric that some service publishes while the cache is down, and nothing in
    // the organisation publishes one; the nightly schedule is what takes non-prod
    // (and prod) to zero overnight instead.
    const asg = new autoscaling.AutoScalingGroup(this, 'DragonflyASG', {
      autoScalingGroupName: asgName,
      vpc,
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      cooldown: cdk.Duration.minutes(5),
    });

    if (props.schedule) {
      addAsgSchedule(asg, {minCapacity: 1, maxCapacity: 1}, props.schedule);
    }

    // buildCloudWatchAgentConfig publishes a dimension-less rollup alongside the
    // per-InstanceId series, which is what makes a fleet alarm on a metric from
    // an ASG-managed host possible at all.
    new cloudwatch.Alarm(this, 'DragonflyHighMemAlarm', {
      alarmName: `${environment}-ctech-dragonfly-high-mem`,
      alarmDescription: `Dragonfly host RAM > 80% - lower --maxmemory (now ${MAXMEMORY}) or upgrade the instance`,
      metric: new cloudwatch.Metric({
        namespace: DRAGONFLY_METRIC_NAMESPACE(environment),
        metricName: 'mem_used_percent',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new ssm.StringParameter(this, 'DragonflyUrlPlaceholder', {
      parameterName: this.urlSsmPath,
      stringValue: 'pending-first-boot',
      description: `Shared Dragonfly base URL - overwritten by EC2 instance at boot (${environment})`,
    });

    new cdk.CfnOutput(this, 'DragonflyUrlSsmPath', {
      value: this.urlSsmPath,
      exportName: `${id}-url-ssm-path`,
    });
    new cdk.CfnOutput(this, 'DragonflyAsgName', {
      value: asg.autoScalingGroupName,
      exportName: `${id}-asg-name`,
    });
    new cdk.CfnOutput(this, 'DragonflySgId', {
      value: sg.securityGroupId,
      exportName: `${id}-sg-id`,
    });
    if (dnsName) {
      new cdk.CfnOutput(this, 'DragonflyDnsName', {
        value: dnsName,
        exportName: `${id}-dns-name`,
      });
    }
  }
}
