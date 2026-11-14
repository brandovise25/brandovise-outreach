-- migrate:up
-- Better prospect search (Jibran, 13.11.2026):
--  1. every active campaign gets its own search word in each round (e-commerce was crowded out);
--  2. withdrawals of old invites reach the Approve tab (never auto-approved), at most 12 a day;
--  3. twelve e-commerce keyword sets (title x shop type), all "stage only": found people wait in Leads.
create or replace function public.ext_prospect_plan(p_user_id uuid)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  lim jsonb := outreach.limits();
  alert timestamptz := nullif(outreach.ext_setting('linkedin_limit_alert') #>> '{}', '')::timestamptz;
  waiting int;
  mode text := 'approve';
  why text := null;
  max_approve int;
  kw jsonb;
  run_id bigint;
begin
  perform outreach.ext_assert_user(p_user_id);
  select count(*) into waiting from outreach.prospects where stage in ('approved', 'visited');
  if lim->>'invite_status' in ('linkedin_warning', 'paused_until', 'robot_paused') then
    mode := 'stage'; why := 'invites are ' || (lim->>'invite_status');
  elsif alert is not null and alert > now() - interval '7 days' then
    mode := 'stage'; why := 'LinkedIn limit alert in the last 7 days';
  elsif waiting > 75 then
    mode := 'stage'; why := waiting || ' prospects already wait for an invite (over 75)';
  end if;
  max_approve := case when mode = 'approve' then least(25, greatest(0, 100 - waiting)) else 0 end;
  begin
    kw := outreach.doc('prospecting_keywords')::jsonb;
  exception when others then
    raise exception 'prospecting_keywords is not valid JSON' using errcode = '22023';
  end;
  -- One search word per campaign first (least recently used), then the next best, up to 4 sets: a campaign
  -- with few words (e-commerce) is no longer crowded out by one with many (13.11.2026).
  select coalesce(jsonb_agg(k order by pick), '[]') into kw from (
    select k, row_number() over (order by rn, last_used nulls first, ord) as pick from (
      select k, ord, last_used,
             row_number() over (partition by coalesce(k->>'campaign', '_none') order by last_used nulls first, ord) as rn
      from (
        select k, ord, (select max(found_at) from outreach.candidates c where c.keyword = k->>'keyword') as last_used
        from jsonb_array_elements(kw) with ordinality as t(k, ord)
        where coalesce((k->>'enabled')::boolean, true)
          and (k->>'campaign' is null or exists (select 1 from outreach.campaigns c where c.id = k->>'campaign' and c.status = 'on'))
      ) a
    ) b
  ) x where pick <= 4;
  insert into outreach.runs (kind, notes) values ('add', 'extension prospect round') returning id into run_id;
  return jsonb_build_object('run_id', run_id, 'mode', mode, 'why', why, 'waiting', waiting,
                            'max_approve', max_approve, 'keywords', kw);
end $$;

create or replace function public.ext_prepare_candidates(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  open_connects int;
  room int;
begin
  perform outreach.ext_assert_user(p_user_id);
  select count(*) into open_connects from outreach.action_queue
   where action = 'connect' and status in ('proposed', 'approved')
     and coalesce(approved_at, due_at) >= now() - interval '14 days';
  room := greatest(0, greatest(8, 2 * outreach.invite_day_target()) - open_connects);
  return jsonb_build_object(
    'auto', coalesce(outreach.ext_setting('auto_approve') = 'true'::jsonb, false),
    'items', (select coalesce(jsonb_agg(to_jsonb(x) order by x.action desc, x.due_at), '[]') from (
      select q.id, q.action, q.step, q.message_text, q.due_at, q.campaign_id,
             p.id as prospect_id, p.full_name, p.first_name, p.headline, p.company, p.stage,
             p.raw->'fit' as fit, p.raw->'trigger' as trigger,
             c.name as campaign_name, c.description as campaign_description,
             row_number() over (partition by q.action order by q.due_at) as n
      from outreach.action_queue q
        join outreach.prospects p on p.id = q.prospect_id
        left join outreach.campaigns c on c.id = q.campaign_id
      where q.status = 'scheduled' and q.due_at <= now() and q.action in ('connect', 'message', 'withdraw')
        and (q.action = 'withdraw' or c.status = 'on')
        and (q.action <> 'withdraw' or p.stage = 'invited')
        and p.stage not in ('blacklisted', 'skipped', 'withdrawn', 'completed', 'replied')) x
      where (x.action = 'message' and x.n <= 20) or (x.action = 'connect' and x.n <= room) or (x.action = 'withdraw' and x.n <= 15)));
end $$;

create or replace function public.ext_prepare_apply(p_user_id uuid, p_items jsonb, p_auto boolean)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare n_auto int; n_prop int;
begin
  perform outreach.ext_assert_user(p_user_id);
  with upd as (
    update outreach.action_queue q set
      message_text = coalesce(nullif(i->>'text', ''), q.message_text),
      status = case when coalesce((i->>'ok')::boolean, false) and p_auto and q.action <> 'withdraw' then 'approved' else 'proposed' end,
      approved_at = case when coalesce((i->>'ok')::boolean, false) and p_auto and q.action <> 'withdraw' then now() end,
      approved_via = case when coalesce((i->>'ok')::boolean, false) and p_auto and q.action <> 'withdraw' then 'auto' end,
      error = case when coalesce((i->>'ok')::boolean, false) then null else left(i->>'note', 500) end
    from jsonb_array_elements(coalesce(p_items, '[]')) i
    where q.id = (i->>'id')::bigint and q.status = 'scheduled'
    returning q.status)
  select count(*) filter (where status = 'approved'), count(*) filter (where status = 'proposed') into n_auto, n_prop from upd;
  return jsonb_build_object('ok', true, 'approved', n_auto, 'proposed', n_prop);
end $$;

create or replace function public.ext_send_batch(p_user_id uuid, p_max int)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  lim jsonb := outreach.limits();
  paused boolean := coalesce(outreach.ext_setting('paused') in ('true'::jsonb, '"true"'::jsonb), false);
  practice boolean := coalesce(outreach.ext_setting('ext_dry_run') <> 'false'::jsonb, true);
  msg_left int := coalesce((lim->>'messages_allowed_now')::int, 0);
  inv_left int := coalesce((lim->>'invites_allowed_now')::int, 0);
  target int := outreach.invite_day_target();
  items jsonb;
  stale int;
  w_room int;
begin
  perform outreach.ext_assert_user(p_user_id);
  if practice then
    -- Practice sends nothing, so up to 3 of each may be practised even when the limits are reached.
    msg_left := greatest(msg_left, 3);
    inv_left := greatest(inv_left, 3);
  else
    inv_left := least(inv_left, greatest(0, target - coalesce((lim->>'invites_today')::int, 0)));
  end if;
  -- at most 12 withdrawals a day, spread over the send rounds (13.11.2026)
  select greatest(0, 12 - count(*)) into w_room from outreach.events
   where event_type = 'invite_withdrawn' and occurred_at >= date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';
  select count(*) into stale from outreach.action_queue
   where status = 'approved' and coalesce(approved_at, due_at) < now() - interval '14 days';
  if paused or not outreach.send_window_open() then
    return jsonb_build_object('items', '[]'::jsonb, 'practice', practice, 'paused', paused,
      'window_open', outreach.send_window_open(), 'stale', stale, 'limits', lim, 'invite_day_target', target);
  end if;
  with base as (
    select q.id, q.action, q.message_text, q.due_at, q.campaign_id, q.step,
           p.id as prospect_id, p.full_name, p.first_name, p.linkedin_url, p.stage,
           case q.action when 'reply' then 1 when 'message' then 2 when 'inmail' then 2 when 'withdraw' then 3 when 'connect' then 4 else 9 end as prio
    from outreach.action_queue q join outreach.prospects p on p.id = q.prospect_id
    where q.status = 'approved' and q.due_at <= now() and coalesce(q.approved_at, q.due_at) >= now() - interval '14 days'
      and q.action in ('reply', 'message', 'withdraw', 'connect')
      and p.stage not in ('blacklisted', 'skipped', 'withdrawn', 'completed')
      and not (q.action in ('message', 'connect', 'withdraw') and p.stage = 'replied')
  ), ranked as (
    select b.*, row_number() over (partition by case when action in ('reply', 'message') then 'msg' else action end order by due_at) as n
    from base b
  )
  select coalesce(jsonb_agg(to_jsonb(r) - 'n' - 'prio' order by r.prio, r.due_at), '[]') into items
  from (select * from ranked
        where (action in ('reply', 'message') and n <= msg_left)
           or (action = 'connect' and n <= inv_left)
           or (action = 'withdraw' and n <= w_room)
        order by prio, due_at limit greatest(1, least(coalesce(p_max, 5), 10))) r;
  return jsonb_build_object('items', items, 'practice', practice, 'paused', paused, 'window_open', true,
                            'stale', stale, 'limits', lim, 'invite_day_target', target);
end $$;

do $do$
declare cur jsonb; extra jsonb;
begin
  begin cur := outreach.doc('prospecting_keywords')::jsonb; exception when others then return; end;
  if cur is null or jsonb_typeof(cur) <> 'array' then return; end if;
  select coalesce(jsonb_agg(a), '[]') into extra from jsonb_array_elements($j$[{"keyword": "Geschäftsführer Onlineshop", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "Inhaber Onlineshop", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "Online-Händler Geschäftsführer", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "E-Commerce Gründer", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "Shopify Händler Inhaber", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "Shopware Shop Betreiber", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "WooCommerce Shop Inhaber", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "Inhaber Onlineshop Mode", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "Inhaber Onlineshop Haustier", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "Inhaber Onlineshop Möbel", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "Inhaber Onlineshop Sport", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}, {"keyword": "Gründer Onlineshop Bio Lebensmittel", "segment": "ecommerce", "campaign": "ecommerce-first-level-support", "stage_only": true}]$j$::jsonb) a
   where not exists (select 1 from jsonb_array_elements(cur) c where lower(c->>'keyword') = lower(a->>'keyword'));
  if jsonb_array_length(extra) = 0 then return; end if;
  perform outreach.doc_put('prospecting_keywords', (cur || extra)::text, 'e-commerce keyword sets added (13.11.2026)', 'migration');
end $do$;

-- migrate:down
-- (earlier function definitions stay in migrations 035, 042 and 047; added keywords can be removed in Settings)
select 1;
