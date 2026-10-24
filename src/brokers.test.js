import test from 'node:test';
import assert from 'node:assert/strict';

const credentials = {apiKey:'test_key', accessToken:'test_token'};
const NOW = new Date('2026-10-23T09:02:00Z'); // 14:32 IST, during the session.
let moduleId = 0;
async function setup(t, responses = []) {
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    calls.push({url,init});
    assert.equal(init.method ?? 'GET','GET','broker adapter must only read');
    const next = responses.shift();
    assert.notEqual(next, undefined, 'unexpected upstream request: '+url);
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {status:next.status ?? 200});
  });
  const api = await import('./brokers.js?test='+moduleId++);
  return {...api,calls};
}
const kite = data => ({body:{status:'success',data}});
const groww = payload => ({body:{status:'SUCCESS',payload}});
const bar = time => [time,100,105,99,103,200,42];
const growwCSV = 'exchange,trading_symbol,groww_symbol,name,isin,underlying_symbol,segment,instrument_type,expiry_date,strike_price,lot_size\nNSE,M&M,NSE-M&M,Mahindra,INEMM,,CASH,EQ,,,1\nNSE,NIFTY26OCT25000CE,NSE-NIFTY-27Oct26-25000-CE,,,NIFTY,FNO,CE,2026-10-27,25000,65\nBSE,BSEONLY,BSE-BSEONLY,Only BSE,INEBSE,,CASH,EQ,,,1\nBSE,SENSEX26OCT80000CE,BSE-SENSEX-29Oct26-80000-CE,,,SENSEX,FNO,CE,2026-10-29,80000,20\n';

test('Kite holdings use the read endpoint and preserve T1 separately',async t=>{
  const api=await setup(t,[kite([{tradingsymbol:'M&M',exchange:'NSE',instrument_token:123,isin:'INEMM',quantity:10,t1_quantity:2,average_price:200}])]);
  const r=await api.brokerAction({broker:'kite',credentials,action:'holdings'});
  assert.equal(api.calls[0].url.href,'https://api.kite.trade/portfolio/holdings');
  assert.deepEqual(api.calls[0].init.headers,{'X-Kite-Version':'3',Authorization:'token test_key:test_token'});
  assert.equal(r.holdings[0].quantity,10);
  assert.equal(r.holdings[0].t1_quantity,2);
  assert.equal(r.holdings[0].token,'123');
});

test('Groww holdings resolve ISIN through public master without forwarding credentials',async t=>{
  const api=await setup(t,[groww({holdings:[{trading_symbol:'BSEONLY',isin:'INEBSE',quantity:2,average_price:100},{trading_symbol:'UNKNOWN',isin:'UNKNOWN',quantity:1}]}),{body:growwCSV}]);
  const r=await api.brokerAction({broker:'groww',credentials,action:'holdings'});
  assert.equal(api.calls[0].url.pathname,'/v1/holdings/user');
  assert.equal(api.calls[0].init.headers.Authorization,'Bearer test_token');
  assert.equal(api.calls[0].init.headers['X-API-VERSION'],'1.0');
  assert.equal(api.calls[1].url.href,'https://growwapi-assets.groww.in/instruments/instrument.csv');
  assert.deepEqual(api.calls[1].init.headers,{});
  assert.equal(r.holdings[0].exchange,'BSE');
  assert.equal(r.holdings[0].token,'BSE-BSEONLY');
  assert.equal(r.holdings[1].exchangeUnresolved,true);
  assert.equal(r.holdings[1].exchange,'');
});

test('Kite quote batches repeated i values and handles missing instruments',async t=>{
  const api=await setup(t,[kite({'NSE:M&M':{timestamp:'2026-10-23 14:32:00',last_trade_time:'2026-10-23 14:30:00',last_price:110,ohlc:{close:100},depth:{buy:[{price:109}],sell:[{price:111}]},oi:500,volume:2000}})]);
  const r=await api.brokerAction({broker:'kite',credentials,action:'quotes',symbols:['NSE:M&M','NSE:NIFTY 50']});
  assert.deepEqual(api.calls[0].url.searchParams.getAll('i'),['NSE:M&M','NSE:NIFTY 50']);
  assert.equal(r.quotes['M&M'].timestamp,NOW.toISOString());
  assert.equal(r.quotes['M&M'].isStale,false);
  assert.equal(r.quotes['M&M'].change,10);
  assert.ok(Math.abs(r.quotes['M&M'].changePercent-10)<1e-10);
  assert.equal(r.quotes['M&M'].bid,109);
  assert.equal(r.quotes['NIFTY 50'],undefined);
});

