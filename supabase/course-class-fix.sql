-- Run in Supabase SQL Editor if course editing reports that courses.class_name is missing.
alter table public.courses
  add column if not exists class_name varchar(100);

notify pgrst, 'reload schema';
