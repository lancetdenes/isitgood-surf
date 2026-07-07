import { HttpError } from './http.mjs';

const RULES = {
  photo: { types: { 'image/jpeg': 'jpg', 'image/png': 'png' }, maxBytes: 15 * 1024 * 1024 },
  video: { types: { 'video/mp4': 'mp4', 'video/quicktime': 'mov' }, maxBytes: 100 * 1024 * 1024 },
};

export function validateUploadRequest({ kind, contentType, bytes }) {
  const rule = RULES[kind];
  if (!rule || !rule.types[contentType]) throw new HttpError(400, 'bad_type');
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > rule.maxBytes) throw new HttpError(400, 'too_big');
  return { ext: rule.types[contentType] };
}
