import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cdk from 'aws-cdk-lib';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {GlobalStack} from '../lib/global-stack';

function synth() {
  const app = new cdk.App();
  const stack = new GlobalStack(app, 'Ctech-Global', {
    env: {account: '868899309401', region: 'us-east-1'},
    certArn: 'arn:aws:acm:us-east-1:868899309401:certificate/fixture',
    ctechGithubRepo: 'artur-oliveira/ctech-cdk',
  });
  return Template.fromStack(stack);
}

test('the Packer build role is scoped to image-build actions, never AdministratorAccess', () => {
  const template = synth();
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'ctech-gha-packer',
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(['ec2:CreateImage', 'ec2:RegisterImage']),
      })]),
    }),
  });
});
