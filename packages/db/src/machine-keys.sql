-- ============================================================
-- Machine API Keys for Bridge Authentication
-- Run this in Supabase SQL Editor
-- ============================================================

-- Machine keys table — stores hashed API keys for bridge connections
CREATE TABLE IF NOT EXISTS public.machine_keys (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  key_prefix text NOT NULL,          -- first 8 chars of key (for display: "tm_a1b2...")
  key_hash text NOT NULL UNIQUE,     -- SHA-256 hash of the full key
  key_value text,                    -- legacy nullable column; new keys are never persisted in plaintext
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Default',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- Authentication uses key_hash; clearing legacy plaintext does not revoke a key.
UPDATE public.machine_keys SET key_value = NULL WHERE key_value IS NOT NULL;

ALTER TABLE public.machine_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own keys" ON public.machine_keys;
CREATE POLICY "Users can view own keys"
  ON public.machine_keys FOR SELECT
  USING (public.teammate_is_human_session() AND auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own keys" ON public.machine_keys;
-- Key creation is intentionally RPC-only. This closes the check/insert race
-- with workspace member eviction and also prevents Bridge JWTs from minting
-- new long-lived credentials.

CREATE OR REPLACE FUNCTION public.create_current_user_machine_key(
  server_uuid uuid,
  machine_key_prefix text,
  machine_key_hash text,
  machine_key_name text
)
RETURNS jsonb AS $$
DECLARE
  requesting_user_id uuid := auth.uid();
  workspace_owner_id uuid;
  created_key public.machine_keys%ROWTYPE;
BEGIN
  IF requesting_user_id IS NULL OR public.teammate_is_bridge_session() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Human authentication required';
  END IF;
  IF server_uuid IS NULL
    OR COALESCE(machine_key_prefix, '') !~ '^tm_[0-9a-f]{8}$'
    OR COALESCE(machine_key_hash, '') !~ '^[0-9a-f]{64}$'
    OR COALESCE(char_length(trim(machine_key_name)), 0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid runtime key';
  END IF;

  SELECT server.owner_id
    INTO workspace_owner_id
  FROM public.servers server
  WHERE server.id = server_uuid
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Workspace access denied';
  END IF;
  IF workspace_owner_id <> requesting_user_id THEN
    PERFORM 1
    FROM public.server_members member
    WHERE member.server_id = server_uuid
      AND member.member_id = requesting_user_id
      AND member.member_type = 'human'
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Workspace access denied';
    END IF;
  END IF;

  INSERT INTO public.machine_keys (
    key_prefix,
    key_hash,
    key_value,
    user_id,
    server_id,
    name
  ) VALUES (
    machine_key_prefix,
    machine_key_hash,
    NULL,
    requesting_user_id,
    server_uuid,
    trim(machine_key_name)
  ) RETURNING * INTO created_key;

  RETURN jsonb_build_object(
    'id', created_key.id,
    'key_prefix', created_key.key_prefix,
    'name', created_key.name,
    'created_at', created_key.created_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.create_current_user_machine_key(uuid, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.create_current_user_machine_key(uuid, text, text, text) TO authenticated;

DROP POLICY IF EXISTS "Users can update own keys" ON public.machine_keys;
CREATE OR REPLACE FUNCTION public.machine_key_identity_is_unchanged(
  machine_key_uuid uuid,
  next_user_uuid uuid,
  next_server_uuid uuid,
  next_key_prefix text,
  next_key_hash text,
  next_key_value text
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.machine_keys machine_key
    WHERE machine_key.id = machine_key_uuid
      AND machine_key.user_id = next_user_uuid
      AND machine_key.server_id = next_server_uuid
      AND machine_key.key_prefix = next_key_prefix
      AND machine_key.key_hash = next_key_hash
      AND machine_key.key_value IS NOT DISTINCT FROM next_key_value
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.machine_key_identity_is_unchanged(uuid, uuid, uuid, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.machine_key_identity_is_unchanged(uuid, uuid, uuid, text, text, text) TO authenticated;

CREATE POLICY "Users can update own keys"
  ON public.machine_keys FOR UPDATE
  USING (public.teammate_is_human_session() AND auth.uid() = user_id)
  WITH CHECK (
    public.teammate_is_human_session()
    AND auth.uid() = user_id
    AND public.machine_key_identity_is_unchanged(
      id,
      user_id,
      server_id,
      key_prefix,
      key_hash,
      key_value
    )
  );

DROP POLICY IF EXISTS "Users can delete own keys" ON public.machine_keys;
CREATE POLICY "Users can delete own keys"
  ON public.machine_keys FOR DELETE
  USING (public.teammate_is_human_session() AND auth.uid() = user_id);

-- ============================================================
-- Helper functions for bridge auth
-- ============================================================

-- Check if a given agent is owned by the current user
CREATE OR REPLACE FUNCTION public.user_owns_agent(agent_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agents WHERE id = agent_uuid AND owner_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- Check if current user has an agent in a given channel
CREATE OR REPLACE FUNCTION public.user_has_agent_in_channel(chan_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.channel_members cm
    JOIN public.agents a ON a.id = cm.member_id AND cm.member_type = 'agent'
    JOIN public.channels c
      ON c.id = cm.channel_id AND c.server_id = a.server_id
    JOIN public.server_members agent_membership
      ON agent_membership.server_id = c.server_id
     AND agent_membership.member_id = a.id
     AND agent_membership.member_type = 'agent'
    JOIN public.servers workspace ON workspace.id = c.server_id
    WHERE cm.channel_id = chan_uuid
      AND a.owner_id = auth.uid()
      AND public.teammate_bridge_session_matches_server(c.server_id)
      AND COALESCE(
        (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
          ->> 'teammate_bridge') = 'true',
        false
      )
      AND COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        ->> 'teammate_server_id' = c.server_id::text
      AND (
        workspace.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1
          FROM public.server_members owner_membership
          WHERE owner_membership.server_id = c.server_id
            AND owner_membership.member_id = auth.uid()
            AND owner_membership.member_type = 'human'
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- Check that a specific agent belongs to the current user and is in the channel
CREATE OR REPLACE FUNCTION public.user_owns_agent_in_channel(agent_uuid uuid, chan_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agents a
    JOIN public.channel_members cm
      ON cm.member_id = a.id AND cm.member_type = 'agent'
    JOIN public.channels c
      ON c.id = cm.channel_id AND c.server_id = a.server_id
    JOIN public.server_members agent_membership
      ON agent_membership.server_id = c.server_id
     AND agent_membership.member_id = a.id
     AND agent_membership.member_type = 'agent'
    JOIN public.servers workspace ON workspace.id = c.server_id
    WHERE a.id = agent_uuid
      AND a.owner_id = auth.uid()
      AND cm.channel_id = chan_uuid
      AND public.teammate_bridge_session_matches_server(c.server_id)
      AND COALESCE(
        (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
          ->> 'teammate_bridge') = 'true',
        false
      )
      AND COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        ->> 'teammate_server_id' = c.server_id::text
      AND (
        workspace.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1
          FROM public.server_members owner_membership
          WHERE owner_membership.server_id = c.server_id
            AND owner_membership.member_id = auth.uid()
            AND owner_membership.member_type = 'human'
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.user_owns_agent(uuid) FROM public;
REVOKE ALL ON FUNCTION public.user_has_agent_in_channel(uuid) FROM public;
REVOKE ALL ON FUNCTION public.user_owns_agent_in_channel(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.user_owns_agent(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_agent_in_channel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_owns_agent_in_channel(uuid, uuid) TO authenticated;

-- ============================================================
-- Updated RLS policies for bridge operations
-- Bridge authenticates with a JWT containing the user's ID,
-- so auth.uid() returns the user — but bridge needs to
-- operate on behalf of the user's agents.
-- ============================================================

-- Messages SELECT: user is member OR user owns an agent that is member
DROP POLICY IF EXISTS "Users can view messages in their channels" ON public.messages;
DROP POLICY IF EXISTS "Channel members can view messages" ON public.messages;
CREATE POLICY "Users can view messages in their channels"
  ON public.messages FOR SELECT
  USING (
    public.user_is_channel_member(channel_id)
    OR public.user_has_agent_in_channel(channel_id)
  );

-- Messages INSERT: user sends own message OR sends as their agent
DROP POLICY IF EXISTS "Users can send messages in their channels" ON public.messages;
DROP POLICY IF EXISTS "Channel members can send messages" ON public.messages;
CREATE POLICY "Users can send messages in their channels"
  ON public.messages FOR INSERT
  WITH CHECK (
    (
      -- User sends as themselves
      sender_id = auth.uid()
      AND sender_type = 'human'
      AND NOT public.teammate_is_bridge_session()
      AND public.user_is_channel_member(channel_id)
    )
    OR
    (
      -- User sends as their own agent
      sender_type = 'agent'
      AND
      public.user_owns_agent_in_channel(sender_id, channel_id)
    )
  );

-- Channel members SELECT: also allow if user owns an agent in that channel
DROP POLICY IF EXISTS "Users can view channel memberships" ON public.channel_members;
DROP POLICY IF EXISTS "Members can view channel membership" ON public.channel_members;
CREATE POLICY "Users can view channel memberships"
  ON public.channel_members FOR SELECT
  USING (
    public.user_is_channel_member(channel_id)
    OR public.user_has_agent_in_channel(channel_id)
  );

-- Channels SELECT: also allow if user owns an agent that is a member
DROP POLICY IF EXISTS "Users can view their channels" ON public.channels;
DROP POLICY IF EXISTS "Channel members can view channels" ON public.channels;
CREATE POLICY "Users can view their channels"
  ON public.channels FOR SELECT
  USING (
    (type = 'public' AND public.user_is_server_human_member(server_id))
    OR (created_by = auth.uid() AND public.user_is_server_human_member(server_id))
    OR public.user_is_channel_member(id)
    OR public.user_has_agent_in_channel(id)
  );

-- Tasks: also allow if user owns an agent in the channel
DROP POLICY IF EXISTS "Channel members can view tasks" ON public.tasks;
CREATE POLICY "Channel members can view tasks"
  ON public.tasks FOR SELECT
  USING (
    public.user_is_channel_member(channel_id)
    OR public.user_has_agent_in_channel(channel_id)
  );

DROP POLICY IF EXISTS "Channel members can manage tasks" ON public.tasks;
DROP POLICY IF EXISTS "Channel members can update tasks" ON public.tasks;
DROP POLICY IF EXISTS "Channel members can delete tasks" ON public.tasks;
-- Task deletion stays closed until an actor-scoped lifecycle RPC can preserve
-- the source message, hierarchy and optimistic-concurrency contract.

-- Agent INSERT/UPDATE/DELETE policies are finalized by fix-rls.sql in the
-- documented installation order.
