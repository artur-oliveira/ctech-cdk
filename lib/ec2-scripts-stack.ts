import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {SSM} from './constants';
import {Environment} from './types';

interface Ec2ScriptsStackProps extends cdk.StackProps {
  environment: Environment;
}

/**
 * Publishes the shared EC2 bootstrap scripts and records where they went.
 *
 * The S3 key prefix is the content hash of `assets/ec2`. Consumers read both SSM
 * parameters at synthesis, so the hash ends up literal inside the launch
 * template's user data: editing a script changes the hash, changes the user data,
 * versions the launch template, and triggers an instance refresh. A fixed key
 * would leave the user data byte-identical while the script changed underneath
 * running instances.
 *
 * `prune: false` keeps older prefixes alive for instances still booting from
 * them. There is deliberately no expiration rule: expiring by age would delete
 * the live prefix of any environment whose scripts have not changed recently.
 */
export class Ec2ScriptsStack extends cdk.Stack {
  public readonly bucketName: string;
  /** Content hash of `assets/ec2`; also the S3 key prefix. */
  public readonly version: string;
  /** Content hash of `assets/ec2-alpine`; also the S3 key prefix. */
  public readonly alpineScriptsVersion: string;
  /** Content hash of `assets/ctech-ec2-agent/dist`; also the S3 key prefix. */
  public readonly agentVersion: string;

  constructor(scope: Construct, id: string, props: Ec2ScriptsStackProps) {
    super(scope, id, props);

    const {environment} = props;

    // Literal, not `bucket.bucketName`: the name is deterministic, and a Ref
    // token here would land in the SSM parameter and in every consumer's user
    // data as an unresolvable cross-stack reference.
    const bucketName = `${environment}-ctech-ec2-scripts`;

    const bucket = new s3.Bucket(this, 'ScriptsBucket', {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const asset = new s3assets.Asset(this, 'ScriptsAsset', {
      path: path.join(__dirname, '..', 'assets', 'ec2'),
    });

    this.bucketName = bucketName;
    this.version = asset.assetHash;

    new s3deploy.BucketDeployment(this, 'PublishScripts', {
      sources: [s3deploy.Source.bucket(asset.bucket, asset.s3ObjectKey)],
      destinationBucket: bucket,
      destinationKeyPrefix: this.version,
      prune: false,
      retainOnDelete: true,
    });

    new ssm.StringParameter(this, 'ScriptsBucketParam', {
      parameterName: SSM.ec2Scripts(environment).bucket,
      stringValue: bucketName,
      description: 'Bucket holding the shared CTech EC2 bootstrap scripts',
    });

    new ssm.StringParameter(this, 'ScriptsVersionParam', {
      parameterName: SSM.ec2Scripts(environment).version,
      stringValue: this.version,
      description: 'Content hash and S3 key prefix of the current EC2 bootstrap scripts',
    });

    // ── Alpine scripts (same content-hash publishing pattern) ────────────────
    const alpineAsset = new s3assets.Asset(this, 'AlpineScriptsAsset', {
      path: path.join(__dirname, '..', 'assets', 'ec2-alpine'),
    });
    this.alpineScriptsVersion = alpineAsset.assetHash;

    new s3deploy.BucketDeployment(this, 'PublishAlpineScripts', {
      sources: [s3deploy.Source.bucket(alpineAsset.bucket, alpineAsset.s3ObjectKey)],
      destinationBucket: bucket,
      destinationKeyPrefix: this.alpineScriptsVersion,
      prune: false,
      retainOnDelete: true,
    });

    new ssm.StringParameter(this, 'AlpineScriptsBucketParam', {
      parameterName: SSM.ec2ScriptsAlpine(environment).bucket,
      stringValue: bucketName,
      description: 'Bucket holding the Alpine EC2 bootstrap scripts',
    });
    new ssm.StringParameter(this, 'AlpineScriptsVersionParam', {
      parameterName: SSM.ec2ScriptsAlpine(environment).version,
      stringValue: this.alpineScriptsVersion,
      description: 'Content hash and S3 key prefix of the current Alpine bootstrap scripts',
    });

    // ── ctech-ec2-agent binary (same pattern again) ───────────────────────────
    const agentAsset = new s3assets.Asset(this, 'CtechEc2AgentAsset', {
      path: path.join(__dirname, '..', 'assets', 'ctech-ec2-agent', 'dist'),
    });
    this.agentVersion = agentAsset.assetHash;

    new s3deploy.BucketDeployment(this, 'PublishCtechEc2Agent', {
      sources: [s3deploy.Source.bucket(agentAsset.bucket, agentAsset.s3ObjectKey)],
      destinationBucket: bucket,
      destinationKeyPrefix: this.agentVersion,
      prune: false,
      retainOnDelete: true,
    });

    new ssm.StringParameter(this, 'CtechEc2AgentBucketParam', {
      parameterName: SSM.ctechEc2Agent(environment).bucket,
      stringValue: bucketName,
      description: 'Bucket holding the ctech-ec2-agent binary',
    });
    new ssm.StringParameter(this, 'CtechEc2AgentVersionParam', {
      parameterName: SSM.ctechEc2Agent(environment).version,
      stringValue: this.agentVersion,
      description: 'Content hash and S3 key prefix of the current ctech-ec2-agent build',
    });

    new cdk.CfnOutput(this, 'ScriptsBucketName', {
      value: this.bucketName,
      exportName: `${id}-scripts-bucket`,
    });
    new cdk.CfnOutput(this, 'ScriptsVersion', {
      value: this.version,
      exportName: `${id}-scripts-version`,
    });
  }
}
