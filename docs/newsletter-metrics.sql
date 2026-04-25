-- Newsletter analytics schema for Resend webhook events.
-- Run this in Supabase SQL editor.

create table if not exists public.newsletter_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  webhook_id text not null,
  event_type text not null,
  event_created_at timestamptz not null,
  email_id text,
  broadcast_id text,
  recipient text,
  sender text,
  subject text,
  campaign text,
  stream text,
  click_link text,
  click_timestamp timestamptz,
  tags jsonb,
  payload jsonb not null,
  inserted_at timestamptz not null default now()
);

create index if not exists idx_newsletter_events_event_type
  on public.newsletter_events (event_type);

create index if not exists idx_newsletter_events_campaign
  on public.newsletter_events (campaign);

create index if not exists idx_newsletter_events_event_created_at
  on public.newsletter_events (event_created_at desc);

create index if not exists idx_newsletter_events_recipient
  on public.newsletter_events (recipient);

create index if not exists idx_newsletter_events_email_id
  on public.newsletter_events (email_id);

create or replace view public.newsletter_campaign_metrics as
with base as (
  select
    coalesce(nullif(campaign, ''), 'unattributed') as campaign,
    recipient,
    event_type,
    event_created_at
  from public.newsletter_events
)
select
  campaign,
  min(event_created_at) as first_event_at,
  max(event_created_at) as last_event_at,
  count(*) as total_events,
  count(*) filter (where event_type = 'email.sent') as sent_events,
  count(distinct recipient) filter (where event_type = 'email.sent') as sent_unique,
  count(distinct recipient) filter (where event_type = 'email.delivered') as delivered_unique,
  count(distinct recipient) filter (where event_type = 'email.opened') as opened_unique,
  count(distinct recipient) filter (where event_type = 'email.clicked') as clicked_unique,
  round(
    100.0 * count(distinct recipient) filter (where event_type = 'email.opened')
    / nullif(count(distinct recipient) filter (where event_type = 'email.delivered'), 0),
    2
  ) as open_rate_pct,
  round(
    100.0 * count(distinct recipient) filter (where event_type = 'email.clicked')
    / nullif(count(distinct recipient) filter (where event_type = 'email.delivered'), 0),
    2
  ) as ctr_pct,
  round(
    100.0 * count(distinct recipient) filter (where event_type = 'email.clicked')
    / nullif(count(distinct recipient) filter (where event_type = 'email.opened'), 0),
    2
  ) as ctor_pct
from base
group by campaign
order by last_event_at desc;

create or replace view public.newsletter_campaign_link_metrics as
select
  coalesce(nullif(campaign, ''), 'unattributed') as campaign,
  click_link,
  count(*) filter (where event_type = 'email.clicked') as total_clicks,
  count(distinct recipient) filter (where event_type = 'email.clicked') as unique_clicks,
  min(event_created_at) filter (where event_type = 'email.clicked') as first_click_at,
  max(event_created_at) filter (where event_type = 'email.clicked') as last_click_at
from public.newsletter_events
where click_link is not null and click_link <> ''
group by campaign, click_link
order by unique_clicks desc, total_clicks desc;
