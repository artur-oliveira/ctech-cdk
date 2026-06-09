import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {Environment} from './types';
import {SSM} from './constants';

interface S3StackProps extends cdk.StackProps {
  environment: Environment;
}

export class S3Stack extends cdk.Stack {
  public readonly deploymentsBucketName: string;
  public readonly logsBucketName: string;

  constructor(scope: Construct, id: string, props: S3StackProps) {
    super(scope, id, props);

    const {environment} = props;

    const deploymentsBucket = new s3.Bucket(this, 'DeploymentsBucket', {
      bucketName: `${environment}-ctech-deployments`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{expiration: cdk.Duration.days(30)}],
    });

    const logsBucket = new s3.Bucket(this, 'LogsBucket', {
      bucketName: `${environment}-ctech-application-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.deploymentsBucketName = deploymentsBucket.bucketName;
    this.logsBucketName = logsBucket.bucketName;

    new ssm.StringParameter(this, 'DeploymentsBucketParam', {
      parameterName: SSM.s3(environment).deploymentsBucket,
      stringValue: deploymentsBucket.bucketName,
    });

    new ssm.StringParameter(this, 'LogsBucketParam', {
      parameterName: SSM.s3(environment).logsBucket,
      stringValue: logsBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'DeploymentsBucketName', {
      value: this.deploymentsBucketName,
      exportName: `${id}-deployments-bucket`,
    });
    new cdk.CfnOutput(this, 'LogsBucketName', {
      value: this.logsBucketName,
      exportName: `${id}-logs-bucket`,
    });
  }
}
