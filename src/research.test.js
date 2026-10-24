import test from 'node:test';import assert from 'node:assert/strict';
import {planPosition,evaluateChecklist,analyzeDrift} from './research.js';
const inputs={equity:100000,cashAvailable:50000,entry:100,stop:90,riskPercent:1,maxPositionPercent:20,existingSymbolValue:0};
test('whole-share position size respects risk, cash and remaining allocation separately',()=>{
 assert.equal(planPosition(inputs).shares,100);assert.equal(planPosition({...inputs,cashAvailable:250}).shares,2);const capped=planPosition({...inputs,existingSymbolValue:19500});assert.equal(capped.shares,5);assert.deepEqual(capped.bindingConstraints,['allocation']);assert.equal(planPosition({...inputs,existingSymbolValue:25000}).shares,0);
});
test('invalid long stops, missing cash and unreasonable inputs block calculations',()=>{
 for(const input of [{...inputs,stop:100},{...inputs,stop:110},{...inputs,cashAvailable:undefined},{...inputs,riskPercent:NaN},{...inputs,cashAvailable:100001},{...inputs,entry:0}]){const r=planPosition(input);assert.equal(r.valid,false);assert.equal(r.shares,null);}
 assert.equal(planPosition({...inputs,cashAvailable:0}).shares,0);
});
test('checklist requires explicit evidence and true confirmations',()=>{
 const complete={thesis:'Revenue evidence',invalidation:'Margin below threshold',catalyst:'Results date checked',eventChecked:true,liquidityChecked:true,dataVerified:true};assert.equal(evaluateChecklist(complete).complete,true);assert.equal(evaluateChecklist({...complete,dataVerified:'true'}).complete,false);assert.equal(evaluateChecklist({...complete,invalidation:' '}).missing.length,1);assert.equal(evaluateChecklist({}).missing.length,6);
});
test('allocation comparison keeps untargeted holdings and measures percentage points',()=>{
 const result=analyzeDrift([{symbol:'TCS',exchange:'NSE',marketValue:300},{symbol:'TCS',exchange:'NSE',marketValue:100},{symbol:'ITC',exchange:'NSE',marketValue:100}],[{symbol:'TCS',exchange:'NSE',weightPercent:100}]);assert.equal(result.valid,true);assert.equal(result.rows.find(r=>r.symbol==='TCS').driftPp,-20);assert.equal(result.rows.find(r=>r.symbol==='ITC').targetPercent,0);
});
test('allocation targets are never silently normalized and missing prices block drift',()=>{
 const p=[{symbol:'TCS',exchange:'NSE',marketValue:100}];assert.equal(analyzeDrift(p,[{symbol:'TCS',exchange:'NSE',weightPercent:50}]).valid,false);assert.equal(analyzeDrift([{...p[0],marketValue:null}],[{symbol:'TCS',exchange:'NSE',weightPercent:100}]).valid,false);
});
