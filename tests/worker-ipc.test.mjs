import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';

const source=fileURLToPath(new URL('../src/',import.meta.url));
function within(promise,ms=2000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('child did not exit autonomously within budget')),ms);})]).finally(()=>clearTimeout(timer));}
function fixture(t,{stall=false,persistenceFailure,connected=false,recover=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'argo-worker-fixture-')),app=path.join(root,'app'),data=path.join(root,'data');
 fs.mkdirSync(app);fs.mkdirSync(path.join(app,'bin'));
 for(const name of fs.readdirSync(source).filter(name=>name.endsWith('.mjs')))fs.copyFileSync(path.join(source,name),path.join(app,name));
 if(connected){
  // Only this child fixture replaces external boundaries. The worker, attempt,
  // and supervisor still own their real IPC and cleanup lifecycle.
  fs.writeFileSync(path.join(app,'prototype.mjs'),`export async function loadConfig(){return {serial:'7',config:{}};}export function serversFrom(config,profile){process.send?.({kind:'profile',profile});return [{id:'fixture',server:'fixture.invalid'}];}export async function authenticate(candidate,protocol,{signal}){process.send?.({kind:'auth',protocol,signal:signal instanceof AbortSignal});return candidate;}`);
  fs.writeFileSync(path.join(app,'engine.mjs'),`let count=0;export async function chooseProxyPort(port){return port+1;}export async function startEngine(session,{port,mode,signal}){const id=++count;process.send?.({kind:'engine',id,port,mode,signal:signal instanceof AbortSignal});let stopped=false,resolveClosed;const closed=new Promise(resolve=>resolveClosed=resolve);${recover?'if(id===1)setTimeout(()=>{stopped=true;resolveClosed();},20);':''}return {port,closed,isStopped:()=>stopped,stop:async()=>{process.send?.({kind:'cleanup-started',id});await new Promise(resolve=>setTimeout(resolve,40));stopped=true;resolveClosed();process.send?.({kind:'cleanup-done',id});return {processStopped:true,runtimeRemoved:true};}};}`);
  fs.writeFileSync(path.join(app,'traffic-probe.mjs'),`export async function verifyTraffic({port,mode,signal}){process.send?.({kind:'verified',port,mode,signal:signal instanceof AbortSignal});return {tunnelVerified:true,country:'DE'};}export async function pingSession(){}export async function disconnectSession(){return {status:200,body:'x'};}`);
 }
 const hashes={};for(const name of ['sing-box.exe','wintun.dll']){const relative=`bin/${name}`,body=Buffer.from('harmless fixture, never executed');fs.writeFileSync(path.join(app,relative),body);hashes[relative]=crypto.createHash('sha256').update(body).digest('hex');}
 fs.writeFileSync(path.join(app,'integrity.json'),JSON.stringify(hashes));
 const preload=path.join(root,'preload.mjs');
 fs.writeFileSync(preload,`import https from 'node:https';import {EventEmitter} from 'node:events';import fs from 'node:fs';
 const read=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file).endsWith('config-signed.txt'))process.send?.({kind:'fallback'});return read.call(this,file,...args);};
 https.request=(options)=>{process.send?.({kind:'config-entered'});${stall?'':'throw new Error("EXTERNAL_IO_FORBIDDEN");'}
 const req=new EventEmitter();let destroyed=false;req.end=()=>{};req.destroy=()=>{if(destroyed)return;destroyed=true;options.signal?.removeEventListener('abort',abort);queueMicrotask(()=>req.emit('close'));};const abort=()=>{req.destroy();queueMicrotask(()=>req.emit('error',new Error('fixture aborted')));};options.signal?.addEventListener('abort',abort,{once:true});return req;};
 ${stall?'setInterval(()=>{},1000);':''}`);
 if(connected)fs.appendFileSync(preload,`import dns from 'node:dns/promises';dns.lookup=async()=>({address:'192.0.2.1',family:4});setInterval(()=>{},1000);`);
 if(persistenceFailure)fs.appendFileSync(preload,`
 const write=fs.writeFileSync;let periodic=false,stateFailed=false;fs.writeFileSync=function(file,body,...args){const text=String(body),stateFailure=${JSON.stringify(persistenceFailure)}==='state'&&!stateFailed&&text.includes('"lastStage": "connected"');if(stateFailure)stateFailed=true;if((periodic||stateFailure||(${JSON.stringify(persistenceFailure)}==='final'&&text.includes('"completedAt"')))&&String(file).endsWith('latest.json'))throw Object.assign(new Error('PRIVATE_PERSISTENCE_SENTINEL'),{code:'EACCES'});return write.call(this,file,body,...args);};
 const interval=globalThis.setInterval;globalThis.setInterval=(callback,ms,...args)=>ms===5000?setTimeout(()=>{periodic=${JSON.stringify(persistenceFailure)}==='periodic';try{callback(...args);}finally{periodic=false;}},20):interval(callback,ms,...args);`);
 const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,path.join(app,'worker.mjs')],{env:{...process.env,ARGO_DATA_DIR:data},stdio:['pipe','pipe','pipe','ipc'],windowsHide:true});
 let stdout='',stderr='';const messages=[];child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('message',message=>messages.push(message));
 const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 t.after(async()=>{
  if(child.exitCode===null){child.kill();await closed;}
  // The fixture root was created above and remains a direct task-owned temp child.
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('argo-worker-fixture-'));
  function removeOwned(dir){assert(!fs.lstatSync(dir).isSymbolicLink());for(const item of fs.readdirSync(dir,{withFileTypes:true})){const target=path.join(dir,item.name);if(item.isDirectory())removeOwned(target);else fs.unlinkSync(target);}fs.rmdirSync(dir);}
  removeOwned(root);
 });
 return {child,messages,closed,send:command=>child.stdin.write(JSON.stringify(command)+'\n'),get stdout(){return stdout;},get stderr(){return stderr;},report:()=>JSON.parse(fs.readFileSync(path.join(data,'reports','latest.json'),'utf8'))};
}
function events(f){return f.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
function assertEventTimestamps(output){for(const event of output){assert.equal(typeof event.at,'string');assert(!Number.isNaN(Date.parse(event.at)));assert.equal(new Date(event.at).toISOString(),event.at);}}
async function entered(f){await within(new Promise(resolve=>{if(f.messages.length)return resolve();f.child.on('message',message=>{if(message.kind==='config-entered')resolve();});}));}

for(const options of [{mode:'INVALID_SENTINEL',profile:'global',port:10808},{mode:'proxy',profile:'INVALID_SENTINEL',port:10808},{mode:'proxy',profile:'global',port:'INVALID_SENTINEL'},{mode:'full',profile:'ir',port:1023}])test(`invalid options ${JSON.stringify(options)} are rejected before external I/O with a safe report`,async t=>{
 const f=fixture(t);f.send({cmd:'start',...options});f.child.stdin.end();const result=await within(f.closed);
 assert.equal(result.code,1);assert.equal(f.stderr,'');assert.equal(f.messages.length,0);
 const report=f.report(),output=events(f);assert.equal(report.version,'0.3.0');assert.equal(report.errorCode,'INVALID_OPTIONS');assert.equal(report.lastStage,'disconnected');assert.equal(report.stopReason,'failed');
 assert(output.some(e=>e.type==='error'&&e.errorCode==='INVALID_OPTIONS'));assert.equal(output.at(-1).stage,'disconnected');assertEventTimestamps(output);
 assert(!JSON.stringify({report,output}).includes('INVALID_SENTINEL'));
});

test('stop before start stays latched and never loads configuration',async t=>{
 const f=fixture(t);f.send({cmd:'stop'});f.send({cmd:'start',mode:'INVALID_SENTINEL',port:'INVALID_SENTINEL'});
 const result=await within(f.closed);assert.equal(result.code,0);assert.equal(f.stderr,'');assert.equal(f.messages.length,0);
 const report=f.report();assert.equal(report.version,'0.3.0');assert.equal(report.errorCode,undefined);assert.equal(report.configurationSource,undefined);assert.equal(report.stopReason,'requested');assert.equal(report.lastStage,'disconnected');assert(report.stopRequestedAt);assert(report.completedAt);
 const output=events(f);assert(!output.some(e=>e.stage==='connected'||e.type==='error'));assertEventTimestamps(output);
});

test('stop during pending config exits within two seconds with stdin open and an uncancellable residual timer',async t=>{
 const f=fixture(t,{stall:true});f.send({cmd:'start',mode:'proxy',profile:'global',port:10808});await entered(f);
 const began=performance.now();f.send({cmd:'stop'});const result=await within(f.closed);
 const elapsed=performance.now()-began;t.diagnostic(`bounded worker exit: ${elapsed.toFixed(1)} ms`);
 assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(f.stderr,'');assert(!f.child.stdin.writableEnded);
 assert.deepEqual(f.messages,[{kind:'config-entered'}]);const report=f.report();assert.equal(report.errorCode,undefined);assert.equal(report.configurationSource,undefined);assert.equal(report.lastStage,'disconnected');assert.equal(report.stopReason,'requested');assert.equal(report.tunnelVerified,false);assert(report.stopRequestedAt);assert(report.completedAt);
 const output=events(f);assert(!output.some(e=>e.type==='error'||e.stage==='connected'));assert.equal(output.at(-1).stage,'disconnected');assertEventTimestamps(output);
});

test('malformed and nonobject commands produce only safe INVALID_COMMAND events',async t=>{
 const f=fixture(t);f.child.stdin.write('INVALID_SENTINEL\nnull\n[]\n42\n{}\n');f.send({cmd:'stop'});f.send({cmd:'start',mode:'proxy',profile:'global',port:10808});
 assert.equal((await within(f.closed)).code,0);assert.equal(f.stderr,'');const output=events(f),errors=output.filter(e=>e.type==='error');assert.equal(errors.length,5);assert(errors.every(e=>e.errorCode==='INVALID_COMMAND'));assertEventTimestamps(output);assert(!f.stdout.includes('INVALID_SENTINEL'));
});

for(const persistenceFailure of ['periodic','final'])test(`${persistenceFailure} report write failure still emits safe terminal JSON and exits autonomously`,async t=>{
 const f=fixture(t,{stall:true,persistenceFailure});f.send({cmd:'start',mode:'proxy',profile:'global',port:10808});await entered(f);
 if(persistenceFailure==='final')f.send({cmd:'stop'});
 assert.equal((await within(f.closed)).code,1);assert.equal(f.stderr,'');const output=events(f);
 assert(output.some(e=>e.type==='error'&&e.errorCode==='REPORT_WRITE_FAILED'));assert.equal(output.at(-1).stage,'disconnected');assertEventTimestamps(output);assert(!f.stdout.includes('PRIVATE_PERSISTENCE_SENTINEL'));assert.deepEqual(f.messages,[{kind:'config-entered'}]);
 if(persistenceFailure==='periodic'){const report=f.report();assert.equal(report.errorCode,'REPORT_WRITE_FAILED');assert.equal(report.lastStage,'disconnected');assert(report.completedAt);}
});


for(const reportPath of ['relative/INVALID_SENTINEL.json',null,42])test(`invalid report path ${reportPath} rejects before any configuration I/O`,async t=>{
 const f=fixture(t);f.send({cmd:'start',mode:'proxy',profile:'global',port:10808,reportPath});
 assert.equal((await within(f.closed)).code,1);assert.equal(f.stderr,'');assert.equal(f.messages.length,0);
 assert.equal(f.report().errorCode,'INVALID_OPTIONS');assert(!f.stdout.includes('INVALID_SENTINEL'));
});

test('a second start during configuration is ignored and EOF cancels the current owner',async t=>{
 const f=fixture(t,{stall:true});f.send({cmd:'start',mode:'proxy',profile:'global',port:10808});await entered(f);
 f.send({cmd:'start',mode:'INVALID_SENTINEL',profile:'global',port:10808});f.child.stdin.end();
 assert.equal((await within(f.closed)).code,0);assert.equal(f.stderr,'');assert.deepEqual(f.messages,[{kind:'config-entered'}]);
 const report=f.report();assert.equal(report.errorCode,undefined);assert.equal(report.stopReason,'requested');assert.equal(report.lastStage,'disconnected');assert(report.completedAt);assert(!f.stdout.includes('INVALID_SENTINEL'));
});

test('test-complete preserves verified traffic evidence and exits only after engine cleanup',async t=>{
 const f=fixture(t,{connected:true});f.send({cmd:'start',mode:'proxy',profile:'global',port:10808,testSeconds:0.04});
 assert.equal((await within(f.closed)).code,0);assert.equal(f.stderr,'');
 const report=f.report();assert.equal(report.lastStage,'disconnected');assert.equal(report.tunnelVerified,true);assert.equal(report.stopReason,'test-complete');assert.equal(report.configurationSource,'online');assert.equal(report.configurationVerified,true);assert.equal(report.configSerial,'7');
 assert.deepEqual(report.proxy,{requestedPort:10808,actualPort:10809,automaticallyChanged:true});assert.equal(report.cleanup.engine.processStopped,true);
 assert.deepEqual(f.messages.filter(m=>m.kind.startsWith('cleanup')).map(m=>m.kind),['cleanup-started','cleanup-done']);
 assert(f.messages.some(m=>m.kind==='auth'&&m.protocol==='A'&&m.signal));assert(f.messages.some(m=>m.kind==='verified'&&m.port===10809&&m.signal));
 const output=events(f);assert.equal(output.at(-1).stage,'disconnected');assertEventTimestamps(output);
});

test('periodic persistence failure joins adopted engine cleanup before terminal exit',async t=>{
 const f=fixture(t,{connected:true,persistenceFailure:'periodic'});f.send({cmd:'start',mode:'proxy',profile:'global',port:10808});
 assert.equal((await within(f.closed)).code,1);assert.equal(f.stderr,'');assert.equal(f.report().errorCode,'REPORT_WRITE_FAILED');
 assert.deepEqual(f.messages.filter(m=>m.kind.startsWith('cleanup')).map(m=>m.kind),['cleanup-started','cleanup-done']);
 assert.equal(f.report().cleanup.engine.processStopped,true);const output=events(f);assert.equal(output.at(-1).stage,'disconnected');assertEventTimestamps(output);
});

test('connected-state persistence failure latches cancellation and joins adopted engine cleanup before terminal exit',async t=>{
 const f=fixture(t,{connected:true,persistenceFailure:'state'});f.send({cmd:'start',mode:'proxy',profile:'global',port:10808});
 assert.equal((await within(f.closed)).code,1);assert.equal(f.stderr,'');const report=f.report(),output=events(f);
 assert.equal(report.errorCode,'REPORT_WRITE_FAILED');assert(report.stopRequestedAt);assert.equal(report.lastStage,'disconnected');assert(report.completedAt);
 assert.deepEqual(f.messages.filter(m=>m.kind.startsWith('cleanup')).map(m=>m.kind),['cleanup-started','cleanup-done']);
 assert.equal(report.cleanup.engine.processStopped,true);assert(output.some(e=>e.type==='error'&&e.errorCode==='REPORT_WRITE_FAILED'));assert.equal(output.at(-1).stage,'disconnected');
 assert(!JSON.stringify({report,output}).includes('PRIVATE_PERSISTENCE_SENTINEL'));assertEventTimestamps(output);
});
