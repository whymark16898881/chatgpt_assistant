// Reads only an admin-configured mounted source. No gateway or trading API access.
import {setTimeout as delay} from 'node:timers/promises';
import {connectDatabase} from '../lib/db.mjs';
import {syncPortfolioSource} from '../lib/portfolio-source.mjs';
import {fetchInvestmentFx} from '../lib/investment-fx.mjs';
const pool=await connectDatabase(),loop=process.argv.includes('--loop'),stop=new AbortController();
process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
try{do{
 try{const fxQuote=await fetchInvestmentFx().catch(()=>null);const result=await syncPortfolioSource(pool,process.env.CFO_PORTFOLIO_DIR,{fxQuote});console.log(JSON.stringify({event:'portfolio_sync',status:result.status,reused:result.reused,summary:result.summary,issues:result.issues,financial_transaction_posted:false}));}
 catch(e){console.error(JSON.stringify({event:'portfolio_sync_failed',code:e.code||'INVALID_SOURCE',message:'只读来源未成功导入，保留上次成功快照。'}));if(!loop)process.exitCode=1;}
 if(loop&&!stop.signal.aborted)await delay(15*60000,undefined,{signal:stop.signal}).catch(()=>{});
}while(loop&&!stop.signal.aborted);}finally{await pool.end();}
