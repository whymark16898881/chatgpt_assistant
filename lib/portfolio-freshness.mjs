// Receiver freshness is separate from the upstream portfolio pipeline cadence.
const OFFSET=8*3600000,CAPTURE_LIMIT=90*60000,GRACE=30*60000;
export function portfolioRefreshPolicy(){const p=process.env.CFO_PORTFOLIO_REFRESH_POLICY||'hourly';if(!['hourly','twice_daily'].includes(p))throw new Error('Invalid CFO portfolio refresh policy');return p;}
export function nextPortfolioDeadline(exportedAt){
 const t=Date.parse(exportedAt);if(!Number.isFinite(t))return null;
 const local=new Date(t+OFFSET),dayStart=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()),hour=local.getUTCHours();
 // SGT publication windows [07,12) and [18,24), plus receiver polling grace.
 // A new manual publication also proves data delivery; it never changes exporter timers.
 const due=hour<7?dayStart+12*3600000:hour<18?dayStart+24*3600000:dayStart+36*3600000;
 return new Date(due-OFFSET+GRACE).toISOString();
}
export function portfolioFreshness(observedAt,exportedAt,{now=()=>Date.now(),policy=portfolioRefreshPolicy()}={}){
 if(!['hourly','twice_daily'].includes(policy))throw new Error('Invalid CFO portfolio refresh policy');
 const observation=Date.parse(observedAt),publication=Date.parse(exportedAt),current=now();
 const invalid=!Number.isFinite(observation)||!Number.isFinite(publication)||observation>publication||observation>current+300000||publication>current+300000;
 const capture_stale=invalid||publication-observation>CAPTURE_LIMIT;
 const next_expected_by=policy==='twice_daily'?nextPortfolioDeadline(exportedAt):Number.isFinite(observation)?new Date(observation+CAPTURE_LIMIT).toISOString():null;
 const delivery_stale=next_expected_by===null||current>Date.parse(next_expected_by);
 return{policy,stale:capture_stale||delivery_stale,capture_stale,delivery_stale,next_expected_by};
}
