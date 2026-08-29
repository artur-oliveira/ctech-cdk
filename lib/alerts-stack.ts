import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {Environment} from './types';
import {SSM} from './constants';

export interface AlertsStackProps extends cdk.StackProps {
  environment: Environment;
  /**
   * Where an alert lands. A single address on purpose: the alternative is a
   * distribution list nobody owns, and one operator reading every alert is the
   * accurate description of this company today.
   *
   * The subscription is created PENDING and stays useless until the address
   * confirms it by e-mail — CDK cannot confirm it, and an unconfirmed topic
   * looks identical to a working one from the publisher's side.
   */
  alertEmail: string;
}

/**
 * The account's alert channel: one SNS topic per environment, and every service
 * publishes its own failures to it.
 *
 * This is deliberately not CloudWatch. An alarm is billed per alarm per month
 * and the family would need dozens of them to say the one thing that matters —
 * "this job did not do its work" — while every job already knows that at the
 * moment it happens. SNS e-mail is free at the first thousand notifications a
 * month, which is far past the volume at which somebody would stop reading them.
 *
 * What this trades away is liveness: a process that never runs publishes
 * nothing, and silence here is indistinguishable from health. A service that
 * needs "did it run at all" asserts it from the next run (a stored marker, a
 * later job checking it), which is a cheaper and more honest check than an
 * alarm on a metric nobody emits.
 */
export class AlertsStack extends cdk.Stack {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlertsStackProps) {
    super(scope, id, props);

    const {environment, alertEmail} = props;

    this.topic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `ctech-${environment}-alerts`,
      displayName: `CTech alerts (${environment})`,
    });

    this.topic.addSubscription(new subscriptions.EmailSubscription(alertEmail));

    // Consumers read the ARN rather than importing the stack: the Terraform
    // services (billing, and whatever follows) have no CloudFormation export to
    // reach for, and an SSM parameter is the one contract both toolchains speak.
    new ssm.StringParameter(this, 'AlertsTopicArnParam', {
      parameterName: SSM.alerts(environment).topicArn,
      stringValue: this.topic.topicArn,
    });

    new cdk.CfnOutput(this, 'AlertsTopicArn', {value: this.topic.topicArn});
  }
}
