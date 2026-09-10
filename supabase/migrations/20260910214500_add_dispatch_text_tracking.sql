alter table public.loads_shifts
  add column if not exists carrier_docs_text_sent_at timestamptz;

alter table public.loads_houston
  add column if not exists pre_shift_text_sent_at timestamptz;
