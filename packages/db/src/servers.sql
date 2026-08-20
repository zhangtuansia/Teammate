-- ============================================================
-- Servers & Server Members — Multi-workspace support
-- Run this in Supabase SQL Editor
-- ============================================================

-- -----------------------------------------------------------
-- Tables (create if not exists)
-- -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.servers (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.server_members (
  server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  member_id uuid NOT NULL,
  member_type text NOT NULL CHECK (member_type IN ('human', 'agent')),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, member_id)
);

-- -----------------------------------------------------------
-- Helper function (SECURITY DEFINER bypasses RLS, breaks recursion)
-- -----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_is_server_member(server_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.server_members
    WHERE server_id = server_uuid AND member_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- -----------------------------------------------------------
-- RLS
-- -----------------------------------------------------------

ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_members ENABLE ROW LEVEL SECURITY;

-- Servers: users can see servers they own or are members of
DROP POLICY IF EXISTS "Users can view their servers" ON public.servers;
CREATE POLICY "Users can view their servers"
  ON public.servers FOR SELECT
  USING (
    owner_id = auth.uid()
    OR public.user_is_server_member(id)
  );

-- Servers: authenticated users can create servers (must be owner)
DROP POLICY IF EXISTS "Users can create servers" ON public.servers;
CREATE POLICY "Users can create servers"
  ON public.servers FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

-- Servers: owner can update
DROP POLICY IF EXISTS "Owner can update server" ON public.servers;
CREATE POLICY "Owner can update server"
  ON public.servers FOR UPDATE
  USING (auth.uid() = owner_id);

-- Servers: owner can delete
DROP POLICY IF EXISTS "Owner can delete server" ON public.servers;
CREATE POLICY "Owner can delete server"
  ON public.servers FOR DELETE
  USING (auth.uid() = owner_id);

-- Server members: members can see other members of their servers
DROP POLICY IF EXISTS "Members can view server members" ON public.server_members;
CREATE POLICY "Members can view server members"
  ON public.server_members FOR SELECT
  USING (public.user_is_server_member(server_id));

-- Server members: server owner or self-add
DROP POLICY IF EXISTS "Users can join servers" ON public.server_members;
CREATE POLICY "Users can join servers"
  ON public.server_members FOR INSERT
  WITH CHECK (
    -- User adding themselves
    (auth.uid() = member_id AND member_type = 'human')
    OR
    -- Server owner adding anyone (use SECURITY DEFINER function to avoid cross-table recursion)
    auth.uid() = (SELECT owner_id FROM public.servers WHERE id = server_id)
  );

-- Server members: owner can remove members, or members can leave
DROP POLICY IF EXISTS "Users can leave servers" ON public.server_members;
CREATE POLICY "Users can leave servers"
  ON public.server_members FOR DELETE
  USING (
    auth.uid() = member_id
    OR auth.uid() = (SELECT owner_id FROM public.servers WHERE id = server_id)
  );
