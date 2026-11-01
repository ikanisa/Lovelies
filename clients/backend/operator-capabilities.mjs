// Presentation/admission hints only. The API reads current database grants on
// every request and every operation replay; browser state never grants access.
export const OPERATOR_CAPABILITIES=Object.freeze(['overview.read','users.read','users.sessions.revoke','support.read','support.review',
  'safety.read','safety.review','guardian.read','guardian.review','privacy.read','privacy.review','uploads.read','uploads.recover','retention.read','retention.manage']);
export function operatorCapabilities(value) {
  if(!value)return [];
  const capabilities=value.operator_capabilities;
  if(capabilities===undefined)return Array.isArray(value.roles)&&value.roles.includes('admin')?[...OPERATOR_CAPABILITIES]:[];
  if(!Array.isArray(capabilities)||capabilities.length>OPERATOR_CAPABILITIES.length||new Set(capabilities).size!==capabilities.length||
      capabilities.some(capability=>!OPERATOR_CAPABILITIES.includes(capability)))throw Object.assign(new Error('operator_authority_unavailable'),{code:'operator_authority_unavailable'});
  return [...capabilities];
}
export function canOperate(operator,capability) {
  return capability==='operators.manage'?!!operator?.roles?.includes('admin'):operatorCapabilities(operator).includes(capability);
}
export const capabilityPrerequisites=Object.freeze({'users.sessions.revoke':'users.read','support.review':'support.read','safety.review':'safety.read',
  'guardian.review':'guardian.read','privacy.review':'privacy.read','uploads.recover':'uploads.read','retention.manage':'retention.read'});
export function capabilitySelection(values) {
  if(!Array.isArray(values)||values.some(value=>!OPERATOR_CAPABILITIES.includes(value)))throw new Error('operator_access_input_invalid');
  const selected=new Set(values);for(const value of values)if(capabilityPrerequisites[value])selected.add(capabilityPrerequisites[value]);
  return [...selected].sort();
}
