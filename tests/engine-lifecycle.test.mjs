import assert from 'node:assert/strict';
import {EventEmitter,once,getEventListeners} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import {fault} from '../src/async-control.mjs';
import {controllerRequest,startEngine} from '../src/engine.mjs';

const session={serverIp:'203.0.113.1',hostName:'example.invalid',uuid:'11111111-1111-4111-8111-111111111111',token:'private-fixture-token',headers:{Host:'AUTO'},wsPath:'/'};

function fixture(t,{closeOnKill=true,ready=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'argo-engine-test-'));
 const child=new EventEmitter();
 Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,kills:0});
 child.kill=()=>{
  child.kills++;
  if(closeOnKill)queueMicrotask(()=>child.emit('close',null,'SIGTERM'));
  return true;
 };
 t.after(()=>{child.stdout.destroy();child.stderr.destroy();fs.rmSync(root,{recursive:true,force:true});});
 const calls=[];
 let configPath;
 const options={mode:'proxy',port:10808,exe:path.join(root,'fixture-engine.exe'),workDir:root,chooseApiPort:async()=>19090,stopWaitMs:[10,10],
  launch(exe,args,options){
   calls.push({exe,args,options});configPath=args[2];
   if(ready)setImmediate(()=>child.stdout.write('sing-box started (fixture)\n'));
   return child;
  },
  controller:async()=>({status:200,body:'{}'})
 };
 return {root,child,calls,options,get configPath(){return configPath;}};
}

test('injected launch and controller start an owned engine without exposing private state',async t=>{
 const f=fixture(t),requests=[];
 f.options.controller=async(...args)=>{requests.push(args);return {status:200,body:'{}'};};
 const core=await startEngine(session,f.options);
 try{
  assert.equal(core.port,10808);assert.equal(core.child,f.child);assert.equal(core.isStopped(),false);
  assert.equal(f.calls.length,1);
  const call=f.calls[0];
  assert.equal(call.exe,f.options.exe);
  assert.deepEqual(call.args,['run','-c',f.configPath,'--disable-color']);
  assert.deepEqual(call.options,{cwd:path.dirname(f.options.exe),windowsHide:true,stdio:['ignore','pipe','pipe']});
  assert.match(path.basename(path.dirname(f.configPath)),/^connection-[A-Za-z0-9]+$/);
  const config=JSON.parse(fs.readFileSync(f.configPath,'utf8'));
  assert.equal(config.experimental.clash_api.external_controller,'127.0.0.1:19090');
  assert.match(config.experimental.clash_api.secret,/^[a-f0-9]{48}$/);
  assert.equal(requests[0][2],'GET');assert.equal(requests[0][3],'/version');
  assert(requests[0][5].signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(core).sort(),['child','closed','isStopped','port','stop']);
 }finally{await core.stop();}
});

test('stop is cached and waits for close even after exit before removing the runtime',async t=>{
 const f=fixture(t,{closeOnKill:false}),requests=[];
 f.options.stopWaitMs=[250,20];
 // Readiness requires a successful GET, whereas shutdown also accepts 204.
 f.options.controller=async(...args)=>{requests.push(args);return {status:args[2]==='GET'?200:204};};
 const core=await startEngine(session,f.options);
 const stopping=core.stop();
 assert.equal(core.stop(),stopping);
 await nextTurn();
 const stopRequest=requests.find(args=>args[2]==='PUT');
 assert.equal(stopRequest[3],'/configs?force=true');
 assert.deepEqual(JSON.parse(stopRequest[4].payload).inbounds,[]);
 assert.equal(f.child.kills,1);
 f.child.exitCode=0;f.child.emit('exit',0,null);
 let closed=false;core.closed.then(()=>{closed=true;});
 await nextTurn();
 assert.equal(closed,false);assert.equal(core.isStopped(),true);assert(fs.existsSync(f.configPath));
 f.child.emit('close',0,null);
 assert.deepEqual(await stopping,{configurationClosed:true,processStopped:true,runtimeRemoved:true});
 assert.equal(core.isStopped(),true);assert.equal(closed,true);assert(!fs.existsSync(path.dirname(f.configPath)));
 // Recreating this path makes a second filesystem cleanup observable.
 fs.mkdirSync(path.dirname(f.configPath));fs.writeFileSync(f.configPath,'sentinel');
 assert.equal(core.stop(),stopping);await core.stop();
 assert.equal(fs.readFileSync(f.configPath,'utf8'),'sentinel');assert.equal(f.child.kills,1);
});

