-- Final RLS upgrade. SECURITY DEFINER helpers avoid circular policy lookups;
-- every helper pins search_path because authenticated users execute them.

-- Bring databases created from pre-document/pre-inbox releases to the current
-- table shape before any helper or policy below references the new objects.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS parent_task_id uuid
  REFERENCES public.tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON public.tasks(parent_task_id);

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Historical tasks used the first visible message line as their display title.
-- Materialize that value once so later task edits never rewrite chat history.
UPDATE public.tasks task
SET title = left(
  coalesce(
    nullif(btrim(task.title), ''),
    (
      SELECT nullif(btrim(line.value), '')
      FROM public.messages message
      CROSS JOIN LATERAL regexp_split_to_table(
        replace(message.content, E'\r\n', E'\n'),
        E'\n'
      ) WITH ORDINALITY AS line(value, position)
      WHERE message.id = task.message_id
        AND btrim(line.value) <> ''
      ORDER BY line.position
      LIMIT 1
    ),
    'Untitled task'
  ),
  500
)
WHERE task.title IS NULL
   OR btrim(task.title) = ''
   OR char_length(task.title) > 500;

UPDATE public.tasks
SET description = ''
WHERE description IS NULL;

ALTER TABLE public.tasks
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN description SET DEFAULT '',
  ALTER COLUMN description SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tasks'::regclass
      AND conname = 'tasks_title_length'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_title_length
      CHECK (char_length(title) BETWEEN 1 AND 500) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tasks'::regclass
      AND conname = 'tasks_description_length'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_description_length
      CHECK (char_length(description) <= 100000) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.tasks VALIDATE CONSTRAINT tasks_title_length;
ALTER TABLE public.tasks VALIDATE CONSTRAINT tasks_description_length;

