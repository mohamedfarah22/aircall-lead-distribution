create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  phone text not null unique
);
