'use client';

type Sections={[k:string]:string};
type Bucket={bucket:string;amount:string};
type Balance={total_assets:string;total_liabilities:string;net_worth:string;opening_equity:string;retained_profit:string;balanced:boolean};
type Cash={opening:string;closing:string;buckets:Bucket[];net_change:string;reconciled:boolean};
type Group={name:string;total:string};

const BUCKETS:{[k:string]:string}={operating:'经营活动',investing:'投资活动',financing:'筹资活动',opening:'期初建账'};

export default function Statements({sections,balance,cash,assets,liabilities,symbol}:{
 sections:Sections;balance:Balance;cash:Cash;assets:Group[];liabilities:Group[];symbol:string;}){
 const n=(v:string|undefined)=>Number(v||0);
 const money=(v:string|undefined)=>`${symbol} ${n(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
 // A row is a subtotal when it closes a block; those carry the rule above and the heavier type.
 const Row=({label,value,note,level='item'}:{label:string;value:string|undefined;note?:string;level?:'item'|'sub'|'total'})=>
  <tr className={`sheet-row sheet-${level}`}>
   <th scope="row">{label}{note&&<small className="muted"> {note}</small>}</th>
   <td className={n(value)<0?'sheet-negative':undefined}>{money(value)}</td>
  </tr>;

 return <div className="statement-set">
  <section className="sheet">
   <h3>利润表</h3>
   <p className="muted">本月已入账的收入与费用。赊购在刷卡当月计费用，不等于当月现金流出。</p>
   <table>
    <tbody>
     <Row label="主营业务收入" value={sections.operating_revenue} note="工资"/>
     <Row label="减：主营业务成本" value={sections.cogs} note="通勤·工作餐·培训·设备"/>
     <Row label="毛利" value={sections.gross_profit} note="这份工作净落袋" level="sub"/>
     <Row label="减：必要生活支出" value={sections.living} note="三餐·居住·交通·通讯"/>
     <Row label="减：可选消费" value={sections.lifestyle} note="旅游·购物·娱乐"/>
     <Row label="经营利润" value={sections.operating_profit} note="过完日子还剩多少" level="sub"/>
     <Row label="加：投资收益" value={sections.investment_income}/>
     <Row label="加：其他收入" value={sections.other_income} note="副业等"/>
     <Row label="减：财务费用" value={sections.financing_cost} note="利息·手续费"/>
     <Row label="减：投资损失" value={sections.investment_loss}/>
     {n(sections.other_expense)!==0&&<Row label="减：其他支出" value={sections.other_expense}/>}
     <Row label="净利润" value={sections.net_income} level="total"/>
    </tbody>
   </table>
  </section>

  <section className="sheet">
   <h3>资产负债表</h3>
   <p className="muted">按平台汇总，资产与负债分列不抵消。{balance.balanced?'借贷已平。':'⚠ 借贷未平，数字暂不可用。'}</p>
   <table>
    <tbody>
     {assets.map(g=><Row key={'a'+g.name} label={g.name} value={g.total}/>)}
     <Row label="资产合计" value={balance.total_assets} level="sub"/>
     {liabilities.length>0&&liabilities.map(g=><Row key={'l'+g.name} label={g.name} value={g.total}/>)}
     <Row label="负债合计" value={balance.total_liabilities} level="sub"/>
     <Row label="净资产" value={balance.net_worth} note="资产减负债" level="total"/>
     <Row label="其中：期初权益" value={balance.opening_equity}/>
     <Row label="　　　本期留存" value={balance.retained_profit}/>
    </tbody>
   </table>
  </section>

  <section className="sheet">
   <h3>现金流量表</h3>
   <p className="muted">只认已记录的现金收付。刷信用卡当月不出现金，还款当月才算流出——这是它和利润表的差额来源。</p>
   <table>
    <tbody>
     <Row label="期初现金" value={cash.opening}/>
     {cash.buckets.map(b=><Row key={b.bucket} label={BUCKETS[b.bucket]||b.bucket} value={b.amount}/>)}
     <Row label="本期净变动" value={cash.net_change} level="sub"/>
     <Row label="期末现金" value={cash.closing} level="total"/>
    </tbody>
   </table>
   {!cash.reconciled&&<p className="muted">⚠ 期初加净变动与期末对不上，先别用这张表下结论。</p>}
  </section>
 </div>;
}
