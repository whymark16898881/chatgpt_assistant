import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PORTFOLIO_FILES} from '../lib/portfolio-manifest.mjs';
import {tmpdir} from 'node:os';
import {connectDatabase} from '../lib/db.mjs';
import {inspectPortfolioFiles,readPortfolioFiles,syncPortfolioSource,portfolioSourceStatus} from '../lib/portfolio-source.mjs';
import {investmentOverview} from '../lib/investments.mjs';
import {foreignUsdToCny,usdForeignToCny,fetchInvestmentFx} from '../lib/investment-fx.mjs';
if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Isolated test database required');
const pool=await connectDatabase();after(()=>pool.end());const now=()=>Date.parse('2026-11-15T04:00:00Z');
function seal(f){
 const p=JSON.parse(f['positions_latest.json']);const m={schema:'cfo-export/v1',export_id:'test-export-'+createHash('sha256').update(JSON.stringify(f)).digest('hex').slice(0,8),exported_at:'2026-11-15T11:20:00+08:00',source:{snapshot_id:p.snapshot_id,generated_at:p.generated_at,complete:p.complete,stale:p.stale,coverage:p.coverage},files:PORTFOLIO_FILES.map(name=>{if(f[name]===undefined)f[name]='';return{name,status:'ok',bytes:Buffer.byteLength(f[name]),sha256:createHash('sha256').update(f[name]).digest('hex'),source_mtime:'2026-11-12T00:00:00+08:00'};})};f['manifest.json']=JSON.stringify(m);return f;
}
function files({complete=false,missingBroker=false}={}){
 const p={schema:'positions_latest/v1',source:'portfolio_sync',generated_at:'2026-11-15T11:16:44+08:00',stale:false,stocks:[{ticker:'TEST',stock_qty:10,stock_cost:5,net_cost:1,value:60}],options:[{display:'TEST 261218 90P',ticker:'TEST',qty:-2,current_price:30,pnl:-20}],strategy:{targets:[{ticker:'NOT_AN_ASSET',actual_pct:null}],cash_reserve_usd:999999}};
 p.complete=complete;p.snapshot_id='test-batch-1';p.coverage={moomoo:{ok:complete?true:null},tiger:{ok:complete?true:null},futubull:{ok:complete?true:null}};
 const r={ts:'2026-11-15 11:15:36',brokers:Object.fromEntries(['moomoo','tiger','futubull'].map(b=>[b,{broker:{total_assets:100,cash:-10,market_val:110,power:99999},derived:{net_mv_x:999999},_all:{}}]))};if(missingBroker)delete r.brokers.futubull;
 return seal({'positions_latest.json':JSON.stringify(p),'account_risk_latest.json':JSON.stringify(r),'trades.csv':'dt,broker,deal_id,code,symbol,sectype,side,signed_qty,price,mult,fee\n2026-11-14 22:00:00,moomoo,1,US.TEST,TEST,STK,BUY,1,5,1,0\n2026-11-14 22:00:00,ibkr,old,US.OLD,OLD,STK,BUY,1,5,1,0\n','external_flows.csv':'date,broker,type,amount_usd\n2026-11-14,moomoo,入金,100\n2026-11-14,moomoo,入金,100\n2026-11-14,moomoo,已核对无流水,0\n'});
}
async function directory(data){seal(data);const dir=await mkdtemp(path.join(tmpdir(),'portfolio-ro-'));for(const[n,t]of Object.entries(data))await writeFile(path.join(dir,n),t,{mode:0o444});return dir;}
test('existing upstream shape without complete is quarantined and strategy targets/reserve never become assets',()=>{
 const r=inspectPortfolioFiles(files(),{now});assert.equal(r.status,'quarantined');assert.ok(r.issues.some(x=>x.includes('complete')));assert.equal(r.metadata.stocks_count,1);assert.equal(r.metadata.options_count,1);assert.equal(r.metadata.aggregate_positions.length,2);assert.equal(r.snapshot.accounts.length,3);assert.equal(r.snapshot.accounts[0].net_liquidation_value,'100');assert.equal(r.snapshot.accounts[0].cash_balances[0].amount,'-10');assert.equal(r.snapshot.accounts[0].positions_complete,false);assert.equal(r.metadata.trade_count,1);assert.equal(r.metadata.aggregate_positions[1].market_value,null);assert.equal(r.metadata.aggregate_positions[1].quantity,'-2');
});
test('same-day same-amount cash rows are preserved separately; verification markers excluded',()=>{const r=inspectPortfolioFiles(files(),{now});assert.equal(r.metadata.cash_candidates.length,2);assert.deepEqual(r.metadata.cash_candidates.map(x=>x.occurrence),[1,2]);assert.ok(r.metadata.cash_candidates.every(x=>x.needs_review));});
test('complete true with one broker failure is still rejected; stale or mixed-batch data rejected',()=>{
 const f=files({complete:true});const p=JSON.parse(f['positions_latest.json']);p.coverage.futubull.ok=false;f['positions_latest.json']=JSON.stringify(p);assert.equal(inspectPortfolioFiles(seal(f),{now}).status,'quarantined');assert.equal(inspectPortfolioFiles(files({complete:true,missingBroker:true}),{now}).status,'quarantined');assert.equal(inspectPortfolioFiles(files({complete:true}),{now:()=>now()+2*3600000}).status,'quarantined');const mixed=files({complete:true});const risk=JSON.parse(mixed['account_risk_latest.json']);risk.ts='2026-11-15 10:15:36';mixed['account_risk_latest.json']=JSON.stringify(risk);assert.ok(inspectPortfolioFiles(seal(mixed),{now}).issues.some(x=>x.includes('账户观测超过90分钟')));
});
test('readonly source sync archives original text and is idempotent without accounting writes',async()=>{
 await pool.query('TRUNCATE cfo_investment_snapshots,cfo_portfolio_ingests');const f=files(),dir=await directory(f);const before=(await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count;
 try{const first=await syncPortfolioSource(pool,dir,{now}),again=await syncPortfolioSource(pool,dir,{now});assert.equal(first.status,'quarantined');assert.equal(first.financial_transaction_posted,false);assert.equal(again.reused,true);assert.equal(first.id,again.id);assert.equal((await investmentOverview(pool,{now})).connected,false);assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,before);assert.equal(await readFile(path.join(dir,'positions_latest.json'),'utf8'),f['positions_latest.json']);const raw=(await pool.query('SELECT raw_files FROM cfo_portfolio_ingests')).rows[0].raw_files;assert.equal(raw['trades.csv'],f['trades.csv']);const status=await portfolioSourceStatus(pool,{now});assert.equal(status.metadata.cash_candidates,undefined);}finally{await rm(dir,{recursive:true,force:true});}
});
test('verified coverage can promote only account NAV and remains non-posting; USD stays USD without trusted FX',async()=>{
 await pool.query('TRUNCATE cfo_investment_snapshots,cfo_portfolio_ingests');const dir=await directory(files({complete:true}));
 try{const result=await syncPortfolioSource(pool,dir,{now});assert.equal(result.status,'ready');assert.equal(result.accepted_snapshot.financial_transaction_posted,false);const v=await investmentOverview(pool,{now});assert.equal(v.sources[0].accounts[0].net_liquidation_value,'100');assert.equal(v.sources[0].accounts[0].cny_net_liquidation_value,null);assert.equal(v.reported_net_assets_cny,null);}finally{await rm(dir,{recursive:true,force:true});}
});
test('fixed source allowlist never reads IBKR residue or unversioned history; symlinks rejected',async()=>{
 const dir=await directory({...files(),'ibkr_last_snapshot.json':'PRIVATE','history.csv':'UNVERSIONED'});
 try{const r=await readPortfolioFiles(dir);assert.equal(r['ibkr_last_snapshot.json'],undefined);assert.equal(r['history.csv'],undefined);await rm(path.join(dir,'positions_latest.json'));await symlink(path.join(dir,'account_risk_latest.json'),path.join(dir,'positions_latest.json'));await assert.rejects(readPortfolioFiles(dir),e=>e.code==='INVALID_SOURCE');}finally{await rm(dir,{recursive:true,force:true});}
});
test('FX direction is explicit and independent reference quote is validated',async()=>{
 assert.equal(foreignUsdToCny('0.125','7'),'0.875');assert.equal(usdForeignToCny('8','7'),'0.875000000000');const quote=await fetchInvestmentFx({now,fetcher:async()=>({ok:true,text:async()=>JSON.stringify({base:'USD',date:'2026-11-13',rates:{CNY:7}})})});assert.equal(quote.rate_to_cny,'7');await assert.rejects(fetchInvestmentFx({now,fetcher:async()=>({ok:true,text:async()=>JSON.stringify({base:'CNY',date:'2026-11-13',rates:{CNY:7}})})}));
});
test('adding a validated valuation rate creates an explicit local revision, not a source conflict or journal',async()=>{
 await pool.query('TRUNCATE cfo_investment_snapshots,cfo_portfolio_ingests');const dir=await directory(files({complete:true}));
 try{await syncPortfolioSource(pool,dir,{now});const fxQuote={rate_to_cny:'7',as_of:'2026-11-13T00:00:00Z',source:'synthetic reference rate'};const r=await syncPortfolioSource(pool,dir,{now,fxQuote});assert.equal(r.status,'ready');const v=await investmentOverview(pool,{now});assert.equal(v.sources[0].revision,2);assert.equal(v.reported_net_assets_cny,'2100.00');const same=await syncPortfolioSource(pool,dir,{now,fxQuote});assert.equal(same.accepted_snapshot.reused,true);}finally{await rm(dir,{recursive:true,force:true});}
});

