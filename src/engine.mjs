import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {abortable,delay,fault,scope} from './async-control.mjs';

export function makeEngineConfig(session,{mode='proxy',port=10808,apiPort,secret}) {
 if(!['proxy','full'].includes(mode))throw new Error('Unknown connection mode');
 if(!net.isIP(session.serverIp))throw new Error('A resolved server address is required before creating the tunnel');
 const headers={...session.headers};
 if(!headers.Host||headers.Host==='AUTO')headers.Host=session.hostName;
 const inbounds=[{type:'mixed',tag:'local-proxy',listen:'127.0.0.1',listen_port:port}];
 if(mode==='full')inbounds.push({type:'tun',tag:'windows-tun',interface_name:'ArgoDesktop',address:['172.29.231.1/30','fdfe:dcba:9876::1/126'],mtu:1400,auto_route:true,strict_route:true,dns_mode:'hijack',stack:'mixed'});
 return {
  log:{level:'info',timestamp:false},
  dns:{servers:[{type:'https',tag:'remote-doh',server:'1.1.1.1',server_port:443,path:'/dns-query',tls:{enabled:true,server_name:'cloudflare-dns.com'},detour:'argo'}],final:'remote-doh',strategy:'prefer_ipv4'},
  inbounds,
  outbounds:[{type:'vmess',tag:'argo',server:session.serverIp,server_port:session.port||443,uuid:session.uuid,security:'auto',alter_id:0,global_padding:true,authenticated_length:true,tls:{enabled:true,server_name:session.hostName,insecure:false},transport:{type:'ws',path:session.wsPath||'/',headers}}],
  route:{auto_detect_interface:mode==='full',default_domain_resolver:{server:'remote-doh',strategy:'prefer_ipv4'},rules:mode==='full'?[{inbound:['windows-tun'],port:53,action:'hijack-dns'}]:[],final:'argo'},
  experimental:{clash_api:{external_controller:'127.0.0.1:'+apiPort,secret,access_control_allow_origin:['http://127.0.0.1'],access_control_allow_private_network:false}}
 };
}
export function makeStoppedConfig(apiPort,secret){
 return {log:{level:'error'},inbounds:[],outbounds:[{type:'block',tag:'stopped'}],route:{final:'stopped'},experimental:{clash_api:{external_controller:'127.0.0.1:'+apiPort,secret}}};
}
async function reservePort(preferred=0){
 return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen({port:preferred,host:'127.0.0.1',exclusive:true},()=>resolve(s));});
}
export async function freePort(preferred=0){
 const server=await reservePort(preferred),port=server.address().port;
 await new Promise(resolve=>server.close(resolve));return port;
}
export async function chooseProxyPort(requested,{exclude=[]}={}){
 if(!Number.isInteger(requested)||requested<1024||requested>65535)throw new Error('Invalid proxy port');
 for(let candidate=requested;candidate<=Math.min(65535,requested+16);candidate++){
  if(exclude.includes(candidate))continue;
  try{return await freePort(candidate);}catch(e){if(!['EADDRINUSE','EACCES'].includes(e.code))throw e;}
 }
 // Keep rejected ephemeral sockets open until the search is finished: Windows
 // can otherwise hand back the same just-released port on every attempt.
 const held=[];
 try{
  for(let attempt=0;attempt<Math.min(exclude.length+2,64);attempt++){
   const server=await reservePort();held.push(server);
   const candidate=server.address().port;
   if(candidate>=1024&&!exclude.includes(candidate))return candidate;
  }
  throw new Error('No local proxy port is available');
 }finally{await Promise.all(held.map(server=>new Promise(resolve=>server.close(resolve))));}
}
export function isProxyBindConflict(error){
 return /local-proxy[^\n]*listen tcp[^\n]*bind:/i.test(error?.message||'');
}
function abortReason(signal){
 const reason=signal.reason;
 return reason instanceof Error&&reason.name!=='AbortError'?reason:fault('CANCELLED');
}
function checkAbort(signal){if(signal.aborted)throw abortReason(signal);}

