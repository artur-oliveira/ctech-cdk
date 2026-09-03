import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {NetworkStack} from '../lib/network-stack';

test('NetworkStack creates a public subnet in every pinned availability zone', () => {
  const availabilityZones = [
    'us-east-1a',
    'us-east-1b',
    'us-east-1c',
    'us-east-1d',
    'us-east-1e',
    'us-east-1f',
  ];
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'NetworkFixture', {
    env: {account: '111111111111', region: 'us-east-1'},
    environment: 'dev',
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::Subnet', availabilityZones.length);
  for (const availabilityZone of availabilityZones) {
    template.hasResourceProperties('AWS::EC2::Subnet', {AvailabilityZone: availabilityZone});
  }

  const subnets = template.findResources('AWS::EC2::Subnet');
  const existingSubnetAssignments = [
    ['VpcPublicSubnetSubnet1SubnetC1C3749F', 'us-east-1b', '10.0.0.0/20'],
    ['VpcPublicSubnetSubnet2Subnet2294BBD1', 'us-east-1c', '10.0.16.0/20'],
    ['VpcPublicSubnetSubnet3SubnetFDC17AA4', 'us-east-1d', '10.0.32.0/20'],
  ];
  for (const [logicalId, availabilityZone, cidrBlock] of existingSubnetAssignments) {
    assert.equal(subnets[logicalId].Properties.AvailabilityZone, availabilityZone);
    assert.equal(subnets[logicalId].Properties.CidrBlock, cidrBlock);
  }
});
