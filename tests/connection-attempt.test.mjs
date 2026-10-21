import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {abortable,fault} from '../src/async-control.mjs';
import {compareNetwork} from '../src/windows-network.mjs';

import {attemptConnection as attempt} from '../src/connection-attempt.mjs';
const snapshot = () => ({routes:[],dns:[],adapters:[]});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(){
 const events=[],record={},caller=new AbortController(),closed=deferred();
 let alive=false,authenticated=false,stopped=false,tick=100;
 const session={server:'fixture.invalid',token:'private-token',uuid:'private-uuid'};
 const core={closed:closed.promise,isStopped:()=>stopped,async stop(){events.push('stop');alive=false;stopped=true;closed.resolve({code:0});return {processStopped:true,runtimeRemoved:true};}};
 const deps={now:()=>tick++,async authenticate(){events.push('authenticate');authenticated=true;return session;},async lookup(){events.push('lookup');return {address:'203.0.113.7',family:4};},async choosePort(port){events.push('choosePort');return port;},async startEngine(){events.push('start');alive=true;return core;},async verifyTraffic(){events.push('verify');return {tunnelVerified:true};},async pingSession(value,options){return {value,options};},async disconnect(value,engine,signal){events.push('disconnect');assert.equal(value,session);assert.equal(engine,core);assert.equal(signal.aborted,false);authenticated=false;return {status:200,body:'1'};},async captureNetwork(){events.push('snapshot');return snapshot();},compareNetwork};
 const options={signal:caller.signal,mode:'proxy',requestedPort:10808,record,onStage:stage=>events.push(stage),onPort:port=>events.push(`port:${port}`)};
 return {events,record,caller,session,core,deps,options,get alive(){return alive;},get authenticated(){return authenticated;},set stopped(value){stopped=value;}};
}

// Every dependency is local and injected; the resource flags expose leaked ownership.
test('failed data verification disconnects its authenticated session then stops its engine before rejecting',async()=>{
 const f=fixture(),probe=fault('TRAFFIC_PROBE_FAILED');f.deps.verifyTraffic=async()=>{throw probe;};
 await assert.rejects(attempt({},f.options,f.deps),error=>error===probe);
 assert.equal(f.authenticated,false);assert.equal(f.alive,false);
 assert.deepEqual(f.events.slice(-2),['disconnect','stop']);
 assert.equal(f.record.authenticated,true);assert.equal(f.record.failedStage,'verifying');
 assert.equal(f.record.errorCode,'TRAFFIC_PROBE_FAILED');assert.equal(typeof f.record.durationMs,'number');
 assert.equal(f.record.cleanup.disconnectAccepted,true);assert.equal(f.record.cleanup.engine.processStopped,true);
 assert(!JSON.stringify(f.record).includes('private-'));
});

test('success retains the selected port and one cached close promise',async()=>{
 const f=fixture();f.deps.choosePort=async()=>10812;
 const result=await attempt({},f.options,f.deps);
 assert.equal(f.session.serverIp,'203.0.113.7');assert.equal(result.session,f.session);assert.equal(result.port,10812);
 assert.equal(result.closed,f.core.closed);assert.equal(result.health.tunnelVerified,true);
 assert.equal(f.record.port,10812);assert.equal(f.record.dataVerified,true);assert.equal(f.alive,true);
 assert.deepEqual(f.events.filter(x=>['authenticating','preparing','verifying'].includes(x)),['authenticating','preparing','verifying']);
 const pingOptions={signal:new AbortController().signal};assert.deepEqual(await result.ping(pingOptions),{value:{session:f.session,port:10812},options:pingOptions});
 f.caller.abort(fault('CANCELLED'));
 const closing=result.close();assert.equal(result.close(),closing);await closing;
 assert.equal(f.events.filter(x=>x==='disconnect').length,1);assert.equal(f.events.filter(x=>x==='stop').length,1);
 assert.equal(f.record.port,10812);assert.equal(f.alive,false);
});

