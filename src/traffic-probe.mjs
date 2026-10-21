import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import {request,sessionAuthorization,sessionRequest} from './prototype.mjs';
import {tunnelRequest} from './proxy.mjs';
import {abortable,fault} from './async-control.mjs';

const GOOGLE='https://www.google.com/gen_204';
const CLOUDFLARE='https://www.cloudflare.com/cdn-cgi/trace';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function traceFields(response){
 const fields=Object.fromEntries(String(response.body||'').trim().split('\n').map(row=>{
  const index=row.indexOf('=');return index<0?[row,'']:[row.slice(0,index),row.slice(index+1).trim()];
 }));
 if(response.status!==200||!fields.ip)throw fault('TRAFFIC_PROBE_FAILED');
 return fields;
}

export async function verifyTraffic({mode,port,signal},{system=request,tunnel=tunnelRequest,resolve4=dns.resolve4}={}){
 const check=()=>signal?.throwIfAborted();
 const options={signal,timeout:12000};
 let google,trace,fields;
 try{
  check();
  let reference;
  if(mode==='full'){
   reference=traceFields(await tunnel(port,CLOUDFLARE,options)).ip;check();
  }
  const send=mode==='full'?system:(url,opts)=>tunnel(port,url,opts);
  google=await send(GOOGLE,options);check();
  trace=await send(CLOUDFLARE,options);check();fields=traceFields(trace);
  if(google.status!==204||(mode==='full'&&fields.ip!==reference))throw fault('TRAFFIC_PROBE_FAILED');
 }catch(error){check();throw fault('TRAFFIC_PROBE_FAILED');}
 const health={tunnelVerified:true,country:fields.loc||'',google:{status:google.status},
  cloudflare:{status:trace.status,country:fields.loc||'',tls:fields.tls,egressIpSha256:hash(fields.ip)},
  validationThrough:mode==='full'?'system-routing':'loopback-proxy'};
 if(mode==='full'){
  try{
   check();const addresses=await abortable(resolve4('example.com'),signal);check();
   if(!Array.isArray(addresses)||!addresses.length)throw fault('DNS_PROBE_FAILED');
  }catch(error){check();throw fault('DNS_PROBE_FAILED');}
  health.systemEgressMatchesProxy=true;health.systemDns={success:true};
  // These flags describe the requested engine configuration, not leak measurements.
  health.configuredRouting={ipv4:true,ipv6:true,dnsHijack:true,strictRoute:true};
 }
 return health;
}

export async function pingSession(connection,{signal,timeout=12000,send=tunnelRequest}={}){
 signal?.throwIfAborted();
 const {session,port}=connection;
 const response=await send(port,`https://${session.hostName}:${session.port||443}/`,{
  signal,timeout,headers:{Authorization:sessionAuthorization(session,'keepalive')}
 });
 signal?.throwIfAborted();
 if(response.status===401||response.status===403||
  (response.status===200&&(typeof response.body!=='string'||response.body.length%2!==1)))throw fault('SESSION_REJECTED');
 if(response.status!==200)throw fault('KEEPALIVE_HTTP');
 return response;
}

export async function disconnectSession(session,core,signal){
 const options={signal,timeout:2000};
 if(!core||core.isStopped())return sessionRequest(session,'disconnect',options);
 return tunnelRequest(core.port,`https://${session.hostName}:${session.port||443}/`,{
  ...options,headers:{Authorization:sessionAuthorization(session,'disconnect')}
 });
}
