import {isIPv4} from 'node:net';
import {scope,abortable,fault,codeOf} from './async-control.mjs';
import {compareNetwork as validateNetwork} from './windows-network.mjs';

function validSnapshot(snapshot){
 const comparison=validateNetwork(snapshot,snapshot);
 return comparison.routesEqual&&comparison.dnsEqual;
}

// Authentication and engine startup transfer ownership when they settle. Their
// signal-aware implementations must finish teardown before rejecting.
export async function attemptConnection(candidate,options,deps){
 const {signal,mode,requestedPort,record={},onStage=()=>{},onPort=()=>{}}=options;
 const began=deps.now();
 let session,core,startupCleanupError,baseline,baselineError,baselineNetwork,closePromise,stage='authenticating';
 const check=()=>signal?.throwIfAborted();
 const phase=value=>{stage=value;record.stage=value;onStage(value);};
 const close=()=>{
  if(closePromise)return closePromise;
  closePromise=(async()=>{
   const result={};
   // Keep partial cleanup evidence even if a later step cannot be confirmed.
   record.cleanup=result;
   let failed=Boolean(startupCleanupError||baselineError||baselineNetwork);
   if(startupCleanupError)result.engineError=startupCleanupError;
   if(baselineError)result.networkError=baselineError;
   if(baselineNetwork)result.network=baselineNetwork;
   if(session){
    result.disconnectAccepted=false;
    const bye=scope(undefined,2000);
    try{
     const response=await abortable(deps.disconnect(session,core,bye.signal),bye.signal);
     result.disconnectAccepted=response?.status>=200&&response.status<300
      &&typeof response.body==='string'&&response.body.length%2===1;
    }catch(error){result.disconnectError=codeOf(error);}
    finally{bye.dispose();}
   }
   if(core){
    try{result.engine=await core.stop();}
    catch(error){result.engineError=codeOf(error);failed=true;}
    if(result.engine?.processStopped!==true)failed=true;
   }
   if(mode==='full'&&baseline){
    try{
     const after=await deps.captureNetwork();
     if(!validSnapshot(after))throw fault('NETWORK_SNAPSHOT_FAILED');
     result.network=deps.compareNetwork(baseline,after);
     if(result.network?.verified!==true)failed=true;
    }catch(error){result.networkError=codeOf(error);failed=true;}
   }
   if(failed)throw fault('CLEANUP_FAILED');
   return result;
  })().catch(error=>{record.cleanupError=codeOf(error);throw fault('CLEANUP_FAILED');});
  return closePromise;
 };
 try{
  check();phase('authenticating');check();
  session=await deps.authenticate(candidate,signal);record.authenticated=true;
  check();phase('preparing');check();
  const address=await abortable(deps.lookup(session.server),signal);
  check();
  if(!isIPv4(address?.address))throw fault('DNS_FAILED');
  session.serverIp=address.address;
  if(mode==='full'){
   try{
    const before=await deps.captureNetwork();
    // The shared comparator validates the entire snapshot schema. Adapters
    // require their own classification because a pre-existing tunnel is unsafe.
    if(!validSnapshot(before))throw fault('NETWORK_SNAPSHOT_FAILED');
    if(before.adapters.length){
     baselineNetwork={verified:false,classification:'existing-argo-adapter'};
     throw fault('CLEANUP_FAILED');
    }
    baseline=before;
   }catch(error){
    if(!baselineNetwork)baselineError='NETWORK_SNAPSHOT_FAILED';
    throw fault('CLEANUP_FAILED');
   }
  }
  check();
  let port;
  const excluded=[];
  for(let bind=0;bind<4;bind++){
   check();port=await abortable(deps.choosePort(requestedPort,{exclude:[...excluded]}),signal);check();
   record.port=port;onPort(port);check();
   try{core=await deps.startEngine(session,{mode,port,signal});break;}
   catch(error){
    if(error?.code==='CLEANUP_FAILED'){
     startupCleanupError=codeOf(error);throw error;
    }
    check();
    if(error?.code!=='PROXY_BIND_CONFLICT'||bind===3)throw error;
    excluded.push(port);
   }
  }
  check();phase('verifying');check();
  const health=await abortable(deps.verifyTraffic({mode,port,signal}),signal);
  check();
  if(core.isStopped())throw fault('ENGINE_EXIT');
  if(health?.tunnelVerified!==true)throw fault('TRAFFIC_PROBE_FAILED');
  record.dataVerified=true;record.durationMs=deps.now()-began;
  return {session,port,health,closed:core.closed,close,
   ping:options=>deps.pingSession({session,port},options)};
 }catch(error){
  record.failedStage=stage;record.errorCode=codeOf(error);record.durationMs=deps.now()-began;
  await close();throw error;
 }
}