test('separate fresh account/position observations keep their true timestamps without fake same-batch values',()=>{
 const f=files({complete:true});const risk=JSON.parse(f['account_risk_latest.json']);risk.ts='2026-11-15 10:55:36';f['account_risk_latest.json']=JSON.stringify(risk);const r=inspectPortfolioFiles(seal(f),{now});assert.equal(r.status,'ready');assert.equal(r.snapshot.as_of,'2026-11-15T10:55:36+08:00');assert.equal(r.metadata.generated_at,'2026-11-15T11:16:44+08:00');assert.ok(r.metadata.warnings.some(x=>x.includes('不同时间')));
});
test('valid empty portfolio with successful zero-count coverage is not mistaken for an outage',()=>{
 const f=files({complete:true});const p=JSON.parse(f['positions_latest.json']);p.stocks=[];p.options=[];p.stale=true;for(const v of Object.values(p.coverage)){v.n_stk=0;v.n_opt=0;}f['positions_latest.json']=JSON.stringify(p);const r=inspectPortfolioFiles(seal(f),{now});assert.equal(r.status,'ready');assert.ok(r.metadata.warnings.some(x=>x.includes('正常空仓')));
});
test('bad subsequent export records failure and preserves the last accepted account observation',async()=>{
 await pool.query('TRUNCATE cfo_investment_snapshots,cfo_portfolio_ingests,cfo_portfolio_sync_attempts');const dir=await directory(files({complete:true}));
 try{await syncPortfolioSource(pool,dir,{now});const before=await investmentOverview(pool,{now});const{chmod}=await import('node:fs/promises');await chmod(path.join(dir,'trades.csv'),0o600);await writeFile(path.join(dir,'trades.csv'),'corrupted export');await assert.rejects(syncPortfolioSource(pool,dir,{now}),e=>e.code==='HASH_MISMATCH');const after=await investmentOverview(pool,{now});assert.deepEqual(after,before);const s=await portfolioSourceStatus(pool,{now});assert.equal(s.last_attempt.status,'failed');assert.equal(s.last_attempt.code,'HASH_MISMATCH');}finally{await rm(dir,{recursive:true,force:true});}
});
test('fresh export timestamp cannot hide old source observations',()=>{
 const f=files({complete:true});const m=JSON.parse(f['manifest.json']);m.exported_at='2026-11-15T14:00:00+08:00';f['manifest.json']=JSON.stringify(m);const r=inspectPortfolioFiles(f,{now:()=>Date.parse('2026-11-15T14:00:00+08:00')});assert.equal(r.status,'quarantined');assert.ok(r.issues.some(x=>x.includes('90分钟')));
});

