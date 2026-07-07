import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUploadRequest } from '../uploadrules.mjs';
import { completeUpload } from '../uploadflow.mjs';

test('accepts jpeg photo within cap', () => {
  assert.deepEqual(validateUploadRequest({ kind: 'photo', contentType: 'image/jpeg', bytes: 5_000_000 }), { ext: 'jpg' });
});

test('rejects oversize photo and wrong types', () => {
  assert.throws(() => validateUploadRequest({ kind: 'photo', contentType: 'image/jpeg', bytes: 16_000_000 }), /too_big/);
  assert.throws(() => validateUploadRequest({ kind: 'photo', contentType: 'image/gif', bytes: 1000 }), /bad_type/);
  assert.throws(() => validateUploadRequest({ kind: 'video', contentType: 'video/webm', bytes: 1000 }), /bad_type/);
  assert.throws(() => validateUploadRequest({ kind: 'other', contentType: 'image/jpeg', bytes: 1000 }), /bad_type/);
});

test('accepts mp4 video within cap', () => {
  assert.deepEqual(validateUploadRequest({ kind: 'video', contentType: 'video/mp4', bytes: 80_000_000 }), { ext: 'mp4' });
});

const pendingMedia = () => ({
  id: 'm1', user_id: 'u1', kind: 'photo', r2_key: 'media/m1.jpg',
  status: 'pending', content_type: 'image/jpeg',
});

function depsWith(exif, media = pendingMedia()) {
  return {
    sql: async (strings, ...vals) => {
      const q = strings.join('?');
      if (q.includes('SELECT') && q.includes('FROM media')) return [media];
      if (q.includes('UPDATE media')) return [{ ...media, status: 'live', stamp_source: vals[0] }];
      throw new Error('unexpected: ' + q);
    },
    headObject: async () => ({ bytes: 5000, contentType: 'image/jpeg' }),
    readExif: async () => exif,
    reverseGeocode: async () => null,
  };
}

test('completeUpload verifies object, resolves tier, and goes live', async () => {
  const out = await completeUpload(depsWith({ lat: 40.001, lng: -74.001, capturedAt: '2026-07-01T12:00:00Z' }), {
    mediaId: 'm1', userId: 'u1', lat: 40, lng: -74,
    capturedAt: '2026-07-01T12:30:00Z', caption: 'firing', claimedStampSource: 'exif',
  });
  assert.equal(out.status, 'live');
  assert.equal(out.stamp_source, 'exif');
});

test('completeUpload downgrades when object EXIF contradicts claim', async () => {
  const out = await completeUpload(depsWith({ lat: 0, lng: 0, capturedAt: '2020-01-01T00:00:00Z' }), {
    mediaId: 'm1', userId: 'u1', lat: 40, lng: -74,
    capturedAt: '2026-07-01T12:30:00Z', caption: '', claimedStampSource: 'exif',
  });
  assert.equal(out.stamp_source, 'manual');
});

test('completeUpload is idempotent for already-live media', async () => {
  const live = { ...pendingMedia(), status: 'live', stamp_source: 'exif' };
  const out = await completeUpload(depsWith(null, live), {
    mediaId: 'm1', userId: 'u1', lat: 40, lng: -74,
    capturedAt: '2026-07-01T12:30:00Z', caption: '', claimedStampSource: 'exif',
  });
  assert.equal(out.status, 'live');
  assert.equal(out.stamp_source, 'exif');
});

test('completeUpload 400s when the object was never uploaded', async () => {
  const deps = { ...depsWith(null), headObject: async () => null };
  await assert.rejects(() => completeUpload(deps, {
    mediaId: 'm1', userId: 'u1', lat: 40, lng: -74,
    capturedAt: '2026-07-01T12:30:00Z', caption: '', claimedStampSource: 'device',
  }), /no_object/);
});
