-- migrate:up
-- Funnel per campaign (Jibran, 18.11.2026): invited -> accepted -> messaged -> replied -> hot reply
-- (interested, question, objection) -> meeting -> won. Stages imported from the earlier tool count too:
-- someone who replied was connected and written to, so later stages imply the earlier ones.
-- p_days: only people invited in the last p_days days (null = everyone). Additive only.

create or replace function public.ext_funnel(p_user_id uuid, p_days int)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (
    with base as (
      select p.campaign_id,
        (p.invited_at is not null or p.stage in ('invited', 'accepted', 'msg1_sent', 'msg2_sent', 'msg3_sent',
           'replied', 'completed', 'withdrawn') or p.replied_at is not null) as invited,
        (p.accepted_at is not null or p.stage in ('accepted', 'msg1_sent', 'msg2_sent', 'msg3_sent', 'replied',
           'completed') or p.replied_at is not null) as accepted,
        (p.msg1_at is not null or p.stage in ('msg1_sent', 'msg2_sent', 'msg3_sent', 'replied', 'completed')
           or p.replied_at is not null) as messaged,
        (p.replied_at is not null or p.stage = 'replied') as replied,
        (p.reply_outcome in ('interested', 'question', 'objection')
           or p.deal_stage in ('engaged', 'qualifying', 'meeting', 'won')) as hot,
        (p.deal_stage in ('meeting', 'won')) as meeting,
        (p.deal_stage = 'won') as won
      from outreach.prospects p
      where p_days is null or p.invited_at >= now() - make_interval(days => p_days)
    ),
    per as (
      select coalesce(b.campaign_id, '(none)') as campaign_id,
             count(*) filter (where invited) as invited, count(*) filter (where accepted) as accepted,
             count(*) filter (where messaged) as messaged, count(*) filter (where replied) as replied,
             count(*) filter (where hot) as hot, count(*) filter (where meeting) as meeting,
             count(*) filter (where won) as won
      from base b group by 1
    )
    select jsonb_build_object(
      'days', p_days,
      'total', (select jsonb_build_object('invited', coalesce(sum(invited), 0), 'accepted', coalesce(sum(accepted), 0),
                  'messaged', coalesce(sum(messaged), 0), 'replied', coalesce(sum(replied), 0),
                  'hot', coalesce(sum(hot), 0), 'meeting', coalesce(sum(meeting), 0), 'won', coalesce(sum(won), 0))
                from per),
      'campaigns', (select coalesce(jsonb_agg(to_jsonb(x) order by x.invited desc), '[]') from (
                  select per.*, c.name, c.status from per left join outreach.campaigns c on c.id = per.campaign_id
                  where per.invited > 0 or per.replied > 0) x))
  );
end $$;

revoke all on function public.ext_funnel(uuid, int) from public;
grant execute on function public.ext_funnel(uuid, int) to api_rpc;

-- migrate:down
drop function if exists public.ext_funnel(uuid, int);
