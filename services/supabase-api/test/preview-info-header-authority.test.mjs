import {test} from 'node:test';
import {runHeaderTimeout} from './preview-info-header-authority-fixture.mjs';

const expected={current:{status:503,code:'private_storage_unavailable'},logout:{status:401,code:'session_invalid'},withdraw:{status:403,code:'photo_forbidden'}};
for(const route of ['direct','ticket'])for(const change of ['current','logout','withdraw'])
 test(`header timeout ${route} ${change} preserves the current authority decision`,{timeout:60000},
  t=>runHeaderTimeout(t,route,change,expected[change]));

test('header timeout retains expired-ticket precedence',{timeout:60000},
 t=>runHeaderTimeout(t,'ticket','expired-ticket',{status:403,code:'preview_changed'}));
