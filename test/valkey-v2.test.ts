import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {ValkeyStackV2} from '../lib/valkey-stack-v2';

function synth() {
  const app = new cdk.App({context: {'aws:cdk:bundling-stacks': []}});
  const base = new cdk.Stack(app, 'Base', {env: {account: '111111111111', region: 'us-east-1'}});
  const vpc = new ec2.Vpc(base, 'Vpc', {
    availabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c', 'us-east-1d', 'us-east-1e', 'us-east-1f'],
  });
  const stack = new ValkeyStackV2(app, 'Ctech-Prod-ValkeyV2', {
    env: {account: '111111111111', region: 'us-east-1'},
    environment: 'prod',
    vpc,
  });
  return {template: Template.fromStack(stack), stack};
}

test('keeps the same SSM URL contract as ValkeyStack, so no service repository changes', () => {
  const {template} = synth();
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/prod/valkey/url',
  });
});

test('boots from the Alpine AMI via an SSM parameter, not a hardcoded AMI id', () => {
  const {template} = synth();
  const templates = template.findResources('AWS::EC2::LaunchTemplate');
  const data = JSON.stringify(Object.values(templates)[0].Properties.LaunchTemplateData);
  assert.doesNotMatch(data, /"ImageId":"ami-[0-9a-f]+"/, 'AMI id must resolve via SSM, not a literal ami- string');
  template.hasParameter('*', Match.objectLike({
    Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
    Default: '/ctech/prod/ami/alpine/arm64',
  }));
});

test('targets a 1 GiB root volume', () => {
  const {template} = synth();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({
      BlockDeviceMappings: [Match.objectLike({Ebs: Match.objectLike({VolumeSize: 1, Encrypted: true})})],
    }),
  });
});

test('user data calls ctech-ec2-agent, never the AWS CLI', () => {
  const {template} = synth();
  const templates = template.findResources('AWS::EC2::LaunchTemplate');
  const userData = JSON.stringify(Object.values(templates)[0].Properties.LaunchTemplateData.UserData);
  assert.match(userData, /ctech-ec2-agent/);
  assert.doesNotMatch(userData, /\baws ssm\b|\baws s3\b|\baws route53\b/);
});

test('keeps one instance in prod, matching ValkeyStack today', () => {
  const {template} = synth();
  template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    MinSize: '1',
    MaxSize: '2',
  });
});

test('excludes us-east-1e from the t4g ASG while retaining the VPC subnet', () => {
  const {template} = synth();
  const [asg] = Object.values(template.findResources('AWS::AutoScaling::AutoScalingGroup'));
  assert.equal(asg.Properties.VPCZoneIdentifier.length, 5);
});
