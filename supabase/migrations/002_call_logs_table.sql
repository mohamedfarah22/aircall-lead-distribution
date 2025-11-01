create table if not exists public.call_logs (
  id                       uuid primary key default gen_random_uuid(),
  call_sid                 text unique not null,
  partner_id               uuid not null references public.partners(id) on delete cascade,
  customer_number          text not null,
  created_at               timestamp not null default (now() at time zone 'Australia/Melbourne'),
  call_direction           text not null check (call_direction in ('incoming', 'outgoing')),
  duration                 integer check (duration >= 0),
  recording_url            text,
  transcription            text,
  chargeable               boolean not null default false,
  call_status              text not null check (call_status in ('answered', 'missed')),
  voicemail                boolean not null default false,
  voicemail_transcription  text default NULL,
  missed_by                text check (missed_by in ('customer', 'partner')),

  -- integrity: missed_by only when status = 'missed'
  constraint call_logs_missed_by_when_missed
    check (
      (call_status = 'answered' and missed_by is null) or
      (call_status = 'missed'   and missed_by is not null)
    ),

  -- voicemail implies a missed call
  constraint call_logs_voicemail_only_when_missed
    check (voicemail = false or call_status = 'missed')
);
