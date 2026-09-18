-- Keep the original insertion time as an audit field, but store the shift
-- date/time separately for cancellation display and chronological placement.
-- No foreign key to loads_shifts: notes must survive the load's archival.
alter table public.driver_notes
  add column created_by text,
  add column note_type text not null default 'note'
    check (note_type in ('note', 'cancellation')),
  add column source_shift_id bigint,
  add column source_shift_date date,
  add column source_shift_start text,
  add column source_load_label text;

-- Only NEW notes get the authenticated author's label by default. Never
-- attribute historical notes to the person running this migration.
alter table public.driver_notes alter column created_by
  set default nullif(split_part(auth.jwt() ->> 'email', '@', 1), '');

-- Enrich legacy cancellation notes only if load date + PRO + driver resolve
-- to exactly one source shift. Preserve note_text and created_at verbatim.
with parsed as (
  select n.*,
         regexp_match(n.note_text, '^Cancellation — ([0-9]{4}-[0-9]{2}-[0-9]{2}) — (.*?) — ') as parts
  from public.driver_notes n
), candidates as (
  select n.id as note_id, n.created_at, s.id as shift_id,
         s.shift_date, s.shift_start, s.pro_number,
         count(*) over (partition by n.id) as match_count
  from parsed n
  join public.atlanta_drivers d on d.id = n.driver_id
  join public.loads_shifts s
    on s.shift_date::text = n.parts[1]
   and s.pro_number = n.parts[2]
   and (s.driver_id = n.driver_id or (
     s.driver_id is null
     and lower(btrim(regexp_replace(s.driver_name_text, '\s*-\s*$', ''))) = lower(btrim(d."Driver Name"))
   ))
  where n.parts is not null
), metadata as (
  select c.*, (
    select h.changed_by
    from public.load_change_history h
    where h.shift_id = c.shift_id
      and h.field_name = 'called_off'
      and h.new_value = 'true'
      and h.changed_at <= c.created_at
      and nullif(btrim(h.changed_by), '') is not null
      and lower(h.changed_by) <> 'unknown user'
    order by h.changed_at desc, h.id desc
    limit 1
  ) as author
  from candidates c
  where c.match_count = 1
)
update public.driver_notes n
set note_type = 'cancellation',
    source_shift_id = m.shift_id,
    source_shift_date = m.shift_date,
    source_shift_start = m.shift_start,
    source_load_label = m.pro_number,
    created_by = coalesce(n.created_by, m.author)
from metadata m
where n.id = m.note_id;

-- RLS and the internal-role policies on driver_notes are unchanged.
