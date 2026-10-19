import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env, optionalEnv } from './env.js';

let client: S3Client | undefined;

export function r2Configured(): boolean {
  return Boolean(optionalEnv('R2_ACCOUNT_ID') && optionalEnv('R2_ACCESS_KEY_ID') && optionalEnv('R2_SECRET_ACCESS_KEY') && optionalEnv('R2_BUCKET'));
}

function r2(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') },
    });
  }
  return client;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await r2().send(new PutObjectCommand({ Bucket: env('R2_BUCKET'), Key: key, Body: body, ContentType: contentType }));
}
