import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as demo from './demo.js';
import * as engine from './engine.js';
import * as longterm from './longterm.js';
import * as portfolio from './portfolio.js';
import * as research from './research.js';

// Nonvisual smoke tests: actual templates and calculation engines run with minimal
// DOM/storage doubles. No browser, layout, pointer geometry, or visual QA is implied.
const NOW=Date.parse('2026-10-23T09:02:00Z');
function harness({saved,fetch:fetchImpl}={}){
 let now=NOW;
 class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const elements=new Map(['#app','#modal-root','#toast'].map(id=>[id,{innerHTML:'',textContent:'',className:'',style:{}}]));
 const listeners=new Map(),storage=new Map(saved===undefined?[]:[[saved.version===2?'stocklens.v2':'stocklens.v1',JSON.stringify(saved)]]),requests=[];
 class TestFormData extends Map{constructor(form){super(Object.entries(form.fields||{}));}get(k){return super.get(k)??null;}}
 const context=vm.createContext({FormData:TestFormData,...demo,...engine,...longterm,...portfolio,...research,Date:Clock,console,structuredClone,AbortController,URL,Blob,
  document:{hidden:false,querySelector:s=>elements.get(s)||null,addEventListener:(type,fn)=>{const fns=listeners.get(type)||[];fns.push(fn);listeners.set(type,fns);}},
  window:{scrollTo(){}},location:{reload(){}},HTMLElement:class{},
  localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
  setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
  fetch:async(url,init)=>{const payload=JSON.parse(init.body);requests.push({url,init,payload});if(!fetchImpl)throw new Error('Unexpected fetch');return fetchImpl(payload,requests.length);},
 });
 const src=readFileSync(new URL('./app.js',import.meta.url),'utf8').replace(/^import .*?;\s*$/gm,'');
 vm.runInContext(src+'\nglobalThis.app={state,runtime,key,persist,render,setTab,setScope,accountById,disconnectAccount,connectForm,importHoldingsFile,loadCandles,quoteFor,refreshMarket,refreshFno,searchContracts,parseCSV,connectionModal,holdingModal,settingsModal,detailsModal,importCandlesPrompt};',context,{filename:'app.js',timeout:5000});
 for(const broker of ['csv','kite','groww'])if(!context.app.state.accounts.some(a=>a.id==='legacy:'+broker))context.app.state.accounts.push({id:'legacy:'+broker,broker,label:broker,memberId:'self'});
 return {...context.app,elements,storage,requests,setNow:value=>{now=value;},dispatch:async(type,target)=>{for(const fn of listeners.get(type)||[])await fn({target,preventDefault(){}});}};
}
const response=data=>({ok:true,json:async()=>data});
const holding={symbol:'M&M',name:'Mahindra',source:'kite',exchange:'NSE',quantity:2,average_price:100,token:'123'};
const views=['family','research','overview','portfolio','swing','longterm','fno','opportunities','connections','methodology'];

test('all eight views render sample, empty, and imported workspaces with real engines',()=>{
 for(const mode of ['demo','empty','csv']){
  const app=harness();
  if(mode!=='demo'){app.state.source='csv';app.state.scope='account:legacy:csv';app.state.holdings=mode==='empty'?[]:[{...holding,source:'csv'}];app.state.selected=null;}
  for(const view of views){
   assert.doesNotThrow(()=>app.setTab(view),`${mode}: ${view}`);
   const html=app.elements.get('#app').innerHTML;
   assert.match(html,/<h1>[^<]+<\/h1>/);
   assert.ok(html.includes(`data-nav="${view}" class="active"`),`${view} navigation active`);
   assert.ok(!html.includes('₹NaN'),`${view} does not render a numeric NaN`);
  }
 }
});

test('imported symbols, names and thesis text remain escaped in render output and dialogs',()=>{
 const app=harness(),symbol='X<img src=x onerror="boom">',h={...holding,symbol,name:'<script>boom()</script>',source:'csv'};
 app.state.holdings=[h];app.state.source='csv';app.state.scope='account:legacy:csv';app.state.selected=app.key(h);
 app.state.theses[app.key(h)]={notes:'</textarea><script>boom()</script>',sourceUrl:'" onfocus="boom'};
 for(const view of ['overview','portfolio','swing','longterm','fno']){
  app.setTab(view);const html=app.elements.get('#app').innerHTML;
  assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img'),view+' renders escaped symbol');
 }
 app.holdingModal(app.key(h));
 assert.ok(!app.elements.get('#modal-root').innerHTML.includes('<img src=x'));
 app.detailsModal();
 assert.ok(!app.elements.get('#modal-root').innerHTML.includes('<img src=x'));
});

