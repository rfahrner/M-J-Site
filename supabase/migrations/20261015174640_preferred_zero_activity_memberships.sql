-- Retire only Preferred memberships whose displayed activity is 0.
-- Keep all driver IDs and historical links: 364 already have Atlanta peers;
-- move the remaining 9 memberships to Atlanta (also used by Building C).
alter table public.atlanta_drivers add column preferred_list_active boolean not null default true;

-- List membership is local to a row, like location. Editing or inserting a
-- shared contact must not reactivate a retired Preferred membership.
CREATE OR REPLACE FUNCTION public.prepare_shared_driver_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare source public.atlanta_drivers; matched_keys uuid[]; inherited jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.profile_key is distinct from old.profile_key then
      raise exception 'Driver profile identity cannot be changed by an edit';
    end if;
    return new;
  end if;
  if nullif(btrim(new."Driver Name"), '') is null or nullif(btrim(new."MC"), '') is null then return new; end if;
  select array_agg(distinct d.profile_key) into matched_keys from public.atlanta_drivers d
  where lower(regexp_replace(btrim(d."Driver Name"), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(new."Driver Name"), '\s+', ' ', 'g'))
    and btrim(d."MC") = btrim(new."MC");
  if cardinality(matched_keys) = 1 then
    new.profile_key := matched_keys[1];
    select * into source from public.atlanta_drivers where profile_key = new.profile_key order by id limit 1;
    -- Adding list membership must preserve the existing dispatcher opt-out.
    new.do_not_text_dispatch := source.do_not_text_dispatch;
    new.do_not_text := source.do_not_text;
    select jsonb_object_agg(e.key, e.value) into inherited from jsonb_each(to_jsonb(source)) e
    where e.key not in ('id','location','profile_key','preferred_list_active') and
      (to_jsonb(new)->e.key) in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb, '{"tiers":{},"settings":{}}'::jsonb);
    new := jsonb_populate_record(new, coalesce(inherited, '{}'::jsonb));
  end if;
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public.sync_shared_driver_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare patch jsonb; assignments text;
begin
  -- Peer updates run the same triggers. Do not send them back around the group.
  if pg_trigger_depth() > 1 then return new; end if;
  select jsonb_object_agg(e.key, e.value) into patch from jsonb_each(to_jsonb(new)) e
  where e.key not in ('id','location','profile_key','preferred_list_active')
    and (tg_op = 'INSERT' or e.value is distinct from to_jsonb(old)->e.key);
  if patch is null then return new; end if;
  select string_agg(format('%I = ($1).%I', key, key), ', ') into assignments from jsonb_each(patch);
  execute 'update public.atlanta_drivers d set ' || assignments ||
    ' where d.profile_key = $2 and d.id <> $3 and exists (select 1 from jsonb_each($4) e where to_jsonb(d)->e.key is distinct from e.value)'
    using new, new.profile_key, new.id, patch;
  return new;
end;
$function$;


