-- SalesGlider engager pipeline schema.
-- Inbox rows are never deleted. Statuses are marked in place.

CREATE TABLE IF NOT EXISTS public.sg_engager_suppression (
  domain text PRIMARY KEY,
  reason text,
  added_at timestamptz NOT NULL DEFAULT now()
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

CREATE TABLE IF NOT EXISTS public.sg_pipeline_spend (
  month_key text PRIMARY KEY,
  apify_cents numeric NOT NULL DEFAULT 0,
  waterfall_cents numeric NOT NULL DEFAULT 0,
  verifier_cents numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sg_pipeline_hwm (
  profile_id text PRIMARY KEY,
  captured_at_hwm timestamptz,
  last_scraped_at timestamptz,
  last_run_at timestamptz,
  last_pulled integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.sg_pipeline_first_run (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sg_pipeline_feeds (
  id text PRIMARY KEY,
  csv text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS mv_result text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS n2b_status text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS verification_source text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS imported_at timestamptz;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS smartlead_lead_id text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS mv_file_id text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS resolution_attempts integer DEFAULT 0;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS last_resolution_at timestamptz;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS company_source text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS engager_job_title text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS company_domain text;
ALTER TABLE public.sg_engager_inbox ADD COLUMN IF NOT EXISTS employment_mismatch boolean;

ALTER TABLE public.leads_staging ADD COLUMN IF NOT EXISTS linkedin_profile text;
ALTER TABLE public.leads_staging ADD COLUMN IF NOT EXISTS source_dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_staging_source_dedupe_key_uidx
  ON public.leads_staging (source_dedupe_key)
  WHERE source_dedupe_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leads_staging_source_dedupe_key_key'
      AND conrelid = 'public.leads_staging'::regclass
  ) THEN
    ALTER TABLE public.leads_staging
      ADD CONSTRAINT leads_staging_source_dedupe_key_key UNIQUE (source_dedupe_key);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS sg_engager_inbox_status_id_idx
  ON public.sg_engager_inbox (status, id);

CREATE INDEX IF NOT EXISTS sg_engager_inbox_email_lower_idx
  ON public.sg_engager_inbox (lower(engager_email));

ALTER TABLE public.sg_engager_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sg_pipeline_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sg_pipeline_hwm ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sg_pipeline_first_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sg_pipeline_feeds ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sg_engager_suppression TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sg_pipeline_spend TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sg_pipeline_hwm TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sg_pipeline_first_run TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sg_pipeline_feeds TO service_role;

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

CREATE OR REPLACE FUNCTION public.sg_pipeline_spend_state(p_month text)
RETURNS public.sg_pipeline_spend
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.sg_pipeline_spend;
BEGIN
  INSERT INTO public.sg_pipeline_spend (month_key)
  VALUES (p_month)
  ON CONFLICT (month_key) DO UPDATE
    SET month_key = EXCLUDED.month_key
  RETURNING * INTO rec;
  RETURN rec;
END;
$$;

CREATE OR REPLACE FUNCTION public.sg_pipeline_add_spend(p_month text, p_vendor text, p_cents numeric)
RETURNS public.sg_pipeline_spend
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.sg_pipeline_spend;
BEGIN
  INSERT INTO public.sg_pipeline_spend (month_key)
  VALUES (p_month)
  ON CONFLICT (month_key) DO NOTHING;

  IF p_vendor = 'apify' THEN
    UPDATE public.sg_pipeline_spend
    SET apify_cents = apify_cents + COALESCE(p_cents, 0), updated_at = now()
    WHERE month_key = p_month
    RETURNING * INTO rec;
  ELSIF p_vendor = 'waterfall' THEN
    UPDATE public.sg_pipeline_spend
    SET waterfall_cents = waterfall_cents + COALESCE(p_cents, 0), updated_at = now()
    WHERE month_key = p_month
    RETURNING * INTO rec;
  ELSIF p_vendor = 'verifier' THEN
    UPDATE public.sg_pipeline_spend
    SET verifier_cents = verifier_cents + COALESCE(p_cents, 0), updated_at = now()
    WHERE month_key = p_month
    RETURNING * INTO rec;
  ELSE
    RAISE EXCEPTION 'unknown vendor %', p_vendor;
  END IF;
  RETURN rec;
END;
$$;

CREATE OR REPLACE FUNCTION public.sg_pipeline_status_counts()
RETURNS TABLE (status text, n bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.status, count(*)::bigint
  FROM public.sg_engager_inbox i
  GROUP BY i.status;
$$;

CREATE OR REPLACE FUNCTION public.sg_pipeline_bootstrap()
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
REVOKE ALL ON FUNCTION public.sg_pipeline_spend_state(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sg_pipeline_add_spend(text, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sg_pipeline_status_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sg_pipeline_bootstrap() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_sg_engager_inbox(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_engager_reclaim_stale(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_engager_inbox_by_emails(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_pipeline_spend_state(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_pipeline_add_spend(text, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_pipeline_status_counts() TO service_role;
GRANT EXECUTE ON FUNCTION public.sg_pipeline_bootstrap() TO service_role;
