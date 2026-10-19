// Read-only project backup + content verification. No deploy, import or delete operation exists here.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function encrypt(value, password) {
  if (!password || password.length < 16) throw Error('BACKUP_PASSPHRASE must contain at least 16 characters');
  const salt = randomBytes(16), iv = randomBytes(12), key = pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('firebase-admin-backup-v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); key.fill(0);
  return JSON.stringify({ version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export function decrypt(text, password) {
  const data = JSON.parse(text); if (data.version !== 1) throw Error('Unsupported backup');
  const key = pbkdf2Sync(password, Buffer.from(data.salt, 'base64'), 310000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
  decipher.setAAD(Buffer.from('firebase-admin-backup-v1')); decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  try { return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]).toString('utf8')); }
  finally { key.fill(0); }
}
export function manifest(data) {
  function normalizeReferences(value) {
    if (Array.isArray(value)) return value.map(normalizeReferences);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      k === 'referenceValue' && typeof v === 'string' ? v.replace(`projects/${data.project}/`, 'projects/$PROJECT/') : normalizeReferences(v)]));
    return value;
  }
  return { documents: Object.keys(data.firestore).length, firestore: digest(normalizeReferences(data.firestore)), rtdb: digest(data.rtdb), rules: digest(data.rules) };
}
export function firestorePath(project, name) {
  const prefix = `projects/${project}/databases/(default)/documents/`;
  if (!name.startsWith(prefix)) throw Error('Unexpected Firestore document resource');
  return name.slice(prefix.length);
}
export const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
async function request(url, body, raw = false) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: {
    Authorization: `Bearer ${process.env.GCP_ACCESS_TOKEN}`, 'Content-Type': 'application/json'
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  // Error responses can contain data: never echo them or tokens.
  if (!response.ok) throw Error(`Admin read failed: HTTP ${response.status}`);
  return raw ? response.text() : response.json();
}
async function capture(project, databaseURL) {
  if (!process.env.GCP_ACCESS_TOKEN) throw Error('Provide a short-lived administrator GCP_ACCESS_TOKEN through the environment');
  if (!/^[a-z][a-z0-9-]+$/.test(project)) throw Error('Invalid project');
  const url = new URL(databaseURL);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.firebasedatabase.app') || url.pathname !== '/' || url.search || url.username) throw Error('Expected root RTDB https URL');
  const db = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const firestore = {};
  async function collection(parent) {
    let pageToken;
    do {
      const page = await request(`${db}${parent}:listCollectionIds`, { pageSize: 1000, ...(pageToken ? { pageToken } : {}) });
      for (const id of page.collectionIds || []) {
        let token;
        do {
          const query = new URLSearchParams({ pageSize: '1000', showMissing: 'true', ...(token ? { pageToken: token } : {}) });
          const docs = await request(`${db}${parent}/${encodeURIComponent(id)}?${query}`);
          for (const doc of docs.documents || []) {
            const path = firestorePath(project, doc.name);
            // Preserve original protobuf field values, including exact integer/timestamp/reference/bytes types.
            if (doc.createTime || doc.updateTime || doc.fields) firestore[path] = doc.fields || {};
            await collection('/' + encodePath(path));
          }
          token = docs.nextPageToken;
        } while (token);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  await collection('');
  // Export priorities too, and keep the original JSON text to avoid rounding large integer literals.
  const rtdb = await request(`${url.origin}/.json?format=export`, undefined, true);
  const rtdbRules = await request(`${url.origin}/.settings/rules.json`);
  const release = await request(`https://firebaserules.googleapis.com/v1/projects/${project}/releases/cloud.firestore`);
  const firestoreRules = await request(`https://firebaserules.googleapis.com/v1/${release.rulesetName}`);
  return { version: 1, capturedAt: new Date().toISOString(), project, databaseURL: url.origin, firestore, rtdb, rules: { rtdb: rtdbRules, firestore: firestoreRules.source } };
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const password = process.env.BACKUP_PASSPHRASE;
  if (mode === 'capture') {
    const [project, databaseURL, destination] = args;
    if (!destination) throw Error('capture PROJECT RTDB_ROOT_URL OUTPUT_FILE (outside repository)');
    const output = resolve(destination), rel = relative(process.cwd(), output);
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) throw Error('Save private backup OUTSIDE the current repository');
    const data = await capture(project, databaseURL), encrypted = encrypt(data, password);
    await mkdir(resolve(output, '..'), { recursive: true, mode: 0o700 });
    await writeFile(output, encrypted, { flag: 'wx', mode: 0o600 });
    const verified = decrypt(await readFile(output, 'utf8'), password);
    if (digest(verified) !== digest(data)) throw Error('Backup readback verification failed');
    console.log(JSON.stringify({ result: 'encrypted-backup-readback-verified', ...manifest(verified) }));
  } else if (mode === 'compare') {
    const a = decrypt(await readFile(args[0], 'utf8'), password), b = decrypt(await readFile(args[1], 'utf8'), password);
    const ma = manifest(a), mb = manifest(b);
    if (ma.documents !== mb.documents || ma.firestore !== mb.firestore || ma.rtdb !== mb.rtdb) throw Error('Data mismatch: do not deploy or delete anything');
    console.log(JSON.stringify({ result: 'all-document-paths-counts-and-content-match', ...ma, rulesMatch: ma.rules === mb.rules }));
  } else throw Error('Usage: capture PROJECT RTDB_ROOT_URL OUTPUT_FILE | compare BEFORE_FILE RESTORED_FILE');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
