// Dependency-free unit tests for security.js (Node built-ins only).
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createWebhookSecretMiddleware,
  logSafeError,
  logTelegramApiResult
} = require("../security");

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

test("rejects a request when the configured webhook secret is absent", () => {
  let nextCalls = 0;
  const response = mockResponse();
  const middleware = createWebhookSecretMiddleware(undefined);

  middleware(
    { headers: { "x-telegram-bot-api-secret-token": "any-value" } },
    response,
    () => { nextCalls += 1; }
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.body, "Webhook secret is not configured");
  assert.equal(nextCalls, 0);
});

test("rejects a wrong secret with the same byte length", () => {
  let nextCalls = 0;
  const response = mockResponse();
  const middleware = createWebhookSecretMiddleware("expected-secret");

  middleware(
    { headers: { "x-telegram-bot-api-secret-token": "wrong-secret---" } },
    response,
    () => { nextCalls += 1; }
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body, "Forbidden");
  assert.equal(nextCalls, 0);
});

test("passes the request when the webhook secret is valid", () => {
  let nextCalls = 0;
  const response = mockResponse();
  const middleware = createWebhookSecretMiddleware("expected-secret");

  middleware(
    { headers: { "x-telegram-bot-api-secret-token": "expected-secret" } },
    response,
    () => { nextCalls += 1; }
  );

  assert.equal(nextCalls, 1);
  assert.equal(response.statusCode, null);
});

test("redacts raw API responses, URLs, tokens, and error contents", () => {
  const calls = [];
  const loggerMock = {
    error(...args) { calls.push(args); },
    info(...args) { calls.push(args); }
  };
  const sensitive = [
    "private-bot-token",
    "receipt-file-id",
    "download-token",
    "https://private.example/path?token=secret"
  ];
  const error = new Error(sensitive.join(" "));
  error.config = { url: sensitive[3], headers: { authorization: sensitive[0] } };

  logSafeError(loggerMock, "Request failed", error);
  logTelegramApiResult(loggerMock, "Telegram API response", {
    ok: false,
    error_code: 400,
    description: sensitive.join(" "),
    result: { file_id: sensitive[1], text: sensitive.join(" ") }
  });

  const serialized = JSON.stringify(calls);
  for (const value of sensitive) {
    assert.equal(serialized.includes(value), false);
  }
  assert.equal(serialized.includes("file_id"), false);
  assert.equal(serialized.includes("description"), false);
});
