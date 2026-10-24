// Read-only broker adapters. Credentials are request-scoped and never cached or logged.
const masters = new Map();
const num = v => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
export function exchangeTime(value) {
  if (!value) return null;
  if (typeof value === 'number') { const d=new Date(value < 1e12 ? value * 1000 : value); return Number.isFinite(d.getTime())?d.toISOString():null; }
  let s = String(value).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += '+05:30';
  return Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
}
export function parseCSV(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value.trim()); value = ''; }
    else if (c === '\n' && !quoted) { row.push(value.trim()); if (row.some(Boolean)) rows.push(row); row = []; value = ''; }
    else if (c !== '\r') value += c;
  }
  if (value || row.length) { row.push(value.trim()); rows.push(row); }
  if (quoted) throw new Error('Malformed instrument CSV.');
  const fields = (rows.shift() || []).map(x => x.replace(/^\uFEFF/, '').toLowerCase());
  return rows.map(r => Object.fromEntries(fields.map((f, i) => [f, r[i] || ''])));
}
function safeString(value, name, pattern = /^[A-Za-z0-9 &_:.\-]{1,90}$/) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid ' + name + '.');
  return value;
}
function auth(broker, credentials = {}) {
  const token = safeString(credentials.accessToken, 'access token', /^[A-Za-z0-9_.\-=+/]{5,8192}$/);
  if (broker === 'kite') return { 'X-Kite-Version': '3', Authorization: 'token ' + safeString(credentials.apiKey, 'API key', /^[A-Za-z0-9_-]{4,200}$/) + ':' + token };
  if (broker === 'groww') return { Authorization: 'Bearer ' + token, 'X-API-VERSION': '1.0', Accept: 'application/json' };
  throw new Error('Choose Kite or Groww.');
}
async function upstream(url, headers, text = false) {
  const response = await fetch(url, {headers, redirect:'error', signal:AbortSignal.timeout(20000)});
  if (!response.ok) {
    const hints = {401:'Session expired. Reconnect with a fresh broker token.',403:'Access denied. Check your token and market-data subscription.',429:'Broker rate limit reached. Wait before refreshing.'};
    throw new Error(hints[response.status] || 'Broker request failed (HTTP ' + response.status + ').');
  }
  if (text) return response.text();
  const result = await response.json();
  if (!['success','SUCCESS'].includes(result.status)) throw new Error('Broker rejected the request. Check account permissions, instrument and date range.');
  return result.data ?? result.payload;
}
function urlFor(broker, path, params = {}) {
  const url = new URL(path, broker === 'kite' ? 'https://api.kite.trade' : 'https://api.groww.in');
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
  return url;
}
async function master(broker, headers, exchange = 'NSE') {
  const key = broker + ':' + exchange;
  const prior = masters.get(key);
  if (prior && Date.now() - prior.time < 6 * 3600000) return prior.rows;
  const url = broker === 'kite' ? urlFor(broker, '/instruments/' + exchange) : 'https://growwapi-assets.groww.in/instruments/instrument.csv';
  const csv = await upstream(url, broker === 'kite' ? headers : {}, true);
  const rows = parseCSV(csv).map(r => ({
    symbol:r.tradingsymbol || r.trading_symbol, token:r.instrument_token || r.groww_symbol,
    growwSymbol:r.groww_symbol, exchange:r.exchange, name:r.name || r.underlying_symbol || r.trading_symbol,
    underlyingSymbol:r.underlying_symbol || r.name || null,
    isin:r.isin, segment:r.segment, lotSize:num(r.lot_size), expiry:r.expiry || r.expiry_date || null,
    strike:num(r.strike || r.strike_price), instrumentType:r.instrument_type,
    verified:true, verifiedAt:new Date().toISOString()
  })).filter(r => r.symbol && r.exchange);
  masters.set(key,{time:Date.now(), rows});
  return rows;
}
function qNormalize(q, broker) {
  const price = num(q.last_price), prior = num(q.ohlc?.close);
  const timestamp = exchangeTime(broker === 'kite' ? q.timestamp : q.last_trade_time);
  return { price, lastPrice:price, change:num(q.day_change) ?? (price != null && prior ? price - prior : null),
    changePercent:num(q.day_change_perc) ?? (price != null && prior ? (price / prior - 1) * 100 : null),
    timestamp, asOf:timestamp, volume:num(q.volume), oi:num(q.oi ?? q.open_interest),
    bid:num(q.depth?.buy?.[0]?.price) ?? num(q.bid_price), ask:num(q.depth?.sell?.[0]?.price) ?? num(q.offer_price), source:broker,
    isStale:!timestamp || Date.now() - Date.parse(timestamp) > 90000 || Date.parse(timestamp)>Date.now()+60000,
    retrievedAt:new Date().toISOString() };
}
function fullSymbols(body) {
  const list = body.symbols || [body.symbol];
  if (!Array.isArray(list) || list.length < 1 || list.length > 50) throw new Error('Request between 1 and 50 symbols.');
  return list.map(item => {
    let symbol, exchange;
    if (typeof item === 'object') { symbol=item.symbol; exchange=item.exchange; }
    else { const parts=String(item).split(':'); symbol=parts.pop(); exchange=parts[0] || body.exchange || 'NSE'; }
    if (!['NSE','BSE','NFO','BFO'].includes(exchange)) throw new Error('Unsupported exchange.');
    return {symbol:safeString(symbol, 'symbol'), exchange};
  });
}
async function quotes(body, headers) {
  const symbols=fullSymbols(body), out={};
  if (body.broker === 'kite') {
    const url=urlFor('kite','/quote');
    symbols.forEach(s=>url.searchParams.append('i',s.exchange+':'+s.symbol));
    const data=await upstream(url,headers);
    for (const s of symbols) if (data[s.exchange+':'+s.symbol]) {
      const quote=qNormalize(data[s.exchange+':'+s.symbol],'kite');
      out[s.exchange+':'+s.symbol]=quote; out[s.symbol]=quote;
    }
  } else {
    // Sequential requests keep one batch below 5/sec. Other apps share the broker quota.
    for (const s of symbols) {
      const data=await upstream(urlFor('groww','/v1/live-data/quote',{
        exchange:s.exchange === 'NFO' ? 'NSE' : s.exchange === 'BFO' ? 'BSE' : s.exchange,
        segment:body.segment || (['NFO','BFO'].includes(s.exchange)?'FNO':'CASH'), trading_symbol:s.symbol
      }),headers);
      const quote=qNormalize(data,'groww'); out[s.exchange+':'+s.symbol]=quote; out[s.symbol]=quote;
      if (symbols.length>1) await new Promise(r=>setTimeout(r,220));
    }
  }
  return {quotes:out,source:body.broker,retrievedAt:new Date().toISOString()};
}
function istDate(date) { return new Date(date.getTime()+19800000).toISOString().slice(0,19).replace('T',' '); }
export async function brokerAction(body) {
  const broker=body.broker, headers=auth(broker,body.credentials);
  if (body.action === 'holdings') {
    const data=await upstream(urlFor(broker,broker === 'kite'?'/portfolio/holdings':'/v1/holdings/user'),headers);
    let instruments=[];
    if (broker === 'groww') instruments=await master(broker,headers);
    const holdings=(broker === 'kite'?data:data.holdings || []).map(r=>{
      const m=broker === 'groww' ? instruments.find(i=>i.isin === r.isin && i.symbol === r.trading_symbol && i.exchange==='NSE') || instruments.find(i=>i.isin === r.isin && i.symbol === r.trading_symbol) : null;
      return {symbol:r.tradingsymbol || r.trading_symbol, exchange:r.exchange || m?.exchange || '',
        token:String(r.instrument_token || m?.token || ''), quantity:num(r.quantity) || 0,
        t1_quantity:num(r.t1_quantity) || 0, average_price:num(r.average_price),
        source:broker,isin:r.isin, exchangeUnresolved:broker === 'groww' && !m};
    });
    return {holdings,source:broker,retrievedAt:new Date().toISOString()};
  }
  if (body.action === 'quotes') return quotes(body,headers);
  if (body.action === 'search') {
    const exchange=body.exchange || (body.segment === 'FNO' && broker === 'kite'?'NFO':'NSE');
    if (!['NSE','BSE','NFO','BFO'].includes(exchange)) throw new Error('Unsupported exchange.');
    const term=safeString(body.query || body.symbol || 'NIFTY','search').toUpperCase();
    const rows=await master(broker,headers,exchange);
    const instruments=rows.filter(r=>(broker==='groww'? (r.exchange === exchange || exchange==='NFO' && r.exchange==='NSE' || exchange==='BFO' && r.exchange==='BSE') : true) &&
      (body.segment==='FNO'? /FNO|FUT|OPT/.test(r.segment) || ['CE','PE','FUT'].includes(r.instrumentType) : !/FNO|FUT|OPT/.test(r.segment)) &&
      (r.symbol.toUpperCase().includes(term)||String(r.name).toUpperCase().includes(term)))
      .sort((a,b)=>(a.symbol===term?-1:b.symbol===term?1:0)||String(a.expiry||'').localeCompare(String(b.expiry||''))||a.symbol.localeCompare(b.symbol)).slice(0,60);
    return {instruments,source:broker};
  }
  if (body.action === 'candles') {
    if (body.interval && !['day','1day','5minute'].includes(body.interval)) throw new Error('Supported candle intervals are day and 5minute.');
    if (body.exchange && !['NSE','BSE','NFO','BFO'].includes(body.exchange)) throw new Error('Unsupported exchange.');
    if (body.segment && !['CASH','FNO'].includes(body.segment)) throw new Error('Unsupported segment.');
    const daily=body.interval !== '5minute';
    const now=new Date();
    const from=body.from ? new Date(body.from) : new Date(now.getTime()-(daily?175:7)*86400000);
    const to=body.to ? new Date(body.to) : now;
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from>=to || to-from>(daily?180:30)*86400000) throw new Error('Invalid date range. Use at most 180 days for daily or 30 days for intraday.');
    let token=body.token;
    if (!token) {
      const all=await master(broker,headers,body.exchange || 'NSE');
      const exchange=broker==='groww' ? (body.exchange==='NFO'?'NSE':body.exchange==='BFO'?'BSE':body.exchange) : body.exchange;
      token=all.find(i=>i.symbol===body.symbol && (i.exchange===exchange || !exchange))?.token;
    }
    if (!token) throw new Error('Instrument not found. Search the broker instrument list first.');
    const url=broker==='kite'?urlFor(broker,'/instruments/historical/'+safeString(String(token),'token',/^\d{1,15}$/)+'/'+(daily?'day':'5minute'),{from:istDate(from),to:istDate(to),oi:1}):
      urlFor(broker,'/v1/historical/candles',{exchange:body.exchange==='NFO'?'NSE':body.exchange==='BFO'?'BSE':body.exchange || 'NSE',segment:body.segment || (['NFO','BFO'].includes(body.exchange)?'FNO':'CASH'),groww_symbol:safeString(String(token),'Groww symbol'),start_time:istDate(from),end_time:istDate(to),candle_interval:daily?'1day':'5minute'});
    const data=await upstream(url,headers);
    const rows=data.candles || [];
    if (!Array.isArray(rows)) throw new Error('Unexpected broker history response.');
    const dayNow=istDate(now).slice(0,10);
    const candles=rows.map(c=>({time:exchangeTime(c[0]),open:num(c[1]),high:num(c[2]),low:num(c[3]),close:num(c[4]),volume:num(c[5]),...(c[6]!=null?{oi:num(c[6])}:{})}))
      .filter(c=>c.time && (daily?istDate(new Date(c.time)).slice(0,10)<dayNow:Date.parse(c.time)+300000<=now.getTime()));
    return {candles,source:broker,interval:daily?'day':'5minute',asOf:candles.at(-1)?.time || null,retrievedAt:now.toISOString(),completedOnly:true};
  }
  throw new Error('Unsupported read operation.');
}
