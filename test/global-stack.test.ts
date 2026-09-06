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

test('ctech-gha-infra trust policy is scoped to specific refs, never a bare :* suffix', () => {
  const template = synth();
  const roles = template.findResources('AWS::IAM::Role');
  const infra = Object.values(roles).find((r: any) => r.Properties.RoleName === 'ctech-gha-infra') as any;
  assert.ok(infra, 'expected to find ctech-gha-infra');
  const subs: string[] = infra.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringLike[
    'token.actions.githubusercontent.com:sub'
  ];
  assert.ok(subs.length > 0);
  for (const sub of subs) {
    assert.ok(!sub.endsWith(':*'), `sub suffix should be scoped, got ${sub}`);
  }
});

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
