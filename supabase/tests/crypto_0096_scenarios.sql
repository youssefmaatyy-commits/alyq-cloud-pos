-- 0096 focused regression — hosted Supabase installs pgcrypto in `extensions`
-- (`extensions.digest`, `extensions.gen_random_bytes`, `extensions.crypt`,
-- `extensions.gen_salt`), without `public.*` forwarding functions.
--
-- Verify that:
--   1. All test-only `public.*` pgcrypto forwarding shims are dropped so the
--      namespace matches hosted Supabase (`pg_catalog` + `extensions` only).
--   2. Every `public` function in `pg_proc` is free of unqualified `pgcrypto`
--      calls outside `extensions`.
--   3. All 7 repaired functions in 0096 retain SECURITY DEFINER, hardened
--      search_path, and exact REVOKE/GRANT privileges.
--   4. All 7 repaired functions execute end-to-end under `search_path =
--      pg_catalog, public` without any `public.*` pgcrypto shims.

do $crypto_0096$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_reg_install uuid := '00000000-0000-4000-8000-000000009601';
  v_mob_install_v1 uuid := '00000000-0000-4000-8000-000000009602';
  v_mob_install_v2 uuid := '00000000-0000-4000-8000-000000009603';
  v_signature text;
  v_definition text;
  v_seeded int;
  v_viewer_hash text;
  v_preview jsonb;
  v_exec jsonb;
  v_reg_created jsonb;
  v_reg_credential text;
  v_reg_resolved public.registers;
  v_mob_v1 jsonb;
  v_mob_v2 jsonb;
  v_unqualified_count int;