test('explicit null position fields stay unknown rather than zero; account NAV remains independently usable',()=>{
 const f=files({complete:true});const p=JSON.parse(f['positions_latest.json']);p.stocks[0].stock_qty=null;p.stocks[0].value=null;p.options[0].qty=null;p.options[0].pnl=null;f['positions_latest.json']=JSON.stringify(p);
 const r=inspectPortfolioFiles(seal(f),{now});assert.equal(r.status,'ready');const [stock,option]=r.metadata.aggregate_positions;assert.equal(stock.quantity,null);assert.equal(stock.market_value,null);assert.equal(option.quantity,null);assert.equal(option.reported_unrealized_pnl,null);assert.equal(r.snapshot.accounts[0].net_liquidation_value,'100');assert.equal(r.snapshot.accounts[0].positions_complete,false);
});
test('required account money null and malformed optional money still fail closed',()=>{
 const f=files({complete:true});const risk=JSON.parse(f['account_risk_latest.json']);risk.brokers.moomoo.broker.total_assets=null;f['account_risk_latest.json']=JSON.stringify(risk);assert.throws(()=>inspectPortfolioFiles(seal(f),{now}),e=>e.code==='INVALID_SOURCE');
 const g=files({complete:true});const p=JSON.parse(g['positions_latest.json']);p.stocks[0].stock_qty='';g['positions_latest.json']=JSON.stringify(p);assert.throws(()=>inspectPortfolioFiles(seal(g),{now}),e=>e.code==='INVALID_SOURCE');
});

