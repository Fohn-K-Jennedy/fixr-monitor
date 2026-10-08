const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const local = __dirname + '/repaired.mjs';
const source = fs.existsSync(local) ? fs.readFileSync(local,'utf8') : fs.readFileSync(__dirname+'/../src/index.js','utf8');

function harness() {
  let urls=['https://fixr.co/event/existing-tickets-1'], posts=0, writes=0;
  let failWrite=0, bodyFailure=false, postFailure=false, invalidListing=false;
  const disk=new Map();
  const storage={
    async get(key){return structuredClone(disk.get(key));},
    async put(key,value){writes++;if(writes===failWrite)throw Error('Mock storage failure');disk.set(key,structuredClone(value));}
  };
  const env={WHATSAPP_SENDING_ENABLED:'true',WHATSAPP_TO:'10000000000',WHATSAPP_PHONE_NUMBER_ID:'mock',WHATSAPP_ACCESS_TOKEN:'mock'};
  const ctx=vm.createContext({URL,Request,Response,TextEncoder,Uint8Array,AbortController,setTimeout,clearTimeout,console,crypto:require('node:crypto').webcrypto,
    fetch:async url=>{
      if(String(url).includes('graph.facebook.com')) {
        posts++;
        if(postFailure)throw Error('Mock network timeout');
        return {ok:true,status:200,text:async()=>{if(bodyFailure)throw Error('Mock body failure');return '{}';}};
      }
      if(invalidListing) return {ok:false,status:503,text:async()=>''};
      return {ok:true,status:200,text:async()=>String(url).includes('/organiser/') ? urls.map(url=>`<a href="${url}">Event</a>`).join('') : '<h1>Mock Event</h1>'};
    }
  });
  vm.runInContext(source.replace('export default {','const worker = {').replace('export class NotificationCoordinator','class NotificationCoordinator')+'\n globalThis.api={worker,NotificationCoordinator};',ctx);
  // The clock is deliberately isolated from the real monitoring window.
  vm.runInContext('isWithinMonitoringWindow = () => true;',ctx);
  let object=new ctx.api.NotificationCoordinator({storage},env);
  env.NOTIFICATION_COORDINATOR={idFromName:()=> 'singleton',get:()=>({fetch:(url,options)=>object.fetch(new Request(url,options))})};
  const h={env, posts:()=>posts, disk, ctx,
    check:async()=>{const r=await object.fetch(new Request('https://internal/check',{method:'POST'}));return r.json();},
    health:async()=>{const r=await ctx.api.worker.fetch(new Request('https://public/health'),env);return r.json();},
    public:path=>ctx.api.worker.fetch(new Request('https://public'+path),env),
    urls:value=>{urls=value;}, failNextWrite:()=>{failWrite=writes+1;},failWriteAfter:n=>{failWrite=writes+n;},
    bodyFailure:()=>{bodyFailure=true;},postFailure:()=>{postFailure=true;},invalidListing:()=>{invalidListing=true;},
    restart:()=>{object=new ctx.api.NotificationCoordinator({storage},env);},
    newEvent:()=>{urls.push('https://fixr.co/event/new-tickets-2');}
  };
  return h;
}

