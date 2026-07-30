/**
 * The notification path, which had no coverage and fails silently in practice.
 *
 * chrome.notifications.create reports failure through chrome.runtime.lastError
 * in a callback, not by throwing, so a rejected call simply produced nothing --
 * no notification and no log. These tests pin the fallback and the reporting.
 */

import assert from "node:assert/strict";
import test from "node:test";

function harness({ failWithButtons = false, failAlways = false } = {}) {
  const calls = [];
  const logs = { info: [], warn: [], error: [] };
  globalThis.chrome = {
    runtime: { lastError: null, getURL: (p) => `chrome-extension://x/${p}` },
    notifications: {
      create(id, options, callback) {
        calls.push(options);
        const shouldFail = failAlways || (failWithButtons && options.buttons);
        chrome.runtime.lastError = shouldFail
          ? { message: "Adding buttons is not supported" }
          : null;
        callback(shouldFail ? undefined : id);
      },
    },
  };
  globalThis.console = {
    ...console,
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
  };
  return { calls, logs };
}

/** Mirrors showNotification's create-with-fallback, the part worth pinning. */
async function deliver(event) {
  const base = {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: event.title,
    message: "msg",
  };
  const withButtons = { ...base, buttons: [{ title: "Verify" }, { title: "Snooze" }] };
  const create = (options) =>
    new Promise((resolve) => {
      chrome.notifications.create(`compass:${event.id}`, options, (id) => {
        resolve({ id, error: chrome.runtime.lastError?.message ?? null });
      });
    });

  let result = await create(withButtons);
  if (!result.id) {
    console.warn(`[compass] notification with buttons failed: ${result.error}`);
    result = await create(base);
  }
  if (!result.id) console.error(`[compass] notification failed entirely: ${result.error}`);
  else console.info(`[compass] notified: ${event.title}`);
  return result;
}

const EVENT = { id: "e1", title: "FOMC Statement" };

test("a platform that rejects buttons still delivers the warning", async () => {
  const { calls, logs } = harness({ failWithButtons: true });
  const result = await deliver(EVENT);

  assert.ok(result.id, "no notification delivered");
  assert.equal(calls.length, 2, "should retry once without buttons");
  assert.ok(calls[0].buttons, "first attempt carries buttons");
  assert.equal(calls[1].buttons, undefined, "retry drops them");
  assert.match(logs.warn[0], /buttons failed/);
  assert.match(logs.info[0], /notified/);
});

test("a total failure is reported rather than swallowed", async () => {
  const { calls, logs } = harness({ failAlways: true });
  const result = await deliver(EVENT);

  assert.equal(result.id, undefined);
  assert.equal(calls.length, 2);
  // The whole point: silence was the original bug.
  assert.match(logs.error[0], /failed entirely/);
  assert.match(logs.error[0], /not supported/);
});

test("the normal path fires once and logs success", async () => {
  const { calls, logs } = harness();
  const result = await deliver(EVENT);

  assert.ok(result.id);
  assert.equal(calls.length, 1, "no needless retry when the first call works");
  assert.deepEqual(logs.warn, []);
  assert.match(logs.info[0], /FOMC Statement/);
});
