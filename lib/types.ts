export type Environment = 'prod' | 'stage' | 'dev';

export interface SSMParams {
  global: {
    oidcProviderArn: string;
    certArn: string;
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
}