test('late DNS completion after cancellation never starts an engine',async()=>{
 const f=fixture(),dns=deferred(),entered=deferred();
 f.deps.lookup=()=>{entered.resolve();return dns.promise;};
 f.deps.disconnect=async(session,core,signal)=>{assert.equal(core,undefined);assert.equal(signal.aborted,false);f.events.push('disconnect');return {status:200,body:'1'};};
 const pending=attempt({},f.options,f.deps);await entered.promise;f.caller.abort(fault('CANCELLED'));
 await assert.rejects(pending,{code:'CANCELLED'});dns.resolve({address:'203.0.113.8',family:4});await nextTurn();
 assert(!f.events.includes('start'));assert.equal(f.record.failedStage,'preparing');assert.equal(f.record.cleanup.disconnectAccepted,true);
});

test('late authenticated sessions are still disconnected after cancellation',async()=>{
 const f=fixture(),auth=deferred(),entered=deferred();
 f.deps.authenticate=()=>{entered.resolve();return auth.promise;};
 f.deps.disconnect=async(session,core,signal)=>{assert.equal(session,f.session);assert.equal(core,undefined);assert.equal(signal.aborted,false);f.events.push('disconnect');return {status:200,body:'1'};};
 const pending=attempt({},f.options,f.deps);await entered.promise;f.caller.abort(fault('CANCELLED'));auth.resolve(f.session);
 await assert.rejects(pending,{code:'CANCELLED'});assert.deepEqual(f.events,['authenticating','disconnect']);assert.equal(f.record.authenticated,true);
});

test('cancelled startup waits for the engine owner to release its partial resource',async()=>{
 const f=fixture(),entered=deferred(),release=deferred();let partial=false;
 f.deps.startEngine=async(session,{signal})=>{partial=true;entered.resolve();try{await abortable(new Promise(()=>{}),signal);}finally{await release.promise;partial=false;}};
 f.deps.disconnect=async(session,core,signal)=>{assert.equal(core,undefined);assert.equal(partial,false);f.events.push('disconnect');return {status:200,body:'1'};};
 const pending=attempt({},f.options,f.deps);await entered.promise;f.caller.abort(fault('CANCELLED'));
 let settled=false;pending.catch(()=>{settled=true;});await nextTurn();assert.equal(settled,false);assert.equal(partial,true);
 release.resolve();await assert.rejects(pending,{code:'CANCELLED'});assert.equal(partial,false);assert.equal(f.record.failedStage,'preparing');
});

test('cancellation during verification cleans the live engine and session',async()=>{
 const f=fixture(),entered=deferred();f.deps.verifyTraffic=()=>{entered.resolve();return new Promise(()=>{});};
 const pending=attempt({},f.options,f.deps);await entered.promise;assert.equal(f.alive,true);f.caller.abort(fault('CANCELLED'));
 await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.alive,false);assert.equal(f.authenticated,false);
});

for(const health of [undefined,{}, {tunnelVerified:false},{tunnelVerified:'true'}])test(`unconfirmed health ${JSON.stringify(health)} cannot succeed`,async()=>{
 const f=fixture();f.deps.verifyTraffic=async()=>health;
 await assert.rejects(attempt({},f.options,f.deps),{code:'TRAFFIC_PROBE_FAILED'});assert.equal(f.alive,false);assert.notEqual(f.record.dataVerified,true);
});

test('an exited engine cannot become a healthy result',async()=>{
 const f=fixture();f.deps.verifyTraffic=async()=>{f.stopped=true;return {tunnelVerified:true};};
 await assert.rejects(attempt({},f.options,f.deps),{code:'ENGINE_EXIT'});assert.equal(f.alive,false);
});