test('14-file account result ingestion verifies source numbers, remains non-posting and rejects supplied sample data',async()=>{
 const{accountResultHash}=await import('../lib/account-results.mjs');const{accountResultOverview}=await import('../lib/account-results.mjs');
 await pool.query('TRUNCATE cfo_account_results,cfo_investment_snapshots,cfo_portfolio_ingests,cfo_portfolio_sync_attempts');
 const f=files({complete:true}),risk=JSON.parse(f['account_risk_latest.json']);
 for(const b of Object.values(risk.brokers)){b.broker.cash=-20;b.broker.long_mv=120;b.broker.short_mv=0;b.broker.market_val=120;}
 f['account_risk_latest.json']=JSON.stringify(risk);seal(f);const manifest=JSON.parse(f['manifest.json']);
 const body=JSON.parse(await readFile(new URL('./fixtures/account-results.sample.json',import.meta.url),'utf8'));body.status='live';body.producer='synthetic test';body.generated_at='2026-11-15T11:16:44+08:00';body.export_batch.export_id=manifest.export_id;
 for(const r of body.results){if(r.kind==='balance'){r.as_of='2026-11-15T11:15:36+08:00';r.logical_key.as_of=r.as_of;r.net_assets='100';if(r.decomposable){r.assets_total='120';r.liabilities_total='20';r.assets={cash_positive:'0',long_market_value:'120'};r.liabilities={margin_debit:'20',short_market_value:'0'};}}r.content_hash=accountResultHash(r);}
 function attach(){f['account_results.json']=JSON.stringify(body);const row={name:'account_results.json',status:'ok',bytes:Buffer.byteLength(f['account_results.json']),sha256:createHash('sha256').update(f['account_results.json']).digest('hex'),source_mtime:manifest.exported_at};manifest.files=manifest.files.filter(x=>x.name!==row.name);manifest.files.push(row);f['manifest.json']=JSON.stringify(manifest);}
 attach();const dir=await mkdtemp(path.join(tmpdir(),'account-results-ro-'));for(const[n,t]of Object.entries(f))await writeFile(path.join(dir,n),t);
 const before=(await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count;
 try{const result=await syncPortfolioSource(pool,dir,{now});assert.equal(result.status,'ready');assert.equal(result.financial_transaction_posted,false);assert.equal(result.summary.account_results_count,5);assert.equal(result.summary.account_results_saved,true);assert.equal((await accountResultOverview(pool,{month:'2026-11'})).balances.length,3);assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,before);
  const prior=await investmentOverview(pool,{now});
  const failed=body.results.find(r=>r.kind==='balance'&&r.account_scope[0]==='tiger');Object.assign(failed,{status:'unavailable',net_assets:null,decomposable:false,decomposition_basis:null,assets_total:null,liabilities_total:null,assets:null,liabilities:null,identity_check:null,unavailable_reason:['request timed out']});failed.content_hash=accountResultHash(failed);
  risk.brokers.tiger={_err:'request timed out'};f['account_risk_latest.json']=JSON.stringify(risk);manifest.export_id+='-partial';body.export_batch.export_id=manifest.export_id;
  const rf=manifest.files.find(x=>x.name==='account_risk_latest.json');rf.bytes=Buffer.byteLength(f[rf.name]);rf.sha256=createHash('sha256').update(f[rf.name]).digest('hex');attach();
  for(const name of['account_risk_latest.json','account_results.json','manifest.json'])await writeFile(path.join(dir,name),f[name]);
  const partial=await syncPortfolioSource(pool,dir,{now});assert.equal(partial.status,'quarantined');assert.equal(partial.summary.unavailable_balance_count,1);assert.equal(partial.summary.account_results_saved,false);assert.deepEqual(await investmentOverview(pool,{now}),prior);assert.equal((await pool.query('SELECT count(*) FROM cfo_account_results')).rows[0].count,'5');
  body.status='SAMPLE';attach();await writeFile(path.join(dir,'account_results.json'),f['account_results.json']);await writeFile(path.join(dir,'manifest.json'),f['manifest.json']);await assert.rejects(syncPortfolioSource(pool,dir,{now}),e=>e.code==='TEST_DATA_REJECTED');assert.deepEqual(await investmentOverview(pool,{now}),prior);
 }finally{await rm(dir,{recursive:true,force:true});await pool.query('TRUNCATE cfo_account_results');}
});

