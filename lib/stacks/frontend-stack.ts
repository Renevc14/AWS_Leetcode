import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  CachedMethods,
  Distribution,
  Function as CfFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
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

    // Fuerza Cache-Control: no-store en responses /v1/* para que ningun browser
    // o proxy intermedio cachee respuestas del API (Run/Submit deben ser frescas).
    const apiNoStorePolicy = new ResponseHeadersPolicy(this, 'ApiNoStorePolicy', {
      responseHeadersPolicyName: `${id}-api-no-store`,
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, max-age=0',
            override: true,
          },
        ],
      },
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
        responseHeadersPolicy: apiNoStorePolicy,
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

    // Reescribe paths del SPA (React Router) a /index.html antes de S3, evitando
    // los 403 AccessDenied de S3 cuando el user navega directo a /login,
    // /problems/abc, etc. Sin esto un refresh en una ruta del SPA devuelve XML.
    const spaRewriteFn = new CfFunction(this, 'SpaRewriteFunction', {
      functionName: `${id}-spa-rewrite`,
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(`
function handler(event) {
  var req = event.request;
  var uri = req.uri;
  // Paths que NO son del SPA: API, assets, Authentik, favicon, archivos con extension.
  if (uri.indexOf('/v1/') === 0) return req;
  if (uri.indexOf('/assets/') === 0) return req;
  if (uri.indexOf('/application/') === 0) return req;
  if (uri.indexOf('/flows/') === 0) return req;
  if (uri.indexOf('/static/') === 0) return req;
  if (uri.indexOf('/if/') === 0) return req;
  if (uri.indexOf('/api/') === 0) return req;
  if (uri.indexOf('/media/') === 0) return req;
  if (uri.indexOf('/outpost/') === 0) return req;
  if (uri.indexOf('/source/') === 0) return req;
  if (uri.indexOf('/-/') === 0) return req;
  if (uri === '/favicon.svg' || uri === '/favicon.ico') return req;
  var last = uri.split('/').pop();
  if (last && last.indexOf('.') !== -1) return req;
  req.uri = '/index.html';
  return req;
}
      `),
    });

    this.distribution = new Distribution(this, 'Cdn', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        functionAssociations: [
          { function: spaRewriteFn, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors,
      defaultRootObject: 'index.html',
      // El SPA routing lo maneja spaRewriteFn (viewer-request). No usamos
      // errorResponses porque CF cachea esos sustituidos por /index.html
      // como "error response" y eso rompia POST /v1/submissions/run.
      priceClass: PriceClass.PRICE_CLASS_100,
    });

    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
    });
  }
}
