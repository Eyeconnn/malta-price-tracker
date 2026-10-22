-- 004: the read-only role used by the public site must not read visitor reports (they hold emails).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    revoke select on reports from dashboard_ro;
  end if;
end
$$;
