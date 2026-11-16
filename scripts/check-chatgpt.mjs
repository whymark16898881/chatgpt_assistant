// Read-only local MCP acceptance; never prints authorization or financial data.
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {VERSION} from '../lib/version.mjs';
const authorization=(await readFile(process.env.CFO_MCP_AUTHORIZATION_FILE||'/run/cfo/mcp-authorization','utf8')).trim();
if(!/^Bearer [a-f0-9]{64}$/.test(authorization))throw new Error('正式MCP凭证格式无效；未输出原值');
const client=new Client({name:'personal-cfo-local-acceptance',version:VERSION});
try{
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp'),{requestInit:{headers:{Authorization:authorization}}}));
 const health=await client.callTool({name:'cfo_health',arguments:{}});
 const result=health.structuredContent;
 if(health.isError||result?.service_version!==VERSION||result.database!=='reachable')throw new Error('正式MCP健康检查未通过');
 const tools=(await client.listTools()).tools.map(t=>t.name);
 const required=['cfo_list_accounts','cfo_capture','cfo_read_document','cfo_record_existing_document','cfo_resolve_transaction','cfo_report','cfo_investments','cfo_batch_summary','cfo_field_coverage'];
 if(required.some(name=>!tools.includes(name))||tools.some(name=>name.startsWith('cfo_probe_')))throw new Error('正式MCP工具清单不完整或仍为归档探针');
 console.log(JSON.stringify({event:'formal_mcp_local_check',status:'ready',service_version:result.service_version,database:result.database,tool_count:tools.length,batch_capture_max_files:3,financial_transaction_posted:false,chatgpt_plugin_verified:false}));
}finally{await client.close();}