lock table public.atlanta_drivers in share row exclusive mode;
create temporary table preferred_cleanup_plan(driver_id bigint primary key,new_location text,atlanta_peer_id bigint) on commit drop;
insert into preferred_cleanup_plan values
  (6299,'atlanta',null),
  (6683,'atlanta',null),
  (6686,'preferred',7590),
  (6291,'preferred',9806),
  (6575,'preferred',7630),
  (6592,'preferred',7694),
  (6393,'preferred',7457),
  (6300,'atlanta',null),
  (10578,'preferred',10580),
  (10579,'preferred',10580),
  (6615,'atlanta',null),
  (6629,'preferred',7421),
  (10567,'atlanta',null),
  (10584,'preferred',10586),
  (6363,'atlanta',null),
  (6424,'atlanta',null),
  (6579,'atlanta',null),
  (6631,'atlanta',null),
  (10596,'preferred',10597),
  (10603,'preferred',10604),
  (10607,'preferred',10608),
  (6229,'preferred',10284),
  (6253,'preferred',8382),
  (6228,'preferred',9286),
  (6270,'preferred',8914),
  (6247,'preferred',9518),
  (6266,'preferred',10072),
  (6218,'preferred',10239),
  (6265,'preferred',8176),
  (6233,'preferred',10234),
  (6267,'preferred',8298),
  (6674,'preferred',8037),
  (6660,'preferred',8435),
  (6701,'preferred',8564),
  (6696,'preferred',8786),
  (6651,'preferred',7758),
  (6252,'preferred',9477),
  (6682,'preferred',9870),
  (6200,'preferred',8087),
  (6248,'preferred',8396),
  (6705,'preferred',10333),
  (6211,'preferred',7909),
  (6222,'preferred',8669),
  (6236,'preferred',9232),
  (6645,'preferred',9258),
  (6693,'preferred',7385),
  (6672,'preferred',7431),
  (6268,'preferred',7892),
  (6673,'preferred',10337),
  (6239,'preferred',7794),
  (6213,'preferred',7852),
  (6646,'preferred',8515),
  (6704,'preferred',8259),
  (6272,'preferred',8057),
  (6226,'preferred',9820),
  (6315,'preferred',10297),
  (6230,'preferred',9480),
  (6595,'preferred',8193),
  (6609,'preferred',7643),
  (6565,'preferred',10011),
  (6584,'preferred',9146),
  (6294,'preferred',9465),
  (6515,'preferred',7641),
  (6554,'preferred',9978),
  (6583,'preferred',7797),
  (6539,'preferred',7449),
  (6545,'preferred',8972),
  (6495,'preferred',9787),
  (6469,'preferred',9532),
  (6409,'preferred',7269),
  (6580,'preferred',9645),
  (6707,'preferred',7980),
  (6240,'preferred',9473),
  (6414,'preferred',9233),
  (6568,'preferred',8268),
  (6324,'preferred',7595),
  (6436,'preferred',8134),
  (6353,'preferred',7706),
  (6278,'preferred',7689),
  (6382,'preferred',10046),
  (6462,'preferred',8847),
  (6400,'preferred',8521),
  (6271,'preferred',7851),
  (6269,'preferred',8313),
  (6516,'preferred',8246),
  (6526,'preferred',7569),
  (6601,'preferred',7566),
  (6511,'preferred',9928),
  (6486,'preferred',7815),
  (6610,'preferred',10064),
  (6620,'preferred',9780),
  (6607,'preferred',9062),
  (6531,'preferred',9972),
  (6603,'preferred',8898),
  (6368,'preferred',7933),
  (6390,'preferred',9110),
  (6418,'preferred',8078),
  (6389,'preferred',9274),
  (6337,'preferred',9024),
  (6467,'preferred',8642),
  (6281,'preferred',7442),
  (6435,'preferred',7722),
  (6328,'preferred',10288),
  (6306,'preferred',9384),
  (6374,'preferred',8910),
  (6383,'preferred',8315),
  (6387,'preferred',9328),
  (6214,'preferred',7690),
  (6634,'preferred',10332),
  (6479,'preferred',7603),
  (6464,'preferred',7661),
  (6487,'preferred',8657),
  (6370,'preferred',9122),
  (6348,'preferred',10124),
  (6537,'preferred',8114),
  (6514,'preferred',8444),
  (6378,'preferred',8085),
  (6410,'preferred',9538),
  (6532,'preferred',7302),
  (6691,'preferred',7386),
  (6460,'preferred',8508),
  (6292,'preferred',8437),
  (6453,'preferred',7548),
  (6688,'preferred',8787),
  (6204,'preferred',8272),
  (6611,'preferred',8019),
  (6338,'preferred',8505),
  (6305,'preferred',8464),
  (6529,'preferred',9130),
  (6408,'preferred',9304),
  (6468,'preferred',8060),
  (6327,'preferred',9218),
  (6403,'preferred',9771),
  (6386,'preferred',9212),
  (6441,'preferred',9534),
  (6548,'preferred',10068),
  (6259,'preferred',7800),
  (6658,'preferred',10336),
  (6566,'preferred',7668),
  (6285,'preferred',7403),
  (6404,'preferred',8013),
  (6570,'preferred',8835),
  (6461,'preferred',10065),
  (6489,'preferred',8190),
  (6463,'preferred',7700),
  (6617,'preferred',9628),
  (6624,'preferred',9774),
  (6499,'preferred',8831),
  (6597,'preferred',7760),
  (6402,'preferred',9684),
  (6373,'preferred',9214),
  (6465,'preferred',7653),
  (6501,'preferred',7688),
  (6398,'preferred',8230),
  (6397,'preferred',8398),
  (6606,'preferred',9658),
  (6310,'preferred',9611),
  (6627,'preferred',8186),
  (6371,'preferred',9037),
  (6255,'preferred',8058),
  (6656,'preferred',8038),
  (6376,'preferred',8312),
  (6307,'preferred',7619),
  (6553,'preferred',8195),
  (6521,'preferred',8569),
  (6352,'preferred',7666),
  (6540,'preferred',7297),
  (6448,'preferred',10019),
  (6241,'preferred',8092),
  (6227,'preferred',8498),
  (6256,'preferred',9356),
  (6478,'preferred',8068),
  (6355,'preferred',9622),
  (6518,'preferred',7669),
  (6581,'preferred',9396),
  (6561,'preferred',7564),
  (6475,'preferred',9637),
  (6319,'preferred',8499),
  (6428,'preferred',9539),
  (6450,'preferred',8133),
  (6653,'preferred',7388),
  (6366,'preferred',8644),
  (6578,'preferred',9581),
  (6443,'preferred',7792),
  (6596,'preferred',8951),
  (6282,'preferred',7435),
  (6455,'preferred',7784),
  (6395,'preferred',7555),
  (6549,'preferred',8970),
  (6377,'preferred',8561),
  (6442,'preferred',9366),
  (6503,'preferred',7859),
  (6608,'preferred',8691),
  (6316,'preferred',9027),
  (6283,'preferred',8619),
  (6550,'preferred',9378),
  (6618,'preferred',8550),
  (6425,'preferred',9923),
  (6439,'preferred',8587),
  (6530,'preferred',7362),
  (6251,'preferred',8426),
  (6449,'preferred',10022),
  (6544,'preferred',7924),
  (6538,'preferred',8188),
  (6303,'preferred',9619),
  (6416,'preferred',7735),
  (6365,'preferred',7558),
  (6505,'preferred',9226),
  (6639,'preferred',7390),
  (6644,'preferred',8179),
  (6605,'preferred',9664),
  (6625,'preferred',9412),
  (6493,'preferred',8077),
  (6576,'preferred',8529),
  (6602,'preferred',8600),
  (6320,'preferred',9612),
  (6396,'preferred',8590),
  (6318,'preferred',8300),
  (6438,'preferred',10023),
  (6573,'preferred',9461),
  (6593,'preferred',7882),
  (6385,'preferred',9410),
  (6388,'preferred',8913),
  (6440,'preferred',8971),
  (6496,'preferred',8184),
  (6524,'preferred',10025),
  (6585,'preferred',8836),
  (6543,'preferred',8762),
  (6367,'preferred',7405),
  (6527,'preferred',8224),
  (6589,'preferred',8854),
  (6326,'preferred',9496),
  (6401,'preferred',9164),
  (6231,'preferred',7380),
  (6638,'preferred',7691),
  (6209,'preferred',8271),
  (6447,'preferred',7553),
  (6522,'preferred',8615),
  (6619,'preferred',9635),
  (6577,'preferred',8558),
  (6413,'preferred',7446),
  (6296,'preferred',8715),
  (6481,'preferred',9253),
  (6520,'preferred',9716),
  (6474,'preferred',8674),
  (6207,'preferred',9638),
  (6662,'preferred',10335),
  (6567,'preferred',7696),
  (6562,'preferred',10259),
  (6351,'preferred',7512),
  (6359,'preferred',9313),
  (6350,'preferred',9474),
  (6289,'preferred',7551),
  (6329,'preferred',8466),
  (6604,'preferred',7869),
  (6313,'preferred',9788),
  (6384,'preferred',9941),
  (6243,'preferred',7791),
  (6360,'preferred',9203),
  (6517,'preferred',8072),
  (6333,'preferred',8853),
  (6588,'preferred',8741),
  (6466,'preferred',8929),
  (6331,'preferred',9833),
  (6492,'preferred',8279),
  (6437,'preferred',9770),
  (6431,'preferred',10043),
  (6630,'preferred',9215),
  (6372,'preferred',8369),
  (6652,'preferred',9259),
  (6284,'preferred',8712),
  (6500,'preferred',8639),
  (6480,'preferred',9048),
  (6277,'preferred',10052),
  (6314,'preferred',7729),
  (6506,'preferred',10251),
  (6417,'preferred',7448),
  (6582,'preferred',7697),
  (6215,'preferred',8562),
  (6216,'preferred',7387),
  (6342,'preferred',9457),
  (6560,'preferred',9630),
  (6632,'preferred',8006),
  (6534,'preferred',8425),
  (6339,'preferred',7842),
  (6280,'preferred',9832),
  (6614,'preferred',9773),
  (6558,'preferred',7532),
  (6594,'preferred',9678),
  (6599,'preferred',8808),
  (6488,'preferred',7663),
  (6502,'preferred',8678),
  (6325,'preferred',7298),
  (6709,'preferred',9426),
  (6391,'preferred',9435),
  (6399,'preferred',10010),
  (6535,'preferred',8713),
  (6336,'preferred',7476),
  (6586,'preferred',7634),
  (6482,'preferred',8278),
  (6290,'preferred',8494),
  (6513,'preferred',8613),
  (6457,'preferred',9934),
  (6574,'preferred',8322),
  (6344,'preferred',8573),
  (6542,'preferred',7762),
  (6434,'preferred',8537),
  (6346,'preferred',8511),
  (6509,'preferred',8183),
  (6557,'preferred',9013),
  (6419,'preferred',8677),
  (6546,'preferred',8962),
  (6311,'preferred',9160),
  (6405,'preferred',9809),
  (6334,'preferred',8632),
  (6407,'preferred',7409),
  (6301,'preferred',7259),
  (6564,'preferred',9731),
  (6621,'preferred',7284),
  (6406,'preferred',9537),
  (6563,'preferred',8021),
  (6421,'preferred',10031),
  (6559,'preferred',7370),
  (6380,'preferred',7470),
  (6349,'preferred',8454),
  (6394,'preferred',8065),
  (6343,'preferred',8673),
  (6392,'preferred',9486),
  (6569,'preferred',9057),
  (6613,'preferred',8699),
  (6700,'preferred',7389),
  (6258,'preferred',8772),
  (6497,'preferred',9134),
  (6591,'preferred',8732),
  (6361,'preferred',8544),
  (6512,'preferred',7570),
  (6298,'preferred',9577),
  (6358,'preferred',7915),
  (6483,'preferred',7704),
  (6445,'preferred',8314),
  (6555,'preferred',7571),
  (6356,'preferred',8390),
  (6420,'preferred',9719),
  (6498,'preferred',8073),
  (6451,'preferred',8571),
  (6332,'preferred',9621),
  (6622,'preferred',8577),
  (6504,'preferred',9636),
  (6308,'preferred',8582),
  (6354,'preferred',9460),
  (6657,'preferred',8810),
  (6262,'preferred',9689),
  (6525,'preferred',9185),
  (6476,'preferred',7665),
  (6626,'preferred',9927),
  (6369,'preferred',8645),
  (6415,'preferred',10039),
  (6528,'preferred',9476),
  (6551,'preferred',7870),
  (6459,'preferred',7659),
  (6224,'preferred',7438),
  (6703,'preferred',7474),
  (6708,'preferred',10331),
  (6612,'preferred',8656),
  (6552,'preferred',9466),
  (6523,'preferred',7674),
  (6427,'preferred',9417),
  (6508,'preferred',9813),
  (6322,'preferred',8269),
  (6456,'preferred',7318),
  (6264,'preferred',10075),
  (6260,'preferred',10143),
  (6422,'preferred',7541);
