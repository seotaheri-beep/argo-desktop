import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {EventEmitter,getEventListeners,once} from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import test from 'node:test';
import {authenticate,loadConfig,request,serversFrom,sessionRequest} from '../src/prototype.mjs';
import {socksConnect,tunnelRequest} from '../src/proxy.mjs';
import {fault} from '../src/async-control.mjs';

function within(promise,milliseconds=1500){
 let timer;
 return Promise.race([promise,new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(new Error('Operation did not settle promptly')),milliseconds);
 })]).finally(()=>clearTimeout(timer));
}

// Replace only the transport boundary: configuration and authentication still execute normally.
function fakeHttps(t,onEnd=()=>{}){
 const calls=[];
 t.mock.method(https,'request',(options,onResponse)=>{
  const req=new EventEmitter();
  let destroyed=false;
  const onAbort=()=>req.destroy(Object.assign(new Error('Node transport aborted'),{code:'ABORT_ERR'}));
  req.destroy=error=>{
   if(destroyed)return req;
   destroyed=true;
   options.signal?.removeEventListener('abort',onAbort);
   queueMicrotask(()=>{if(error)req.emit('error',error);req.emit('close');});
   return req;
  };
  req.end=()=>onEnd({options,req,respond(status=200,body='',headers={}){
   const res=new EventEmitter();
   Object.assign(res,{statusCode:status,headers,socket:{remoteAddress:'203.0.113.8'}});
   onResponse(res);
   res.emit('data',Buffer.from(body));res.emit('end');
   req.destroy();
  }});
  options.signal?.addEventListener('abort',onAbort,{once:true});
  calls.push({options,req});
  return req;
 });
 t.after(()=>{for(const {req} of calls)req.destroy();});
 return calls;
}

async function fixture(t,onConnection){
 const sockets=new Set(),closed=new EventEmitter();
 let accepted=0;
 const server=net.createServer(socket=>{
  accepted++;sockets.add(socket);
  socket.on('error',()=>{});
  socket.once('close',()=>{sockets.delete(socket);if(!sockets.size)closed.emit('empty');});
  onConnection(socket);
 });
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(async()=>{
  for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>server.close(resolve));
 });
 return {port:server.address().port,sockets,get accepted(){return accepted;},
  allClosed:()=>sockets.size?once(closed,'empty'):Promise.resolve()};
}

function socksFixture(onReady,{reply=Buffer.from([5,0,0,1,127,0,0,1,0,0])}={}){
 return socket=>{
  let buffered=Buffer.alloc(0),stage='greeting';
  socket.on('data',chunk=>{
   buffered=Buffer.concat([buffered,chunk]);
   if(stage==='greeting'&&buffered.length>=3){
    assert.deepEqual(buffered.subarray(0,3),Buffer.from([5,1,0]));
    buffered=buffered.subarray(3);stage='connect';socket.write(Buffer.from([5,0]));
   }
   if(stage==='connect'&&buffered.length>=5&&buffered.length>=7+buffered[4]){
    const length=7+buffered[4],message=buffered.subarray(0,length);
    buffered=buffered.subarray(length);stage='tunnel';socket.write(reply);
    onReady?.({socket,message});
   }
  });
 };
}

test('an already-aborted HTTPS request never reaches the transport',async t=>{
 const calls=fakeHttps(t),controller=new AbortController(),reason=fault('CANCELLED');
 controller.abort(reason);
 await assert.rejects(within(request('https://remote.invalid/',{signal:controller.signal})),error=>error===reason);
 assert.equal(calls.length,0);
});

test('direct requests require HTTPS before reaching the transport',async t=>{
 const calls=fakeHttps(t);
 await assert.rejects(request('http://remote.invalid/'),error=>error.code==='HTTPS_REQUIRED');
 assert.equal(calls.length,0);
});

