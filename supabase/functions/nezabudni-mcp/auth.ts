import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'npm:jose@6.2.12';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2';
import type { IntegrationClient } from '../chatgpt-api/index.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class OAuthError extends Error {}
export function tokenVerifier(issuer: string, resource: string, key?: JWTVerifyGetKey) {
  const keys=key ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token: string) => {
    const {payload}=await jwtVerify(token,keys,{issuer,audience:resource,algorithms:['ES256','RS256'],requiredClaims:['sub','exp','iat','client_id','integration_id','scope','role']});
    if(payload.role!=='nezabudni_mcp' || typeof payload.scope!=='string'
      || !payload.scope.split(' ').includes('openid')
      || ![payload.sub,payload.client_id,payload.integration_id].every(value=>typeof value==='string' && UUID.test(value))) throw new OAuthError('INVALID_TOKEN');
    return payload;
  };
}
export async function authenticateMcp(request: Request,admin: SupabaseClient,resource: string,verify: ReturnType<typeof tokenVerifier>): Promise<IntegrationClient> {
  const header=request.headers.get('authorization')??'';
  if(!header.startsWith('Bearer ') || header.length>16384) throw new OAuthError('AUTH_REQUIRED');
  let claims;
  try { claims=await verify(header.slice(7)); } catch { throw new OAuthError('INVALID_TOKEN'); }
  const {data:client,error}=await admin.from('integration_clients')
    .select('id,actor_id,name,active,allowed_operations,expires_at,oauth_client_id')
    .eq('id',claims.integration_id).eq('actor_id',claims.sub).eq('oauth_client_id',claims.client_id).maybeSingle();
  if(error || !client || !client.active || Date.parse(client.expires_at)<=Date.now()) throw new OAuthError('CONSENT_REQUIRED');
  const {data:app,error:appError}=await admin.from('integration_oauth_apps')
    .select('active,resource_uri,allowed_operations').eq('oauth_client_id',claims.client_id).maybeSingle();
  if(appError || !app?.active || app.resource_uri!==resource) throw new OAuthError('CLIENT_DISABLED');
  const tokenScopes=String(claims.scope).split(' ');
  return {...client,allowed_operations:client.allowed_operations.filter((scope:string)=>tokenScopes.includes(scope) && app.allowed_operations.includes(scope))};
}
