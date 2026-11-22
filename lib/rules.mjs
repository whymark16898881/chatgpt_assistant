import {z} from 'zod';

// What the user has settled once. A rule never invents money: it either files a
// transaction under a chosen account, or marks it as already recorded elsewhere
// so the same spending is not counted twice across statements.
export const ruleSchema=z.object({
 pattern:z.string().trim().min(2).max(120),
 account_pattern:z.string().trim().min(1).max(200).optional(),
 applies_to:z.enum(['income','expense','any']).default('any'),
 action:z.enum(['categorize','skip']),
 category:z.string().trim().max(80).optional(),
 reason:z.string().trim().min(2).max(300),
 priority:z.number().int().min(1).max(1000).default(100),
}).strict().refine(r=>r.action!=='categorize'||!!r.category,{message:'归类规则必须给出科目'});

const norm=v=>String(v??'').toLowerCase();
// account_pattern holds one or more alternatives separated by | so a single rule
// can cover "the cards I top up from the salary account".
const hitsAccount=(pattern,fields)=>{
 if(!pattern)return true;
 const names=fields.filter(Boolean).map(norm);
 return pattern.split('|').map(p=>norm(p).trim()).filter(Boolean).some(p=>names.some(n=>n.includes(p)));
};

export function matchRule(rules,tx){
 const haystack=[tx.merchant,tx.description,tx.memo].filter(Boolean).map(norm);
 if(!haystack.length)return null;
 for(const r of rules){
  if(r.enabled===false)continue;
  if(r.applies_to!=='any'&&r.applies_to!==tx.kind)continue;
  if(!haystack.some(h=>h.includes(norm(r.pattern))))continue;
  if(!hitsAccount(r.account_pattern,[tx.account_name,tx.platform_name]))continue;
  return r;
 }
 return null;
}

export async function listRules(pool){
 return(await pool.query(`SELECT id,priority,pattern,account_pattern,applies_to,action,category,reason,enabled,hit_count,last_hit_at,created_at
  FROM cfo_rules ORDER BY enabled DESC,priority,created_at`)).rows;
}

export async function addRule(pool,input){
 const r=ruleSchema.parse(input);
 const row=(await pool.query(`INSERT INTO cfo_rules(priority,pattern,account_pattern,applies_to,action,category,reason)
  VALUES($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT(lower(pattern),coalesce(lower(account_pattern),''),applies_to)
  DO UPDATE SET action=EXCLUDED.action,category=EXCLUDED.category,reason=EXCLUDED.reason,priority=EXCLUDED.priority,enabled=true
  RETURNING *`,[r.priority,r.pattern,r.account_pattern??null,r.applies_to,r.action,r.category??null,r.reason])).rows[0];
 return row;
}

export async function setRuleEnabled(pool,id,enabled){
 const row=(await pool.query('UPDATE cfo_rules SET enabled=$2 WHERE id=$1 RETURNING *',[z.uuid().parse(id),!!enabled])).rows[0];
 if(!row)throw new Error('规则不存在');
 return row;
}

// Counting hits is what makes a rule auditable: a rule that never fires is dead
// weight, and one that fires unexpectedly often is usually too broad.
export async function recordHit(c,id){
 await c.query('UPDATE cfo_rules SET hit_count=hit_count+1,last_hit_at=now() WHERE id=$1',[id]);
}

// Applied where the model hands in candidates, not inside the ledger: a rule is
// the user's standing judgement about what a line means, so it belongs with
// recognition rather than with double-entry.
export async function applyRulesTo(pool,items){
 const rules=await listRules(pool);
 const kept=[],skipped=[],recategorized=[];
 if(!rules.length)return{kept:items,skipped,recategorized};
 for(const item of items){
  const p=item.payload||{};
  const hit=matchRule(rules,{kind:p.kind,merchant:p.merchant,description:p.description,
   memo:p.account_hint,account_name:p.platform_name,platform_name:p.platform_name});
  if(!hit){kept.push(item);continue;}
  await recordHit(pool,hit.id);
  if(hit.action==='skip'){skipped.push({source_ref:item.source_ref,rule_id:hit.id,pattern:hit.pattern,reason:hit.reason});continue;}
  if(p.category!==hit.category)recategorized.push({source_ref:item.source_ref,rule_id:hit.id,from:p.category??null,to:hit.category,reason:hit.reason});
  kept.push({...item,payload:{...p,category:hit.category}});
 }
 return{kept,skipped,recategorized};
}

// Seeded once, never overwritten: the user owns these afterwards and may edit or
// disable any of them. Rules that depend on a habit the user must keep up are
// seeded disabled, so nothing is silently dropped before they agree to it.
const SEED=[
 {priority:10,pattern:'SALA',account_pattern:'DBS|UOB',applies_to:'income',action:'skip',enabled:true,
  reason:'HSBC 是真工资卡，它每月转入 DBS/UOB 时备注沿用 SALA/SALARY，是内部调度不是第二份工资'},
 {priority:100,pattern:'Gojek',applies_to:'expense',action:'categorize',category:'expense.commute',enabled:true,
  reason:'用户确认 Gojek 用于通勤'},
 {priority:100,pattern:'Foodpanda',applies_to:'expense',action:'categorize',category:'expense.food',enabled:true,
  reason:'新加坡外卖平台'},
 {priority:100,pattern:'饿了么',applies_to:'expense',action:'categorize',category:'expense.food',enabled:true,
  reason:'国内外卖平台'},
 {priority:100,pattern:'高德',applies_to:'expense',action:'categorize',category:'expense.transport',enabled:true,
  reason:'国内打车；国内已无工作收入，不计入通勤成本'},
 {priority:100,pattern:'Marriott',applies_to:'expense',action:'categorize',category:'expense.travel',enabled:true,
  reason:'酒店'},
 {priority:100,pattern:'万豪',applies_to:'expense',action:'categorize',category:'expense.travel',enabled:true,
  reason:'酒店'},
 // These drop a bank line on the assumption that the same spending arrives in
 // the wallet statement. If a month's wallet statement is missing, enabling them
 // would quietly lose that month's spending, so the user turns them on.
 {priority:20,pattern:'支付宝',applies_to:'expense',action:'skip',enabled:false,
  reason:'支付宝绑定国内各卡，消费以支付宝账单为准；银行卡上这条是同一笔的镜像。仅在确实会上传支付宝账单时启用'},
 {priority:20,pattern:'财付通',applies_to:'expense',action:'skip',enabled:false,
  reason:'微信支付的银行卡扣款镜像，同上，仅在确实会上传微信账单时启用'},
];
export async function seedRules(c){
 for(const r of SEED)await c.query(`INSERT INTO cfo_rules(priority,pattern,account_pattern,applies_to,action,category,reason,enabled)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(lower(pattern),coalesce(lower(account_pattern),''),applies_to) DO NOTHING`,
  [r.priority,r.pattern,r.account_pattern??null,r.applies_to,r.action,r.category??null,r.reason,r.enabled]);
}
