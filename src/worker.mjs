import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {loadConfig,serversFrom,authenticate} from './prototype.mjs';
import {startEngine,chooseProxyPort} from './engine.mjs';
import {verifyTraffic,pingSession,disconnectSession} from './traffic-probe.mjs';
import {attemptConnection} from './connection-attempt.mjs';
import {supervise} from './connection-supervisor.mjs';
import {captureNetwork,compareNetwork} from './windows-network.mjs';
import {fault,codeOf} from './async-control.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=process.env.ARGO_DATA_DIR||path.join(process.env.LOCALAPPDATA||ROOT,'ArgoDesktop');
const root=new AbortController();
const report={version:'0.3.0',startedAt:new Date().toISOString(),tunnelVerified:false};
let reportPath=path.join(DATA,'reports','latest.json'),started=false,finished=false,periodic,testTimer;
const line=readline.createInterface({input:process.stdin,terminal:false});
process.stdout.on('error',()=>{});
const messages={
 INVALID_COMMAND:'دستور نامعتبر است.',INVALID_OPTIONS:'گزینه‌های اتصال معتبر نیست.',
 INTEGRITY_FAILED:'یکپارچگی فایل‌های برنامه تأیید نشد.',CONFIG_UNAVAILABLE:'دریافت تنظیمات ممکن نشد.',
 REPORT_WRITE_FAILED:'ذخیره گزارش اتصال ممکن نشد.',CLEANUP_FAILED:'پاک‌سازی اتصال تأیید نشد.'
};
const messageFor=code=>messages[code]||'اتصال برقرار نشد. دوباره تلاش کنید.';
function emit(type,values={}){
 if(!process.stdout.destroyed)process.stdout.write(JSON.stringify({type,...values,at:new Date().toISOString()})+'\n');
}
function save(){
 try{
  fs.mkdirSync(path.dirname(reportPath),{recursive:true});
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
 }catch{throw fault('REPORT_WRITE_FAILED');}
}
function fail(error){
 const code=codeOf(error);
 if(!report.errorCode){report.errorCode=code;report.error=messageFor(code);emit('error',{errorCode:code,message:report.error});}
}
function cancel(){
 report.stopRequestedAt ||= new Date().toISOString();
 if(!root.signal.aborted)root.abort(fault('CANCELLED'));
}
function state(type,values){
 if(type==='state')report.lastStage=values.stage;
 try{save();}catch(error){fail(error);cancel();throw error;}
 emit(type,values);
}
function validate(options){
 if(!['proxy','full'].includes(options.mode)||!['global','ir'].includes(options.profile)||
  !Number.isInteger(options.port)||options.port<1024||options.port>65535||
  (options.reportPath!==undefined&&(typeof options.reportPath!=='string'||!path.isAbsolute(options.reportPath)||options.reportPath.includes('\0'))))throw fault('INVALID_OPTIONS');
}
async function run(options){
 try{
  // Stop is a latch, including when it precedes the first start command.
  root.signal.throwIfAborted();validate(options);
  if(options.reportPath!==undefined)reportPath=options.reportPath;
  report.mode=options.mode;report.requestedPort=options.port;
  try{
   fs.mkdirSync(path.join(DATA,'runtime'),{recursive:true});
   fs.mkdirSync(path.join(DATA,'reports'),{recursive:true});
  }catch{throw fault('REPORT_WRITE_FAILED');}
  periodic=setInterval(()=>{
   try{save();}catch(error){fail(error);cancel();}
  },5000);
  const deps={now:Date.now,authenticate:(candidate,signal)=>authenticate(candidate,'A',{signal}),
   lookup:host=>dns.lookup(host,{family:4}),choosePort:chooseProxyPort,
   startEngine:(session,engineOptions)=>startEngine(session,{...engineOptions,
    exe:path.join(ROOT,'bin','sing-box.exe'),workDir:path.join(DATA,'runtime')}),
   verifyTraffic,pingSession,disconnect:disconnectSession,captureNetwork,compareNetwork};
  await supervise({signal:root.signal,report,
   loadCandidates:async signal=>{
    signal.throwIfAborted();
    try{
     const integrity=JSON.parse(fs.readFileSync(path.join(ROOT,'integrity.json'),'utf8'));
     for(const relative of ['bin/sing-box.exe','bin/wintun.dll']){
      const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,relative))).digest('hex');
      if(actual!==integrity[relative])throw fault('INTEGRITY_FAILED');
     }
    }catch{throw fault('INTEGRITY_FAILED');}
    signal.throwIfAborted();let config;
    try{config=await loadConfig(undefined,{signal});signal.throwIfAborted();report.configurationSource='online';}
    catch(error){
     signal.throwIfAborted();
     config=await loadConfig(path.join(ROOT,'config-signed.txt'),{signal});
     signal.throwIfAborted();report.configurationSource='signed-snapshot';
    }
    report.configurationVerified=true;report.configSerial=config.serial;
    return serversFrom(config.config,options.profile);
   },
   attempt:(candidate,attemptOptions)=>attemptConnection(candidate,{...attemptOptions,
    mode:options.mode,requestedPort:report.proxy?.actualPort||options.port},deps),
   emit:(type,values)=>{
    state(type,values);
    if(type==='state'&&values.stage==='connected'&&!testTimer&&
     Number.isFinite(options.testSeconds)&&options.testSeconds>0&&options.testSeconds<=7200){
     testTimer=setTimeout(()=>{report.stopReason='test-complete';cancel();},options.testSeconds*1000);
    }
   }
  });
 }catch(error){if(codeOf(error)!=='CANCELLED')fail(error);}
 finally{
  // supervise settles only after its current owner has finished cleanup.
  finished=true;clearInterval(periodic);clearTimeout(testTimer);
  report.stopReason ||= report.errorCode?'failed':'requested';
  report.completedAt=new Date().toISOString();report.lastStage='disconnected';
  try{save();}catch(error){fail(error);report.stopReason='failed';}
  line.close();
  const exitCode=report.errorCode?1:0;process.exitCode=exitCode;
  // A caller may keep stdin open, and native DNS may retain a handle. Only
  // after awaited cleanup and final persistence, flush terminal JSON and exit.
  const fallback=setTimeout(()=>process.exit(exitCode),80);
  if(process.stdout.destroyed){clearTimeout(fallback);process.exit(exitCode);}
  else process.stdout.write(JSON.stringify({type:'state',stage:'disconnected',reportPath,at:new Date().toISOString()})+'\n',()=>{
   clearTimeout(fallback);process.exit(exitCode);
  });
 }
}
line.on('line',text=>{
 let command;
 try{command=JSON.parse(text);}catch{emit('error',{errorCode:'INVALID_COMMAND',message:messageFor('INVALID_COMMAND')});return;}
 if(!command||typeof command!=='object'||Array.isArray(command)||!['start','stop'].includes(command.cmd)){
  emit('error',{errorCode:'INVALID_COMMAND',message:messageFor('INVALID_COMMAND')});return;
 }
 if(command.cmd==='stop')cancel();
 else if(!started){started=true;void run(command);}
});
line.on('close',()=>{if(!finished){cancel();if(!started){started=true;void run({});}}});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{cancel();if(!started){started=true;void run({});}});
emit('ready');
