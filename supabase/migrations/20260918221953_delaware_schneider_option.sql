-- Optional Delaware worksheet marker: false displays as blank.
ALTER TABLE public.loads_shifts
  ADD COLUMN IF NOT EXISTS schneider boolean NOT NULL DEFAULT false;
