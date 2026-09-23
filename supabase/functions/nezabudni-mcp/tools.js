const uuid={type:'string',format:'uuid'};
const text={type:'string'};
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const file=object({download_url:text,file_id:text,mime_type:text,file_name:text},['download_url','file_id']);
const definitions=[
  ['get_nezabudni_context','Načíta členov skupiny a autoritatívny miestny čas.',null,object({}),true],
  ['search_nezabudni_tasks','Vyhľadá úlohy v skupine. Pred vytvorením over možné duplicity.','read_tasks',object({
    assignee:uuid,status:{type:'string',enum:['pending','completed','cancelled','rejected']},from:{type:'string',format:'date-time'},to:{type:'string',format:'date-time'},query:{type:'string',maxLength:180},limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:10000},
  }),true],
  ['get_nezabudni_task','Znova načíta konkrétnu úlohu a metadáta jej príloh zo servera.','read_tasks',object({task_id:uuid},['task_id']),true],
  ['create_nezabudni_task','Po výslovnom potvrdení vytvorí úlohu. Pri retry zachovaj request_id aj obsah. Potom úlohu over cez get_nezabudni_task.','create_task',object({
    request_id:uuid,title:{type:'string',minLength:1,maxLength:180},notes:{type:'string',maxLength:10000},
    assignee_id:uuid,local_date:{type:'string',format:'date'},local_time:{type:'string',pattern:'^([01][0-9]|2[0-3]):[0-5][0-9]$'},
    timezone:{type:'string',enum:['Europe/Bratislava']},notify_creator_on_complete:{type:'boolean'},ambiguous_time_choice:{type:'string',enum:['earlier','later']},
  },['request_id','title','assignee_id','local_date','local_time','timezone','notify_creator_on_complete']),false],
  ['add_nezabudni_attachment','Po potvrdení uloží používateľom poskytnutý obrázok alebo PDF ku konkrétnej úlohe. Retry musí zachovať request_id a súbor.','upload_attachment',object({task_id:uuid,request_id:uuid,file},['task_id','request_id','file']),false],
  ['get_nezabudni_attachment','Vráti krátkodobú URL na stiahnutie prílohy z úlohy v skupine.','read_tasks',object({task_id:uuid,attachment_id:uuid},['task_id','attachment_id']),true],
];
export const TOOL_DEFINITIONS=definitions.map(([name,description,scope,inputSchema,readOnlyHint])=>({
  name,description,scope,inputSchema,outputSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:true},
  annotations:{readOnlyHint,destructiveHint:false,openWorldHint:false,idempotentHint:true},
  securitySchemes:[{type:'oauth2',scopes:['openid']}],
  _meta:{securitySchemes:[{type:'oauth2',scopes:['openid']}],...(name==='add_nezabudni_attachment'?{'openai/fileParams':['file']}:{})},
}));
export function toolsForClient(client) {
  return TOOL_DEFINITIONS.filter(tool=>!tool.scope || client.allowed_operations.includes(tool.scope))
    .map(({scope,...descriptor})=>descriptor);
}
export function checkToolArguments(name,args,client) {
  const tool=TOOL_DEFINITIONS.find(tool=>tool.name===name);
  if(!tool || (tool.scope && !client.allowed_operations.includes(tool.scope))) throw new Error('TOOL_NOT_ALLOWED');
  if(!args || typeof args!=='object' || Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
  if(Object.keys(args).some(key=>!Object.hasOwn(tool.inputSchema.properties,key))
    || tool.inputSchema.required.some(key=>!Object.hasOwn(args,key))) throw new Error('INVALID_ARGUMENTS');
  // Exact semantic validation remains in the shared API and SQL functions.
  return tool;
}