export async function controllerRequest(port,secret,method,endpoint,body,{signal,timeout=1000}={}){
 const budget=scope(signal,timeout);
 try{
  checkAbort(budget.signal);
  return await new Promise((resolve,reject)=>{
   const encoded=body===undefined?null:Buffer.from(JSON.stringify(body));
   const fail=error=>reject(budget.signal.aborted?abortReason(budget.signal):error);
   const req=http.request({hostname:'127.0.0.1',port,path:endpoint,method,signal:budget.signal,
    headers:{Authorization:'Bearer '+secret,...(encoded?{'Content-Type':'application/json','Content-Length':encoded.length}:{})}},res=>{
    const chunks=[];let bytes=0;
    res.on('data',chunk=>{
     bytes+=chunk.length;
     if(bytes>131072){req.destroy(fault('CONTROLLER_RESPONSE_LIMIT'));return;}
     chunks.push(chunk);
    });
    res.once('error',fail);
    res.once('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
   });
   req.once('error',fail);
   if(encoded)req.write(encoded);
   req.end();
  });
 }finally{budget.dispose();}
}

export async function startEngine(session,{mode,port,exe,workDir,signal,
 launch=spawn,controller=controllerRequest,chooseApiPort=freePort,stopWaitMs=[3000,1000]}){
 const startup=scope(signal,18000);
 let apiPort,secret,dir,configPath,child;
 // Remove only this runtime's file and empty directory. Never traverse a
 // replacement junction, or recursively remove files owned by another run.
 const removeConfig=()=>{
  try{
   const root=path.resolve(workDir),target=path.resolve(dir);
   if(path.dirname(target)!==root||!/^connection-[A-Za-z0-9]+$/.test(path.basename(target)))throw fault('CLEANUP_FAILED');
   let stat;
   try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')return;throw error;}
   if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('CLEANUP_FAILED');
   const expected=path.join(fs.realpathSync.native(root),path.basename(target));
   const actual=fs.realpathSync.native(target);
   const same=process.platform==='win32'?actual.toLowerCase()===expected.toLowerCase():actual===expected;
   if(!same)throw fault('CLEANUP_FAILED');
   try{fs.unlinkSync(configPath);}catch(error){if(error.code!=='ENOENT')throw error;}
   fs.rmdirSync(target);
  }catch{throw fault('CLEANUP_FAILED');}
 };
 try{
  checkAbort(startup.signal);
  apiPort=await abortable(chooseApiPort(),startup.signal);
  checkAbort(startup.signal);
  if(apiPort===port)apiPort=await abortable(chooseProxyPort(apiPort,{exclude:[port]}),startup.signal);
  checkAbort(startup.signal);
  secret=crypto.randomBytes(24).toString('hex');
  const config=makeEngineConfig(session,{mode,port,apiPort,secret});
  dir=fs.mkdtempSync(path.join(workDir,'connection-'));
  configPath=path.join(dir,'config.json');
  fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
  checkAbort(startup.signal);
  child=launch(exe,['run','-c',configPath,'--disable-color'],{windowsHide:true,stdio:['ignore','pipe','pipe'],cwd:path.dirname(exe)});
 }catch(error){
  startup.dispose();
  if(dir)removeConfig();
  throw startup.signal.aborted?abortReason(startup.signal):fault('ENGINE_FAILED');
 }
 let log='',spawnError,processExited=false,exited=false,stopPromise;
 const capture=data=>{
  log+=data.toString();
  if(session.uuid)log=log.replaceAll(session.uuid,'[session]');
  if(session.token)log=log.replaceAll(session.token,'[token]');
  log=log.slice(-12000);
 };
 child.stdout.on('data',capture);child.stderr.on('data',capture);
 child.on('error',error=>{spawnError=error;});
 child.once('exit',()=>{processExited=true;});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>{
  exited=true;resolve({code,signal});
 }));
 const stoppedWithin=async milliseconds=>{
  const budget=scope(undefined,milliseconds);
  try{await abortable(closed,budget.signal);return true;}catch{return false;}
  finally{budget.dispose();}
 };
 const kill=()=>{try{child.kill();}catch{ /* Close must still be confirmed. */ }};
 const stop=()=>{
  if(stopPromise)return stopPromise;
  stopPromise=(async()=>{
   let configurationClosed=false;
   if(!exited){
    // Cleanup has its own budget so cancellation never prevents teardown.
    const cleanup=scope(undefined,1000);
    try{
     const result=await abortable(controller(apiPort,secret,'PUT','/configs?force=true',
      {payload:JSON.stringify(makeStoppedConfig(apiPort,secret))},{signal:cleanup.signal}),cleanup.signal);
     configurationClosed=result.status===200||result.status===204;
    }catch{}
    finally{cleanup.dispose();}
    if(!exited)kill();
   }
   if(!exited&&!await stoppedWithin(stopWaitMs[0])){
    kill();await stoppedWithin(stopWaitMs[1]);
   }
   if(!exited)throw fault('CLEANUP_FAILED');
   removeConfig();
   return {configurationClosed,processStopped:true,runtimeRemoved:true};
  })();
  return stopPromise;
 };
 const failed=()=>spawnError||processExited||exited||child.exitCode!==null||child.signalCode!=null;
 try{
  while(true){
   checkAbort(startup.signal);
   if(failed())throw fault('ENGINE_FAILED');
   try{
    const result=await abortable(controller(apiPort,secret,'GET','/version',undefined,{signal:startup.signal}),startup.signal);
    checkAbort(startup.signal);
    // The API can be listening while TUN setup is still in progress.
   if(result.status===200&&log.includes('sing-box started (')&&!failed())return {port,child,closed,stop,isStopped:()=>processExited||exited};
   }catch(error){if(startup.signal.aborted)throw abortReason(startup.signal);}
   if(failed())throw fault('ENGINE_FAILED');
   await delay(150,startup.signal);
  }
 }catch(error){
  const bindConflict=isProxyBindConflict({message:log});
  const terminal=startup.signal.aborted?abortReason(startup.signal):fault(bindConflict?'PROXY_BIND_CONFLICT':'ENGINE_FAILED');
  await stop();
  throw terminal;
 }finally{startup.dispose();}
}
