// Reversals remain append-only, including delete/restore cycles.
export async function journalChain(c,eventId){return(await c.query(`WITH RECURSIVE chain AS (SELECT j.*,0 AS depth FROM cfo_entries j WHERE j.event_id=$1 UNION ALL SELECT j.*,p.depth+1 FROM cfo_entries j JOIN chain p ON j.reverses_id=p.id) SELECT * FROM chain ORDER BY depth`,[eventId])).rows;}
export async function reverseJournal(c,entry,date,description){
 const check=(await c.query('SELECT count(*)::int AS n,sum(cny_cents)::text AS total FROM cfo_lines WHERE entry_id=$1',[entry.id])).rows[0];if(check.n<2||check.total!=='0')throw new Error('原分录金额不完整，不能撤销或恢复');
 const row=(await c.query('INSERT INTO cfo_entries(entry_date,description,kind,cash_flow_bucket,reverses_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[date,description,entry.kind,entry.cash_flow_bucket,entry.id])).rows[0];
 await c.query('INSERT INTO cfo_lines(entry_id,account_id,native_cents,cny_cents,fx_rate,fx_source) SELECT $1,account_id,-native_cents,-cny_cents,fx_rate,fx_source FROM cfo_lines WHERE entry_id=$2',[row.id,entry.id]);return row;
}
