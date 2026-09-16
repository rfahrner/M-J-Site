-- If the Accounting row already exists, the source shift has in fact been
-- transferred. Keep the source flag consistent so board-side retry logic does
-- not keep checking an already-created Accounting row.
update public.loads_shifts s
set sent_to_accounting=true
where coalesce(s.sent_to_accounting,false)=false
  and exists (
    select 1 from public.loads_accounting a where a.source_shift_id=s.id
  );
