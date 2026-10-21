import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import {abortable,codeOf,delay,fault,scope} from '../src/async-control.mjs';

const timerCount=()=>process.getActiveResourcesInfo().filter(type=>type==='Timeout').length;
const listenerCount=signal=>getEventListeners(signal,'abort').length;

test('parent cancellation interrupts a 30-second delay promptly and preserves CANCELLED',async t=>{
 const parent=new AbortController(),child=scope(parent.signal);
 t.after(()=>child.dispose());
 const reason=fault('CANCELLED'),started=performance.now();
 const waiting=delay(30000,child.signal);
 parent.abort(reason);
 await assert.rejects(waiting,error=>error===reason&&error.code==='CANCELLED');
 assert(performance.now()-started<1000,'cancellation must not wait for the delay');
});

test('a 10ms scope deadline ends a pending operation before its late completion',async t=>{
 const child=scope(undefined,10);
 t.after(()=>child.dispose());
 let complete;
 const original=new Promise(resolve=>{complete=resolve;});
 t.after(()=>complete('late result'));
 const waiting=abortable(original,child.signal),started=performance.now();
 await assert.rejects(waiting,error=>error.code==='DEADLINE');
 assert(performance.now()-started<1000,'deadline must settle the wrapper promptly');
 complete('late result');
 assert.equal(await original,'late result');
});

test('fault creates an Error with a code and an optional separate message',()=>{
 const defaultMessage=fault('CANCELLED'),customMessage=fault('DEADLINE','Operation expired');
 assert(defaultMessage instanceof Error);
 assert.equal(defaultMessage.code,'CANCELLED');
 assert.equal(defaultMessage.message,'CANCELLED');
 assert.equal(customMessage.code,'DEADLINE');
 assert.equal(customMessage.message,'Operation expired');
});

test('scope forwards already-latched parent cancellation without adding resources',()=>{
 const parent=new AbortController(),reason=fault('CANCELLED');
 parent.abort(reason);
 const before=timerCount(),child=scope(parent.signal,30000);
 try{
  assert.equal(child.signal.aborted,true);
  assert.equal(child.signal.reason,reason);
  assert.equal(listenerCount(parent.signal),0);
  assert.equal(timerCount(),before);
 }finally{child.dispose();}
});

test('scope dispose removes its parent listener and deadline without aborting',async()=>{
 const parent=new AbortController(),before=timerCount(),child=scope(parent.signal,10);
 assert.equal(listenerCount(parent.signal),1);
 assert.equal(timerCount(),before+1);
 child.dispose();child.dispose();
 assert.equal(listenerCount(parent.signal),0);
 assert.equal(timerCount(),before);
 parent.abort(fault('CANCELLED'));
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(child.signal.aborted,false);
});

test('manual scope cancellation clears its resources and preserves the first reason',()=>{
 const parent=new AbortController(),before=timerCount(),child=scope(parent.signal,30000);
 const reason=fault('CANCELLED');
 try{
  child.abort(reason);child.abort(fault('DEADLINE'));
  assert.equal(child.signal.reason,reason);
  assert.equal(listenerCount(parent.signal),0);
  assert.equal(timerCount(),before);
 }finally{child.dispose();}
});

test('scope abort without a reason defaults to CANCELLED',()=>{
 const child=scope();
 child.abort();
 assert.equal(child.signal.reason.code,'CANCELLED');
 child.dispose();
});

test('scope supplies CANCELLED when the parent has no cancellation reason',()=>{
 const parent=new AbortController();
 // Native signals always supply a reason; shadow it to exercise the compatibility fallback.
 Object.defineProperty(parent.signal,'reason',{value:undefined});
 const child=scope(parent.signal);
 try{
  parent.abort();
  assert.equal(child.signal.reason.code,'CANCELLED');
 }finally{child.dispose();}
});

test('scope has no timer when its deadline is infinite',()=>{
 const before=timerCount(),child=scope();
 try{
  assert.equal(child.signal.aborted,false);
  assert.equal(timerCount(),before);
 }finally{child.dispose();}
});

test('a scope deadline detaches from the parent',async()=>{
 const parent=new AbortController(),child=scope(parent.signal,0);
 try{
  await assert.rejects(abortable(new Promise(()=>{}),child.signal),error=>error.code==='DEADLINE');
  assert.equal(listenerCount(parent.signal),0);
 }finally{child.dispose();}
});

