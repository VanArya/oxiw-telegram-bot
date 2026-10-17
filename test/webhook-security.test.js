// Express integration tests. Keep these separate from dependency-free unit tests.
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const {
  registerTelegramWebhook
} = require("../security");

async function fetchAndConsume(...args) {
  const response = await fetch(...args);
  await response.arrayBuffer();
  return response;
}

async function withWebhookServer(secret, handler, run) {
  const app = express();
  registerTelegramWebhook(app, express, secret, handler);

  const server = http.createServer(app);
  const sockets = new Set();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await run(baseUrl);
  } finally {
    const closePromise = server.listening
      ? new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        })
      : Promise.resolve();

    for (const socket of sockets) {
      socket.destroy();
    }

    server.closeAllConnections?.();
    await closePromise;
  }
}

test("rejects requests with no configured secret before parsing or handling", async () => {
  let handlerCalls = 0;
  const handlerMock = async (req, res) => {
    handlerCalls += 1;
    res.sendStatus(200);
  };

  await withWebhookServer(undefined, handlerMock, async baseUrl => {
    const response = await fetchAndConsume(`${baseUrl}/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ malformed json"
    });

    assert.equal(response.status, 503);
    assert.equal(handlerCalls, 0);
  });
});

test("rejects an invalid secret before JSON parsing or handler side effects", async () => {
  let handlerCalls = 0;
  const handlerMock = async (req, res) => {
    handlerCalls += 1;
    res.sendStatus(200);
  };

  await withWebhookServer("expected-secret", handlerMock, async baseUrl => {
    const response = await fetchAndConsume(`${baseUrl}/telegram`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret"
      },
      body: "{ malformed json"
    });

    assert.equal(response.status, 403);
    assert.equal(handlerCalls, 0);
  });
});

test("validates the secret, parses JSON, and then invokes the handler mock", async () => {
  const receivedBodies = [];
  const handlerMock = async (req, res) => {
    receivedBodies.push(req.body);
    res.sendStatus(200);
  };

  await withWebhookServer("expected-secret", handlerMock, async baseUrl => {
    const response = await fetchAndConsume(`${baseUrl}/telegram`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "expected-secret"
      },
      body: JSON.stringify({ update_id: 1 })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(receivedBodies, [{ update_id: 1 }]);
  });
});
