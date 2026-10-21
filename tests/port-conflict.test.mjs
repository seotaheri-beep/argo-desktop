import assert from 'node:assert/strict';
import net from 'node:net';
import {chooseProxyPort,freePort,isProxyBindConflict} from '../src/engine.mjs';

const blockers=[];
async function occupy(port=0){
 const server=net.createServer(socket=>socket.end('existing-application'));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({port,host:'127.0.0.1',exclusive:true},resolve);});
 blockers.push(server);return server.address().port;
}
async function readExisting(port){
 return new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1');let result='';s.setTimeout(2000,()=>s.destroy(new Error('fixture timeout')));s.on('data',b=>result+=b);s.on('end',()=>resolve(result));s.on('error',reject);});
}
try{
 const requested=await occupy();
 const alternative=await chooseProxyPort(requested);
 assert.notEqual(alternative,requested);
 await occupy(alternative);
 const second=await chooseProxyPort(requested);
 assert(![requested,alternative].includes(second));
 assert.equal(await readExisting(requested),'existing-application');
 assert.equal(await readExisting(alternative),'existing-application');
 const excluded=Array.from({length:Math.min(17,65536-requested)},(_,i)=>requested+i);
 const fallback=await chooseProxyPort(requested,{exclude:excluded});
 assert(!excluded.includes(fallback));
 const available=await freePort();
 assert.equal(await chooseProxyPort(available),available);
 for(const invalid of [0,80,65536,10808.5,NaN])await assert.rejects(chooseProxyPort(invalid));
 assert(isProxyBindConflict(new Error('start inbound/mixed[local-proxy]: listen tcp 127.0.0.1:10808: bind: Only one usage of each socket address is normally permitted.')));
 assert(!isProxyBindConflict(new Error('start inbound/tun: Access is denied')));
 assert(!isProxyBindConflict(new Error('VMess authentication failed')));
 console.log('Occupied ports bypassed; existing listeners preserved; fallback and bind-error classification passed.');
}finally{await Promise.all(blockers.map(server=>new Promise(resolve=>server.close(resolve))));}
