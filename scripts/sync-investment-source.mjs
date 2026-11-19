// Reads only an admin-configured mounted source. No gateway or trading API access.
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {connectDatabase} from '../lib/db.mjs';
import {syncPortfolioSource} from '../lib/portfolio-source.mjs';
import {reconcileBrokerLedger} from '../lib/broker-ledger.mjs';
import {documentService} from '../lib/documents.mjs';
import {fetchInvestmentFx} from '../lib/investment-fx.mjs';
const pool=await connectDatabase(),loop=process.argv.includes('--loop'),stop=new AbortController();
process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
try{do{
 try{const fxQuote=await fetchInvestmentFx().catch(()=>null);const result=await syncPortfolioSource(pool,process.env.CFO_PORTFOLIO_DIR,{fxQuote});let bridge=null;
  if(result.status==='ready'){
   const files=result.verified_files;
   if(files['account_results.json']){
    const bytes=Buffer.from(JSON.stringify(files)),digest=createHash('sha256').update(bytes).digest('hex'),old=(await pool.query('SELECT id,trashed_at,purge_requested_at FROM cfo_documents WHERE sha256=$1',[digest])).rows[0];
    if(old&&(old.trashed_at||old.purge_requested_at)){bridge={status:'pending',posted_count:0,reasons:[{code:'SOURCE_ARCHIVE_REMOVED',message:'该批来源归档已被移入回收站或删除，未自动恢复'}]};await pool.query('INSERT INTO cfo_broker_bridge_runs(status,summary) VALUES($1,$2)',[bridge.status,JSON.stringify(bridge)]);}
    else{const doc=old||await documentService(pool,process.env.CFO_DATA_DIR||'/data').saveBytes({file_name:'券商已验证来源-'+JSON.parse(files['manifest.json']).export_id.replace(/[^a-zA-Z0-9#-]/g,'')+'.json'},{bytes,mime:'application/json'});
     try{bridge=await reconcileBrokerLedger(pool,{files,documentId:doc.id});}catch(e){bridge={status:'pending',posted_count:0,reasons:[{code:'BRIDGE_RETRY_REQUIRED',message:'自动入账核对暂未通过，已有分录保留，等待重试或核实来源'}]};await pool.query('INSERT INTO cfo_broker_bridge_runs(status,summary) VALUES($1,$2)',[bridge.status,JSON.stringify(bridge)]);}
    }
   }
  }
  console.log(JSON.stringify({event:'portfolio_sync',status:result.status,reused:result.reused,summary:result.summary,issues:result.issues,ledger_bridge:bridge?{status:bridge.status,posted_count:bridge.posted_count,opening_count:bridge.opening_count,period_count:bridge.period_count,reason_codes:bridge.reasons.map(x=>x.code)}:null,financial_transaction_posted:!!bridge?.posted_count}));}
 catch(e){console.error(JSON.stringify({event:'portfolio_sync_failed',code:e.code||'INVALID_SOURCE',message:'只读来源未成功导入，保留上次成功快照。'}));if(!loop)process.exitCode=1;}
 if(loop&&!stop.signal.aborted)await delay(15*60000,undefined,{signal:stop.signal}).catch(()=>{});
}while(loop&&!stop.signal.aborted);}finally{await pool.end();}