test('a verified export replay after an incomplete batch restores current quality status without new financial writes',async()=>{
 await pool.query('TRUNCATE cfo_investment_snapshots,cfo_portfolio_ingests,cfo_portfolio_sync_attempts');const good=await directory(files({complete:true})),bad=await directory(files());
 try{const first=await syncPortfolioSource(pool,good,{now});await syncPortfolioSource(pool,bad,{now});assert.equal((await portfolioSourceStatus(pool,{now})).status,'quarantined');const restored=await syncPortfolioSource(pool,good,{now});assert.equal(restored.reused,true);const status=await portfolioSourceStatus(pool,{now});assert.equal(status.status,'ready');assert.equal(status.metadata.export_id,first.summary.export_id);assert.equal(status.last_attempt.status,'ready');}finally{await rm(good,{recursive:true,force:true});await rm(bad,{recursive:true,force:true});}
});

test('twice daily cadence accepts a timely captured export between windows but does not hide a missed window',()=>{
 const f=files({complete:true});const later=()=>Date.parse('2026-11-15T22:00:00+08:00');assert.equal(inspectPortfolioFiles(f,{now:later}).status,'quarantined');assert.equal(inspectPortfolioFiles(f,{now:later,refreshPolicy:'twice_daily'}).status,'ready');assert.equal(inspectPortfolioFiles(f,{now:()=>Date.parse('2026-11-16T00:30:00.001+08:00'),refreshPolicy:'twice_daily'}).status,'quarantined');
});
test('switching cadence re-evaluates an existing raw batch and keeps collector and account display consistent',async()=>{
 await pool.query('TRUNCATE cfo_investment_snapshots,cfo_portfolio_ingests,cfo_portfolio_sync_attempts');const dir=await directory(files({complete:true})),later=()=>Date.parse('2026-11-15T22:00:00+08:00'),prior=process.env.CFO_PORTFOLIO_REFRESH_POLICY;
 try{const first=await syncPortfolioSource(pool,dir,{now:later,refreshPolicy:'hourly'});assert.equal(first.status,'quarantined');process.env.CFO_PORTFOLIO_REFRESH_POLICY='twice_daily';const next=await syncPortfolioSource(pool,dir,{now:later});assert.equal(next.status,'ready');assert.equal(next.reused,true);assert.equal(next.id,first.id);const v=await investmentOverview(pool,{now:later});assert.equal(v.sources[0].stale,false);assert.equal(v.sources[0].as_of,'2026-11-15T11:15:36+08:00');const s=await portfolioSourceStatus(pool,{now:later});assert.equal(s.status,'ready');assert.equal(s.stale,false);assert.equal(s.refresh_policy,'twice_daily');}finally{if(prior===undefined)delete process.env.CFO_PORTFOLIO_REFRESH_POLICY;else process.env.CFO_PORTFOLIO_REFRESH_POLICY=prior;await rm(dir,{recursive:true,force:true});}
});