test('startup cancellation interrupts a controller wait and confirms close before rejecting',async t=>{
 const f=fixture(t,{ready:false,closeOnKill:false}),caller=new AbortController();
 f.options.stopWaitMs=[250,20];
 const entered=new EventEmitter();let requestSignal;
 f.options.signal=caller.signal;
 f.options.controller=async(port,secret,method,endpoint,body,{signal}={})=>{
  if(method==='PUT'){assert.equal(signal?.aborted,false);return {status:200};}
  requestSignal=signal;entered.emit('request');
  return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 };
 const requested=once(entered,'request'),starting=startEngine(session,f.options);
 await Promise.race([requested,starting]);
 const reason=fault('CANCELLED');caller.abort(reason);
 let settled=false;starting.then(()=>{settled=true;},()=>{settled=true;});
 await nextTurn();
 assert(requestSignal.aborted);assert.equal(f.child.kills,1);assert.equal(settled,false);assert(fs.existsSync(f.configPath));
 f.child.emit('close',null,'SIGTERM');
 await assert.rejects(starting,error=>error===reason);
 assert(!fs.existsSync(path.dirname(f.configPath)));
});

test('startup rejects a process that exits by signal during a successful readiness request',async t=>{
 const f=fixture(t);
 f.options.controller=async(port,secret,method)=>{
  if(method==='GET'){
   f.child.stdout.write('sing-box started (fixture)\n');
   f.child.signalCode='SIGTERM';
   f.child.emit('exit',null,'SIGTERM');
  }
  return {status:200};
 };
 await assert.rejects(startEngine(session,f.options),{code:'ENGINE_FAILED'});
 assert.equal(f.child.kills,1);
 assert(!fs.existsSync(path.dirname(f.configPath)));
});

test('an unconfirmed child termination is terminal and retains its runtime',async t=>{
 const f=fixture(t,{closeOnKill:false}),core=await startEngine(session,f.options);
 const stopping=core.stop();
 f.child.exitCode=0;f.child.emit('exit',0,null);
 await assert.rejects(stopping,{code:'CLEANUP_FAILED'});
 assert.equal(f.child.kills,2);assert.equal(core.isStopped(),true);assert(fs.existsSync(f.configPath));
 assert.equal(core.stop(),stopping);await assert.rejects(core.stop(),{code:'CLEANUP_FAILED'});
 assert.equal(f.child.kills,2);
 f.child.emit('close',0,null);await core.closed;
});

test('confirmed close refuses a replaced runtime junction and preserves its target',async t=>{
 const f=fixture(t),core=await startEngine(session,f.options);
 const dir=path.dirname(f.configPath),target=path.join(f.root,'preserved');
 fs.renameSync(dir,target);fs.symlinkSync(target,dir,process.platform==='win32'?'junction':'dir');
 await assert.rejects(core.stop(),{code:'CLEANUP_FAILED'});
 assert.equal(core.isStopped(),true);assert(fs.existsSync(path.join(target,'config.json')));
 assert(fs.lstatSync(dir).isSymbolicLink());
});

test('a launch failure removes the newly created runtime without leaking its error',async t=>{
 const f=fixture(t);
 f.options.launch=()=>{throw new Error(session.uuid+' '+session.token);};
 await assert.rejects(startEngine(session,f.options),error=>error.code==='ENGINE_FAILED'&&!error.message.includes(session.uuid)&&!error.message.includes(session.token));
 assert.deepEqual(fs.readdirSync(f.root),[]);
});

test('pre-aborted startup never selects a port, writes a config, or launches',async t=>{
 const f=fixture(t),caller=new AbortController(),reason=fault('CANCELLED');let chosen=false;
 caller.abort(reason);f.options.signal=caller.signal;f.options.chooseApiPort=async()=>{chosen=true;return 19090;};
 await assert.rejects(startEngine(session,f.options),error=>error===reason);
 assert.equal(chosen,false);assert.equal(f.calls.length,0);assert.deepEqual(fs.readdirSync(f.root),[]);
});

test('cancellation during API port selection prevents runtime creation',async t=>{
 const f=fixture(t),caller=new AbortController(),reason=fault('CANCELLED');
 f.options.signal=caller.signal;f.options.chooseApiPort=async()=>{caller.abort(reason);return 19090;};
 await assert.rejects(startEngine(session,f.options),error=>error===reason);
 assert.equal(f.calls.length,0);assert.deepEqual(fs.readdirSync(f.root),[]);
});

test('API port selection cannot reuse the local proxy port',async t=>{
 const f=fixture(t);f.options.chooseApiPort=async()=>f.options.port;
 const core=await startEngine(session,f.options);
 try{
  const config=JSON.parse(fs.readFileSync(f.configPath,'utf8'));
  assert.notEqual(config.experimental.clash_api.external_controller,'127.0.0.1:'+f.options.port);
 }finally{await core.stop();}
});

