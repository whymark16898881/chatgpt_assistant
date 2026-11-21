// Personal-wide statement policy: payment institutions are optional details.
// Currency and cash versus credit remain accounting facts, never inferred from a card name.
export const SUMMARY_POLICY={mode:'personal_statements',payment_account_required:false,fx_policy:{mode:'automatic_daily_public_reference',provider:'ECB / Frankfurter',user_rate_source_required:false,note:'省略汇率与来源，服务器按入账日自动取得并缓存在NAS；勿向用户索要汇率来源。'},default_settlement:'cash',unknown_currency:'draft',unknown_settlement:'draft',note:'普通已收已付收支按币种汇总；不辨认具体银行卡或钱包。赊购/借款仍区分负债，未知不猜。'};
export const ordinary=e=>['income','expense'].includes(e.kind);
export function summaryKind(e){if(!ordinary(e)||e.account_id||e.settlement==='unknown')return null;if(e.settlement==='credit')return e.kind==='expense'?'payable':null;return'cash';}
export async function bindSummaryAccount(c,e){
 const kind=summaryKind(e);if(!kind||!e.currency)return e;
 const row=(await c.query(`INSERT INTO cfo_accounts(name,kind,account_group,currency,is_cash,summary_kind)
  VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(currency,summary_kind) WHERE summary_kind IS NOT NULL DO NOTHING RETURNING id`,[
   (kind==='cash'?'综合现金':'综合应付款')+' · '+e.currency,kind==='cash'?'cash':'other_liability',kind==='cash'?'asset':'liability',e.currency,kind==='cash',kind])).rows[0]||(await c.query('SELECT id FROM cfo_accounts WHERE currency=$1 AND summary_kind=$2',[e.currency,kind])).rows[0];
 return{...e,account_id:row.id};
}
