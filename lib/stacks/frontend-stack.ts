import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  CachedMethods,
  Distribution,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface FrontendStackProps extends StackProps {
  albDnsName?: string;
  authentikHost?: string;
}

export class FrontendStack extends Stack {
  public readonly bucket: Bucket;
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props?: FrontendStackProps) {
    super(scope, id, props);

    this.bucket = new Bucket(this, 'SpaBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const additionalBehaviors: Record<string, any> = {};

    if (props?.albDnsName) {
      additionalBehaviors['/v1/*'] = {
        origin: new HttpOrigin(props.albDnsName, {
          protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
          connectionTimeout: Duration.seconds(10),
          readTimeout: Duration.seconds(60),
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachedMethods: CachedMethods.CACHE_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
      };
    }

    if (props?.authentikHost) {
      const authentikOrigin = new HttpOrigin(props.authentikHost, {
        protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
        httpPort: 9000,
        connectionTimeout: Duration.seconds(10),
        readTimeout: Duration.seconds(60),
      });
      const authentikBehavior = {
        origin: authentikOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachedMethods: CachedMethods.CACHE_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
      };
      // Todas las rutas que Authentik usa para flows OIDC, UI y assets.
      for (const path of [
        '/application/*',
        '/flows/*',
        '/-/*',
        '/static/*',
        '/if/*',
        '/api/*',
        '/media/*',
        '/outpost/*',
        '/source/*',
      ]) {
        additionalBehaviors[path] = authentikBehavior;
      }
    }

    this.distribution = new Distribution(this, 'Cdn', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
      },
      additionalBehaviors,
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      priceClass: PriceClass.PRICE_CLASS_100,
    });

    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
    });
  }
}
