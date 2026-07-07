import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from './http.mjs';

let _client = null;
function client() {
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${getEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: getEnv('R2_ACCESS_KEY_ID'),
        secretAccessKey: getEnv('R2_SECRET_ACCESS_KEY'),
      },
    });
  }
  return _client;
}
const bucket = () => getEnv('R2_BUCKET');

export function presignPut({ key, contentType }) {
  return getSignedUrl(client(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn: 600 });
}

export async function headObject(key) {
  try {
    const h = await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { bytes: h.ContentLength, contentType: h.ContentType };
  } catch {
    return null;
  }
}

/** First maxBytes of the object — EXIF lives at the front of the file. */
export async function getObjectBuffer(key, maxBytes = 20 * 1024 * 1024) {
  const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=0-${maxBytes - 1}` }));
  return Buffer.from(await r.Body.transformToByteArray());
}

export async function deleteObject(key) {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export const publicUrl = (key) => `${getEnv('MEDIA_PUBLIC_BASE')}/${key}`;
