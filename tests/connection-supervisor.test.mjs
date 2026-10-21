import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {abortable,fault} from '../src/async-control.mjs';
import {attemptConnection} from '../src/connection-attempt.mjs';
const module = await import('../src/connection-supervisor.mjs').catch(error => {
 if(error.code==='ERR_MODULE_NOT_FOUND') return {};
 throw error;
});
const {supervise,POLICY}=module;
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await nextTurn();}assert.fail('expected progress did not occur');}
function fixture(){
 const root=new AbortController(),events=[],calls=[],waits=[],heartbeats=[],connections=[];
 const report={requestedPort:10808,mode:'proxy'};
 let active=0,maxActive=0;
 const makeConnection=(id,overrides={})=>{
  active++;maxActive=Math.max(maxActive,active);const exited=deferred();let closed=false;
  const connection={port:10808+connections.length,health:{tunnelVerified:true},closed:exited.promise,
   async ping(){},async close(){if(!closed){closed=true;active--;events.push(['close',id]);}return {engine:{processStopped:true}};},...overrides,exit:exited.resolve};
  connections.push(connection);return connection;
 };
 const options={signal:root.signal,report,loadCandidates:async()=>[{id:'a',country:'A'},{id:'b',country:'B'}],
  attempt:async(candidate,options)=>{calls.push([candidate.id,options]);return makeConnection(candidate.id);},
  emit:(type,data)=>events.push([type,data]),random:()=>0,
  sleep:(ms,signal)=>{waits.push(ms);if(ms===45000){const gate=deferred();heartbeats.push(gate);return abortable(gate.promise,signal);}return abortable(Promise.resolve(),signal);}};
 const start=()=>{assert.equal(typeof supervise,'function','supervise must be exported');const pending=supervise(options);pending.catch(()=>{});return pending;};
 return {root,events,calls,waits,heartbeats,connections,report,options,makeConnection,start,get active(){return active;},get maxActive(){return maxActive;},stop(){root.abort(fault('CANCELLED'));}};
}
const connected=f=>f.events.filter(([type,data])=>type==='state'&&data.stage==='connected');
async function stop(f,pending){f.stop();await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.active,0);}

test('exports the fixed frozen supervisor policy',()=>{
 assert.deepEqual(POLICY,{initialMs:120000,recoveryMs:120000,attemptMs:30000,keepaliveMs:45000,retryMs:1000,retryProbeMs:5000,backoffMs:[1000,3000,7000]});
 assert(Object.isFrozen(POLICY));assert(Object.isFrozen(POLICY.backoffMs));
});

test('real attempts reject authenticated data failure and release engine before candidate two starts',async()=>{
 const f=fixture(),ownership=[];let engines=0,max=0;
 f.options.attempt=(candidate,options)=>attemptConnection(candidate,{...options,mode:'proxy',requestedPort:10808},{now:()=>0,
  authenticate:async()=>({server:'fake.invalid'}),lookup:async()=>({address:'203.0.113.9'}),choosePort:async()=>10808,
  startEngine:async()=>{assert.equal(engines,0);engines++;max=Math.max(max,engines);ownership.push(`start:${candidate.id}`);const closed=deferred();return {closed:closed.promise,isStopped:()=>false,stop:async()=>{engines--;ownership.push(`stop:${candidate.id}`);closed.resolve();return {processStopped:true};}};},
  verifyTraffic:async()=>{if(candidate.id==='a')throw fault('TRAFFIC_PROBE_FAILED');return {tunnelVerified:true};},
  disconnect:async()=>({status:200,body:'1'}),pingSession:async()=>{}});
 const pending=f.start();await until(()=>connected(f).length===1);f.stop();await assert.rejects(pending,{code:'CANCELLED'});
 assert.equal(f.report.attempts[0].authenticated,true);assert.equal(f.report.attempts[0].failedStage,'verifying');assert.equal(f.report.attempts[1].id,'b');
 assert.deepEqual(ownership,['start:a','stop:a','start:b','stop:b']);assert.equal(max,1);assert.equal(engines,0);
});