test('initial deployment baselines existing events without backlog messages',async()=>{
  const h=harness();h.urls(Array.from({length:18},(_,i)=>`https://fixr.co/event/old-tickets-${i+1}`));
  assert.equal((await h.check()).status,'baseline_created');await h.check();assert.equal(h.posts(),0);
});
test('one new event sends once across subsequent runs and restart',async()=>{
  const h=harness();await h.check();h.newEvent();assert.equal((await h.check()).notifications_sent,1);h.restart();await h.check();assert.equal(h.posts(),1);
});
test('failed durable claim prevents external send',async()=>{
  const h=harness();await h.check();h.newEvent();h.failNextWrite();assert.equal((await h.check()).status,'check_failed');assert.equal(h.posts(),0);
});
test('failed receipt persistence leaves claim blocking resend after restart',async()=>{
  const h=harness();await h.check();h.newEvent();h.failWriteAfter(2);await h.check();h.restart();assert.equal((await h.check()).status,'delivery_review_required');assert.equal(h.posts(),1);
});
test('accepted message with unreadable body never retries',async()=>{
  const h=harness();await h.check();h.newEvent();h.bodyFailure();await h.check();h.restart();await h.check();assert.equal(h.posts(),1);assert.equal((await h.health()).whatsapp_sending_enabled,false);
});
test('ambiguous POST timeout never retries',async()=>{
  const h=harness();await h.check();h.newEvent();h.postFailure();await h.check();await h.check();assert.equal(h.posts(),1);
});
test('overlapping invocations cannot double send',async()=>{
  const h=harness();await h.check();h.newEvent();await Promise.all([h.check(),h.check(),h.check()]);assert.equal(h.posts(),1);
});
test('public routes including test endpoint never trigger WhatsApp',async()=>{
  const h=harness();await h.check();h.newEvent();
  for(const path of ['/','/favicon.ico','/test-whatsapp','/check'])assert.equal((await h.public(path)).status,404);
  await h.health();assert.equal(h.posts(),0);
});
test('recipient normalization deduplicates numbers, sends each recipient once',async()=>{
  const h=harness();h.env.WHATSAPP_RECIPIENTS='10000000000,+1 000 000 0000,10000000001';await h.check();h.newEvent();await h.check();await h.check();assert.equal(h.posts(),2);
});
test('same numeric FIXR event ID with changed slug is not new',async()=>{
  const h=harness();await h.check();h.urls(['https://fixr.co/event/renamed-tickets-1/']);await h.check();assert.equal(h.posts(),0);
});
test('large batch pauses before any message and does not auto resume',async()=>{
  const h=harness();await h.check();h.urls(Array.from({length:4},(_,i)=>`https://fixr.co/event/new-tickets-${i+2}`));assert.equal((await h.check()).status,'sending_limit_exceeded');h.newEvent();await h.check();assert.equal(h.posts(),0);
});
test('per-run recipient fanout cap prevents message burst',async()=>{
  const h=harness();h.env.WHATSAPP_RECIPIENTS=Array.from({length:7},(_,i)=>String(10000000000+i)).join(',');await h.check();h.urls(['https://fixr.co/event/a-tickets-2','https://fixr.co/event/b-tickets-3']);await h.check();assert.equal(h.posts(),0);
});
test('rolling hourly attempt budget persists across runs',async()=>{
  const h=harness();await h.check();const ledger=h.disk.get('notification_ledger_v1');ledger.attempts=Array(30).fill(Date.now());h.disk.set('notification_ledger_v1',ledger);h.newEvent();assert.equal((await h.check()).status,'sending_limit_exceeded');assert.equal(h.posts(),0);
});
test('FIXR outage cannot reset baseline or cause sends',async()=>{
  const h=harness();h.invalidListing();assert.equal((await h.check()).status,'check_failed');assert.equal(h.disk.size,0);assert.equal(h.posts(),0);
});
test('empty event listing cannot initialize baseline',async()=>{
  const h=harness();h.urls([]);assert.equal((await h.check()).status,'check_failed');assert.equal(h.disk.size,0);
});
test('disabled sender cannot send a new event',async()=>{
  const h=harness();await h.check();h.env.WHATSAPP_SENDING_ENABLED='false';h.newEvent();await h.check();assert.equal(h.posts(),0);
});
test('out-of-window check cannot send a new event',async()=>{
  const h=harness();await h.check();h.newEvent();vm.runInContext('isWithinMonitoringWindow=()=>false;',h.ctx);assert.equal((await h.check()).status,'outside_monitoring_window');assert.equal(h.posts(),0);
});
