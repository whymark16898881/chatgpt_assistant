// Local isolated database only; never run this against a personal NAS ledger.
import {chromium} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const url=process.env.CFO_BROWSER_TEST_URL||'http://127.0.0.1:3201';
if(new URL(url).hostname!=='127.0.0.1')throw new Error('Browser check is restricted to loopback');
const password=(await readFile(process.env.CFO_BROWSER_PASSWORD_FILE||'/workspace/scratch/cfo-020-local/secrets/web-password.txt','utf8')).trim();
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(url);await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'进入私账 →'}).click();await page.getByRole('heading',{name:'财务总览',exact:true}).waitFor();
 await page.getByRole('button',{name:'账户与期初',exact:true}).click();await page.getByRole('button',{name:'添加账户'}).first().click();await page.getByLabel('账户名称').fill('浏览器测试银行');await page.getByRole('button',{name:'建立账户',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByRole('heading',{name:'账户与期初',exact:true}).waitFor();
 await page.getByRole('button',{name:'新增记录'}).click();await page.getByRole('combobox',{name:'类型',exact:true}).selectOption('opening');await page.getByRole('combobox',{name:'账户',exact:true}).selectOption({label:'浏览器测试银行 · CNY'});await page.getByLabel('原币金额',{exact:false}).fill('1000');await page.getByRole('button',{name:'校验并入账'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'新增记录'}).click();await page.getByRole('combobox',{name:'账户',exact:true}).selectOption({label:'浏览器测试银行 · CNY'});await page.getByLabel('原币金额',{exact:false}).fill('12.50');await page.getByLabel('描述',{exact:true}).fill('浏览器验收午餐');await page.getByRole('button',{name:'校验并入账'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 const state=await page.evaluate(async()=>{const r=await fetch('/api/state');return r.json();});assert.equal(state.report.income_statement.total_expenses,'12.50');assert.equal(state.report.balance_sheet.balanced,true);assert.equal(state.report.cash_flow.reconciled,true);
 await page.getByRole('button',{name:'财务总览',exact:true}).click();await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/desktop.png',fullPage:true});
 await page.getByRole('button',{name:'财务报表',exact:true}).click();await page.getByRole('heading',{name:'财务报表',exact:true}).waitFor();assert.equal(await page.getByText('现金流已勾稽',{exact:true}).count(),1);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'财务总览',exact:true}).click();await page.screenshot({path:'artifacts/mobile.png',fullPage:true});
 const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(width.scroll<=width.width+1,JSON.stringify(width));assert.deepEqual(errors,[]);
 console.log('Browser PASS: login, account, opening balance, expense, reports, desktop and 390px mobile; no page errors.');
}finally{await browser.close();}
