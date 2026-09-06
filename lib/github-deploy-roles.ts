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
 * e.g. `['ref:refs/heads/main', 'pull_request']`. Required — no `['*']`
 * default: matching every ref meant any workflow run in the trusted repo
 * (including one from an untrusted PR branch that modified the workflow
 * itself) could assume these roles. Callers must pass the exact suffixes
 * their workflow triggers actually use.
 */
export function githubTrustPrincipal(
  stack: cdk.Stack,
  githubRepo: string,
  allowedSubSuffixes: string[],
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
   * such as `['ref:refs/heads/main', 'pull_request']`. Required: there is no
   * `['*']` default, since matching every ref would let any workflow run in
   * the trusted repo (including an untrusted PR branch that modifies the
   * workflow file itself) assume the infra role's AdministratorAccess.
   */
  allowedSubSuffixes: string[];
  /**
   * Tag value the deploy role's `ssm:SendCommand` grant requires on the
   * target EC2 instances (matched against the `Project` tag key — the
   * convention CTech ASGs propagate from `cdk.Tags.of(app)`). Defaults to
   * `service`.
   */
  instanceTagValue?: string;
  /**
   * ASG name pattern the deploy role's `autoscaling:StartInstanceRefresh`/
   * `CancelInstanceRefresh` grants are scoped to. Defaults to `*-${service}`
   * (the `${env}-${service}` naming convention CTech ASGs use).
   */
  asgNamePattern?: string;
}

/**
 * The two GitHub Actions deploy roles every CTech service repeats (B20):
 *
 * - `apiRole` — artifact upload to the shared deployments bucket under
 *   `${service}/`, SSM RunCommand rolling deploy, ASG discovery/refresh.
 *   Resource-scoped where AWS supports it (SendCommand to tagged instances,
 *   StartInstanceRefresh to this service's ASG); left `Resource: ['*']` only
 *   for the read-only Describe, List, and GetCommandInvocation calls that
 *   have no resource-level IAM support.
 * - `infraRole` — `cdk deploy` (still AdministratorAccess: fully replacing it
 *   is tracked as a follow-up, not attempted here — see the comment at its
 *   grant). What *is* scoped now is the trust policy: `allowedSubSuffixes`
 *   is required (no more implicit `['*']`), so a caller must consciously
 *   choose which refs may assume account-admin.
 *
 * All are exposed (plus `trust`) so a service can append statements or add
 * extra roles (e.g. dfe's worker/py-dfe Lambda deploy roles).
 */
export class GithubActionsDeployRoles extends Construct {
  readonly trust: iam.WebIdentityPrincipal;
  readonly apiRole: iam.Role;
  readonly infraRole: iam.Role;
  private readonly service: string;
  private readonly deploymentsBucket: string;

  constructor(scope: cdk.Stack, id: string, props: GithubActionsDeployRolesProps) {
    super(scope, id);

    const {githubRepo, service} = props;
    const deploymentsBucket = props.deploymentsBucket ?? '*-ctech-deployments';
    const instanceTagValue = props.instanceTagValue ?? service;
    const asgNamePattern = props.asgNamePattern ?? `*-${service}`;
    this.service = service;
    this.deploymentsBucket = deploymentsBucket;
    this.trust = githubTrustPrincipal(scope, githubRepo, props.allowedSubSuffixes);

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
    // Trigger the rolling deploy on running instances via SSM RunCommand,
    // scoped to this service's own instances (tagged `Project=${service}` —
    // `cdk.Tags.of(app)` in each service's bin/*.ts propagates it to the ASG's
    // instances) and the one document the deploy workflow actually runs.
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [`arn:aws:ec2:*:${scope.account}:instance/*`],
      conditions: {StringEquals: {'ssm:resourceTag/Project': instanceTagValue}},
    }));
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: ['arn:aws:ssm:*::document/AWS-RunShellScript'],
    }));
    // Command-status polling. These are read-only and have no resource-level
    // scoping in IAM (SSM only supports `*` for them).
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:GetCommandInvocation',
        'ssm:ListCommands',
        'ssm:ListCommandInvocations',
      ],
      resources: ['*'],
    }));
    // Discover the InService instances of the ASG. Describe* has no
    // resource-level scoping in IAM.
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:DescribeInstanceRefreshes',
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    }));
    // Drive instance refresh — scoped to this service's own ASG(s) only.
    this.apiRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:StartInstanceRefresh',
        'autoscaling:CancelInstanceRefresh',
      ],
      resources: [
        `arn:aws:autoscaling:*:${scope.account}:autoScalingGroup:*:autoScalingGroupName/${asgNamePattern}`,
      ],
    }));

    // ── Infra deploy role ───────────────────────────────────────────────────
    this.infraRole = new iam.Role(this, 'InfraDeployRole', {
      roleName: `${service}-gha-infra`,
      assumedBy: this.trust,
    });
    // KNOWN RISK (tracked, not fixed here): CDK deploy legitimately needs
    // broad permissions to manage CloudFormation stacks across many resource
    // types, and AdministratorAccess is still the blanket grant used to cover
    // that. Any workflow run matching `allowedSubSuffixes` above gets full
    // account-admin. Replacing this with a hand-scoped policy (modeled on
    // what `cdk deploy`/bootstrap actually touches — CloudFormation, the
    // bootstrap S3 bucket, PassRole to the bootstrap execution role, ECR) is
    // backlog B11 and was judged too large to land safely in this pass; see
    // ctech-poker/cdk/lib/oidc-stack.ts for a per-service hand-scoped
    // replacement (PowerUserAccess + a narrow IAM allowlist + an explicit
    // Deny on privilege-escalation actions) that could be generalized here.
    // What *is* now enforced: `allowedSubSuffixes` is required (no `['*']`
    // default), so a caller can no longer let every ref in the repo assume
    // this role by omission.
    this.infraRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
    );

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
