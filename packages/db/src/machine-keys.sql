-- ============================================================
-- Machine API Keys for Bridge Authentication
-- Run this in Supabase SQL Editor
-- ============================================================

-- Machine keys table — stores hashed API keys for bridge connections
CREATE TABLE IF NOT EXISTS public.machine_keys (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  key_prefix text NOT NULL,          -- first 8 chars of key (for display: "zk_a1b2...")
  key_hash text NOT NULL UNIQUE,     -- SHA-256 hash of the full key
  key_value text,                    -- full key (stored for user convenience, RLS-protected)
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Default',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

ALTER TABLE public.machine_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own keys"
  ON public.machine_keys FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own keys"
  ON public.machine_keys FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own keys"
  ON public.machine_keys FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own keys"
  ON public.machine_keys FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================
-- Helper functions for bridge auth
-- ============================================================

-- Check if a given agent is owned by the current user
CREATE OR REPLACE FUNCTION public.user_owns_agent(agent_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agents WHERE id = agent_uuid AND owner_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Check if current user has an agent in a given channel
CREATE OR REPLACE FUNCTION public.user_has_agent_in_channel(chan_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.channel_members cm
    JOIN public.agents a ON a.id = cm.member_id
    WHERE cm.channel_id = chan_uuid
      AND cm.member_type = 'agent'
      AND a.owner_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

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
      AND public.user_is_channel_member(channel_id)
    )
    OR
    (
      -- User sends as their own agent
      public.user_owns_agent(sender_id)
      AND public.user_has_agent_in_channel(channel_id)
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
    type = 'public'
    OR created_by = auth.uid()
    OR id IN (SELECT channel_id FROM public.channel_members WHERE member_id = auth.uid())
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
CREATE POLICY "Channel members can manage tasks"
  ON public.tasks FOR ALL
  USING (
    public.user_is_channel_member(channel_id)
    OR public.user_has_agent_in_channel(channel_id)
  );

-- Agents UPDATE: owners can update their agents (already exists, but ensure it works)
-- The existing policy "Owner can manage own agents" FOR ALL USING (auth.uid() = owner_id)
-- already covers this. No change needed.