CREATE INDEX IF NOT EXISTS idx_tasks_channel_active
  ON public.tasks(channel_id, status, task_number)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.documents (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE NOT NULL,
  title text NOT NULL,
  content text DEFAULT '' NOT NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  generated_by_agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS generated_by_agent_id uuid
  REFERENCES public.agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_documents_server_updated
  ON public.documents(server_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.message_deliveries (
  message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE NOT NULL,
  agent_id uuid REFERENCES public.agents(id) ON DELETE CASCADE NOT NULL,
  server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE NOT NULL,
  channel_id uuid REFERENCES public.channels(id) ON DELETE CASCADE NOT NULL,
  status text DEFAULT 'pending' NOT NULL
    CHECK (status IN ('pending', 'processing', 'completed', 'skipped', 'failed')),
  attempts integer DEFAULT 0 NOT NULL CHECK (attempts >= 0),
  claim_token uuid,
  claimed_by text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz DEFAULT now() NOT NULL,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_ready
  ON public.message_deliveries(server_id, status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_expired
  ON public.message_deliveries(server_id, status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_agent
  ON public.message_deliveries(agent_id, status, created_at);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_deliveries ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.clear_removed_channel_member_task_assignments()
RETURNS trigger AS $$
BEGIN
  UPDATE public.tasks task
  SET assignee_id = NULL,
      assignee_type = NULL,
      updated_at = now()
  WHERE task.channel_id = OLD.channel_id
    AND task.assignee_id = OLD.member_id
    AND task.assignee_type = OLD.member_type;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.clear_removed_channel_member_task_assignments() FROM public;
DROP TRIGGER IF EXISTS trg_clear_removed_channel_member_task_assignments ON public.channel_members;
CREATE TRIGGER trg_clear_removed_channel_member_task_assignments
AFTER DELETE ON public.channel_members
FOR EACH ROW EXECUTE FUNCTION public.clear_removed_channel_member_task_assignments();

CREATE OR REPLACE FUNCTION public.clear_removed_server_human_channel_memberships()
RETURNS trigger AS $$
BEGIN
  IF OLD.member_type = 'human' THEN
    DELETE FROM public.machine_keys machine_key
    WHERE machine_key.server_id = OLD.server_id
      AND machine_key.user_id = OLD.member_id;

    DELETE FROM public.channel_members channel_member
    USING public.channels channel
    WHERE channel_member.channel_id = channel.id
      AND channel.server_id = OLD.server_id
      AND channel_member.member_id = OLD.member_id
      AND channel_member.member_type = 'human';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.clear_removed_server_human_channel_memberships() FROM public;
DROP TRIGGER IF EXISTS trg_clear_removed_server_human_channel_memberships ON public.server_members;
CREATE TRIGGER trg_clear_removed_server_human_channel_memberships
AFTER DELETE ON public.server_members
FOR EACH ROW EXECUTE FUNCTION public.clear_removed_server_human_channel_memberships();

-- A historical release briefly allowed arbitrary channel_members inserts.
-- Repair only rows that cannot represent a real member of the channel's
-- workspace. The locks make the scan and cleanup one deterministic upgrade
-- step; the channel-member trigger above also clears polymorphic assignees.
DO $$
DECLARE
  removed_workspace_members bigint;
  removed_channel_members bigint;
BEGIN
  LOCK TABLE public.server_members IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.channel_members IN SHARE ROW EXCLUSIVE MODE;

  WITH removed AS (
    DELETE FROM public.server_members workspace_member
    WHERE NOT (
      (
        workspace_member.member_type = 'human'
        AND EXISTS (
          SELECT 1 FROM public.profiles profile
          WHERE profile.id = workspace_member.member_id
        )
      )
      OR (
        workspace_member.member_type = 'agent'
        AND workspace_member.role = 'member'
        AND EXISTS (
          SELECT 1 FROM public.agents agent
          WHERE agent.id = workspace_member.member_id
            AND agent.server_id = workspace_member.server_id
        )
      )
    )
    RETURNING 1
  )
  SELECT count(*) INTO removed_workspace_members FROM removed;

  WITH removed AS (
    DELETE FROM public.channel_members channel_member
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.channels channel
      WHERE channel.id = channel_member.channel_id
        AND (
          (
            channel_member.member_type = 'human'
            AND EXISTS (
              SELECT 1
              FROM public.profiles profile
              JOIN public.server_members workspace_member
                ON workspace_member.server_id = channel.server_id
               AND workspace_member.member_id = profile.id
               AND workspace_member.member_type = 'human'
              WHERE profile.id = channel_member.member_id
            )
          )
          OR (
            channel_member.member_type = 'agent'
            AND EXISTS (
              SELECT 1
              FROM public.agents agent
              JOIN public.server_members workspace_member
                ON workspace_member.server_id = channel.server_id
               AND workspace_member.member_id = agent.id
               AND workspace_member.member_type = 'agent'
              WHERE agent.id = channel_member.member_id
                AND agent.server_id = channel.server_id
            )
          )
        )
    )
    RETURNING 1
  )
  SELECT count(*) INTO removed_channel_members FROM removed;

  IF removed_workspace_members > 0 OR removed_channel_members > 0 THEN
    RAISE NOTICE
      'Teammate RLS repair removed % invalid workspace memberships and % invalid channel memberships',
      removed_workspace_members,
      removed_channel_members;
  END IF;
END;
$$;

-- Browser and Bridge sessions share auth.uid(), so write paths must also bind
-- the signed runtime role before choosing a human or agent identity. Define
-- these before the atomic RPCs and policies that reference them so upgrades
-- from older schemas do not depend on deferred function resolution.
CREATE OR REPLACE FUNCTION public.teammate_is_bridge_session()
RETURNS boolean AS $$
  SELECT COALESCE(
    (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
      ->> 'teammate_bridge') = 'true',
    false
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.teammate_is_human_session()
RETURNS boolean AS $$
  SELECT auth.uid() IS NOT NULL AND NOT public.teammate_is_bridge_session();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.teammate_bridge_session_matches_server(server_uuid uuid)
RETURNS boolean AS $$
  WITH claims AS (
    SELECT COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), ''),
      '{}'
    )::jsonb AS value
  )
  SELECT EXISTS (
    SELECT 1
    FROM claims
    JOIN public.machine_keys machine_key
      ON machine_key.id::text = claims.value ->> 'teammate_machine_key_id'
     AND machine_key.user_id = auth.uid()
     AND machine_key.server_id = server_uuid
    JOIN public.servers server ON server.id = server_uuid
    WHERE claims.value ->> 'teammate_bridge' = 'true'
      AND claims.value ->> 'teammate_server_id' = server_uuid::text
      AND (
        server.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1
          FROM public.server_members member
          WHERE member.server_id = server_uuid
            AND member.member_id = auth.uid()
            AND member.member_type = 'human'
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.touch_current_bridge_machine_key()
RETURNS timestamptz AS $$
DECLARE
  claims jsonb := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
  touched_at timestamptz;
BEGIN
  IF NOT public.teammate_bridge_session_matches_server(
    NULLIF(claims ->> 'teammate_server_id', '')::uuid
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Bridge machine key is not active';
  END IF;
  UPDATE public.machine_keys machine_key
  SET last_used_at = now()
  WHERE machine_key.id::text = claims ->> 'teammate_machine_key_id'
    AND machine_key.user_id = auth.uid()
    AND machine_key.server_id::text = claims ->> 'teammate_server_id'
  RETURNING machine_key.last_used_at INTO touched_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Bridge machine key is not active';
  END IF;
  RETURN touched_at;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Bridge machine key claims are invalid';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.teammate_is_bridge_session() FROM public;
REVOKE ALL ON FUNCTION public.teammate_is_human_session() FROM public;
REVOKE ALL ON FUNCTION public.teammate_bridge_session_matches_server(uuid) FROM public;
REVOKE ALL ON FUNCTION public.touch_current_bridge_machine_key() FROM public;
GRANT EXECUTE ON FUNCTION public.teammate_is_bridge_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.teammate_is_human_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.teammate_bridge_session_matches_server(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.touch_current_bridge_machine_key() TO authenticated;

-- Older installs used a non-unique index and max(seq)+1 without serialization.
-- Repair only affected channels before replacing that index with the invariant.
WITH affected_channels AS (
  SELECT channel_id
  FROM public.messages
  GROUP BY channel_id
  HAVING count(*) FILTER (WHERE seq IS NULL) > 0
     OR count(*) <> count(DISTINCT seq)
), ranked AS (
  SELECT message.id,
         row_number() OVER (
           PARTITION BY message.channel_id
           ORDER BY message.created_at ASC, message.id ASC
         ) AS next_seq
  FROM public.messages message
  WHERE message.channel_id IN (SELECT channel_id FROM affected_channels)
)
UPDATE public.messages message
SET seq = ranked.next_seq
FROM ranked
WHERE message.id = ranked.id;

DROP INDEX IF EXISTS public.idx_messages_channel_seq;
CREATE UNIQUE INDEX idx_messages_channel_seq
  ON public.messages(channel_id, seq);

CREATE OR REPLACE FUNCTION public.assign_message_seq()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.channel_id::text, 0));
  SELECT coalesce(max(seq), 0) + 1 INTO NEW.seq
  FROM public.messages WHERE channel_id = NEW.channel_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_seq ON public.messages;
CREATE TRIGGER trg_message_seq
BEFORE INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.assign_message_seq();

CREATE OR REPLACE FUNCTION public.validate_message_delivery_scope()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.message_id IS DISTINCT FROM OLD.message_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.server_id IS DISTINCT FROM OLD.server_id
    OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Message delivery identity fields are immutable';
  END IF;

  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1
    FROM public.messages message
    JOIN public.channels channel
      ON channel.id = message.channel_id
     AND channel.id = NEW.channel_id
     AND channel.server_id = NEW.server_id
    JOIN public.agents agent
      ON agent.id = NEW.agent_id
     AND agent.server_id = channel.server_id
    JOIN public.channel_members channel_member
      ON channel_member.channel_id = channel.id
     AND channel_member.member_id = agent.id
     AND channel_member.member_type = 'agent'
    JOIN public.server_members workspace_member
      ON workspace_member.server_id = channel.server_id
     AND workspace_member.member_id = agent.id
     AND workspace_member.member_type = 'agent'
    WHERE message.id = NEW.message_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Message delivery must stay inside one agent channel workspace';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.validate_message_delivery_scope() FROM public;
DROP TRIGGER IF EXISTS trg_validate_message_delivery_scope ON public.message_deliveries;
CREATE TRIGGER trg_validate_message_delivery_scope
BEFORE INSERT OR UPDATE ON public.message_deliveries
FOR EACH ROW EXECUTE FUNCTION public.validate_message_delivery_scope();

CREATE OR REPLACE FUNCTION public.enqueue_human_message_deliveries()
RETURNS trigger AS $$
BEGIN
  -- Human messages fan out to every agent member; agent messages fan out too
  -- (minus the sender) so agents can @mention each other — the runtime keeps
  -- agent-authored deliveries strictly mention-gated.
  IF NEW.sender_type NOT IN ('human', 'agent') THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.message_deliveries (
    message_id,
    agent_id,
    server_id,
    channel_id
  )
  SELECT
    NEW.id,
    agent.id,
    channel.server_id,
    NEW.channel_id
  FROM public.channel_members member
  JOIN public.agents agent
    ON agent.id = member.member_id
   AND member.member_type = 'agent'
  JOIN public.channels channel
    ON channel.id = NEW.channel_id
   AND channel.server_id = agent.server_id
  JOIN public.server_members workspace_member
    ON workspace_member.server_id = channel.server_id
   AND workspace_member.member_id = agent.id
   AND workspace_member.member_type = 'agent'
  WHERE member.channel_id = NEW.channel_id
    AND agent.id <> NEW.sender_id
  ON CONFLICT (message_id, agent_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.enqueue_human_message_deliveries() FROM public;
DROP TRIGGER IF EXISTS trg_enqueue_human_message_deliveries ON public.messages;
CREATE TRIGGER trg_enqueue_human_message_deliveries
AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.enqueue_human_message_deliveries();

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_deliveries;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.documents;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.channels;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.server_members;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.user_is_server_member(server_uuid uuid)
RETURNS boolean AS $$
  SELECT public.teammate_is_human_session() AND EXISTS (
    SELECT 1
    FROM public.server_members member
    WHERE member.server_id = server_uuid
      AND member.member_id = auth.uid()
      AND member.member_type = 'human'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_is_server_human_member(server_uuid uuid)
RETURNS boolean AS $$
  SELECT public.teammate_is_human_session() AND EXISTS (
    SELECT 1
    FROM public.server_members member
    WHERE member.server_id = server_uuid
      AND member.member_id = auth.uid()
      AND member.member_type = 'human'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- Human workspace members can discover agents without gaining SELECT access
-- to runtime credentials, prompts, sessions, or owner identity fields.
CREATE OR REPLACE FUNCTION public.list_workspace_agent_directory(server_uuid uuid)
RETURNS TABLE (
  id uuid,
  name text,
  display_name text,
  description text,
  avatar_url text,
  status text
) AS $$
BEGIN
  IF NOT public.teammate_is_human_session() OR NOT EXISTS (
    SELECT 1
    FROM public.server_members viewer_membership
    WHERE viewer_membership.server_id = server_uuid
      AND viewer_membership.member_id = auth.uid()
      AND viewer_membership.member_type = 'human'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Workspace access denied';
  END IF;

  RETURN QUERY
  SELECT
    agent.id,
    agent.name,
    agent.display_name,
    agent.description,
    agent.avatar_url,
    agent.status
  FROM public.agents agent
  JOIN public.server_members agent_membership
    ON agent_membership.server_id = agent.server_id
   AND agent_membership.member_id = agent.id
   AND agent_membership.member_type = 'agent'
  WHERE agent.server_id = server_uuid
  ORDER BY agent.created_at, agent.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- Member management only exposes the profile fields needed by the workspace UI.
-- Agent ownership is summarized as a count so owners can understand the impact
-- of a removal without receiving another person's private agent configuration.
CREATE OR REPLACE FUNCTION public.list_workspace_human_members(server_uuid uuid)
RETURNS TABLE (
  id uuid,
  display_name text,
  avatar_url text,
  role text,
  joined_at timestamptz,
  agent_count bigint,
  is_current_user boolean
) AS $$
BEGIN
  IF NOT public.teammate_is_human_session() OR NOT EXISTS (
    SELECT 1
    FROM public.server_members viewer_membership
    WHERE viewer_membership.server_id = server_uuid
      AND viewer_membership.member_id = auth.uid()
      AND viewer_membership.member_type = 'human'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Workspace access denied';
  END IF;

  RETURN QUERY
  SELECT
    profile.id,
    profile.display_name,
    profile.avatar_url,
    membership.role,
    membership.joined_at,
    count(agent.id)::bigint,
    profile.id = auth.uid()
  FROM public.server_members membership
  JOIN public.profiles profile
    ON profile.id = membership.member_id
  LEFT JOIN public.agents agent
    ON agent.server_id = membership.server_id
   AND agent.owner_id = membership.member_id
  WHERE membership.server_id = server_uuid
    AND membership.member_type = 'human'
  GROUP BY
    profile.id,
    profile.display_name,
    profile.avatar_url,
    membership.role,
    membership.joined_at
  ORDER BY
    CASE membership.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
    membership.joined_at,
    profile.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_is_channel_member(channel_uuid uuid)
RETURNS boolean AS $$
  SELECT public.teammate_is_human_session() AND EXISTS (
    SELECT 1
    FROM public.channel_members member
    JOIN public.channels channel ON channel.id = member.channel_id
    JOIN public.server_members workspace_member
      ON workspace_member.server_id = channel.server_id
     AND workspace_member.member_id = auth.uid()
     AND workspace_member.member_type = 'human'
    WHERE member.channel_id = channel_uuid
      AND member.member_id = auth.uid()
      AND member.member_type = 'human'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- Bridge sessions authenticate as an agent owner. Both the agent and owner
-- must still belong to the channel's workspace.
CREATE OR REPLACE FUNCTION public.user_has_agent_in_channel(channel_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.channel_members member
    JOIN public.agents agent
      ON agent.id = member.member_id
     AND member.member_type = 'agent'
    JOIN public.channels channel
      ON channel.id = member.channel_id
     AND channel.server_id = agent.server_id
    JOIN public.server_members agent_membership
      ON agent_membership.server_id = channel.server_id
     AND agent_membership.member_id = agent.id
     AND agent_membership.member_type = 'agent'
    JOIN public.servers workspace ON workspace.id = channel.server_id
    WHERE member.channel_id = channel_uuid
      AND agent.owner_id = auth.uid()
      AND public.teammate_bridge_session_matches_server(channel.server_id)
      AND COALESCE(
        (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
          ->> 'teammate_bridge') = 'true',
        false
      )
      AND COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        ->> 'teammate_server_id' = channel.server_id::text
      AND (
        workspace.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1
          FROM public.server_members owner_membership
          WHERE owner_membership.server_id = channel.server_id
            AND owner_membership.member_id = auth.uid()
            AND owner_membership.member_type = 'human'
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_owns_agent_in_channel(agent_uuid uuid, channel_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agents agent
    JOIN public.channel_members member
      ON member.member_id = agent.id
     AND member.member_type = 'agent'
    JOIN public.channels channel
      ON channel.id = member.channel_id
     AND channel.server_id = agent.server_id
    JOIN public.server_members agent_membership
      ON agent_membership.server_id = channel.server_id
     AND agent_membership.member_id = agent.id
     AND agent_membership.member_type = 'agent'
    JOIN public.servers workspace ON workspace.id = channel.server_id
    WHERE agent.id = agent_uuid
      AND agent.owner_id = auth.uid()
      AND member.channel_id = channel_uuid
      AND public.teammate_bridge_session_matches_server(channel.server_id)
      AND COALESCE(
        (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
          ->> 'teammate_bridge') = 'true',
        false
      )
      AND COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        ->> 'teammate_server_id' = channel.server_id::text
      AND (
        workspace.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1
          FROM public.server_members owner_membership
          WHERE owner_membership.server_id = channel.server_id
            AND owner_membership.member_id = auth.uid()
            AND owner_membership.member_type = 'human'
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_can_manage_channel(channel_uuid uuid)
RETURNS boolean AS $$
  SELECT NOT public.teammate_is_bridge_session() AND EXISTS (
    SELECT 1
    FROM public.channels channel
    JOIN public.servers workspace ON workspace.id = channel.server_id
    WHERE channel.id = channel_uuid
      AND (
        workspace.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1
          FROM public.server_members member
          WHERE member.server_id = channel.server_id
            AND member.member_id = auth.uid()
            AND member.member_type = 'human'
            AND (
              member.role IN ('owner', 'admin')
              OR channel.created_by = auth.uid()
            )
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.channel_member_is_in_server(
  channel_uuid uuid,
  candidate_uuid uuid,
  candidate_type text
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.channels channel
    WHERE channel.id = channel_uuid
      AND (
        (
          candidate_type = 'human'
          AND EXISTS (
            SELECT 1
            FROM public.server_members member
            JOIN public.profiles profile ON profile.id = member.member_id
            WHERE member.server_id = channel.server_id
              AND member.member_id = candidate_uuid
              AND member.member_type = 'human'
          )
        )
        OR (
          candidate_type = 'agent'
          AND EXISTS (
            SELECT 1
            FROM public.agents agent
            JOIN public.server_members member
              ON member.server_id = channel.server_id
             AND member.member_id = agent.id
             AND member.member_type = 'agent'
            WHERE agent.id = candidate_uuid
              AND agent.server_id = channel.server_id
          )
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_can_self_join_public_channel(
  channel_uuid uuid,
  candidate_uuid uuid,
  candidate_type text
)
RETURNS boolean AS $$
  SELECT public.teammate_is_human_session()
    AND candidate_uuid = auth.uid()
    AND candidate_type = 'human'
    AND EXISTS (
      SELECT 1
      FROM public.channels channel
      JOIN public.server_members member
        ON member.server_id = channel.server_id
       AND member.member_id = auth.uid()
       AND member.member_type = 'human'
      WHERE channel.id = channel_uuid
        AND channel.type = 'public'
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_can_self_leave_channel(
  channel_uuid uuid,
  candidate_uuid uuid,
  candidate_type text
)
RETURNS boolean AS $$
  SELECT public.teammate_is_human_session()
    AND candidate_uuid = auth.uid()
    AND candidate_type = 'human'
    AND EXISTS (
      SELECT 1
      FROM public.channels channel
      JOIN public.server_members member
        ON member.server_id = channel.server_id
       AND member.member_id = auth.uid()
       AND member.member_type = 'human'
      WHERE channel.id = channel_uuid
        AND channel.type <> 'dm'
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.channel_identity_is_unchanged(
  channel_uuid uuid,
  next_server_uuid uuid,
  next_creator_uuid uuid,
  next_type text
)
RETURNS boolean AS $$
  SELECT public.teammate_is_human_session() AND EXISTS (
    SELECT 1
    FROM public.channels channel
    WHERE channel.id = channel_uuid
      AND channel.server_id = next_server_uuid
      AND channel.created_by IS NOT DISTINCT FROM next_creator_uuid
      AND channel.type IS NOT DISTINCT FROM next_type
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.server_member_matches_server(
  server_uuid uuid,
  candidate_uuid uuid,
  candidate_type text
)
RETURNS boolean AS $$
  SELECT (
    candidate_type = 'human'
    AND EXISTS (
      SELECT 1 FROM public.profiles profile WHERE profile.id = candidate_uuid
    )
  ) OR (
    candidate_type = 'agent'
    AND EXISTS (
      SELECT 1
      FROM public.agents agent
      WHERE agent.id = candidate_uuid
        AND agent.server_id = server_uuid
    )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_can_register_owned_agent(
  server_uuid uuid,
  agent_uuid uuid
)
RETURNS boolean AS $$
  SELECT public.teammate_is_human_session() AND EXISTS (
    SELECT 1
    FROM public.agents agent
    JOIN public.servers server ON server.id = agent.server_id
    WHERE agent.id = agent_uuid
      AND agent.server_id = server_uuid
      AND agent.owner_id = auth.uid()
      AND (
        server.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1
          FROM public.server_members member
          WHERE member.server_id = server_uuid
            AND member.member_id = auth.uid()
            AND member.member_type = 'human'
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_owns_agent_in_server(
  server_uuid uuid,
  agent_uuid uuid
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agents agent
    WHERE agent.id = agent_uuid
      AND agent.server_id = server_uuid
      AND agent.owner_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.server_human_has_no_agents(
  server_uuid uuid,
  human_uuid uuid
)
RETURNS boolean AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.agents agent
    WHERE agent.server_id = server_uuid
      AND agent.owner_id = human_uuid
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_can_create_agent_in_server(
  server_uuid uuid,
  owner_uuid uuid
)
RETURNS boolean AS $$
  SELECT public.teammate_is_human_session()
    AND owner_uuid = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.servers server
      WHERE server.id = server_uuid
        AND (
          server.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1
            FROM public.server_members member
            WHERE member.server_id = server_uuid
              AND member.member_id = auth.uid()
              AND member.member_type = 'human'
          )
        )
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.agent_identity_is_unchanged(
  agent_uuid uuid,
  next_owner_uuid uuid,
  next_server_uuid uuid
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agents agent
    WHERE agent.id = agent_uuid
      AND agent.owner_id = next_owner_uuid
      AND agent.server_id = next_server_uuid
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.agent_update_is_permitted(
  agent_uuid uuid,
  next_owner_uuid uuid,
  next_server_uuid uuid,
  next_name text,
  next_status text,
  next_workspace_path text,
  next_session_id text,
  next_runtime_session_id text,
  next_runtime_session_runtime text,
  next_connection_id text,
  next_created_at timestamptz
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agents agent
    WHERE agent.id = agent_uuid
      AND agent.owner_id = next_owner_uuid
      AND agent.server_id = next_server_uuid
      AND agent.name IS NOT DISTINCT FROM next_name
      AND agent.created_at IS NOT DISTINCT FROM next_created_at
      AND (
        COALESCE(
          (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
            ->> 'teammate_bridge') = 'true',
          false
        )
        OR (
          agent.status IS NOT DISTINCT FROM next_status
          AND agent.workspace_path IS NOT DISTINCT FROM next_workspace_path
          AND agent.connection_id IS NOT DISTINCT FROM next_connection_id
          AND (
            (
              agent.session_id IS NOT DISTINCT FROM next_session_id
              AND agent.runtime_session_id IS NOT DISTINCT FROM next_runtime_session_id
              AND agent.runtime_session_runtime IS NOT DISTINCT FROM next_runtime_session_runtime
            )
            OR (
              next_session_id IS NULL
              AND next_runtime_session_id IS NULL
              AND next_runtime_session_runtime IS NULL
            )
          )
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.bridge_agent_update_is_permitted(
  agent_uuid uuid,
  next_owner_uuid uuid,
  next_server_uuid uuid,
  next_name text,
  next_display_name text,
  next_description text,
  next_system_prompt text,
  next_runtime text,
  next_model text,
  next_connection_id text,
  next_avatar_url text,
  next_created_at timestamptz
)
RETURNS boolean AS $$
  SELECT public.teammate_bridge_session_matches_server(next_server_uuid)
    AND EXISTS (
      SELECT 1
      FROM public.agents agent
      WHERE agent.id = agent_uuid
        AND agent.owner_id = next_owner_uuid
        AND agent.server_id = next_server_uuid
        AND agent.name IS NOT DISTINCT FROM next_name
        AND agent.display_name IS NOT DISTINCT FROM next_display_name
        AND agent.description IS NOT DISTINCT FROM next_description
        AND agent.system_prompt IS NOT DISTINCT FROM next_system_prompt
        AND agent.runtime IS NOT DISTINCT FROM next_runtime
        AND agent.model IS NOT DISTINCT FROM next_model
        AND agent.connection_id IS NOT DISTINCT FROM next_connection_id
        AND agent.avatar_url IS NOT DISTINCT FROM next_avatar_url
        AND agent.created_at IS NOT DISTINCT FROM next_created_at
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.document_identity_is_unchanged(
  document_uuid uuid,
  next_server_uuid uuid,
  next_creator_uuid uuid,
  next_generator_uuid uuid
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.documents document
    WHERE document.id = document_uuid
      AND document.server_id = next_server_uuid
      AND document.created_by IS NOT DISTINCT FROM next_creator_uuid
      AND document.generated_by_agent_id IS NOT DISTINCT FROM next_generator_uuid
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

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

-- Atomic channel and task workflows. These SECURITY DEFINER functions are the
-- only client entry points for multi-row creation/member assignment.
create or replace function public.user_can_view_profile(profile_uuid uuid)
returns boolean as $$
  select (
    public.teammate_is_human_session()
    and (
      profile_uuid = auth.uid()
      or exists (
        select 1
        from public.server_members viewer
        join public.server_members subject
          on subject.server_id = viewer.server_id
         and subject.member_type = 'human'
        where viewer.member_id = auth.uid()
          and viewer.member_type = 'human'
          and subject.member_id = profile_uuid
      )
    )
  ) or exists (
      select 1
      from public.server_members subject
      where public.teammate_bridge_session_matches_server(subject.server_id)
        and subject.member_type = 'human'
        and subject.member_id = profile_uuid
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.lock_channel_member_for_task(
  channel_uuid uuid,
  member_uuid uuid,
  member_type text,
  require_owned_agent boolean
)
returns boolean as $$
begin
  if member_type = 'agent' then
    perform 1
    from public.channel_members channel_member
    join public.channels channel on channel.id = channel_member.channel_id
    join public.agents agent
      on agent.id = channel_member.member_id
     and agent.server_id = channel.server_id
    join public.server_members workspace_member
      on workspace_member.server_id = channel.server_id
     and workspace_member.member_id = agent.id
     and workspace_member.member_type = 'agent'
    where channel_member.channel_id = channel_uuid
      and channel_member.member_id = member_uuid
      and channel_member.member_type = 'agent'
      and (
        not require_owned_agent
        or (
          agent.owner_id = auth.uid()
          and public.teammate_bridge_session_matches_server(channel.server_id)
        )
      )
    for key share of channel_member, agent, workspace_member;
  elsif member_type = 'human' and not require_owned_agent then
    perform 1
    from public.channel_members channel_member
    join public.channels channel on channel.id = channel_member.channel_id
    join public.profiles profile on profile.id = channel_member.member_id
    join public.server_members workspace_member
      on workspace_member.server_id = channel.server_id
     and workspace_member.member_id = profile.id
     and workspace_member.member_type = 'human'
    where channel_member.channel_id = channel_uuid
      and channel_member.member_id = member_uuid
      and channel_member.member_type = 'human'
    for key share of channel_member, workspace_member;
  else
    return false;
  end if;
  return found;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function public.lock_channel_member_for_task(uuid, uuid, text, boolean) from public;

create or replace function public.list_channel_agent_mentions(channel_uuid uuid)
returns jsonb as $$
declare
  target_server_id uuid;
  mentions jsonb;
begin
  select channel.server_id into target_server_id
  from public.channels channel
  where channel.id = channel_uuid;
  if not found then
    raise exception using errcode = 'P0002', message = 'Channel not found';
  end if;
  if public.teammate_is_bridge_session() then
    if not public.teammate_bridge_session_matches_server(target_server_id)
      or not exists (
        select 1
        from public.channel_members channel_member
        join public.agents agent
          on agent.id = channel_member.member_id
         and agent.owner_id = auth.uid()
         and agent.server_id = target_server_id
        join public.server_members workspace_member
          on workspace_member.server_id = target_server_id
         and workspace_member.member_id = agent.id
         and workspace_member.member_type = 'agent'
        where channel_member.channel_id = channel_uuid
          and channel_member.member_type = 'agent'
      ) then
      raise exception using errcode = '42501', message = 'Channel access denied';
    end if;
  elsif not public.user_is_channel_member(channel_uuid) then
    raise exception using errcode = '42501', message = 'Channel access denied';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', agent.id,
        'name', agent.name,
        'display_name', agent.display_name,
        'description', agent.description,
        'avatar_url', agent.avatar_url,
        'status', agent.status,
        'is_owner', agent.owner_id = auth.uid()
      ) order by agent.name, agent.id
    ),
    '[]'::jsonb
  ) into mentions
  from public.channel_members channel_member
  join public.agents agent
    on agent.id = channel_member.member_id
   and agent.server_id = target_server_id
  join public.server_members workspace_member
    on workspace_member.server_id = target_server_id
   and workspace_member.member_id = agent.id
   and workspace_member.member_type = 'agent'
  where channel_member.channel_id = channel_uuid
    and channel_member.member_type = 'agent';
  return mentions;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function public.list_channel_agent_mentions(uuid) from public;

create or replace function public.create_channel_with_members(
  server_uuid uuid,
  channel_name text,
  channel_description text,
  channel_type text,
  selected_members jsonb
)
returns jsonb as $$
declare
  requesting_user_id uuid := auth.uid();
  normalized_members jsonb := coalesce(selected_members, '[]'::jsonb);
  requested_member_count integer;
  unique_member_count integer;
  inserted_member_count integer;
  created_channel public.channels%rowtype;
  created_members jsonb;
  requested_member record;
begin
  if requesting_user_id is null or public.teammate_is_bridge_session() then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not exists (
    select 1
    from public.server_members member
    join public.profiles profile on profile.id = member.member_id
    where member.server_id = server_uuid
      and member.member_id = requesting_user_id
      and member.member_type = 'human'
  ) then
    raise exception using errcode = '42501', message = 'Workspace access denied';
  end if;
  if coalesce(char_length(trim(channel_name)), 0) not between 1 and 100
    or char_length(coalesce(channel_description, '')) > 1000
    or channel_type not in ('public', 'private') then
    raise exception using errcode = '22023', message = 'Invalid channel configuration';
  end if;
  if jsonb_typeof(normalized_members) <> 'array' then
    raise exception using errcode = '22023', message = 'selected_members must be an array';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(normalized_members) member
    where jsonb_typeof(member.value) <> 'object'
      or not (member.value ? 'member_id' and member.value ? 'member_type')
      or (select count(*) from jsonb_object_keys(member.value)) <> 2
      or jsonb_typeof(member.value->'member_id') <> 'string'
      or jsonb_typeof(member.value->'member_type') <> 'string'
      or coalesce(member.value->>'member_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or member.value->>'member_type' not in ('human', 'agent')
  ) then
    raise exception using errcode = '22023', message = 'Invalid selected channel member';
  end if;

  select count(*), count(distinct member.value->>'member_id')
    into requested_member_count, unique_member_count
  from jsonb_array_elements(normalized_members) member;
  if requested_member_count > 100
    or requested_member_count <> unique_member_count
    or exists (
      select 1 from jsonb_array_elements(normalized_members) member
      where (member.value->>'member_id')::uuid = requesting_user_id
    ) then
    raise exception using errcode = '22023', message = 'Channel members must be unique and exclude the creator';
  end if;

  for requested_member in
    select
      (member.value->>'member_id')::uuid as member_id,
      member.value->>'member_type' as member_type
    from jsonb_array_elements(normalized_members) member
  loop
    if requested_member.member_type = 'agent' then
      perform 1
      from public.agents agent
      join public.server_members workspace_member
        on workspace_member.server_id = agent.server_id
       and workspace_member.member_id = agent.id
       and workspace_member.member_type = 'agent'
      where agent.id = requested_member.member_id
        and agent.server_id = server_uuid
      for key share of agent, workspace_member;
    else
      perform 1
      from public.profiles profile
      join public.server_members workspace_member
        on workspace_member.member_id = profile.id
       and workspace_member.member_type = 'human'
      where profile.id = requested_member.member_id
        and workspace_member.server_id = server_uuid
      for key share of workspace_member;
    end if;
    if not found then
      raise exception using
        errcode = '23514',
        message = 'Every selected member must belong to the channel workspace';
    end if;
  end loop;

  insert into public.channels (name, description, type, created_by, server_id)
  values (
    trim(channel_name),
    nullif(trim(channel_description), ''),
    channel_type,
    requesting_user_id,
    server_uuid
  ) returning * into created_channel;

  insert into public.channel_members (channel_id, member_id, member_type)
  values (created_channel.id, requesting_user_id, 'human');

  with requested as (
    select
      (member.value->>'member_id')::uuid as member_id,
      member.value->>'member_type' as member_type
    from jsonb_array_elements(normalized_members) member
  ), valid as (
    select requested.*
    from requested
    where (
      requested.member_type = 'human'
      and exists (
        select 1
        from public.server_members workspace_member
        join public.profiles profile on profile.id = workspace_member.member_id
        where workspace_member.server_id = server_uuid
          and workspace_member.member_id = requested.member_id
          and workspace_member.member_type = 'human'
      )
    ) or (
      requested.member_type = 'agent'
      and exists (
        select 1
        from public.agents agent
        join public.server_members workspace_member
          on workspace_member.server_id = agent.server_id
         and workspace_member.member_id = agent.id
         and workspace_member.member_type = 'agent'
        where agent.id = requested.member_id
          and agent.server_id = server_uuid
      )
    )
  )
  insert into public.channel_members (channel_id, member_id, member_type)
  select created_channel.id, valid.member_id, valid.member_type from valid;
  get diagnostics inserted_member_count = row_count;

  if inserted_member_count <> requested_member_count then
    raise exception using
      errcode = '23514',
      message = 'Every selected member must belong to the channel workspace';
  end if;

  select coalesce(jsonb_agg(to_jsonb(member) order by member.joined_at, member.member_id), '[]'::jsonb)
    into created_members
  from public.channel_members member
  where member.channel_id = created_channel.id;

  return jsonb_build_object(
    'channel', to_jsonb(created_channel),
    'members', created_members
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop function if exists public.set_channel_agent_members(uuid, uuid[], text, text);
drop function if exists public.set_channel_agent_members(uuid, uuid[], text, text, uuid[]);
create or replace function public.set_channel_agent_members(
  channel_uuid uuid,
  agent_ids uuid[],
  channel_name text,
  channel_description text,
  expected_agent_ids uuid[],
  expected_channel_name text,
  expected_channel_description text
)
returns jsonb as $$
declare
  normalized_agent_ids uuid[] := coalesce(agent_ids, '{}'::uuid[]);
  requested_agent_count integer;
  unique_agent_count integer;
  expected_agent_count integer;
  unique_expected_agent_count integer;
  current_agent_count integer;
  locked_agent_count integer;
  target_channel public.channels%rowtype;
  saved_agent_ids jsonb;
begin
  if auth.uid() is null or public.teammate_is_bridge_session() then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not public.user_can_manage_channel(channel_uuid) then
    raise exception using errcode = '42501', message = 'Channel management access denied';
  end if;

  select channel.* into target_channel
  from public.channels channel
  where channel.id = channel_uuid
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Channel not found';
  end if;
  if target_channel.type not in ('public', 'private') then
    raise exception using errcode = '22023', message = 'Direct-message membership is managed with its agent';
  end if;
  if target_channel.name is distinct from expected_channel_name
    or target_channel.description is distinct from expected_channel_description then
    raise exception using errcode = '40001', message = 'Channel details changed; refresh and retry';
  end if;
  if coalesce(char_length(trim(channel_name)), 0) not between 1 and 100
    or char_length(coalesce(channel_description, '')) > 1000 then
    raise exception using errcode = '22023', message = 'Invalid channel configuration';
  end if;

  select count(*), count(distinct requested.agent_id)
    into requested_agent_count, unique_agent_count
  from unnest(normalized_agent_ids) requested(agent_id);
  if requested_agent_count > 100
    or requested_agent_count <> unique_agent_count
    or exists (select 1 from unnest(normalized_agent_ids) requested(agent_id) where requested.agent_id is null) then
    raise exception using errcode = '22023', message = 'Agent ids must be unique non-null values';
  end if;

  select count(*), count(distinct requested.agent_id)
    into expected_agent_count, unique_expected_agent_count
  from unnest(coalesce(expected_agent_ids, '{}'::uuid[])) requested(agent_id);
  if expected_agent_ids is null
    or expected_agent_count > 100
    or expected_agent_count <> unique_expected_agent_count
    or exists (
      select 1 from unnest(expected_agent_ids) requested(agent_id)
      where requested.agent_id is null
    ) then
    raise exception using errcode = '22023', message = 'Expected agent ids must be unique non-null values';
  end if;

  select count(*) into current_agent_count
  from public.channel_members member
  where member.channel_id = target_channel.id
    and member.member_type = 'agent';
  if current_agent_count <> expected_agent_count
    or exists (
      select 1
      from public.channel_members member
      where member.channel_id = target_channel.id
        and member.member_type = 'agent'
        and not (member.member_id = any(expected_agent_ids))
    ) then
    raise exception using errcode = '40001', message = 'Channel membership changed; refresh and retry';
  end if;

  perform 1
  from public.agents agent
  join public.server_members workspace_member
    on workspace_member.server_id = agent.server_id
   and workspace_member.member_id = agent.id
   and workspace_member.member_type = 'agent'
  where agent.id = any(normalized_agent_ids)
    and agent.server_id = target_channel.server_id
  for key share of agent, workspace_member;
  get diagnostics locked_agent_count = row_count;
  if locked_agent_count <> requested_agent_count then
    raise exception using
      errcode = '23514',
      message = 'Every selected agent must belong to the channel workspace';
  end if;

  update public.channels channel
  set name = trim(channel_name),
      description = nullif(trim(channel_description), '')
  where channel.id = target_channel.id
  returning * into target_channel;

  update public.tasks task
  set assignee_id = null,
      assignee_type = null,
      updated_at = now()
  where task.channel_id = target_channel.id
    and task.assignee_type = 'agent'
    and not (task.assignee_id = any(normalized_agent_ids));

  delete from public.channel_members member
  where member.channel_id = target_channel.id
    and member.member_type = 'agent'
    and not (member.member_id = any(normalized_agent_ids));

  insert into public.channel_members (channel_id, member_id, member_type)
  select target_channel.id, requested.agent_id, 'agent'
  from unnest(normalized_agent_ids) requested(agent_id)
  join public.agents agent
    on agent.id = requested.agent_id
   and agent.server_id = target_channel.server_id
  join public.server_members workspace_member
    on workspace_member.server_id = target_channel.server_id
   and workspace_member.member_id = agent.id
   and workspace_member.member_type = 'agent'
  where not exists (
    select 1
    from public.channel_members existing_member
    where existing_member.channel_id = target_channel.id
      and existing_member.member_id = requested.agent_id
      and existing_member.member_type = 'agent'
  );

  select coalesce(jsonb_agg(member.member_id order by member.member_id), '[]'::jsonb)
    into saved_agent_ids
  from public.channel_members member
  where member.channel_id = target_channel.id
    and member.member_type = 'agent';

  return jsonb_build_object(
    'channel', to_jsonb(target_channel),
    'agent_ids', saved_agent_ids
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop function if exists public.create_task_with_message(uuid, text, uuid, uuid, text, text);
create or replace function public.create_task_with_message(
  channel_uuid uuid,
  task_title text,
  parent_task_uuid uuid,
  assignee_uuid uuid,
  assignee_type text,
  assignee_mention_name text,
  sender_agent_uuid uuid
)
returns jsonb as $$
declare
  requesting_user_id uuid := auth.uid();
  normalized_title text := trim(task_title);
  canonical_sender_id uuid;
  canonical_sender_type text;
  created_message public.messages%rowtype;
  created_task public.tasks%rowtype;
  notification_message public.messages%rowtype;
  notification_content text;
  mention_match_count integer;
  mention_matches_assignee boolean;
begin
  if requesting_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if sender_agent_uuid is null then
    if public.teammate_is_bridge_session()
      or not exists (select 1 from public.profiles profile where profile.id = requesting_user_id)
      or not public.user_is_channel_member(channel_uuid) then
      raise exception using errcode = '42501', message = 'Channel access denied';
    end if;
    canonical_sender_id := requesting_user_id;
    canonical_sender_type := 'system';
  else
    if not public.user_owns_agent_in_channel(sender_agent_uuid, channel_uuid) then
      raise exception using errcode = '42501', message = 'Agent channel access denied';
    end if;
    if not public.lock_channel_member_for_task(
      channel_uuid,
      sender_agent_uuid,
      'agent',
      true
    ) then
      raise exception using errcode = '42501', message = 'Agent channel access denied';
    end if;
    canonical_sender_id := sender_agent_uuid;
    canonical_sender_type := 'agent';
  end if;
  perform 1 from public.channels channel where channel.id = channel_uuid for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Channel not found';
  end if;
  if coalesce(char_length(normalized_title), 0) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Invalid task title';
  end if;
  if (assignee_uuid is null) <> (assignee_type is null)
    or (assignee_type is not null and assignee_type not in ('human', 'agent')) then
    raise exception using errcode = '22023', message = 'Invalid task assignee';
  end if;
  if assignee_type = 'agent' and coalesce(char_length(trim(assignee_mention_name)), 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Agent assignment requires a mention name';
  end if;
  if assignee_type is distinct from 'agent' and nullif(trim(assignee_mention_name), '') is not null then
    raise exception using errcode = '22023', message = 'Only agent assignments can include a mention name';
  end if;
  if assignee_uuid is not null and not public.lock_channel_member_for_task(
    channel_uuid,
    assignee_uuid,
    assignee_type,
    false
  ) then
    raise exception using errcode = '23514', message = 'Task assignee must be a current channel member';
  end if;

  insert into public.messages (channel_id, sender_id, sender_type, content)
  values (channel_uuid, canonical_sender_id, canonical_sender_type, normalized_title)
  returning * into created_message;

  insert into public.tasks (
    message_id,
    channel_id,
    title,
    parent_task_id,
    assignee_id,
    assignee_type
  ) values (
    created_message.id,
    channel_uuid,
    normalized_title,
    parent_task_uuid,
    assignee_uuid,
    assignee_type
  ) returning * into created_task;

  if assignee_type = 'agent' and sender_agent_uuid is distinct from assignee_uuid then
    perform 1
    from public.agents agent
    join public.channel_members channel_member
      on channel_member.member_id = agent.id
     and channel_member.member_type = 'agent'
     and channel_member.channel_id = channel_uuid
    where channel_member.channel_id = channel_uuid
    for share of agent;

    with channel_agents as (
      select agent.id, agent.name, agent.display_name
      from public.agents agent
      join public.channel_members channel_member
        on channel_member.member_id = agent.id
       and channel_member.member_type = 'agent'
       and channel_member.channel_id = channel_uuid
      join public.channels channel
        on channel.id = channel_member.channel_id
       and channel.server_id = agent.server_id
      join public.server_members workspace_member
        on workspace_member.server_id = channel.server_id
       and workspace_member.member_id = agent.id
       and workspace_member.member_type = 'agent'
    ), stable_matches as (
      select candidate.id from channel_agents candidate
      where lower(candidate.name) = lower(trim(assignee_mention_name))
    ), resolved_matches as (
      select match.id from stable_matches match
      union all
      select candidate.id from channel_agents candidate
      where not exists (select 1 from stable_matches)
        and lower(candidate.display_name) = lower(trim(assignee_mention_name))
    )
    select
      count(*),
      coalesce(bool_or(match.id = assignee_uuid), false)
      into mention_match_count, mention_matches_assignee
    from resolved_matches match;

    if mention_match_count <> 1 or not mention_matches_assignee then
      raise exception using
        errcode = '23514',
        message = 'Agent mention name must uniquely identify the assignee in this channel';
    end if;

    notification_content := '@' || trim(assignee_mention_name)
      || ' Task #' || created_task.task_number
      || ' assigned to you: ' || normalized_title;
    if char_length(notification_content) > 100000 then
      raise exception using errcode = '22023', message = 'Task notification is too long';
    end if;

    insert into public.messages (channel_id, sender_id, sender_type, content)
    values (
      channel_uuid,
      coalesce(sender_agent_uuid, requesting_user_id),
      case when sender_agent_uuid is null then 'human' else 'agent' end,
      notification_content
    )
    returning * into notification_message;

    if sender_agent_uuid is not null then
      insert into public.message_deliveries (
        message_id,
        agent_id,
        server_id,
        channel_id
      )
      select
        notification_message.id,
        assignee_uuid,
        channel.server_id,
        channel.id
      from public.channels channel
      join public.channel_members channel_member
        on channel_member.channel_id = channel.id
       and channel_member.member_id = assignee_uuid
       and channel_member.member_type = 'agent'
      join public.agents agent
        on agent.id = channel_member.member_id
       and agent.server_id = channel.server_id
      join public.server_members workspace_member
        on workspace_member.server_id = channel.server_id
       and workspace_member.member_id = agent.id
       and workspace_member.member_type = 'agent'
      where channel.id = channel_uuid
      on conflict (message_id, agent_id) do nothing;
      if not found then
        raise exception using errcode = '23514', message = 'Task notification target is unavailable';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'message', to_jsonb(created_message),
    'task', to_jsonb(created_task),
    'notification', case
      when notification_message.id is null then null
      else to_jsonb(notification_message)
    end
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop function if exists public.assign_task_with_notification(uuid, uuid, text, text);
drop function if exists public.assign_task_with_notification(uuid, uuid, text, text, uuid);
create or replace function public.assign_task_with_notification(
  task_uuid uuid,
  assignee_uuid uuid,
  assignee_type text,
  assignee_mention_name text,
  sender_agent_uuid uuid,
  expected_updated_at timestamptz
)
returns jsonb as $$
declare
  target_task public.tasks%rowtype;
  target_channel_id uuid;
  task_title text;
  notification_message public.messages%rowtype;
  notification_content text;
  mention_match_count integer;
  mention_matches_assignee boolean;
  assignment_changed boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if expected_updated_at is null then
    raise exception using errcode = '22023', message = 'expected_updated_at is required';
  end if;
  if (assignee_uuid is null) <> (assignee_type is null)
    or (assignee_type is not null and assignee_type not in ('human', 'agent')) then
    raise exception using errcode = '22023', message = 'Invalid task assignee';
  end if;
  if assignee_type = 'agent' and coalesce(char_length(trim(assignee_mention_name)), 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Agent assignment requires a mention name';
  end if;
  if assignee_type is distinct from 'agent' and nullif(trim(assignee_mention_name), '') is not null then
    raise exception using errcode = '22023', message = 'Only agent assignments can include a mention name';
  end if;

  select task.channel_id into target_channel_id
  from public.tasks task
  where task.id = task_uuid;
  if not found then
    raise exception using errcode = 'P0002', message = 'Task not found';
  end if;
  if sender_agent_uuid is not null and not public.lock_channel_member_for_task(
    target_channel_id,
    sender_agent_uuid,
    'agent',
    true
  ) then
    raise exception using errcode = 'P0002', message = 'Task not found';
  end if;
  if assignee_uuid is not null and not public.lock_channel_member_for_task(
    target_channel_id,
    assignee_uuid,
    assignee_type,
    false
  ) then
    raise exception using errcode = '23514', message = 'Task assignee must be a current channel member';
  end if;

  select task.* into target_task
  from public.tasks task
  join public.channels channel on channel.id = task.channel_id
  where task.id = task_uuid
    and (
      (
        sender_agent_uuid is null
        and not public.teammate_is_bridge_session()
        and exists (select 1 from public.profiles profile where profile.id = auth.uid())
        and public.user_is_channel_member(task.channel_id)
      )
      or (
        sender_agent_uuid is not null
        and public.user_owns_agent_in_channel(sender_agent_uuid, task.channel_id)
      )
    )
  for update of task, channel;
  if not found then
    raise exception using errcode = 'P0002', message = 'Task not found';
  end if;
  if target_task.updated_at is distinct from expected_updated_at then
    raise exception using errcode = '40001', message = 'Task changed; refresh and retry';
  end if;
  if target_task.archived_at is not null then
    raise exception using errcode = '23514', message = 'Archived tasks cannot be reassigned';
  end if;

  assignment_changed := target_task.assignee_id is distinct from assignee_uuid
    or target_task.assignee_type is distinct from assignee_type;
  if not assignment_changed then
    return jsonb_build_object('task', to_jsonb(target_task), 'notification', null);
  end if;

  update public.tasks task
  set assignee_id = assign_task_with_notification.assignee_uuid,
      assignee_type = assign_task_with_notification.assignee_type,
      updated_at = now()
  where task.id = target_task.id
  returning * into target_task;

  if assignee_type = 'agent' and sender_agent_uuid is distinct from assignee_uuid then
    perform 1
    from public.agents agent
    join public.channel_members channel_member
      on channel_member.member_id = agent.id
     and channel_member.member_type = 'agent'
     and channel_member.channel_id = target_task.channel_id
    where channel_member.channel_id = target_task.channel_id
    for share of agent;

    with channel_agents as (
      select agent.id, agent.name, agent.display_name
      from public.agents agent
      join public.channel_members channel_member
        on channel_member.member_id = agent.id
       and channel_member.member_type = 'agent'
       and channel_member.channel_id = target_task.channel_id
      join public.channels channel
        on channel.id = channel_member.channel_id
       and channel.server_id = agent.server_id
      join public.server_members workspace_member
        on workspace_member.server_id = channel.server_id
       and workspace_member.member_id = agent.id
       and workspace_member.member_type = 'agent'
    ), stable_matches as (
      select candidate.id from channel_agents candidate
      where lower(candidate.name) = lower(trim(assignee_mention_name))
    ), resolved_matches as (
      select match.id from stable_matches match
      union all
      select candidate.id from channel_agents candidate
      where not exists (select 1 from stable_matches)
        and lower(candidate.display_name) = lower(trim(assignee_mention_name))
    )
    select
      count(*),
      coalesce(bool_or(match.id = assignee_uuid), false)
      into mention_match_count, mention_matches_assignee
    from resolved_matches match;

    if mention_match_count <> 1 or not mention_matches_assignee then
      raise exception using
        errcode = '23514',
        message = 'Agent mention name must uniquely identify the assignee in this channel';
    end if;

    task_title := target_task.title;

    notification_content := '@' || trim(assignee_mention_name)
      || ' Task #' || target_task.task_number
      || ' assigned to you: ' || task_title;
    if char_length(notification_content) > 100000 then
      raise exception using errcode = '22023', message = 'Task notification is too long';
    end if;

    insert into public.messages (channel_id, sender_id, sender_type, content)
    values (
      target_task.channel_id,
      coalesce(sender_agent_uuid, auth.uid()),
      case when sender_agent_uuid is null then 'human' else 'agent' end,
      notification_content
    )
    returning * into notification_message;

    if sender_agent_uuid is not null then
      insert into public.message_deliveries (
        message_id,
        agent_id,
        server_id,
        channel_id
      )
      select
        notification_message.id,
        assignee_uuid,
        channel.server_id,
        channel.id
      from public.channels channel
      join public.channel_members channel_member
        on channel_member.channel_id = channel.id
       and channel_member.member_id = assignee_uuid
       and channel_member.member_type = 'agent'
      join public.agents agent
        on agent.id = channel_member.member_id
       and agent.server_id = channel.server_id
      join public.server_members workspace_member
        on workspace_member.server_id = channel.server_id
       and workspace_member.member_id = agent.id
       and workspace_member.member_type = 'agent'
      where channel.id = target_task.channel_id
      on conflict (message_id, agent_id) do nothing;
      if not found then
        raise exception using errcode = '23514', message = 'Task notification target is unavailable';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'task', to_jsonb(target_task),
    'notification', case
      when notification_message.id is null then null
      else to_jsonb(notification_message)
    end
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;


-- Agent teardown spans polymorphic membership rows that cannot be expressed
-- with foreign keys. Keep the whole operation in one database transaction.
CREATE OR REPLACE FUNCTION public.update_task_status(
  task_uuid uuid,
  task_status text,
  sender_agent_uuid uuid,
  expected_updated_at timestamptz
)
RETURNS jsonb AS $$
DECLARE
  target_task public.tasks%rowtype;
  target_channel_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Authentication required';
  END IF;
  IF task_status NOT IN ('todo', 'in_progress', 'in_review', 'done')
    OR expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid task status update';
  END IF;
  SELECT task.channel_id INTO target_channel_id
  FROM public.tasks task
  WHERE task.id = task_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  IF sender_agent_uuid IS NOT NULL AND NOT public.lock_channel_member_for_task(
    target_channel_id,
    sender_agent_uuid,
    'agent',
    true
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  SELECT task.* INTO target_task
  FROM public.tasks task
  JOIN public.channels channel ON channel.id = task.channel_id
  WHERE task.id = task_uuid
    AND (
      (
        sender_agent_uuid IS NULL
        AND NOT public.teammate_is_bridge_session()
        AND EXISTS (SELECT 1 FROM public.profiles profile WHERE profile.id = auth.uid())
        AND public.user_is_channel_member(task.channel_id)
      )
      OR (
        sender_agent_uuid IS NOT NULL
        AND public.user_owns_agent_in_channel(sender_agent_uuid, task.channel_id)
      )
    )
  FOR UPDATE OF task, channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  IF target_task.updated_at IS DISTINCT FROM expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Task changed; refresh and retry';
  END IF;
  IF target_task.archived_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Archived tasks cannot change status';
  END IF;
  UPDATE public.tasks task
  SET status = task_status,
      updated_at = now()
  WHERE task.id = target_task.id
  RETURNING * INTO target_task;
  RETURN jsonb_build_object('task', to_jsonb(target_task));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.claim_task(
  task_uuid uuid,
  sender_agent_uuid uuid,
  expected_updated_at timestamptz
)
RETURNS jsonb AS $$
DECLARE
  target_task public.tasks%rowtype;
  target_channel_id uuid;
BEGIN
  IF auth.uid() IS NULL OR sender_agent_uuid IS NULL OR expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Agent authentication required';
  END IF;
  SELECT task.channel_id INTO target_channel_id
  FROM public.tasks task
  WHERE task.id = task_uuid;
  IF NOT FOUND OR NOT public.lock_channel_member_for_task(
    target_channel_id,
    sender_agent_uuid,
    'agent',
    true
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  SELECT task.* INTO target_task
  FROM public.tasks task
  JOIN public.channels channel ON channel.id = task.channel_id
  WHERE task.id = task_uuid
    AND public.user_owns_agent_in_channel(sender_agent_uuid, task.channel_id)
  FOR UPDATE OF task, channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  IF target_task.updated_at IS DISTINCT FROM expected_updated_at
    OR target_task.archived_at IS NOT NULL
    OR target_task.status = 'done'
    OR (
      target_task.assignee_id IS NOT NULL
      AND (
        target_task.assignee_id IS DISTINCT FROM sender_agent_uuid
        OR target_task.assignee_type IS DISTINCT FROM 'agent'
      )
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Task changed or was claimed; refresh and retry';
  END IF;
  UPDATE public.tasks task
  SET assignee_id = sender_agent_uuid,
      assignee_type = 'agent',
      status = 'in_progress',
      updated_at = now()
  WHERE task.id = target_task.id
  RETURNING * INTO target_task;
  RETURN jsonb_build_object('task', to_jsonb(target_task));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.unclaim_task(
  task_uuid uuid,
  sender_agent_uuid uuid,
  expected_updated_at timestamptz
)
RETURNS jsonb AS $$
DECLARE
  target_task public.tasks%rowtype;
  target_channel_id uuid;
BEGIN
  IF auth.uid() IS NULL OR sender_agent_uuid IS NULL OR expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Agent authentication required';
  END IF;
  SELECT task.channel_id INTO target_channel_id
  FROM public.tasks task
  WHERE task.id = task_uuid;
  IF NOT FOUND OR NOT public.lock_channel_member_for_task(
    target_channel_id,
    sender_agent_uuid,
    'agent',
    true
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  SELECT task.* INTO target_task
  FROM public.tasks task
  JOIN public.channels channel ON channel.id = task.channel_id
  WHERE task.id = task_uuid
    AND public.user_owns_agent_in_channel(sender_agent_uuid, task.channel_id)
  FOR UPDATE OF task, channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  IF target_task.updated_at IS DISTINCT FROM expected_updated_at
    OR target_task.archived_at IS NOT NULL
    OR target_task.assignee_id IS DISTINCT FROM sender_agent_uuid
    OR target_task.assignee_type IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Task assignment changed; refresh and retry';
  END IF;
  UPDATE public.tasks task
  SET assignee_id = NULL,
      assignee_type = NULL,
      updated_at = now()
  WHERE task.id = target_task.id
  RETURNING * INTO target_task;
  RETURN jsonb_build_object('task', to_jsonb(target_task));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.delete_owned_agent(agent_uuid uuid)
RETURNS boolean AS $$
DECLARE
  requesting_user_id uuid := auth.uid();
  target_server_id uuid;
  deleted_agents integer;
BEGIN
  IF requesting_user_id IS NULL OR public.teammate_is_bridge_session() THEN
    RETURN false;
  END IF;

  SELECT agent.server_id
    INTO target_server_id
  FROM public.agents agent
  JOIN public.servers server ON server.id = agent.server_id
  WHERE agent.id = agent_uuid
    AND agent.owner_id = requesting_user_id
    AND (
      server.owner_id = requesting_user_id
      OR EXISTS (
        SELECT 1
        FROM public.server_members member
        WHERE member.server_id = agent.server_id
          AND member.member_id = requesting_user_id
          AND member.member_type = 'human'
      )
    )
  FOR UPDATE OF agent;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  LOCK TABLE public.channel_members IN SHARE ROW EXCLUSIVE MODE;

  DELETE FROM public.channels channel
  USING public.channel_members member
  WHERE channel.id = member.channel_id
    AND channel.server_id = target_server_id
    AND channel.type = 'dm'
    AND member.member_id = agent_uuid
    AND member.member_type = 'agent';

  DELETE FROM public.channel_members member
  WHERE member.member_id = agent_uuid
    AND member.member_type = 'agent';

  DELETE FROM public.server_members member
  WHERE member.server_id = target_server_id
    AND member.member_id = agent_uuid
    AND member.member_type = 'agent';

  UPDATE public.tasks task
  SET assignee_id = NULL,
      assignee_type = NULL,
      updated_at = now()
  FROM public.channels channel
  WHERE task.channel_id = channel.id
    AND channel.server_id = target_server_id
    AND task.assignee_id = agent_uuid
    AND task.assignee_type = 'agent';

  DELETE FROM public.agents agent
  WHERE agent.id = agent_uuid
    AND agent.owner_id = requesting_user_id
    AND agent.server_id = target_server_id;
  GET DIAGNOSTICS deleted_agents = ROW_COUNT;

  IF deleted_agents <> 1 THEN
    RAISE EXCEPTION 'Agent teardown lost its locked target';
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Workspace owners need one authoritative teardown path for people who still
-- own agents or runtime keys. Direct server_members deletes cannot safely
-- express these polymorphic relationships, so the whole eviction is kept in a
-- SECURITY DEFINER transaction and scoped to exactly one workspace.
CREATE OR REPLACE FUNCTION public.remove_server_human_member(
  server_uuid uuid,
  human_uuid uuid
)
RETURNS jsonb AS $$
DECLARE
  requesting_user_id uuid := auth.uid();
  workspace_owner_id uuid;
  target_agent_ids uuid[] := '{}'::uuid[];
  target_dm_ids uuid[] := '{}'::uuid[];
  removed_human_membership integer := 0;
  removed_agents integer := 0;
  revoked_machine_keys integer := 0;
  removed_dm_channels integer := 0;
  cleared_task_assignments integer := 0;
  removed_deliveries integer := 0;
BEGIN
  IF requesting_user_id IS NULL OR public.teammate_is_bridge_session() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Human authentication required';
  END IF;
  IF server_uuid IS NULL OR human_uuid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace and member are required';
  END IF;

  SELECT server.owner_id
    INTO workspace_owner_id
  FROM public.servers server
  WHERE server.id = server_uuid
  FOR UPDATE;

  IF NOT FOUND OR workspace_owner_id <> requesting_user_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only the workspace owner can remove members';
  END IF;
  IF human_uuid = workspace_owner_id THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'The workspace owner cannot be removed';
  END IF;

  LOCK TABLE public.server_members IN ACCESS EXCLUSIVE MODE;

  PERFORM 1
  FROM public.server_members target_membership
  WHERE target_membership.server_id = server_uuid
    AND target_membership.member_id = human_uuid
    AND target_membership.member_type = 'human'
  FOR UPDATE;

  PERFORM 1
  FROM public.agents agent
  WHERE agent.server_id = server_uuid
    AND agent.owner_id = human_uuid
  FOR UPDATE;

  SELECT COALESCE(array_agg(agent.id ORDER BY agent.id), '{}'::uuid[])
    INTO target_agent_ids
  FROM public.agents agent
  WHERE agent.server_id = server_uuid
    AND agent.owner_id = human_uuid;

  SELECT COALESCE(array_agg(channel.id ORDER BY channel.id), '{}'::uuid[])
    INTO target_dm_ids
  FROM public.channels channel
  WHERE channel.server_id = server_uuid
    AND channel.type = 'dm'
    AND EXISTS (
      SELECT 1
      FROM public.channel_members member
      WHERE member.channel_id = channel.id
        AND (
          (member.member_id = human_uuid AND member.member_type = 'human')
          OR (
            member.member_type = 'agent'
            AND member.member_id = ANY(target_agent_ids)
          )
        )
    );

  DELETE FROM public.message_deliveries delivery
  WHERE delivery.server_id = server_uuid
    AND delivery.agent_id = ANY(target_agent_ids);
  GET DIAGNOSTICS removed_deliveries = ROW_COUNT;

  DELETE FROM public.channels channel
  WHERE channel.server_id = server_uuid
    AND channel.id = ANY(target_dm_ids);
  GET DIAGNOSTICS removed_dm_channels = ROW_COUNT;

  UPDATE public.tasks task
  SET assignee_id = NULL,
      assignee_type = NULL,
      updated_at = now()
  FROM public.channels channel
  WHERE task.channel_id = channel.id
    AND channel.server_id = server_uuid
    AND (
      (task.assignee_id = human_uuid AND task.assignee_type = 'human')
      OR (
        task.assignee_type = 'agent'
        AND task.assignee_id = ANY(target_agent_ids)
      )
    );
  GET DIAGNOSTICS cleared_task_assignments = ROW_COUNT;

  DELETE FROM public.channel_members member
  USING public.channels channel
  WHERE member.channel_id = channel.id
    AND channel.server_id = server_uuid
    AND (
      (member.member_id = human_uuid AND member.member_type = 'human')
      OR (
        member.member_type = 'agent'
        AND member.member_id = ANY(target_agent_ids)
      )
    );

  DELETE FROM public.server_members member
  WHERE member.server_id = server_uuid
    AND member.member_type = 'agent'
    AND member.member_id = ANY(target_agent_ids);

  UPDATE public.documents document
  SET generated_by_agent_id = NULL,
      updated_at = now()
  WHERE document.server_id = server_uuid
    AND document.generated_by_agent_id = ANY(target_agent_ids);

  DELETE FROM public.machine_keys machine_key
  WHERE machine_key.server_id = server_uuid
    AND machine_key.user_id = human_uuid;
  GET DIAGNOSTICS revoked_machine_keys = ROW_COUNT;

  DELETE FROM public.agents agent
  WHERE agent.server_id = server_uuid
    AND agent.owner_id = human_uuid;
  GET DIAGNOSTICS removed_agents = ROW_COUNT;

  DELETE FROM public.server_members member
  WHERE member.server_id = server_uuid
    AND member.member_id = human_uuid
    AND member.member_type = 'human';
  GET DIAGNOSTICS removed_human_membership = ROW_COUNT;

  RETURN jsonb_build_object(
    'removed', removed_human_membership = 1,
    'agents_removed', removed_agents,
    'machine_keys_revoked', revoked_machine_keys,
    'dm_channels_removed', removed_dm_channels,
    'task_assignments_cleared', cleared_task_assignments,
    'deliveries_removed', removed_deliveries
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.create_owned_server(
  server_name text,
  server_slug text,
  server_description text,
  machine_key_prefix text,
  machine_key_hash text,
  machine_key_value text,
  machine_key_name text
)
RETURNS jsonb AS $$
DECLARE
  requesting_user_id uuid := auth.uid();
  created_server public.servers%ROWTYPE;
  created_key_id uuid;
BEGIN
  IF requesting_user_id IS NULL OR public.teammate_is_bridge_session() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Authentication required';
  END IF;
  IF COALESCE(char_length(trim(server_name)), 0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid workspace name';
  END IF;
  IF COALESCE(server_slug, '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    OR char_length(server_slug) > 80 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid workspace slug';
  END IF;
  IF char_length(COALESCE(server_description, '')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace description is too long';
  END IF;
  IF COALESCE(machine_key_prefix, '') !~ '^tm_[0-9a-f]{8}$'
    OR COALESCE(machine_key_hash, '') !~ '^[0-9a-f]{64}$'
    OR COALESCE(machine_key_value, '') !~ '^tm_[0-9a-f]{64}$'
    OR COALESCE(char_length(trim(machine_key_name)), 0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid runtime key';
  END IF;

  INSERT INTO public.servers (name, slug, description, owner_id)
  VALUES (trim(server_name), server_slug, nullif(trim(server_description), ''), requesting_user_id)
  RETURNING * INTO created_server;

  INSERT INTO public.server_members (server_id, member_id, member_type, role)
  VALUES (created_server.id, requesting_user_id, 'human', 'owner');

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
    created_server.id,
    trim(machine_key_name)
  ) RETURNING id INTO created_key_id;

  RETURN jsonb_build_object(
    'server', to_jsonb(created_server),
    'machine_key_id', created_key_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Runtime keys are a workspace-membership capability. Provisioning takes the
-- same server -> human membership locks as member eviction, so either the key
-- commits before teardown and is revoked there, or provisioning observes that
-- the membership is gone and fails without creating a usable key.
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

CREATE OR REPLACE FUNCTION public.create_owned_agent_with_dm(
  server_uuid uuid,
  agent_name text,
  agent_display_name text,
  agent_description text,
  agent_system_prompt text,
  agent_runtime text,
  agent_model text
)
RETURNS jsonb AS $$
DECLARE
  requesting_user_id uuid := auth.uid();
  workspace_owner_id uuid;
  created_agent public.agents%ROWTYPE;
  created_channel public.channels%ROWTYPE;
BEGIN
  IF requesting_user_id IS NULL OR public.teammate_is_bridge_session() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Authentication required';
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
  IF COALESCE(agent_name, '') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    OR char_length(agent_name) > 100
    OR COALESCE(char_length(trim(agent_display_name)), 0) NOT BETWEEN 1 AND 100
    OR char_length(COALESCE(agent_description, '')) > 2000
    OR char_length(COALESCE(agent_system_prompt, '')) > 50000
    OR agent_runtime NOT IN ('claude-code', 'codex', 'pi')
    OR COALESCE(char_length(trim(agent_model)), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid agent configuration';
  END IF;

  INSERT INTO public.agents (
    name,
    display_name,
    description,
    system_prompt,
    runtime,
    model,
    status,
    owner_id,
    server_id
  ) VALUES (
    trim(agent_name),
    trim(agent_display_name),
    nullif(trim(agent_description), ''),
    nullif(trim(agent_system_prompt), ''),
    agent_runtime,
    trim(agent_model),
    'offline',
    requesting_user_id,
    server_uuid
  ) RETURNING * INTO created_agent;

  INSERT INTO public.server_members (server_id, member_id, member_type, role)
  VALUES (server_uuid, created_agent.id, 'agent', 'member');

  INSERT INTO public.channels (name, description, type, created_by, server_id)
  VALUES (
    trim(agent_display_name),
    'Direct chat with ' || trim(agent_display_name),
    'dm',
    requesting_user_id,
    server_uuid
  ) RETURNING * INTO created_channel;

  INSERT INTO public.channel_members (channel_id, member_id, member_type)
  VALUES
    (created_channel.id, requesting_user_id, 'human'),
    (created_channel.id, created_agent.id, 'agent');

  RETURN jsonb_build_object(
    'agent', to_jsonb(created_agent),
    'channel', to_jsonb(created_channel)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.reset_owned_agent(agent_uuid uuid)
RETURNS integer AS $$
DECLARE
  requesting_user_id uuid := auth.uid();
  target_server_id uuid;
  deleted_messages integer;
BEGIN
  IF requesting_user_id IS NULL OR public.teammate_is_bridge_session() THEN
    RETURN -1;
  END IF;

  SELECT agent.server_id
    INTO target_server_id
  FROM public.agents agent
  JOIN public.servers server ON server.id = agent.server_id
  WHERE agent.id = agent_uuid
    AND agent.owner_id = requesting_user_id
    AND (
      server.owner_id = requesting_user_id
      OR EXISTS (
        SELECT 1
        FROM public.server_members member
        WHERE member.server_id = agent.server_id
          AND member.member_id = requesting_user_id
          AND member.member_type = 'human'
      )
    )
  FOR UPDATE OF agent;

  IF NOT FOUND THEN
    RETURN -1;
  END IF;

  LOCK TABLE public.channel_members IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.messages IN SHARE ROW EXCLUSIVE MODE;

  DELETE FROM public.messages message
  USING public.channels channel, public.channel_members member
  WHERE message.channel_id = channel.id
    AND member.channel_id = channel.id
    AND channel.server_id = target_server_id
    AND channel.type = 'dm'
    AND member.member_id = agent_uuid
    AND member.member_type = 'agent';
  GET DIAGNOSTICS deleted_messages = ROW_COUNT;

  UPDATE public.agents agent
  SET session_id = NULL,
      runtime_session_id = NULL,
      runtime_session_runtime = NULL
  WHERE agent.id = agent_uuid
    AND agent.owner_id = requesting_user_id
    AND agent.server_id = target_server_id;

  RETURN deleted_messages;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.validate_message_scope()
RETURNS trigger AS $$
BEGIN
  IF tg_op = 'UPDATE' AND (
    new.channel_id IS DISTINCT FROM old.channel_id
    OR new.sender_id IS DISTINCT FROM old.sender_id
    OR new.sender_type IS DISTINCT FROM old.sender_type
    OR new.seq IS DISTINCT FROM old.seq
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Message identity fields are immutable';
  END IF;

  IF new.thread_parent_id IS NOT NULL AND (
    new.thread_parent_id = new.id
    OR NOT EXISTS (
      SELECT 1
      FROM public.messages parent
      WHERE parent.id = new.thread_parent_id
        AND parent.channel_id = new.channel_id
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Thread parent must belong to the same channel';
  END IF;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.validate_message_scope() FROM public;
DROP TRIGGER IF EXISTS trg_validate_message_scope ON public.messages;
CREATE TRIGGER trg_validate_message_scope
BEFORE INSERT OR UPDATE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.validate_message_scope();

CREATE OR REPLACE FUNCTION public.validate_task_scope()
RETURNS trigger AS $$
DECLARE
  validate_parent boolean := tg_op = 'INSERT';
  validate_assignee boolean := tg_op = 'INSERT';
BEGIN
  IF tg_op = 'UPDATE' THEN
    IF new.channel_id IS DISTINCT FROM old.channel_id
      OR new.message_id IS DISTINCT FROM old.message_id
      OR new.task_number IS DISTINCT FROM old.task_number THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Task identity fields are immutable';
    END IF;
    validate_parent := new.parent_task_id IS DISTINCT FROM old.parent_task_id;
    validate_assignee := new.assignee_id IS DISTINCT FROM old.assignee_id
      OR new.assignee_type IS DISTINCT FROM old.assignee_type;
  END IF;

  IF tg_op = 'INSERT' AND NOT EXISTS (
    SELECT 1
    FROM public.messages message
    WHERE message.id = new.message_id
      AND message.channel_id = new.channel_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Task message must belong to the same channel';
  END IF;

  IF validate_parent AND new.parent_task_id IS NOT NULL THEN
    IF new.parent_task_id = new.id OR NOT EXISTS (
      SELECT 1
      FROM public.tasks parent
      WHERE parent.id = new.parent_task_id
        AND parent.channel_id = new.channel_id
        AND (new.archived_at IS NOT NULL OR parent.archived_at IS NULL)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Parent task must belong to the same channel and an active task cannot use an archived parent';
    END IF;

    IF tg_op = 'UPDATE' AND EXISTS (
      WITH RECURSIVE lineage(id, parent_task_id) AS (
        SELECT task.id, task.parent_task_id
        FROM public.tasks task
        WHERE task.id = new.parent_task_id
        UNION
        SELECT task.id, task.parent_task_id
        FROM public.tasks task
        JOIN lineage ancestor ON task.id = ancestor.parent_task_id
      )
      SELECT 1 FROM lineage WHERE id = new.id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Task hierarchy cannot contain a cycle';
    END IF;
  END IF;

  IF validate_assignee THEN
    IF (new.assignee_id IS NULL) <> (new.assignee_type IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Task assignee id and type must be set together';
    END IF;
    IF new.assignee_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.channel_members channel_member
      JOIN public.channels channel ON channel.id = channel_member.channel_id
      WHERE channel_member.channel_id = new.channel_id
        AND channel_member.member_id = new.assignee_id
        AND channel_member.member_type = new.assignee_type
        AND (
          (
            new.assignee_type = 'human'
            AND EXISTS (
              SELECT 1
              FROM public.server_members workspace_member
              JOIN public.profiles profile ON profile.id = workspace_member.member_id
              WHERE workspace_member.server_id = channel.server_id
                AND workspace_member.member_id = new.assignee_id
                AND workspace_member.member_type = 'human'
            )
          )
          OR (
            new.assignee_type = 'agent'
            AND EXISTS (
              SELECT 1
              FROM public.agents agent
              JOIN public.server_members workspace_member
                ON workspace_member.server_id = channel.server_id
               AND workspace_member.member_id = agent.id
               AND workspace_member.member_type = 'agent'
              WHERE agent.id = new.assignee_id
                AND agent.server_id = channel.server_id
            )
          )
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Task assignee must be a valid member of the channel workspace';
    END IF;
  END IF;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.validate_task_scope() FROM public;
DROP TRIGGER IF EXISTS trg_validate_task_scope ON public.tasks;
CREATE TRIGGER trg_validate_task_scope
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.validate_task_scope();

REVOKE ALL ON FUNCTION public.user_is_server_member(uuid) FROM public;
REVOKE ALL ON FUNCTION public.user_is_server_human_member(uuid) FROM public;
REVOKE ALL ON FUNCTION public.list_workspace_agent_directory(uuid) FROM public;
REVOKE ALL ON FUNCTION public.list_workspace_human_members(uuid) FROM public;
REVOKE ALL ON FUNCTION public.user_is_channel_member(uuid) FROM public;
REVOKE ALL ON FUNCTION public.user_has_agent_in_channel(uuid) FROM public;
REVOKE ALL ON FUNCTION public.user_owns_agent_in_channel(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.user_can_manage_channel(uuid) FROM public;
REVOKE ALL ON FUNCTION public.channel_member_is_in_server(uuid, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.user_can_self_join_public_channel(uuid, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.user_can_self_leave_channel(uuid, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.channel_identity_is_unchanged(uuid, uuid, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.server_member_matches_server(uuid, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.user_can_register_owned_agent(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.user_owns_agent_in_server(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.server_human_has_no_agents(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.remove_server_human_member(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.user_can_create_agent_in_server(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.agent_identity_is_unchanged(uuid, uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.agent_update_is_permitted(uuid, uuid, uuid, text, text, text, text, text, text, text, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.bridge_agent_update_is_permitted(uuid, uuid, uuid, text, text, text, text, text, text, text, text, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.document_identity_is_unchanged(uuid, uuid, uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.machine_key_identity_is_unchanged(uuid, uuid, uuid, text, text, text) FROM public;
REVOKE ALL ON FUNCTION public.user_can_view_profile(uuid) FROM public;
REVOKE ALL ON FUNCTION public.list_channel_agent_mentions(uuid) FROM public;
REVOKE ALL ON FUNCTION public.create_channel_with_members(uuid, text, text, text, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.set_channel_agent_members(uuid, uuid[], text, text, uuid[], text, text) FROM public;
REVOKE ALL ON FUNCTION public.create_task_with_message(uuid, text, uuid, uuid, text, text, uuid) FROM public;
REVOKE ALL ON FUNCTION public.assign_task_with_notification(uuid, uuid, text, text, uuid, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.update_task_status(uuid, text, uuid, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.claim_task(uuid, uuid, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.unclaim_task(uuid, uuid, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.delete_owned_agent(uuid) FROM public;
REVOKE ALL ON FUNCTION public.create_owned_server(text, text, text, text, text, text, text) FROM public;
REVOKE ALL ON FUNCTION public.create_current_user_machine_key(uuid, text, text, text) FROM public;
REVOKE ALL ON FUNCTION public.create_owned_agent_with_dm(uuid, text, text, text, text, text, text) FROM public;
REVOKE ALL ON FUNCTION public.reset_owned_agent(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.user_is_server_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_server_human_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_workspace_agent_directory(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_workspace_human_members(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_channel_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_agent_in_channel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_owns_agent_in_channel(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_manage_channel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.channel_member_is_in_server(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_self_join_public_channel(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_self_leave_channel(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.channel_identity_is_unchanged(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.server_member_matches_server(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_register_owned_agent(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_owns_agent_in_server(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.server_human_has_no_agents(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_server_human_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_create_agent_in_server(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_identity_is_unchanged(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_update_is_permitted(uuid, uuid, uuid, text, text, text, text, text, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_agent_update_is_permitted(uuid, uuid, uuid, text, text, text, text, text, text, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.document_identity_is_unchanged(uuid, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.machine_key_identity_is_unchanged(uuid, uuid, uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_view_profile(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_channel_agent_mentions(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_channel_with_members(uuid, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_channel_agent_members(uuid, uuid[], text, text, uuid[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_task_with_message(uuid, text, uuid, uuid, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_task_with_notification(uuid, uuid, text, text, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_task_status(uuid, text, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_task(uuid, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unclaim_task(uuid, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_owned_agent(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_owned_server(text, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_current_user_machine_key(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_owned_agent_with_dm(uuid, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_owned_agent(uuid) TO authenticated;

-- Close the legacy self-enrollment policy. Workspace owners may add valid
-- members; a human member may register only an agent they own in that server.
DROP POLICY IF EXISTS "Users can view their servers" ON public.servers;
CREATE POLICY "Users can view their servers"
  ON public.servers FOR SELECT
  USING (
    (public.teammate_is_human_session() AND owner_id = auth.uid())
    OR public.user_is_server_member(id)
    OR public.teammate_bridge_session_matches_server(id)
  );

DROP POLICY IF EXISTS "Owner can update server" ON public.servers;
DROP POLICY IF EXISTS "Users can create servers" ON public.servers;
CREATE POLICY "Owner can update server"
  ON public.servers FOR UPDATE
  USING (public.teammate_is_human_session() AND owner_id = auth.uid())
  WITH CHECK (public.teammate_is_human_session() AND owner_id = auth.uid());

DROP POLICY IF EXISTS "Owner can delete server" ON public.servers;
CREATE POLICY "Owner can delete server"
  ON public.servers FOR DELETE
  USING (public.teammate_is_human_session() AND owner_id = auth.uid());

DROP POLICY IF EXISTS "Members can view server members" ON public.server_members;
CREATE POLICY "Members can view server members"
  ON public.server_members FOR SELECT
  USING (public.user_is_server_member(server_id));

DROP POLICY IF EXISTS "Users can join servers" ON public.server_members;
CREATE POLICY "Users can join servers"
  ON public.server_members FOR INSERT
  WITH CHECK (
    public.teammate_is_human_session()
    AND public.server_member_matches_server(server_id, member_id, member_type)
    AND (
      auth.uid() = (SELECT owner_id FROM public.servers WHERE id = server_id)
      OR (
        member_type = 'agent'
        AND public.user_can_register_owned_agent(server_id, member_id)
      )
    )
  );

DROP POLICY IF EXISTS "Users can leave servers" ON public.server_members;
CREATE POLICY "Users can leave servers"
  ON public.server_members FOR DELETE
  USING (
    public.teammate_is_human_session()
    AND member_id = auth.uid()
    AND member_type = 'human'
    AND auth.uid() <> (SELECT owner_id FROM public.servers WHERE id = server_id)
    AND public.server_human_has_no_agents(server_id, member_id)
  );

DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
DROP POLICY IF EXISTS "Workspace members can view profiles" ON public.profiles;
CREATE POLICY "Workspace members can view profiles"
  ON public.profiles FOR SELECT
  USING (public.user_can_view_profile(id));

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (public.teammate_is_human_session() AND auth.uid() = id)
  WITH CHECK (public.teammate_is_human_session() AND auth.uid() = id);

DROP POLICY IF EXISTS "Members can view channel membership" ON public.channel_members;
DROP POLICY IF EXISTS "Users can view own channel memberships" ON public.channel_members;
DROP POLICY IF EXISTS "Users can view channel memberships" ON public.channel_members;
CREATE POLICY "Users can view channel memberships"
  ON public.channel_members FOR SELECT
  USING (
    public.user_is_channel_member(channel_id)
    OR public.user_has_agent_in_channel(channel_id)
  );

DROP POLICY IF EXISTS "Users can add channel members" ON public.channel_members;
CREATE POLICY "Users can add channel members"
  ON public.channel_members FOR INSERT
  WITH CHECK (
    public.channel_member_is_in_server(channel_id, member_id, member_type)
    AND public.user_can_self_join_public_channel(channel_id, member_id, member_type)
  );

DROP POLICY IF EXISTS "Users can remove channel members" ON public.channel_members;
CREATE POLICY "Users can remove channel members"
  ON public.channel_members FOR DELETE
  USING (public.user_can_self_leave_channel(channel_id, member_id, member_type));

DROP POLICY IF EXISTS "Authenticated users can create channels" ON public.channels;
DROP POLICY IF EXISTS "Users can create channels" ON public.channels;

DROP POLICY IF EXISTS "Channel members can view channels" ON public.channels;
DROP POLICY IF EXISTS "Users can view their channels" ON public.channels;
CREATE POLICY "Users can view their channels"
  ON public.channels FOR SELECT
  USING (
    (type = 'public' AND public.user_is_server_human_member(server_id))
    OR (created_by = auth.uid() AND public.user_is_server_human_member(server_id))
    OR public.user_is_channel_member(id)
    OR public.user_has_agent_in_channel(id)
  );

DROP POLICY IF EXISTS "Users can update channels" ON public.channels;

DROP POLICY IF EXISTS "Users can delete channels" ON public.channels;
CREATE POLICY "Users can delete channels"
  ON public.channels FOR DELETE
  USING (
    NOT public.teammate_is_bridge_session()
    AND public.user_can_manage_channel(id)
  );

DROP POLICY IF EXISTS "Channel members can view messages" ON public.messages;
DROP POLICY IF EXISTS "Users can view messages in their channels" ON public.messages;
CREATE POLICY "Users can view messages in their channels"
  ON public.messages FOR SELECT
  USING (
    public.user_is_channel_member(channel_id)
    OR public.user_has_agent_in_channel(channel_id)
  );

DROP POLICY IF EXISTS "Channel members can send messages" ON public.messages;
DROP POLICY IF EXISTS "Users can send messages in their channels" ON public.messages;
CREATE POLICY "Users can send messages in their channels"
  ON public.messages FOR INSERT
  WITH CHECK (
    (
      sender_id = auth.uid()
      AND sender_type = 'human'
      AND NOT public.teammate_is_bridge_session()
      AND public.user_is_channel_member(channel_id)
    )
    OR (
      sender_type = 'agent'
      AND public.user_owns_agent_in_channel(sender_id, channel_id)
    )
  );

DROP POLICY IF EXISTS "Agent owners can view message deliveries"
  ON public.message_deliveries;
CREATE POLICY "Agent owners can view message deliveries"
  ON public.message_deliveries FOR SELECT
  USING (
    public.teammate_bridge_session_matches_server(server_id)
    AND public.user_owns_agent_in_server(server_id, agent_id)
  );

DROP POLICY IF EXISTS "Agent owners can update message deliveries"
  ON public.message_deliveries;
CREATE POLICY "Agent owners can update message deliveries"
  ON public.message_deliveries FOR UPDATE
  USING (
    public.teammate_bridge_session_matches_server(server_id)
    AND public.user_owns_agent_in_server(server_id, agent_id)
  )
  WITH CHECK (
    public.teammate_bridge_session_matches_server(server_id)
    AND public.user_owns_agent_in_server(server_id, agent_id)
  );

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
-- Task writes stay closed; the actor-scoped lifecycle RPCs below preserve the
-- source message, hierarchy and optimistic-concurrency contract.

DROP POLICY IF EXISTS "Agents are viewable by everyone" ON public.agents;
DROP POLICY IF EXISTS "Workspace members can view agents" ON public.agents;
CREATE POLICY "Workspace members can view agents"
  ON public.agents FOR SELECT
  USING (
    owner_id = auth.uid()
    AND (
      public.teammate_is_human_session()
      OR public.teammate_bridge_session_matches_server(server_id)
    )
  );

DROP POLICY IF EXISTS "Owner can manage agents" ON public.agents;
DROP POLICY IF EXISTS "Owner can manage own agents" ON public.agents;
DROP POLICY IF EXISTS "Owners can create agents in their workspaces" ON public.agents;
DROP POLICY IF EXISTS "Owners can update own agents" ON public.agents;
DROP POLICY IF EXISTS "Owners can delete own agents" ON public.agents;
CREATE POLICY "Owners can update own agents"
  ON public.agents FOR UPDATE
  USING (
    auth.uid() = owner_id
    AND (
      public.teammate_is_human_session()
      OR public.teammate_bridge_session_matches_server(server_id)
    )
  )
  WITH CHECK (
    auth.uid() = owner_id
    AND (
      (
        public.teammate_is_human_session()
        AND public.agent_update_is_permitted(
          id,
          owner_id,
          server_id,
          name,
          status,
          workspace_path,
          session_id,
          runtime_session_id,
          runtime_session_runtime,
          connection_id,
          created_at
        )
      )
      OR public.bridge_agent_update_is_permitted(
        id,
        owner_id,
        server_id,
        name,
        display_name,
        description,
        system_prompt,
        runtime,
        model,
        connection_id,
        avatar_url,
        created_at
      )
    )
  );

DROP POLICY IF EXISTS "Server members can view documents" ON public.documents;
CREATE POLICY "Server members can view documents"
  ON public.documents FOR SELECT
  USING (
    public.user_can_create_agent_in_server(server_id, auth.uid())
    OR public.teammate_bridge_session_matches_server(server_id)
  );

DROP POLICY IF EXISTS "Server members can create documents" ON public.documents;
CREATE POLICY "Server members can create documents"
  ON public.documents FOR INSERT
  WITH CHECK (
    auth.uid() = created_by
    AND (
      public.user_can_create_agent_in_server(server_id, auth.uid())
      OR (
        public.teammate_bridge_session_matches_server(server_id)
        AND generated_by_agent_id IS NOT NULL
        AND public.user_owns_agent_in_server(server_id, generated_by_agent_id)
      )
    )
    AND (
      generated_by_agent_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.agents agent
        JOIN public.server_members member
          ON member.server_id = documents.server_id
         AND member.member_id = agent.id
         AND member.member_type = 'agent'
        WHERE agent.id = documents.generated_by_agent_id
          AND agent.server_id = documents.server_id
          AND agent.owner_id = documents.created_by
      )
    )
  );

DROP POLICY IF EXISTS "Server members can update documents" ON public.documents;
CREATE POLICY "Server members can update documents"
  ON public.documents FOR UPDATE
  USING (
    public.user_can_create_agent_in_server(server_id, auth.uid())
    OR public.teammate_bridge_session_matches_server(server_id)
  )
  WITH CHECK (
    (
      public.user_can_create_agent_in_server(server_id, auth.uid())
      OR public.teammate_bridge_session_matches_server(server_id)
    )
    AND public.document_identity_is_unchanged(
      id,
      server_id,
      created_by,
      generated_by_agent_id
    )
  );

DROP POLICY IF EXISTS "Server members can delete documents" ON public.documents;
CREATE POLICY "Server members can delete documents"
  ON public.documents FOR DELETE
  USING (
    public.user_can_create_agent_in_server(server_id, auth.uid())
  );

DROP POLICY IF EXISTS "Users can view own keys" ON public.machine_keys;
-- Existing runtimes authenticate with key_hash, so this removes recoverable
-- secrets without invalidating deployed keys.
UPDATE public.machine_keys SET key_value = NULL WHERE key_value IS NOT NULL;

CREATE POLICY "Users can view own keys"
  ON public.machine_keys FOR SELECT
  USING (public.teammate_is_human_session() AND auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own keys" ON public.machine_keys;
-- Key creation must use create_current_user_machine_key so membership
-- validation and insertion share one transaction and lock order.

DROP POLICY IF EXISTS "Users can update own keys" ON public.machine_keys;
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

-- Private Realtime Broadcast authorization reuses the role discriminator
-- defined before every human/Bridge RPC above.
CREATE OR REPLACE FUNCTION public.teammate_user_can_access_server(server_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.servers server
    WHERE server.id = server_uuid
      AND (
        server.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1
          FROM public.server_members member
          WHERE member.server_id = server.id
            AND member.member_id = auth.uid()
            AND member.member_type = 'human'
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.teammate_bridge_can_access_server(
  server_uuid uuid,
  owner_uuid uuid
)
RETURNS boolean AS $$
  WITH claims AS (
    SELECT COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), ''),
      '{}'
    )::jsonb AS value
  )
  SELECT EXISTS (
    SELECT 1
    FROM claims
    JOIN public.machine_keys machine_key
      ON machine_key.id::text = claims.value ->> 'teammate_machine_key_id'
     AND machine_key.user_id = owner_uuid
     AND machine_key.server_id = server_uuid
    JOIN public.servers server ON server.id = server_uuid
    WHERE auth.uid() = owner_uuid
      AND claims.value ->> 'teammate_bridge' = 'true'
      AND claims.value ->> 'teammate_server_id' = server_uuid::text
      AND (
        server.owner_id = owner_uuid
        OR EXISTS (
          SELECT 1
          FROM public.server_members member
          WHERE member.server_id = server_uuid
            AND member.member_id = owner_uuid
            AND member.member_type = 'human'
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.teammate_is_bridge_session() FROM public;
REVOKE ALL ON FUNCTION public.teammate_user_can_access_server(uuid) FROM public;
REVOKE ALL ON FUNCTION public.teammate_bridge_can_access_server(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.teammate_is_bridge_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.teammate_user_can_access_server(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.teammate_bridge_can_access_server(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS "Teammate activity subscribers" ON realtime.messages;
DROP POLICY IF EXISTS "Teammate activity publishers" ON realtime.messages;
DROP POLICY IF EXISTS "Teammate RPC request subscribers" ON realtime.messages;
DROP POLICY IF EXISTS "Teammate RPC request publishers" ON realtime.messages;
DROP POLICY IF EXISTS "Teammate RPC response subscribers" ON realtime.messages;
DROP POLICY IF EXISTS "Teammate RPC response publishers" ON realtime.messages;

CREATE POLICY "Teammate activity subscribers"
  ON realtime.messages FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND CASE
      WHEN (SELECT realtime.topic()) ~ '^agent-activity:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN NOT public.teammate_is_bridge_session()
        AND public.teammate_user_can_access_server(
          split_part((SELECT realtime.topic()), ':', 2)::uuid
        )
      ELSE false
    END
  );

CREATE POLICY "Teammate activity publishers"
  ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'broadcast'
    AND CASE
      WHEN (SELECT realtime.topic()) ~ '^agent-activity:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN public.teammate_bridge_can_access_server(
        split_part((SELECT realtime.topic()), ':', 2)::uuid,
        auth.uid()
      )
      ELSE false
    END
  );

CREATE POLICY "Teammate RPC request subscribers"
  ON realtime.messages FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND CASE
      WHEN (SELECT realtime.topic()) ~ '^bridge-rpc-request:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN public.teammate_bridge_can_access_server(
        split_part((SELECT realtime.topic()), ':', 2)::uuid,
        split_part((SELECT realtime.topic()), ':', 3)::uuid
      )
      ELSE false
    END
  );

CREATE POLICY "Teammate RPC request publishers"
  ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'broadcast'
    AND CASE
      WHEN (SELECT realtime.topic()) ~ '^bridge-rpc-request:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN NOT public.teammate_is_bridge_session()
        AND auth.uid() = split_part((SELECT realtime.topic()), ':', 3)::uuid
        AND public.teammate_user_can_access_server(
          split_part((SELECT realtime.topic()), ':', 2)::uuid
        )
      ELSE false
    END
  );

CREATE POLICY "Teammate RPC response subscribers"
  ON realtime.messages FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND CASE
      WHEN (SELECT realtime.topic()) ~ '^bridge-rpc-response:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN NOT public.teammate_is_bridge_session()
        AND auth.uid() = split_part((SELECT realtime.topic()), ':', 3)::uuid
        AND public.teammate_user_can_access_server(
          split_part((SELECT realtime.topic()), ':', 2)::uuid
        )
      ELSE false
    END
  );

CREATE POLICY "Teammate RPC response publishers"
  ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'broadcast'
    AND CASE
      WHEN (SELECT realtime.topic()) ~ '^bridge-rpc-response:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN public.teammate_bridge_can_access_server(
        split_part((SELECT realtime.topic()), ':', 2)::uuid,
        split_part((SELECT realtime.topic()), ':', 3)::uuid
      )
      ELSE false
    END
  );

-- Hosted runtime identity v2. Controller sessions retain workspace delivery,
-- heartbeat, status, and RPC duties. Model subprocesses authenticate as one
-- agent UUID and every data-plane operation revalidates the machine key,
-- human owner, workspace, and agent membership from live rows.
CREATE OR REPLACE FUNCTION public.teammate_is_agent_session()
RETURNS boolean AS $$
  SELECT auth.uid() IS NOT NULL
    AND COALESCE(
      (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        ->> 'teammate_agent') = 'true',
      false
    )
    AND COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
      ->> 'teammate_token_version' = '2'
    AND COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
      ->> 'teammate_agent_id' = auth.uid()::text;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.teammate_is_human_session()
RETURNS boolean AS $$
  SELECT auth.uid() IS NOT NULL
    AND NOT public.teammate_is_bridge_session()
    AND NOT public.teammate_is_agent_session();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.teammate_agent_session_matches_server(server_uuid uuid)
RETURNS boolean AS $$
  WITH claims AS (
    SELECT COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), ''),
      '{}'
    )::jsonb AS value
  )
  SELECT EXISTS (
    SELECT 1
    FROM claims
    JOIN public.agents agent
      ON agent.id = auth.uid()
     AND agent.id::text = claims.value ->> 'teammate_agent_id'
     AND agent.owner_id::text = claims.value ->> 'teammate_owner_id'
     AND agent.server_id = server_uuid
    JOIN public.server_members agent_membership
      ON agent_membership.server_id = server_uuid
     AND agent_membership.member_id = agent.id
     AND agent_membership.member_type = 'agent'
    JOIN public.machine_keys machine_key
      ON machine_key.id::text = claims.value ->> 'teammate_machine_key_id'
     AND machine_key.user_id = agent.owner_id
     AND machine_key.server_id = server_uuid
    JOIN public.servers server ON server.id = server_uuid
    WHERE claims.value ->> 'teammate_agent' = 'true'
      AND claims.value ->> 'teammate_token_version' = '2'
      AND claims.value ->> 'teammate_server_id' = server_uuid::text
      AND (
        server.owner_id = agent.owner_id
        OR EXISTS (
          SELECT 1
          FROM public.server_members owner_membership
          WHERE owner_membership.server_id = server_uuid
            AND owner_membership.member_id = agent.owner_id
            AND owner_membership.member_type = 'human'
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_has_agent_in_channel(channel_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.channel_members member
    JOIN public.agents agent
      ON agent.id = member.member_id
     AND member.member_type = 'agent'
    JOIN public.channels channel
      ON channel.id = member.channel_id
     AND channel.server_id = agent.server_id
    JOIN public.server_members agent_membership
      ON agent_membership.server_id = channel.server_id
     AND agent_membership.member_id = agent.id
     AND agent_membership.member_type = 'agent'
    WHERE member.channel_id = channel_uuid
      AND (
        (
          public.teammate_is_agent_session()
          AND agent.id = auth.uid()
          AND public.teammate_agent_session_matches_server(channel.server_id)
        )
        OR (
          public.teammate_is_bridge_session()
          AND agent.owner_id = auth.uid()
          AND public.teammate_bridge_session_matches_server(channel.server_id)
          AND EXISTS (
            SELECT 1 FROM public.servers workspace
            WHERE workspace.id = channel.server_id
              AND (
                workspace.owner_id = auth.uid()
                OR EXISTS (
                  SELECT 1 FROM public.server_members owner_membership
                  WHERE owner_membership.server_id = channel.server_id
                    AND owner_membership.member_id = auth.uid()
                    AND owner_membership.member_type = 'human'
                )
              )
          )
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_owns_agent_in_channel(
  agent_uuid uuid,
  channel_uuid uuid
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agents agent
    JOIN public.channel_members member
      ON member.member_id = agent.id
     AND member.member_type = 'agent'
    JOIN public.channels channel
      ON channel.id = member.channel_id
     AND channel.server_id = agent.server_id
    JOIN public.server_members agent_membership
      ON agent_membership.server_id = channel.server_id
     AND agent_membership.member_id = agent.id
     AND agent_membership.member_type = 'agent'
    WHERE agent.id = agent_uuid
      AND member.channel_id = channel_uuid
      AND (
        (
          public.teammate_is_agent_session()
          AND agent_uuid = auth.uid()
          AND public.teammate_agent_session_matches_server(channel.server_id)
        )
        OR (
          public.teammate_is_bridge_session()
          AND agent.owner_id = auth.uid()
          AND public.teammate_bridge_session_matches_server(channel.server_id)
          AND EXISTS (
            SELECT 1 FROM public.servers workspace
            WHERE workspace.id = channel.server_id
              AND (
                workspace.owner_id = auth.uid()
                OR EXISTS (
                  SELECT 1 FROM public.server_members owner_membership
                  WHERE owner_membership.server_id = channel.server_id
                    AND owner_membership.member_id = auth.uid()
                    AND owner_membership.member_type = 'human'
                )
              )
          )
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.user_owns_agent_in_server(
  server_uuid uuid,
  agent_uuid uuid
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agents agent
    JOIN public.server_members membership
      ON membership.server_id = agent.server_id
     AND membership.member_id = agent.id
     AND membership.member_type = 'agent'
    WHERE agent.id = agent_uuid
      AND agent.server_id = server_uuid
      AND (
        (
          public.teammate_is_human_session()
          AND agent.owner_id = auth.uid()
          AND public.user_is_server_human_member(server_uuid)
        )
        OR
        (
          public.teammate_is_agent_session()
          AND agent.id = auth.uid()
          AND public.teammate_agent_session_matches_server(server_uuid)
        )
        OR (
          public.teammate_is_bridge_session()
          AND agent.owner_id = auth.uid()
          AND public.teammate_bridge_session_matches_server(server_uuid)
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.lock_channel_member_for_task(
  channel_uuid uuid,
  member_uuid uuid,
  member_type text,
  require_owned_agent boolean
)
RETURNS boolean AS $$
BEGIN
  IF member_type = 'agent' THEN
    PERFORM 1
    FROM public.channel_members channel_member
    JOIN public.channels channel ON channel.id = channel_member.channel_id
    JOIN public.agents agent
      ON agent.id = channel_member.member_id
     AND agent.server_id = channel.server_id
    JOIN public.server_members workspace_member
      ON workspace_member.server_id = channel.server_id
     AND workspace_member.member_id = agent.id
     AND workspace_member.member_type = 'agent'
    WHERE channel_member.channel_id = channel_uuid
      AND channel_member.member_id = member_uuid
      AND channel_member.member_type = 'agent'
      AND (
        NOT require_owned_agent
        OR public.user_owns_agent_in_channel(member_uuid, channel_uuid)
      )
    FOR KEY SHARE OF channel_member, agent, workspace_member;
  ELSIF member_type = 'human' AND NOT require_owned_agent THEN
    PERFORM 1
    FROM public.channel_members channel_member
    JOIN public.channels channel ON channel.id = channel_member.channel_id
    JOIN public.profiles profile ON profile.id = channel_member.member_id
    JOIN public.server_members workspace_member
      ON workspace_member.server_id = channel.server_id
     AND workspace_member.member_id = profile.id
     AND workspace_member.member_type = 'human'
    WHERE channel_member.channel_id = channel_uuid
      AND channel_member.member_id = member_uuid
      AND channel_member.member_type = 'human'
    FOR KEY SHARE OF channel_member, workspace_member;
  ELSE
    RETURN false;
  END IF;
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.list_workspace_agent_directory(server_uuid uuid)
RETURNS TABLE (
  id uuid,
  name text,
  display_name text,
  description text,
  avatar_url text,
  status text
) AS $$
BEGIN
  IF NOT (
    (
      public.teammate_is_human_session()
      AND EXISTS (
        SELECT 1 FROM public.server_members viewer_membership
        WHERE viewer_membership.server_id = server_uuid
          AND viewer_membership.member_id = auth.uid()
          AND viewer_membership.member_type = 'human'
      )
    )
    OR public.teammate_agent_session_matches_server(server_uuid)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Workspace access denied';
  END IF;

  RETURN QUERY
  SELECT agent.id, agent.name, agent.display_name, agent.description, agent.avatar_url, agent.status
  FROM public.agents agent
  JOIN public.server_members agent_membership
    ON agent_membership.server_id = agent.server_id
   AND agent_membership.member_id = agent.id
   AND agent_membership.member_type = 'agent'
  WHERE agent.server_id = server_uuid
  ORDER BY agent.created_at, agent.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.list_workspace_human_directory(server_uuid uuid)
RETURNS TABLE (id uuid, display_name text, avatar_url text) AS $$
BEGIN
  IF NOT (
    (
      public.teammate_is_human_session()
      AND EXISTS (
        SELECT 1 FROM public.server_members viewer_membership
        WHERE viewer_membership.server_id = server_uuid
          AND viewer_membership.member_id = auth.uid()
          AND viewer_membership.member_type = 'human'
      )
    )
    OR public.teammate_agent_session_matches_server(server_uuid)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Workspace access denied';
  END IF;

  RETURN QUERY
  SELECT profile.id, profile.display_name, profile.avatar_url
  FROM public.server_members membership
  JOIN public.profiles profile ON profile.id = membership.member_id
  WHERE membership.server_id = server_uuid
    AND membership.member_type = 'human'
  ORDER BY profile.display_name, profile.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.list_channel_agent_mentions(channel_uuid uuid)
RETURNS jsonb AS $$
DECLARE
  target_server_id uuid;
  mentions jsonb;
BEGIN
  SELECT channel.server_id INTO target_server_id
  FROM public.channels channel
  WHERE channel.id = channel_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Channel not found';
  END IF;
  IF NOT public.user_is_channel_member(channel_uuid)
    AND NOT public.user_has_agent_in_channel(channel_uuid) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channel access denied';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', agent.id,
        'name', agent.name,
        'display_name', agent.display_name,
        'description', agent.description,
        'avatar_url', agent.avatar_url,
        'status', agent.status,
        'is_owner', agent.id = auth.uid()
      ) ORDER BY agent.name, agent.id
    ),
    '[]'::jsonb
  ) INTO mentions
  FROM public.channel_members channel_member
  JOIN public.agents agent
    ON agent.id = channel_member.member_id
   AND agent.server_id = target_server_id
  JOIN public.server_members workspace_member
    ON workspace_member.server_id = target_server_id
   AND workspace_member.member_id = agent.id
   AND workspace_member.member_type = 'agent'
  WHERE channel_member.channel_id = channel_uuid
    AND channel_member.member_type = 'agent';
  RETURN mentions;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.teammate_is_agent_session() FROM public;
REVOKE ALL ON FUNCTION public.teammate_agent_session_matches_server(uuid) FROM public;
REVOKE ALL ON FUNCTION public.list_workspace_human_directory(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.teammate_is_agent_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.teammate_agent_session_matches_server(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_workspace_human_directory(uuid) TO authenticated;

DROP POLICY IF EXISTS "Workspace members can view agents" ON public.agents;
CREATE POLICY "Workspace members can view agents"
  ON public.agents FOR SELECT
  USING (
    (
      owner_id = auth.uid()
      AND (
        public.teammate_is_human_session()
        OR public.teammate_bridge_session_matches_server(server_id)
      )
    )
    OR (
      id = auth.uid()
      AND public.teammate_agent_session_matches_server(server_id)
    )
  );

DROP POLICY IF EXISTS "Server members can view documents" ON public.documents;
CREATE POLICY "Server members can view documents"
  ON public.documents FOR SELECT
  USING (
    public.user_can_create_agent_in_server(server_id, auth.uid())
    OR public.teammate_bridge_session_matches_server(server_id)
    OR public.teammate_agent_session_matches_server(server_id)
  );

DROP POLICY IF EXISTS "Server members can create documents" ON public.documents;
CREATE POLICY "Server members can create documents"
  ON public.documents FOR INSERT
  WITH CHECK (
    (
      auth.uid() = created_by
      AND public.user_can_create_agent_in_server(server_id, auth.uid())
      AND (
        generated_by_agent_id IS NULL
        OR public.user_owns_agent_in_server(server_id, generated_by_agent_id)
      )
    )
    OR (
      public.teammate_agent_session_matches_server(server_id)
      AND generated_by_agent_id = auth.uid()
      AND created_by::text = (
        COALESCE(
          NULLIF(current_setting('request.jwt.claims', true), ''),
          '{}'
        )::jsonb ->> 'teammate_owner_id'
      )
    )
  );

DROP POLICY IF EXISTS "Server members can update documents" ON public.documents;
CREATE POLICY "Server members can update documents"
  ON public.documents FOR UPDATE
  USING (
    public.user_can_create_agent_in_server(server_id, auth.uid())
    OR public.teammate_bridge_session_matches_server(server_id)
    OR public.teammate_agent_session_matches_server(server_id)
  )
  WITH CHECK (
    (
      public.user_can_create_agent_in_server(server_id, auth.uid())
      OR public.teammate_bridge_session_matches_server(server_id)
      OR public.teammate_agent_session_matches_server(server_id)
    )
    AND public.document_identity_is_unchanged(
      id,
      server_id,
      created_by,
      generated_by_agent_id
    )
  );
-- Task lifecycle writes stay behind actor-scoped RPCs. Channel row locks
-- serialize hierarchy changes with task creation without reopening table UPDATE.
CREATE OR REPLACE FUNCTION public.claim_message_as_task(
  message_uuid uuid,
  sender_agent_uuid uuid,
  expected_message_updated_at timestamptz
)
RETURNS jsonb AS $$
DECLARE
  target_channel_id uuid;
  target_server_id uuid;
  target_message public.messages%rowtype;
  target_task public.tasks%rowtype;
  derived_title text;
BEGIN
  IF sender_agent_uuid IS NULL
    OR auth.uid() IS DISTINCT FROM sender_agent_uuid
    OR NOT public.teammate_is_agent_session()
    OR expected_message_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Agent authentication required';
  END IF;

  SELECT message.channel_id, channel.server_id
    INTO target_channel_id, target_server_id
  FROM public.messages message
  JOIN public.channels channel ON channel.id = message.channel_id
  WHERE message.id = message_uuid;
  IF NOT FOUND
    OR NOT public.teammate_agent_session_matches_server(target_server_id)
    OR NOT public.user_owns_agent_in_channel(sender_agent_uuid, target_channel_id)
    OR NOT public.lock_channel_member_for_task(
      target_channel_id,
      sender_agent_uuid,
      'agent',
      true
    ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Message not found';
  END IF;

  PERFORM 1
  FROM public.channels channel
  WHERE channel.id = target_channel_id
    AND channel.server_id = target_server_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Message not found';
  END IF;

  SELECT message.* INTO target_message
  FROM public.messages message
  WHERE message.id = message_uuid
    AND message.channel_id = target_channel_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Message not found';
  END IF;
  IF target_message.thread_parent_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Thread replies cannot become tasks';
  END IF;
  IF target_message.sender_type = 'system' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'System messages cannot become tasks';
  END IF;
  IF target_message.updated_at IS DISTINCT FROM expected_message_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Message changed; refresh and retry';
  END IF;

  SELECT task.* INTO target_task
  FROM public.tasks task
  WHERE task.message_id = target_message.id
  FOR UPDATE;
  IF FOUND THEN
    IF target_task.archived_at IS NOT NULL
      OR target_task.status = 'done'
      OR (
        target_task.assignee_id IS NOT NULL
        AND (
          target_task.assignee_id IS DISTINCT FROM sender_agent_uuid
          OR target_task.assignee_type IS DISTINCT FROM 'agent'
        )
      ) THEN
      RETURN jsonb_build_object(
        'outcome', 'conflict',
        'created', false,
        'claimed', false,
        'task', to_jsonb(target_task)
      );
    END IF;

    IF target_task.assignee_id = sender_agent_uuid
      AND target_task.assignee_type = 'agent'
      AND target_task.status = 'in_progress' THEN
      RETURN jsonb_build_object(
        'outcome', 'already_claimed',
        'created', false,
        'claimed', false,
        'task', to_jsonb(target_task)
      );
    END IF;

    UPDATE public.tasks task
    SET assignee_id = sender_agent_uuid,
        assignee_type = 'agent',
        status = 'in_progress',
        updated_at = now()
    WHERE task.id = target_task.id
    RETURNING * INTO target_task;
    RETURN jsonb_build_object(
      'outcome', 'claimed_existing',
      'created', false,
      'claimed', true,
      'task', to_jsonb(target_task)
    );
  END IF;

  SELECT left(btrim(line.value), 500)
    INTO derived_title
  FROM regexp_split_to_table(
    replace(target_message.content, E'\r\n', E'\n'),
    E'\n'
  ) WITH ORDINALITY AS line(value, position)
  WHERE btrim(line.value) <> ''
  ORDER BY line.position
  LIMIT 1;
  IF coalesce(char_length(derived_title), 0) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Message has no task title';
  END IF;

  INSERT INTO public.tasks (
    message_id,
    channel_id,
    title,
    status,
    assignee_id,
    assignee_type
  ) VALUES (
    target_message.id,
    target_channel_id,
    derived_title,
    'in_progress',
    sender_agent_uuid,
    'agent'
  )
  RETURNING * INTO target_task;

  RETURN jsonb_build_object(
    'outcome', 'claimed_new',
    'created', true,
    'claimed', true,
    'task', to_jsonb(target_task)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.update_task_details(
  task_uuid uuid,
  task_title text,
  task_description text,
  parent_task_uuid uuid,
  sender_agent_uuid uuid,
  expected_updated_at timestamptz
)
RETURNS jsonb AS $$
DECLARE
  normalized_title text := btrim(task_title);
  normalized_description text := coalesce(task_description, '');
  target_channel_id uuid;
  target_server_id uuid;
  target_message_id uuid;
  target_task public.tasks%rowtype;
  parent_task public.tasks%rowtype;
BEGIN
  IF coalesce(char_length(normalized_title), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid task title';
  END IF;
  IF char_length(normalized_description) > 100000 OR expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid task details';
  END IF;

  SELECT task.channel_id, channel.server_id, task.message_id
    INTO target_channel_id, target_server_id, target_message_id
  FROM public.tasks task
  JOIN public.channels channel ON channel.id = task.channel_id
  WHERE task.id = task_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;

  IF sender_agent_uuid IS NULL THEN
    IF NOT public.teammate_is_human_session()
      OR NOT public.lock_channel_member_for_task(
        target_channel_id,
        auth.uid(),
        'human',
        false
      ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
    END IF;
  ELSIF auth.uid() IS DISTINCT FROM sender_agent_uuid
    OR NOT public.teammate_is_agent_session()
    OR NOT public.teammate_agent_session_matches_server(target_server_id)
    OR NOT public.user_owns_agent_in_channel(sender_agent_uuid, target_channel_id)
    OR NOT public.lock_channel_member_for_task(
      target_channel_id,
      sender_agent_uuid,
      'agent',
      true
    ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;

  PERFORM 1 FROM public.channels channel
  WHERE channel.id = target_channel_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  PERFORM 1 FROM public.messages message
  WHERE message.id = target_message_id
    AND message.channel_id = target_channel_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Task message is missing';
  END IF;

  SELECT task.* INTO target_task
  FROM public.tasks task
  WHERE task.id = task_uuid
    AND task.channel_id = target_channel_id
    AND task.message_id = target_message_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  IF target_task.updated_at IS DISTINCT FROM expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Task changed; refresh and retry';
  END IF;

  IF parent_task_uuid IS NOT NULL THEN
    IF parent_task_uuid = task_uuid THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A task cannot be its own parent';
    END IF;
    SELECT parent.* INTO parent_task
    FROM public.tasks parent
    WHERE parent.id = parent_task_uuid
      AND parent.channel_id = target_channel_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Parent task must belong to the same channel';
    END IF;
    IF target_task.archived_at IS NULL AND EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT task.id, task.parent_task_id, task.archived_at
        FROM public.tasks task
        WHERE task.id = parent_task_uuid
        UNION
        SELECT task.id, task.parent_task_id, task.archived_at
        FROM public.tasks task
        JOIN ancestors child ON task.id = child.parent_task_id
      )
      SELECT 1 FROM ancestors ancestor
      WHERE ancestor.archived_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An active task cannot use an archived parent';
    END IF;
    IF EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT task.id, task.parent_task_id
        FROM public.tasks task
        WHERE task.id = parent_task_uuid
        UNION
        SELECT task.id, task.parent_task_id
        FROM public.tasks task
        JOIN ancestors child ON task.id = child.parent_task_id
      )
      SELECT 1 FROM ancestors ancestor WHERE ancestor.id = task_uuid
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Task hierarchy cannot contain a cycle';
    END IF;
  END IF;

  IF target_task.title = normalized_title
    AND target_task.description = normalized_description
    AND target_task.parent_task_id IS NOT DISTINCT FROM parent_task_uuid THEN
    RETURN jsonb_build_object('task', to_jsonb(target_task));
  END IF;

  UPDATE public.tasks task
  SET title = normalized_title,
      description = normalized_description,
      parent_task_id = parent_task_uuid,
      updated_at = now()
  WHERE task.id = target_task.id
  RETURNING * INTO target_task;
  RETURN jsonb_build_object('task', to_jsonb(target_task));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_task_archived(
  task_uuid uuid,
  archived boolean,
  sender_agent_uuid uuid,
  expected_updated_at timestamptz
)
RETURNS jsonb AS $$
DECLARE
  target_channel_id uuid;
  target_server_id uuid;
  target_task public.tasks%rowtype;
  descendant_ids uuid[];
  changed_tasks jsonb;
BEGIN
  IF archived IS NULL OR expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid task archive request';
  END IF;

  SELECT task.channel_id, channel.server_id
    INTO target_channel_id, target_server_id
  FROM public.tasks task
  JOIN public.channels channel ON channel.id = task.channel_id
  WHERE task.id = task_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;

  IF sender_agent_uuid IS NULL THEN
    IF NOT public.teammate_is_human_session()
      OR NOT public.lock_channel_member_for_task(
        target_channel_id,
        auth.uid(),
        'human',
        false
      ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
    END IF;
  ELSIF auth.uid() IS DISTINCT FROM sender_agent_uuid
    OR NOT public.teammate_is_agent_session()
    OR NOT public.teammate_agent_session_matches_server(target_server_id)
    OR NOT public.user_owns_agent_in_channel(sender_agent_uuid, target_channel_id)
    OR NOT public.lock_channel_member_for_task(
      target_channel_id,
      sender_agent_uuid,
      'agent',
      true
    ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;

  PERFORM 1 FROM public.channels channel
  WHERE channel.id = target_channel_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  SELECT task.* INTO target_task
  FROM public.tasks task
  WHERE task.id = task_uuid
    AND task.channel_id = target_channel_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  IF target_task.updated_at IS DISTINCT FROM expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Task changed; refresh and retry';
  END IF;

  IF NOT archived AND EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT task.id, task.parent_task_id, task.archived_at
      FROM public.tasks task
      WHERE task.id = target_task.parent_task_id
      UNION
      SELECT task.id, task.parent_task_id, task.archived_at
      FROM public.tasks task
      JOIN ancestors child ON task.id = child.parent_task_id
    )
    SELECT 1 FROM ancestors ancestor WHERE ancestor.archived_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Restore the archived ancestor before restoring this task';
  END IF;

  WITH RECURSIVE descendants AS (
    SELECT task.id
    FROM public.tasks task
    WHERE task.id = target_task.id
    UNION
    SELECT child.id
    FROM public.tasks child
    JOIN descendants parent ON child.parent_task_id = parent.id
    WHERE child.channel_id = target_channel_id
  )
  SELECT array_agg(descendant.id ORDER BY descendant.id)
    INTO descendant_ids
  FROM descendants descendant;

  PERFORM 1 FROM public.tasks task
  WHERE task.id = ANY(descendant_ids)
  ORDER BY task.id
  FOR UPDATE;

  WITH updated_tasks AS (
    UPDATE public.tasks task
    SET archived_at = CASE WHEN archived THEN now() ELSE NULL END,
        updated_at = now()
    WHERE task.id = ANY(descendant_ids)
      AND task.channel_id = target_channel_id
    RETURNING task.*
  )
  SELECT coalesce(
    jsonb_agg(to_jsonb(updated_tasks) ORDER BY updated_tasks.task_number),
    '[]'::jsonb
  ) INTO changed_tasks
  FROM updated_tasks;

  SELECT task.* INTO target_task
  FROM public.tasks task
  WHERE task.id = task_uuid;
  RETURN jsonb_build_object(
    'task', to_jsonb(target_task),
    'tasks', changed_tasks,
    'affected_count', coalesce(array_length(descendant_ids, 1), 0)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.delete_archived_task(
  task_uuid uuid,
  expected_updated_at timestamptz
)
RETURNS jsonb AS $$
DECLARE
  target_channel_id uuid;
  target_server_id uuid;
  target_message_id uuid;
  target_task public.tasks%rowtype;
  deleted_task public.tasks%rowtype;
BEGIN
  IF expected_updated_at IS NULL OR NOT public.teammate_is_human_session() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Human authentication required';
  END IF;

  SELECT task.channel_id, channel.server_id, task.message_id
    INTO target_channel_id, target_server_id, target_message_id
  FROM public.tasks task
  JOIN public.channels channel ON channel.id = task.channel_id
  WHERE task.id = task_uuid;
  IF NOT FOUND OR NOT public.user_can_manage_channel(target_channel_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;

  PERFORM 1
  FROM public.server_members member
  WHERE member.server_id = target_server_id
    AND member.member_id = auth.uid()
    AND member.member_type = 'human'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;

  PERFORM 1 FROM public.channels channel
  WHERE channel.id = target_channel_id
    AND channel.server_id = target_server_id
  FOR UPDATE;
  IF NOT FOUND OR NOT public.user_can_manage_channel(target_channel_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  SELECT task.* INTO target_task
  FROM public.tasks task
  WHERE task.id = task_uuid
    AND task.channel_id = target_channel_id
    AND task.message_id = target_message_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Task not found';
  END IF;
  IF target_task.updated_at IS DISTINCT FROM expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Task changed; refresh and retry';
  END IF;
  IF target_task.archived_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Archive the task before deleting it';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tasks child
    WHERE child.parent_task_id = target_task.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Delete or reparent child tasks first';
  END IF;

  DELETE FROM public.tasks task
  WHERE task.id = target_task.id
  RETURNING * INTO deleted_task;
  RETURN jsonb_build_object(
    'deleted', true,
    'task', to_jsonb(deleted_task),
    'message_id', target_message_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.claim_message_as_task(uuid, uuid, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.update_task_details(uuid, text, text, uuid, uuid, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.set_task_archived(uuid, boolean, uuid, timestamptz) FROM public;
REVOKE ALL ON FUNCTION public.delete_archived_task(uuid, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_message_as_task(uuid, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_task_details(uuid, text, text, uuid, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_task_archived(uuid, boolean, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_archived_task(uuid, timestamptz) TO authenticated;
