-- migrate:up
-- Random sign-outs (Jibran, 08.11.2026). The extension renews its login every 15 minutes by trading
-- its refresh token for a new one. When the answer never arrives (Chrome stops the background worker
-- mid-request, the Mac sleeps, Wi-Fi drops), the server has already retired the old token but the
-- extension still holds it. Its next try counted as token theft and revoked every login: signed out.
-- Now: if the retired token's replacement was never used, the answer was lost, not stolen. The unused
-- replacement is retired and a new token issued. A replacement that was used (or a token retired by
-- logout) still revokes everything, as before. Same signature, so nothing else changes.

create or replace function public.ext_auth_rotate_refresh(
  p_old_hash text, p_new_hash text, p_expires_at timestamptz)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  t outreach.refresh_tokens%rowtype;
  r outreach.refresh_tokens%rowtype;
  v_new uuid;
begin
  select * into t from outreach.refresh_tokens where token_hash = p_old_hash for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  if t.revoked_at is not null then
    if t.replaced_by is not null then
      select * into r from outreach.refresh_tokens where id = t.replaced_by for update;
    end if;
    if r.id is null or r.revoked_at is not null or r.expires_at < now()
       or t.revoked_at < now() - interval '7 days' then
      update outreach.refresh_tokens set revoked_at = now()
        where user_id = t.user_id and revoked_at is null;
      return jsonb_build_object('ok', false, 'reason', 'reused');
    end if;
    -- Lost answer: retire the unused replacement and issue a new one below.
    update outreach.refresh_tokens set revoked_at = now() where id = r.id;
  end if;
  if t.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if not exists (select 1 from outreach.app_users where id = t.user_id and enabled) then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  insert into outreach.refresh_tokens (user_id, device_id, token_hash, expires_at)
  values (t.user_id, t.device_id, p_new_hash, p_expires_at)
  returning id into v_new;
  update outreach.refresh_tokens set revoked_at = coalesce(revoked_at, now()), replaced_by = v_new
    where id = t.id;
  return jsonb_build_object('ok', true, 'user_id', t.user_id, 'device_id', t.device_id);
end $$;

-- migrate:down
create or replace function public.ext_auth_rotate_refresh(
  p_old_hash text, p_new_hash text, p_expires_at timestamptz)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  t outreach.refresh_tokens%rowtype;
  v_new uuid;
begin
  select * into t from outreach.refresh_tokens where token_hash = p_old_hash for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  if t.revoked_at is not null then
    update outreach.refresh_tokens set revoked_at = now()
      where user_id = t.user_id and revoked_at is null;
    return jsonb_build_object('ok', false, 'reason', 'reused');
  end if;
  if t.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if not exists (select 1 from outreach.app_users where id = t.user_id and enabled) then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  insert into outreach.refresh_tokens (user_id, device_id, token_hash, expires_at)
  values (t.user_id, t.device_id, p_new_hash, p_expires_at)
  returning id into v_new;
  update outreach.refresh_tokens set revoked_at = now(), replaced_by = v_new where id = t.id;
  return jsonb_build_object('ok', true, 'user_id', t.user_id, 'device_id', t.device_id);
end $$;