test('engine exit closes old owner before recovery, puts last id last, and ignores old exits',async()=>{
 const f=fixture(),pending=f.start();await until(()=>f.heartbeats.length===1);const old=f.connections[0];old.exit();
 await until(()=>connected(f).length===2);assert.deepEqual(f.calls.map(([id])=>id),['a','b']);assert.equal(f.report.recoveries,1);
 assert.equal(f.maxActive,1);assert(f.events.findIndex(e=>e[0]==='close')<f.events.findIndex(e=>e[1]?.round===1&&e[1]?.stage==='reconnecting'));
 old.exit();await nextTurn();assert.equal(connected(f).length,2);await stop(f,pending);
});

test('temporary heartbeat failure retries once with timeout on the same engine',async()=>{
 const f=fixture(),pings=[];f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);return f.makeConnection(c.id,{ping:async options=>{pings.push(options);if(pings.length===1)throw fault('TEMPORARY');}});};
 const pending=f.start();await until(()=>f.heartbeats.length===1);f.heartbeats[0].resolve();await until(()=>f.report.keepaliveAccepted===1);
 assert.equal(pings.length,2);assert.equal(pings[1].timeout,5000);assert.equal(f.calls.length,1);assert(f.waits.includes(1000));await stop(f,pending);
});

for(const rejection of ['SESSION_REJECTED','TEMPORARY'])test(`${rejection} failed heartbeat creates a fresh recovery attempt`,async()=>{
 const f=fixture();let pings=0;f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);return f.makeConnection(c.id,{ping:async()=>{pings++;throw fault(rejection);}});};
 const pending=f.start();await until(()=>f.heartbeats.length===1);f.heartbeats[0].resolve();await until(()=>connected(f).length===2);
 assert.equal(pings,rejection==='SESSION_REJECTED'?1:2);assert.equal(f.maxActive,1);assert.equal(f.report.recoveries,1);await stop(f,pending);
});

test('three recovery rounds exhaust with 1/3/7 second backoffs and positive bounded jitter',async()=>{
 const f=fixture();f.options.random=()=>0.5;f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);if(f.calls.length>1)throw fault('AUTH_FAILED');return f.makeConnection(c.id);};
 const pending=f.start();await until(()=>f.heartbeats.length===1);f.connections[0].exit();await assert.rejects(pending,{code:'RECOVERY_EXHAUSTED'});
 assert.deepEqual(f.waits.filter(ms=>ms!==45000),[1100,3300,7700]);assert.equal(f.calls.length,7);assert.equal(f.active,0);
 assert.deepEqual(f.report.attempts.map(r=>r.round),[0,1,1,2,2,3,3]);
});

for(const source of ['attempt','close'])test(`CLEANUP_FAILED from ${source} is terminal before any new engine`,async()=>{
 const f=fixture();f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);if(source==='attempt')throw fault('CLEANUP_FAILED');return f.makeConnection(c.id,{close:async()=>{throw fault('CLEANUP_FAILED');}});};
 const pending=f.start();if(source==='close'){await until(()=>f.heartbeats.length===1);f.connections[0].exit();}
 await assert.rejects(pending,{code:'CLEANUP_FAILED'});assert.equal(f.calls.length,1);
});

test('cancelling recovery backoff prevents the next attempt',async()=>{
 const f=fixture(),backoff=deferred();f.options.sleep=(ms,signal)=>{f.waits.push(ms);return abortable(backoff.promise,signal);};
 const pending=f.start();await until(()=>connected(f).length===1);f.connections[0].exit();await until(()=>f.waits.includes(1000));await stop(f,pending);assert.equal(f.calls.length,1);
});

test('initial deadline covers uncooperative candidate loading and forwards its signal',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=fixture();let loadSignal;f.options.loadCandidates=signal=>{loadSignal=signal;return new Promise(()=>{});};
 const pending=f.start();await nextTurn();t.mock.timers.tick(120000);await assert.rejects(pending,{code:'DEADLINE'});
 assert.equal(loadSignal.aborted,true);assert.equal(f.calls.length,0);assert.equal(f.events.at(-1)[1].stage,'stopping');
});

