import pg from 'pg';
import {seedClassifications} from './classifications.mjs';
import { readFile } from 'node:fs/promises';
pg.types.setTypeParser(1082, value=>value);
export async function connectDatabase() {
  const config = process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
    host: process.env.PGHOST || 'postgres', user: 'cfo', database: 'cfo',
    password: (await readFile(process.env.CFO_DB_PASSWORD_FILE || '/run/secrets/db_password', 'utf8')).trim()
  };
  const pool = new pg.Pool({ ...config, max: 6 });
  await migrate(pool);
  return pool;
}
export async function transaction(pool, work) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await work(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export async function migrate(pool) {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await transaction(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(20261101)");
    await c.query(sql);
    const groups = {
      'income.salary': ['工资收入', 'income'], 'income.side': ['副业收入', 'income'],
      'income.interest': ['利息收入', 'income'], 'income.dividend': ['股息收入', 'income'],
      'income.other': ['其他收入', 'income'], 'income.fx': ['汇兑收益', 'income'],
      'income.unrealized': ['未实现估值收益', 'income'],
      'expense.family': ['家庭支持', 'expense'], 'expense.food': ['餐饮', 'expense'],
      'expense.shopping': ['购物', 'expense'], 'expense.learning': ['学习成长', 'expense'],
      'expense.health': ['健康', 'expense'], 'expense.travel': ['旅游出行', 'expense'],
      'expense.insurance': ['保险', 'expense'], 'expense.subscription': ['会员订阅', 'expense'],
      'expense.interest': ['融资利息', 'expense'], 'expense.financing_fees': ['借款及融资手续费', 'expense'],
      'income.investment_realized': ['已实现投资收益', 'income'], 'expense.investment_realized': ['已实现投资损失', 'expense'],
      'expense.other': ['其他支出', 'expense'], 'expense.fx': ['汇兑损失', 'expense'],
      'expense.unrealized': ['未实现估值损失', 'expense'], 'equity.opening': ['期初净资产', 'equity']
    };
    for (const [key, [name, group]] of Object.entries(groups)) {
      await c.query(`INSERT INTO cfo_accounts(id,name,kind,account_group,currency,system_key,opening_confirmed)
        VALUES(gen_random_uuid(),$1,'system',$2,'CNY',$3,true) ON CONFLICT(system_key) DO NOTHING`, [name, group, key]);
    }
    await seedClassifications(c);
  });
}
