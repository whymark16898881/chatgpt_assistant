import Decimal from 'decimal.js';
export const START = '2026-11-01';
export const CURRENCIES = ['CNY','SGD','USD','HKD','EUR','GBP'];
export function validDate(s) { return typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s+'T00:00:00Z')) && new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s; }
export function cents(s, signed=false) {
  if(typeof s!=='string' || !(signed?/^-?\d{1,12}(\.\d{1,2})?$/:/^\d{1,12}(\.\d{1,2})?$/).test(s)) throw new Error('金额需为最多两位小数的字符串');
  const n = new Decimal(s).mul(100);
  if(n.abs().gt('9000000000000'))throw new Error('金额超出支持范围');
  return n.toNumber();
}
export function baseCents(native, rate, currency) {
  if(currency==='CNY') {if(rate && !new Decimal(rate).eq(1))throw new Error('人民币汇率必须为1');return native;}
  if(typeof rate!=='string' || !/^\d{1,6}(\.\d{1,12})?$/.test(rate) || new Decimal(rate).lte(0))throw new Error('外币交易缺少有效的人民币汇率');
  const v=new Decimal(native).mul(rate).toDecimalPlaces(0,Decimal.ROUND_HALF_UP);
  if(v.abs().gt('9000000000000'))throw new Error('折算金额超出支持范围');
  return v.toNumber();
}
export const yuan=n=>new Decimal(n||0).div(100).toFixed(2);
