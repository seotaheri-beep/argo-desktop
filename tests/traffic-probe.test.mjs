import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {fault} from '../src/async-control.mjs';

async function api(){
 assert(fs.existsSync(new URL('../src/traffic-probe.mjs',import.meta.url)),'traffic probe module must exist');
 return import('../src/traffic-probe.mjs');
}
const trace=(ip='203.0.113.7')=>({status:200,body:`ip=${ip}\nloc=DE\ntls=TLSv1.3\n`});
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');

test('proxy probes both destinations through the actual port and reports only hashed egress',async()=>{
 const {verifyTraffic}=await api(),calls=[],controller=new AbortController();
 const result=await verifyTraffic({mode:'proxy',port:10819,signal:controller.signal},{
  system:()=>assert.fail('proxy mode must not use system routing'),
  tunnel:async(port,url,options)=>{calls.push({port,url,options});return url.includes('google')?{status:204}:trace();}
 });
 assert.equal(calls.length,2);assert(calls.every(c=>c.port===10819&&c.options.signal===controller.signal&&c.options.timeout===12000));
 assert.deepEqual(result,{tunnelVerified:true,country:'DE',google:{status:204},cloudflare:{status:200,country:'DE',tls:'TLSv1.3',egressIpSha256:hash('203.0.113.7')},validationThrough:'loopback-proxy'});
 assert(!JSON.stringify(result).includes('203.0.113.7'));
});

test('full mode gets the proxy reference first then requires exact system egress equality and DNS',async()=>{
 const {verifyTraffic}=await api(),calls=[],controller=new AbortController();
 const result=await verifyTraffic({mode:'full',port:10820,signal:controller.signal},{
  tunnel:async(port,url,options)=>{calls.push(['proxy',port,url,options]);return trace();},
  system:async(url,options)=>{calls.push(['system',url,options]);return url.includes('google')?{status:204}:trace();},
  resolve4:async host=>{calls.push(['dns',host]);return ['198.51.100.1'];}
 });
 assert.equal(calls[0][0],'proxy');assert.equal(calls[0][1],10820);assert.equal(calls[0][3].signal,controller.signal);
 assert.equal(calls[0][3].timeout,12000);assert.equal(calls.filter(c=>c[0]==='system').length,2);
 assert(calls.filter(c=>c[0]==='system').every(c=>c[2].signal===controller.signal&&c[2].timeout===12000));
 assert.equal(result.systemEgressMatchesProxy,true);assert.deepEqual(result.systemDns,{success:true});
 assert.deepEqual(result.configuredRouting,{ipv4:true,ipv6:true,dnsHijack:true,strictRoute:true});
 assert.equal(result.validationThrough,'system-routing');assert.equal(result.cloudflare.egressIpSha256,hash('203.0.113.7'));
 assert(!JSON.stringify(result).includes('203.0.113.7'));
});

for(const [name,reference,google,systemTrace] of [
 ['mismatched exact IP',trace(),{status:204},trace('203.0.113.70')],
 ['bad reference status',{...trace(),status:503},{status:204},trace()],
 ['missing reference IP',{status:200,body:'loc=DE'}, {status:204},trace()],
 ['bad Google status',trace(),{status:200},trace()],
 ['missing system IP',trace(),{status:204},{status:200,body:'loc=DE'}]
])test(`traffic failure is safe for ${name}`,async()=>{
 const {verifyTraffic}=await api();
 await assert.rejects(verifyTraffic({mode:'full',port:10821},{tunnel:async()=>reference,system:async url=>url.includes('google')?google:systemTrace,resolve4:async()=>['1.2.3.4']}),{code:'TRAFFIC_PROBE_FAILED'});
});

for(const addresses of [[],null])test(`full DNS rejects an empty result ${addresses}`,async()=>{
 const {verifyTraffic}=await api();
 await assert.rejects(verifyTraffic({mode:'full',port:10821},{tunnel:async()=>trace(),system:async url=>url.includes('google')?{status:204}:trace(),resolve4:async()=>addresses}),{code:'DNS_PROBE_FAILED'});
});

