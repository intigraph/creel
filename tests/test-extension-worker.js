'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { Browser } = require('./browser.js');

async function main() {
  const browser = Object.create(Browser.prototype);
  browser.extensionManifest = { name: 'Creel Bridge', version: '0.4.0', background: { service_worker: 'worker.js' } };
  let polls = 0;
  const detached = [];
  browser.send = async (method, params, session) => {
    if (method === 'Target.getTargets') {
      polls++;
      return { targetInfos: [
        { type: 'service_worker', targetId: 'starting', url: 'chrome-extension://starting/worker.js' },
        { type: 'service_worker', targetId: 'other', url: 'chrome-extension://other/worker.js' },
      ] };
    }
    if (method === 'Target.attachToTarget') return { sessionId: params.targetId };
    if (method === 'Runtime.enable') return {};
    if (method === 'Target.detachFromTarget') { detached.push(params.sessionId); return {}; }
    assert.equal(method, 'Runtime.evaluate');
    const manifest = session === 'other' ? { name: 'Other extension', version: '0.4.0' } : browser.extensionManifest;
    const context = session === 'starting' && polls === 1 ? {} : { chrome: { runtime: { getManifest: () => manifest } } };
    try { return { result: { value: vm.runInNewContext(params.expression, context) } }; }
    catch (error) { return { exceptionDetails: { text: error.message } }; }
  };
  const worker = await browser.extensionWorker({ timeout: 1000 });
  assert.equal(worker.sessionId, 'starting');
  assert.equal(polls, 2, 'wait for the extension API instead of accepting an unready worker');
  assert.deepEqual(detached, ['starting', 'other'], 'detach both unready and unrelated workers');
  console.log('PASS extension API readiness and exact manifest identity');

  browser.send = async (method) => {
    assert.equal(method, 'Target.getTargets');
    return { targetInfos: [] };
  };
  await assert.rejects(browser.extensionWorker({ timeout: 1 }), /service worker never started/);
  console.log('PASS missing extension remains a failure');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