create temporary table preferred_cleanup_before on commit drop as
  select d.id,to_jsonb(d) snapshot from public.atlanta_drivers d;
do $$
begin
  if (select count(*) from preferred_cleanup_plan)<>373 then raise exception 'Unexpected plan size'; end if;
  if exists(select 1 from preferred_cleanup_plan p left join public.atlanta_drivers d on d.id=p.driver_id
    where d.id is null or d.location<>'preferred' or not d.preferred_list_active) then
    raise exception 'A Preferred membership changed since review';
  end if;
  if exists(select 1 from preferred_cleanup_plan p join public.atlanta_drivers d on d.id=p.driver_id
    where p.new_location='preferred' and not exists(select 1 from public.atlanta_drivers a
      where a.id=p.atlanta_peer_id and a.profile_key=d.profile_key and a.location='atlanta')) then
    raise exception 'A reviewed Atlanta membership is missing';
  end if;
  if exists(select 1 from preferred_cleanup_plan p join public.atlanta_drivers d on d.id=p.driver_id
    where p.new_location='atlanta' and exists(select 1 from public.atlanta_drivers a
      where a.profile_key=d.profile_key and a.location='atlanta')) then
    raise exception 'An Atlanta membership was added after review; regenerate the plan';
  end if;
end;
$$;
insert into private.driver_profile_sync_backups(migration_name,driver_id,snapshot)
  select 'preferred_zero_activity_memberships_20261015',b.id,
    b.snapshot || jsonb_build_object('_preferred_cleanup',jsonb_build_object('new_location',p.new_location,'new_active',false))
  from preferred_cleanup_before b join preferred_cleanup_plan p on p.driver_id=b.id;

update public.atlanta_drivers d set location=p.new_location,preferred_list_active=false
from preferred_cleanup_plan p where d.id=p.driver_id;

do $$
begin
  if exists(select 1 from preferred_cleanup_plan p join public.atlanta_drivers d on d.id=p.driver_id
    where d.preferred_list_active or d.location<>p.new_location
      or not exists(select 1 from public.atlanta_drivers a where a.location='atlanta' and a.profile_key=d.profile_key)) then
    raise exception 'A retired Preferred member is missing from Atlanta/Building C';
  end if;
  if exists(select 1 from preferred_cleanup_before b full join public.atlanta_drivers d on d.id=b.id
    where b.id is null or d.id is null or
      (to_jsonb(d)-'location'-'preferred_list_active') is distinct from (b.snapshot-'location'-'preferred_list_active')) then
    raise exception 'A driver ID, profile field, or historical identity changed';
  end if;
  if exists(select 1 from preferred_cleanup_before b join public.atlanta_drivers d on d.id=b.id
    where not exists(select 1 from preferred_cleanup_plan p where p.driver_id=d.id)
      and to_jsonb(d) is distinct from b.snapshot) then raise exception 'An unplanned membership changed'; end if;
end;
$$;