test('full DNS cancellation promptly settles an uncancellable resolver and retains cancellation',async()=>{
 const {verifyTraffic}=await api(),controller=new AbortController();let entered;
 const reached=new Promise(resolve=>entered=resolve);
 const pending=verifyTraffic({mode:'full',port:10821,signal:controller.signal},{tunnel:async()=>trace(),system:async url=>url.includes('google')?{status:204}:trace(),resolve4:()=>{entered();return new Promise(()=>{});}});
 await reached;controller.abort(fault('CANCELLED'));await assert.rejects(pending,{code:'CANCELLED'});
});

for(const [status,body,code] of [[401,'x','SESSION_REJECTED'],[403,'x','SESSION_REJECTED'],[200,'xx','SESSION_REJECTED'],[503,'x','KEEPALIVE_HTTP']])test(`keepalive ${status}/${body.length} maps to ${code}`,async()=>{
 const {pingSession}=await api();
 await assert.rejects(pingSession({session:{uuid:'fixture',hostName:'fixture.invalid',port:8443},port:10999},{send:async()=>({status,body})}),{code});
});

test('accepted keepalive uses encrypted authorization through the actual proxy port',async()=>{
 const {pingSession}=await api(),controller=new AbortController();let call;
 await pingSession({session:{uuid:'fixture',hostName:'fixture.invalid',port:8443},port:10999},{signal:controller.signal,timeout:5000,send:async(...args)=>{call=args;return {status:200,body:'x'};}});
 assert.equal(call[0],10999);assert.equal(call[1],'https://fixture.invalid:8443/');
 assert.equal(call[2].signal,controller.signal);assert.equal(call[2].timeout,5000);
 assert.equal(typeof call[2].headers.Authorization,'string');assert(!call[2].headers.Authorization.includes('fixture'));
});

test('disconnect chooses direct transport for a stopped engine and caps cleanup at two seconds',async t=>{
 const {disconnectSession}=await api();let options;
 t.mock.method(https,'request',(value,respond)=>{
  options=value;const req=new EventEmitter();req.destroy=()=>{};
  req.end=()=>{const res=new EventEmitter();Object.assign(res,{statusCode:200,headers:{}});respond(res);res.emit('data',Buffer.from('x'));res.emit('end');};return req;
 });
 const result=await disconnectSession({uuid:'fixture',hostName:'fixture.invalid',serverIp:'192.0.2.1'}, {port:10999,isStopped:()=>true},new AbortController().signal);
 assert.equal(result.status,200);assert.equal(options.hostname,'192.0.2.1');assert.equal(typeof options.headers.Authorization,'string');
});

test('proxy transport failures use the fixed probe code without raw details',async()=>{
 const {verifyTraffic}=await api();
 await assert.rejects(verifyTraffic({mode:'proxy',port:10821},{tunnel:async()=>{throw new Error('PRIVATE_TRANSPORT_DETAIL');}}),error=>error.code==='TRAFFIC_PROBE_FAILED'&&!error.message.includes('PRIVATE_TRANSPORT_DETAIL'));
});

test('full DNS transport failures use the fixed DNS code without raw details',async()=>{
 const {verifyTraffic}=await api();
 await assert.rejects(verifyTraffic({mode:'full',port:10821},{tunnel:async()=>trace(),system:async url=>url.includes('google')?{status:204}:trace(),resolve4:async()=>{throw new Error('PRIVATE_DNS_DETAIL');}}),error=>error.code==='DNS_PROBE_FAILED'&&!error.message.includes('PRIVATE_DNS_DETAIL'));
});

test('already cancelled traffic probes and keepalives perform no I/O',async()=>{
 const {verifyTraffic,pingSession}=await api(),controller=new AbortController();controller.abort(fault('CANCELLED'));
 const forbidden=()=>assert.fail('cancelled operations must not reach transport');
 await assert.rejects(verifyTraffic({mode:'full',port:10821,signal:controller.signal},{tunnel:forbidden,system:forbidden,resolve4:forbidden}),{code:'CANCELLED'});
 await assert.rejects(pingSession({session:{},port:10821},{signal:controller.signal,send:forbidden}),{code:'CANCELLED'});
});
