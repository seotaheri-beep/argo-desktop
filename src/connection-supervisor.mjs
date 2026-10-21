import {scope,abortable,delay,fault,codeOf} from './async-control.mjs';

export const POLICY=Object.freeze({initialMs:120000,recoveryMs:120000,
 attemptMs:30000,keepaliveMs:45000,retryMs:1000,retryProbeMs:5000,
 backoffMs:Object.freeze([1000,3000,7000])});

export async function supervise({signal,loadCandidates,attempt,emit,report,
 now=Date.now,sleep=delay,random=Math.random,policy=POLICY}){
 let current,candidates,sequence=0,lastId,callbackFailed=false,callbackError;
 report.attempts=[];report.keepaliveAccepted=0;report.recoveries=0;
 const check=parent=>{parent?.throwIfAborted();signal?.throwIfAborted();};
 const state=(stage,values={})=>{
  try{emit('state',{stage,...values});}
  catch(error){callbackFailed=true;callbackError=error;throw error;}
 };
 const closeConnection=async connection=>{
  try{report.cleanup=await connection.close();}
  catch{throw fault('CLEANUP_FAILED');}
 };
 const closeCurrent=async()=>{
  if(!current)return;
  const closing=current;current=undefined;
  await closeConnection(closing);
 };
 const connectRound=async(ordered,parent,round)=>{
  for(const candidate of ordered){
   check(parent);
   const id=++sequence,record={attemptId:id,round,id:candidate.id,startedAt:now()};
   report.attempts.push(record);
   const budget=scope(parent,policy.attemptMs);
   let active=true,connection,previousPort=report.proxy?.actualPort||report.requestedPort;
   const accepts=()=>active&&id===sequence&&!signal?.aborted&&!parent.aborted&&!budget.signal.aborted;
   try{
    try{
     // The attempt owns its resources until it settles, including on cancellation.
     try{
      connection=await attempt(candidate,{signal:budget.signal,record,
       onStage:stage=>{if(accepts())state(stage,{attempt:id,round});},
       onPort:port=>{if(accepts()){
        state('port-selected',{port,previousPort,changed:previousPort!==port});previousPort=port;
       }}});
     }finally{active=false;}
     if(callbackFailed||parent.aborted||signal?.aborted||budget.signal.aborted){
      await closeConnection(connection);
      if(callbackFailed)throw callbackError;
      check(parent);budget.signal.throwIfAborted();
     }
    }catch(error){
     record.errorCode ||= codeOf(error);
     if(error?.code==='CLEANUP_FAILED')throw error;
     if(callbackFailed)throw callbackError;
     check(parent);
     continue;
    }
    // Once adopted, observer/report failures are terminal and finally releases it.
    current=connection;lastId=candidate.id;
    Object.assign(report,connection.health,{authenticated:true});
    report.proxy={requestedPort:report.requestedPort,actualPort:connection.port,
     automaticallyChanged:connection.port!==report.requestedPort};
    state('connected',{port:connection.port,mode:report.mode,
     country:connection.health.country,attemptId:id});
    return;
   }finally{active=false;budget.dispose();}
  }
  throw fault('NO_AVAILABLE_SERVER');
 };
 const watch=async connection=>{
  const watching=scope(signal);
  const heartbeat=(async()=>{
   while(true){
    await sleep(policy.keepaliveMs,watching.signal);check(watching.signal);
    try{
     await connection.ping({signal:watching.signal});
    }catch(error){
     check(watching.signal);
     if(error?.code==='SESSION_REJECTED')return 'SESSION_REJECTED';
     await sleep(policy.retryMs,watching.signal);check(watching.signal);
     try{
      await connection.ping({signal:watching.signal,timeout:policy.retryProbeMs});
     }catch(error){
      check(watching.signal);
      return error?.code==='SESSION_REJECTED'?'SESSION_REJECTED':'KEEPALIVE_FAILED';
     }
    }
    check(watching.signal);
    report.keepaliveAccepted++;
   }
  })();
  try{
   return await abortable(Promise.race([
    Promise.resolve(connection.closed).then(()=>'ENGINE_EXIT',()=>'ENGINE_EXIT'),heartbeat
   ]),watching.signal);
  }finally{
   watching.abort(fault('WATCH_ENDED'));watching.dispose();
   // Join the old heartbeat before another engine can acquire ownership.
   await heartbeat.catch(()=>{});
  }
 };
 try{
  const initial=scope(signal,policy.initialMs);
  try{
   state('loading');check(initial.signal);
   const loaded=await abortable(loadCandidates(initial.signal),initial.signal);
   check(initial.signal);
   const seen=new Set();
   candidates=loaded.filter(candidate=>{
    if(seen.has(candidate.id))return false;
    seen.add(candidate.id);return true;
   }).slice(0,6);
   await connectRound(candidates,initial.signal,0);
  }finally{initial.dispose();}
  while(true){
   check();const reason=await watch(current);check();
   const recovery=scope(signal,policy.recoveryMs);
   try{
    report.tunnelVerified=false;state('reconnecting',{reason});report.recoveries++;
    await closeCurrent();check(recovery.signal);
    const ordered=[...candidates.filter(candidate=>candidate.id!==lastId),...candidates.filter(candidate=>candidate.id===lastId)];
    let connected=false;
    for(let round=1;round<=policy.backoffMs.length;round++){
     check(recovery.signal);
     const delayMs=Math.round(policy.backoffMs[round-1]*(1+random()*0.2));
     state('reconnecting',{round,delayMs,reason});
     await sleep(delayMs,recovery.signal);check(recovery.signal);
     try{await connectRound(ordered,recovery.signal,round);connected=true;break;}
     catch(error){
      if(error?.code==='CLEANUP_FAILED'||callbackFailed||current)throw error;
      check(recovery.signal);
     }
    }
    if(!connected)throw fault('RECOVERY_EXHAUSTED');
   }finally{recovery.dispose();}
  }
 }finally{
  try{state('stopping');}finally{await closeCurrent();}
 }
}
