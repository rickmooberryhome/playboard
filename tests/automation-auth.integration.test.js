const assert = require("node:assert/strict");
const test = require("node:test");

const automationWorker = require("../api/run-automation-queue");

function makeReq({ method = "GET", body = {}, query = {}, headers = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: {
      host: "playboard.test",
      "x-forwarded-proto": "https",
      "user-agent": "automation-auth-test",
      ...headers
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

async function call(handler, options) {
  const response = makeRes();
  await handler(makeReq(options), response);
  return response;
}

test("automation worker blocks unauthenticated cron requests when CRON_SECRET is configured", async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "phase2-secret";

  try {
    const blocked = await call(automationWorker, { method: "GET" });
    assert.equal(blocked.statusCode, 401);
    assert.equal(blocked.body.success, false);
    assert.equal(blocked.body.code, "UNAUTHORIZED");

    assert.equal(
      automationWorker.isAuthorized(makeReq({ headers: { authorization: "Bearer phase2-secret" } })),
      true
    );
    assert.equal(
      automationWorker.isAuthorized(makeReq({ headers: { authorization: "Bearer wrong-secret" } })),
      false
    );
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});
