export function fault(code,message=code){
 return Object.assign(new Error(message),{code});
}

function cancellationReason(signal){
 return signal?.reason??fault('CANCELLED');
}

export function scope(parentSignal,milliseconds=Infinity){
 const controller=new AbortController();
 let timer;
 const forward=()=>abort(cancellationReason(parentSignal));
 function dispose(){
  clearTimeout(timer);timer=undefined;
  parentSignal?.removeEventListener('abort',forward);
 }
 function abort(reason=fault('CANCELLED')){
  dispose();
  controller.abort(reason);
 }
 if(parentSignal?.aborted)forward();
 else{
  parentSignal?.addEventListener('abort',forward,{once:true});
  if(Number.isFinite(milliseconds))timer=setTimeout(()=>abort(fault('DEADLINE')),milliseconds);
 }
 return {signal:controller.signal,abort,dispose};
}

export function abortable(promise,signal){
 return new Promise((resolve,reject)=>{
  const settle=(callback,value)=>{
   signal?.removeEventListener('abort',onAbort);
   callback(value);
  };
  const onAbort=()=>settle(reject,cancellationReason(signal));
  if(signal?.aborted)onAbort();
  else signal?.addEventListener('abort',onAbort,{once:true});
  // Attach both handlers even after cancellation so a late failure is consumed.
  Promise.resolve(promise).then(value=>settle(resolve,value),error=>settle(reject,error));
 });
}

export function delay(milliseconds,signal){
 return new Promise((resolve,reject)=>{
  let timer;
  const settle=(callback,value)=>{
   clearTimeout(timer);
   signal?.removeEventListener('abort',onAbort);
   callback(value);
  };
  const onAbort=()=>settle(reject,cancellationReason(signal));
  if(signal?.aborted){onAbort();return;}
  signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>settle(resolve),milliseconds);
 });
}

export function codeOf(error){
 const code=error?.code;
 return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,50}$/.test(code)?code:'CONNECTION_FAILED';
}
