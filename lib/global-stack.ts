import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {SSM} from './constants';

interface GlobalStackProps extends cdk.StackProps {
  certArn: string;
  // e.g. "myorg/ctech-cdk"
  ctechGithubRepo: string;
}

export class GlobalStack extends cdk.Stack {
  public readonly oidcProviderArn: string;

  constructor(scope: Construct, id: string, props: GlobalStackProps) {
    super(scope, id, props);

    const {certArn, ctechGithubRepo} = props;

    // Owns the GitHub Actions OIDC provider for the entire AWS account.
    // All service CDKs (py-dfe-cdk, ctech-account) import this by ARN.
    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    this.oidcProviderArn = provider.openIdConnectProviderArn;

    // ctech-cdk infra deploy role - assumed by ctech-cdk's GitHub Actions workflow.
    const trust = new iam.FederatedPrincipal(
      provider.openIdConnectProviderArn,
      {StringLike: {'token.actions.githubusercontent.com:sub': `repo:${ctechGithubRepo}:*`}},
      'sts:AssumeRoleWithWebIdentity',
    );

    const infraRole = new iam.Role(this, 'InfraDeployRole', {
      roleName: 'ctech-gha-infra',
      assumedBy: trust,
    });
    infraRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
    );

    // Publish shared values so service CDKs can reference them without hardcoding.
    new ssm.StringParameter(this, 'OidcProviderArnParam', {
      parameterName: SSM.global.oidcProviderArn,
      stringValue: provider.openIdConnectProviderArn,
      description: 'GitHub Actions OIDC provider ARN (shared across all services)',
    });

    new ssm.StringParameter(this, 'CertArnParam', {
      parameterName: SSM.global.certArn,
      stringValue: certArn,
      description: 'Wildcard ACM certificate ARN for aoctech.app',
    });

    new cdk.CfnOutput(this, 'InfraRoleArn', {value: infraRole.roleArn});
  }
}
