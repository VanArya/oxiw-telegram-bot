# Webhook secret rollout

`POST /telegram` validates the `X-Telegram-Bot-Api-Secret-Token` header against
`TELEGRAM_WEBHOOK_SECRET` before parsing JSON. An absent secret returns HTTP
503; an absent or mismatched request header returns HTTP 403. The application
can start locally without the secret, but webhook updates will not be handled.

Configure the secret in the deployment environment and register the Telegram
webhook with the matching secret token before expecting production updates to
be processed. Missing configuration is fail-closed in every environment: the
server remains available, but rejects webhook updates. Never commit or log the
secret value. No live service or webhook configuration was changed as part of
this local code change.
