const { timingSafeEqual } = require("node:crypto");

const WEBHOOK_SECRET_HEADER =
  "x-telegram-bot-api-secret-token";

function createWebhookSecretMiddleware(secret) {
  const expected =
    typeof secret === "string" && secret.length > 0
      ? Buffer.from(secret, "utf8")
      : null;

  return function verifyWebhookSecret(req, res, next) {
    if (!expected) {
      return res.status(503).send("Webhook secret is not configured");
    }

    const suppliedHeader =
      req.headers?.[WEBHOOK_SECRET_HEADER];

    if (typeof suppliedHeader !== "string" || suppliedHeader.length === 0) {
      return res.status(403).send("Forbidden");
    }

    const supplied = Buffer.from(suppliedHeader, "utf8");

    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      return res.status(403).send("Forbidden");
    }

    return next();
  };
}

function registerTelegramWebhook(app, express, secret, handler) {
  const verifyWebhookSecret =
    createWebhookSecretMiddleware(secret);

  app.use((req, res, next) => {
    if (
      req.method !== "POST" ||
      !/^\/telegram\/?$/i.test(req.path)
    ) {
      return next();
    }

    return verifyWebhookSecret(req, res, next);
  });

  app.use(express.json());
  app.post("/telegram", handler);
}

function logSafeError(logger, event, error) {
  const name =
    typeof error?.name === "string" &&
    /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name)
      ? error.name
      : "Error";

  const details = { name };

  if (Number.isInteger(error?.code)) {
    details.code = error.code;
  }

  logger.error(event, details);
}

function logTelegramApiResult(logger, event, result) {
  const details = {
    ok: result?.ok === true
  };

  if (Number.isInteger(result?.error_code)) {
    details.error_code = result.error_code;
  }

  logger.info(event, details);
}

module.exports = {
  createWebhookSecretMiddleware,
  registerTelegramWebhook,
  logSafeError,
  logTelegramApiResult
};
