-- Applied to the live project on 2026-09-18. Kept here so the repo and the
-- database do not drift.

-- refresh_accounting_audit_snapshot is SECURITY DEFINER, returns void, and
-- UPDATEs public.loads_accounting past that table's accounting/admin/it-only
-- RLS. It was executable by `anon`, so anyone holding the publishable key --
-- which is public by design, it ships in login.html -- could call it over REST
-- with no session at all. Two consequences: an unauthenticated write amplifier,
-- and a way to wipe the notes/history snapshots that are deliberately retained
-- after a source shift is deleted. The browser never calls it; it exists for
-- the triggers, which run as definer regardless of this grant.
revoke execute on function public.refresh_accounting_audit_snapshot(bigint) from public, anon;

-- The other three are trigger functions, so a direct REST call is rejected by
-- Postgres anyway. Revoked for hygiene rather than because they are reachable.
revoke execute on function public.log_houston_load_change() from public, anon;
revoke execute on function public.seed_accounting_audit_snapshot() from public, anon;
revoke execute on function public.sync_accounting_audit_from_source() from public, anon;
