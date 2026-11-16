-- Staged additive migration. Not loaded by connectDatabase or the NAS updater.
-- Apply in isolated *_test databases for review until production field audit is available.
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
 revision integer NOT NULL CHECK(revision>0), content_hash text NOT NULL,
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
