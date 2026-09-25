-- Migration: add pnl_r (return-on-risk) column to outcomes + backfill.
-- pnl_r = (exit - entry) / abs(entry - SL)  for LONG
--       = (entry - exit) / abs(entry - SL)  for SHORT
--       = 0 for BE/TIMEOUT
-- Run ONCE in Supabase SQL Editor.

alter table outcomes add column if not exists pnl_r numeric;

-- Backfill existing rows from signals (entry/sl) + outcomes (exit_price)
update outcomes o
set pnl_r = case
  when s.direction = 'LONG' then (o.exit_price - s.entry) / greatest(abs(s.entry - s.sl), 1e-12)
  when s.direction = 'SHORT' then (s.entry - o.exit_price) / greatest(abs(s.entry - s.sl), 1e-12)
  else 0
end
from signals s
where o.signal_id = s.id
  and o.result in ('WIN','LOSS')
  and s.entry is not null and s.sl is not null;

-- BE/TIMEOUT = 0 R
update outcomes set pnl_r = 0 where result = 'BE' and pnl_r is null;

-- Verify
select result, count(*) as n, round(avg(pnl_r)::numeric, 3) as avg_r, round(sum(pnl_r)::numeric, 3) as sum_r
from outcomes
group by result order by result;