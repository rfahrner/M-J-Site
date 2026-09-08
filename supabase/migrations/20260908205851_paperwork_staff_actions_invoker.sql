-- The staff RPCs only need the privileges already granted to authenticated
-- internal M-J users. Running as SECURITY INVOKER keeps RLS and grants in
-- force and removes unnecessary definer-level privilege escalation.
alter function public.assign_paperwork_submission(uuid,text,bigint) security invoker;
alter function public.soft_delete_paperwork_submission(uuid) security invoker;
