import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, writeBatch, disableNetwork, enableNetwork, getDocs, collection } from 'firebase/firestore';
const host = process.env.FIRESTORE_EMULATOR_HOST;
assert.match(host || '', /^(127\.0\.0\.1|localhost):\d+$/, 'Only a localhost emulator is allowed');
const [hostname, port] = host.split(':');
const fragment = readFileSync(new URL('../docs/firestore-rules-fragment.rules',import.meta.url),'utf8').replace("rules_version = '2';",'');
const rules = `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { ${fragment}
match /unrelated-app/{id} { allow read,write: if request.auth != null && request.auth.uid == "other-owner"; }
} }`;
const env = await initializeTestEnvironment({ projectId:'demo-budget-security', firestore:{host:hostname,port:Number(port),rules} });
const google = {firebase:{sign_in_provider:'google.com'}};
const path = 'spaces/household_budget_management_forbaby';
try {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const uid of ['spouseA','spouseB']) await setDoc(doc(db,'approvedBudgetUsers',uid),{approved:true});
    await setDoc(doc(db,'approvedBudgetUsers','disabled-user'),{approved:false});
    await setDoc(doc(db,path,'expenses','existing'),{amount:42,note:'保存済み'});
    await setDoc(doc(db,'unrelated-app','original'),{preserve:42});
  });
  const a=env.authenticatedContext('spouseA',google).firestore(), b=env.authenticatedContext('spouseB',google).firestore();
  for (const db of [env.authenticatedContext('disabled-user',google).firestore(),env.unauthenticatedContext().firestore(),env.authenticatedContext('third-party',google).firestore(),env.authenticatedContext('spouseA',{firebase:{sign_in_provider:'anonymous'}}).firestore()]) {
    await assertFails(getDoc(doc(db,path,'expenses','existing')));
    await assertFails(setDoc(doc(db,path,'expenses','malicious'),{amount:0}));
    await assertFails(setDoc(doc(db,'approvedBudgetUsers','third-party'),{approved:true}));
  }
  await assertSucceeds(getDoc(doc(a,path,'expenses','existing')));await assertSucceeds(getDoc(doc(b,path,'expenses','existing')));
  await assertFails(setDoc(doc(a,'approvedBudgetUsers','third-party'),{}));
  await disableNetwork(a);await disableNetwork(b);
  const add = (db,id) => {const batch=writeBatch(db);batch.set(doc(db,path,'expenses',id),{amount:10});batch.set(doc(db,path,'history',id),{entityId:id});return batch.commit();};
  const pa=add(a,'offline-A'),pb=add(b,'offline-B');await enableNetwork(a);await enableNetwork(b);await Promise.all([pa,pb]);
  assert.equal((await getDocs(collection(a,path,'expenses'))).size,3);
  assert.equal((await getDocs(collection(b,path,'history'))).size,2);
  assert.equal((await getDoc(doc(a,path,'expenses','existing'))).data().amount,42);
  assert.equal((await assertSucceeds(getDoc(doc(env.authenticatedContext('other-owner',google).firestore(),'unrelated-app','original')))).data().preserve,42);
  await assertFails(getDoc(doc(a,'unrelated-app','original')));
  console.log('PASS: approved two users, unauthenticated/third-party/anonymous denial, two-client offline writes + history, unrelated app rule preservation (emulator only)');
} finally { await env.cleanup(); }
