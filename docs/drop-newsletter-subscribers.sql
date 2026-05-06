-- Remove obsolete table now that workflow is fully on `public.leads`.
-- Run in Supabase SQL editor after confirming `public.leads` is populated.

drop table if exists public.newsletter_subscribers;
