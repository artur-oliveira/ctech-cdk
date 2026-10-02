import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import {Template} from 'aws-cdk-lib/assertions';
import {HaproxyEc2Service} from '../lib';
import {ValkeyStackV2} from '../lib/valkey-stack-v2';

test('On-Demand service emits only a nano launch template and rolling replacement', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'OnDemand');
  const vpc = new ec2.Vpc(stack, 'Vpc', {natGateways: 0});
  const props = {
    vpc, edgeSecurityGroup: new ec2.SecurityGroup(stack, 'Edge', {vpc}),
    appPort: 8080, userData: ec2.UserData.forLinux(), instanceProfileName: 'fixture',
    securityGroupName: 'fixture', securityGroupDescription: 'fixture',
    appLogGroupName: '/fixture/app', logRetention: logs.RetentionDays.ONE_WEEK,
    logRemovalPolicy: cdk.RemovalPolicy.DESTROY, asgName: 'fixture',
    minCapacity: 1, maxCapacity: 2, onDemand: true,
  };
  new HaproxyEc2Service(stack, 'Service', props);
  assert.throws(() => new HaproxyEc2Service(stack, 'Invalid', {
    ...props, spot: {percentage: 100},
  }), /onDemand and spot/);
  const template = Template.fromStack(stack);
  const [asg] = Object.values(template.findResources('AWS::AutoScaling::AutoScalingGroup'));
  assert.equal(asg.Properties.MixedInstancesPolicy, undefined);
  assert.equal(asg.Properties.CapacityRebalance, false);
  assert.ok(asg.Properties.LaunchTemplate);
  assert.ok(asg.UpdatePolicy.AutoScalingRollingUpdate);
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {InstanceType: 't4g.nano'},
  });
});

test('active Valkey uses only nano On-Demand capacity', () => {
  const app = new cdk.App();
  const network = new cdk.Stack(app, 'Network');
  const vpc = new ec2.Vpc(network, 'Vpc', {natGateways: 0});
  const stack = new ValkeyStackV2(app, 'Valkey', {environment: 'prod', vpc});
  const template = Template.fromStack(stack);
  const [asg] = Object.values(template.findResources('AWS::AutoScaling::AutoScalingGroup'));
  assert.equal(asg.Properties.MixedInstancesPolicy, undefined);
  assert.equal(asg.Properties.CapacityRebalance, false);
  assert.ok(asg.Properties.LaunchTemplate);
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {InstanceType: 't4g.nano'},
  });
});
