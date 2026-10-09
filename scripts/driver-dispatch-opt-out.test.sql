-- Run against an isolated database after the dispatcher opt-out migration.
-- Synthetic records are rolled back; no real texts are sent.
begin;
do $test$
declare base bigint; peer public.atlanta_drivers;
begin
  select coalesce(max(id),0)+1000000 into base from public.atlanta_drivers;
  insert into public.atlanta_drivers(id,"Driver Name","MC",location,"Driver Cell")
  values(base,'__DISPATCH_OPT_OUT_TEST__','999999999997','atlanta','5551112222');
  assert (select do_not_text_dispatch=false from public.atlanta_drivers where id=base), 'Existing behavior defaults to allowed';
  insert into public.atlanta_drivers(id,"Driver Name","MC",location)
  values(base+1,'__DISPATCH_OPT_OUT_TEST__','999999999997','preferred');
  update public.atlanta_drivers set do_not_text=true, do_not_text_dispatch=true where id=base+1;
  select * into peer from public.atlanta_drivers where id=base;
  assert peer.do_not_text and peer.do_not_text_dispatch, 'Both flags must save across linked list profiles';
  -- A stale older client edits an unrelated field without the new column.
  update public.atlanta_drivers set "Driver Cell"='5551113333' where id=base;
  assert (select bool_and(do_not_text_dispatch) from public.atlanta_drivers where id in (base,base+1)), 'Older client edits must preserve the dispatcher opt-out';
  insert into public.atlanta_drivers(id,"Driver Name","MC",location,do_not_text,do_not_text_dispatch)
  values(base+2,'__DISPATCH_OPT_OUT_TEST__','999999999997','houston',false,false);
  assert (select bool_and(do_not_text and do_not_text_dispatch) from public.atlanta_drivers where id between base and base+2), 'New list membership must inherit both opt-outs';
  update public.atlanta_drivers set do_not_text_dispatch=false where id=base+2;
  select * into peer from public.atlanta_drivers where id=base;
  assert not peer.do_not_text_dispatch and peer.do_not_text, 'Unchecking dispatch must not clear the driver opt-out';
  update public.atlanta_drivers set do_not_text=false where id=base;
  assert (select bool_and(not do_not_text and not do_not_text_dispatch) from public.atlanta_drivers where id between base and base+2), 'Both flags can be cleared across linked profiles';
end;
$test$;
rollback;
