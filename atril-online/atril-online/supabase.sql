-- Atril: base de datos para cuentas de usuario
-- Cópialo completo en Supabase → SQL Editor → New query → Run.
-- Se puede correr más de una vez sin romper nada.

-- 1) Todo lo de cada persona (libros, resaltados, portadas, documentos, ajustes)
create table if not exists public.items (
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null,           -- book | hl | cover | doc | ls
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);
alter table public.items enable row level security;

drop policy if exists "items: cada quien ve lo suyo" on public.items;
create policy "items: cada quien ve lo suyo" on public.items
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 2) Uso mensual de voz e IA por persona (solo el servidor escribe aquí)
create table if not exists public.usage (
  user_id   uuid not null references auth.users(id) on delete cascade,
  month     text not null,            -- por ejemplo 2026-10
  tts_chars integer not null default 0,
  ai_calls  integer not null default 0,
  primary key (user_id, month)
);
alter table public.usage enable row level security;

drop policy if exists "usage: cada quien ve su uso" on public.usage;
create policy "usage: cada quien ve su uso" on public.usage
  for select to authenticated using (user_id = auth.uid());

create or replace function public.bump_usage(p_user uuid, p_month text, p_chars integer, p_calls integer)
returns public.usage
language plpgsql security definer set search_path = public as $$
declare r public.usage;
begin
  insert into public.usage as u (user_id, month, tts_chars, ai_calls)
  values (p_user, p_month, p_chars, p_calls)
  on conflict (user_id, month)
  do update set tts_chars = u.tts_chars + excluded.tts_chars, ai_calls = u.ai_calls + excluded.ai_calls
  returning * into r;
  return r;
end $$;
revoke all on function public.bump_usage(uuid, text, integer, integer) from public, anon, authenticated;

-- 3) Archivos de los libros (texto ya procesado), en una carpeta privada por persona
insert into storage.buckets (id, name, public)
values ('books', 'books', false)
on conflict (id) do nothing;

drop policy if exists "books: leer lo propio" on storage.objects;
drop policy if exists "books: subir lo propio" on storage.objects;
drop policy if exists "books: cambiar lo propio" on storage.objects;
drop policy if exists "books: borrar lo propio" on storage.objects;
create policy "books: leer lo propio" on storage.objects for select to authenticated
  using (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "books: subir lo propio" on storage.objects for insert to authenticated
  with check (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "books: cambiar lo propio" on storage.objects for update to authenticated
  using (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "books: borrar lo propio" on storage.objects for delete to authenticated
  using (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);