for(const [line,code] of [
 ['start inbound/mixed[local-proxy]: listen tcp 127.0.0.1:10808: bind: occupied','PROXY_BIND_CONFLICT'],
 ['start inbound/tun: bind: access denied','ENGINE_FAILED']
])test('startup classifies '+code+' only after cleanup despite a successful controller reply',async t=>{
 const f=fixture(t,{ready:false});
 f.options.controller=async(port,secret,method)=>{
  if(method==='GET'){
   f.child.stderr.write(line+'\n'+session.uuid+' '+session.token+'\nsing-box started (fixture)\n');
   f.child.emit('error',new Error('private spawn error'));
  }
  return {status:200};
 };
 await assert.rejects(startEngine(session,f.options),error=>error.code===code&&!error.message.includes(session.uuid)&&!error.message.includes(session.token));
 assert.equal(f.child.kills,1);assert(!fs.existsSync(path.dirname(f.configPath)));
});

test('cleanup failure overrides startup cancellation and retains the config',async t=>{
 const f=fixture(t,{ready:false,closeOnKill:false}),caller=new AbortController();
 f.options.signal=caller.signal;
 f.options.controller=async(port,secret,method)=>{
  if(method==='GET'){caller.abort(fault('CANCELLED'));throw caller.signal.reason;}
  return {status:200};
 };
 await assert.rejects(startEngine(session,f.options),{code:'CLEANUP_FAILED'});
 assert.equal(f.child.kills,2);assert(fs.existsSync(f.configPath));
 f.child.emit('close',null,'SIGTERM');
});

test('a later cancellation during teardown preserves the original startup failure',async t=>{
 const f=fixture(t,{ready:false}),caller=new AbortController();
 f.options.signal=caller.signal;
 f.options.controller=async(port,secret,method)=>{
  if(method==='GET')f.child.emit('error',new Error('startup failed'));
  else caller.abort(fault('CANCELLED'));
  return {status:200};
 };
 await assert.rejects(startEngine(session,f.options),{code:'ENGINE_FAILED'});
 assert.equal(f.child.kills,1);assert(!fs.existsSync(path.dirname(f.configPath)));
});

async function controllerFixture(t,handler){
 const server=http.createServer(handler);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return server.address().port;
}

test('controller request sends loopback Bearer authentication and a byte-counted JSON body',async t=>{
 const payload={message:'fixture \u06cc'},encoded=JSON.stringify(payload);
 const port=await controllerFixture(t,(req,res)=>{
  assert.equal(req.method,'PUT');assert.equal(req.url,'/configs?force=true');assert.equal(req.headers.authorization,'Bearer secret');
  assert.equal(req.headers['content-type'],'application/json');assert.equal(Number(req.headers['content-length']),Buffer.byteLength(encoded));
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{assert.equal(body,encoded);res.writeHead(204);res.end();});
 });
 assert.deepEqual(await controllerRequest(port,'secret','PUT','/configs?force=true',payload),{status:204,body:''});
});

test('controller pre-abort normalizes native cancellation and makes no request',async t=>{
 let requests=0;
 const port=await controllerFixture(t,(req,res)=>{requests++;res.end('{}');}),caller=new AbortController();caller.abort();
 await assert.rejects(controllerRequest(port,'secret','GET','/version',undefined,{signal:caller.signal}),{code:'CANCELLED'});
 assert.equal(requests,0);assert.equal(getEventListeners(caller.signal,'abort').length,0);
});

test('controller caller cancellation preserves its reason and detaches its listener',async t=>{
 const entered=new EventEmitter(),caller=new AbortController(),reason=fault('CANCELLED');
 const port=await controllerFixture(t,(req,res)=>{entered.emit('request');setTimeout(()=>res.end('{}'),100);});
 const requested=once(entered,'request'),request=controllerRequest(port,'secret','GET','/version',undefined,{signal:caller.signal});
 await requested;caller.abort(reason);
 await assert.rejects(request,error=>error===reason);
 assert.equal(getEventListeners(caller.signal,'abort').length,0);
});

test('controller deadline bounds a stalled response',async t=>{
 const port=await controllerFixture(t,(req,res)=>{setTimeout(()=>res.end('{}'),100);});
 await assert.rejects(controllerRequest(port,'secret','GET','/version',undefined,{timeout:10}),{code:'DEADLINE'});
});

test('controller response cap has a stable bounded-response error code',async t=>{
 const port=await controllerFixture(t,(req,res)=>res.end(Buffer.alloc(131073)));
 await assert.rejects(controllerRequest(port,'secret','GET','/version'),{code:'CONTROLLER_RESPONSE_LIMIT'});
});
