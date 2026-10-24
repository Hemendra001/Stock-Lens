import http from 'node:http';
import worker from '../worker/index.js';
const host='127.0.0.1',port=Number(process.env.PORT||4173);
http.createServer(async(req,res)=>{
 try {
  const chunks=[];for await(const c of req)chunks.push(c);
  const r=new Request('http://'+host+':'+port+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
  const out=await worker.fetch(r,{});res.writeHead(out.status,Object.fromEntries(out.headers));res.end(Buffer.from(await out.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Server error');}
}).listen(port,host,()=>console.log('StockLens preview: http://'+host+':'+port));