test('bind conflicts retry selected ports with exclusion only after startup resources have closed',async()=>{
 const f=fixture(),choices=[],starts=[];let startupActive=false;
 f.deps.choosePort=async(port,{exclude})=>{assert.equal(startupActive,false);choices.push({port,exclude:[...exclude]});return 10808+exclude.length;};
 f.deps.startEngine=async(session,{port})=>{assert.equal(startupActive,false);startupActive=true;starts.push(port);await nextTurn();startupActive=false;if(starts.length<3)throw fault('PROXY_BIND_CONFLICT');return f.core;};
 const result=await attempt({},f.options,f.deps);await result.close();
 assert.deepEqual(starts,[10808,10809,10810]);assert.deepEqual(choices,[{port:10808,exclude:[]},{port:10808,exclude:[10808]},{port:10808,exclude:[10808,10809]}]);
 assert.equal(f.record.port,10810);assert(f.events.includes('port:10810'));
});

test('bind conflict attempts are capped at four',async()=>{
 const f=fixture();let starts=0;f.deps.choosePort=async(port,{exclude})=>port+exclude.length;
 f.deps.startEngine=async()=>{starts++;throw fault('PROXY_BIND_CONFLICT');};f.deps.disconnect=async()=>({status:200,body:'1'});
 await assert.rejects(attempt({},f.options,f.deps),{code:'PROXY_BIND_CONFLICT'});assert.equal(starts,4);
});

test('non-bind startup failure never retries',async()=>{
 const f=fixture();let starts=0;f.deps.startEngine=async()=>{starts++;throw fault('ENGINE_FAILED');};f.deps.disconnect=async()=>({status:200,body:'1'});
 await assert.rejects(attempt({},f.options,f.deps),{code:'ENGINE_FAILED'});assert.equal(starts,1);
});

test('full mode captures baseline before engine and checks restoration after stop',async()=>{
 const f=fixture();f.options.mode='full';const result=await attempt({},f.options,f.deps);await result.close();
 assert(f.events.indexOf('snapshot')<f.events.indexOf('start'));assert.deepEqual(f.events.slice(-3),['disconnect','stop','snapshot']);
 assert.equal(f.record.cleanup.network.verified,true);
});

test('unverified full-mode restoration overrides the data failure and preserves classification',async()=>{
 const f=fixture();f.options.mode='full';f.deps.verifyTraffic=async()=>{throw fault('TRAFFIC_PROBE_FAILED');};
 f.deps.compareNetwork=()=>({verified:false,classification:'unexplained-network-change'});
 await assert.rejects(attempt({},f.options,f.deps),{code:'CLEANUP_FAILED'});
 assert.equal(f.record.cleanup.network.classification,'unexplained-network-change');assert.equal(f.record.cleanupError,'CLEANUP_FAILED');assert.equal(f.record.errorCode,'TRAFFIC_PROBE_FAILED');assert.equal(f.alive,false);
});

for(const kind of ['throw','malformed','adapter'])test(`full baseline ${kind} prevents any engine and is terminal`,async()=>{
 const f=fixture();f.options.mode='full';f.deps.disconnect=async()=>{f.events.push('disconnect');return {status:200,body:'1'};};
 f.deps.captureNetwork=async()=>{if(kind==='throw')throw fault('NETWORK_SNAPSHOT_FAILED','private routes');if(kind==='malformed')return {};return {...snapshot(),adapters:[{Name:'ArgoDesktop',InterfaceIndex:3}]};};
 await assert.rejects(attempt({},f.options,f.deps),{code:'CLEANUP_FAILED'});assert(!f.events.includes('start'));assert(f.events.includes('disconnect'));
 assert.equal(f.record.cleanupError,'CLEANUP_FAILED');assert(!JSON.stringify(f.record).includes('private'));
});

