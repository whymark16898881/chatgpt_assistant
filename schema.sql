CREATE TABLE IF NOT EXISTS cfo_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  kind text NOT NULL, account_group text NOT NULL CHECK(account_group IN ('asset','liability','equity','income','expense')),
  currency text NOT NULL CHECK(currency IN ('CNY','SGD','USD','HKD','EUR','GBP')),
  is_cash boolean NOT NULL DEFAULT false, opening_confirmed boolean NOT NULL DEFAULT false,
  system_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(name,currency)
);
-- Statement-wide settlement nodes are accounting aggregates, not identified bank accounts.
ALTER TABLE cfo_accounts ADD COLUMN IF NOT EXISTS summary_kind text CHECK(summary_kind IN ('cash','payable'));
CREATE UNIQUE INDEX IF NOT EXISTS cfo_summary_currency ON cfo_accounts(currency,summary_kind) WHERE summary_kind IS NOT NULL;
CREATE TABLE IF NOT EXISTS cfo_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sha256 text UNIQUE NOT NULL,
  filename text NOT NULL, mime_type text NOT NULL, bytes integer NOT NULL CHECK(bytes>0),
  stored_path text NOT NULL, archived_at timestamptz NOT NULL DEFAULT now()
);
-- Recycle bin and permanent original removal preserve journal/reference identity.
ALTER TABLE cfo_documents ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
ALTER TABLE cfo_documents ADD COLUMN IF NOT EXISTS purge_requested_at timestamptz;
ALTER TABLE cfo_documents ADD COLUMN IF NOT EXISTS file_removed_at timestamptz;
ALTER TABLE cfo_documents ADD COLUMN IF NOT EXISTS lifecycle_revision integer NOT NULL DEFAULT 0;
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

-- Normalized recognition facts; additive and separate from immutable journal amounts.
CREATE TABLE IF NOT EXISTS cfo_classification_nodes (
 tree text NOT NULL CHECK(tree IN ('financial','analysis')), code text NOT NULL,
 parent_code text, name text NOT NULL, business_group text NOT NULL CHECK(business_group IN ('asset','liability','equity','income','expense')),
 financial_account_id uuid REFERENCES cfo_accounts(id),
 PRIMARY KEY(tree,code), FOREIGN KEY(tree,parent_code) REFERENCES cfo_classification_nodes(tree,code),
 CHECK(parent_code IS NULL OR parent_code<>code),CHECK(tree='financial' OR financial_account_id IS NULL)
);
CREATE OR REPLACE FUNCTION cfo_check_classification_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_group text; cycle_found boolean;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.tree<>OLD.tree OR NEW.code<>OLD.code OR NEW.business_group<>OLD.business_group) THEN RAISE EXCEPTION 'Classification identity is stable'; END IF;
 IF NEW.parent_code IS NULL THEN RETURN NEW; END IF;
 SELECT business_group INTO parent_group FROM cfo_classification_nodes WHERE tree=NEW.tree AND code=NEW.parent_code;
 IF parent_group IS DISTINCT FROM NEW.business_group THEN RAISE EXCEPTION 'Classification parent has a different business group'; END IF;
 WITH RECURSIVE chain AS (
  SELECT code,parent_code FROM cfo_classification_nodes WHERE tree=NEW.tree AND code=NEW.parent_code
  UNION SELECT n.code,n.parent_code FROM cfo_classification_nodes n JOIN chain p ON n.code=p.parent_code WHERE n.tree=NEW.tree
 ) SELECT EXISTS(SELECT 1 FROM chain WHERE code=NEW.code) INTO cycle_found;
 IF cycle_found THEN RAISE EXCEPTION 'Classification cycle'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cfo_classification_parent_check ON cfo_classification_nodes;
