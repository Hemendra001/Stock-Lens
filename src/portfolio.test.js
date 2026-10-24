import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateWorkspace,holdingKey,scopeHoldings,aggregatePortfolio,replaceAccountHoldings} from './portfolio.js';
const now=Date.parse('2026-10-24T04:30:00Z');
const accounts=[{id:'a',broker:'kite',memberId:'self',label:'Mine'},{id:'b',broker:'kite',memberId:'mum',label:'Mum Kite'},{id:'d',broker:'demo',memberId:'self',label:'Sample'}];
const members=[{id:'self',name:'You'},{id:'mum',name:'Mum'}];
const h=(accountId,quantity=10,average_price=100,symbol='TCS')=>({accountId,source:accountId==='d'?'demo':'kite',symbol,exchange:'NSE',quantity,average_price});
const quote=()=>({price:150,timestamp:new Date(now).toISOString(),isStale:false});
test('legacy migration preserves holdings, histories, theses and untouched input',()=>{
 const old={source:'kite',holdings:[{source:'kite',symbol:'TCS',quantity:10,average_price:100}],imported:{'kite:NSE:TCS':{candles:[1]}},theses:{'kite:NSE:TCS':{notes:'Keep thesis'}},selected:'kite:NSE:TCS'};const before=JSON.stringify(old),m=migrateWorkspace(old,[]);
 assert.equal(m.scope,'account:legacy:kite');assert.equal(m.holdings[0].accountId,'legacy:kite');assert.deepEqual(m.imported['legacy:kite:NSE:TCS'],{candles:[1]});assert.equal(m.theses[m.selected].notes,'Keep thesis');assert.equal(JSON.stringify(old),before);assert.deepEqual(migrateWorkspace({holdings:[]},[h('d')]).holdings,[]);
 assert.deepEqual(migrateWorkspace(m,[]),m);
});
test('account and member scopes preserve same-broker positions and exclude demo in family',()=>{
 const rows=[h('a'),h('b'),h('d')];assert.notEqual(holdingKey(rows[0]),holdingKey(rows[1]));assert.equal(scopeHoldings(rows,accounts,'all').length,2);assert.equal(scopeHoldings(rows,accounts,'member:self').length,1);assert.equal(scopeHoldings(rows,accounts,'account:b')[0].accountId,'b');assert.equal(scopeHoldings(rows,accounts,'account:d').length,1);
});
test('weighted cost, total value and overlapping family positions are exact',()=>{
 const t=aggregatePortfolio([h('a',10,100),h('b',20,130)],quote,accounts,members,now);
 assert.equal(t.invested,3600);assert.equal(t.currentValue,4500);assert.equal(t.pnl,900);assert.equal(t.stocks[0].averagePrice,120);assert.equal(t.stocks[0].quantity,30);assert.equal(t.overlaps.length,1);assert.equal(t.memberBreakdown.length,2);assert.equal(t.stocks[0].weightPercent,100);
});
test('missing prices do not create invented losses or complete totals',()=>{
 const t=aggregatePortfolio([h('a'),h('b')],row=>row.accountId==='a'?quote():{},accounts,members,now);assert.equal(t.currentValue,1500);assert.equal(t.invested,2000);assert.equal(t.pricedInvestment,1000);assert.equal(t.pnl,500);assert.equal(t.missingCount,1);assert.equal(t.isPartial,true);assert.equal(t.coveragePercent,50);
 const none=aggregatePortfolio([h('a')],()=>({}),accounts,members,now);assert.equal(none.currentValue,null);assert.equal(none.pnl,null);
});
test('timestamps and CSV source control freshness; cross-exchange positions stay separate',()=>{
 const rows=[h('a'),{...h('b'),exchange:'BSE',source:'csv'}];const t=aggregatePortfolio(rows,quote,accounts,members,now);assert.equal(t.staleCount,1);assert.equal(t.stocks.length,2);assert.equal(t.overlaps.length,0);
 assert.equal(aggregatePortfolio([h('a')],()=>({...quote(),timestamp:new Date(now-91000).toISOString()}),accounts,members,now).staleCount,1);
});
test('sync replaces only its account atomically and rejects invalid or duplicate rows',()=>{
 const old=[h('a'),h('b')];const result=replaceAccountHoldings(old,'a',[h('a',3)]);assert.equal(result.find(x=>x.accountId==='b'),old[1]);assert.equal(result.find(x=>x.accountId==='a').quantity,3);assert.equal(replaceAccountHoldings(old,'a',[]).length,1);
 for(const incoming of [[h('b')],[h('a'),h('a')],[h('a',-1)],[h('a',1,NaN)]])assert.throws(()=>replaceAccountHoldings(old,'a',incoming));assert.equal(old.length,2);
});
