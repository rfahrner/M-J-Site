import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
const asModule=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const time=asModule(fs.readFileSync('overnight-times.js','utf8'));
const timeApi=await import(time);
const api=await import(asModule(fs.readFileSync('dispatch-route-text.js','utf8').replace("'./overnight-times.js'",JSON.stringify(time))));
const shift={id:1,driver_id:7,shift_date:'2026-10-12',shift_start:'09:00'};
const trip={id:2,trip_number:1,route_id:'RO123',dispatch_time:'09:15',dispatch_text_event_id:'event-one'};
const now=new Date('2026-10-12T14:00:00Z');
test('exact message; dispatches are independent and handled state survives a fresh scan',()=>{
  assert.equal(api.DISPATCH_ROUTE_MESSAGE,'This is D&L be sure to keep up with your arrival and departure times per stop. when you are finished at your last stop be sure to call in and give us the times and your ETA back to the DC.');
  const p=api.dispatchRoutePrompt(shift,trip,now);assert.ok(p);assert.equal(p.waitingForMessage,false);
  const sent={...trip,dispatch_text_sent_at:now.toISOString(),dispatch_text_sent_event_id:p.eventId,dispatch_text_sent_driver_key:p.driverKey};
  assert.equal(api.dispatchRoutePrompt(shift,sent,now),null);
  assert.ok(api.dispatchRoutePrompt(shift,{...sent,dispatch_text_event_id:'event-two'},now));
  assert.ok(api.dispatchRoutePrompt({...shift,driver_id:8},sent,now));
  assert.ok(api.dispatchRoutePrompt(shift,{...trip,id:3},now));
});
test('PA/FA/GA and salvage/backhaul suppress routine text; blank, settled and future dispatches are excluded',()=>{
  for(const id of ['PA123','FA123','GA222',' pa999',' fa999',' ga999'])assert.equal(api.dispatchRoutePrompt(shift,{...trip,route_id:id},now),null);
  assert.equal(api.dispatchRoutePrompt(shift,{...trip,backhaul:true},now),null);
  assert.equal(api.dispatchRoutePrompt(shift,{...trip,salvage:true},now),null);
  assert.equal(api.isCallRequiredRoute({route_id:'PA123'}),true);
  assert.equal(api.isCallRequiredRoute({route_id:'FA123'}),true);
  assert.equal(api.isCallRequiredRoute({route_id:'GA123'}),false);
  for(const s of [{...shift,shift_complete:true},{...shift,tonu:true},{...shift,load_cancelled:true},{...shift,called_off:true}])assert.equal(api.dispatchRoutePrompt(s,trip,now),null);
  for(const t of [{...trip,complete:true},{...trip,minimized:true},{...trip,route_id:''},{...trip,dispatch_time:''},{...trip,dispatch_time:'20:00'}])assert.equal(api.dispatchRoutePrompt(shift,t,now),null);
  assert.equal(api.dispatchRoutePrompt(shift,trip,new Date('2026-10-13T14:00:00Z')),null);
  assert.ok(api.dispatchRoutePrompt({...shift,shift_start:'23:00'}, {...trip,dispatch_time:'00:15'},new Date('2026-10-13T04:30:00Z')));
});
test('tracking guards reject an old draft after another dispatch; ordinary edits do not reset it',async()=>{
  const db=new PGlite();try{
    await db.exec('create role anon;create role authenticated;create table loads_trips(id bigint primary key,dispatch_time text,notes text)');
    await db.exec(fs.readFileSync('supabase/migrations/20261012221316_dispatched_route_text_tracking.sql','utf8'));
    await db.exec("insert into loads_trips(id,dispatch_time,notes) values(2,'09:15','keep')");
    const first=(await db.query('select * from loads_trips')).rows[0];
    await db.query('update loads_trips set dispatch_text_sent_at=now(),dispatch_text_sent_event_id=$1,dispatch_text_sent_driver_key=$2 where id=2',[first.dispatch_text_event_id,'driver:7']);
    await db.exec("update loads_trips set notes='changed',dispatch_time='09:15'");
    assert.ok((await db.query('select dispatch_text_sent_at from loads_trips')).rows[0].dispatch_text_sent_at);
    await db.exec("update loads_trips set dispatch_time='10:30'");
    const second=(await db.query('select * from loads_trips')).rows[0];assert.notEqual(second.dispatch_text_event_id,first.dispatch_text_event_id);assert.equal(second.dispatch_text_sent_at,null);assert.equal(second.notes,'changed');
    const old=await db.query('update loads_trips set dispatch_text_sent_at=now() where id=2 and dispatch_text_event_id=$1 returning id',[first.dispatch_text_event_id]);assert.equal(old.rows.length,0);
    await db.exec("update loads_trips set dispatch_time='09:15'");assert.notEqual((await db.query('select dispatch_text_event_id from loads_trips')).rows[0].dispatch_text_event_id,first.dispatch_text_event_id);
  }finally{await db.close();}
});
test('paused Carrier Docs cannot open old alerts; email contains the exact activation keys',()=>{
  const source=fs.readFileSync('preshift-pro-text.js','utf8');
  assert.match(source,/const CARRIER_DOCS_ALERTS_PAUSED = true/);
  assert.match(source,/async function carrierDocsAlerts\(\) \{\s+if \(CARRIER_DOCS_ALERTS_PAUSED\) return \[\]/);
  assert.match(source,/if \(CARRIER_DOCS_ALERTS_PAUSED\) return;\s+const id = Number\(docs/);
  const email=fs.readFileSync('mondelez.js','utf8');
  for(const line of ['Organization ID: 078605713','Morris IL - 6104','Addison IL - 6136','Indianapolis - 6116','West Chester OH - 6116'])assert.ok(email.includes(line),line);
});
test('actual alerts open the exact draft, cancellation leaves it pending, and only sending acknowledges it',async()=>{
  const dom=new JSDOM('<div id="alert-widget"><div id="alert-widget-body"></div><span id="alert-widget-count"></span></div>',{url:'https://fixture.invalid/index.html'});
  const data={loads_shifts:[{...shift,location:'atlanta',shift_date:timeApi.boardDateKey(new Date()),shift_start:'00:00'}],
    loads_trips:[{...trip,shift_id:shift.id,dispatch_time:new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())},
      {...trip,shift_id:shift.id,id:3,route_id:'FA123',dispatch_time:new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())},
      {...trip,shift_id:shift.id,id:4,route_id:'GA123',dispatch_time:new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())}],
    atlanta_drivers:[{id:7,'Driver Name':'Test Driver','Driver Cell':'7705551234'}]};
  const writes=[],opened=[],audit=[];
  const client={from:table=>{
    const filters=[];let patch=null;
    const q={select:()=>q,in:()=>q,eq:(key,value)=>{filters.push([key,value]);return q;},update:p=>{patch=p;return q;},
      then:resolve=>{const rows=(data[table]||[]).filter(r=>filters.every(([k,v])=>r[k]===v));
        if(patch){writes.push(patch);for(const r of rows)Object.assign(r,patch);}resolve({data:rows,error:null});}};return q;
  }};
  const strip=s=>s.replace(/^import[^;]+;\n/gm,'').replace(/export /g,'');
  const source=strip(fs.readFileSync('overnight-times.js','utf8'))+'\n'+strip(fs.readFileSync('dispatch-route-text.js','utf8'))+'\n'+strip(fs.readFileSync('preshift-pro-text.js','utf8'));
  const env={supabaseClient:client,logAlertTextClick:async details=>{audit.push(details);},openSendTextModal:(...args)=>opened.push(args),setDriverSyncStatus:()=>{},document:dom.window.document,
    window:dom.window,location:dom.window.location,MutationObserver:dom.window.MutationObserver,setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0};
  const module=new Function(...Object.keys(env),source+';return {refreshExtraAlerts};')(...Object.values(env));
  await module.refreshExtraAlerts();
  const buttons=dom.window.document.querySelectorAll('[data-dispatch-text-trip]');assert.equal(buttons.length,1,'only regular routes offer the routine text');
  buttons[0].dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
  await new Promise(setImmediate);
  assert.equal(audit.length,1);assert.deepEqual(audit[0].loadIds,[shift.id]);assert.equal(audit[0].tripId,trip.id);assert.ok(audit[0].label.includes(trip.route_id));
  assert.equal(opened.length,1);assert.equal(opened[0][1],api.DISPATCH_ROUTE_MESSAGE);assert.equal(opened[0][0][0].phone,'7705551234');
  assert.equal(writes.length,0,'opening/cancelling does not mark sent');
  await module.refreshExtraAlerts();assert.equal(dom.window.document.querySelectorAll('[data-dispatch-text-trip]').length,1);
  opened[0][3].onSent();await new Promise(setImmediate);assert.equal(writes.length,1);
  // FA and GA no longer take the routine dispatch text at all (they route to
  // the PA/FA call instead), so once the one regular route is acknowledged
  // there is nothing left to offer. This asserted 2 -- the pre-#240 count --
  // which contradicted the assertion of 0 four lines below it.
  await module.refreshExtraAlerts();assert.equal(dom.window.document.querySelectorAll('[data-dispatch-text-trip]').length,0);
  assert.equal(data.loads_trips.find(t=>t.id===3).dispatch_text_sent_at,undefined);
  assert.equal(data.loads_trips.find(t=>t.id===4).dispatch_text_sent_at,undefined);
  assert.equal(writes.length,1);
  assert.equal(dom.window.document.querySelectorAll('[data-dispatch-text-trip]').length,0);
  dom.window.close();
});
