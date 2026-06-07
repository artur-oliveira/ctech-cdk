import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {SSM} from './constants';

interface GlobalStackProps extends cdk.StackProps {
  // ARN of the existing GitHub OIDC provider (owned by py-dfe-cdk for now).
  // Transfer ownership to this stack via `cdk import` when ready.
  oidcProviderArn: string;
  certArn: string;
  // e.g. "myorg/ctech-cdk"
  ctechGithubRepo: string;
}

export class GlobalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GlobalStackProps) {
    super(scope, id, props);

    const {oidcProviderArn, certArn, ctechGithubRepo} = props;

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this, 'GitHubOidc', oidcProviderArn,
    );

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
      stringValue: oidcProviderArn,
      description: 'GitHub Actions OIDC provider ARN (shared across all services)',
    });

    new ssm.StringParameter(this, 'CertArnParam', {
      parameterName: SSM.global.certArn,
      stringValue: certArn,
      description: 'Wildcard ACM certificate ARN for arturocarvalho.com',
    });

    new cdk.CfnOutput(this, 'InfraRoleArn', {value: infraRole.roleArn});
  }
}
