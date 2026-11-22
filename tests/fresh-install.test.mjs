// A first install is the one path no existing database can test: every other
// suite runs against a database that migrated incrementally, where a parent
// already exists by the time a child references it. Ordering mistakes in the
// chart of accounts only surface here — on a new machine, or a restore.
import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import pg from 'pg';

if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Isolated test database required');

const base=new URL(process.env.DATABASE_URL);
const name='cfo_fresh_'+randomUUID().slice(0,8)+'_test';
const adminUrl=new URL(base);adminUrl.pathname='/postgres';
const freshUrl=new URL(base);freshUrl.pathname='/'+name;

const admin=new pg.Pool({connectionString:adminUrl.toString()});
await admin.query(`CREATE DATABASE ${name}`);
after(async()=>{await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(()=>{});await admin.end();});

test('an empty database migrates, and the chart of accounts comes out whole',async()=>{
 process.env.DATABASE_URL=freshUrl.toString();
 const {connectDatabase}=await import('../lib/db.mjs?fresh='+name);
 const pool=await connectDatabase();   // throws if any parent is inserted after its child
 try{
  const nodes=(await pool.query("SELECT code,parent_code,business_group,financial_account_id FROM cfo_classification_nodes WHERE tree='financial'")).rows;
  assert.ok(nodes.length>20,`科目树只有 ${nodes.length} 个节点，没建起来`);

  const byCode=new Map(nodes.map(n=>[n.code,n]));
  for(const n of nodes){
   if(!n.parent_code)continue;
   const parent=byCode.get(n.parent_code);
   assert.ok(parent,`${n.code} 的父节点 ${n.parent_code} 不存在`);
   assert.equal(parent.business_group,n.business_group,`${n.code} 与父节点分组不一致`);
  }

  // Every ledger account must reach the tree carrying its own id: a node seeded
  // first and only later matched to an account used to keep a NULL id, which no
  // join would catch but which leaves the tree inconsistent with the ledger.
  const accounts=(await pool.query('SELECT system_key FROM cfo_accounts WHERE system_key IS NOT NULL')).rows;
  assert.ok(accounts.length>20,'预置科目账户没建起来');
  for(const a of accounts){
   const node=byCode.get(a.system_key);
   assert.ok(node,`科目账户 ${a.system_key} 在树上没有节点`);
   assert.ok(node.financial_account_id,`${a.system_key} 的节点缺账户 id`);
  }

  // Pure grouping levels own no account and must stay NULL.
  for(const code of ['expense.cogs','expense.lifestyle','expense.financing'])
   assert.equal(byCode.get(code)?.financial_account_id,null,`${code} 是分组层，不该绑账户`);
 }finally{await pool.end();process.env.DATABASE_URL=base.toString();}
});
