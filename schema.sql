CREATE TABLE IF NOT EXISTS cfo_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  kind text NOT NULL, account_group text NOT NULL CHECK(account_group IN ('asset','liability','equity','income','expense')),
  currency text NOT NULL CHECK(currency IN ('CNY','SGD','USD','HKD','EUR','GBP')),
  is_cash boolean NOT NULL DEFAULT false, opening_confirmed boolean NOT NULL DEFAULT false,
  system_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(name,currency)
);
CREATE TABLE IF NOT EXISTS cfo_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sha256 text UNIQUE NOT NULL,
  filename text NOT NULL, mime_type text NOT NULL, bytes integer NOT NULL CHECK(bytes>0),
  stored_path text NOT NULL, archived_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cfo_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid REFERENCES cfo_documents,
  source_ref text NOT NULL, request_key text UNIQUE NOT NULL,
  payload jsonb NOT NULL, issues jsonb NOT NULL DEFAULT '[]',
  revision integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK(status IN ('draft','posted','reversed','discarded')) DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,source_ref)
);
ALTER TABLE cfo_events ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS cfo_event_sources (
  document_id uuid NOT NULL REFERENCES cfo_documents, source_ref text NOT NULL,
  event_id uuid NOT NULL REFERENCES cfo_events, PRIMARY KEY(document_id,source_ref)
);
CREATE TABLE IF NOT EXISTS cfo_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid UNIQUE REFERENCES cfo_events,
  entry_date date NOT NULL, description text NOT NULL, kind text NOT NULL,
  cash_flow_bucket text NOT NULL CHECK(cash_flow_bucket IN ('operating','investing','financing','opening','noncash')),
  reverses_id uuid UNIQUE REFERENCES cfo_entries, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cfo_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES cfo_entries, account_id uuid NOT NULL REFERENCES cfo_accounts,
  native_cents bigint NOT NULL, cny_cents bigint NOT NULL,
  fx_rate numeric(24,12) NOT NULL CHECK(fx_rate>0), fx_source text NOT NULL
);
CREATE INDEX IF NOT EXISTS cfo_lines_account ON cfo_lines(account_id);
CREATE INDEX IF NOT EXISTS cfo_entries_date ON cfo_entries(entry_date);
CREATE TABLE IF NOT EXISTS cfo_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, action text NOT NULL,
  entity_id uuid NOT NULL, details jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION cfo_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; line_count integer;
BEGIN
 SELECT sum(cny_cents),count(*) INTO total,line_count FROM cfo_lines WHERE entry_id=NEW.entry_id;
 IF total<>0 OR line_count<2 THEN RAISE EXCEPTION 'Unbalanced journal entry'; END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='cfo_balanced_entry') THEN
  CREATE CONSTRAINT TRIGGER cfo_balanced_entry AFTER INSERT OR UPDATE ON cfo_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cfo_check_balance();
 END IF;
END $$;
-- Posted journal history is append-only. Corrections add reversing entries.
CREATE OR REPLACE FUNCTION cfo_immutable_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Journal history is immutable; use a reversal'; END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='cfo_lines_immutable') THEN
  CREATE TRIGGER cfo_lines_immutable BEFORE UPDATE OR DELETE ON cfo_lines FOR EACH ROW EXECUTE FUNCTION cfo_immutable_journal();
  CREATE TRIGGER cfo_entries_immutable BEFORE UPDATE OR DELETE ON cfo_entries FOR EACH ROW EXECUTE FUNCTION cfo_immutable_journal();
 END IF;
END $$;
-- Investment source snapshots are staging/read models, never automatic journals.
CREATE TABLE IF NOT EXISTS cfo_investment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL, snapshot_key text NOT NULL, revision integer NOT NULL CHECK(revision>=1),
  as_of timestamptz NOT NULL, data_type text NOT NULL CHECK(data_type IN ('live','test')),
  payload_hash text NOT NULL, payload jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source,snapshot_key,revision)
);
CREATE INDEX IF NOT EXISTS cfo_investment_source_time ON cfo_investment_snapshots(source,as_of DESC,revision DESC);
CREATE TABLE IF NOT EXISTS cfo_portfolio_ingests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fingerprint text UNIQUE NOT NULL,
 status text NOT NULL CHECK(status IN ('quarantined','ready')),
 generated_at timestamptz NOT NULL, issues jsonb NOT NULL,
 metadata jsonb NOT NULL, raw_files jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cfo_portfolio_sync_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 at timestamptz NOT NULL DEFAULT now(), status text NOT NULL CHECK(status IN ('ready','quarantined','failed')),
 code text NOT NULL, export_id text
);
CREATE INDEX IF NOT EXISTS cfo_portfolio_ingests_time ON cfo_portfolio_ingests(imported_at DESC);
CREATE TABLE IF NOT EXISTS cfo_account_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), logical_key text NOT NULL,
 revision integer NOT NULL CHECK(revision>=0), payload_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('balance','period')), as_of timestamptz,
 period_start date, period_end date, status text NOT NULL,
 payload jsonb NOT NULL, export_id text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(logical_key,revision)
);
