// Start only the pinned local Java emulator needed for QA; no CLI credentials or deploy command.
// SHA-256 values are from firebase-tools v15.34.0 downloadableEmulatorInfo.json.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const marriage=(await readFile(join(root,'index.html'),'utf8')).includes('marriage_checklist_v2');
const type=marriage?'database':'firestore',port=marriage?19000:18080;
const details=marriage
  ? {file:'firebase-database-emulator-v4.11.2.jar',sha:'b70d99344caf17c98b6f910fa8f6edf32a7c016cb1035e8915f70d38901eb97f'}
  : {file:'cloud-firestore-emulator-v1.22.0.jar',sha:'9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c'};
const cache=join(homedir(),'.cache','firebase','emulators'),file=join(cache,details.file);
await mkdir(cache,{recursive:true});
let jar;try {jar=await readFile(file);}catch {
  const response=await fetch('https://storage.googleapis.com/firebase-preview-drop/emulator/'+details.file,{redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error('Emulator download failed');jar=Buffer.from(await response.arrayBuffer());
  if(createHash('sha256').update(jar).digest('hex')!==details.sha)throw Error('Emulator checksum mismatch');
  await writeFile(file,jar,{flag:'wx'});
}
if(createHash('sha256').update(jar).digest('hex')!==details.sha)throw Error('Emulator checksum mismatch');
const isOpen=()=>new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.on('connect',()=>{socket.destroy();resolve(true)});socket.on('error',()=>resolve(false));});
if(await isOpen())throw Error('QA port already in use; refusing to connect to another database');
const java=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
const args=['-Duser.language=en','-jar',file,'--host','127.0.0.1','--port',String(port)];
if(!marriage)args.push('--project_id','demo-budget-security','--rules',join(root,'docs/qa-deny.firestore.rules'));
const emulator=spawn(java,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
let output='',exitCode=null;emulator.stdout.on('data',chunk=>output+=chunk);emulator.stderr.on('data',chunk=>output+=chunk);
emulator.on('error',error=>{output+=error.message;exitCode=1;});emulator.on('exit',code=>exitCode=code??1);
try {
  const start=Date.now();
  while(!await isOpen()) {
    if(exitCode!==null||Date.now()-start>60000)throw Error('Local emulator failed to start: '+output.slice(-2000));
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  const test=spawn(process.execPath,[join(root,'scripts/rules.test.mjs')],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,
    [marriage?'FIREBASE_DATABASE_EMULATOR_HOST':'FIRESTORE_EMULATOR_HOST']:`127.0.0.1:${port}`,
    GCLOUD_PROJECT:marriage?'demo-marriage-security':'demo-budget-security'}});
  const result=await new Promise((resolve,reject)=>{test.on('error',reject);test.on('exit',code=>resolve(code));});
  if(result!==0)throw Error('Emulator QA failed');
} finally {
  emulator.kill();
  await writeFile(join(root,type+'-debug.log'),output);
}
