-- ============================================================
-- Teammate Database Schema
-- Run this in Supabase SQL Editor to set up your database
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- -----------------------------------------------------------
-- Profiles (extends Supabase auth.users)
-- -----------------------------------------------------------
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  display_name text not null,
  avatar_url text,
  created_at timestamptz default now() not null
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------
-- Workspaces and members
-- -----------------------------------------------------------
create table public.servers (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  slug text not null unique,
  description text,
  owner_id uuid references public.profiles(id) on delete cascade not null,
  created_at timestamptz default now() not null
);

create table public.server_members (
  server_id uuid references public.servers(id) on delete cascade not null,
  member_id uuid not null,
  member_type text not null check (member_type in ('human', 'agent')),
  role text default 'member' not null check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz default now() not null,
  primary key (server_id, member_id)
);

-- -----------------------------------------------------------
-- Agents
-- -----------------------------------------------------------
create table public.agents (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  display_name text not null,
  description text,
  system_prompt text,
  runtime text default 'codex' not null check (runtime in ('claude-code', 'codex', 'pi')),
  model text default 'default' not null,
  status text default 'offline' check (status in ('online', 'sleeping', 'offline')),
  owner_id uuid references public.profiles(id) on delete cascade not null,
  server_id uuid references public.servers(id) on delete cascade not null,
  workspace_path text,
  session_id text,
  runtime_session_id text,
  runtime_session_runtime text,
  connection_id text,
  avatar_url text,
  created_at timestamptz default now() not null,
  unique(server_id, name)
);

-- -----------------------------------------------------------
-- Channels
-- -----------------------------------------------------------
create table public.channels (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  description text,
  type text default 'public' check (type in ('public', 'private', 'dm')),
  created_by uuid references public.profiles(id) on delete set null,
  server_id uuid references public.servers(id) on delete cascade not null,
  created_at timestamptz default now() not null,
  unique(server_id, name)
);

-- -----------------------------------------------------------
-- Channel Members
-- -----------------------------------------------------------
create table public.channel_members (
  channel_id uuid references public.channels(id) on delete cascade,
  member_id uuid not null,
  member_type text not null check (member_type in ('human', 'agent')),
  joined_at timestamptz default now() not null,
  primary key (channel_id, member_id)
);

-- -----------------------------------------------------------
-- Runtime machine keys
-- -----------------------------------------------------------
-- This table is declared before the atomic provisioning functions below so a
-- fresh schema install can resolve every relation referenced by those functions.
create table public.machine_keys (
  id uuid default uuid_generate_v4() primary key,
  key_prefix text not null,
  key_hash text not null unique,
  key_value text,
  user_id uuid references public.profiles(id) on delete cascade not null,
  server_id uuid references public.servers(id) on delete cascade not null,
  name text default 'Default' not null,
  created_at timestamptz default now() not null,
  last_used_at timestamptz
);