test('initial deadline cancellation remains latched after owned late attempt settles',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=fixture(),late=deferred();f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);return late.promise;};
 const pending=f.start();await until(()=>f.calls.length===1);t.mock.timers.tick(120000);late.resolve(f.makeConnection('late'));
 await assert.rejects(pending,{code:'DEADLINE'});assert.equal(f.active,0);assert.equal(f.calls.length,1);assert.equal(connected(f).length,0);
});

test('recovery deadline includes old engine cleanup and blocks further attempts',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=fixture(),release=deferred();let closing=false;
 f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);const connection=f.makeConnection(c.id);const close=connection.close;connection.close=async()=>{closing=true;await release.promise;return close();};return connection;};
 const pending=f.start();await until(()=>f.heartbeats.length===1);f.connections[0].exit();await until(()=>closing);t.mock.timers.tick(120000);release.resolve();
 await assert.rejects(pending,{code:'DEADLINE'});assert.equal(f.calls.length,1);assert.equal(f.active,0);
});

test('stable id deduplication caps initial candidates at six',async()=>{
 const f=fixture();f.options.loadCandidates=async()=>[{id:'a'},{id:'a'},...Array.from({length:8},(_,i)=>({id:String(i)}))];
 f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);throw fault('AUTH_FAILED');};await assert.rejects(f.start(),{code:'NO_AVAILABLE_SERVER'});
 assert.deepEqual(f.calls.map(([id])=>id),['a','0','1','2','3','4']);
});

test('late 30 second attempt success is closed before the next candidate starts',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=fixture(),late=deferred(),release=deferred();let closing=false;
 f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);if(c.id==='a')return late.promise;assert.equal(f.active,0);return f.makeConnection(c.id);};
 const pending=f.start();await until(()=>f.calls.length===1);t.mock.timers.tick(30000);const lateConnection=f.makeConnection('a');const close=lateConnection.close;
 lateConnection.close=async()=>{closing=true;await release.promise;return close();};late.resolve(lateConnection);await until(()=>closing);assert.equal(f.calls.length,1);release.resolve();
 await until(()=>connected(f).length===1);assert.equal(f.calls.length,2);assert.equal(f.maxActive,1);assert.equal(f.report.attempts[0].errorCode,'DEADLINE');await stop(f,pending);
});

for(const stage of ['connected','stopping','verifying'])test(`${stage} callback failure is terminal and still releases ownership`,async()=>{
 const f=fixture(),callbackError=new Error('observer failed');f.options.emit=(type,data)=>{f.events.push([type,data]);if(data.stage===stage)throw callbackError;};
 f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);if(stage==='verifying'){o.onStage('verifying');}return f.makeConnection(c.id);};
 const pending=f.start();if(stage==='stopping'){await until(()=>connected(f).length===1);f.stop();}
 await assert.rejects(pending,error=>error===callbackError);assert.equal(f.calls.length,1);assert.equal(f.active,0);
});

test('settled and aborted attempt callbacks cannot emit or update previous port',async()=>{
 const f=fixture(),pending=f.start();await until(()=>f.heartbeats.length===1);const options=f.calls[0][1],count=f.events.length;
 options.onStage('verifying');options.onPort(19999);assert.equal(f.events.length,count);assert.equal(f.report.proxy.actualPort,10808);
 f.stop();options.onStage('preparing');options.onPort(29999);await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.report.proxy.actualPort,10808);
});

test('port selection reports previous actual port and connected report retains health',async()=>{
 const f=fixture();f.report.proxy={actualPort:10812};f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);o.onStage('authenticating');o.onPort(10813);return f.makeConnection(c.id,{port:10813});};
 const pending=f.start();await until(()=>connected(f).length===1);assert.deepEqual(f.events.find(([,data])=>data?.stage==='port-selected')[1],{stage:'port-selected',port:10813,previousPort:10812,changed:true});
 assert.deepEqual(f.report.proxy,{requestedPort:10808,actualPort:10813,automaticallyChanged:true});assert.equal(f.report.authenticated,true);assert.equal(f.report.tunnelVerified,true);await stop(f,pending);
});

