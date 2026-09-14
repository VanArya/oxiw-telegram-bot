const express = require("express");
const { google } = require("googleapis");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const SPREADSHEET_ID =
  "17hDL6GiIKpEn3t6-qS99e2FTXnErrI9F-eDG5uOwthc";

const GOOGLE_KEY_FILE =
  "/etc/secrets/google-service-account.json";


/* =========================
   Google Sheets
========================= */

async function getGoogleSheets() {

  const auth =
    new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_FILE,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets.readonly"
      ]
    });

  const client =
    await auth.getClient();

  return google.sheets({
    version: "v4",
    auth: client
  });
}


async function getMovies() {

  const sheets =
    await getGoogleSheets();

  const response =
    await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "سینمایی"
    });

  const values =
    response.data.values || [];

  if (values.length < 2) {
    return [];
  }

  const headers =
    values[0].map(header =>
      String(header).trim()
    );

  return values
    .slice(1)
    .filter(row =>
      row.some(value =>
        String(value || "").trim() !== ""
      )
    )
    .map(row => {

      const movie = {};

      headers.forEach((header, index) => {

        movie[header] =
          row[index] || "";

      });

      return movie;
    });
}


/* =========================
   Telegram
========================= */

async function sendTelegramMessage(
  chatId,
  text,
  keyboard = null
) {

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

  const response =
    await fetch(url, {

      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify(payload)

    });

  const result =
    await response.json();

  console.log(
    "Telegram response:",
    result
  );

  return result;
}


/* =========================
   Telegram Update
========================= */

async function processTelegramUpdate(
  update
) {

  if (!update.message) {
    return;
  }

  const chatId =
    update.message.chat.id;

  const text =
    String(
      update.message.text || ""
    ).trim();


  /* /start */

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

    await sendTelegramMessage(

      chatId,

      "سلام 👋\n\n" +
      "به کلوپ سفید خوش آمدید 🎬\n\n" +
      "چه کاری می‌خواهید انجام دهید؟",

      keyboard

    );

    return;
  }


  /* جستجوی آزمایشی */

  try {

    const movies =
      await getMovies();

    const search =
      text.toLowerCase();

    const results =
      movies
        .filter(movie =>
          String(
            movie["اسم فیلم"] || ""
          )
          .toLowerCase()
          .includes(search)
        )
        .slice(0, 10);


    if (!results.length) {

      await sendTelegramMessage(
        chatId,
        "❌ فیلم موردنظر پیدا نشد."
      );

      return;
    }


    let message =
      "🎬 نتایج جستجو:\n\n";


    results.forEach(
      (movie, index) => {

        message +=
          `${index + 1}. ` +
          `${movie["اسم فیلم"] || ""}`;

        if (movie["سال"]) {
          message +=
            ` (${movie["سال"]})`;
        }

        if (movie["امتیاز"]) {
          message +=
            ` ⭐ ${movie["امتیاز"]}`;
        }

        message += "\n";

      }
    );


    await sendTelegramMessage(
      chatId,
      message
    );

  } catch (error) {

    console.error(
      "Google Sheets error:",
      error
    );

    await sendTelegramMessage(
      chatId,
      "⚠️ هنگام دریافت اطلاعات فیلم‌ها مشکلی پیش آمد."
    );

  }

}


/* =========================
   Routes
========================= */

app.get("/", (req, res) => {

  res
    .status(200)
    .send("OXIW Telegram Bot OK");

});


app.post("/telegram", async (req, res) => {

  console.log(
    "Telegram update:",
    JSON.stringify(req.body)
  );


  // پاسخ فوری به Telegram
  res
    .status(200)
    .send("OK");


  try {

    await processTelegramUpdate(
      req.body
    );

  } catch (error) {

    console.error(
      "Bot error:",
      error
    );

  }

});


/* =========================
   Start Server
========================= */

app.listen(
  PORT,
  () => {

    console.log(
      `OXIW Telegram Bot running on port ${PORT}`
    );

  }
);
