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
      lifecycleRules: [{
        id: 'ExpireApplicationLogs',
        // Thirteen months keeps one complete annual operational window while
        // preventing an unbounded archive. The bucket itself remains RETAINed.
        expiration: cdk.Duration.days(400),
      }, {
        id: 'ArchiveLargeApplicationLogs',
        // Daily archives can be very small at the current traffic level. S3
        // archival classes have minimum billable object sizes, so only archive
        // objects larger than 128 KiB and leave smaller objects in Standard
        // until the common expiration date.
        objectSizeGreaterThan: 128 * 1024,
        transitions: [{
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(90),
        }],
      }],
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
