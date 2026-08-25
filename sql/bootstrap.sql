-- Applied as a Supabase migration and also documented here.
-- Inbox rows are never deleted; statuses are only marked.

CREATE TABLE IF NOT EXISTS public.sg_engager_suppression (
  domain text PRIMARY KEY,
  reason text,
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sg_worker_spend (
  month_key text PRIMARY KEY,
  spend_cents numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.sg_engager_suppression (domain, reason) VALUES
  ('trumethods.com', 'creator'),
  ('technologymarketingtoolkit.com', 'creator'),
  ('tallannresources.com', 'creator'),
  ('staffingmastery.com', 'creator'),
  ('salesglidergrowth.com', 'creator'),
  ('crelate.com', 'competitor'),
  ('haleymarketing.com', 'competitor'),
  ('axial.net', 'competitor'),
  ('dealroom.net', 'competitor'),
  ('mascience.com', 'competitor')
ON CONFLICT (domain) DO NOTHING;

ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS mv_result text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS n2b_status text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS verification_source text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS imported_at timestamptz;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS smartlead_lead_id text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS mv_file_id text;

ALTER TABLE public.leads_staging ADD COLUMN IF NOT EXISTS linkedin_profile text;
ALTER TABLE public.leads_staging ADD COLUMN IF NOT EXISTS source_dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_staging_source_dedupe_key_uidx
  ON public.leads_staging (source_dedupe_key)
  WHERE source_dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS sg_engager_inbox_status_id_idx
  ON public.sg_engager_inbox (status, id);

CREATE INDEX IF NOT EXISTS sg_engager_inbox_email_lower_idx
  ON public.sg_engager_inbox (lower(engager_email));

ALTER TABLE public.sg_engager_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sg_worker_spend ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sg_engager_suppression TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sg_worker_spend TO service_role;

CREATE OR REPLACE FUNCTION public.claim_sg_engager_inbox(p_limit integer DEFAULT 500)
RETURNS SETOF public.sg_engager_inbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.sg_engager_inbox AS t
  SET status = 'verifying',
      processed_at = now()
  FROM (
    SELECT i.id
    FROM public.sg_engager_inbox i
    WHERE i.status = 'pending_verification'
    ORDER BY i.id
    LIMIT GREATEST(COALESCE(p_limit, 500), 0)
    FOR UPDATE SKIP LOCKED
  ) AS claimed
  WHERE t.id = claimed.id
  RETURNING t.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.sg_engager_reclaim_stale(p_minutes integer DEFAULT 45)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.sg_engager_inbox
  SET status = 'pending_verification'
  WHERE status = 'verifying'
    AND COALESCE(processed_at, received_at) < now() - make_interval(mins => GREATEST(COALESCE(p_minutes, 45), 1));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.sg_engager_inbox_by_emails(p_emails text[])
RETURNS TABLE (id bigint, dedupe_key text, engager_email text, status text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.dedupe_key, i.engager_email, i.status
  FROM public.sg_engager_inbox i
  WHERE lower(i.engager_email) = ANY (
    SELECT lower(x) FROM unnest(p_emails) AS x
  );
$$;

CREATE OR REPLACE FUNCTION public.sg_engager_spend_state(p_month text)
RETURNS public.sg_worker_spend
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.sg_worker_spend;
BEGIN
  INSERT INTO public.sg_worker_spend (month_key, spend_cents)
  VALUES (p_month, 0)
  ON CONFLICT (month_key) DO UPDATE
    SET month_key = EXCLUDED.month_key
  RETURNING * INTO rec;
  RETURN rec;
END;
$$;

CREATE OR REPLACE FUNCTION public.sg_engager_add_spend(p_month text, p_cents numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v numeric;
BEGIN
  INSERT INTO public.sg_worker_spend (month_key, spend_cents)
  VALUES (p_month, COALESCE(p_cents, 0))
  ON CONFLICT (month_key) DO UPDATE
    SET spend_cents = public.sg_worker_spend.spend_cents + EXCLUDED.spend_cents,
        updated_at = now()
  RETURNING spend_cents INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.sg_engager_bootstrap()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.sg_engager_suppression (domain, reason) VALUES
    ('trumethods.com', 'creator'),
    ('technologymarketingtoolkit.com', 'creator'),
    ('tallannresources.com', 'creator'),
    ('staffingmastery.com', 'creator'),
    ('salesglidergrowth.com', 'creator'),
    ('crelate.com', 'competitor'),
    ('haleymarketing.com', 'competitor'),
    ('axial.net', 'competitor'),
    ('dealroom.net', 'competitor'),
    ('mascience.com', 'competitor')
  ON CONFLICT (domain) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_sg_engager_inbox(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sg_engager_reclaim_stale(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sg_engager_inbox_by_emails(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sg_engager_spend_state(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sg_engager_add_spend(text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sg_engager_bootstrap() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_sg_engager_inbox(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_engager_reclaim_stale(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_engager_inbox_by_emails(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_engager_spend_state(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_engager_add_spend(text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_engager_bootstrap() TO service_role;
