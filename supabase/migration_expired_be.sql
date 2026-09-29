-- Migration (PRD Module D): outcomes.hit kini mendukung tag EXPIRED_BE
-- (time-based exit >48 jam tanpa sentuh SL/TP).
-- Run ONCE di Supabase SQL Editor. Idempotent.
do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'outcomes'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%SL%TP%';
  if c is not null then
    execute format('alter table outcomes drop constraint %I', c);
  end if;
end $$;

alter table outcomes add constraint outcomes_hit_check check (hit in ('SL','TP','TIMEOUT','EXPIRED_BE'));