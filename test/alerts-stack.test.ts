import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {AlertsStack} from '../lib/alerts-stack';

function synth() {
  const app = new cdk.App();
  const stack = new AlertsStack(app, 'Ctech-Dev-Alerts', {
    env: {account: '868899309401', region: 'us-east-1'},
    environment: 'dev',
    alertEmail: 'ops@example.com',
  });
  return Template.fromStack(stack);
}

test('the topic is named per environment and carries the e-mail subscription', () => {
  const template = synth();
  template.hasResourceProperties('AWS::SNS::Topic', {TopicName: 'ctech-dev-alerts'});
  template.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email',
    Endpoint: 'ops@example.com',
  });
});

// The ARN is published to SSM and not only as a CloudFormation output: the
// consumers are Terraform roots, which have no export to import.
test('the topic ARN is published to SSM at the shared path', () => {
  const template = synth();
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/dev/alerts/topic-arn',
  });
});

test('exactly one topic exists — services share the channel, they do not each own one', () => {
  const template = synth();
  assert.equal(Object.keys(template.findResources('AWS::SNS::Topic')).length, 1);
});
