#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';

import {GlobalStack} from '../lib/global-stack';
import {NetworkStack} from '../lib/network-stack';
import {S3Stack} from '../lib/s3-stack';
import {ValkeyStack} from '../lib/valkey-stack';
import {Environment} from '../lib';
import {DEFAULT_AWS_ACCOUNT, DEFAULT_AWS_REGION, DEFAULT_CERTIFICATE_ARN, DEFAULT_GITHUB_REPO} from "../lib/constants";

const app = new cdk.App();

// =====================
// Constants
// =====================
const AWS_ACCOUNT = process.env.AWS_ACCOUNT || DEFAULT_AWS_ACCOUNT;
const AWS_REGION = process.env.AWS_REGION || DEFAULT_AWS_REGION;
// Wildcard cert covering *.aoctech.app - shared with edge and service infrastructure.
const CERT_ARN = process.env.AWS_CERTIFICATE_ARN || DEFAULT_CERTIFICATE_ARN;
const CTECH_GITHUB_REPO = process.env.GITHUB_REPO || DEFAULT_GITHUB_REPO;

const ENVIRONMENT = (process.env.ENVIRONMENT || 'dev') as Environment;
const env = {account: AWS_ACCOUNT, region: AWS_REGION};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// =====================
// Global stack (deploy once per account)
// Manages: ctech-gha-infra IAM role, SSM pointers for OIDC provider and cert.
// =====================
new GlobalStack(app, 'Ctech-Global', {
  env,
  certArn: CERT_ARN,
  ctechGithubRepo: CTECH_GITHUB_REPO,
  description: 'CTech account-level shared infra (OIDC provider, cert, deploy role)',
});

// =====================
// Per-environment stacks
// =====================
const networkStack = new NetworkStack(app, `Ctech-${cap(ENVIRONMENT)}-Network`, {
  env,
  environment: ENVIRONMENT,
  description: `CTech Shared VPC & Security Groups - ${ENVIRONMENT}`,
});

// =====================
// Shared S3 buckets (deployments + logs, consumed by all service CDKs)
// Service CDKs read bucket names via /ctech/{env}/s3/* SSM params and scope
// their IAM permissions to {bucket}/{service-name}/* prefixes.
// =====================
new S3Stack(app, `Ctech-${cap(ENVIRONMENT)}-S3`, {
  env,
  environment: ENVIRONMENT,
  description: `CTech Shared S3 Buckets (deployments + logs) - ${ENVIRONMENT}`,
});

// =====================
// Shared Valkey cache (EC2 ASG, private; prod keeps one instance, non-prod can scale to zero)
// All services share one instance, each using a different Redis DB number.
// =====================
new ValkeyStack(app, `Ctech-${cap(ENVIRONMENT)}-Valkey`, {
  env,
  environment: ENVIRONMENT,
  vpc: networkStack.vpc,
  privateHostedZone: networkStack.privateHostedZone,
  description: `CTech Shared Valkey Cache - ${ENVIRONMENT}`,
});
