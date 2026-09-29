-- Apply after supabase/schema.sql to enable student accounts, digital work,
-- private file storage, and push notification subscriptions.

alter table public.students
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

alter table public.submissions
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists submission_note text;

create table if not exists public.student_push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth_secret text not null,
  created_at timestamptz not null default now()
);
create index if not exists student_push_subscriptions_user_id_idx
  on public.student_push_subscriptions(user_id);

alter table public.student_push_subscriptions enable row level security;
revoke all on public.student_push_subscriptions from anon;
grant select, insert, update, delete on public.student_push_subscriptions to authenticated;

create or replace function public.is_active_student()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select
    coalesce((select auth.jwt() -> 'app_metadata' ->> 'account_type') = 'student', false)
    and coalesce((select (auth.jwt() -> 'app_metadata' ->> 'must_change_password')::boolean), true) = false
    and exists (
      select 1 from public.students s
      where s.auth_user_id = (select auth.uid()) and s.status = 'active'
    );
$$;
revoke all on function public.is_active_student() from public, anon;
grant execute on function public.is_active_student() to authenticated;

drop policy if exists "Students can read their own student record" on public.students;
create policy "Students can read their own student record" on public.students
for select to authenticated using (auth_user_id = (select auth.uid()));

drop policy if exists "Students can read their own submissions" on public.submissions;
create policy "Students can read their own submissions" on public.submissions
for select to authenticated using (
  (select public.is_active_student())
  and student_id in (
    select s.id from public.students s
    where s.auth_user_id = (select auth.uid()) and s.status = 'active'
  )
);

drop policy if exists "Students can read their assigned active work" on public.assignments;
create policy "Students can read their assigned active work" on public.assignments
for select to authenticated using (
  status = 'active'
  and exists (
    select 1
    from public.submissions sub
    join public.students s on s.id = sub.student_id
    where sub.assignment_id = assignments.id
      and s.auth_user_id = (select auth.uid())
      and s.status = 'active'
  )
);

drop policy if exists "Students can manage their own push subscription" on public.student_push_subscriptions;
create policy "Students can manage their own push subscription" on public.student_push_subscriptions
for all to authenticated
using (user_id = (select auth.uid()) and (select public.is_active_student()))
with check (user_id = (select auth.uid()) and (select public.is_active_student()));

create or replace function public.submit_student_work(
  p_submission_id bigint,
  p_attachment_path text default null,
  p_attachment_name text default null,
  p_submission_note text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_student_id bigint;
begin
  if not public.is_active_student() then
    raise exception 'Student account is not active or password setup is incomplete';
  end if;

  select s.id into v_student_id
  from public.students s
  where s.auth_user_id = (select auth.uid()) and s.status = 'active';

  if p_attachment_path is null and nullif(btrim(p_submission_note), '') is null then
    raise exception 'Attach a file or enter a note before submitting';
  end if;

  if p_attachment_path is not null and (
    split_part(p_attachment_path, '/', 1) <> (select auth.uid())::text
    or split_part(p_attachment_path, '/', 2) <> p_submission_id::text
  ) then
    raise exception 'Invalid attachment path';
  end if;

  if p_attachment_path is not null and not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'student-submissions' and o.name = p_attachment_path
  ) then
    raise exception 'Uploaded attachment was not found';
  end if;

  update public.submissions sub
  set status = case
        when a.due_date is not null and now() > a.due_date then 'late'::public.submission_status
        else 'submitted'::public.submission_status
      end,
      submitted_at = now(),
      attachment_path = p_attachment_path,
      attachment_name = nullif(btrim(p_attachment_name), ''),
      submission_note = nullif(btrim(p_submission_note), '')
  from public.assignments a
  where sub.id = p_submission_id
    and sub.assignment_id = a.id
    and sub.student_id = v_student_id
    and sub.status in ('pending'::public.submission_status, 'returned'::public.submission_status);

  if not found then
    raise exception 'Submission is unavailable or is no longer accepting work';
  end if;
end;
$$;
revoke all on function public.submit_student_work(bigint, text, text, text) from public, anon;
grant execute on function public.submit_student_work(bigint, text, text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'student-submissions',
  'student-submissions',
  false,
  26214400,
  array['application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword','application/vnd.ms-powerpoint','application/vnd.ms-excel']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Student can upload own pending work" on storage.objects;
create policy "Student can upload own pending work" on storage.objects
for insert to authenticated with check (
  bucket_id = 'student-submissions'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and exists (
    select 1 from public.submissions sub
    join public.students s on s.id = sub.student_id
    where sub.id::text = split_part(name, '/', 2)
      and s.auth_user_id = (select auth.uid())
      and sub.status in ('pending'::public.submission_status, 'returned'::public.submission_status)
  )
);

drop policy if exists "Staff and owner can read student work" on storage.objects;
create policy "Staff and owner can read student work" on storage.objects
for select to authenticated using (
  bucket_id = 'student-submissions'
  and (
    (select public.is_active_staff())
    or (
      split_part(name, '/', 1) = (select auth.uid())::text
      and (select public.is_active_student())
    )
  )
);

drop policy if exists "Student can delete own resubmission files" on storage.objects;
create policy "Student can delete own resubmission files" on storage.objects
for delete to authenticated using (
  bucket_id = 'student-submissions'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and exists (
    select 1 from public.submissions sub
    join public.students s on s.id = sub.student_id
    where sub.id::text = split_part(name, '/', 2)
      and s.auth_user_id = (select auth.uid())
      and sub.status in ('pending'::public.submission_status, 'returned'::public.submission_status)
  )
);

drop policy if exists "Staff can manage student work files" on storage.objects;
create policy "Staff can manage student work files" on storage.objects
for all to authenticated
using (bucket_id = 'student-submissions' and (select public.is_active_staff()))
with check (bucket_id = 'student-submissions' and (select public.is_active_staff()));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'submissions'
     ) then
    execute 'alter publication supabase_realtime add table public.submissions';
  end if;
end;
$$;
