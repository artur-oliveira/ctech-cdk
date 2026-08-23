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

    // ctech-gha-packer: builds the Alpine AMI. Deliberately separate from
    // infraRole (AdministratorAccess) — Packer needs broad EC2 build/image
    // actions, not the ability to touch every other AWS service.
    const packerRole = new iam.Role(this, 'PackerBuildRole', {
      roleName: 'ctech-gha-packer',
      assumedBy: trust,
    });
    packerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:RunInstances',
        'ec2:TerminateInstances',
        'ec2:CreateImage',
        'ec2:RegisterImage',
        'ec2:DeregisterImage',
        'ec2:DescribeImages',
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceStatus',
        'ec2:DescribeSnapshots',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeVolumes',
        'ec2:CreateTags',
        'ec2:CreateKeyPair',
        'ec2:DeleteKeyPair',
        'ec2:CreateSecurityGroup',
        'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:GetPasswordData',
      ],
      // Packer's amazon-ebs builder does not support resource-level scoping
      // for most of these actions — they are EC2 control-plane calls against
      // whatever build instance/AMI/snapshot IDs Packer creates that run.
      resources: ['*'],
    }));
    packerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: ['arn:aws:ssm:*:*:parameter/ctech/*'],
    }));
    packerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::*-ctech-ec2-scripts/*'],
    }));

    new cdk.CfnOutput(this, 'PackerRoleArn', {value: packerRole.roleArn});
  }
}
