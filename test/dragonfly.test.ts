import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import {test} from 'node:test';

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {Match, Template} from 'aws-cdk-lib/assertions';

import {DragonflyStack} from '../lib/dragonfly-stack';

/**
 * `aws:cdk:bundling-stacks: []` is what `cdk synth --no-bundling` sets. Without
 * it every run of this file would shell out to Docker and download the release
 * tarball just to render a template.
 */
function synth() {
  const app = new cdk.App({context: {'aws:cdk:bundling-stacks': []}});
  const base = new cdk.Stack(app, 'Base', {env: {account: '111111111111', region: 'us-east-1'}});
  const vpc = new ec2.Vpc(base, 'Vpc', {maxAzs: 2});
  const stack = new DragonflyStack(app, 'Ctech-Prod-Dragonfly', {
    env: {account: '111111111111', region: 'us-east-1'},
    environment: 'prod',
    vpc,
    schedule: {},
  });
  const template = Template.fromStack(stack);
  return {template, json: JSON.stringify(template.toJSON())};
}

test('runs the release binary with flags sized for a 512 MiB t4g.nano', () => {
  const {json} = synth();
  // Dragonfly exits at boot below 256 MiB per proactor thread, so this is a
  // floor; --rss_oom_deny_ratio is what actually protects the 512 MiB host.
  assert.match(json, /--maxmemory=256mb/);
  assert.match(json, /--rss_oom_deny_ratio=0\.7/);
  assert.match(json, /--dbnum=8/);
  // One proactor per core is the default; the nano has two and a second set of
  // arenas is pure overhead here.
  assert.match(json, /--proactor_threads=1/);
  // Empty dbfilename disables the shutdown snapshot on an ephemeral cache.
  assert.match(json, /--dbfilename=/);
  assert.match(json, /--cache_mode=true/);
});

test('bounds pub/sub buffers, which are not covered by --maxmemory', () => {
  const {json} = synth();
  // Defaults are 196 MB soft (x4 hard) and 128 MB per IO thread, on a 512 MiB box.
  assert.match(json, /--publish_buffer_limit=16mb/);
  assert.match(json, /--pipeline_buffer_limit=32mb/);
  assert.match(json, /--pubsub_slow_subscriber_timeout_ms=5000/);
});

test('gives the instance swap so an OOM kill cannot silently empty the cache', () => {
  const {json} = synth();
  assert.match(json, /ctech_run setup-swap\.sh '512'/);
});

test('an instance that never answers PING marks itself unhealthy', () => {
  const {template, json} = synth();
  assert.match(json, /set-instance-health/);
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([Match.objectLike({
        Action: 'autoscaling:SetInstanceHealth',
      })]),
    },
  });
});

test('keeps one instance in every environment and no dead scaling policy', () => {
  const {template} = synth();
  template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    MinSize: '1',
    MaxSize: '1',
  });
  // Scaling out on CacheUnavailable needed a publisher that never existed.
  template.resourceCountIs('AWS::AutoScaling::ScalingPolicy', 0);
  template.resourceCountIs('AWS::AutoScaling::ScheduledAction', 2);
});

test('keeps the Valkey SSM contract so no service repository changes', () => {
  const {template} = synth();
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/prod/valkey/url',
  });
});

test('encrypts the root volume', () => {
  const {template} = synth();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({
      BlockDeviceMappings: [Match.objectLike({Ebs: Match.objectLike({Encrypted: true})})],
    }),
  });
});

test('publishes a dimension-less rollup so the host memory alarm can match', () => {
  const {json} = synth();
  assert.match(json, /aggregation_dimensions/);
});

test('user data stays well inside the 16 KB EC2 limit', () => {
  const {template} = synth();
  const templates = template.findResources('AWS::EC2::LaunchTemplate');
  const userData = JSON.stringify(Object.values(templates)[0].Properties.LaunchTemplateData.UserData);
  assert.ok(userData.length < 12000, `user data renders to ${userData.length} bytes`);
});

test('the binary is downloaded from a pinned release, never compiled', () => {
  const install = readFileSync(path.join(__dirname, '..', 'assets', 'dragonfly', 'install.sh'), 'utf8');
  assert.match(install, /^SHA256=[0-9a-f]{64}$/m);
  assert.match(install, /sha256sum -c -/);
  assert.doesNotMatch(install, /ninja|blaze\.sh|git clone/);
});
