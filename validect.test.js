const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createValidectClient, normalize } = require('./validect');
const ok = data => ({ ok: true, json: async () => data });
for (const [input, expected] of [['valid','Valid'],['invalid','Invalid'],['accept_all','Catch-All'],['unknown','Unknown']]) {
  test(`maps ${input}`, () => assert.equal(normalize({status: input}, 'a@example.com').status, expected));
}
test('unrecognized responses never become valid', () => {
  assert.equal(normalize({success:true}, 'a@example.com').status,'Unknown');
  assert.equal(normalize({status:'valid',email:'b@example.com'}, 'a@example.com').status,'Unknown');
});
test('encodes request and caches per email, deduplicates inflight', async () => {
  let calls=0;
  const client=createValidectClient({key:'test-secret',interval:0,fetcher:async (url, opts)=>{
    calls++; assert.equal(url.hostname,'validect-email-verification-v1.p.rapidapi.com');
    assert.equal(opts.headers['x-rapidapi-key'],'test-secret'); assert.equal(opts.method,'GET');
    return ok({status:url.searchParams.get('email')==='a+tag@example.com'?'valid':'invalid'});
  }});
  const [a,b]=await Promise.all([client.verify('a+tag@example.com'),client.verify('a+tag@example.com')]);
  assert.equal(a.status,'Valid'); assert.equal(b.status,'Valid'); assert.equal(calls,1);
  assert.equal((await client.verify('b@example.com')).status,'Invalid');
  assert.equal((await client.verify('a+tag@example.com')).externalApiCached,true); assert.equal(calls,2);
});
for(const code of [401,403,429,500]) test(`HTTP ${code} remains unknown`,async()=>{
  let calls=0;
  const client=createValidectClient({key:'test',interval:0,fetcher:async()=>{calls++;return {ok:false,status:code,headers:{get:()=>null}};}});
  assert.equal((await client.verify('a@example.com')).status,'Unknown');
  await client.verify('b@example.com'); assert.equal(calls,code===500?2:1);
});
test('timeout and malformed JSON are unknown',async()=>{
  for(const fetcher of [async()=>{throw {name:'AbortError'};},async()=>({ok:true,json:async()=>{throw Error();}})]) {
    const client=createValidectClient({key:'test',interval:0,fetcher});
    assert.equal((await client.verify('a@example.com')).status,'Unknown');
  }
});
test('missing key does not call upstream',async()=>{
  const client=createValidectClient({key:'',fetcher:()=>{throw Error('must not call');}});
  assert.equal((await client.verify('a@example.com')).status,'Unknown');
});
