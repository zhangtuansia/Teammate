-- Auto-create Onboarding Agent + Channel when a new profile is created
CREATE OR REPLACE FUNCTION public.handle_new_profile()
RETURNS trigger AS $func$
DECLARE
  agent_id uuid;
  onboarding_channel_id uuid;
  dm_channel_id uuid;
BEGIN
  agent_id := uuid_generate_v4();
  onboarding_channel_id := uuid_generate_v4();
  dm_channel_id := uuid_generate_v4();

  -- Create Onboarding Agent
  INSERT INTO public.agents (id, name, display_name, description, system_prompt, status, owner_id, is_default)
  VALUES (
    agent_id,
    'onboarding-' || substr(new.id::text, 1, 8),
    'Onboarding Assistant',
    'Your guide to setting up Zano',
    E'You are the Onboarding Assistant for Zano — a collaborative platform where humans work with AI agents.\n\nYour job is to onboard the user step by step. Follow these goals (soft guidance, do not force):\n1. First, ask what language they prefer. Then use that language for the rest of the conversation.\n2. Help them understand what Zano is and get comfortable using it.\n3. Learn about their work, goals, and what they need help with.\n4. Guide them to create an initial team of AI agents (target: at least 2-3 agents) tailored to their needs.\n5. Help them create useful channels for organizing their work.\n\nRules:\n- Keep it simple and conversational. One actionable next step at a time.\n- No info dumps, no checklist-style interrogation.\n- Ask thoughtful questions to understand what kind of agents would be most useful.\n- When you have enough context, suggest specific agent configurations (name, role, description).\n- Be warm, proactive, and helpful.',
    'active',
    new.id,
    true
  );

  -- Create #onboarding channel
  INSERT INTO public.channels (id, name, description, type, created_by)
  VALUES (
    onboarding_channel_id,
    'onboarding-' || substr(new.display_name, 1, 20),
    'Your onboarding workspace',
    'public',
    new.id
  );

  -- Add user and agent to onboarding channel
  INSERT INTO public.channel_members (channel_id, member_id, member_type)
  VALUES (onboarding_channel_id, new.id, 'human');
  INSERT INTO public.channel_members (channel_id, member_id, member_type)
  VALUES (onboarding_channel_id, agent_id, 'agent');

  -- Also create a DM channel for direct chat with the Onboarding Agent
  INSERT INTO public.channels (id, name, description, type, created_by)
  VALUES (
    dm_channel_id,
    'Onboarding Assistant',
    'Direct chat with your onboarding guide',
    'dm',
    new.id
  );
  INSERT INTO public.channel_members (channel_id, member_id, member_type)
  VALUES (dm_channel_id, new.id, 'human');
  INSERT INTO public.channel_members (channel_id, member_id, member_type)
  VALUES (dm_channel_id, agent_id, 'agent');

  -- System-triggered onboarding task message in the channel
  INSERT INTO public.messages (channel_id, sender_id, sender_type, content)
  VALUES (
    onboarding_channel_id,
    agent_id,
    'system',
    'Onboarding task (system-triggered): Please proactively onboard @' || new.display_name || ' in this channel. Default language is English; first ask what language they prefer.'
  );

  -- Onboarding Agent welcome message
  INSERT INTO public.messages (channel_id, sender_id, sender_type, content)
  VALUES (
    onboarding_channel_id,
    agent_id,
    'agent',
    E'Hey @' || new.display_name || E', welcome to Zano!\n\nI''m your Onboarding Assistant — I''ll help you get set up here.\n\nBefore we dive in, do you have a preferred language? I''m happy to chat in English, Chinese, or whatever works best for you.'
  );

  RETURN new;
END;
$func$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_profile_created ON public.profiles;
CREATE TRIGGER on_profile_created
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_profile();
