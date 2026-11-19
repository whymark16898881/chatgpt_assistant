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

Ordinary receipts and expenses use personal-wide settlement aggregates in 0.4.1: a specific bank or wallet is optional, currency is explicit, credit purchases remain liabilities, and unknown settlement stays pending. The aggregates are accounting nodes, not verified institution balances.

The 0.4.2 receipt library supports individual/batch deletion, clearing across all pages, a restorable recycle bin and explicit permanent-original removal. Financial records remain intact; transaction details identify missing originals. Permanent removal affects current files, while existing private backups remain subject to their own retention.

Version 0.4.3 adds single/batch transaction deletion and restoration with matching original-period statement effects and append-only journal history. The sidebar prioritizes summary reports and everyday work, with muted investment-source and opening setup links at the bottom. File deletion and transaction deletion remain separate.

Version 0.4.4 adds a CNY/USD/SGD display selector and automatically refreshed, dated exchange quotes. Original native amounts and historical CNY postings stay intact. Complete-journal translation and reversal-chain rounding keep displayed statements, analysis and action previews consistent. ExchangeRate-API is the primary source, with ECB/Frankfurter fallback; outages never imply a 1:1 exchange rate.

Version 0.4.5 separates saving draft supplements from posting, adds atomic batch review and a table editor, server-side 20-row ledger pagination, optional zero-value visibility, wrapped descriptions and a collapsible desktop sidebar. Opening balances stay fixed to the ledger start date; broker references remain separate until supported opening facts are confirmed.

Version 0.4.6 adds source-linked broker ledger reconciliation: validated historical openings use historical FX; only independently reconciled, contiguous periods can post funding, investment return and FX journals. Missing transfer coverage, duplicate manual balances, source revisions and user reversals remain explicit blockers. Current NAV stays visibly separate from verified book values.