test('SESSION_REJECTED during the retry preserves its immediate recovery reason',async()=>{
 const f=fixture();let pings=0;f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);return f.makeConnection(c.id,{ping:async()=>{pings++;throw fault(pings===1?'TEMPORARY':'SESSION_REJECTED');}});};
 const pending=f.start();await until(()=>f.heartbeats.length===1);f.heartbeats[0].resolve();await until(()=>connected(f).length===2);
 assert.equal(f.events.find(([,data])=>data?.stage==='reconnecting')[1].reason,'SESSION_REJECTED');await stop(f,pending);
});

test('connected report setter failure is terminal after releasing the adopted connection',async()=>{
 const f=fixture(),error=new Error('report failed');Object.defineProperty(f.report,'authenticated',{set(){throw error;}});
 const pending=f.start();await assert.rejects(pending,value=>value===error);assert.equal(f.calls.length,1);assert.equal(f.active,0);
});

test('engine exit cancels and joins its in-flight heartbeat before starting recovery',async()=>{
 const f=fixture(),pingEntered=deferred(),pingReleased=deferred();let pingSignal,livePing=false;
 f.options.attempt=async(c,o)=>{assert.equal(livePing,false);f.calls.push([c.id,o]);return f.makeConnection(c.id,{ping:async({signal})=>{
  livePing=true;pingSignal=signal;pingEntered.resolve();try{await abortable(new Promise(()=>{}),signal);}finally{await pingReleased.promise;livePing=false;}
 }});};
 const pending=f.start();await until(()=>f.heartbeats.length===1);f.heartbeats[0].resolve();await pingEntered.promise;f.connections[0].exit();
 await until(()=>pingSignal.aborted);assert.equal(f.calls.length,1);pingReleased.resolve();await until(()=>connected(f).length===2);assert.equal(f.report.keepaliveAccepted,0);await stop(f,pending);
});

test('callbacks from a cancelled unsettled attempt are filtered before its cleanup settles',async()=>{
 const f=fixture(),late=deferred();f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);return late.promise;};
 const pending=f.start();await until(()=>f.calls.length===1);f.stop();const before=f.events.length;
 f.calls[0][1].onPort(39999);f.calls[0][1].onStage('verifying');assert.equal(f.events.length,before);
 late.resolve(f.makeConnection('late'));await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.active,0);assert.equal(f.report.proxy,undefined);
});

test('unconfirmed cleanup of a late connection overrides deadline and prevents another candidate',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=fixture(),late=deferred();f.options.attempt=async(c,o)=>{f.calls.push([c.id,o]);return late.promise;};
 const pending=f.start();await until(()=>f.calls.length===1);t.mock.timers.tick(30000);late.resolve(f.makeConnection('late',{close:async()=>{throw fault('CLEANUP_FAILED');}}));
 await assert.rejects(pending,{code:'CLEANUP_FAILED'});assert.equal(f.calls.length,1);
});

for(const retry of [false,true])test(`accepted keepalive report failure after ${retry?'retry':'first'} success is terminal without extra I/O`,async()=>{
 const f=fixture(),error=new Error('accepted counter failed');let accepted=0,pings=0,closeCalls=0,settled=false,rejection;
 Object.defineProperty(f.report,'keepaliveAccepted',{get:()=>accepted,set(value){if(value>0)throw error;accepted=value;}});
 f.options.attempt=async(c,o)=>{
  f.calls.push([c.id,o]);const connection=f.makeConnection(c.id,{ping:async()=>{pings++;if(retry&&pings===1)throw fault('TEMPORARY');}});
  const close=connection.close;connection.close=async()=>{closeCalls++;return close();};return connection;
 };
 const pending=f.start();pending.then(()=>{settled=true;},value=>{settled=true;rejection=value;});
 try{
  await until(()=>f.heartbeats.length===1);f.heartbeats[0].resolve();await until(()=>settled||connected(f).length===2);
  assert.equal(settled,true,'a report failure must stop the supervisor');assert.equal(rejection,error);
  assert.equal(pings,retry?2:1);assert.equal(f.calls.length,1);assert.equal(f.report.recoveries,0);
  assert.equal(f.waits.filter(ms=>ms===1000).length,retry?1:0);assert.equal(closeCalls,1);assert.equal(f.active,0);
 }finally{if(!settled){f.stop();await pending.catch(()=>{});}}
});
