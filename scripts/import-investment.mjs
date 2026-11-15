// Admin-only import of an agreed local JSON export; no broker credentials or trading access.
import {open} from 'node:fs/promises';
import {connectDatabase} from '../lib/db.mjs';
import {importInvestmentSnapshot} from '../lib/investments.mjs';
const file=process.argv[2];if(!file)throw new Error('Usage: node scripts/import-investment.mjs /read-only-export/snapshot.json');
const h=await open(file,'r');let input;try{const s=await h.stat();if(!s.isFile()||s.size>5*1024*1024)throw new Error('Snapshot must be a regular JSON file no larger than 5MiB');input=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}
const pool=await connectDatabase();try{console.log(JSON.stringify(await importInvestmentSnapshot(pool,input)));}finally{await pool.end();}
