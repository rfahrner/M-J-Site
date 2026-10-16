-- The Delaware BOL-photo request is its own text with its own alert, so it
-- needs its own sent-marker. Reusing pre_shift_text_sent_at would make
-- sending one of the two silence the other: the ETA reminder and the BOL
-- request both go out at the start of the same shift, and a dispatcher who
-- sent the ETA text would never be prompted for the BOL photos at all.
--
-- Nullable with no default, so this is a catalogue-only change: no table
-- rewrite, no lock held while existing rows are touched, and every shift
-- already on the board reads as "not sent yet", which is correct.
--
-- Applied to production 2026-10-16, before the code that reads it shipped.
alter table public.loads_shifts
  add column if not exists bol_text_sent_at timestamptz;

comment on column public.loads_shifts.bol_text_sent_at is
  'When the BOL-photo request text was sent for this shift (Delaware board). Null means the alert is still asking for it. Separate from pre_shift_text_sent_at, which tracks the ETA reminder.';
