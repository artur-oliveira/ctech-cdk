import {SSMParams} from "./types";

export const DEFAULT_AWS_ACCOUNT = '868899309401';
export const DEFAULT_AWS_REGION = 'us-east-1';
export const DEFAULT_CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:868899309401:certificate/29678869-bfc3-4688-b81b-55aa5b1d7443';
export const DEFAULT_GITHUB_REPO = 'artur-oliveira/ctech-cdk';
export const SSM = {
  global: {
    oidcProviderArn: '/ctech/global/oidc/provider-arn',
    certArn: '/ctech/global/acm/cert-arn',
    privateHostedZoneId: '/ctech/global/dns/private-hosted-zone-id',
    privateHostedZoneName: '/ctech/global/dns/private-hosted-zone-name',
  },
  network: (env: string) => ({
    vpcId: `/ctech/${env}/network/vpc-id`,
    albSgId: `/ctech/${env}/network/alb-sg-id`,
  }),
  alb: (env: string) => ({
    arn: `/ctech/${env}/alb/arn`,
    dnsName: `/ctech/${env}/alb/dns-name`,
    httpsListenerArn: `/ctech/${env}/alb/https-listener-arn`,
  }),
  // Base URL (no DB number) written by the Valkey EC2 instance at boot.
  // Consumers append their own DB: /0 = cache, /1 = ws pub/sub, /2+ = other services.
  valkey: (env: string) => ({
    url: `/ctech/${env}/valkey/url`,
  }),
  s3: (env: string) => ({
    deploymentsBucket: `/ctech/${env}/s3/deployments-bucket`,
    logsBucket: `/ctech/${env}/s3/logs-bucket`,
  }),
  // Written by Ec2ScriptsStack. `version` is the content hash of assets/ec2 and
  // is also the S3 key prefix the scripts live under. Consumers embed both in
  // user data at deploy time, which is what versions the launch template when a
  // script changes.
  ec2Scripts: (env: string) => ({
    bucket: `/ctech/${env}/ec2-scripts/bucket`,
    version: `/ctech/${env}/ec2-scripts/version`,
  }),
  // Published by the Packer AMI build workflow. Read by ValkeyStackV2 (and any
  // later Alpine consumer) via ec2.MachineImage.fromSsmParameter — a rebuilt
  // AMI only takes effect on that consumer's next `cdk deploy`, same as an
  // ec2-scripts change.
  amiAlpine: (env: string) => ({
    arm64: `/ctech/${env}/ami/alpine/arm64`,
  }),
  // Same content-hash publishing pattern as ec2Scripts, for assets/ec2-alpine.
  ec2ScriptsAlpine: (env: string) => ({
    bucket: `/ctech/${env}/ec2-scripts-alpine/bucket`,
    version: `/ctech/${env}/ec2-scripts-alpine/version`,
  }),
  // Same pattern again, for the compiled ctech-ec2-agent binary.
  ctechEc2Agent: (env: string) => ({
    bucket: `/ctech/${env}/ctech-ec2-agent/bucket`,
    version: `/ctech/${env}/ctech-ec2-agent/version`,
  }),
} as SSMParams;
