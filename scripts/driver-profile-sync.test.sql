-- Database regression checks: all fixtures are rolled back. Run after the migration.
begin;
do $test$
declare base bigint; key uuid; target public.atlanta_drivers;
begin
  select max(id)+1000000 into base from public.atlanta_drivers;
  insert into public.atlanta_drivers(id,"Driver Name","MC",location,"Driver Cell",atlanta_rate_overrides)
  values(base,'__PROFILE_SYNC_TEST__','999999999999','atlanta','5551112222','{"tiers":{"3":400},"settings":{}}');
  insert into public.atlanta_drivers(id,"Driver Name","MC",location)
  values(base+1,'__PROFILE_SYNC_TEST__','999999999999','preferred');
  select profile_key into key from public.atlanta_drivers where id=base;
  select * into target from public.atlanta_drivers where id=base+1;
  assert target.profile_key=key and target.atlanta_rate_overrides->'tiers'->>'3'='400', 'New membership must inherit the saved card';
  insert into public.atlanta_drivers(id,"Driver Name","MC",location,"Driver Cell")
  values(base+2,'__OTHER_DRIVER_TEST__','999999999999','atlanta','5559999999');
  update public.atlanta_drivers set atlanta_rate_overrides='{"tiers":{"3":475},"settings":{}}',"Driver Cell"='5551234567',"Driver Rating"='B' where id=base+1;
  select * into target from public.atlanta_drivers where id=base;
  assert target.atlanta_rate_overrides->'tiers'->>'3'='475' and target."Driver Cell"='5551234567' and target."Driver Rating"='B', 'Preferred edits must reach Atlanta';
  select * into target from public.atlanta_drivers where id=base+2;
  assert target."Driver Cell"='5559999999', 'Same carrier must not update another driver';
  update public.atlanta_drivers set "Driver Name"='__RENAMED_PROFILE_TEST__',"MC"='999999999998' where id=base;
  select * into target from public.atlanta_drivers where id=base+1;
  assert target."Driver Name"='__RENAMED_PROFILE_TEST__' and target."MC"='999999999998' and target.profile_key=key, 'Identity edits must preserve the shared group';
  update public.atlanta_drivers set "Notes"='Saved from Atlanta' where id=base;
  update public.atlanta_drivers set "E mail"='profile-test@example.invalid' where id=base+1;
  select * into target from public.atlanta_drivers where id=base;
  assert target."Notes"='Saved from Atlanta' and target."E mail"='profile-test@example.invalid', 'Unrelated field edits must coexist';
  update public.atlanta_drivers set atlanta_rate_overrides=null,"Driver Cell"=null where id=base+1;
  select * into target from public.atlanta_drivers where id=base;
  assert target.atlanta_rate_overrides is null and target."Driver Cell" is null, 'Explicit clears must propagate';
  assert (select count(distinct location) from public.atlanta_drivers where profile_key=key)=2, 'List memberships must remain separate';
  assert (select count(*) from public.atlanta_drivers where "Driver Name"='__OTHER_DRIVER_TEST__')=1, 'Peer synchronization must not create duplicates';
end;
$test$;

rollback;
