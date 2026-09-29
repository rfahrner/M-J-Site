import assert from 'node:assert/strict';
import fs from 'node:fs';

const dateKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const addDays = (d,n) => { const out=new Date(d); out.setDate(out.getDate()+n); return out; };
function load(file,stateName) {
  const source=fs.readFileSync(file,'utf8').replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g,'').replace(/export /g,'');
  const table={innerHTML:''};
  return new Function('dateKey','addDays','$','escapeHtml',`${source}; return {computeMetricsFromRows,buildDisplayRows,renderTable,state:${stateName},fields:FIELD_DEFS,table:$('#table')};`)(dateKey,addDays,selector=>selector.endsWith('table')?table:null,String);
}
const location=load('location-analytics.js','laState');
const volume=load('analytics-volume.js','volState');
const shifts=[
 {id:1,shift_date:'2026-09-20',driver_id:7},
 {id:2,shift_date:'2026-09-20',driver_id:7}, // same person/day
 {id:3,shift_date:'2026-09-21',driver_id:7}, // repeat person, different day
 {id:4,shift_date:'2026-09-21',driver_name_text:'Typed Driver',tonu:true,load_cancelled:true},
 {id:5,shift_date:'2026-09-22',driver_id:8,tonu:true,called_off:true},
 {id:6,shift_date:'2026-09-22',driver_id:9,called_off:true},
 {id:7,shift_date:'2026-09-22'},
];
const trips=[
 {shift_id:1,route_id:'A',route_miles:100,stop_count:2,salvage:true},
 {shift_id:2,trip_id:'B',route_miles:200,stop_count:3,backhaul:true},
 {shift_id:3,route_id:'C',route_miles:50,stop_count:1},
 {shift_id:3,route_id:'',trip_id:'',route_miles:999,stop_count:999},
];
const accountingRows=[
 {shift_date:'2026-09-20',total_revenue:1000,total_cost:700},
 {shift_date:'2026-09-21',total_revenue:500,total_cost:200},
 {shift_date:'2026-09-22',total_revenue:0,total_cost:150},
];
const data={shifts,trips,accountingRows};
// Location Analytics counts drivers who RAN, so the two TONU rows (ids 4 and
// 5) drop out: only person 7 on 09-20 and person 7 again on 09-21 remain.
// Volume's driversRequested still sees 4 -- see the assertion below it.
const expected={drivers:2,mileage:350,routes:3,stops:6,turn:1.5,salvage:1,backhauls:1,tonu:2,revenue:1500,cost:1050,margin:450,gmPct:30,revPerMile:1500/350,revPerRoute:500,revPerDriver:750,avrLoh:350/3,marginPerDriver:225,revPerStop:250,marginPerRoute:150};
assert.deepEqual(location.computeMetricsFromRows(shifts,trips,accountingRows),expected);
assert.deepEqual(new Set(location.fields.map(f=>f.key)),new Set(Object.keys(expected)),'every displayed column covered');
assert.deepEqual(volume.computeMetricsFromRows(shifts,trips),{driversRequested:4,tonu:2,routesRan:3});
for (const page of [location,volume]) {
 const rows=page.buildDisplayRows(data,'2026-09-21','2026-09-22');
 const recap=rows.find(r=>r.rowType==='weekRecap');
 assert.equal(recap.rangeStart,'2026-09-21');
 assert.equal(recap.rangeEnd,'2026-09-22');
 // 09-21..09-22 holds one running driver (person 7 on 09-21); the rest of the
 // window is two TONUs, a call-off and a row with nobody on it. Volume counts
 // the TONUs as requested, so it still sees 3.
 assert.equal(recap[page===location?'drivers':'driversRequested'],page===location?1:3,'hidden Sunday excluded');
 const additive=page===location?['drivers','mileage','routes','stops','salvage','backhauls','tonu','revenue','cost','margin']:['driversRequested','tonu','routesRan'];
 for(const key of additive) assert.equal(recap[key],rows.filter(r=>r.rowType==='day').reduce((n,r)=>n+r[key],0),key);
 const crossing=page.buildDisplayRows(data,'2026-09-30','2026-10-04');
 assert.deepEqual(crossing.filter(r=>r.rowType==='weekRecap').map(r=>[r.rangeStart,r.rangeEnd]),[['2026-09-30','2026-09-30'],['2026-10-01','2026-10-03'],['2026-10-04','2026-10-04']]);
 page.state.displayRows=rows;
 page.renderTable();
 assert.equal((page.table.innerHTML.match(/analytics-week-start/g)||[]).length,1);
 assert.equal((page.table.innerHTML.match(/analytics-week-end/g)||[]).length,1);
 assert.equal((page.table.innerHTML.match(/analytics-week-row/g)||[]).length,3,'box contains days and recap');
 const empty=page.computeMetricsFromRows([],[],[]);
 assert.ok(Object.values(empty).every(v=>v===0),'empty range has finite zero metrics');
}
// Regression shape: 57 distinct people across three days -- 57 + 57 running, plus
// 9 TONU'd on the third day. 123 driver-days were requested; 114 of them ran.
// This is the case that shows the two pages must not share a number.
const week=[];
for(let day=0;day<3;day++) for(let person=0;person<(day===2?9:57);person++) week.push({shift_date:`2026-09-${20+day}`,driver_id:person,tonu:day===2});
assert.equal(location.computeMetricsFromRows(week,[],[]).drivers,114);
assert.equal(volume.computeMetricsFromRows(week,[]).driversRequested,123);
console.log('All analytics columns, daily totals, TONUs (excluded from Drivers, kept in Drivers Requested), partial weeks, quarter boundaries, and box grouping passed.');
