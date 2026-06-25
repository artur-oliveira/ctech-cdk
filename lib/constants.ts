import {SSMParams} from "./types";

export const DEFAULT_AWS_ACCOUNT = '868899309401';
export const DEFAULT_AWS_REGION = 'us-east-1';
export const DEFAULT_CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:868899309401:certificate/29678869-bfc3-4688-b81b-55aa5b1d7443';
export const DEFAULT_GITHUB_REPO = 'artur-oliveira/ctech-cdk';
export const SSM = {
  global: {
    oidcProviderArn: '/ctech/global/oidc/provider-arn',
    certArn: '/ctech/global/acm/cert-arn',
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
} as SSMParams;
