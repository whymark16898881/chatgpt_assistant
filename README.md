# Personal CFO

Self-hosted personal accounting application with a password-protected web UI, PostgreSQL ledger, receipt archive, and read-only account-level investment results.

## Deployment and updates

See [GitHub deployment](docs/GITHUB_DEPLOYMENT.md). The existing NAS installation keeps its database, receipts, credentials and Cloudflare connector. Production updates follow the `stable` branch; development commits on `main` do not deploy automatically.

## Development

Requires Node.js 24+ and Docker. Run `npm ci`, `npm run typecheck`, and `npm run build`. Database tests require an isolated test database configured in a local `.env.test`; never use a production database for tests. Run `npm test`.

## Data boundaries

Secrets, financial data, source exports, receipts and private backups are not part of this repository. Investment synchronization reads published files and does not contact broker gateways or automatically post financial transactions. Fixtures under `tests/fixtures` are synthetic and cannot be used as real account results.

## ChatGPT screenshot bookkeeping

See [formal ChatGPT connection](docs/CHATGPT_CONNECTION.md). Website availability alone does not install the ChatGPT plugin.

For unified receipts across multiple attachments, see [batch bookkeeping](docs/BATCH_BOOKKEEPING.md).

## Receipt structure and drilldown

Version 0.4.0 adds versioned recognition facts, hierarchical analysis categories and the authenticated **分类与凭证** view: posted income/expense → category → transaction → original document. Financial classifications remain tied to actual journal accounts; analysis labels do not rewrite past postings. See [normalized recognition](docs/NORMALIZED_RECOGNITION.md) and [field coverage](docs/FIELD_COVERAGE.md).
