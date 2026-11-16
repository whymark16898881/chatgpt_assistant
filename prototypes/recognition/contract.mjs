// Staged contract for the accepted data model. No existing MCP input is replaced yet.
import {z} from 'zod';
import {cents,CURRENCIES,validDate} from '../../lib/money.mjs';
const ref=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/),text=z.string().max(1000);
const amount=z.string().refine(v=>{try{return cents(v)>=0;}catch{return false;}},'金额必须为非负、最多两位小数的原币字符串');
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
const timezone=z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'时区无效');
const box=z.tuple([z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1)]).refine(([x1,y1,x2,y2])=>x2>x1&&y2>y1,'区域必须为有效的归一化矩形');
const item=z.object({item_ref:ref,description:text.optional(),amount:amount.optional(),currency:z.enum(CURRENCIES).optional(),category_code:ref.optional(),merchant:z.string().max(150).optional(),meal_type:z.enum(['breakfast','lunch','dinner','snack','unknown','not_applicable']).optional()}).strict();
const observation=z.object({item_ref:ref.optional(),field_name:z.enum(['amount','currency','occurred_on','occurred_time','time_precision','timezone','merchant','payment_channel','description','category_code','meal_type','account','counter_account','financial_category']),
 value:z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()]),value_status:z.enum(['found','missing','ambiguous','conflicting','not_applicable']),origin:z.enum(['original','cross_document','user_provided','derived']),verification:z.enum(['unverified','user_confirmed']).default('unverified'),
 document_id:z.uuid().optional(),source_ref:z.string().max(200).optional(),page:z.number().int().min(1).optional(),bounding_box:box.optional(),raw_text:text.optional(),reason:text.optional()
}).strict().superRefine((v,ctx)=>{
 const add=message=>ctx.addIssue({code:'custom',message});
 if(['missing','not_applicable'].includes(v.value_status)&&v.value!==null)add('缺失或不适用字段必须保持null');
 if(v.value_status==='found'&&(v.value===null||v.value===''))add('已找到字段必须有实际值');
 if(['original','cross_document'].includes(v.origin)&&!v.document_id)add('原件识别或跨图补全必须关联原件');
 if((v.page!==undefined||v.bounding_box!==undefined||v.source_ref!==undefined)&&!v.document_id)add('页码或位置必须关联原件');
 if(v.value_status==='found'){
  if(v.field_name==='amount'){try{if(typeof v.value!=='string')throw new Error();cents(v.value,true);}catch{add('金额观察必须是最多两位小数的原币字符串');}}
  if(v.field_name==='currency'&&!CURRENCIES.includes(v.value))add('币种观察必须规范化为支持的币种');
  if(v.field_name==='occurred_on'&&!validDate(v.value))add('发生日期观察必须是有效日期');
 }
 if(v.origin==='derived'&&v.verification==='user_confirmed')add('规则计算不能冒充用户对原文事实的确认');
});
export const recognitionSchema=z.object({schema:z.literal('cfo_recognition/v1'),data_type:z.enum(['live','sample']),
 allocation_status:z.enum(['not_itemized','complete','partial']).default('not_itemized'),
 merchant:z.string().max(150).optional(),occurred_time:time.optional(),time_precision:z.enum(['unknown','date','minute','second']).default('unknown'),timezone:timezone.optional(),payment_channel:z.string().max(150).optional(),
 category_code:ref.optional(),meal_type:z.enum(['breakfast','lunch','dinner','snack','unknown','not_applicable']).optional(),
 items:z.array(item).max(300).default([]),observations:z.array(observation).max(1000).default([])
}).strict().superRefine((v,ctx)=>{
 const add=message=>ctx.addIssue({code:'custom',message});
 if(v.occurred_time===undefined&&['minute','second'].includes(v.time_precision))add('分/秒精度必须提供具体时刻');
 if(v.occurred_time!==undefined&&!['minute','second'].includes(v.time_precision))add('具体时刻必须明确分或秒精度');
 if(v.occurred_time!==undefined&&(v.time_precision==='minute'&&v.occurred_time.length!==5||v.time_precision==='second'&&v.occurred_time.length!==8))add('时刻与精度不一致');
 if(v.allocation_status==='not_itemized'&&v.items.length)add('未拆分总额不能同时提交商品分项');
 if(v.allocation_status!=='not_itemized'&&!v.items.length)add('完整或部分明细需要至少一项');
 const refs=new Set(v.items.map(i=>i.item_ref));if(refs.size!==v.items.length)add('同笔明细引用重复');
 if(v.observations.some(o=>o.item_ref!==undefined&&!refs.has(o.item_ref)))add('字段观察引用了不存在的明细');
});
