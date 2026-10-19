const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs');
const ctx = { crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, module: {exports:{}} };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../data-backup.js'),'utf8'), ctx);
const backup = ctx.module.exports;
const plain = obj => JSON.parse(JSON.stringify(obj));
const keys = ['data', 'pending', 'settings'];
class Storage {
  constructor() { this.values = new Map(); this.failOnce = null; }
  getItem(k) { return this.values.get(k) ?? null; }
  setItem(k, v) { if (this.failOnce === k) { this.failOnce = null; throw Error('quota'); } this.values.set(k, v); }
  removeItem(k) { this.values.delete(k); }
}
test('complete encrypted export/import preserves exact content, counts, pending queue and Unicode', async () => {
  const entries = { data: JSON.stringify({months:{'2026-10':{salary:200000, expenses:[{id:'日本語',amount:42,deletedAt:123}]}}}), pending: JSON.stringify(Array.from({length:601},(_,id)=>({id,operationId:'op-'+id}))), settings: null };
  const encrypted = await backup.seal('test-app', entries, 'strong-long-passphrase');
  assert.ok(!encrypted.includes('日本語')); assert.ok(!encrypted.includes('salary'));
  const restored = await backup.open('test-app', encrypted, 'strong-long-passphrase', keys);
  assert.deepEqual(plain(restored), entries); assert.equal(JSON.parse(restored.pending).length, 601);
  const storage = new Storage(); storage.setItem('data', 'existing'); storage.setItem('auth', 'must-not-export');
  backup.transaction(storage, keys, restored, 'test');
  assert.deepEqual(plain(backup.snapshot(storage, keys)), entries); assert.equal(storage.getItem('auth'), 'must-not-export');
  const rollback = JSON.parse(storage.getItem('test:rollback')); backup.transaction(storage, keys, rollback, 'test');
  assert.equal(storage.getItem('data'), 'existing');
});
test('wrong password, tampered ciphertext, wrong app, incomplete schema are rejected', async () => {
  const encrypted = await backup.seal('test-app', {data:'a',pending:'[]',settings:null}, 'strong-long-passphrase');
  await assert.rejects(backup.open('test-app', encrypted, 'wrong-long-passphrase', keys));
  await assert.rejects(backup.open('other-app', encrypted, 'strong-long-passphrase', keys));
  await assert.rejects(backup.open('test-app', encrypted, 'strong-long-passphrase', ['data']));
  const tampered = JSON.parse(encrypted); tampered.ciphertext = (tampered.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.ciphertext.slice(1);
  await assert.rejects(backup.open('test-app', JSON.stringify(tampered), 'strong-long-passphrase', keys));
});
test('partial restore rolls back and interrupted restore recovers on startup', () => {
  const storage = new Storage(); storage.setItem('data','old'); storage.setItem('pending','old-pending');
  storage.failOnce = 'pending';
  assert.throws(() => backup.transaction(storage, keys, {data:'new',pending:'new-pending',settings:null}, 'test'));
  assert.equal(storage.getItem('data'),'old'); assert.equal(storage.getItem('pending'),'old-pending');
  storage.setItem('test:pending',JSON.stringify({data:'old',pending:'old-pending',settings:null})); storage.setItem('data','partial');
  backup.recover(storage,'test'); assert.equal(storage.getItem('data'),'old'); assert.equal(storage.getItem('test:pending'),null);
});
test('cannot start restore if rollback journal cannot be persisted', () => {
  const storage = new Storage(); storage.setItem('data','old'); storage.failOnce='test:rollback';
  assert.throws(() => backup.transaction(storage,keys,{data:'new',pending:'[]',settings:null},'test'));
  assert.equal(storage.getItem('data'),'old');
});
