'use strict';
const { requireUser, adminRequest, json, fail, preflight, bodyObject } = require('./_shared');

function backupPath(value, userId) {
  const path = String(value || '');
  const segments = path.split('/');
  if (path.length > 512 || segments.length < 2 || segments[0] !== userId || segments.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part)) || !path.endsWith('.zip')) {
    throw Object.assign(new Error('The cloud backup path is invalid.'), { statusCode: 400 });
  }
  return path;
}

async function getHead(userId) {
  const query = new URLSearchParams({ select: 'revision,snapshot_path', user_id: 'eq.' + userId });
  const rows = await adminRequest('workspace_sync_heads?' + query.toString(), undefined, 'GET');
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function deleteStoredArchive(auth, path) {
  const object = 'noteject-workspaces/' + path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(auth.url + '/storage/v1/object/' + object, {
    method: 'DELETE', headers: { apikey: auth.anonKey, Authorization: 'Bearer ' + auth.token }, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok && response.status !== 404) {
    throw Object.assign(new Error('The cloud ZIP could not be deleted. Your backup record is unchanged; retry deletion.'), { statusCode: 503 });
  }
}

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed.' });
  try {
    const auth = await requireUser(req), body = bodyObject(req);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(auth.user?.id || ''))) {
      return json(res, 401, { error: 'Sign in to your Noteject account again.' });
    }
    const revision = Number(body.revision), snapshotPath = backupPath(body.snapshotPath, auth.user.id);
    if (!Number.isSafeInteger(revision) || revision < 1) return json(res, 400, { error: 'The cloud backup revision is invalid.' });

    const head = await getHead(auth.user.id);
    if (!head) return json(res, 200, { ok: true, deleted: false });
    if (Number(head.revision) !== revision || head.snapshot_path !== snapshotPath) {
      return json(res, 409, { error: 'Another device changed the cloud backup. Refresh the cloud status and try again.' });
    }

    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw Object.assign(new Error('Cloud backup deletion is not configured on this Noteject site.'), { statusCode: 503 });
    await deleteStoredArchive(auth, snapshotPath);

    const filters = new URLSearchParams({
      user_id: 'eq.' + auth.user.id,
      revision: 'eq.' + revision,
      snapshot_path: 'eq.' + snapshotPath
    });
    const deleted = await adminRequest('workspace_sync_heads?' + filters.toString(), undefined, 'DELETE');
    if (!Array.isArray(deleted) || deleted.length === 0) {
      const current = await getHead(auth.user.id);
      if (current) return json(res, 409, { error: 'Another device changed the cloud backup. Its current copy is still available.' });
    }
    return json(res, 200, { ok: true, deleted: true });
  } catch (error) { fail(res, error, 'Could not delete the cloud backup.'); }
};
