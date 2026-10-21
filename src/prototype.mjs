import crypto from 'node:crypto';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import {fault,scope} from './async-control.mjs';

export const RSA_DER = Buffer.from('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz/M4JOwjHadx2ZsZZOATv0sT+YCtleYy4BPBBYA1KKypT59gVc5y1geVIbV6ssktTGnWE7q2BQsKG6QLZ13Xzdc/uYHm8hcQewlsUrh5i3qs9kyZSHXV9TqPna4sKX9pVxMxO+PfUWABzygRgDdpP3x/Y8my7oh3NVbRKrWrabcAtuyL3mdQGCWHooaVQfYttLWBuCSDUF8C5AnDUNQ5DnOrQFt8bKMQoqt7aj97Ecf2TiU0jxUAKt5QpmuS+Yjrny6/U7aCFU9iP+uQFwKNBRpxwlR/OS4mIq9gCWkrI7FWJ2i4AGU878IwiwGKYwvJK2Pyk3+6fW4dVg7+K+6B7QIDAQAB','base64');
export const TRUSTED_KEYS = {
 'snowcfg':'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEe9JfBCUoFo1vmiYHLNz0EbAN/xkzFlBrdBFbCGCQ4N41Cjt6c7vNi6dAfJSdn/a39m5AkbBcn9a/ITxMxZNHJQ==',
 'snowcfg-f':'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfMH+QlcC9f0wsbsHWJYcei+cp4rO2WnTzHcdhQF3OJFP58+I1O/Z/HTJE9GXUZ5SV3WPQgJF8V/YFoObjvmZtw==',
 'snowcfg-b':'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEvOr0llysYNMT+F4fRE0S7Bh/s29X8EXyKIbcZFwXmm2KebR9YvG+nBasKrH0QzZLgxdNDggIqgTdU0wAJXtMJA=='
};
const CONFIG_URLS=[
 'https://api.github.com/repos/legend-wizard/browse/contents/data6.br?ref=main',
 'https://raw.githubusercontent.com/legend-wizard/browse/refs/heads/main/data6.br',
 'https://s3.amazonaws.com/argovpn/browse/data6.br',
 'https://akeptumbesnow.com/repo6'
];
export function hmac(key,data,hash='sha256'){return crypto.createHmac(hash,key).update(data).digest();}
export function expand(prk,info,length,hash='sha256') {
 let previous=Buffer.alloc(0),out=Buffer.alloc(0);
 for(let i=1;out.length<length;i++){
  if(i>255)throw new Error('HKDF output too long');
  previous=hmac(prk,Buffer.concat([previous,Buffer.from(info),Buffer.from([i])]),hash);
  out=Buffer.concat([out,previous]);
 }
 return out.subarray(0,length);
}
const b64=b=>b.toString('base64').replace(/=+$/,'');
export function derive(secret,salt) {
 const prk=hmac(salt,secret);
 return {key:expand(prk,'Argo-AES-Key',32),iv:expand(prk,'Argo-AES-IV',12)};
}
export function encryptPayload(payload,publicKey=RSA_DER) {
 const plain=Buffer.from(JSON.stringify(payload));
 if(plain.length>190)throw new Error('Authentication payload exceeds RSA OAEP bound');
 const key=crypto.createPublicKey({key:publicKey,format:'der',type:'spki'});
 const encrypted=crypto.publicEncrypt({key,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},plain);
 return b64(zlib.gzipSync(Buffer.concat([encrypted,crypto.randomBytes(crypto.randomInt(1,33))])));
}
export function makeAuth(protocol='A',clockOffsetSeconds=0) {
 const salt=crypto.randomBytes(32);
 const seed=crypto.randomBytes(32);
 const secret=expand(hmac(crypto.randomBytes(32),seed,'sha512'),'ArgoVPN-Derivation',32,'sha512');
 const payload={protocol,request:'auth',salt:b64(salt),secret:b64(secret),t:Date.now()+clockOffsetSeconds*1000,version:3};
 const authorization=encryptPayload(payload);
 const {key,iv}=derive(secret,salt);
 const aad=hmac(expand(RSA_DER,'Argo-RSA-MAC-Key',32),Buffer.from(authorization));
 return {authorization,key,iv,aad,payload};
}
export function decryptAuth(text,auth) {
 const body=Buffer.from(text.trim(),'base64');
 if(body.length<16)throw new Error('Authentication response is too short');
 const dec=crypto.createDecipheriv('aes-256-gcm',auth.key,auth.iv);
 dec.setAAD(auth.aad);dec.setAuthTag(body.subarray(-16));
 return JSON.parse(Buffer.concat([dec.update(body.subarray(0,-16)),dec.final()]).toString('utf8'));
}
export function verifyConfig(text) {
 if(Buffer.byteLength(text)>262144)throw new Error('Configuration too large');
 let envelope=text.trim();
 if(envelope.startsWith('{')){
  const wrapper=JSON.parse(envelope);
  if(wrapper.encoding!=='base64'||typeof wrapper.content!=='string')throw new Error('Invalid GitHub response');
  envelope=Buffer.from(wrapper.content,'base64').toString('utf8').trim();
 }
 const parts=envelope.split('.');
 if(parts.length!==6||parts[0]!=='v1'||!TRUSTED_KEYS[parts[1]])throw new Error('Unsupported signed envelope');
 if(!/^[1-9][0-9]{0,18}$/.test(parts[2])||!/^\d{1,19}$/.test(parts[3]))throw new Error('Invalid serial/time');
 const key=crypto.createPublicKey({key:Buffer.from(TRUSTED_KEYS[parts[1]],'base64'),format:'der',type:'spki'});
 if(!crypto.verify('sha256',Buffer.from(parts.slice(0,5).join('.'),'ascii'),key,Buffer.from(parts[5],'base64url')))throw new Error('Configuration signature failed');
 const transformed=Buffer.from(parts[4],'base64').map(n=>n^255).reverse();
 const config=JSON.parse(zlib.inflateSync(transformed,{maxOutputLength:1048576}));
 if(!config.parameters||typeof config.parameters!=='object')throw new Error('Invalid configuration parameters');
 return {config,serial:parts[2],issuedAt:Number(parts[3]),keyId:parts[1]};
}
export async function request(url,{headers={},ip,timeout=12000,maxBytes=262144,signal}={}) {
 const u=new URL(url);
 if(u.protocol!=='https:')throw fault('HTTPS_REQUIRED');
 const operation=scope(signal,timeout);
 try{
  if(operation.signal.aborted)throw operation.signal.reason;
  return await new Promise((resolve,reject)=>{
   let req,settled=false;
   const finish=(error,result)=>{
    if(settled)return;
    settled=true;operation.signal.removeEventListener('abort',onAbort);
    if(operation.signal.aborted)reject(operation.signal.reason);
    else if(error)reject(error);
    else resolve(result);
   };
   const onAbort=()=>{finish(operation.signal.reason);req?.destroy();};
   operation.signal.addEventListener('abort',onAbort,{once:true});
   try{
    req=https.request({hostname:ip||u.hostname,port:u.port||443,path:u.pathname+u.search,servername:u.hostname,method:'GET',headers:{Host:u.host,'User-Agent':'ArgoDesktop/0.3.0',Accept:'*/*',...headers},signal:operation.signal,agent:false},res=>{
     const chunks=[];let bytes=0;
     res.on('data',chunk=>{
      if(settled)return;
      bytes+=chunk.length;
      if(bytes>maxBytes){finish(fault('RESPONSE_TOO_LARGE'));req?.destroy();return;}
      chunks.push(chunk);
     });
     res.on('error',error=>finish(error));
     res.on('aborted',()=>finish(fault('RESPONSE_CLOSED')));
     res.on('end',()=>finish(null,{status:res.statusCode,body:Buffer.concat(chunks).toString('utf8'),headers:res.headers,remoteAddress:res.socket?.remoteAddress}));
    });
    req.on('error',error=>finish(error));req.end();
   }catch(error){finish(error);req?.destroy();}
  });
 }finally{operation.dispose();}
}
export async function loadConfig(cache,options={}) {
 if(options.signal?.aborted)throw options.signal.reason??fault('CANCELLED');
 if(cache)return verifyConfig(fs.readFileSync(cache,'utf8'));
 for(const url of CONFIG_URLS){
  if(options.signal?.aborted)throw options.signal.reason??fault('CANCELLED');
  try{
   const r=await request(url,{...options,headers:{Accept:'application/vnd.github.raw+json',...options.headers}});
   if(r.status!==200)throw new Error('HTTP '+r.status);
   return verifyConfig(r.body);
  }catch(error){if(options.signal?.aborted)throw options.signal.reason??fault('CANCELLED');}
 }
 throw fault('CONFIG_UNAVAILABLE');
}
export function serversFrom(config,profile='global') {
 return Object.entries(config.parameters).filter(([key])=>key.startsWith('server_'+profile+'_')).map(([id,value])=>({...JSON.parse(value),id}));
}
export async function authenticate(server,protocol='A',options={}) {
 const host=server.hostName||((server.headers?.Host&&server.headers.Host!=='AUTO')?server.headers.Host:server.server);
 const auth=makeAuth(protocol,server.clockOffsetSeconds||0);
 const url=`https://${host}:${server.port||443}/`;
 const response=await request(url,{...options,headers:{...options.headers,Authorization:auth.authorization},ip:server.serverIp||undefined});
 if(!(response.status>=200&&response.status<300))throw fault('AUTH_HTTP');
 let credentials;
 try{
  credentials=decryptAuth(response.body,auth);
  if(typeof credentials?.uuid!=='string'||! /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(credentials.uuid))throw fault('AUTH_RESPONSE');
 }catch{throw fault('AUTH_RESPONSE');}
 return {...server,...credentials,hostName:host,protocol,authDate:response.headers.date};
}
export function sessionAuthorization(session,action) {
 const sessionId=crypto.createHash('sha256').update(session.uuid+(session.token||'')).digest('hex');
 return encryptPayload({request:action,sessionId,t:Date.now()+(session.clockOffsetSeconds||0)*1000,version:3});
}
export async function sessionRequest(session,action,options={}) {
 const authorization=sessionAuthorization(session,action);
 return request(`https://${session.hostName}:${session.port||443}/`,{...options,headers:{...options.headers,Authorization:authorization},ip:session.serverIp});
}
