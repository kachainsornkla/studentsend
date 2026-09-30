-- Run in Supabase SQL Editor to support the same subject in multiple classes.
alter table public.courses
  add column if not exists class_name varchar(100);

update public.courses set class_name = '' where class_name is null;
alter table public.courses alter column class_name set default '';
alter table public.courses alter column class_name set not null;

alter table public.courses drop constraint if exists courses_course_name_key;
alter table public.courses drop constraint if exists courses_course_code_key;
alter table public.courses drop constraint if exists courses_course_code_unique;
alter table public.courses drop constraint if exists courses_name_class_unique;
alter table public.courses drop constraint if exists courses_code_class_unique;
drop index if exists public.courses_course_name_key;
drop index if exists public.courses_course_code_key;

create unique index if not exists courses_name_class_unique_idx
  on public.courses(course_name, class_name);
create unique index if not exists courses_code_class_unique_idx
  on public.courses(course_code, class_name);

notify pgrst, 'reload schema';
