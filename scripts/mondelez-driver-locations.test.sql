-- Isolated regression fixtures; run after the Mondelez location migration.
begin;
do $test$
declare base bigint; peer public.atlanta_drivers;
begin
  select coalesce(max(id),0)+1000000 into base from public.atlanta_drivers;
  insert into public.atlanta_drivers(id,"Driver Name","MC",location)
  values(base,'__MONDELEZ_LOCATION_TEST__','999999999996','atlanta');
  assert (select mondelez_locations is null from public.atlanta_drivers where id=base), 'New profiles must be unassigned';
  insert into public.atlanta_drivers(id,"Driver Name","MC",location)
  values(base+1,'__MONDELEZ_LOCATION_TEST__','999999999996','preferred');
  update public.atlanta_drivers set mondelez_locations=array['morris','addison'] where id=base;
  select * into peer from public.atlanta_drivers where id=base+1;
  assert peer.mondelez_locations=array['morris','addison'], 'Multiple locations must save across linked profiles';
  update public.atlanta_drivers set "Driver Cell"='5551114444' where id=base+1;
  assert (select mondelez_locations=array['morris','addison'] from public.atlanta_drivers where id=base), 'Old client edits must preserve origin assignments';
  insert into public.atlanta_drivers(id,"Driver Name","MC",location)
  values(base+2,'__MONDELEZ_LOCATION_TEST__','999999999996','houston');
  assert (select mondelez_locations=array['morris','addison'] from public.atlanta_drivers where id=base+2), 'New membership must inherit the saved origin assignments';
  update public.atlanta_drivers set mondelez_locations=null where id=base+1;
  assert (select bool_and(mondelez_locations is null) from public.atlanta_drivers where id between base and base+2), 'Clearing locations must synchronize';
end;
$test$;
rollback;