test('broker access credentials and quote caches are excluded from persisted browser state',()=>{
 const app=harness();
 app.runtime.credentials['legacy:kite']={apiKey:'PRIVATE_API_KEY',accessToken:'PRIVATE_ACCESS_TOKEN'};
 app.runtime.quotes.private='PRIVATE_QUOTE';
 app.state.holdings=[holding];app.persist();
 const saved=app.storage.get('stocklens.v2');
 assert.ok(!saved.includes('PRIVATE_'));
 assert.equal(JSON.parse(saved).holdings[0].token,'123','public instrument identifier may persist');
 const reloaded=harness({saved:JSON.parse(saved)});
 assert.equal(Object.keys(reloaded.runtime.credentials).length,0);
});

test('broker daily history requests stay inside 180-day window and retain candle provenance',async()=>{
 const candles=[{time:'2026-10-22T00:00:00+05:30',open:100,high:102,low:99,close:101,volume:200}];
 const app=harness({fetch:async()=>response({candles,asOf:candles[0].time})});
 app.runtime.credentials['legacy:kite']={apiKey:'key',accessToken:'token'};
 await app.loadCandles(holding);
 const req=app.requests[0];
 assert.equal(req.url,'/api/broker');assert.equal(req.init.method,'POST');
 assert.equal(req.payload.action,'candles');assert.equal(req.payload.interval,'day');
 assert.equal(req.payload.symbol,'M&M');assert.equal(req.payload.token,'123');
 const duration=Date.parse(req.payload.to)-Date.parse(req.payload.from);
 assert.ok(duration>0&&duration<=180*86400000);
 assert.equal(app.runtime.brokerCandles[app.key(holding)].asOf,candles[0].time);
});

test('cached quote ages against current clock, without needing a new broker response',()=>{
 const app=harness();
 app.runtime.quotes[app.key(holding)]={price:100,timestamp:new Date(NOW).toISOString(),isStale:false};
 assert.equal(app.quoteFor(holding).isStale,false);
 app.setNow(NOW+91000);
 assert.equal(app.quoteFor(holding).isStale,true);
 app.state.holdings=[holding];app.state.source='kite';app.state.scope='account:legacy:kite';app.setTab('portfolio');
 assert.match(app.elements.get('#app').innerHTML,/STALE/);
});

test('an old FNO quote response cannot overwrite a newly selected contract',async()=>{
 let finish;
 const app=harness({fetch:()=>new Promise(resolve=>{finish=resolve;})});
 app.runtime.credentials['legacy:kite']={apiKey:'key',accessToken:'token'};
 const old={symbol:'OLDCE',exchange:'NFO',token:'1'},next={symbol:'NEWCE',exchange:'NFO',token:'2'};
 Object.assign(app.runtime.fno,{contract:old,broker:'kite',accountId:'legacy:kite',epoch:1});
 const pending=app.refreshFno(true);
 Object.assign(app.runtime.fno,{contract:next,epoch:2,quote:{price:55},candles:[]});
 finish(response({quotes:{'NFO:OLDCE':{price:999}}}));await pending;
 assert.equal(app.runtime.fno.contract,next);
 assert.equal(app.runtime.fno.quote.price,55);
 assert.equal(app.requests.length,1,'obsolete quote must not start candle fetch');
 assert.equal(app.runtime.fno.busy,false);
});

test('an old FNO history response cannot overwrite a newly selected contract',async()=>{
 let finishHistory;
 const app=harness({fetch:async(payload)=>payload.action==='quotes'?response({quotes:{'NFO:OLDCE':{price:100}}}):new Promise(resolve=>{finishHistory=resolve;})});
 app.runtime.credentials['legacy:kite']={apiKey:'key',accessToken:'token'};
 const old={symbol:'OLDCE',exchange:'NFO',token:'1'},next={symbol:'NEWCE',exchange:'NFO',token:'2'};
 Object.assign(app.runtime.fno,{contract:old,broker:'kite',accountId:'legacy:kite',epoch:1});
 const pending=app.refreshFno(true);
 for(let i=0;i<10&&!finishHistory;i++)await Promise.resolve();
 assert.equal(typeof finishHistory,'function');
 Object.assign(app.runtime.fno,{contract:next,epoch:2,candles:[],quote:null});
 finishHistory(response({candles:[{time:'2026-10-23T09:00:00Z',close:999}]}));await pending;
 assert.equal(app.runtime.fno.candles.length,0);
 assert.equal(app.runtime.fno.quote,null);
});

