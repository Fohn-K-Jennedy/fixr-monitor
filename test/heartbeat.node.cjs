const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const local=__dirname+'/repaired.mjs';
const source=(fs.existsSync(local)?fs.readFileSync(local,'utf8'):fs.readFileSync(__dirname+'/../src/index.js','utf8')).replace('export default {','const worker = {').replace('export class NotificationCoordinator','class NotificationCoordinator');
function setup({result={success:true},coordinatorFails=false,heartbeatFailures=0}={}) {
  const calls=[];
  const env={BETTERSTACK_HEARTBEAT_URL:'https://mock.invalid/heartbeat',NOTIFICATION_COORDINATOR:{idFromName:()=> 'singleton',get:()=>({fetch:async()=>{if(coordinatorFails)throw Error('mock');return Response.json(result);}})}};
  const ctx=vm.createContext({URL,AbortController,setTimeout,clearTimeout,console:{log(){},error(){}},fetch:async url=>{calls.push(url);return new Response('',{status:calls.length<=heartbeatFailures?503:200});}});
  vm.runInContext(source,ctx);
  return {ctx,env,calls};
}
test('healthy coordinator emits success heartbeat',async()=>{const h=setup();await h.ctx.runScheduledCheck(h.env);assert.deepEqual(h.calls,['https://mock.invalid/heartbeat']);});
test('delivery review requirement emits failure heartbeat',async()=>{const h=setup({result:{success:false,status:'delivery_review_required'}});await h.ctx.runScheduledCheck(h.env);assert.deepEqual(h.calls,['https://mock.invalid/heartbeat/fail']);});
test('coordinator exception emits failure heartbeat',async()=>{const h=setup({coordinatorFails:true});await h.ctx.runScheduledCheck(h.env);assert.deepEqual(h.calls,['https://mock.invalid/heartbeat/fail']);});
test('transient heartbeat failure retries heartbeat only',async()=>{const h=setup({heartbeatFailures:1});await h.ctx.runScheduledCheck(h.env);assert.equal(h.calls.length,2);assert.ok(h.calls.every(url=>url.endsWith('/heartbeat')));});
test('persistent heartbeat failure rejects scheduled task',async()=>{const h=setup({heartbeatFailures:3});await assert.rejects(h.ctx.runScheduledCheck(h.env),/after 3 attempts/);assert.equal(h.calls.length,3);});
test('missing heartbeat secret rejects scheduled task',async()=>{const h=setup();delete h.env.BETTERSTACK_HEARTBEAT_URL;await assert.rejects(h.ctx.runScheduledCheck(h.env),/secret is missing/);});
