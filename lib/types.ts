export type Environment = 'prod' | 'stage' | 'dev';

export interface SSMParams {
  global: {
    oidcProviderArn: string;
    certArn: string;
    privateHostedZoneId: string;
    privateHostedZoneName: string;
  };
  alb: (env: Environment) => {
    arn: string;
    dnsName: string;
    httpsListenerArn: string;
  };
  network: (env: Environment) => {
    vpcId: string;
    albSgId: string;
  };
  valkey: (env: Environment) => {
    url: string;
  };
  s3: (env: Environment) => {
    deploymentsBucket: string;
    logsBucket: string;
  };
  ec2Scripts: (env: Environment) => {
    bucket: string;
    version: string;
  };
  amiAlpine: (env: Environment) => {
    arm64: string;
  };
  ec2ScriptsAlpine: (env: Environment) => {
    bucket: string;
    version: string;
  };
  ctechEc2Agent: (env: Environment) => {
    bucket: string;
    version: string;
  };
}