test('CSV parser supports BOM, quoted commas, escaped quotes and CRLF; rejects malformed rows',()=>{
 const app=harness();
 const r=app.parseCSV('\uFEFFsymbol,name\r\nM&M,"Mahindra, \"\"Group\"\""\r\n');
 assert.equal(r.rows[0].symbol,'M&M');assert.equal(r.rows[0].name,'Mahindra, "Group"');
 for(const input of ['symbol\n','symbol,symbol\nA,B','symbol,quantity\nA,1,2','symbol,quantity\n"A,1','symbol,quantity\nA"B,1'])assert.throws(()=>app.parseCSV(input));
});

test('holdings CSV import validates symbols and duplicates before changing workspace',async()=>{
 const app=harness(),before=JSON.stringify(app.state.holdings);app.runtime.holdingsImportAccount='legacy:csv';
 for(const csv of ['symbol,quantity,average_price\nBAD<script>,1,100','symbol,quantity,average_price\nRELIANCE,-2,100','symbol,quantity,average_price\nRELIANCE,1,100\nRELIANCE,2,110']){
  app.runtime.holdingsImportAccount='legacy:csv';await app.dispatch('change',{id:'holdings-file',value:'upload.csv',files:[{size:csv.length,text:async()=>csv}]});
  assert.equal(JSON.stringify(app.state.holdings),before);
  assert.match(app.elements.get('#toast').className,/error/);
 }
 const csv='symbol,quantity,average_price,exchange\nM&M,2,1500,NSE';
 app.runtime.holdingsImportAccount='legacy:csv';await app.dispatch('change',{id:'holdings-file',value:'upload.csv',files:[{size:csv.length,text:async()=>csv}]});
 assert.equal(app.state.source,'csv');
 assert.equal(app.state.holdings.find(h=>h.source==='csv').symbol,'M&M');
});

test('candle CSV import uses engine validation and remains unverified after valid import',async()=>{
 const app=harness(),h={...holding,source:'csv'};
 app.state.holdings=[h];app.state.source='csv';app.state.scope='account:legacy:csv';app.runtime.importTarget=h;
 const headers='time,open,high,low,close,volume\n';
 const invalid=headers+'2026-10-01,100,90,99,101,200';
 await app.dispatch('change',{id:'candles-file',value:'bad.csv',files:[{size:invalid.length,text:async()=>invalid}]});
 assert.equal(Object.keys(app.state.imported).length,0);
 const rows=Array.from({length:20},(_,i)=>`2026-09-${String(i+1).padStart(2,'0')},100,105,99,103,200`);
 const good=headers+rows.join('\n');
 await app.dispatch('change',{id:'candles-file',value:'good.csv',files:[{size:good.length,text:async()=>good}]});
 assert.equal(app.state.imported[app.key(h)].candles.length,20);
 assert.equal(app.state.imported[app.key(h)].isStale,true);
 assert.match(app.elements.get('#toast').textContent,/unverified/);
});

// A broker refresh can finish after the user has started editing their thesis.
test('an in-flight broker refresh preserves the long-term editor',async()=>{
 let finish;
 const app=harness({fetch:()=>new Promise(resolve=>{finish=resolve;})});
 app.state.holdings=[holding];app.state.source='kite';app.state.scope='account:legacy:kite';app.state.selected=app.key(holding);
 app.runtime.credentials['legacy:kite']={apiKey:'key',accessToken:'token'};
 app.runtime.brokerCandles[app.key(holding)]={candles:[],fetchedDay:'2026-10-23'};
 const pending=app.refreshMarket(false);
 app.setTab('longterm');
 const editor=app.elements.get('#app');editor.innerHTML='Unsaved company thesis';
 finish(response({quotes:{'NSE:M&M':{price:105,timestamp:new Date(NOW).toISOString()}}}));
 await pending;
 assert.equal(editor.innerHTML,'Unsaved company thesis');
 assert.equal(app.runtime.quotes[app.key(holding)].price,105);
});

