// Existing probe volumes are mounted read-only; source SQL uses BEGIN READ ONLY.
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {connectDatabase} from '../lib/db.mjs';
import {documentService} from '../lib/documents.mjs';
import {importProbe} from '../lib/import-probe.mjs';
const source=new pg.Pool({host:process.env.PROBE_PGHOST||'cfo-test-postgres-1',user:'cfo_probe',database:'cfo_probe',password:(await readFile('/run/probe-secrets/postgres-password','utf8')).trim()});
const target=await connectDatabase();
try{console.log(JSON.stringify(await importProbe(source,documentService(target,process.env.CFO_DATA_DIR||'/data/originals'),'/probe-originals')));}
finally{await source.end();await target.end();}