test('abortable returns normal fulfillment and removes its cancellation listener',async()=>{
 const controller=new AbortController();
 const waiting=abortable(Promise.resolve('result'),controller.signal);
 assert.equal(await waiting,'result');
 assert.equal(listenerCount(controller.signal),0);
});

test('abortable preserves normal rejection and removes its cancellation listener',async()=>{
 const controller=new AbortController(),reason=new Error('Operation failed');
 await assert.rejects(abortable(Promise.reject(reason),controller.signal),error=>error===reason);
 assert.equal(listenerCount(controller.signal),0);
});

test('abortable rejects immediately for an already-cancelled signal',async()=>{
 const controller=new AbortController(),reason=fault('CANCELLED');
 controller.abort(reason);
 await assert.rejects(abortable(new Promise(()=>{}),controller.signal),error=>error===reason);
 assert.equal(listenerCount(controller.signal),0);
});

test('abortable consumes a later underlying rejection after cancellation',async()=>{
 const controller=new AbortController(),reason=fault('CANCELLED');
 let rejectOriginal;
 const original=new Promise((resolve,reject)=>{rejectOriginal=reject;});
 const waiting=abortable(original,controller.signal);
 controller.abort(reason);
 await assert.rejects(waiting,error=>error===reason);
 assert.equal(listenerCount(controller.signal),0);
 rejectOriginal(new Error('Late failure'));
 await nextTurn();
});

test('abortable consumes an underlying rejection when the signal is already cancelled',async()=>{
 const controller=new AbortController(),reason=fault('CANCELLED');
 controller.abort(reason);
 await assert.rejects(abortable(Promise.reject(new Error('Late failure')),controller.signal),error=>error===reason);
 await nextTurn();
});

test('abortable supports an operation without a cancellation signal',async()=>{
 assert.equal(await abortable(Promise.resolve('result')),'result');
});

test('abortable supplies CANCELLED when the signal has no reason',async()=>{
 const controller=new AbortController();
 Object.defineProperty(controller.signal,'reason',{value:undefined});
 controller.abort();
 await assert.rejects(abortable(new Promise(()=>{}),controller.signal),error=>error.code==='CANCELLED');
});

test('delay completion removes its cancellation listener and timer',async()=>{
 const controller=new AbortController(),before=timerCount();
 await delay(1,controller.signal);
 await nextTurn();
 assert.equal(listenerCount(controller.signal),0);
 assert.equal(timerCount(),before);
});

test('delay cancellation clears its 30-second timer and listener',async()=>{
 const controller=new AbortController(),reason=fault('CANCELLED'),before=timerCount();
 const waiting=delay(30000,controller.signal);
 assert.equal(listenerCount(controller.signal),1);
 assert.equal(timerCount(),before+1);
 controller.abort(reason);
 await assert.rejects(waiting,error=>error===reason);
 assert.equal(listenerCount(controller.signal),0);
 assert.equal(timerCount(),before);
});

test('an already-cancelled delay adds no timer or listener',async()=>{
 const controller=new AbortController(),reason=fault('CANCELLED');
 controller.abort(reason);
 const before=timerCount();
 await assert.rejects(delay(30000,controller.signal),error=>error===reason);
 assert.equal(listenerCount(controller.signal),0);
 assert.equal(timerCount(),before);
});

test('delay works without a cancellation signal',async()=>{
 assert.equal(await delay(1),undefined);
});

test('delay supplies CANCELLED when the signal has no reason',async()=>{
 const controller=new AbortController();
 Object.defineProperty(controller.signal,'reason',{value:undefined});
 const waiting=delay(30000,controller.signal);
 controller.abort();
 await assert.rejects(waiting,error=>error.code==='CANCELLED');
});

test('codeOf exposes only bounded uppercase error codes',()=>{
 for(const code of ['A','CANCELLED','TLS_FAILED_2','A'.repeat(51)])assert.equal(codeOf({code}),code);
 for(const code of ['', 'lowercase', '2FAILED', 'AUTH token=fixture', 'VALID\n', 'A'.repeat(52), 123, null, undefined]){
  assert.equal(codeOf({code}),'CONNECTION_FAILED');
 }
 for(const error of [null,undefined,'CANCELLED',new Error('Sensitive fixture message')]){
  assert.equal(codeOf(error),'CONNECTION_FAILED');
 }
});

test('codeOf does not coerce arbitrary values into error codes',()=>{
 let coerced=false;
 const code={toString(){coerced=true;return 'CANCELLED';}};
 assert.equal(codeOf({code}),'CONNECTION_FAILED');
 assert.equal(coerced,false);
});