const familySaved=()=>({version:2,scope:'all',source:'combined',members:[{id:'self',name:'You'},{id:'mum',name:'Mum'}],accounts:[{id:'a',broker:'kite',label:'My Kite',memberId:'self'},{id:'b',broker:'kite',label:'Mum Kite',memberId:'mum'}],holdings:[{...holding,accountId:'a'},{...holding,accountId:'b',quantity:4}]});
test('two accounts on the same broker use separate tokens and quote caches',async()=>{
 const app=harness({saved:familySaved(),fetch:async p=>response({quotes:{'NSE:M&M':{price:p.credentials.accessToken==='TOKEN_A'?111:222,timestamp:new Date(NOW).toISOString()}}})});
 app.runtime.credentials.a={accessToken:'TOKEN_A',apiKey:'a'};app.runtime.credentials.b={accessToken:'TOKEN_B',apiKey:'b'};
 for(const h of app.state.holdings)app.runtime.brokerCandles[app.key(h)]={candles:[]};
 await app.refreshMarket(false);
 assert.deepEqual(app.requests.map(r=>r.payload.credentials.accessToken),['TOKEN_A','TOKEN_B']);assert.equal(app.runtime.quotes['a:NSE:M&M'].price,111);assert.equal(app.runtime.quotes['b:NSE:M&M'].price,222);
 app.persist();const saved=app.storage.get('stocklens.v2');assert.ok(!saved.includes('TOKEN_'));assert.equal(JSON.parse(saved).accounts.length,5); // test harness adds three legacy fixtures
 app.disconnectAccount('a');assert.equal(app.runtime.credentials.b.accessToken,'TOKEN_B');assert.equal(app.runtime.quotes['a:NSE:M&M'],undefined);assert.equal(app.runtime.quotes['b:NSE:M&M'].price,222);
});
test('a quote arriving after disconnect cannot repopulate an account cache',async()=>{
 let finish;const app=harness({saved:familySaved(),fetch:()=>new Promise(r=>{finish=r;})});app.state.scope='account:a';app.runtime.credentials.a={accessToken:'TOKEN_A'};
 const pending=app.refreshMarket(false);app.disconnectAccount('a');finish(response({quotes:{'NSE:M&M':{price:999,timestamp:new Date(NOW).toISOString()}}}));await pending;assert.equal(app.runtime.quotes['a:NSE:M&M'],undefined);
});
test('account-targeted CSV replacement leaves another same-broker account untouched',async()=>{
 const app=harness({saved:familySaved()}),other=app.state.holdings.find(h=>h.accountId==='b');app.runtime.holdingsImportAccount='a';
 const csv='symbol,quantity,average_price,exchange,last_price,price_as_of\nTCS,3,100,NSE,120,2026-10-22T10:00:00+05:30';await app.importHoldingsFile({value:'csv',files:[{size:csv.length,text:async()=>csv}]});
 assert.equal(app.state.holdings.find(h=>h.accountId==='b'),other);const mine=app.state.holdings.find(h=>h.accountId==='a');assert.equal(mine.symbol,'TCS');assert.equal(app.quoteFor(mine).price,120);assert.equal(app.quoteFor(mine).isStale,true);assert.equal(app.state.scope,'account:a');
});
test('family labels and review text are escaped, demo does not enter family total',()=>{
 const saved=familySaved();saved.accounts[0].label='<img src=x>';saved.members[1].name='<script>evil</script>';saved.holdings.push({...holding,source:'demo',accountId:'legacy:demo',quantity:99999});const app=harness({saved});app.setTab('family');const html=app.elements.get('#app').innerHTML;assert.ok(!html.includes('<script>evil'));assert.ok(!html.includes('<img src=x>'));assert.ok(!html.includes('99999'));
});


test('account aliases remain escaped in connection and removal dialog titles',async()=>{
 const saved=familySaved();saved.accounts[0].label='<img src=x onerror="boom">';const app=harness({saved});
 app.connectionModal('a');
 assert.ok(!app.elements.get('#modal-root').innerHTML.includes('<img src=x'));
 assert.match(app.elements.get('#modal-root').innerHTML,/&lt;img/);
 const button={dataset:{deleteAccount:'a'}};
 await app.dispatch('click',{closest:()=>button});
 assert.ok(!app.elements.get('#modal-root').innerHTML.includes('<img src=x'));
 assert.match(app.elements.get('#modal-root').innerHTML,/&lt;img/);
});

