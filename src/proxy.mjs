import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import {fault,scope} from './async-control.mjs';

const reason=signal=>signal?.reason??fault('CANCELLED');

function read(socket,n,signal){
 return new Promise((resolve,reject)=>{
  let buffer=Buffer.alloc(0),settled=false;
  const cleanup=()=>{
   socket.off('data',onData);socket.off('error',onError);
   socket.off('end',onClosed);socket.off('close',onClosed);
   signal?.removeEventListener('abort',onAbort);
  };
  const finish=(error,value)=>{
   if(settled)return;
   settled=true;socket.pause();cleanup();
   if(error)reject(error);else resolve(value);
  };
  const onError=error=>finish(error);
  const onClosed=()=>finish(fault('SOCKS_CLOSED'));
  const onAbort=()=>finish(reason(signal));
  const onData=chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   if(buffer.length<n)return;
   socket.pause();
   if(buffer.length>n)socket.unshift(buffer.subarray(n));
   finish(null,buffer.subarray(0,n));
  };
  if(signal?.aborted){onAbort();return;}
  if(socket.destroyed||socket.readableEnded){onClosed();return;}
  socket.on('data',onData);socket.once('error',onError);
  socket.once('end',onClosed);socket.once('close',onClosed);
  signal?.addEventListener('abort',onAbort,{once:true});socket.resume();
 });
}

function connected(socket,signal){
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{
   socket.off('connect',onConnect);socket.off('error',onError);
   socket.off('end',onClosed);socket.off('close',onClosed);
   signal?.removeEventListener('abort',onAbort);
  };
  const finish=error=>{cleanup();if(error)reject(error);else resolve();};
  const onConnect=()=>finish();
  const onError=error=>finish(error);
  const onClosed=()=>finish(fault('SOCKS_CLOSED'));
  const onAbort=()=>finish(reason(signal));
  if(signal?.aborted){onAbort();return;}
  if(socket.destroyed){onClosed();return;}
  socket.once('connect',onConnect);socket.once('error',onError);
  socket.once('end',onClosed);socket.once('close',onClosed);
  signal?.addEventListener('abort',onAbort,{once:true});
 });
}

export async function socksConnect(proxyPort,host,port=443,{signal,onSocket=()=>{}}={}){
 if(signal?.aborted)throw reason(signal);
 const domain=typeof host==='string'?Buffer.from(host):Buffer.alloc(0);
 if(!domain.length||domain.length>255)throw fault('SOCKS_HOST');
 const destinationPort=Buffer.alloc(2);destinationPort.writeUInt16BE(port);
 const socket=net.connect({port:proxyPort,host:'127.0.0.1',signal});
 // A socket can emit an error between awaited reads, or during teardown.
 socket.on('error',()=>{});
 try{
  onSocket(socket);
  await connected(socket,signal);
  socket.write(Buffer.from([5,1,0]));
  const hello=await read(socket,2,signal);
  if(hello[0]!==5||hello[1]!==0)throw fault('SOCKS_AUTH');
  socket.write(Buffer.concat([Buffer.from([5,1,0,3,domain.length]),domain,destinationPort]));
  const reply=await read(socket,4,signal);
  if(reply[0]!==5||reply[1]!==0||reply[2]!==0)throw fault('SOCKS_REJECTED');
  if(reply[3]===1)await read(socket,6,signal);
  else if(reply[3]===4)await read(socket,18,signal);
  else if(reply[3]===3){const length=await read(socket,1,signal);await read(socket,length[0]+2,signal);}
  else throw fault('SOCKS_ADDRESS');
  if(signal?.aborted)throw reason(signal);
  return socket;
 }catch(error){socket.destroy();throw signal?.aborted?reason(signal):error;}
}

export async function tunnelRequest(proxyPort,url,{headers={},timeout=25000,signal}={}){
 const u=new URL(url);
 if(u.protocol!=='https:')throw fault('HTTPS_REQUIRED');
 const operation=scope(signal,timeout),sockets=new Set();
 const agent=new https.Agent({keepAlive:false,maxSockets:1});
 let req,cancelConnection=()=>{};
 const track=socket=>{sockets.add(socket);socket.on('error',()=>{});return socket;};
 try{
  if(operation.signal.aborted)throw operation.signal.reason;
  return await new Promise((resolve,reject)=>{
   let settled=false;
   const finish=(error,result)=>{
    if(settled)return;
    settled=true;operation.signal.removeEventListener('abort',onAbort);
    // Destroying a stalled TLSSocket alone does not settle a custom Agent callback.
    cancelConnection(error instanceof Error?error:fault(operation.signal.aborted?'CANCELLED':'TUNNEL_CLOSED'));
    if(operation.signal.aborted)reject(operation.signal.reason);
    else if(error)reject(error);
    else resolve(result);
   };
   const onAbort=()=>finish(operation.signal.reason);
   operation.signal.addEventListener('abort',onAbort,{once:true});
   agent.createConnection=(_options,callback)=>{
    let complete=false,secure;
    const connectionDone=(error,socket)=>{
     if(complete)return;
     complete=true;
     secure?.off('secureConnect',onSecure);secure?.off('error',onError);secure?.off('close',onClose);
     callback(error,socket);
    };
    const onSecure=()=>connectionDone(null,secure);
    const onError=error=>{connectionDone(error);finish(error);};
    const onClose=()=>onError(fault('TLS_CLOSED'));
    cancelConnection=error=>connectionDone(error);
    socksConnect(proxyPort,u.hostname,Number(u.port)||443,{signal:operation.signal,onSocket:track}).then(socket=>{
     if(settled||operation.signal.aborted){socket.destroy();connectionDone(operation.signal.reason||fault('TUNNEL_CLOSED'));return;}
     try{
      secure=track(tls.connect({socket,servername:u.hostname,rejectUnauthorized:true,signal:operation.signal}));
      secure.once('secureConnect',onSecure);secure.once('error',onError);secure.once('close',onClose);
      socket.resume();
     }catch(error){onError(error);}
    },onError);
   };
   try{
    req=https.get(u,{agent,signal:operation.signal,headers:{'User-Agent':'ArgoDesktop/0.3.0',...headers}},res=>{
     const chunks=[];let bytes=0;
     res.on('data',chunk=>{
      if(settled)return;
      bytes+=chunk.length;
      if(bytes>262144){finish(fault('RESPONSE_TOO_LARGE'));req?.destroy();return;}
      chunks.push(chunk);
     });
     res.on('error',error=>finish(error));
     res.on('aborted',()=>finish(fault('RESPONSE_CLOSED')));
     res.on('end',()=>finish(null,{status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',error=>finish(error));
   }catch(error){finish(error);}
  });
 }finally{
  operation.dispose();cancelConnection(operation.signal.reason||fault('TUNNEL_CLOSED'));
  req?.destroy();for(const socket of sockets)socket.destroy();agent.destroy();
 }
}
