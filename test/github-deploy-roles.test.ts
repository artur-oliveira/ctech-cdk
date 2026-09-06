import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cdk from 'aws-cdk-lib';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {GithubActionsDeployRoles} from '../lib/github-deploy-roles';

function synth(props: Partial<ConstructorParameters<typeof GithubActionsDeployRoles>[2]> = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: {account: '868899309401', region: 'us-east-1'},
  });
  new GithubActionsDeployRoles(stack, 'Roles', {
    githubRepo: 'artur-oliveira/ctech-poker',
    service: 'ctech-poker',
    allowedSubSuffixes: ['ref:refs/heads/main'],
    ...props,
  });
  return Template.fromStack(stack);
}

test('apiRole scopes ssm:SendCommand to tagged instances and the RunShellScript document, never Resource: *', () => {
  const template = synth();
  const policies = template.findResources('AWS::IAM::Policy');
  const apiPolicy = Object.values(policies).find((p: any) =>
    p.Properties.PolicyName?.includes('ApiDeployRole') || p.Properties.Roles?.some((r: any) => JSON.stringify(r).includes('ApiDeployRole')),
  ) as any;
  assert.ok(apiPolicy, 'expected to find the ApiDeployRole policy');

  const sendCommandStatements = apiPolicy.Properties.PolicyDocument.Statement.filter((s: any) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    return actions.includes('ssm:SendCommand');
  });
  assert.ok(sendCommandStatements.length >= 2, 'expected SendCommand split across scoped statements');
  for (const stmt of sendCommandStatements) {
    const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
    for (const r of resources) {
      assert.notStrictEqual(r, '*', 'ssm:SendCommand must never be granted on Resource: *');
    }
  }
  // At least one SendCommand statement carries the instance-tag condition.
  assert.ok(
    sendCommandStatements.some((s: any) => s.Condition?.StringEquals?.['ssm:resourceTag/Project']),
    'expected a SendCommand statement conditioned on ssm:resourceTag/Project',
  );
});

test('apiRole scopes autoscaling:StartInstanceRefresh to this service\'s ASG pattern, not every ASG', () => {
  const template = synth();
  template.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(['autoscaling:StartInstanceRefresh']),
        Resource: Match.stringLikeRegexp('autoScalingGroupName/\\*-ctech-poker'),
      })]),
    }),
  }));
});

test('apiRole still leaves Resource: * for genuinely unscopable Describe/List/GetCommandInvocation calls', () => {
  const template = synth();
  template.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(['ssm:GetCommandInvocation']),
        Resource: '*',
      })]),
    }),
  }));
});

test('infraRole trust policy never matches every ref (no bare :* suffix)', () => {
  const template = synth({allowedSubSuffixes: ['ref:refs/heads/main', 'pull_request']});
  const roles = template.findResources('AWS::IAM::Role');
  const infra = Object.values(roles).find((r: any) => r.Properties.RoleName === 'ctech-poker-gha-infra') as any;
  assert.ok(infra, 'expected to find ctech-poker-gha-infra');
  const subs: string[] = infra.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringLike[
    'token.actions.githubusercontent.com:sub'
  ];
  for (const sub of subs) {
    assert.ok(!sub.endsWith(':*'), `sub suffix should be scoped, got ${sub}`);
  }
});

test('infraRole keeps AdministratorAccess (documented follow-up, not replaced in this change)', () => {
  const template = synth();
  template.hasResourceProperties('AWS::IAM::Role', Match.objectLike({
    RoleName: 'ctech-poker-gha-infra',
    ManagedPolicyArns: Match.arrayWith([
      Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([Match.stringLikeRegexp('AdministratorAccess')]),
        ]),
      }),
    ]),
  }));
});
