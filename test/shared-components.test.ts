import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cdk from 'aws-cdk-lib';
import {Match, Template} from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  addCloudflareOriginCaCommands,
  buildCloudWatchAgentConfig,
  HaproxyEc2Service,
} from '../lib';

test('addCloudflareOriginCaCommands downloads only the pinned official RSA root', () => {
  const userData = ec2.UserData.forLinux();
  addCloudflareOriginCaCommands(userData);

  const rendered = userData.render();
  assert.match(rendered, /origin_ca_rsa_root\.pem/);
  assert.match(rendered, /cloudflare-origin-ca-rsa\.pem/);
  assert.match(rendered, /91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae/);
  assert.match(rendered, /sha256sum --check --strict/);
  assert.match(rendered, /openssl x509.*-checkend 86400/);
  assert.match(rendered, /rm -f .*cloudflare-origin-ca-ecc\.pem/);
  assert.match(rendered, /update-ca-trust extract/);
  assert.doesNotMatch(rendered, /BEGIN CERTIFICATE|origin_ca_ecc_root\.pem/);
});

test('buildCloudWatchAgentConfig emits the bounded host metric set', () => {
  const config = JSON.parse(buildCloudWatchAgentConfig({
    metricNamespace: 'CtechExample/prod/Host',
    appProcessPattern: '/opt/app/current/app',
    logFiles: [{
      filePath: '/var/log/app/app.log',
      logGroupName: '/ctech-example/prod/app',
      logStreamName: '{instance_id}',
    }],
  }));

  assert.equal(config.metrics.namespace, 'CtechExample/prod/Host');
  assert.equal(config.metrics.append_dimensions.InstanceId, '${aws:InstanceId}');
  assert.deepEqual(Object.keys(config.metrics.metrics_collected).sort(), ['disk', 'mem', 'procstat', 'swap']);
  assert.equal(config.agent.metrics_collection_interval, 60);
});

test('HaproxyEc2Service synthesizes ASG, dual-stack launch template and route', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'ServiceFixture');
  const vpc = new ec2.Vpc(stack, 'Vpc', {natGateways: 0, maxAzs: 2});
  const edgeSecurityGroup = new ec2.SecurityGroup(stack, 'Edge', {vpc});

  new HaproxyEc2Service(stack, 'Service', {
    vpc,
    edgeSecurityGroup,
    appPort: 8080,
    userData: ec2.UserData.forLinux(),
    instanceProfileName: 'dev-ctech-example',
    securityGroupName: 'dev-ctech-example-sg',
    securityGroupDescription: 'Example service instances',
    appLogGroupName: '/ctech-example/dev/app',
    nginxLogGroupName: '/ctech-example/dev/nginx',
    logRetention: logs.RetentionDays.ONE_WEEK,
    logRemovalPolicy: cdk.RemovalPolicy.DESTROY,
    asgName: 'dev-ctech-example',
    minCapacity: 1,
    maxCapacity: 3,
    route: {
      parameterName: '/ctech/dev/lbalancer/routes/example',
      hostname: 'example-api-dev.aoctech.app',
      healthPath: '/v1.0/health-check',
      healthyStatuses: [200, 207],
    },
  });

  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
  template.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
  template.resourceCountIs('AWS::SSM::Parameter', 1);
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({
      MetadataOptions: {HttpTokens: 'required'},
      NetworkInterfaces: [Match.objectLike({
        AssociatePublicIpAddress: false,
        Ipv6AddressCount: 1,
      })],
    }),
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/dev/lbalancer/routes/example',
    Tier: 'Standard',
  });
});

test('buildCloudWatchAgentConfig emits compact JSON to conserve user data', () => {
  const config = buildCloudWatchAgentConfig({
    metricNamespace: 'CtechExample/prod/Host',
    logFiles: [{
      filePath: '/var/log/app/app.log',
      logGroupName: '/ctech-example/prod/app',
      logStreamName: '{instance_id}',
    }],
  });
  assert.doesNotMatch(config, /\n/, 'config must be a single line');
  assert.ok(JSON.parse(config));
});

test('HaproxyEc2Service schedules disable to zero and enable back to configured capacity', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'ScheduleFixture', {
    env: {account: '111111111111', region: 'us-east-1'},
  });
  const vpc = new ec2.Vpc(stack, 'Vpc');
  new HaproxyEc2Service(stack, 'Svc', {
    vpc,
    edgeSecurityGroup: new ec2.SecurityGroup(stack, 'Edge', {vpc}),
    appPort: 8080,
    userData: ec2.UserData.forLinux(),
    instanceProfileName: 'fixture-profile',
    securityGroupName: 'fixture-sg',
    securityGroupDescription: 'fixture',
    appLogGroupName: '/fixture/app',
    logRetention: logs.RetentionDays.ONE_WEEK,
    logRemovalPolicy: cdk.RemovalPolicy.DESTROY,
    asgName: 'fixture-asg',
    minCapacity: 1,
    maxCapacity: 3,
    schedule: {},
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::AutoScaling::ScheduledAction', {
    Recurrence: '0 22 * * *',
    TimeZone: 'America/Sao_Paulo',
    MinSize: 0,
    MaxSize: 0,
    DesiredCapacity: 0,
  });
  template.hasResourceProperties('AWS::AutoScaling::ScheduledAction', {
    Recurrence: '0 10 * * *',
    TimeZone: 'America/Sao_Paulo',
    MinSize: 1,
    MaxSize: 3,
    DesiredCapacity: 1,
  });
});

test('HaproxyEc2Service registers no scheduled action when schedule is omitted', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'NoScheduleFixture', {
    env: {account: '111111111111', region: 'us-east-1'},
  });
  const vpc = new ec2.Vpc(stack, 'Vpc');
  new HaproxyEc2Service(stack, 'Svc', {
    vpc,
    edgeSecurityGroup: new ec2.SecurityGroup(stack, 'Edge', {vpc}),
    appPort: 8080,
    userData: ec2.UserData.forLinux(),
    instanceProfileName: 'fixture-profile',
    securityGroupName: 'fixture-sg',
    securityGroupDescription: 'fixture',
    appLogGroupName: '/fixture/app',
    logRetention: logs.RetentionDays.ONE_WEEK,
    logRemovalPolicy: cdk.RemovalPolicy.DESTROY,
    asgName: 'fixture-asg',
    minCapacity: 1,
    maxCapacity: 1,
  });
  Template.fromStack(stack).resourceCountIs('AWS::AutoScaling::ScheduledAction', 0);
});
