import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {SSM} from './constants';
import {Environment} from './types';

export interface Ec2ScriptRunnerProps {
  environment: Environment;
}

/** Single-quote for POSIX sh: wrap, and close-escape-reopen each embedded quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Emits user data that fetches the shared bootstrap scripts from S3 and runs
 * them, instead of writing their contents inline.
 *
 * Both SSM parameters are read with `valueForStringParameter`, so CloudFormation
 * resolves them at deploy time and the bucket name and content hash are literal
 * text in the launch template. That is the whole point: a script edit changes the
 * hash, which changes the user data, which versions the launch template and
 * triggers an instance refresh.
 *
 * Scripts are downloaded to a file and then executed rather than piped into
 * `bash`. A pipe truncated mid-transfer runs a partial script and reports
 * success; `aws s3 cp` under `set -e` fails the boot instead.
 */
export class Ec2ScriptRunner extends Construct {
  public readonly bucketName: string;
  public readonly version: string;

  constructor(scope: Construct, id: string, props: Ec2ScriptRunnerProps) {
    super(scope, id);

    this.bucketName = ssm.StringParameter.valueForStringParameter(
      this, SSM.ec2Scripts(props.environment).bucket,
    );
    this.version = ssm.StringParameter.valueForStringParameter(
      this, SSM.ec2Scripts(props.environment).version,
    );
  }

  /** Emits the `ctech_run` helper. Call once, before any `run`. */
  public install(userData: ec2.UserData): void {
    userData.addCommands(
      `CTECH_SCRIPTS="s3://${this.bucketName}/${this.version}"`,
      'ctech_run(){ s="$1"; shift; aws s3 cp "$CTECH_SCRIPTS/$s" "/tmp/$s" >/dev/null; bash "/tmp/$s" "$@"; }',
    );
  }

  /** Appends one script invocation with shell-quoted arguments. */
  public run(userData: ec2.UserData, script: string, ...args: string[]): void {
    if (!/^[a-z0-9][a-z0-9._-]*\.sh$/.test(script)) {
      throw new Error(`Ec2ScriptRunner: "${script}" must be a bare script filename ending in .sh`);
    }
    const quoted = args.map(shellQuote).join(' ');
    userData.addCommands(`ctech_run ${script}${quoted ? ` ${quoted}` : ''}`);
  }

  /** Grants an instance role permission to download the scripts. */
  public grantRead(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${this.bucketName}/*`],
    }));
  }
}
