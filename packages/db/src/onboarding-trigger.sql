-- Legacy onboarding-trigger cleanup.
--
-- Workspace creation now happens explicitly in the web onboarding flow. The
-- former profile trigger predated workspace-scoped agents and channels; leaving
-- it installed makes profile creation fail against the current schema.

drop trigger if exists on_profile_created on public.profiles;
drop function if exists public.handle_new_profile();
