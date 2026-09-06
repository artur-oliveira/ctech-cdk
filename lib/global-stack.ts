import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {SSM} from './constants';
import {githubTrustPrincipal} from './github-deploy-roles';

// Refs/events `.github/workflows/ctech-cdk.yml` actually assumes
// ctech-gha-infra from: `push` to main/staging/dev (the deploy job) and
// `pull_request` against those branches (the read-only `cdk diff` job).
// Keep in sync with that workflow's `on:` block.
const DEFAULT_ALLOWED_SUB_SUFFIXES = [
  'ref:refs/heads/main',
  'ref:refs/heads/staging',
  'ref:refs/heads/dev',
  'pull_request',
];

interface GlobalStackProps extends cdk.StackProps {
  certArn: string;
  // e.g. "myorg/ctech-cdk"
  ctechGithubRepo: string;
  /**
   * Restricts which workflow runs may assume `ctech-gha-infra` — sub-claim
   * suffixes matched with `StringLike`. Defaults to the refs/events
   * `.github/workflows/ctech-cdk.yml` actually triggers on. Previously this
   * trusted `repo:${ctechGithubRepo}:*` (any ref at all), which meant any
   * workflow run in this repo — including one from a PR branch that
   * modified the workflow file itself — could assume a role with
   * AdministratorAccess.
   */
  allowedSubSuffixes?: string[];
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
    const trust = githubTrustPrincipal(
      this,
      ctechGithubRepo,
      props.allowedSubSuffixes ?? DEFAULT_ALLOWED_SUB_SUFFIXES,
    );

    const infraRole = new iam.Role(this, 'InfraDeployRole', {
      roleName: 'ctech-gha-infra',
      assumedBy: trust,
    });
    // KNOWN RISK (tracked, not fixed here): cdk deploy needs broad
    // permissions across many resource types, and AdministratorAccess is
    // still the blanket grant used to cover that — any workflow run matching
    // `allowedSubSuffixes` above gets full account-admin. Replacing this with
    // a hand-scoped policy (CloudFormation + bootstrap S3 bucket + PassRole
    // to the bootstrap execution role + ECR) is backlog B11; see
    // ctech-poker/cdk/lib/oidc-stack.ts for a per-service hand-scoped
    // replacement (PowerUserAccess + narrow IAM allowlist + explicit Deny on
    // privilege-escalation actions) that could be generalized here. What
    // *is* fixed now: the trust policy above no longer matches every ref in
    // the repo (`:*`) — only the specific push/pull_request triggers this
    // workflow actually uses.
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
      // HashiCorp's documented minimal IAM policy for the amazon-ebs builder:
      // https://developer.hashicorp.com/packer/integrations/hashicorp/amazon#iam-task-or-instance-role
      actions: [
        'ec2:AttachVolume',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:CopyImage',
        'ec2:CreateImage',
        'ec2:CreateKeyPair',
        'ec2:CreateSecurityGroup',
        'ec2:CreateSnapshot',
        'ec2:CreateTags',
        'ec2:CreateVolume',
        'ec2:DeleteKeyPair',
        'ec2:DeleteSecurityGroup',
        'ec2:DeleteSnapshot',
        'ec2:DeleteVolume',
        'ec2:DeregisterImage',
        'ec2:DescribeImageAttribute',
        'ec2:DescribeImages',
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceStatus',
        'ec2:DescribeRegions',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeSnapshots',
        'ec2:DescribeSubnets',
        'ec2:DescribeTags',
        'ec2:DescribeVolumes',
        'ec2:DetachVolume',
        'ec2:GetPasswordData',
        'ec2:ModifyImageAttribute',
        'ec2:ModifyInstanceAttribute',
        'ec2:ModifySnapshotAttribute',
        'ec2:RegisterImage',
        'ec2:RunInstances',
        'ec2:StopInstances',
        'ec2:TerminateInstances',
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
