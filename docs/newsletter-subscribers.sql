-- Leads schema normalization (canonical table for newsletter workflow).
-- Run this in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  first_name text,
  last_name text,
  email text not null,
  job_title text,
  document_slug text not null default '',
  redirect_url text not null default '',
  source text,
  created_at timestamptz not null default now(),
  newsletter_opt_in boolean not null default false,
  unsubscribed_at timestamptz,
  inserted_at timestamptz not null default now()
);

alter table public.leads
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists email text,
  add column if not exists job_title text,
  add column if not exists document_slug text,
  add column if not exists redirect_url text,
  add column if not exists source text,
  add column if not exists created_at timestamptz,
  add column if not exists newsletter_opt_in boolean,
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists inserted_at timestamptz;

update public.leads
set
  document_slug = coalesce(document_slug, ''),
  redirect_url = coalesce(redirect_url, ''),
  created_at = coalesce(created_at, now()),
  newsletter_opt_in = coalesce(newsletter_opt_in, false),
  inserted_at = coalesce(inserted_at, now()),
  email = lower(trim(email))
where
  document_slug is null
  or redirect_url is null
  or created_at is null
  or newsletter_opt_in is null
  or inserted_at is null
  or email <> lower(trim(email));

alter table public.leads
  alter column email set not null,
  alter column document_slug set default '',
  alter column document_slug set not null,
  alter column redirect_url set default '',
  alter column redirect_url set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column newsletter_opt_in set default false,
  alter column newsletter_opt_in set not null,
  alter column inserted_at set default now(),
  alter column inserted_at set not null;

create index if not exists idx_leads_email_lower
  on public.leads (lower(email));

create index if not exists idx_leads_active
  on public.leads (newsletter_opt_in, unsubscribed_at);

select count(*) as leads_count from public.leads;
