-- Required student nickname and private face photo after first password change.
-- Run this in Supabase SQL Editor after student-portal.sql.

alter table public.students
  add column if not exists student_nickname varchar(40),
  add column if not exists face_photo_path text,
  add column if not exists profile_completed_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'student-profiles',
  'student-profiles',
  false,
  5242880,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','image/avif']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Students can upload their own profile photo" on storage.objects;
create policy "Students can upload their own profile photo" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'student-profiles'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and (select public.is_active_student())
);

drop policy if exists "Students and staff can view profile photos" on storage.objects;
create policy "Students and staff can view profile photos" on storage.objects
for select to authenticated
using (
  bucket_id = 'student-profiles'
  and (
    (select public.is_active_staff())
    or (
      split_part(name, '/', 1) = (select auth.uid())::text
      and (select public.is_active_student())
    )
  )
);

create or replace function public.complete_student_profile(
  p_nickname text,
  p_photo_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nickname text := btrim(coalesce(p_nickname, ''));
begin
  if not public.is_active_student() then
    raise exception 'Student account is not active or password setup is incomplete';
  end if;

  if char_length(v_nickname) < 1 or char_length(v_nickname) > 40 then
    raise exception 'Nickname must contain between 1 and 40 characters';
  end if;

  if p_photo_path is null
     or split_part(p_photo_path, '/', 1) <> (select auth.uid())::text
     or p_photo_path ~ '(^|/)\.\.?(/|$)'
     or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'student-profiles' and o.name = p_photo_path
     ) then
    raise exception 'A valid profile photo is required';
  end if;

  update public.students s
  set student_nickname = v_nickname,
      face_photo_path = p_photo_path,
      profile_completed_at = now(),
      updated_at = now()
  where s.auth_user_id = (select auth.uid()) and s.status = 'active';

  if not found then
    raise exception 'Student record was not found';
  end if;
end;
$$;

revoke all on function public.complete_student_profile(text, text) from public, anon;
grant execute on function public.complete_student_profile(text, text) to authenticated;

notify pgrst, 'reload schema';
