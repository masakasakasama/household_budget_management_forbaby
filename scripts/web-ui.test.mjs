import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, sep, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const marriage = (await readFile(join(root,'index.html'),'utf8')).includes('marriage_checklist_v2');
const keys=marriage?['marriage_checklist_v2','marriage_checklist_cfg','marriage_checklist_v1']:['baby-budget-data-v2','baby-budget-backups-v2','baby-budget-pending-v2','baby-budget-recent-categories'];
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost'),file=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(root+sep)) {res.writeHead(403);res.end();return;}
    res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.css':'text/css'})[extname(file)]||'application/octet-stream');
    res.end(await readFile(file));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/?offline=1`;
const browser=await chromium.launch({headless:true});
const contexts=[];const errors=[];const outputs=await mkdtemp(join(tmpdir(),'security-backup-ui-'));
async function page() {
  const context=await browser.newContext({acceptDownloads:true});contexts.push(context);
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await context.addInitScript(()=>{window.showSaveFilePicker=undefined;});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());await page.goto(url);
  await page.getByRole('button',{name:'完全バックアップを書き出す',exact:true}).waitFor();
  return page;
}
const snapshot=page=>page.evaluate(keys=>Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)])),keys);
try {
  const original=await page();
  if(marriage) {
    await original.locator('label:has(input[data-id="ta1"])').click();
    assert.equal(await original.locator('[data-id="ta1"]').isChecked(),true);
  } else {
    await original.locator('#salaryInput').fill('321000');await original.locator('#salaryInput').dispatchEvent('change');
    assert.ok((await snapshot(original))['baby-budget-data-v2'].includes('321000'));
  }
  await original.getByPlaceholder('12文字以上のパスフレーズ').fill('fixture-long-backup-password');
  const downloadPromise=original.waitForEvent('download');await original.getByRole('button',{name:'完全バックアップを書き出す',exact:true}).click();
  const file=join(outputs,'fixture.backup');await(await downloadPromise).saveAs(file);
  const before=await snapshot(original);const encrypted=await readFile(file,'utf8');
  assert.ok(!encrypted.includes('321000'));assert.ok(!encrypted.includes('marriage_checklist'));
  const target=await page();const targetBefore=await snapshot(target);
  await target.getByPlaceholder('12文字以上のパスフレーズ').fill('wrong-backup-password');
  await target.locator('input[type=file][accept=".backup"]').setInputFiles(file);
  await target.getByRole('status').filter({hasText:'復元失敗'}).waitFor();assert.deepEqual(await snapshot(target),targetBefore);
  await target.getByPlaceholder('12文字以上のパスフレーズ').fill('fixture-long-backup-password');
  await target.locator('input[type=file][accept=".backup"]').evaluate(input=>input.value='');
  await Promise.all([target.waitForEvent('load'), target.locator('input[type=file][accept=".backup"]').setInputFiles(file)]);
  await target.getByRole('button',{name:'完全バックアップを書き出す',exact:true}).waitFor();
  await target.waitForFunction(()=>localStorage.getItem('marriage:backup:hold')==='1'||localStorage.getItem('baby-budget:backup:hold')==='1');
  assert.deepEqual(await snapshot(target),before,'All restored entries must exactly match exported values');
  if(marriage) assert.equal(await target.locator('[data-id="ta1"]').isChecked(),true);
  else assert.equal((await target.locator('#salaryInput').inputValue()).replaceAll(',',''),'321000');
  await Promise.all([target.waitForEvent('load'),target.getByRole('button',{name:'復元直前へロールバック',exact:true}).click()]);
  await target.getByRole('button',{name:'完全バックアップを書き出す',exact:true}).waitFor();
  assert.deepEqual(await snapshot(target),targetBefore);
  // A corrupt existing record must never be replaced by demonstration/initial data.
  const damaged=await page();
  const bad='{"interrupted-save":';
  await damaged.evaluate(({key,bad})=>localStorage.setItem(key,bad),{key:keys[0],bad});
  await damaged.reload();await damaged.locator('#localDataRecovery').waitFor();
  assert.equal((await snapshot(damaged))[keys[0]],bad);
  await damaged.getByPlaceholder('12文字以上のパスフレーズ').fill('fixture-long-backup-password');
  await Promise.all([damaged.waitForEvent('load'),damaged.locator('input[type=file][accept=".backup"]').setInputFiles(file)]);
  await damaged.getByRole('button',{name:'完全バックアップを書き出す',exact:true}).waitFor();
  assert.deepEqual(await snapshot(damaged),before);
  // Load the actual worker, then take the browser offline and reload/edit/reload.
  await original.evaluate(async()=>{
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller) await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
  });
  const cacheUrls=await original.evaluate(async()=>{
    const urls=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())urls.push(request.url);return urls;
  });
  assert.ok(cacheUrls.length>0);assert.ok(cacheUrls.every(value=>new URL(value).hostname==='127.0.0.1'));
  await original.context().setOffline(true);await original.reload();
  await original.getByRole('button',{name:'完全バックアップを書き出す',exact:true}).waitFor();
  if(marriage) {
    assert.equal(await original.locator('[data-id="ta1"]').isChecked(),true);
    await original.locator('label:has(input[data-id="ta2"])').click();await original.reload();
    assert.equal(await original.locator('[data-id="ta2"]').isChecked(),true);
  } else {
    assert.equal((await original.locator('#salaryInput').inputValue()).replaceAll(',',''),'321000');
    await original.locator('#salaryInput').click();await original.locator('#salaryInput').fill('324000');await original.locator('#salaryInput').dispatchEvent('change');await original.reload();
    assert.equal((await original.locator('#salaryInput').inputValue()).replaceAll(',',''),'324000');
    assert.ok(JSON.parse((await snapshot(original))['baby-budget-pending-v2']).length>0);
  }
  await original.context().setOffline(false);
  assert.deepEqual(errors,[]);
  console.log(`PASS: ${marriage?'marriage':'budget'} browser export -> encrypted download -> wrong-password refusal -> fresh-browser import -> exact content/visible data -> rollback; corrupt-data preservation/recovery; offline reload/edit/reload; no production network access`);
} finally {for(const context of contexts)await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
