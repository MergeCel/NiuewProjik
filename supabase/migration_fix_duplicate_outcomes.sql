-- Migration: fix duplicate outcomes (bug evaluate - status update not checked,
-- some signals were evaluated multiple times producing 2 outcomes).
-- Run this ONCE in Supabase SQL Editor.

-- 1) Hapus outcome duplikat: simpan outcome PERTAMA per signal (evaluated_at asc).
--    Untuk signal c1331477... (BTC LONG): outcome pertama LOSS/SL 13:10 adalah hasil yang benar.
delete from outcomes
where id in (
  select id from (
    select id,
           row_number() over (partition by signal_id order by evaluated_at asc, id asc) rn
    from outcomes
  ) t
  where t.rn > 1
);

-- 2) Cegah duplikat di masa depan di level database (satu outcome per signal).
create unique index if not exists idx_outcomes_signal_unique on outcomes(signal_id);

-- 3) Verifikasi
select count(*) as total_outcomes from outcomes;