test('direct HTTPS preserves Host and SNI with an IP override and releases its parent listener',async t=>{
 const controller=new AbortController();
 const calls=fakeHttps(t,({respond})=>respond(204,'fixture',{'content-type':'text/plain'}));
 const result=await request('https://service.invalid:8443/path?q=1',{ip:'203.0.113.7',signal:controller.signal});
 assert.equal(result.status,204);assert.equal(result.body,'fixture');
 assert.equal(result.remoteAddress,'203.0.113.8');
 assert.equal(calls[0].options.hostname,'203.0.113.7');
 assert.equal(calls[0].options.servername,'service.invalid');
 assert.equal(calls[0].options.headers.Host,'service.invalid:8443');
 assert.equal(calls[0].options.path,'/path?q=1');
 assert.equal(calls[0].options.headers['User-Agent'],'ArgoDesktop/0.3.0');
 assert.equal(calls[0].options.agent,false);
 assert(calls[0].options.signal instanceof AbortSignal);
 assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('direct HTTPS deadlines normalize the transport AbortError to DEADLINE',async t=>{
 fakeHttps(t);
 await assert.rejects(within(request('https://remote.invalid/',{timeout:10})),error=>error.code==='DEADLINE');
});

test('active HTTPS cancellation rejects even when the parent reason is false',async t=>{
 fakeHttps(t);
 const controller=new AbortController();
 const pending=request('https://remote.invalid/',{signal:controller.signal});
 controller.abort(false);
 await assert.rejects(within(pending),error=>error===false);
});

test('direct HTTPS refuses a response above its configured byte limit',async t=>{
 fakeHttps(t,({respond})=>respond(200,'oversized'));
 await assert.rejects(request('https://remote.invalid/',{maxBytes:3}),error=>error.code==='RESPONSE_TOO_LARGE');
});

test('configuration cancellation reaches the active HTTPS request and stops URL fallback',async t=>{
 const calls=fakeHttps(t),controller=new AbortController(),reason=fault('CANCELLED');
 const pending=loadConfig(undefined,{signal:controller.signal});
 pending.catch(()=>{});
 assert.equal(calls.length,1);
 assert(calls[0].options.signal instanceof AbortSignal);
 controller.abort(reason);
 await assert.rejects(within(pending),error=>error===reason);
 assert.equal(calls[0].options.signal.aborted,true);
 assert.equal(calls.length,1);
});

test('configuration cancellation precedes synchronous signed-cache reads',async t=>{
 let reads=0;
 t.mock.method(fs,'readFileSync',()=>{reads++;throw new Error('Cache should not be read');});
 const controller=new AbortController(),reason=fault('CANCELLED');controller.abort(reason);
 await assert.rejects(loadConfig('fixture-cache',{signal:controller.signal}),error=>error===reason);
 assert.equal(reads,0);
});

test('ordinary configuration failures try all four sources and finish with CONFIG_UNAVAILABLE',async t=>{
 const calls=fakeHttps(t,({respond})=>queueMicrotask(()=>respond(503,'unavailable')));
 await assert.rejects(loadConfig(),error=>error.code==='CONFIG_UNAVAILABLE');
 assert.deepEqual(calls.map(({options})=>options.servername),[
  'api.github.com','raw.githubusercontent.com','s3.amazonaws.com','akeptumbesnow.com'
 ]);
});

test('server configuration keys retain canonical identity over a parsed id',()=>{
 const config={parameters:{
  server_global_fixture:JSON.stringify({id:'payload-id',server:'198.51.100.8'}),
  server_other_fixture:JSON.stringify({id:'other-profile'})
 }};
 assert.deepEqual(serversFrom(config),[{id:'server_global_fixture',server:'198.51.100.8'}]);
});

test('authentication cancellation forwards options and preserves the parent cancellation reason',async t=>{
 const calls=fakeHttps(t),controller=new AbortController(),reason=fault('CANCELLED');
 const pending=authenticate({hostName:'auth.invalid',serverIp:'203.0.113.9'},'A',{
  signal:controller.signal,timeout:30000,headers:{'X-Fixture':'present'}
 });
 pending.catch(()=>{});
 assert.equal(calls.length,1);
 assert(calls[0].options.signal instanceof AbortSignal);
 assert.equal(calls[0].options.hostname,'203.0.113.9');
 assert.equal(calls[0].options.headers['X-Fixture'],'present');
 assert.equal(typeof calls[0].options.headers.Authorization,'string');
 controller.abort(reason);
 await assert.rejects(within(pending),error=>error===reason);
});

test('authentication HTTP failures expose a safe AUTH_HTTP error',async t=>{
 fakeHttps(t,({respond})=>respond(401,'secret response fixture'));
 await assert.rejects(authenticate({server:'auth.invalid'}),error=>error.code==='AUTH_HTTP'&&!error.message.includes('secret'));
});

test('malformed encrypted authentication responses expose a safe AUTH_RESPONSE error',async t=>{
 fakeHttps(t,({respond})=>respond(200,'secret response fixture'));
 await assert.rejects(authenticate({server:'auth.invalid'}),error=>error.code==='AUTH_RESPONSE'&&!error.message.includes('secret'));
});

test('authentication credentials cannot override the selected host or protocol',async t=>{
 const credentials={uuid:'11111111-1111-4111-8111-111111111111',token:'fixture-token',hostName:'payload.invalid',protocol:'C',authDate:'payload-date'};
 // Isolate decrypted server data at the cipher boundary without changing authentication logic.
 t.mock.method(crypto,'createDecipheriv',()=>({
  setAAD(){},setAuthTag(){},
  update(){return Buffer.from(JSON.stringify(credentials));},
  final(){return Buffer.alloc(0);}
 }));
 const date='Tue, 20 Oct 2026 10:00:00 GMT';
 fakeHttps(t,({respond})=>respond(200,Buffer.alloc(16).toString('base64'),{date}));
 const session=await authenticate({hostName:'selected.invalid',protocol:'A'},'B');
 assert.deepEqual({hostName:session.hostName,protocol:session.protocol},{hostName:'selected.invalid',protocol:'B'});
 assert.equal(session.authDate,date);
 assert.equal(session.uuid,credentials.uuid);assert.equal(session.token,credentials.token);
});

test('session requests forward cancellation and custom request options',async t=>{
 const calls=fakeHttps(t),controller=new AbortController(),reason=fault('CANCELLED');
 const pending=sessionRequest({uuid:'11111111-1111-4111-8111-111111111111',hostName:'session.invalid',serverIp:'203.0.113.4'},'close',{
  signal:controller.signal,headers:{'X-Fixture':'session'}
 });
 pending.catch(()=>{});
 assert(calls[0].options.signal instanceof AbortSignal);
 assert.equal(calls[0].options.headers['X-Fixture'],'session');
 assert.equal(calls[0].options.hostname,'203.0.113.4');
 controller.abort(reason);
 await assert.rejects(within(pending),error=>error===reason);
});

test('cancelling a stalled SOCKS greeting promptly closes the owned loopback socket',async t=>{
 let greeting;
 const seen=new Promise(resolve=>{greeting=resolve;});
 const local=await fixture(t,socket=>socket.once('data',chunk=>greeting(chunk)));
 const controller=new AbortController(),reason=fault('CANCELLED');let owned;
 const pending=socksConnect(local.port,'destination.invalid',443,{signal:controller.signal,onSocket:socket=>{owned=socket;}});
 pending.catch(()=>{});
 assert.deepEqual(await within(seen),Buffer.from([5,1,0]));
 const started=performance.now();controller.abort(reason);
 await assert.rejects(within(pending),error=>error===reason);
 await within(local.allClosed());
 assert(performance.now()-started<2000);
 assert(owned.destroyed);assert.equal(local.sockets.size,0);
 assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('an already-aborted SOCKS connection opens no loopback socket',async t=>{
 const local=await fixture(t,()=>{}),controller=new AbortController(),reason=fault('CANCELLED');
 controller.abort(reason);let owned=0;
 await assert.rejects(within(socksConnect(local.port,'destination.invalid',443,{
  signal:controller.signal,onSocket:()=>owned++
 })),error=>error===reason);
 assert.equal(local.accepted,0);assert.equal(owned,0);
});

test('SOCKS noauth rejection reports SOCKS_AUTH and closes its socket',async t=>{
 const local=await fixture(t,socket=>socket.once('data',()=>socket.write(Buffer.from([5,255]))));
 await assert.rejects(within(socksConnect(local.port,'destination.invalid')),error=>error.code==='SOCKS_AUTH');
 await within(local.allClosed());assert.equal(local.sockets.size,0);
});

test('SOCKS CONNECT rejection reports SOCKS_REJECTED and closes its socket',async t=>{
 const local=await fixture(t,socksFixture(undefined,{reply:Buffer.from([5,5,0,1,127,0,0,1,0,0])}));
 await assert.rejects(within(socksConnect(local.port,'destination.invalid')),error=>error.code==='SOCKS_REJECTED');
 await within(local.allClosed());assert.equal(local.sockets.size,0);
});

for(const [name,address] of [
 ['IPv4',Buffer.from([1,127,0,0,1,1,187])],
 ['IPv6',Buffer.concat([Buffer.from([4]),Buffer.alloc(16),Buffer.from([1,187])])],
 ['domain',Buffer.from([3,3,97,98,99,1,187])]
])test(`SOCKS consumes fragmented ${name} replies and retains bytes after the handshake`,async t=>{
 let owned,connectMessage;
 const local=await fixture(t,socksFixture(({socket,message})=>{
  connectMessage=message;
  socket.write(Buffer.from([5]));
  setImmediate(()=>socket.write(Buffer.concat([Buffer.from([0,0]),address,Buffer.from('payload')])));
 },{reply:Buffer.alloc(0)}));
 const socket=await within(socksConnect(local.port,'destination.invalid',8443,{onSocket:value=>{owned=value;}}));
 t.after(()=>socket.destroy());
 assert.equal(socket,owned);
 assert.equal(connectMessage.subarray(5,-2).toString(),'destination.invalid');
 assert.equal(connectMessage.readUInt16BE(connectMessage.length-2),8443);
 const data=once(socket,'data');socket.resume();
 assert.equal((await within(data))[0].toString(),'payload');
 socket.destroy();await within(local.allClosed());
});

test('SOCKS rejects an empty destination without opening a socket',async t=>{
 const local=await fixture(t,socksFixture());
 await assert.rejects(within(socksConnect(local.port,'',443)),error=>error.code==='SOCKS_HOST');
 await within(local.allClosed());assert.equal(local.accepted,0);
});

test('tunnel requests require HTTPS without opening a loopback connection',async t=>{
 const local=await fixture(t,()=>{});
 await assert.rejects(tunnelRequest(local.port,'http://destination.invalid/'),error=>error.code==='HTTPS_REQUIRED');
 assert.equal(local.accepted,0);
});

async function stalledTls(t){
 let started;
 const tlsStarted=new Promise(resolve=>{started=resolve;});
 const local=await fixture(t,socksFixture(({socket})=>socket.once('data',chunk=>{
  assert.equal(chunk[0],22,'the SOCKS tunnel must reach a TLS ClientHello');started();
 })));
 return {...local,tlsStarted};
}

test('cancelling after SOCKS success settles a stalled TLS connection and closes every socket',async t=>{
 const originalCreateSocket=https.Agent.prototype.createSocket;
 let callbacks=0;
 t.mock.method(https.Agent.prototype,'createSocket',function(...args){
  const createConnection=this.createConnection;
  this.createConnection=(options,callback)=>createConnection.call(this,options,(...result)=>{
   callbacks++;callback(...result);
  });
  return originalCreateSocket.apply(this,args);
 });
 const local=await stalledTls(t),controller=new AbortController(),reason=fault('CANCELLED');
 const pending=tunnelRequest(local.port,'https://destination.invalid/',{signal:controller.signal,timeout:30000});
 pending.catch(()=>{});
 await within(local.tlsStarted);
 const started=performance.now();controller.abort(reason);
 await assert.rejects(within(pending),error=>error===reason);
 await within(local.allClosed());
 assert(performance.now()-started<2000);assert.equal(local.sockets.size,0);
 assert.equal(callbacks,1,'the pending Agent connection callback must settle exactly once');
 assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('stalled TLS rejects cancellation with a false parent reason and closes its sockets',async t=>{
 const local=await stalledTls(t),controller=new AbortController();
 const pending=tunnelRequest(local.port,'https://destination.invalid/',{signal:controller.signal,timeout:30000});
 pending.catch(()=>{});
 await within(local.tlsStarted);controller.abort(false);
 await assert.rejects(within(pending),error=>error===false);
 await within(local.allClosed());assert.equal(local.sockets.size,0);
});

test('a tunnel deadline settles stalled TLS and closes every socket',async t=>{
 const local=await stalledTls(t);
 const pending=tunnelRequest(local.port,'https://destination.invalid/',{timeout:80});
 pending.catch(()=>{});
 await within(local.tlsStarted);
 await assert.rejects(within(pending),error=>error.code==='DEADLINE');
 await within(local.allClosed());assert.equal(local.sockets.size,0);
});
