const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function sendTelegramMessage(chatId, text, keyboard = null) {
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: text
  };

  if (keyboard) {
    payload.reply_markup = {
      inline_keyboard: keyboard
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  console.log("Telegram response:", result);

  return result;
}


function processTelegramUpdate(update) {

  if (!update.message) {
    return;
  }

  const chatId = update.message.chat.id;

  const text =
    String(update.message.text || "").trim();

  if (text === "/start") {

    const keyboard = [
      [
        {
          text: "🔍 جستجوی فیلم",
          callback_data: "search_movie"
        },
        {
          text: "📺 جستجوی سریال",
          callback_data: "search_series"
        }
      ],
      [
        {
          text: "🎲 پیشنهاد تصادفی",
          callback_data: "random_movie"
        },
        {
          text: "⭐ پیشنهاد کلوپ سفید",
          callback_data: "club_recommend"
        }
      ]
    ];

    sendTelegramMessage(
      chatId,
      "سلام 👋\n\n" +
      "به کلوپ سفید خوش آمدید 🎬\n\n" +
      "چه کاری می‌خواهید انجام دهید؟",
      keyboard
    );

  } else {

    sendTelegramMessage(
      chatId,
      "پیامت رو دریافت کردم 👌"
    );
  }
}


app.get("/", (req, res) => {
  res.status(200).send("OXIW Telegram Bot OK");
});


app.post("/telegram", async (req, res) => {

  console.log(
    "Telegram update:",
    JSON.stringify(req.body)
  );

  // اول سریع به Telegram پاسخ می‌دهیم
  res.status(200).send("OK");

  try {
    await processTelegramUpdate(req.body);
  } catch (error) {
    console.error("Bot error:", error);
  }
});


app.listen(PORT, () => {

  console.log(
    `OXIW Telegram Bot running on port ${PORT}`
  );

});