test('post-stop snapshot failure is terminal and diagnostic code is retained safely',async()=>{
 const f=fixture();f.options.mode='full';let captures=0;f.deps.captureNetwork=async()=>{if(captures++)throw fault('NETWORK_SNAPSHOT_FAILED','private DNS');return snapshot();};
 const result=await attempt({},f.options,f.deps);await assert.rejects(result.close(),{code:'CLEANUP_FAILED'});
 assert.equal(f.record.cleanup.engine.processStopped,true);assert.equal(f.record.cleanup.networkError,'NETWORK_SNAPSHOT_FAILED');assert.equal(f.record.cleanupError,'CLEANUP_FAILED');assert(!JSON.stringify(f.record).includes('private'));
});

test('an uncooperative disconnect is bounded and cannot prevent engine closure',async()=>{
 const f=fixture();f.deps.disconnect=()=>new Promise(()=>{});const result=await attempt({},f.options,f.deps);const began=Date.now();
 await result.close();assert(Date.now()-began<2800);assert.equal(f.alive,false);assert.equal(f.record.cleanup.disconnectAccepted,false);assert.equal(f.record.cleanup.disconnectError,'DEADLINE');
});

for(const response of [{status:200,body:'12'},{status:500,body:'1'},{status:204,body:''}])test(`disconnect acknowledgement requires 2xx and odd body length: ${JSON.stringify(response)}`,async()=>{
 const f=fixture();f.deps.disconnect=async()=>response;const result=await attempt({},f.options,f.deps);await result.close();assert.equal(f.record.cleanup.disconnectAccepted,false);assert.equal(f.alive,false);
});

test('unconfirmed process closure is terminal and retains its partial stop result',async()=>{
 const f=fixture();f.core.stop=async()=>({processStopped:false,runtimeRemoved:false});const result=await attempt({},f.options,f.deps);
 await assert.rejects(result.close(),{code:'CLEANUP_FAILED'});assert.deepEqual(f.record.cleanup.engine,{processStopped:false,runtimeRemoved:false});assert.equal(f.record.cleanupError,'CLEANUP_FAILED');
});

test('a remaining valid Argo adapter retains the comparator classification',async()=>{
 const f=fixture();f.options.mode='full';let captures=0;
 f.deps.captureNetwork=async()=>captures++?{...snapshot(),adapters:[{Name:'ArgoDesktop',InterfaceIndex:7}]}:snapshot();
 const result=await attempt({},f.options,f.deps);await assert.rejects(result.close(),{code:'CLEANUP_FAILED'});
 assert.equal(f.record.cleanup.network.classification,'unexplained-network-change');assert.equal(f.record.cleanup.network.adapterAbsent,false);
});

test('startup cleanup failure remains terminal even when startup was cancelled',async()=>{
 const f=fixture();f.deps.startEngine=async()=>{f.caller.abort(fault('CANCELLED'));throw fault('CLEANUP_FAILED');};f.deps.disconnect=async()=>({status:200,body:'1'});
 await assert.rejects(attempt({},f.options,f.deps),{code:'CLEANUP_FAILED'});assert.equal(f.record.errorCode,'CLEANUP_FAILED');
 assert.equal(f.record.cleanupError,'CLEANUP_FAILED');
 assert.deepEqual(f.record.cleanup,{engineError:'CLEANUP_FAILED',disconnectAccepted:true});
});

test('cancellation in the initial stage callback prevents authentication',async()=>{
 const f=fixture();f.options.onStage=()=>f.caller.abort(fault('CANCELLED'));
 await assert.rejects(attempt({},f.options,f.deps),{code:'CANCELLED'});assert(!f.events.includes('authenticate'));
});

test('cancellation in preparing callback prevents DNS lookup',async()=>{
 const f=fixture();f.options.onStage=stage=>{if(stage==='preparing')f.caller.abort(fault('CANCELLED'));};f.deps.disconnect=async()=>({status:200,body:'1'});
 await assert.rejects(attempt({},f.options,f.deps),{code:'CANCELLED'});assert(!f.events.includes('lookup'));
});