test('Groww quotes normalize epoch milliseconds and derivative exchange',async t=>{
  const api=await setup(t,[groww({last_price:45,last_trade_time:NOW.getTime(),day_change:2,day_change_perc:4.65,open_interest:300,depth:{buy:[{price:44}],sell:[{price:46}]}})]);
  const r=await api.brokerAction({broker:'groww',credentials,action:'quotes',symbol:'SENSEX26OCT80000CE',exchange:'BFO'});
  assert.equal(api.calls[0].url.pathname,'/v1/live-data/quote');
  assert.equal(api.calls[0].url.searchParams.get('exchange'),'BSE');
  assert.equal(api.calls[0].url.searchParams.get('segment'),'FNO');
  assert.equal(r.quotes.SENSEX26OCT80000CE.oi,300);
  assert.equal(r.quotes.SENSEX26OCT80000CE.timestamp,NOW.toISOString());
});

test('Kite instruments parse quoted CSV and retain contract metadata',async t=>{
  const api=await setup(t,[{body:'instrument_token,tradingsymbol,name,exchange,segment,instrument_type,expiry,strike,lot_size\n123,NIFTY26OCT25000CE,"NIFTY, INDEX",NFO,NFO-OPT,CE,2026-10-27,25000,65\n'}]);
  const r=await api.brokerAction({broker:'kite',credentials,action:'search',query:'NIFTY',segment:'FNO'});
  assert.equal(api.calls[0].url.pathname,'/instruments/NFO');
  assert.equal(r.instruments[0].name,'NIFTY, INDEX');
  assert.equal(r.instruments[0].lotSize,65);
  assert.equal(r.instruments[0].expiry,'2026-10-27');
  assert.equal(r.instruments[0].strike,25000);
});

test('Groww search filters cash and FNO and accepts ampersand symbols',async t=>{
  const api=await setup(t,[{body:growwCSV}]);
  const r=await api.brokerAction({broker:'groww',credentials,action:'search',query:'M&M'});
  assert.equal(r.instruments.length,1);
  assert.equal(r.instruments[0].growwSymbol,'NSE-M&M');
  const d=await api.brokerAction({broker:'groww',credentials,action:'search',query:'NIFTY',segment:'FNO'});
  assert.equal(d.instruments.length,1);
  assert.equal(d.instruments[0].instrumentType,'CE');
  assert.equal(api.calls.length,1,'master is reused');
});

test('Kite daily history excludes current unfinished daily bar and converts IST',async t=>{
  const api=await setup(t,[kite({candles:[bar('2026-10-22T00:00:00+0530'),bar('2026-10-23T00:00:00+0530')]})]);
  const r=await api.brokerAction({broker:'kite',credentials,action:'candles',token:123,interval:'day',from:'2026-10-01T00:00:00+05:30'});
  assert.equal(api.calls[0].url.pathname,'/instruments/historical/123/day');
  assert.equal(api.calls[0].url.searchParams.get('from'),'2026-10-01 00:00:00');
  assert.equal(api.calls[0].url.searchParams.get('oi'),'1');
  assert.equal(r.candles.length,1);
  assert.equal(r.candles[0].time,'2026-10-21T18:30:00.000Z');
  assert.equal(r.candles[0].oi,42);
  assert.equal(r.completedOnly,true);
});

test('Groww daily uses nondeprecated endpoint, groww_symbol and 1day interval',async t=>{
  const api=await setup(t,[groww({candles:[bar('2026-10-22T00:00:00')]})]);
  await api.brokerAction({broker:'groww',credentials,action:'candles',token:'NSE-M&M',exchange:'NSE',interval:'day'});
  const url=api.calls[0].url;
  assert.equal(url.pathname,'/v1/historical/candles');
  assert.equal(url.searchParams.get('groww_symbol'),'NSE-M&M');
  assert.equal(url.searchParams.get('candle_interval'),'1day');
  assert.equal(url.searchParams.get('segment'),'CASH');
});

test('5minute history drops incomplete and future bars while retaining just-completed bar',async t=>{
  const api=await setup(t,[groww({candles:[bar('2026-10-23T14:25:00'),bar('2026-10-23T14:27:00'),bar('2026-10-23T14:30:00'),bar('2026-10-23T14:35:00')]})]);
  const r=await api.brokerAction({broker:'groww',credentials,action:'candles',token:'NSE-M&M',interval:'5minute'});
  assert.equal(api.calls[0].url.searchParams.get('candle_interval'),'5minute');
  assert.equal(r.candles.length,2);
  assert.equal(r.asOf,'2026-10-23T08:57:00.000Z');
});

