// A user's explicit date/baseline confirmation is evidence; a replacement photo is not required.
const dateNotes=new Set(['确认余额日期及建账基准','截图未显示日期，待核实','截图未显示日期,待核实','缺少发生日期','发生日期待确认','收益发放日期待确认','截图未显示余额截至日期','确认11月1日期初余额，或明确授权使用截图金额作为建账基准']);
const classificationNotes=new Set(['确认券商名称或账本名称','确认基金账户所属平台或账本名称']);
export function validUserConfirmation(p,currency=p.currency){const q=p.user_confirmation;return !!q&&q.date===p.date&&q.amount===p.amount&&(!currency||q.currency===currency)&&(p.kind==='opening'?q.basis==='estimated_opening'||q.basis==='confirmed':q.basis==='confirmed');}
export function applyUserConfirmation(p){const confirmed=validUserConfirmation(p);return{...p,needs_review:(p.needs_review||[]).filter(n=>!(confirmed&&dateNotes.has(n.trim()))&&!(p.account_id&&classificationNotes.has(n.trim())))};}
export function confirmationIssues(p,currency){if(p.user_confirmation&&!validUserConfirmation(p,currency))return['金额、币种或日期已变更，请重新手工确认'];if(p.kind==='opening'&&p.amount_origin==='snapshot_candidate'&&!validUserConfirmation(p,currency))return['请确认采用此金额作为期初基准，可手工确认或估算，无需重传带日期截图'];return[];}
