export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
    if (url.pathname === '/api/broker') {
      if (request.method !== 'POST') return Response.json({error:'POST required.'},{status:405,headers});
      const origin=request.headers.get('Origin');
      if (origin && origin !== url.origin) return Response.json({error:'Origin rejected.'},{status:403,headers});
      if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({error:'JSON required.'},{status:415,headers});
      try {
        const raw=await request.text();
        if (raw.length>20000) return Response.json({error:'Request too large.'},{status:413,headers});
        const body=JSON.parse(raw);
        const result=await brokerAction(body);
        return Response.json(result,{headers});
      } catch(error) {
        const message=error.name==='TimeoutError'?'Broker timed out. Try again.':error instanceof SyntaxError?'Invalid JSON.':error.message || 'Broker request failed.';
        return Response.json({error:message},{status:400,headers});
      }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed',{status:405,headers});
    const path=url.pathname === '/'?'/index.html':url.pathname;
    const asset=ASSETS[path];
    if (!asset) return new Response('Not found',{status:404,headers});
    headers['Content-Type']=asset.type;
    headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'";
    return new Response(request.method==='HEAD'?null:asset.body,{headers});
  }
};
