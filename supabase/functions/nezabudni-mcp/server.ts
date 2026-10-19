import { toolErrorResult } from './errors.js';
import { Server } from 'npm:@modelcontextprotocol/sdk@1.30.0/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.30.0/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from 'npm:@modelcontextprotocol/sdk@1.30.0/types.js';
import { toolsForClient, checkToolArguments } from './tools.js';
import type { IntegrationClient } from '../chatgpt-api/index.ts';

export type InvokeTool=(name:string,args:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export async function serveMcp(request: Request,client: IntegrationClient,invoke:InvokeTool) {
  const server=new Server({name:'nezabudni',version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,()=>({tools:toolsForClient(client)}));
  server.setRequestHandler(CallToolRequestSchema,async ({params}:CallToolRequest)=>{
    try {
      const args=params.arguments??{};
      checkToolArguments(params.name,args,client);
      const result=await invoke(params.name,args);
      return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result,isError:result.ok===false};
    } catch(error) {
      const result=toolErrorResult(error);
      return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result,isError:true};
    }
  });
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);
  try { return await transport.handleRequest(request); }
  finally { await server.close(); }
}
