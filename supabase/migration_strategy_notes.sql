-- Migration: add strategy_notes column to ai_reflections
-- Run in Supabase SQL Editor once.
-- strategy_notes = hasil evaluasi strategi mingguan Gemini dengan Google Search
-- grounding (berita/YouTube/web), dipakai ulang sebagai masukan analyze berikutnya.
alter table ai_reflections add column if not exists strategy_notes text;

-- Verify
select column_name from information_schema.columns
where table_name = 'ai_reflections' and column_name = 'strategy_notes';