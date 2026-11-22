import {test as nodeTest} from 'node:test';
import {runStalledPreview} from './preview-auth-fixture.mjs';
const test=process.env.TEST_DATABASE_URL===undefined?nodeTest:nodeTest.skip;

const expected={current:{status:503,code:'private_storage_metadata_invalid'},logout:{status:401,code:'session_invalid'},withdraw:{status:403,code:'photo_forbidden'}};
for(const route of ['direct','ticket'])for(const change of ['current','logout','withdraw'])
 test(`candidate ${route} ${change} applies the current authority after a stalled body`,{timeout:60000},
  t=>runStalledPreview(t,route,change,expected[change]));
