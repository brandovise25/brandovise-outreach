-- Run as the owner role after migrations. Fails loudly (raise) on any broken guarantee.
\set ON_ERROR_STOP on

do $$
declare
  ok boolean;
begin
  -- api_rpc has no table privileges on the new tables
  select has_table_privilege('api_rpc', 'outreach.app_users', 'select') into ok;
  if ok then raise exception 'api_rpc can select app_users'; end if;
  select has_table_privilege('api_rpc', 'outreach.settings', 'select') into ok;
  if ok then raise exception 'api_rpc can select settings'; end if;

  -- api_rpc can execute the ext functions, public cannot
  select has_function_privilege('api_rpc', 'public.ext_get_settings(uuid)', 'execute') into ok;
  if not ok then raise exception 'api_rpc cannot execute ext_get_settings'; end if;
  select has_function_privilege('public', 'public.ext_get_settings(uuid)', 'execute') into ok;
  if ok then raise exception 'PUBLIC can execute ext_get_settings'; end if;

  -- unknown user is rejected
  begin
    perform public.ext_get_settings(gen_random_uuid());
    raise exception 'unknown user was allowed';
  exception when insufficient_privilege then null;
  end;

  -- dry-run defaults on
  if (select value::text from outreach.settings where key = 'ext_dry_run') <> 'true' then
    raise exception 'ext_dry_run seed is not true';
  end if;

  raise notice '001_ext_foundation: all checks passed';
end $$;