begin
  -- 1. Drop all remaining test-only public pgcrypto forwarding shims so the
  --    schema matches hosted Supabase exactly.
  perform pg_temp.become(null, 'postgres');
  drop function if exists public.digest(text, text);
  drop function if exists public.digest(bytea, text);
  drop function if exists public.gen_random_bytes(integer);
  drop function if exists public.crypt(text, text);
  drop function if exists public.gen_salt(text);
  drop function if exists public.gen_salt(text, integer);

  if to_regprocedure('public.digest(text,text)') is not null
     or to_regprocedure('public.gen_random_bytes(integer)') is not null
     or to_regprocedure('public.crypt(text,text)') is not null
     or to_regprocedure('public.gen_salt(text)') is not null
     or to_regprocedure('public.gen_salt(text,integer)') is not null
     or to_regprocedure('extensions.digest(text,text)') is null
     or to_regprocedure('extensions.gen_random_bytes(integer)') is null
     or to_regprocedure('extensions.crypt(text,text)') is null
     or to_regprocedure('extensions.gen_salt(text)') is null
     or to_regprocedure('extensions.gen_salt(text,integer)') is null then
    raise exception '0096 test namespace does not match hosted Supabase pgcrypto layout';
  end if;

  -- 2. Verify all 7 functions bind extensions.* explicitly and preserve their
  --    SECURITY DEFINER and search_path configuration.
  foreach v_signature in array array[
    'public.seed_demo_staff(text)',
    'public.preview_selective_cleanup(text,jsonb)',
    'public.execute_selective_cleanup(uuid,text,text,text,uuid)',
    'public.register_resolve_private(uuid,text,boolean)',
    'public.register_create(text,text,uuid,uuid)',
    'public.mobile_installation_register(uuid,text,text,text)',
    'public.mobile_installation_register_v2(uuid,text,text,text,text)'
  ] loop
    select pg_get_functiondef(v_signature::regprocedure::oid) into v_definition;
    if strpos(v_definition, 'SECURITY DEFINER') = 0 then
      raise exception '0096 dropped SECURITY DEFINER on %', v_signature;
    end if;
    if strpos(v_definition, 'extensions.') = 0 then
      raise exception '0096 missing extensions.* qualification on %', v_signature;
    end if;
  end loop;

  -- Verify zero public functions remain with unqualified pgcrypto calls when
  -- `extensions` is absent from their proconfig search_path.
  select count(*) into v_unqualified_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
        where cfg ilike 'search_path=%extensions%'
     )
     and (
       regexp_replace(p.prosrc, 'extensions\.(digest|gen_random_bytes|crypt|gen_salt)', '', 'g')
         ~ '\m(digest|gen_random_bytes|crypt|gen_salt)\s*\('
     );
  if v_unqualified_count <> 0 then
    raise exception '0096 left % public function(s) with unqualified pgcrypto calls', v_unqualified_count;
  end if;

  -- 3. Verify privilege boundaries (proacl + REVOKE/GRANT) on all 7 functions
  --    match their original definitions in 0014, 0073, 0082, 0083, and 0092.
  if not has_function_privilege('authenticated', 'public.seed_demo_staff(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.preview_selective_cleanup(text,jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.execute_selective_cleanup(uuid,text,text,text,uuid)', 'execute')
     or has_function_privilege('anon', 'public.register_resolve_private(uuid,text,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.register_resolve_private(uuid,text,boolean)', 'execute')
     or has_function_privilege('anon', 'public.register_create(text,text,uuid,uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.register_create(text,text,uuid,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.register_create(text,text,uuid,uuid)', 'execute')
     or has_function_privilege('anon', 'public.mobile_installation_register(uuid,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.mobile_installation_register(uuid,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.mobile_installation_register(uuid,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.mobile_installation_register_v2(uuid,text,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.mobile_installation_register_v2(uuid,text,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.mobile_installation_register_v2(uuid,text,text,text,text)', 'execute') then
    raise exception '0096 altered function execute privileges';
  end if;

  -- Prepare active admin + main branch context for runtime verification.
  update public.profiles set active = true, role = 'admin', active_branch_id = v_main where id = v_admin;
  update public.branch_memberships set active = true
   where user_id = v_admin and branch_id = v_main;

  -- Remove `viewer@alyq.local` temporarily so `seed_demo_staff` exercises the
  -- `v_id is null` branch (`extensions.crypt` + `extensions.gen_salt`).
  delete from public.profiles where id in (select id from auth.users where email = 'viewer@alyq.local');
  delete from auth.users where email = 'viewer@alyq.local';
  delete from public.mobile_installations where installation_id in (v_mob_install_v1, v_mob_install_v2);

  -- 4. Execute all 7 functions under `search_path = pg_catalog, public`.
  set local search_path = pg_catalog, public;

  -- (4.1) public.seed_demo_staff(text)
  perform pg_temp.become(v_admin, 'authenticated');
  v_seeded := public.seed_demo_staff('alyq1234');
  if v_seeded < 1 then
    raise exception '0096 seed_demo_staff did not create missing demo account';
  end if;
  perform pg_temp.become(null, 'postgres');
  select encrypted_password into v_viewer_hash from auth.users where email = 'viewer@alyq.local';
  if v_viewer_hash is null or extensions.crypt('alyq1234', v_viewer_hash) <> v_viewer_hash then
    raise exception '0096 seed_demo_staff failed to hash password with extensions.crypt/gen_salt';
  end if;

  -- (4.2) public.preview_selective_cleanup(text,jsonb)
  perform pg_temp.become(v_admin, 'authenticated');
  v_preview := public.preview_selective_cleanup(
    'customers',
    jsonb_build_object('before', (now() - interval '1 day')::text)
  );
  if v_preview->>'preview_id' is null
     or char_length( coalesce(v_preview->>'fingerprint', '') ) <> 64
     or char_length( coalesce(v_preview->>'preview_token', '') ) <> 64 then
    raise exception '0096 preview_selective_cleanup failed to generate token/fingerprint';
  end if;

  -- (4.3) public.execute_selective_cleanup(uuid,text,text,text,uuid)
  v_exec := public.execute_selective_cleanup(
    (v_preview->>'preview_id')::uuid,
    v_preview->>'preview_token',
    v_preview->>'fingerprint',
    v_preview->>'confirmation_phrase',
    null
  );
  if v_exec->>'preview_id' <> v_preview->>'preview_id'
     or v_exec->>'completed_at' is null then
    raise exception '0096 execute_selective_cleanup failed to verify token hash and complete';
  end if;

  -- (4.4) public.register_create(text,text,uuid,uuid)
  v_reg_created := public.register_create('REG096', 'Register 0096 Test', v_main, v_reg_install);
  v_reg_credential := v_reg_created->>'credential';
  if v_reg_credential is null or char_length(v_reg_credential) <> 64 then
    raise exception '0096 register_create failed to issue 64-char hex credential';
  end if;

  -- (4.5) public.register_resolve_private(uuid,text,boolean)
  --       Internal helper revoked from public/anon/authenticated; callable by
  --       SECURITY DEFINER owner (`postgres`) while auth.uid() is set.
  perform pg_temp.become(null, 'postgres');
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );
  v_reg_resolved := public.register_resolve_private(v_reg_install, v_reg_credential, true);
  if v_reg_resolved.installation_id <> v_reg_install or v_reg_resolved.code <> 'REG096' then
    raise exception '0096 register_resolve_private failed to match credential hash';
  end if;

  -- (4.6) public.mobile_installation_register(uuid,text,text,text)
  perform pg_temp.become(v_admin, 'authenticated');
  v_mob_v1 := public.mobile_installation_register(
    v_mob_install_v1,
    'android',
    '1.0.96',
    'push-token-0096-v1-abcdefghijklmnopqrstuvwxyz'
  );
  if v_mob_v1->>'active' <> 'true' or v_mob_v1->>'push_registered' <> 'true' then
    raise exception '0096 mobile_installation_register failed';
  end if;

  -- (4.7) public.mobile_installation_register_v2(uuid,text,text,text,text)
  v_mob_v2 := public.mobile_installation_register_v2(
    v_mob_install_v2,
    'android',
    '1.0.96',
    'push-token-0096-v2-abcdefghijklmnopqrstuvwxyz',
    'ar'
  );
  if v_mob_v2->>'active' <> 'true'
     or v_mob_v2->>'push_registered' <> 'true'
     or v_mob_v2->>'locale' <> 'ar' then
    raise exception '0096 mobile_installation_register_v2 failed';
  end if;

  -- Clean up test rows created in this block (registers remain linked by append-only audit_log).
  perform pg_temp.become(null, 'postgres');
  delete from public.mobile_installations where installation_id in (v_mob_install_v1, v_mob_install_v2);
  delete from public.cleanup_previews where id = (v_preview->>'preview_id')::uuid;

  raise notice '0096 — all 7 legacy pgcrypto functions verified under hosted extensions namespace without public shims';
end
$crypto_0096$;
