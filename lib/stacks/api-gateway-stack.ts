import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface ApiGatewayStackProps extends StackProps {
  authentikPublicIp: string;
  authentikAppSlug?: string;
}

export class ApiGatewayStack extends Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    const appSlug = props.authentikAppSlug ?? 'leetcode';
    const authentikBase = `http://${props.authentikPublicIp}:9000/application/o/${appSlug}`;

    const authorizerHandler = new LambdaFunction(this, 'AuthorizerHandler', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: Duration.seconds(10),
      environment: {
        JWKS_URI: `${authentikBase}/jwks/`,
        ISSUER: `${authentikBase}/`,
        AUDIENCE: appSlug,
      },
      code: Code.fromInline(jwtAuthorizerCode()),
    });

    const authorizer = new HttpLambdaAuthorizer('JwtAuthorizer', authorizerHandler, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: Duration.minutes(5),
    });

    const meHandler = new LambdaFunction(this, 'MeHandler', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: Duration.seconds(5),
      code: Code.fromInline(meHandlerCode()),
    });

    const api = new HttpApi(this, 'Api', {
      apiName: 'leetcode-api',
      description: 'API LeetCode con Lambda Authorizer que valida tokens de Authentik',
      corsPreflight: {
        allowOrigins: ['http://localhost:5173'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });

    api.addRoutes({
      path: '/v1/me',
      methods: [HttpMethod.GET],
      authorizer,
      integration: new HttpLambdaIntegration('MeIntegration', meHandler),
    });

    this.apiUrl = api.apiEndpoint;

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'IssuerUrl', { value: `${authentikBase}/` });
  }
}

function jwtAuthorizerCode(): string {
  return `
const crypto = require('crypto');
const http = require('http');

let cachedJwks = null;
let jwksFetchedAt = 0;
const JWKS_TTL_MS = 5 * 60 * 1000;

function fetchJwks() {
  if (cachedJwks && Date.now() - jwksFetchedAt < JWKS_TTL_MS) {
    return Promise.resolve(cachedJwks);
  }
  return new Promise((resolve, reject) => {
    http
      .get(process.env.JWKS_URI, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            cachedJwks = JSON.parse(data);
            jwksFetchedAt = Date.now();
            resolve(cachedJwks);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function b64urlToBuffer(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function deny() {
  return { isAuthorized: false };
}

exports.handler = async (event) => {
  try {
    const auth = (event.identitySource && event.identitySource[0]) || '';
    const m = auth.match(/^Bearer (.+)$/);
    if (!m) return deny();
    const token = m[1];

    const parts = token.split('.');
    if (parts.length !== 3) return deny();
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8'));
    const payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8'));

    if (payload.iss !== process.env.ISSUER) return deny();
    const aud = payload.aud;
    const audOk = Array.isArray(aud)
      ? aud.includes(process.env.AUDIENCE)
      : aud === process.env.AUDIENCE;
    if (!audOk) return deny();
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return deny();

    const jwks = await fetchJwks();
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) return deny();

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(\`\${headerB64}.\${payloadB64}\`);
    if (!verifier.verify(publicKey, b64urlToBuffer(sigB64))) return deny();

    return {
      isAuthorized: true,
      context: {
        sub: payload.sub || '',
        email: payload.email || '',
        name: payload.name || '',
        roles: JSON.stringify(payload.roles || []),
      },
    };
  } catch (err) {
    console.error('Authorizer error', err);
    return deny();
  }
};
`.trim();
}

function meHandlerCode(): string {
  return `
exports.handler = async (event) => {
  const auth = event.requestContext.authorizer.lambda;
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sub: auth.sub,
      email: auth.email,
      name: auth.name,
      roles: JSON.parse(auth.roles || '[]'),
    }),
  };
};
`.trim();
}
