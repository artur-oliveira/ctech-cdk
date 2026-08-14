import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import {Construct} from 'constructs';
import {Environment} from './types';

const DEFAULT_REWRITE_CODE = `
import cf from 'cloudfront';

const kvs = cf.kvs();

async function handler(event) {
  var uri = event.request.uri;
  if (uri === '/' || /\\.[^/]+$/.test(uri)) return event.request;
  var route = uri.endsWith('/') ? uri.slice(0, -1) : uri;
  event.request.uri = (await kvs.exists(route)) ? route + '.html' : '/404.html';
  return event.request;
}`;

export interface NextjsStaticFrontendBehaviorContext {
  originAccessControl: cloudfront.S3OriginAccessControl;
  securityHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  apiOrigin: origins.HttpOrigin;
  apiBehavior: cloudfront.BehaviorOptions;
}

export interface NextjsStaticFrontendProps {
  environment: Environment;
  serviceName: string;
  bucketName: string;
  routeStoreName: string;
  apiDomainName: string;
  apiPathPatterns: string[];
  /** Complete CSP source expressions, for example https://accounts.aoctech.app. */
  connectSrc: string[];
  domainName?: string;
  certificateArn?: string;
  distributionComment?: string;
  originAccessControlName?: string;
  rewriteFunctionName?: string;
  securityHeadersPolicyName?: string;
  rewriteFunctionCode?: string;
  contentSecurityPolicyDirectives?: string[];
  permissionsPolicy?: string;
  /**
   * Escape hatch for service-specific behaviours such as DFE docs or Poker
   * avatars. A callback makes the shared OAC/origin/policies available without
   * forcing those features into the common API.
   */
  additionalBehaviors?: (
    context: NextjsStaticFrontendBehaviorContext,
  ) => Record<string, cloudfront.BehaviorOptions>;
  /** When set, creates the four workflow-facing outputs with this export prefix. */
  outputExportNamePrefix?: string;
}

export interface NextjsStaticFrontendResources {
  bucket: s3.Bucket;
  distribution: cloudfront.Distribution;
  routeStore: cloudfront.KeyValueStore;
  originAccessControl: cloudfront.S3OriginAccessControl;
  securityHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  apiBehavior: cloudfront.BehaviorOptions;
}

/**
 * Creates the shared Next.js static-export frontend resources directly under
 * the supplied stack scope. Keeping the existing IDs (Bucket, OAC, RouteStore,
 * UrlRewrite, SecurityHeaders, Distribution) lets existing stacks adopt this
 * helper without changing CloudFormation logical IDs.
 */
export function createNextjsStaticFrontend(
  scope: Construct,
  props: NextjsStaticFrontendProps,
): NextjsStaticFrontendResources {
  if ((props.domainName === undefined) !== (props.certificateArn === undefined)) {
    throw new Error('domainName and certificateArn must be provided together');
  }
  if (props.apiPathPatterns.length === 0) {
    throw new Error('At least one API path pattern is required');
  }
  if (new Set(props.apiPathPatterns).size !== props.apiPathPatterns.length) {
    throw new Error('API path patterns must be unique');
  }

  const isProduction = props.environment === 'prod';
  const bucket = new s3.Bucket(scope, 'Bucket', {
    bucketName: props.bucketName,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    versioned: isProduction,
    removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: !isProduction,
  });
  const originAccessControl = new cloudfront.S3OriginAccessControl(scope, 'OAC', {
    originAccessControlName: props.originAccessControlName ?? `${props.environment}-${props.serviceName}-oac`,
  });
  const routeStore = new cloudfront.KeyValueStore(scope, 'RouteStore', {
    keyValueStoreName: props.routeStoreName,
  });
  const rewrite = new cloudfront.Function(scope, 'UrlRewrite', {
    functionName: props.rewriteFunctionName ?? `${props.environment}-${props.serviceName}-url-rewrite`,
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    keyValueStore: routeStore,
    code: cloudfront.FunctionCode.fromInline(props.rewriteFunctionCode ?? DEFAULT_REWRITE_CODE),
  });

  const csp = props.contentSecurityPolicyDirectives ?? [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${props.connectSrc.join(' ')}`.trim(),
  ];
  const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(scope, 'SecurityHeaders', {
    responseHeadersPolicyName: props.securityHeadersPolicyName
      ?? `${props.environment}-${props.serviceName}-security-headers`,
    ...(props.permissionsPolicy ? {
      customHeadersBehavior: {
        customHeaders: [{header: 'Permissions-Policy', value: props.permissionsPolicy, override: true}],
      },
    } : {}),
    securityHeadersBehavior: {
      contentTypeOptions: {override: true},
      frameOptions: {frameOption: cloudfront.HeadersFrameOption.DENY, override: true},
      strictTransportSecurity: {
        accessControlMaxAge: cdk.Duration.days(730),
        includeSubdomains: true,
        preload: true,
        override: true,
      },
      referrerPolicy: {
        referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
      contentSecurityPolicy: {contentSecurityPolicy: csp.join('; '), override: true},
    },
  });

  const apiOrigin = new origins.HttpOrigin(props.apiDomainName, {
    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    readTimeout: cdk.Duration.seconds(60),
    keepaliveTimeout: cdk.Duration.seconds(60),
  });
  const apiBehavior: cloudfront.BehaviorOptions = {
    origin: apiOrigin,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    compress: true,
    responseHeadersPolicy: securityHeadersPolicy,
  };
  const context: NextjsStaticFrontendBehaviorContext = {
    originAccessControl,
    securityHeadersPolicy,
    apiOrigin,
    apiBehavior,
  };
  const additionalBehaviors = props.additionalBehaviors?.(context) ?? {};
  for (const pattern of props.apiPathPatterns) {
    if (pattern in additionalBehaviors) {
      throw new Error(`Additional behavior duplicates API pattern ${pattern}`);
    }
  }

  const distribution = new cloudfront.Distribution(scope, 'Distribution', {
    comment: props.distributionComment ?? `${props.serviceName} frontend - ${props.environment}`,
    defaultRootObject: 'index.html',
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {originAccessControl}),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      compress: true,
      responseHeadersPolicy: securityHeadersPolicy,
      functionAssociations: [{function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST}],
    },
    additionalBehaviors: {
      ...Object.fromEntries(props.apiPathPatterns.map((pattern) => [pattern, apiBehavior])),
      ...additionalBehaviors,
    },
    httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    certificate: props.certificateArn
      ? acm.Certificate.fromCertificateArn(scope, 'Cert', props.certificateArn)
      : undefined,
    domainNames: props.domainName ? [props.domainName] : undefined,
    priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
  });

  if (props.outputExportNamePrefix) {
    new cdk.CfnOutput(scope, 'BucketName', {
      value: bucket.bucketName,
      exportName: `${props.outputExportNamePrefix}-bucket-name`,
    });
    new cdk.CfnOutput(scope, 'DistributionId', {
      value: distribution.distributionId,
      exportName: `${props.outputExportNamePrefix}-dist-id`,
    });
    new cdk.CfnOutput(scope, 'DistributionDomain', {
      value: distribution.distributionDomainName,
      exportName: `${props.outputExportNamePrefix}-dist-domain`,
    });
    new cdk.CfnOutput(scope, 'RouteStoreArn', {
      value: routeStore.keyValueStoreArn,
      exportName: `${props.outputExportNamePrefix}-route-store-arn`,
    });
  }

  return {bucket, distribution, routeStore, originAccessControl, securityHeadersPolicy, apiBehavior};
}
