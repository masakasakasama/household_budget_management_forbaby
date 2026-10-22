const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=import('./firebase-admin-backup.mjs');
test('administrator backup encrypts typed values and rules without modifying references',async()=>{
  const {encrypt,decrypt,manifest,firestorePath,encodePath}=await api;
  const unusual='root/one/documents/id%2F日本語';
  assert.equal(firestorePath('source','projects/source/databases/(default)/documents/'+unusual),unusual);
  assert.equal(encodePath(unusual),'root/one/documents/id%252F%E6%97%A5%E6%9C%AC%E8%AA%9E');
  const data={project:'source',firestore:{'spaces/a/expenses/b':{amount:{integerValue:'9007199254740993'},at:{timestampValue:'2026-10-20T00:00:00Z'},ref:{referenceValue:'projects/source/databases/(default)/documents/other/c'}}},rtdb:'{"largeInteger":9223372036854775807,"withPriority":{".value":true,".priority":10}}',rules:{rtdb:{'.read':false}}};
  const encrypted=encrypt(data,'fixture-administrator-password');
  assert.ok(!encrypted.includes('9007199254740993'));
  assert.deepEqual(decrypt(encrypted,'fixture-administrator-password'),data);
  assert.throws(()=>decrypt(encrypted,'wrong-administrator-password'));
  const restored=structuredClone(data);restored.project='staging';restored.firestore['spaces/a/expenses/b'].ref.referenceValue=restored.firestore['spaces/a/expenses/b'].ref.referenceValue.replace('/source/','/staging/');
  assert.equal(manifest(data).firestore,manifest(restored).firestore);
  restored.firestore['spaces/a/expenses/b'].amount.integerValue='1';assert.notEqual(manifest(data).firestore,manifest(restored).firestore);
  assert.equal(data.firestore['spaces/a/expenses/b'].ref.referenceValue,'projects/source/databases/(default)/documents/other/c');
});