-- -----------------------------------------------------------
-- Messages
-- -----------------------------------------------------------
create table public.messages (
  id uuid default uuid_generate_v4() primary key,
  channel_id uuid references public.channels(id) on delete cascade not null,
  sender_id uuid not null,
  sender_type text not null check (sender_type in ('human', 'agent', 'system')),
  content text not null,
  seq bigint,
  thread_parent_id uuid references public.messages(id) on delete cascade,
  -- A thread reply the author also wanted the channel to see. Slack renders it
  -- in the main flow with the thread root quoted above it.
  thread_broadcast boolean default false not null,
  -- Set when a person rewrites what they said, so the UI can mark it without
  -- inferring intent from updated_at, which moves for other reasons too.
  edited_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Auto-assign per-channel sequential number on insert
create or replace function assign_message_seq()
returns trigger as $$
begin
  -- max(seq) is only safe when inserts for the same channel are serialized.
  -- A transaction-scoped advisory lock keeps unrelated channels concurrent.
  perform pg_advisory_xact_lock(hashtextextended(new.channel_id::text, 0));
  select coalesce(max(seq), 0) + 1 into new.seq
  from public.messages where channel_id = new.channel_id;
  return new;
end;
$$ language plpgsql;

create trigger trg_message_seq
before insert on public.messages
for each row execute function assign_message_seq();

create or replace function public.validate_message_scope()
returns trigger as $$
begin
  if tg_op = 'UPDATE' and (
    new.channel_id is distinct from old.channel_id
    or new.sender_id is distinct from old.sender_id
    or new.sender_type is distinct from old.sender_type
    or new.seq is distinct from old.seq
  ) then
    raise exception using errcode = '23514', message = 'Message identity fields are immutable';
  end if;

  if new.thread_parent_id is not null and (
    new.thread_parent_id = new.id
    or not exists (
      select 1
      from public.messages parent
      where parent.id = new.thread_parent_id
        and parent.channel_id = new.channel_id
    )
  ) then
    raise exception using errcode = '23514', message = 'Thread parent must belong to the same channel';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function public.validate_message_scope() from public;

create trigger trg_validate_message_scope
before insert or update on public.messages
for each row execute function public.validate_message_scope();

create index idx_messages_channel on public.messages(channel_id, created_at desc);
create unique index idx_messages_channel_seq on public.messages(channel_id, seq);
create index idx_messages_thread on public.messages(thread_parent_id, created_at asc);

-- -----------------------------------------------------------
-- Read state
-- -----------------------------------------------------------
-- How far each person has read in each channel. The unread marker is drawn
-- from the value captured when the channel was opened, so it stays put while
-- you read rather than sliding ahead of you.
create table public.channel_read_state (
  user_id uuid not null,
  channel_id uuid references public.channels(id) on delete cascade not null,
  last_read_seq bigint default 0 not null,
  updated_at timestamptz default now() not null,
  primary key (user_id, channel_id)
);

alter table public.channel_read_state enable row level security;

create policy "People see only their own read state" on public.channel_read_state for select using (
  auth.uid() = user_id
);
create policy "People record their own read state" on public.channel_read_state for insert with check (
  auth.uid() = user_id and public.user_is_channel_member(channel_id)
);
create policy "People advance their own read state" on public.channel_read_state for update using (
  auth.uid() = user_id
);

-- -----------------------------------------------------------
-- Reactions
-- -----------------------------------------------------------
-- A reaction is an edge, not a record: it is added and removed, never edited,
-- so the natural key is the whole row.
create table public.message_reactions (
  message_id uuid references public.messages(id) on delete cascade not null,
  actor_id uuid not null,
  actor_type text not null check (actor_type in ('human', 'agent')),
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz default now() not null,
  primary key (message_id, actor_id, emoji)
);

create index idx_message_reactions_message on public.message_reactions(message_id);

-- -----------------------------------------------------------
-- Durable agent message inbox
-- -----------------------------------------------------------
-- One row per message/agent is the durable hand-off between chat and a Bridge.
-- Realtime only wakes the Bridge; startup/polling catch-up reads this table.
create table public.message_deliveries (
  message_id uuid references public.messages(id) on delete cascade not null,
  agent_id uuid references public.agents(id) on delete cascade not null,
  server_id uuid references public.servers(id) on delete cascade not null,
  channel_id uuid references public.channels(id) on delete cascade not null,
  status text default 'pending' not null
    check (status in ('pending', 'processing', 'completed', 'skipped', 'failed')),
  attempts integer default 0 not null check (attempts >= 0),
  claim_token uuid,
  claimed_by text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz default now() not null,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  primary key (message_id, agent_id)
);

create index idx_message_deliveries_ready
  on public.message_deliveries(server_id, status, next_attempt_at, created_at);
create index idx_message_deliveries_expired
  on public.message_deliveries(server_id, status, lease_expires_at, created_at);
create index idx_message_deliveries_agent
  on public.message_deliveries(agent_id, status, created_at);

create or replace function public.validate_message_delivery_scope()
returns trigger as $$
begin
  if tg_op = 'UPDATE' and (
    new.message_id is distinct from old.message_id
    or new.agent_id is distinct from old.agent_id
    or new.server_id is distinct from old.server_id
    or new.channel_id is distinct from old.channel_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Message delivery identity fields are immutable';
  end if;

  if tg_op = 'INSERT' and not exists (
    select 1
    from public.messages message
    join public.channels channel
      on channel.id = message.channel_id
     and channel.id = new.channel_id
     and channel.server_id = new.server_id
    join public.agents agent
      on agent.id = new.agent_id
     and agent.server_id = channel.server_id
    join public.channel_members channel_member
      on channel_member.channel_id = channel.id
     and channel_member.member_id = agent.id
     and channel_member.member_type = 'agent'
    join public.server_members workspace_member
      on workspace_member.server_id = channel.server_id
     and workspace_member.member_id = agent.id
     and workspace_member.member_type = 'agent'
    where message.id = new.message_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Message delivery must stay inside one agent channel workspace';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function public.validate_message_delivery_scope() from public;

create trigger trg_validate_message_delivery_scope
before insert or update on public.message_deliveries
for each row execute function public.validate_message_delivery_scope();

create or replace function public.enqueue_human_message_deliveries()
returns trigger as $$
begin
  -- Human messages fan out to every agent member; agent messages fan out too
  -- (minus the sender) so agents can @mention each other — the runtime keeps
  -- agent-authored deliveries strictly mention-gated.
  if new.sender_type not in ('human', 'agent') then
    return new;
  end if;

  insert into public.message_deliveries (
    message_id,
    agent_id,
    server_id,
    channel_id
  )
  select
    new.id,
    agent.id,
    channel.server_id,
    new.channel_id
  from public.channel_members member
  join public.agents agent
    on agent.id = member.member_id
   and member.member_type = 'agent'
  join public.channels channel
    on channel.id = new.channel_id
   and channel.server_id = agent.server_id
  join public.server_members workspace_member
    on workspace_member.server_id = channel.server_id
   and workspace_member.member_id = agent.id
   and workspace_member.member_type = 'agent'
  where member.channel_id = new.channel_id
    and agent.id <> new.sender_id
  on conflict (message_id, agent_id) do nothing;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- Runtime JWTs authenticate as their human owner. Define this role discriminator
-- before any human-only SECURITY DEFINER RPC can reference it.
create or replace function public.teammate_is_bridge_session()
returns boolean as $$
  select coalesce(
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
      ->> 'teammate_bridge') = 'true',
    false
  );
$$ language sql stable;

create or replace function public.teammate_is_human_session()
returns boolean as $$
  select auth.uid() is not null and not public.teammate_is_bridge_session();
$$ language sql stable;

create or replace function public.teammate_bridge_session_matches_server(server_uuid uuid)
returns boolean as $$
  with claims as (
    select coalesce(
      nullif(current_setting('request.jwt.claims', true), ''),
      '{}'
    )::jsonb as value
  )
  select exists (
    select 1
    from claims
    join public.machine_keys machine_key
      on machine_key.id::text = claims.value ->> 'teammate_machine_key_id'
     and machine_key.user_id = auth.uid()
     and machine_key.server_id = server_uuid
    join public.servers server on server.id = server_uuid
    where claims.value ->> 'teammate_bridge' = 'true'
      and claims.value ->> 'teammate_server_id' = server_uuid::text
      and (
        server.owner_id = auth.uid()
        or exists (
          select 1
          from public.server_members member
          where member.server_id = server_uuid
            and member.member_id = auth.uid()
            and member.member_type = 'human'
        )
      )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.touch_current_bridge_machine_key()
returns timestamptz as $$
declare
  claims jsonb := coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
  touched_at timestamptz;
begin
  if not public.teammate_bridge_session_matches_server(
    nullif(claims ->> 'teammate_server_id', '')::uuid
  ) then
    raise exception using errcode = '42501', message = 'Bridge machine key is not active';
  end if;
  update public.machine_keys machine_key
  set last_used_at = now()
  where machine_key.id::text = claims ->> 'teammate_machine_key_id'
    and machine_key.user_id = auth.uid()
    and machine_key.server_id::text = claims ->> 'teammate_server_id'
  returning machine_key.last_used_at into touched_at;
  if not found then
    raise exception using errcode = '42501', message = 'Bridge machine key is not active';
  end if;
  return touched_at;
exception
  when invalid_text_representation then
    raise exception using errcode = '42501', message = 'Bridge machine key claims are invalid';
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create or replace function public.create_owned_server(
  server_name text,
  server_slug text,
  server_description text,
  machine_key_prefix text,
  machine_key_hash text,
  machine_key_value text,
  machine_key_name text
)
returns jsonb as $$
declare
  requesting_user_id uuid := auth.uid();
  created_server public.servers%rowtype;
  created_key_id uuid;
begin
  if requesting_user_id is null or public.teammate_is_bridge_session() then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if coalesce(char_length(trim(server_name)), 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid workspace name';
  end if;
  if coalesce(server_slug, '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or char_length(server_slug) > 80 then
    raise exception using errcode = '22023', message = 'Invalid workspace slug';
  end if;
  if char_length(coalesce(server_description, '')) > 1000 then
    raise exception using errcode = '22023', message = 'Workspace description is too long';
  end if;
  if coalesce(machine_key_prefix, '') !~ '^tm_[0-9a-f]{8}$'
    or coalesce(machine_key_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(machine_key_value, '') !~ '^tm_[0-9a-f]{64}$'
    or coalesce(char_length(trim(machine_key_name)), 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid runtime key';
  end if;

  insert into public.servers (name, slug, description, owner_id)
  values (trim(server_name), server_slug, nullif(trim(server_description), ''), requesting_user_id)
  returning * into created_server;

  insert into public.server_members (server_id, member_id, member_type, role)
  values (created_server.id, requesting_user_id, 'human', 'owner');

  insert into public.machine_keys (
    key_prefix,
    key_hash,
    key_value,
    user_id,
    server_id,
    name
  ) values (
    machine_key_prefix,
    machine_key_hash,
    null,
    requesting_user_id,
    created_server.id,
    trim(machine_key_name)
  ) returning id into created_key_id;

  return jsonb_build_object(
    'server', to_jsonb(created_server),
    'machine_key_id', created_key_id
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- Runtime keys are a workspace-membership capability. Provisioning takes the
-- same server -> human membership locks as member eviction, so either the key
-- commits before teardown and is revoked there, or provisioning observes that
-- the membership is gone and fails without creating a usable key.
create or replace function public.create_current_user_machine_key(
  server_uuid uuid,
  machine_key_prefix text,
  machine_key_hash text,
  machine_key_name text
)
returns jsonb as $$
declare
  requesting_user_id uuid := auth.uid();
  workspace_owner_id uuid;
  created_key public.machine_keys%rowtype;
begin
  if requesting_user_id is null or public.teammate_is_bridge_session() then
    raise exception using errcode = '42501', message = 'Human authentication required';
  end if;
  if server_uuid is null
    or coalesce(machine_key_prefix, '') !~ '^tm_[0-9a-f]{8}$'
    or coalesce(machine_key_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(char_length(trim(machine_key_name)), 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid runtime key';
  end if;

  select server.owner_id
    into workspace_owner_id
  from public.servers server
  where server.id = server_uuid
  for key share;

  if not found then
    raise exception using errcode = '42501', message = 'Workspace access denied';
  end if;
  if workspace_owner_id <> requesting_user_id then
    perform 1
    from public.server_members member
    where member.server_id = server_uuid
      and member.member_id = requesting_user_id
      and member.member_type = 'human'
    for key share;
    if not found then
      raise exception using errcode = '42501', message = 'Workspace access denied';
    end if;
  end if;

  insert into public.machine_keys (
    key_prefix,
    key_hash,
    key_value,
    user_id,
    server_id,
    name
  ) values (
    machine_key_prefix,
    machine_key_hash,
    null,
    requesting_user_id,
    server_uuid,
    trim(machine_key_name)
  ) returning * into created_key;

  return jsonb_build_object(
    'id', created_key.id,
    'key_prefix', created_key.key_prefix,
    'name', created_key.name,
    'created_at', created_key.created_at
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create or replace function public.create_owned_agent_with_dm(
  server_uuid uuid,
  agent_name text,
  agent_display_name text,
  agent_description text,
  agent_system_prompt text,
  agent_runtime text,
  agent_model text
)
returns jsonb as $$
declare
  requesting_user_id uuid := auth.uid();
  workspace_owner_id uuid;
  created_agent public.agents%rowtype;
  created_channel public.channels%rowtype;
begin
  if requesting_user_id is null or public.teammate_is_bridge_session() then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  select server.owner_id
    into workspace_owner_id
  from public.servers server
  where server.id = server_uuid
  for key share;
  if not found then
    raise exception using errcode = '42501', message = 'Workspace access denied';
  end if;
  if workspace_owner_id <> requesting_user_id then
    perform 1
    from public.server_members member
    where member.server_id = server_uuid
      and member.member_id = requesting_user_id
      and member.member_type = 'human'
    for key share;
    if not found then
      raise exception using errcode = '42501', message = 'Workspace access denied';
    end if;
  end if;
  if coalesce(agent_name, '') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(agent_name) > 100
    or coalesce(char_length(trim(agent_display_name)), 0) not between 1 and 100
    or char_length(coalesce(agent_description, '')) > 2000
    or char_length(coalesce(agent_system_prompt, '')) > 50000
    or agent_runtime not in ('claude-code', 'codex', 'pi')
    or coalesce(char_length(trim(agent_model)), 0) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Invalid agent configuration';
  end if;

  insert into public.agents (
    name,
    display_name,
    description,
    system_prompt,
    runtime,
    model,
    status,
    owner_id,
    server_id
  ) values (
    trim(agent_name),
    trim(agent_display_name),
    nullif(trim(agent_description), ''),
    nullif(trim(agent_system_prompt), ''),
    agent_runtime,
    trim(agent_model),
    'offline',
    requesting_user_id,
    server_uuid
  ) returning * into created_agent;

  insert into public.server_members (server_id, member_id, member_type, role)
  values (server_uuid, created_agent.id, 'agent', 'member');

  insert into public.channels (name, description, type, created_by, server_id)
  values (
    trim(agent_display_name),
    'Direct chat with ' || trim(agent_display_name),
    'dm',
    requesting_user_id,
    server_uuid
  ) returning * into created_channel;

  insert into public.channel_members (channel_id, member_id, member_type)
  values
    (created_channel.id, requesting_user_id, 'human'),
    (created_channel.id, created_agent.id, 'agent');

  return jsonb_build_object(
    'agent', to_jsonb(created_agent),
    'channel', to_jsonb(created_channel)
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create or replace function public.reset_owned_agent(agent_uuid uuid)
returns integer as $$
declare
  requesting_user_id uuid := auth.uid();
  target_server_id uuid;
  deleted_messages integer;
begin
  if requesting_user_id is null or public.teammate_is_bridge_session() then
    return -1;
  end if;

  select agent.server_id
    into target_server_id
  from public.agents agent
  join public.servers server on server.id = agent.server_id
  where agent.id = agent_uuid
    and agent.owner_id = requesting_user_id
    and (
      server.owner_id = requesting_user_id
      or exists (
        select 1
        from public.server_members member
        where member.server_id = agent.server_id
          and member.member_id = requesting_user_id
          and member.member_type = 'human'
      )
    )
  for update of agent;

  if not found then
    return -1;
  end if;

  lock table public.channel_members in share row exclusive mode;
  lock table public.messages in share row exclusive mode;

  delete from public.messages message
  using public.channels channel, public.channel_members member
  where message.channel_id = channel.id
    and member.channel_id = channel.id
    and channel.server_id = target_server_id
    and channel.type = 'dm'
    and member.member_id = agent_uuid
    and member.member_type = 'agent';
  get diagnostics deleted_messages = row_count;

  update public.agents agent
  set session_id = null,
      runtime_session_id = null,
      runtime_session_runtime = null
  where agent.id = agent_uuid
    and agent.owner_id = requesting_user_id
    and agent.server_id = target_server_id;

  return deleted_messages;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function public.enqueue_human_message_deliveries() from public;

create trigger trg_enqueue_human_message_deliveries
after insert on public.messages
for each row execute function public.enqueue_human_message_deliveries();

-- -----------------------------------------------------------
-- Tasks
-- -----------------------------------------------------------
create table public.tasks (
  id uuid default uuid_generate_v4() primary key,
  message_id uuid references public.messages(id) on delete cascade not null unique,
  channel_id uuid references public.channels(id) on delete cascade not null,
  task_number serial,
  title text not null constraint tasks_title_length
    check (char_length(title) between 1 and 500),
  description text default '' not null constraint tasks_description_length
    check (char_length(description) <= 100000),
  status text default 'todo' check (status in ('todo', 'in_progress', 'in_review', 'done')),
  parent_task_id uuid references public.tasks(id) on delete set null,
  assignee_id uuid,
  assignee_type text check (assignee_type in ('human', 'agent')),
  archived_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_tasks_channel on public.tasks(channel_id, task_number);
create index idx_tasks_parent on public.tasks(parent_task_id);
create index idx_tasks_channel_active
  on public.tasks(channel_id, status, task_number)
  where archived_at is null;

create or replace function public.validate_task_scope()
returns trigger as $$
declare
  validate_parent boolean := tg_op = 'INSERT';
  validate_assignee boolean := tg_op = 'INSERT';
begin
  if tg_op = 'UPDATE' then
    if new.channel_id is distinct from old.channel_id
      or new.message_id is distinct from old.message_id
      or new.task_number is distinct from old.task_number then
      raise exception using errcode = '23514', message = 'Task identity fields are immutable';
    end if;
    validate_parent := new.parent_task_id is distinct from old.parent_task_id;
    validate_assignee := new.assignee_id is distinct from old.assignee_id
      or new.assignee_type is distinct from old.assignee_type;
  end if;

  if tg_op = 'INSERT' and not exists (
    select 1
    from public.messages message
    where message.id = new.message_id
      and message.channel_id = new.channel_id
  ) then
    raise exception using errcode = '23514', message = 'Task message must belong to the same channel';
  end if;

  if validate_parent and new.parent_task_id is not null then
    if new.parent_task_id = new.id or not exists (
      select 1
      from public.tasks parent
      where parent.id = new.parent_task_id
        and parent.channel_id = new.channel_id
        and (new.archived_at is not null or parent.archived_at is null)
    ) then
      raise exception using
        errcode = '23514',
        message = 'Parent task must belong to the same channel and an active task cannot use an archived parent';
    end if;

    if tg_op = 'UPDATE' and exists (
      with recursive lineage(id, parent_task_id) as (
        select task.id, task.parent_task_id
        from public.tasks task
        where task.id = new.parent_task_id
        union
        select task.id, task.parent_task_id
        from public.tasks task
        join lineage ancestor on task.id = ancestor.parent_task_id
      )
      select 1 from lineage where id = new.id
    ) then
      raise exception using errcode = '23514', message = 'Task hierarchy cannot contain a cycle';
    end if;
  end if;

  if validate_assignee then
    if (new.assignee_id is null) <> (new.assignee_type is null) then
      raise exception using errcode = '23514', message = 'Task assignee id and type must be set together';
    end if;
    if new.assignee_id is not null and not exists (
      select 1
      from public.channel_members channel_member
      join public.channels channel on channel.id = channel_member.channel_id
      where channel_member.channel_id = new.channel_id
        and channel_member.member_id = new.assignee_id
        and channel_member.member_type = new.assignee_type
        and (
          (
            new.assignee_type = 'human'
            and exists (
              select 1
              from public.server_members workspace_member
              join public.profiles profile on profile.id = workspace_member.member_id
              where workspace_member.server_id = channel.server_id
                and workspace_member.member_id = new.assignee_id
                and workspace_member.member_type = 'human'
            )
          )
          or (
            new.assignee_type = 'agent'
            and exists (
              select 1
              from public.agents agent
              join public.server_members workspace_member
                on workspace_member.server_id = channel.server_id
               and workspace_member.member_id = agent.id
               and workspace_member.member_type = 'agent'
              where agent.id = new.assignee_id
                and agent.server_id = channel.server_id
            )
          )
        )
    ) then
      raise exception using errcode = '23514', message = 'Task assignee must be a valid member of the channel workspace';
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function public.validate_task_scope() from public;

create trigger trg_validate_task_scope
before insert or update on public.tasks
for each row execute function public.validate_task_scope();

-- Polymorphic assignees have no foreign key. Membership removal is the one
-- authoritative point that keeps task assignment aligned with channel access.
create or replace function public.clear_removed_channel_member_task_assignments()
returns trigger as $$
begin
  update public.tasks task
  set assignee_id = null,
      assignee_type = null,
      updated_at = now()
  where task.channel_id = old.channel_id
    and task.assignee_id = old.member_id
    and task.assignee_type = old.member_type;
  return old;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function public.clear_removed_channel_member_task_assignments() from public;

create trigger trg_clear_removed_channel_member_task_assignments
after delete on public.channel_members
for each row execute function public.clear_removed_channel_member_task_assignments();

-- Workspace membership is the parent authorization boundary for channel access
-- and runtime credentials. Removing a human must not leave either capability
-- behind to silently revive if the same profile later rejoins the workspace.
create or replace function public.clear_removed_server_human_channel_memberships()
returns trigger as $$
begin
  if old.member_type = 'human' then
    delete from public.machine_keys machine_key
    where machine_key.server_id = old.server_id
      and machine_key.user_id = old.member_id;

    delete from public.channel_members channel_member
    using public.channels channel
    where channel_member.channel_id = channel.id
      and channel.server_id = old.server_id
      and channel_member.member_id = old.member_id
      and channel_member.member_type = 'human';
  end if;
  return old;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function public.clear_removed_server_human_channel_memberships() from public;

create trigger trg_clear_removed_server_human_channel_memberships
after delete on public.server_members
for each row execute function public.clear_removed_server_human_channel_memberships();

-- -----------------------------------------------------------
-- Workspace Documents
-- -----------------------------------------------------------
create table public.documents (
  id uuid default uuid_generate_v4() primary key,
  server_id uuid references public.servers(id) on delete cascade not null,
  title text not null,
  content text default '' not null,
  created_by uuid references public.profiles(id) on delete set null,
  generated_by_agent_id uuid references public.agents(id) on delete set null,
  -- Where the document sits. Folders are not a table of their own: they are the
  -- distinct paths of the documents in them, so there is no second structure to
  -- drift out of step with the first, and a folder cannot outlive its contents.
  folder_path text default '' not null,
  -- When it was pinned, which is also the order pinned documents sit in.
  pinned_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_documents_server_updated on public.documents(server_id, updated_at desc);

-- -----------------------------------------------------------
-- Row Level Security (RLS)
-- -----------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.servers enable row level security;
alter table public.server_members enable row level security;
alter table public.agents enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.message_deliveries enable row level security;
alter table public.tasks enable row level security;
alter table public.documents enable row level security;
alter table public.machine_keys enable row level security;

create or replace function public.user_is_server_member(server_uuid uuid)
returns boolean as $$
  select public.teammate_is_human_session() and exists (
    select 1 from public.server_members
    where server_id = server_uuid
      and member_id = auth.uid()
      and member_type = 'human'
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.user_is_server_human_member(server_uuid uuid)
returns boolean as $$
  select public.teammate_is_human_session() and exists (
    select 1
    from public.server_members member
    where member.server_id = server_uuid
      and member.member_id = auth.uid()
      and member.member_type = 'human'
  );
$$ language sql security definer stable set search_path = public, pg_temp;

-- Human workspace members can discover agents without gaining SELECT access
-- to runtime credentials, prompts, sessions, or owner identity fields.
-- The document list with a short excerpt and the writing agent attached. The
-- excerpt is cut here so a list view never pulls whole documents across just
-- to render two lines of preview.
create or replace function public.list_workspace_documents(server_uuid uuid, search text default '')
returns table (
  id uuid,
  server_id uuid,
  title text,
  generated_by_agent_id uuid,
  folder_path text,
  pinned_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  excerpt text,
  content_length integer,
  generator_name text,
  generator_avatar_url text
) as $$
begin
  if not public.teammate_is_human_session() or not exists (
    select 1
    from public.server_members viewer_membership
    where viewer_membership.server_id = server_uuid
      and viewer_membership.member_id = auth.uid()
      and viewer_membership.member_type = 'human'
  ) then
    raise exception using errcode = '42501', message = 'Workspace access denied';
  end if;

  return query
  select
    document.id,
    document.server_id,
    document.title,
    document.generated_by_agent_id,
    document.folder_path,
    document.pinned_at,
    document.created_at,
    document.updated_at,
    -- When the body is what matched, show why rather than the opening line.
    case
      when search <> '' and position(lower(search) in lower(document.content)) > 0
        then substr(
          document.content,
          greatest(1, position(lower(search) in lower(document.content)) - 60),
          240
        )
      else left(document.content, 240)
    end,
    char_length(document.content),
    agent.display_name,
    agent.avatar_url
  from public.documents document
  left join public.agents agent on agent.id = document.generated_by_agent_id
  where document.server_id = server_uuid
    and (
      search = ''
      or document.title ilike '%' || search || '%'
      or document.content ilike '%' || search || '%'
    )
  order by document.updated_at desc;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function public.list_workspace_agent_directory(server_uuid uuid)
returns table (
  id uuid,
  name text,
  display_name text,
  description text,
  avatar_url text,
  status text
) as $$
begin
  if not public.teammate_is_human_session() or not exists (
    select 1
    from public.server_members viewer_membership
    where viewer_membership.server_id = server_uuid
      and viewer_membership.member_id = auth.uid()
      and viewer_membership.member_type = 'human'
  ) then
    raise exception using errcode = '42501', message = 'Workspace access denied';
  end if;

  return query
  select
    agent.id,
    agent.name,
    agent.display_name,
    agent.description,
    agent.avatar_url,
    agent.status
  from public.agents agent
  join public.server_members agent_membership
    on agent_membership.server_id = agent.server_id
   and agent_membership.member_id = agent.id
   and agent_membership.member_type = 'agent'
  where agent.server_id = server_uuid
  order by agent.created_at, agent.id;
end;
$$ language plpgsql security definer stable set search_path = public, pg_temp;

-- Member management only exposes the profile fields needed by the workspace UI.
-- Agent ownership is summarized as a count so owners can understand the impact
-- of a removal without receiving another person's private agent configuration.
create or replace function public.list_workspace_human_members(server_uuid uuid)
returns table (
  id uuid,
  display_name text,
  avatar_url text,
  role text,
  joined_at timestamptz,
  agent_count bigint,
  is_current_user boolean
) as $$
begin
  if not public.teammate_is_human_session() or not exists (
    select 1
    from public.server_members viewer_membership
    where viewer_membership.server_id = server_uuid
      and viewer_membership.member_id = auth.uid()
      and viewer_membership.member_type = 'human'
  ) then
    raise exception using errcode = '42501', message = 'Workspace access denied';
  end if;

  return query
  select
    profile.id,
    profile.display_name,
    profile.avatar_url,
    membership.role,
    membership.joined_at,
    count(agent.id)::bigint,
    profile.id = auth.uid()
  from public.server_members membership
  join public.profiles profile
    on profile.id = membership.member_id
  left join public.agents agent
    on agent.server_id = membership.server_id
   and agent.owner_id = membership.member_id
  where membership.server_id = server_uuid
    and membership.member_type = 'human'
  group by
    profile.id,
    profile.display_name,
    profile.avatar_url,
    membership.role,
    membership.joined_at
  order by
    case membership.role when 'owner' then 0 when 'admin' then 1 else 2 end,
    membership.joined_at,
    profile.id;
end;
$$ language plpgsql security definer stable set search_path = public, pg_temp;

create or replace function public.user_is_channel_member(channel_uuid uuid)
returns boolean as $$
  select public.teammate_is_human_session() and exists (
    select 1
    from public.channel_members member
    join public.channels channel on channel.id = member.channel_id
    join public.server_members workspace_member
      on workspace_member.server_id = channel.server_id
     and workspace_member.member_id = auth.uid()
     and workspace_member.member_type = 'human'
    where member.channel_id = channel_uuid
      and member.member_id = auth.uid()
      and member.member_type = 'human'
  );
$$ language sql security definer stable set search_path = public, pg_temp;

-- Bridge sessions authenticate as the agent owner. These helpers deliberately
-- bypass channel_members RLS while keeping ownership and workspace aligned.
create or replace function public.user_has_agent_in_channel(channel_uuid uuid)
returns boolean as $$
  select exists (
    select 1
    from public.channel_members member
    join public.agents agent
      on agent.id = member.member_id
     and member.member_type = 'agent'
    join public.channels channel
      on channel.id = member.channel_id
     and channel.server_id = agent.server_id
    join public.server_members agent_membership
      on agent_membership.server_id = channel.server_id
     and agent_membership.member_id = agent.id
     and agent_membership.member_type = 'agent'
    join public.servers workspace on workspace.id = channel.server_id
    where member.channel_id = channel_uuid
      and agent.owner_id = auth.uid()
      and public.teammate_bridge_session_matches_server(channel.server_id)
      and coalesce(
        (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
          ->> 'teammate_bridge') = 'true',
        false
      )
      and coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        ->> 'teammate_server_id' = channel.server_id::text
      and (
        workspace.owner_id = auth.uid()
        or exists (
          select 1
          from public.server_members owner_membership
          where owner_membership.server_id = channel.server_id
            and owner_membership.member_id = auth.uid()
            and owner_membership.member_type = 'human'
        )
      )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.user_owns_agent_in_channel(agent_uuid uuid, channel_uuid uuid)
returns boolean as $$
  select exists (
    select 1
    from public.agents agent
    join public.channel_members member
      on member.member_id = agent.id
     and member.member_type = 'agent'
    join public.channels channel
      on channel.id = member.channel_id
     and channel.server_id = agent.server_id
    join public.server_members agent_membership
      on agent_membership.server_id = channel.server_id
     and agent_membership.member_id = agent.id
     and agent_membership.member_type = 'agent'
    join public.servers workspace on workspace.id = channel.server_id
    where agent.id = agent_uuid
      and agent.owner_id = auth.uid()
      and member.channel_id = channel_uuid
      and public.teammate_bridge_session_matches_server(channel.server_id)
      and coalesce(
        (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
          ->> 'teammate_bridge') = 'true',
        false
      )
      and coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        ->> 'teammate_server_id' = channel.server_id::text
      and (
        workspace.owner_id = auth.uid()
        or exists (
          select 1
          from public.server_members owner_membership
          where owner_membership.server_id = channel.server_id
            and owner_membership.member_id = auth.uid()
            and owner_membership.member_type = 'human'
        )
      )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.user_can_manage_channel(channel_uuid uuid)
returns boolean as $$
  select not public.teammate_is_bridge_session() and exists (
    select 1
    from public.channels c
    join public.servers s on s.id = c.server_id
    where c.id = channel_uuid
      and (
        s.owner_id = auth.uid()
        or exists (
          select 1 from public.server_members sm
          where sm.server_id = c.server_id
            and sm.member_id = auth.uid()
            and sm.member_type = 'human'
            and (
              sm.role in ('owner', 'admin')
              or c.created_by = auth.uid()
            )
        )
      )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.channel_member_is_in_server(
  channel_uuid uuid,
  candidate_uuid uuid,
  candidate_type text
)
returns boolean as $$
  select exists (
    select 1
    from public.channels channel
    where channel.id = channel_uuid
      and (
        (
          candidate_type = 'human'
          and exists (
            select 1
            from public.server_members member
            join public.profiles profile on profile.id = member.member_id
            where member.server_id = channel.server_id
              and member.member_id = candidate_uuid
              and member.member_type = 'human'
          )
        )
        or (
          candidate_type = 'agent'
          and exists (
            select 1
            from public.agents agent
            join public.server_members member
              on member.server_id = channel.server_id
             and member.member_id = agent.id
             and member.member_type = 'agent'
            where agent.id = candidate_uuid
              and agent.server_id = channel.server_id
          )
        )
      )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.user_can_self_join_public_channel(
  channel_uuid uuid,
  candidate_uuid uuid,
  candidate_type text
)
returns boolean as $$
  select public.teammate_is_human_session()
    and candidate_uuid = auth.uid()
    and candidate_type = 'human'
    and exists (
      select 1
      from public.channels channel
      join public.server_members member
        on member.server_id = channel.server_id
       and member.member_id = auth.uid()
       and member.member_type = 'human'
      where channel.id = channel_uuid
        and channel.type = 'public'
    );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.user_can_self_leave_channel(
  channel_uuid uuid,
  candidate_uuid uuid,
  candidate_type text
)
returns boolean as $$
  select public.teammate_is_human_session()
    and candidate_uuid = auth.uid()
    and candidate_type = 'human'
    and exists (
      select 1
      from public.channels channel
      join public.server_members member
        on member.server_id = channel.server_id
       and member.member_id = auth.uid()
       and member.member_type = 'human'
      where channel.id = channel_uuid
        and channel.type <> 'dm'
    );
$$ language sql security definer stable set search_path = public, pg_temp;

-- Workspace, creator, and visibility are identity fields. Product edits only
-- change the channel name/description; moving a populated channel would leave
-- cross-workspace memberships behind.
create or replace function public.channel_identity_is_unchanged(
  channel_uuid uuid,
  next_server_uuid uuid,
  next_creator_uuid uuid,
  next_type text
)
returns boolean as $$
  select public.teammate_is_human_session() and exists (
    select 1
    from public.channels channel
    where channel.id = channel_uuid
      and channel.server_id = next_server_uuid
      and channel.created_by is not distinct from next_creator_uuid
      and channel.type is not distinct from next_type
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.server_member_matches_server(
  server_uuid uuid,
  candidate_uuid uuid,
  candidate_type text
)
returns boolean as $$
  select (
    candidate_type = 'human'
    and exists (
      select 1 from public.profiles profile where profile.id = candidate_uuid
    )
  ) or (
    candidate_type = 'agent'
    and exists (
      select 1
      from public.agents agent
      where agent.id = candidate_uuid
        and agent.server_id = server_uuid
    )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.user_can_register_owned_agent(
  server_uuid uuid,
  agent_uuid uuid
)
returns boolean as $$
  select public.teammate_is_human_session() and exists (
    select 1
    from public.agents agent
    join public.servers server on server.id = agent.server_id
    where agent.id = agent_uuid
      and agent.server_id = server_uuid
      and agent.owner_id = auth.uid()
      and (
        server.owner_id = auth.uid()
        or exists (
          select 1
          from public.server_members member
          where member.server_id = server_uuid
            and member.member_id = auth.uid()
            and member.member_type = 'human'
        )
      )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.user_owns_agent_in_server(
  server_uuid uuid,
  agent_uuid uuid
)
returns boolean as $$
  select exists (
    select 1
    from public.agents agent
    where agent.id = agent_uuid
      and agent.server_id = server_uuid
      and agent.owner_id = auth.uid()
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.server_human_has_no_agents(
  server_uuid uuid,
  human_uuid uuid
)
returns boolean as $$
  select not exists (
    select 1
    from public.agents agent
    where agent.server_id = server_uuid
      and agent.owner_id = human_uuid
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.user_can_create_agent_in_server(
  server_uuid uuid,
  owner_uuid uuid
)
returns boolean as $$
  select public.teammate_is_human_session()
    and owner_uuid = auth.uid()
    and exists (
      select 1
      from public.servers server
      where server.id = server_uuid
        and (
          server.owner_id = auth.uid()
          or exists (
            select 1
            from public.server_members member
            where member.server_id = server_uuid
              and member.member_id = auth.uid()
              and member.member_type = 'human'
          )
        )
    );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.agent_identity_is_unchanged(
  agent_uuid uuid,
  next_owner_uuid uuid,
  next_server_uuid uuid
)
returns boolean as $$
  select exists (
    select 1
    from public.agents agent
    where agent.id = agent_uuid
      and agent.owner_id = next_owner_uuid
      and agent.server_id = next_server_uuid
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.agent_update_is_permitted(
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
returns boolean as $$
  select exists (
    select 1
    from public.agents agent
    where agent.id = agent_uuid
      and agent.owner_id = next_owner_uuid
      and agent.server_id = next_server_uuid
      and agent.name is not distinct from next_name
      and agent.created_at is not distinct from next_created_at
      and (
        coalesce(
          (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
            ->> 'teammate_bridge') = 'true',
          false
        )
        or (
          agent.status is not distinct from next_status
          and agent.workspace_path is not distinct from next_workspace_path
          and agent.connection_id is not distinct from next_connection_id
          and (
            (
              agent.session_id is not distinct from next_session_id
              and agent.runtime_session_id is not distinct from next_runtime_session_id
              and agent.runtime_session_runtime is not distinct from next_runtime_session_runtime
            )
            or (
              next_session_id is null
              and next_runtime_session_id is null
              and next_runtime_session_runtime is null
            )
          )
        )
      )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.bridge_agent_update_is_permitted(
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
returns boolean as $$
  select public.teammate_bridge_session_matches_server(next_server_uuid)
    and exists (
      select 1
      from public.agents agent
      where agent.id = agent_uuid
        and agent.owner_id = next_owner_uuid
        and agent.server_id = next_server_uuid
        and agent.name is not distinct from next_name
        and agent.display_name is not distinct from next_display_name
        and agent.description is not distinct from next_description
        and agent.system_prompt is not distinct from next_system_prompt
        and agent.runtime is not distinct from next_runtime
        and agent.model is not distinct from next_model
        and agent.connection_id is not distinct from next_connection_id
        and agent.avatar_url is not distinct from next_avatar_url
        and agent.created_at is not distinct from next_created_at
    );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.document_identity_is_unchanged(
  document_uuid uuid,
  next_server_uuid uuid,
  next_creator_uuid uuid,
  next_generator_uuid uuid
)
returns boolean as $$
  select exists (
    select 1
    from public.documents document
    where document.id = document_uuid
      and document.server_id = next_server_uuid
      and document.created_by is not distinct from next_creator_uuid
      and document.generated_by_agent_id is not distinct from next_generator_uuid
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.machine_key_identity_is_unchanged(
  machine_key_uuid uuid,
  next_user_uuid uuid,
  next_server_uuid uuid,
  next_key_prefix text,
  next_key_hash text,
  next_key_value text
)
returns boolean as $$
  select exists (
    select 1
    from public.machine_keys machine_key
    where machine_key.id = machine_key_uuid
      and machine_key.user_id = next_user_uuid
      and machine_key.server_id = next_server_uuid
      and machine_key.key_prefix = next_key_prefix
      and machine_key.key_hash = next_key_hash
      and machine_key.key_value is not distinct from next_key_value
  );
$$ language sql security definer stable set search_path = public, pg_temp;

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
  if assignee_type = 'agent'
    and coalesce(char_length(trim(assignee_mention_name)), 0) not between 1 and 100 then
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
  if assignee_type = 'agent'
    and coalesce(char_length(trim(assignee_mention_name)), 0) not between 1 and 100 then
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
create or replace function public.update_task_status(
  task_uuid uuid,
  task_status text,
  sender_agent_uuid uuid,
  expected_updated_at timestamptz
)
returns jsonb as $$
declare
  target_task public.tasks%rowtype;
  target_channel_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if task_status not in ('todo', 'in_progress', 'in_review', 'done')
    or expected_updated_at is null then
    raise exception using errcode = '22023', message = 'Invalid task status update';
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
    raise exception using errcode = '23514', message = 'Archived tasks cannot change status';
  end if;

  update public.tasks task
  set status = task_status,
      updated_at = now()
  where task.id = target_task.id
  returning * into target_task;
  return jsonb_build_object('task', to_jsonb(target_task));
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create or replace function public.claim_task(
  task_uuid uuid,
  sender_agent_uuid uuid,
  expected_updated_at timestamptz
)
returns jsonb as $$
declare
  target_task public.tasks%rowtype;
  target_channel_id uuid;
begin
  if auth.uid() is null or sender_agent_uuid is null or expected_updated_at is null then
    raise exception using errcode = '42501', message = 'Agent authentication required';
  end if;
  select task.channel_id into target_channel_id
  from public.tasks task
  where task.id = task_uuid;
  if not found or not public.lock_channel_member_for_task(
    target_channel_id,
    sender_agent_uuid,
    'agent',
    true
  ) then
    raise exception using errcode = 'P0002', message = 'Task not found';
  end if;
  select task.* into target_task
  from public.tasks task
  join public.channels channel on channel.id = task.channel_id
  where task.id = task_uuid
    and public.user_owns_agent_in_channel(sender_agent_uuid, task.channel_id)
  for update of task, channel;
  if not found then
    raise exception using errcode = 'P0002', message = 'Task not found';
  end if;
  if target_task.updated_at is distinct from expected_updated_at
    or target_task.archived_at is not null
    or target_task.status = 'done'
    or (
      target_task.assignee_id is not null
      and (
        target_task.assignee_id is distinct from sender_agent_uuid
        or target_task.assignee_type is distinct from 'agent'
      )
    ) then
    raise exception using errcode = '40001', message = 'Task changed or was claimed; refresh and retry';
  end if;

  update public.tasks task
  set assignee_id = sender_agent_uuid,
      assignee_type = 'agent',
      status = 'in_progress',
      updated_at = now()
  where task.id = target_task.id
  returning * into target_task;
  return jsonb_build_object('task', to_jsonb(target_task));
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create or replace function public.unclaim_task(
  task_uuid uuid,
  sender_agent_uuid uuid,
  expected_updated_at timestamptz
)
returns jsonb as $$
declare
  target_task public.tasks%rowtype;
  target_channel_id uuid;
begin
  if auth.uid() is null or sender_agent_uuid is null or expected_updated_at is null then
    raise exception using errcode = '42501', message = 'Agent authentication required';
  end if;
  select task.channel_id into target_channel_id
  from public.tasks task
  where task.id = task_uuid;
  if not found or not public.lock_channel_member_for_task(
    target_channel_id,
    sender_agent_uuid,
    'agent',
    true
  ) then
    raise exception using errcode = 'P0002', message = 'Task not found';
  end if;
  select task.* into target_task
  from public.tasks task
  join public.channels channel on channel.id = task.channel_id
  where task.id = task_uuid
    and public.user_owns_agent_in_channel(sender_agent_uuid, task.channel_id)
  for update of task, channel;
  if not found then
    raise exception using errcode = 'P0002', message = 'Task not found';
  end if;
  if target_task.updated_at is distinct from expected_updated_at
    or target_task.archived_at is not null
    or target_task.assignee_id is distinct from sender_agent_uuid
    or target_task.assignee_type is distinct from 'agent' then
    raise exception using errcode = '40001', message = 'Task assignment changed; refresh and retry';
  end if;

  update public.tasks task
  set assignee_id = null,
      assignee_type = null,
      updated_at = now()
  where task.id = target_task.id
  returning * into target_task;
  return jsonb_build_object('task', to_jsonb(target_task));
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create or replace function public.delete_owned_agent(agent_uuid uuid)
returns boolean as $$
declare
  requesting_user_id uuid := auth.uid();
  target_server_id uuid;
  deleted_agents integer;
begin
  if requesting_user_id is null or public.teammate_is_bridge_session() then
    return false;
  end if;

  select agent.server_id
    into target_server_id
  from public.agents agent
  join public.servers server on server.id = agent.server_id
  where agent.id = agent_uuid
    and agent.owner_id = requesting_user_id
    and (
      server.owner_id = requesting_user_id
      or exists (
        select 1
        from public.server_members member
        where member.server_id = agent.server_id
          and member.member_id = requesting_user_id
          and member.member_type = 'human'
      )
    )
  for update of agent;

  if not found then
    return false;
  end if;

  -- Prevent a concurrent invite from committing a polymorphic membership
  -- after the final cleanup has scanned channel_members.
  lock table public.channel_members in share row exclusive mode;

  delete from public.channels channel
  using public.channel_members member
  where channel.id = member.channel_id
    and channel.server_id = target_server_id
    and channel.type = 'dm'
    and member.member_id = agent_uuid
    and member.member_type = 'agent';

  delete from public.channel_members member
  where member.member_id = agent_uuid
    and member.member_type = 'agent';

  delete from public.server_members member
  where member.server_id = target_server_id
    and member.member_id = agent_uuid
    and member.member_type = 'agent';

  update public.tasks task
  set assignee_id = null,
      assignee_type = null,
      updated_at = now()
  from public.channels channel
  where task.channel_id = channel.id
    and channel.server_id = target_server_id
    and task.assignee_id = agent_uuid
    and task.assignee_type = 'agent';

  delete from public.agents agent
  where agent.id = agent_uuid
    and agent.owner_id = requesting_user_id
    and agent.server_id = target_server_id;
  get diagnostics deleted_agents = row_count;

  if deleted_agents <> 1 then
    raise exception 'Agent teardown lost its locked target';
  end if;

  return true;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- Workspace owners need one authoritative teardown path for people who still
-- own agents or runtime keys. Direct server_members deletes cannot safely
-- express these polymorphic relationships, so the whole eviction is kept in a
-- SECURITY DEFINER transaction and scoped to exactly one workspace.
create or replace function public.remove_server_human_member(
  server_uuid uuid,
  human_uuid uuid
)
returns jsonb as $$
declare
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
begin
  if requesting_user_id is null or public.teammate_is_bridge_session() then
    raise exception using errcode = '42501', message = 'Human authentication required';
  end if;
  if server_uuid is null or human_uuid is null then
    raise exception using errcode = '22023', message = 'Workspace and member are required';
  end if;

  select server.owner_id
    into workspace_owner_id
  from public.servers server
  where server.id = server_uuid
  for update;

  if not found or workspace_owner_id <> requesting_user_id then
    raise exception using errcode = '42501', message = 'Only the workspace owner can remove members';
  end if;
  if human_uuid = workspace_owner_id then
    raise exception using errcode = '22023', message = 'The workspace owner cannot be removed';
  end if;

  -- RLS policies on agent/key/channel creation read server_members. PostgreSQL
  -- documents an ACCESS EXCLUSIVE lock as the safe way to prevent those policy
  -- checks from observing a stale membership snapshot during a rare security
  -- boundary update. It also waits for earlier writers before cleanup starts.
  lock table public.server_members in access exclusive mode;

  -- Provisioning also locks this row FOR KEY SHARE before creating an agent.
  perform 1
  from public.server_members target_membership
  where target_membership.server_id = server_uuid
    and target_membership.member_id = human_uuid
    and target_membership.member_type = 'human'
  for update;

  perform 1
  from public.agents agent
  where agent.server_id = server_uuid
    and agent.owner_id = human_uuid
  for update;

  select coalesce(array_agg(agent.id order by agent.id), '{}'::uuid[])
    into target_agent_ids
  from public.agents agent
  where agent.server_id = server_uuid
    and agent.owner_id = human_uuid;

  select coalesce(array_agg(channel.id order by channel.id), '{}'::uuid[])
    into target_dm_ids
  from public.channels channel
  where channel.server_id = server_uuid
    and channel.type = 'dm'
    and exists (
      select 1
      from public.channel_members member
      where member.channel_id = channel.id
        and (
          (member.member_id = human_uuid and member.member_type = 'human')
          or (
            member.member_type = 'agent'
            and member.member_id = any(target_agent_ids)
          )
        )
    );

  delete from public.message_deliveries delivery
  where delivery.server_id = server_uuid
    and delivery.agent_id = any(target_agent_ids);
  get diagnostics removed_deliveries = row_count;

  delete from public.channels channel
  where channel.server_id = server_uuid
    and channel.id = any(target_dm_ids);
  get diagnostics removed_dm_channels = row_count;

  update public.tasks task
  set assignee_id = null,
      assignee_type = null,
      updated_at = now()
  from public.channels channel
  where task.channel_id = channel.id
    and channel.server_id = server_uuid
    and (
      (task.assignee_id = human_uuid and task.assignee_type = 'human')
      or (
        task.assignee_type = 'agent'
        and task.assignee_id = any(target_agent_ids)
      )
    );
  get diagnostics cleared_task_assignments = row_count;

  delete from public.channel_members member
  using public.channels channel
  where member.channel_id = channel.id
    and channel.server_id = server_uuid
    and (
      (member.member_id = human_uuid and member.member_type = 'human')
      or (
        member.member_type = 'agent'
        and member.member_id = any(target_agent_ids)
      )
    );

  delete from public.server_members member
  where member.server_id = server_uuid
    and member.member_type = 'agent'
    and member.member_id = any(target_agent_ids);

  update public.documents document
  set generated_by_agent_id = null,
      updated_at = now()
  where document.server_id = server_uuid
    and document.generated_by_agent_id = any(target_agent_ids);

  delete from public.machine_keys machine_key
  where machine_key.server_id = server_uuid
    and machine_key.user_id = human_uuid;
  get diagnostics revoked_machine_keys = row_count;

  delete from public.agents agent
  where agent.server_id = server_uuid
    and agent.owner_id = human_uuid;
  get diagnostics removed_agents = row_count;

  delete from public.server_members member
  where member.server_id = server_uuid
    and member.member_id = human_uuid
    and member.member_type = 'human';
  get diagnostics removed_human_membership = row_count;

  return jsonb_build_object(
    'removed', removed_human_membership = 1,
    'agents_removed', removed_agents,
    'machine_keys_revoked', revoked_machine_keys,
    'dm_channels_removed', removed_dm_channels,
    'task_assignments_cleared', cleared_task_assignments,
    'deliveries_removed', removed_deliveries
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function public.user_is_server_member(uuid) from public;
revoke all on function public.teammate_is_bridge_session() from public;
revoke all on function public.teammate_is_human_session() from public;
revoke all on function public.teammate_bridge_session_matches_server(uuid) from public;
revoke all on function public.touch_current_bridge_machine_key() from public;
revoke all on function public.user_is_server_human_member(uuid) from public;
revoke all on function public.list_workspace_agent_directory(uuid) from public;
revoke all on function public.list_workspace_documents(uuid, text) from public;
revoke all on function public.list_workspace_human_members(uuid) from public;
revoke all on function public.user_is_channel_member(uuid) from public;
revoke all on function public.user_has_agent_in_channel(uuid) from public;
revoke all on function public.user_owns_agent_in_channel(uuid, uuid) from public;
revoke all on function public.user_can_manage_channel(uuid) from public;
revoke all on function public.channel_member_is_in_server(uuid, uuid, text) from public;
revoke all on function public.user_can_self_join_public_channel(uuid, uuid, text) from public;
revoke all on function public.user_can_self_leave_channel(uuid, uuid, text) from public;
revoke all on function public.channel_identity_is_unchanged(uuid, uuid, uuid, text) from public;
revoke all on function public.server_member_matches_server(uuid, uuid, text) from public;
revoke all on function public.user_can_register_owned_agent(uuid, uuid) from public;
revoke all on function public.user_owns_agent_in_server(uuid, uuid) from public;
revoke all on function public.server_human_has_no_agents(uuid, uuid) from public;
revoke all on function public.remove_server_human_member(uuid, uuid) from public;
revoke all on function public.user_can_create_agent_in_server(uuid, uuid) from public;
revoke all on function public.agent_identity_is_unchanged(uuid, uuid, uuid) from public;
revoke all on function public.agent_update_is_permitted(uuid, uuid, uuid, text, text, text, text, text, text, text, timestamptz) from public;
revoke all on function public.bridge_agent_update_is_permitted(uuid, uuid, uuid, text, text, text, text, text, text, text, text, timestamptz) from public;
revoke all on function public.document_identity_is_unchanged(uuid, uuid, uuid, uuid) from public;
revoke all on function public.machine_key_identity_is_unchanged(uuid, uuid, uuid, text, text, text) from public;
revoke all on function public.user_can_view_profile(uuid) from public;
revoke all on function public.list_channel_agent_mentions(uuid) from public;
revoke all on function public.create_channel_with_members(uuid, text, text, text, jsonb) from public;
revoke all on function public.set_channel_agent_members(uuid, uuid[], text, text, uuid[], text, text) from public;
revoke all on function public.create_task_with_message(uuid, text, uuid, uuid, text, text, uuid) from public;
revoke all on function public.assign_task_with_notification(uuid, uuid, text, text, uuid, timestamptz) from public;
revoke all on function public.update_task_status(uuid, text, uuid, timestamptz) from public;
revoke all on function public.claim_task(uuid, uuid, timestamptz) from public;
revoke all on function public.unclaim_task(uuid, uuid, timestamptz) from public;
revoke all on function public.delete_owned_agent(uuid) from public;
revoke all on function public.create_owned_server(text, text, text, text, text, text, text) from public;
revoke all on function public.create_current_user_machine_key(uuid, text, text, text) from public;
revoke all on function public.create_owned_agent_with_dm(uuid, text, text, text, text, text, text) from public;
revoke all on function public.reset_owned_agent(uuid) from public;
grant execute on function public.user_is_server_member(uuid) to authenticated;
grant execute on function public.teammate_is_bridge_session() to authenticated;
grant execute on function public.teammate_is_human_session() to authenticated;
grant execute on function public.teammate_bridge_session_matches_server(uuid) to authenticated;
grant execute on function public.touch_current_bridge_machine_key() to authenticated;
grant execute on function public.user_is_server_human_member(uuid) to authenticated;
grant execute on function public.list_workspace_agent_directory(uuid) to authenticated;
grant execute on function public.list_workspace_documents(uuid, text) to authenticated;
grant execute on function public.user_is_channel_member(uuid) to authenticated;
grant execute on function public.user_has_agent_in_channel(uuid) to authenticated;
grant execute on function public.user_owns_agent_in_channel(uuid, uuid) to authenticated;
grant execute on function public.user_can_manage_channel(uuid) to authenticated;
grant execute on function public.channel_member_is_in_server(uuid, uuid, text) to authenticated;
grant execute on function public.user_can_self_join_public_channel(uuid, uuid, text) to authenticated;
grant execute on function public.user_can_self_leave_channel(uuid, uuid, text) to authenticated;
grant execute on function public.channel_identity_is_unchanged(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.server_member_matches_server(uuid, uuid, text) to authenticated;
grant execute on function public.user_can_register_owned_agent(uuid, uuid) to authenticated;
grant execute on function public.user_owns_agent_in_server(uuid, uuid) to authenticated;
grant execute on function public.server_human_has_no_agents(uuid, uuid) to authenticated;
grant execute on function public.user_can_create_agent_in_server(uuid, uuid) to authenticated;
grant execute on function public.agent_identity_is_unchanged(uuid, uuid, uuid) to authenticated;
grant execute on function public.agent_update_is_permitted(uuid, uuid, uuid, text, text, text, text, text, text, text, timestamptz) to authenticated;
grant execute on function public.bridge_agent_update_is_permitted(uuid, uuid, uuid, text, text, text, text, text, text, text, text, timestamptz) to authenticated;
grant execute on function public.document_identity_is_unchanged(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.machine_key_identity_is_unchanged(uuid, uuid, uuid, text, text, text) to authenticated;
grant execute on function public.user_can_view_profile(uuid) to authenticated;
grant execute on function public.list_channel_agent_mentions(uuid) to authenticated;
grant execute on function public.create_channel_with_members(uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.set_channel_agent_members(uuid, uuid[], text, text, uuid[], text, text) to authenticated;
grant execute on function public.create_task_with_message(uuid, text, uuid, uuid, text, text, uuid) to authenticated;
grant execute on function public.assign_task_with_notification(uuid, uuid, text, text, uuid, timestamptz) to authenticated;
grant execute on function public.update_task_status(uuid, text, uuid, timestamptz) to authenticated;
grant execute on function public.claim_task(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.unclaim_task(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.delete_owned_agent(uuid) to authenticated;
grant execute on function public.create_owned_server(text, text, text, text, text, text, text) to authenticated;
grant execute on function public.create_current_user_machine_key(uuid, text, text, text) to authenticated;
grant execute on function public.create_owned_agent_with_dm(uuid, text, text, text, text, text, text) to authenticated;
grant execute on function public.reset_owned_agent(uuid) to authenticated;

-- Realtime authorization helpers reuse the role discriminator defined before
-- every human/Bridge RPC above.
create or replace function public.teammate_user_can_access_server(server_uuid uuid)
returns boolean as $$
  select exists (
    select 1
    from public.servers server
    where server.id = server_uuid
      and (
        server.owner_id = auth.uid()
        or exists (
          select 1
          from public.server_members member
          where member.server_id = server.id
            and member.member_id = auth.uid()
            and member.member_type = 'human'
        )
      )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

create or replace function public.teammate_bridge_can_access_server(
  server_uuid uuid,
  owner_uuid uuid
)
returns boolean as $$
  with claims as (
    select coalesce(
      nullif(current_setting('request.jwt.claims', true), ''),
      '{}'
    )::jsonb as value
  )
  select exists (
    select 1
    from claims
    join public.machine_keys machine_key
      on machine_key.id::text = claims.value ->> 'teammate_machine_key_id'
     and machine_key.user_id = owner_uuid
     and machine_key.server_id = server_uuid
    join public.servers server on server.id = server_uuid
    where auth.uid() = owner_uuid
      and claims.value ->> 'teammate_bridge' = 'true'
      and claims.value ->> 'teammate_server_id' = server_uuid::text
      and (
        server.owner_id = owner_uuid
        or exists (
          select 1
          from public.server_members member
          where member.server_id = server_uuid
            and member.member_id = owner_uuid
            and member.member_type = 'human'
        )
      )
  );
$$ language sql security definer stable set search_path = public, pg_temp;

revoke all on function public.teammate_is_bridge_session() from public;
revoke all on function public.teammate_user_can_access_server(uuid) from public;
revoke all on function public.teammate_bridge_can_access_server(uuid, uuid) from public;
grant execute on function public.teammate_is_bridge_session() to authenticated;
grant execute on function public.teammate_user_can_access_server(uuid) to authenticated;
grant execute on function public.teammate_bridge_can_access_server(uuid, uuid) to authenticated;
grant execute on function public.list_workspace_human_members(uuid) to authenticated;
grant execute on function public.remove_server_human_member(uuid, uuid) to authenticated;

-- Workspaces: members can view; owners manage metadata and membership.
create policy "Users can view their servers" on public.servers for select using (
  (public.teammate_is_human_session() and owner_id = auth.uid())
  or public.user_is_server_member(id)
  or public.teammate_bridge_session_matches_server(id)
);
create policy "Owner can update server" on public.servers for update using (
  public.teammate_is_human_session() and owner_id = auth.uid()
) with check (
  public.teammate_is_human_session() and owner_id = auth.uid()
);
create policy "Owner can delete server" on public.servers for delete using (
  public.teammate_is_human_session() and owner_id = auth.uid()
);
create policy "Members can view server members" on public.server_members for select using (
  public.user_is_server_member(server_id)
);
create policy "Users can join servers" on public.server_members for insert with check (
  public.teammate_is_human_session()
  and public.server_member_matches_server(server_id, member_id, member_type)
  and (
    auth.uid() = (select owner_id from public.servers where id = server_id)
    or (
      member_type = 'agent'
      and public.user_can_register_owned_agent(server_id, member_id)
    )
  )
);
create policy "Users can leave servers" on public.server_members for delete using (
  public.teammate_is_human_session()
  and member_id = auth.uid()
  and member_type = 'human'
  and auth.uid() <> (select owner_id from public.servers where id = server_id)
  and public.server_human_has_no_agents(server_id, member_id)
);

-- Profiles: self and human teammates in a shared workspace are visible.
create policy "Workspace members can view profiles" on public.profiles for select using (
  public.user_can_view_profile(id)
);
create policy "Users can update own profile" on public.profiles for update
  using (public.teammate_is_human_session() and auth.uid() = id)
  with check (public.teammate_is_human_session() and auth.uid() = id);

-- Full agent rows remain private to their owner. Human workspace members use
-- list_workspace_agent_directory() for the deliberately limited shared view.
create policy "Workspace members can view agents" on public.agents for select using (
  owner_id = auth.uid()
  and (
    public.teammate_is_human_session()
    or public.teammate_bridge_session_matches_server(server_id)
  )
);
create policy "Owners can update own agents" on public.agents for update
  using (
    auth.uid() = owner_id
    and (
      public.teammate_is_human_session()
      or public.teammate_bridge_session_matches_server(server_id)
    )
  )
  with check (
    auth.uid() = owner_id
    and (
      (
        public.teammate_is_human_session()
        and public.agent_update_is_permitted(
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
      or public.bridge_agent_update_is_permitted(
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

-- Channels: members can read, creator can manage
create policy "Channel members can view channels" on public.channels for select using (
  (type = 'public' and public.user_is_server_human_member(server_id)) or
  (created_by = auth.uid() and public.user_is_server_human_member(server_id)) or
  public.user_is_channel_member(id) or
  public.user_has_agent_in_channel(id)
);
-- Multi-row channel creation is available only through
-- create_channel_with_members(), so a channel cannot exist without its creator.
create policy "Users can delete channels" on public.channels for delete
  using (
    not public.teammate_is_bridge_session()
    and public.user_can_manage_channel(id)
  );

-- Channel members: members can view
create policy "Members can view channel membership" on public.channel_members for select using (
  public.user_is_channel_member(channel_id)
  or public.user_has_agent_in_channel(channel_id)
);
create policy "Users can add channel members" on public.channel_members for insert with check (
  public.channel_member_is_in_server(channel_id, member_id, member_type)
  and public.user_can_self_join_public_channel(channel_id, member_id, member_type)
);
create policy "Users can remove channel members" on public.channel_members for delete using (
  public.user_can_self_leave_channel(channel_id, member_id, member_type)
);

-- Messages: channel members can read and write
create policy "Channel members can view messages" on public.messages for select using (
  public.user_is_channel_member(channel_id)
  or public.user_has_agent_in_channel(channel_id)
);
create policy "Channel members can send messages" on public.messages for insert with check (
  (
    auth.uid() = sender_id
    and sender_type = 'human'
    and not public.teammate_is_bridge_session()
    and public.user_is_channel_member(channel_id)
  )
  or (
    sender_type = 'agent'
    and public.user_owns_agent_in_channel(sender_id, channel_id)
  )
);

-- Reactions inherit the message's channel: you can see and add one wherever
-- you could have replied, and you can only take back your own.
-- Authors can rewrite or retract what they said, and nothing else.
create policy "Authors can edit their own messages" on public.messages for update using (
  (sender_type = 'human' and auth.uid() = sender_id)
  or (sender_type = 'agent' and public.user_owns_agent_in_channel(sender_id, channel_id))
);
create policy "Authors can delete their own messages" on public.messages for delete using (
  (sender_type = 'human' and auth.uid() = sender_id)
  or (sender_type = 'agent' and public.user_owns_agent_in_channel(sender_id, channel_id))
);

create policy "Channel members can view reactions" on public.message_reactions for select using (
  exists (
    select 1 from public.messages message
    where message.id = message_id
      and (
        public.user_is_channel_member(message.channel_id)
        or public.user_has_agent_in_channel(message.channel_id)
      )
  )
);
create policy "Channel members can add reactions" on public.message_reactions for insert with check (
  exists (
    select 1 from public.messages message
    where message.id = message_id
      and (
        (
          auth.uid() = actor_id
          and actor_type = 'human'
          and public.user_is_channel_member(message.channel_id)
        )
        or (
          actor_type = 'agent'
          and public.user_owns_agent_in_channel(actor_id, message.channel_id)
        )
      )
  )
);
create policy "Actors can remove their own reactions" on public.message_reactions for delete using (
  (actor_type = 'human' and auth.uid() = actor_id)
  or (
    actor_type = 'agent'
    and exists (
      select 1 from public.messages message
      where message.id = message_id
        and public.user_owns_agent_in_channel(actor_id, message.channel_id)
    )
  )
);

-- A Bridge authenticates as the human who owns the target agent. It can only
-- read and advance deliveries for that agent inside the same workspace.
create policy "Agent owners can view message deliveries"
  on public.message_deliveries for select using (
    public.teammate_bridge_session_matches_server(server_id)
    and public.user_owns_agent_in_server(server_id, agent_id)
  );
create policy "Agent owners can update message deliveries"
  on public.message_deliveries for update using (
    public.teammate_bridge_session_matches_server(server_id)
    and public.user_owns_agent_in_server(server_id, agent_id)
  ) with check (
    public.teammate_bridge_session_matches_server(server_id)
    and public.user_owns_agent_in_server(server_id, agent_id)
  );

-- Tasks: same as messages
create policy "Channel members can view tasks" on public.tasks for select using (
  public.user_is_channel_member(channel_id)
  or public.user_has_agent_in_channel(channel_id)
);
-- Task writes are intentionally unavailable as direct table mutations. The
-- actor-scoped RPCs preserve the source message, hierarchy and CAS rules.

-- Documents: workspace members share durable context
create policy "Server members can view documents" on public.documents for select using (
  public.user_can_create_agent_in_server(server_id, auth.uid())
  or public.teammate_bridge_session_matches_server(server_id)
);
create policy "Server members can create documents" on public.documents for insert with check (
  auth.uid() = created_by and (
    public.user_can_create_agent_in_server(server_id, auth.uid())
    or (
      public.teammate_bridge_session_matches_server(server_id)
      and generated_by_agent_id is not null
      and public.user_owns_agent_in_server(server_id, generated_by_agent_id)
    )
  ) and
  (
    generated_by_agent_id is null or exists (
      select 1
      from public.agents agent
      join public.server_members member
        on member.server_id = documents.server_id
       and member.member_id = agent.id
       and member.member_type = 'agent'
      where agent.id = documents.generated_by_agent_id
        and agent.server_id = documents.server_id
        and agent.owner_id = documents.created_by
    )
  )
);
create policy "Server members can update documents" on public.documents for update using (
  public.user_can_create_agent_in_server(server_id, auth.uid())
  or public.teammate_bridge_session_matches_server(server_id)
) with check (
  (
    public.user_can_create_agent_in_server(server_id, auth.uid())
    or public.teammate_bridge_session_matches_server(server_id)
  )
  and public.document_identity_is_unchanged(
    id,
    server_id,
    created_by,
    generated_by_agent_id
  )
);
create policy "Server members can delete documents" on public.documents for delete using (
  public.user_can_create_agent_in_server(server_id, auth.uid())
);

create policy "Users can view own keys" on public.machine_keys for select using (
  public.teammate_is_human_session() and auth.uid() = user_id
);
-- Key creation must use create_current_user_machine_key so membership
-- validation and insertion share one transaction and lock order.
create policy "Users can update own keys" on public.machine_keys for update
  using (public.teammate_is_human_session() and auth.uid() = user_id)
  with check (
    public.teammate_is_human_session()
    and auth.uid() = user_id
    and public.machine_key_identity_is_unchanged(
      id,
      user_id,
      server_id,
      key_prefix,
      key_hash,
      key_value
    )
  );
create policy "Users can delete own keys" on public.machine_keys for delete using (
  public.teammate_is_human_session() and auth.uid() = user_id
);

-- -----------------------------------------------------------
-- Realtime
-- -----------------------------------------------------------
-- Teammate Broadcast channels are private. Permissions are calculated per
-- topic and operation by Supabase Realtime and cached for the connection.
drop policy if exists "Teammate activity subscribers" on realtime.messages;
drop policy if exists "Teammate activity publishers" on realtime.messages;
drop policy if exists "Teammate RPC request subscribers" on realtime.messages;
drop policy if exists "Teammate RPC request publishers" on realtime.messages;
drop policy if exists "Teammate RPC response subscribers" on realtime.messages;
drop policy if exists "Teammate RPC response publishers" on realtime.messages;

create policy "Teammate activity subscribers"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and case
      when (select realtime.topic()) ~ '^agent-activity:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then not public.teammate_is_bridge_session()
        and public.teammate_user_can_access_server(
          split_part((select realtime.topic()), ':', 2)::uuid
        )
      else false
    end
  );

create policy "Teammate activity publishers"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and case
      when (select realtime.topic()) ~ '^agent-activity:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.teammate_bridge_can_access_server(
        split_part((select realtime.topic()), ':', 2)::uuid,
        auth.uid()
      )
      else false
    end
  );

create policy "Teammate RPC request subscribers"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and case
      when (select realtime.topic()) ~ '^bridge-rpc-request:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.teammate_bridge_can_access_server(
        split_part((select realtime.topic()), ':', 2)::uuid,
        split_part((select realtime.topic()), ':', 3)::uuid
      )
      else false
    end
  );

create policy "Teammate RPC request publishers"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and case
      when (select realtime.topic()) ~ '^bridge-rpc-request:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then not public.teammate_is_bridge_session()
        and auth.uid() = split_part((select realtime.topic()), ':', 3)::uuid
        and public.teammate_user_can_access_server(
          split_part((select realtime.topic()), ':', 2)::uuid
        )
      else false
    end
  );

create policy "Teammate RPC response subscribers"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and case
      when (select realtime.topic()) ~ '^bridge-rpc-response:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then not public.teammate_is_bridge_session()
        and auth.uid() = split_part((select realtime.topic()), ':', 3)::uuid
        and public.teammate_user_can_access_server(
          split_part((select realtime.topic()), ':', 2)::uuid
        )
      else false
    end
  );

create policy "Teammate RPC response publishers"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and case
      when (select realtime.topic()) ~ '^bridge-rpc-response:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.teammate_bridge_can_access_server(
        split_part((select realtime.topic()), ':', 2)::uuid,
        split_part((select realtime.topic()), ':', 3)::uuid
      )
      else false
    end
  );

-- Enable realtime for shared workspace activity.
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.message_deliveries;
alter publication supabase_realtime add table public.agents;
alter publication supabase_realtime add table public.channel_members;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.documents;
alter publication supabase_realtime add table public.channels;
alter publication supabase_realtime add table public.server_members;
alter publication supabase_realtime add table public.profiles;

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
