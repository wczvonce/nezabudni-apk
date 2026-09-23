/** @param {string[]} memberIds @param {string} actorId @param {string|null} configuredId */
export function selectPartnerId(memberIds, actorId, configuredId) {
  const others=memberIds.filter(id=>id!==actorId);
  if(configuredId) return others.includes(configuredId)?configuredId:null;
  return others.length===1?others[0]:null;
}