for(const [status,pattern] of [[401,/expired/i],[403,/denied/i],[429,/rate limit/i],[500,/HTTP 500/]]) {
  test('HTTP '+status+' produces an actionable sanitized failure',async t=>{
    const api=await setup(t,[{status,body:'SECRET UPSTREAM DEBUG'}]);
    await assert.rejects(api.brokerAction({broker:'kite',credentials,action:'holdings'}),pattern);
  });
}

test('broker failure envelope never turns into an empty successful portfolio',async t=>{
  const api=await setup(t,[{body:{status:'FAILURE',error:{message:'private'}}}]);
  await assert.rejects(api.brokerAction({broker:'groww',credentials,action:'holdings'}),/rejected/);
});

test('invalid credentials, symbols, ranges and operations reject before fetch',async t=>{
  const api=await setup(t);
  for(const change of [
    {credentials:{accessToken:'x\nAuthorization: bad'}},
    {action:'orders'},
    {action:'quotes',symbol:'../../orders'},
    {action:'quotes',symbols:[]},
    {action:'quotes',symbols:Array(51).fill('M&M')},
    {action:'quotes',symbol:'M&M',exchange:'EVIL'},
    {action:'candles',token:123,from:'bad'},
    {action:'candles',token:123,from:'2020-01-01',to:'2026-01-01'},
    {action:'candles',token:'../orders'},
  ]) await assert.rejects(api.brokerAction({broker:'kite',credentials,action:'holdings',...change}));
  assert.equal(api.calls.length,0);
});

test('exchangeTime treats exchange wall time as IST and tolerates invalid inputs',async t=>{
  const api=await setup(t);
  assert.equal(api.exchangeTime('2026-10-23 14:32:00'),NOW.toISOString());
  assert.equal(api.exchangeTime(NOW.getTime()/1000),NOW.toISOString());
  assert.equal(api.exchangeTime('not a date'),null);
  assert.equal(api.exchangeTime(null),null);
  assert.equal(api.exchangeTime(Infinity),null);
});

test('future quote timestamp is not accepted as fresh',async t=>{
  const api=await setup(t,[kite({'NSE:M&M':{timestamp:'2026-10-24 14:32:00',last_price:100}})]);
  const r=await api.brokerAction({broker:'kite',credentials,action:'quotes',symbol:'M&M'});
  assert.equal(r.quotes['M&M'].isStale,true);
});

test('Groww BFO historical request maps to BSE and FNO',async t=>{
  const api=await setup(t,[groww({candles:[]})]);
  await api.brokerAction({broker:'groww',credentials,action:'candles',token:'BSE-SENSEX-29Oct26-80000-CE',exchange:'BFO',interval:'5minute'});
  assert.equal(api.calls[0].url.searchParams.get('exchange'),'BSE');
  assert.equal(api.calls[0].url.searchParams.get('segment'),'FNO');
});

test('Groww BFO instrument search maps to BSE master entries',async t=>{
  const api=await setup(t,[{body:growwCSV}]);
  const r=await api.brokerAction({broker:'groww',credentials,action:'search',query:'SENSEX',exchange:'BFO',segment:'FNO'});
  assert.equal(r.instruments.length,1);
});

test('Groww derivative candle token fallback resolves normalized master exchange',async t=>{
  const api=await setup(t,[{body:growwCSV},groww({candles:[]})]);
  await api.brokerAction({broker:'groww',credentials,action:'candles',symbol:'NIFTY26OCT25000CE',exchange:'NFO',interval:'5minute'});
  assert.equal(api.calls[1].url.searchParams.get('groww_symbol'),'NSE-NIFTY-27Oct26-25000-CE');
  assert.equal(api.calls[1].url.searchParams.get('exchange'),'NSE');
  assert.equal(api.calls[1].url.searchParams.get('segment'),'FNO');
});

test('unsupported candle interval rejects rather than silently switching to daily',async t=>{
  const api=await setup(t,[kite({candles:[]})]);
  await assert.rejects(api.brokerAction({broker:'kite',credentials,action:'candles',token:123,interval:'garbage'}),/interval/i);
  assert.equal(api.calls.length,0);
});

test('invalid Groww candle exchange rejects before upstream',async t=>{
  const api=await setup(t,[groww({candles:[]})]);
  await assert.rejects(api.brokerAction({broker:'groww',credentials,action:'candles',token:'NSE-M&M',exchange:'EVIL',interval:'day'}),/exchange/i);
  assert.equal(api.calls.length,0);
});
