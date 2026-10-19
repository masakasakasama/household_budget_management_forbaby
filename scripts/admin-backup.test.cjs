const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=import('./firebase-admin-backup.mjs');
test('administrator backup encrypts typed values and rules without modifying references',async()=>{
  const {encrypt,decrypt,manifest}=await api;
  const data={project:'source',firestore:{'spaces/a/expenses/b':{amount:{integerValue:'9007199254740993'},at:{timestampValue:'2026-10-20T00:00:00Z'},ref:{referenceValue:'projects/source/databases/(default)/documents/other/c'}}},rtdb:{existing:{checked:true}},rules:{rtdb:{'.read':false}}};
  const encrypted=encrypt(data,'fixture-administrator-password');
  assert.ok(!encrypted.includes('9007199254740993'));
  assert.deepEqual(decrypt(encrypted,'fixture-administrator-password'),data);
  assert.throws(()=>decrypt(encrypted,'wrong-administrator-password'));
  const restored=structuredClone(data);restored.project='staging';restored.firestore['spaces/a/expenses/b'].ref.referenceValue=restored.firestore['spaces/a/expenses/b'].ref.referenceValue.replace('/source/','/staging/');
  assert.equal(manifest(data).firestore,manifest(restored).firestore);
  restored.firestore['spaces/a/expenses/b'].amount.integerValue='1';assert.notEqual(manifest(data).firestore,manifest(restored).firestore);
  assert.equal(data.firestore['spaces/a/expenses/b'].ref.referenceValue,'projects/source/databases/(default)/documents/other/c');
});
