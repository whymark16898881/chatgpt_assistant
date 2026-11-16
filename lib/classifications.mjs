const seedNodes=[
 ['financial','asset',null,'资产','asset'],['financial','liability',null,'负债','liability'],['financial','equity',null,'权益','equity'],['financial','income',null,'收入','income'],['financial','expense',null,'费用','expense'],
 ['financial','income.work','income','工作收入','income'],['financial','income.investment','income','投资收益','income'],['financial','expense.living','expense','生活费用','expense'],['financial','expense.financing','expense','融资成本','expense'],['financial','expense.investment','expense','投资损失','expense'],
 ['analysis','income',null,'收入','income'],['analysis','expense',null,'消费及费用','expense'],
 ['analysis','expense.food','expense','餐饮','expense'],['analysis','expense.food.dining','expense.food','外食','expense'],['analysis','expense.food.takeaway','expense.food','外卖','expense'],['analysis','expense.food.ingredients','expense.food','食材','expense'],
 ['analysis','expense.transport','expense','交通','expense'],['analysis','expense.shopping','expense','购物','expense'],['analysis','expense.home','expense','居家','expense'],['analysis','expense.home.utilities','expense.home','水电燃气','expense'],['analysis','expense.home.utilities.electricity','expense.home.utilities','电费','expense'],['analysis','expense.financing','expense','融资费用','expense'],
 ['analysis','income.work','income','工作收入','income'],['analysis','income.investment','income','投资收益','income'],['analysis','income.investment.interest','income.investment','利息收益','income'],['analysis','income.investment.dividend','income.investment','股息收益','income']
];

export async function seedClassifications(c){
  for(const node of seedNodes)await c.query('INSERT INTO cfo_classification_nodes(tree,code,parent_code,name,business_group) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tree,code) DO NOTHING',node);
  for(const a of(await c.query('SELECT id,system_key,name,account_group FROM cfo_accounts WHERE system_key IS NOT NULL')).rows){
   const key=a.system_key,g=a.account_group;
   let parent=g;
   if(g==='income'&&['income.salary','income.side'].includes(key))parent='income.work';
   else if(g==='income'&&key!=='income.other')parent='income.investment';
   else if(g==='expense'&&['expense.interest','expense.financing_fees'].includes(key))parent='expense.financing';
   else if(g==='expense'&&['expense.fx','expense.unrealized','expense.investment_realized'].includes(key))parent='expense.investment';
   else if(g==='expense'&&key!=='expense.other')parent='expense.living';
   await c.query("INSERT INTO cfo_classification_nodes(tree,code,parent_code,name,business_group,financial_account_id) VALUES('financial',$1,$2,$3,$4,$5) ON CONFLICT(tree,code) DO NOTHING",[key,parent,a.name,g,a.id]);
  }
}
export async function classificationTree(pool){
 const nodes=(await pool.query('SELECT tree,code,parent_code,name,business_group,financial_account_id FROM cfo_classification_nodes ORDER BY tree,code')).rows;
 const map=new Map(nodes.map(n=>[n.tree+':'+n.code,n]));
 return nodes.map(n=>{const path=[];let next=n;const seen=new Set();while(next){const key=next.tree+':'+next.code;if(seen.has(key))throw new Error('分类树存在循环');seen.add(key);path.unshift({code:next.code,name:next.name});next=next.parent_code?map.get(next.tree+':'+next.parent_code):null;}return{...n,path};});
}