test('connecting another broker account clears the previous derivative evidence',async()=>{
 const saved=familySaved();saved.accounts[1].broker='groww';
 const app=harness({saved,fetch:async()=>response({holdings:[]})});
 app.runtime.credentials.a={apiKey:'A',accessToken:'TOKEN_A'};
 Object.assign(app.runtime.fno,{accountId:'a',broker:'kite',epoch:3,contract:{symbol:'OLDCE'},quote:{price:100},candles:[{close:100}],results:[{symbol:'OLDCE'}],lastHistory:NOW,error:'Old error'});
 const button={disabled:false,textContent:''};
 await app.connectForm({dataset:{account:'b'},fields:{accessToken:'TOKEN_B'},querySelector:()=>button});
 assert.equal(app.runtime.fno.accountId,'b');assert.equal(app.runtime.fno.broker,'groww');
 assert.equal(app.runtime.fno.epoch,4);assert.equal(app.runtime.fno.contract,null);assert.equal(app.runtime.fno.quote,null);
 assert.equal(app.runtime.fno.candles.length,0);assert.equal(app.runtime.fno.results.length,0);assert.equal(app.runtime.fno.lastHistory,0);assert.equal(app.runtime.fno.error,null);
 assert.equal(app.runtime.credentials.a.accessToken,'TOKEN_A');
});

test('old derivative quotes and contract search results are rejected after a token change',async()=>{
 for(const action of ['quotes','search']){
  let finish;const app=harness({fetch:()=>new Promise(resolve=>{finish=resolve;})});
  app.runtime.credentials['legacy:kite']={apiKey:'key',accessToken:'OLD'};app.runtime.connectionEpoch['legacy:kite']=1;
  Object.assign(app.runtime.fno,{accountId:'legacy:kite',broker:'kite',epoch:1,contract:{symbol:'OLDCE',exchange:'NFO',token:'1'},query:'RELIANCE'});
  app.elements.set('[data-action="search-contract"]',{disabled:false,textContent:''});
  const pending=action==='quotes'?app.refreshFno(true):app.searchContracts();
  app.runtime.credentials['legacy:kite']={apiKey:'key',accessToken:'NEW'};app.runtime.connectionEpoch['legacy:kite']=2;
  finish(response(action==='quotes'?{quotes:{'NFO:OLDCE':{price:999}}}:{instruments:[{symbol:'OLDCE',instrumentType:'CE'}]}));await pending;
  assert.equal(app.runtime.fno.quote,null);assert.equal(app.runtime.fno.results.length,0);assert.equal(app.requests.length,1);
 }
});

test('reconnecting the same account invalidates derivative evidence before holdings returns',async()=>{
 let finish;const app=harness({fetch:()=>new Promise(resolve=>{finish=resolve;})});
 app.runtime.credentials['legacy:kite']={apiKey:'key',accessToken:'OLD'};
 Object.assign(app.runtime.fno,{accountId:'legacy:kite',broker:'kite',epoch:1,contract:{symbol:'OLDCE'},quote:{price:99}});
 const button={};const pending=app.connectForm({dataset:{account:'legacy:kite'},fields:{apiKey:'key',accessToken:'NEW'},querySelector:()=>button});
 assert.equal(app.runtime.fno.contract,null);assert.equal(app.runtime.fno.quote,null);assert.equal(app.runtime.fno.epoch,2);
 finish(response({holdings:[]}));await pending;
 assert.equal(app.runtime.credentials['legacy:kite'].accessToken,'NEW');
});

test('importing real history from a demo creates an unowned watchlist entry',async()=>{
 const app=harness(),sample=app.state.holdings.find(h=>h.source==='demo');assert.ok(sample.quantity>0);
 app.runtime.importTarget={...sample};
 const csv='time,open,high,low,close,volume\n'+Array.from({length:20},(_,i)=>`2026-09-${String(i+1).padStart(2,'0')},100,105,99,103,200`).join('\n');
 await app.dispatch('change',{id:'candles-file',value:'history.csv',files:[{size:csv.length,text:async()=>csv}]});
 const imported=app.state.holdings.find(h=>h.source==='csv'&&h.symbol===sample.symbol);
 assert.ok(imported);assert.equal(imported.quantity,0);assert.equal(imported.average_price,0);
 assert.equal(app.state.imported[app.key(imported)].candles.length,20);assert.ok(sample.quantity>0);
 const total=portfolio.aggregatePortfolio(portfolio.scopeHoldings(app.state.holdings,app.state.accounts,'all'),app.quoteFor,app.state.accounts,app.state.members,NOW);
 assert.equal(total.ownedCount,0);assert.equal(total.invested,0);assert.equal(total.currentValue,null);
});