CREATE TRIGGER cfo_classification_parent_check BEFORE INSERT OR UPDATE ON cfo_classification_nodes FOR EACH ROW EXECUTE FUNCTION cfo_check_classification_parent();
CREATE TABLE IF NOT EXISTS cfo_recognition_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES cfo_events(id),
 revision integer NOT NULL CHECK(revision>0), content_hash text NOT NULL, core_basis_hash text NOT NULL DEFAULT '',
 allocation_status text NOT NULL CHECK(allocation_status IN ('not_itemized','complete','partial')),
 merchant text, occurred_time time, time_precision text NOT NULL CHECK(time_precision IN ('unknown','date','minute','second')),
 timezone text, payment_channel text, raw_payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,revision)
);
CREATE TABLE IF NOT EXISTS cfo_recognition_item_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL REFERENCES cfo_events(id),
 item_ref text NOT NULL, UNIQUE(event_id,item_ref),UNIQUE(id,event_id)
);
CREATE TABLE IF NOT EXISTS cfo_recognition_items (
 recognition_id uuid NOT NULL REFERENCES cfo_recognition_versions(id), event_id uuid NOT NULL REFERENCES cfo_events(id),
 item_id uuid NOT NULL, item_ref text NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0),
 description text, amount_minor bigint CHECK(amount_minor>=0), currency text CHECK(currency IN ('CNY','SGD','USD','HKD','EUR','GBP')),
 category_tree text NOT NULL DEFAULT 'analysis' CHECK(category_tree='analysis'),category_code text,
 merchant text, meal_type text CHECK(meal_type IN ('breakfast','lunch','dinner','snack','unknown','not_applicable')),
 basis text NOT NULL CHECK(basis IN ('explicit_item','transaction_total')),
 PRIMARY KEY(recognition_id,item_id),UNIQUE(recognition_id,item_ref),
 FOREIGN KEY(item_id,event_id) REFERENCES cfo_recognition_item_keys(id,event_id),
 FOREIGN KEY(category_tree,category_code) REFERENCES cfo_classification_nodes(tree,code)
);
CREATE TABLE IF NOT EXISTS cfo_field_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recognition_id uuid NOT NULL REFERENCES cfo_recognition_versions(id),
 event_id uuid NOT NULL REFERENCES cfo_events(id),item_id uuid,field_name text NOT NULL,
 observed_value jsonb NOT NULL,value_status text NOT NULL CHECK(value_status IN ('found','missing','ambiguous','conflicting','not_applicable')),
 origin text NOT NULL CHECK(origin IN ('original','cross_document','user_provided','derived')),
 verification text NOT NULL CHECK(verification IN ('unverified','user_confirmed')),
 document_id uuid REFERENCES cfo_documents(id),source_ref text,page integer CHECK(page>0),bounding_box jsonb,
 raw_text text,reason text,
 FOREIGN KEY(item_id,event_id) REFERENCES cfo_recognition_item_keys(id,event_id),
 FOREIGN KEY(recognition_id,item_id) REFERENCES cfo_recognition_items(recognition_id,item_id)
);
CREATE OR REPLACE FUNCTION cfo_check_recognition_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cfo_recognition_versions r WHERE r.id=NEW.recognition_id AND r.event_id=NEW.event_id) THEN RAISE EXCEPTION 'Recognition event mismatch'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cfo_recognition_item_owner ON cfo_recognition_items;
CREATE TRIGGER cfo_recognition_item_owner BEFORE INSERT ON cfo_recognition_items FOR EACH ROW EXECUTE FUNCTION cfo_check_recognition_owner();
DROP TRIGGER IF EXISTS cfo_recognition_observation_owner ON cfo_field_observations;
CREATE TRIGGER cfo_recognition_observation_owner BEFORE INSERT ON cfo_field_observations FOR EACH ROW EXECUTE FUNCTION cfo_check_recognition_owner();
-- Recognition history is append-only. Truncation is only used by isolated tests.
DO $$ DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['cfo_recognition_versions','cfo_recognition_item_keys','cfo_recognition_items','cfo_field_observations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=table_name||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cfo_immutable_journal()',table_name||'_immutable',table_name);
  END IF;
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS cfo_recognition_event ON cfo_recognition_versions(event_id,revision DESC);
CREATE INDEX IF NOT EXISTS cfo_recognition_items_version ON cfo_recognition_items(recognition_id,ordinal);
CREATE INDEX IF NOT EXISTS cfo_field_observation_document ON cfo_field_observations(document_id);

ALTER TABLE cfo_recognition_versions ADD COLUMN IF NOT EXISTS core_basis_hash text NOT NULL DEFAULT '';

-- Deleted transactions retain their sources and immutable financial history.
ALTER TABLE cfo_events ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE cfo_events ADD COLUMN IF NOT EXISTS deleted_status text CHECK(deleted_status IN ('draft','posted','reversed','discarded'));
ALTER TABLE cfo_events ADD COLUMN IF NOT EXISTS deleted_reversal_id uuid REFERENCES cfo_entries(id);
CREATE INDEX IF NOT EXISTS cfo_deleted_events ON cfo_events(deleted_at) WHERE deleted_at IS NOT NULL;

-- Public market quotes used only for display, never for posting or revaluation.
CREATE TABLE IF NOT EXISTS cfo_presentation_rates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),rate_date date NOT NULL,
 provider text NOT NULL,rates jsonb NOT NULL,source_url text NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cfo_presentation_rates_latest ON cfo_presentation_rates(rate_date DESC,fetched_at DESC);
