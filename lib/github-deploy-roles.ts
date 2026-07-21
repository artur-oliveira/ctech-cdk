import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import {Construct} from 'constructs';

/**
 * GitHub Actions OIDC trust principal for a repo (B20). The GitHub OIDC
 * provider is a global IAM resource owned by ctech-cdk's Global stack —
 * imported here by its well-known ARN, never created.
 *
 * GitHub emits the sub claim as `repo:owner/repo:*` for older repos, but as
 * `repo:owner@ownerId/repo@repoId:*` for repos where GitHub has enabled
 * immutable IDs (e.g. recreated after a delete) — match both so deleting and
 * recreating a repo doesn't break OIDC trust.
 *
 * `allowedSubSuffixes` restricts WHICH workflow runs may assume the roles,
 * e.g. `['ref:refs/heads/main', 'environment:prod']`. The default `['*']`
 * matches every ref — the posture the per-repo oidc-stacks ship today.
 * Tightening it (and scoping the infra role's AdministratorAccess) is
 * backlog B11: pass explicit suffixes once each repo's deploy triggers are
 * pinned to protected refs/environments.
 */
export function githubTrustPrincipal(
  stack: cdk.Stack,
  githubRepo: string,
  allowedSubSuffixes: string[] = ['*'],
): iam.WebIdentityPrincipal {
  const providerArn = `arn:aws:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`;
  const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
    stack, 'GithubOidcProvider', providerArn,
  );
  const [owner, repoName] = githubRepo.split('/');
  const subs = allowedSubSuffixes.flatMap((suffix) => [
    `repo:${githubRepo}:${suffix}`,
    `repo:${owner}@*/${repoName}@*:${suffix}`,
  ]);
  return new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
    StringLike: {
      'token.actions.githubusercontent.com:sub': subs,
    },
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    },
  });
}

export interface GithubActionsDeployRolesProps {
  /** e.g. "artur-oliveira/ctech-poker" */
  githubRepo: string;
  /**
   * Service slug (e.g. "ctech-poker"): names the roles
   * (`${service}-gha-{frontend,api,infra}`), the deployments-bucket prefix,
   * and the `*-${service}-frontend` bucket pattern.
   */
  service: string;
  /**
   * Deployments bucket name or pattern (default `*-ctech-deployments`, the
   * shared ctech-cdk buckets across environments).
   */
  deploymentsBucket?: string;
  /**
   * Restricts which workflow runs may assume the roles — sub-claim suffixes
   * such as `['ref:refs/heads/main', 'environment:prod']`. Defaults to
   * `['*']` (any ref), matching the current per-repo stacks; tightening this
   * is backlog B11.
   */
  allowedSubSuffixes?: string[];
}

/**
 * The three GitHub Actions deploy roles every CTech service repeats (B20):
 *
 * - `frontendRole` — S3 sync to `*-${service}-frontend`, CloudFront
 *   invalidation, URL-rewrite KV-store manifest, DescribeStacks.
 * - `apiRole` — artifact upload to the shared deployments bucket under
 *   `${service}/`, SSM RunCommand rolling deploy, ASG discovery/refresh.
 * - `infraRole` — `cdk deploy` (AdministratorAccess; scoping is B11).
 *
 * All are exposed (plus `trust`) so a service can append statements or add
 * extra roles (e.g. dfe's worker/py-dfe Lambda deploy roles).
 */
export class GithubActionsDeployRoles extends Construct {
  readonly trust: iam.WebIdentityPrincipal;
  readonly frontendRole: iam.Role;
  readonly apiRole: iam.Role;
  readonly infraRole: iam.Role;
  private readonly service: string;
  private readonly deploymentsBucket: string;

  constructor(scope: cdk.Stack, id: string, props: GithubActionsDeployRolesProps) {
    super(scope, id);

    const {githubRepo, service} = props;
    const deploymentsBucket = props.deploymentsBucket ?? '*-ctech-deployments';
    this.service = service;
    this.deploymentsBucket = deploymentsBucket;
    this.trust = githubTrustPrincipal(scope, githubRepo, props.allowedSubSuffixes);

    // ── Frontend deploy role ────────────────────────────────────────────────
    this.frontendRole = new iam.Role(this, 'FrontendDeployRole', {
      roleName: `${service}-gha-frontend`,
      assumedBy: this.trust,
    });
    this.frontendRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::*-${service}-frontend`,
        `arn:aws:s3:::*-${service}-frontend/*`,
      ],
    }));
    this.frontendRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: ['*'],
    }));
    // Route manifest for the URL-rewrite CloudFront Function. Published after
    // the S3 sync so the key set matches the objects in the bucket.
    this.frontendRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
        'cloudfront-keyvaluestore:ListKeys',
        'cloudfront-keyvaluestore:UpdateKeys',
      ],
      resources: [`arn:aws:cloudfront::${scope.account}:key-value-store/*`],
    }));
    // Reads the frontend stack's DistributionId output.
    this.frontendRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: ['*'],
    }));

    // ── API deploy role ─────────────────────────────────────────────────────
    this.apiRole = new iam.Role(this, 'ApiDeployRole', {
      roleName: `${service}-gha-api`,
      assumedBy: this.trust,
    });
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [`arn:aws:s3:::${deploymentsBucket}`],
      conditions: {StringLike: {'s3:prefix': `${service}/*`}},
    }));
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [
        `arn:aws:s3:::${deploymentsBucket}/${service}`,
        `arn:aws:s3:::${deploymentsBucket}/${service}/*`,
      ],
    }));
    // The workflow reads /ctech/{env}/s3/deployments-bucket before uploading.
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: ['arn:aws:ssm:*:*:parameter/ctech/*'],
    }));
    // Trigger the rolling deploy on running instances via SSM RunCommand.
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation',
        'ssm:ListCommands',
        'ssm:ListCommandInvocations',
      ],
      resources: ['*'],
    }));
    // Discover the InService instances of the ASG / drive instance refresh.
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:DescribeInstanceRefreshes',
        'autoscaling:StartInstanceRefresh',
        'autoscaling:CancelInstanceRefresh',
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    }));

    // ── Infra deploy role ───────────────────────────────────────────────────
    this.infraRole = new iam.Role(this, 'InfraDeployRole', {
      roleName: `${service}-gha-infra`,
      assumedBy: this.trust,
    });
    // CDK needs broad permissions to manage CloudFormation stacks. Scoping
    // this per stack/resource is backlog B11 — change it there, not here.
    this.infraRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
    );

    new cdk.CfnOutput(this, 'FrontendRoleArn', {value: this.frontendRole.roleArn});
    new cdk.CfnOutput(this, 'ApiRoleArn', {value: this.apiRole.roleArn});
    new cdk.CfnOutput(this, 'InfraRoleArn', {value: this.infraRole.roleArn});
  }

  /**
   * Adds a Lambda deploy role (artifact upload + UpdateFunctionCode on the
   * matched functions) — dfe's worker/py-dfe pattern.
   */
  addLambdaDeployRole(id: string, roleName: string, functionArnPattern: string): iam.Role {
    const scope = cdk.Stack.of(this);
    const role = new iam.Role(this, id, {roleName, assumedBy: this.trust});
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [
        `arn:aws:s3:::${this.deploymentsBucket}/${this.service}`,
        `arn:aws:s3:::${this.deploymentsBucket}/${this.service}/*`,
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration'],
      resources: [`arn:aws:lambda:*:${scope.account}:function:${functionArnPattern}`],
    }));
    return role;
  }
}
