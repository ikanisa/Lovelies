import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operatorCapabilities,canOperate,capabilitySelection,OPERATOR_CAPABILITIES} from './operator-capabilities.mjs';
test('operator hints deny absent, anonymous-shaped and malformed capability claims',()=>{
 assert.deepEqual(operatorCapabilities(null),[]);assert.deepEqual(operatorCapabilities({roles:['user']}),[]);
 for(const operator_capabilities of [null,'support.read',['root'],['support.read','support.read']])assert.throws(()=>operatorCapabilities({operator_capabilities}));
 assert.deepEqual(operatorCapabilities({roles:['admin']}),OPERATOR_CAPABILITIES);
 assert.deepEqual(operatorCapabilities({roles:['admin'],operator_capabilities:[]}),[]);
});
test('delegated capabilities are exact; read access does not imply mutation or delegation',()=>{
 const operator={roles:['user'],operator_capabilities:['support.read']};
 assert(canOperate(operator,'support.read'));assert(!canOperate(operator,'support.review'));assert(!canOperate(operator,'operators.manage'));
 assert.deepEqual(capabilitySelection(['support.review','uploads.recover']),['support.read','support.review','uploads.read','uploads.recover']);
 assert.throws(()=>capabilitySelection(['operators.manage']));
});
