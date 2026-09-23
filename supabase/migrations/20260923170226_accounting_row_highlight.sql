alter table public.loads_accounting
  add column if not exists highlighted boolean not null default false;
