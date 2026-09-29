import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync('loadboard.js','utf8');
function extract(name) {
 const start=source.indexOf(`function ${name}(`);
 const end=source.indexOf('\n  }',start)+4;
 return source.slice(start,end);
}
let driver=null;
let saves=0;
let calculations=0;
const row={id:'row1',dbId:16412,driverId:10018,location:'atlanta',rate:'470',rateManual:false,trips:[{routeId:'PA3061',routeMiles:118,stopCount:3}]};
const api=new Function('state','findDriver','calcLoadRateBreakdown','allowRateWrite','labelForRow','markFieldDirty','dirtyShiftFields','scheduleShiftSave','document',`${extract('getEffectiveRateInfo')}\n${extract('recomputeRowRate')}\nreturn {getEffectiveRateInfo,recomputeRowRate};`)(
 {activeLocation:'atlanta'},()=>driver,()=>{calculations++;return {total:driver?470:420};},()=>true,()=>'',()=>{},new Map(),()=>saves++,{querySelector:()=>null});
assert.equal(api.getEffectiveRateInfo(row).notReady,true);
api.recomputeRowRate(row);
assert.equal(row.rate,'470');
assert.equal(saves,0);
assert.equal(calculations,0,'the missing profile must never reach location pricing');
driver={name:'Atiba Ward',atlantaRateOverrides:{tiers:{3:450},settings:{stop_charge_per_stop:20,stop_charge_free_stops:2}}};
api.recomputeRowRate(row);
assert.equal(row.rate,'470');
assert.equal(saves,0,'loading the profile must not rewrite an already-correct rate');
row.rate='420';
api.recomputeRowRate(row);
assert.equal(row.rate,'470');
assert.equal(saves,1,'a complete profile still permits recalculation');
row.rateManual=true;row.rate='500';driver=null;
api.recomputeRowRate(row);
assert.equal(row.rate,'500');
assert.equal(saves,1,'manual rate preserved');
const cancelled=api.getEffectiveRateInfo({...row,loadCancelled:true});
assert.equal(cancelled.total,0);
assert.equal(cancelled.mode,'load-cancelled');
console.log('Missing driver profile preserves the saved rate; loaded profiles, manual rates and cancellations pass.');
