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
   وضعیت کاربران
========================= */

const userStates = new Map();


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
   منوی اصلی
========================= */

function getMainKeyboard() {

  return [

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
}


/* =========================
   نمایش جزئیات فیلم
========================= */

async function showMovie(
  chatId,
  movie
) {

  let message =
    `🎬 ${movie["اسم فیلم"] || "بدون نام"}\n\n`;

  if (movie["سال"]) {
    message +=
      `📅 سال: ${movie["سال"]}\n`;
  }

  if (movie["ژانر"]) {
    message +=
      `🎭 ژانر: ${movie["ژانر"]}\n`;
  }

  if (movie["امتیاز"]) {
    message +=
      `⭐ امتیاز: ${movie["امتیاز"]}\n`;
  }

  if (movie["زبان"]) {
    message +=
      `🌐 زبان: ${movie["زبان"]}\n`;
  }

  if (movie["بازیگران"]) {
    message +=
      `\n👥 بازیگران:\n${movie["بازیگران"]}\n`;
  }

  if (movie["خلاصه داستان"]) {
    message +=
      `\n📝 خلاصه داستان:\n${movie["خلاصه داستان"]}\n`;
  }


  const keyboard = [];


  if (movie["لینک تریلر"]) {

    keyboard.push([
      {
        text: "▶️ تریلر",
        url: movie["لینک تریلر"]
      }
    ]);

  }


  keyboard.push([
    {
      text: "🔙 بازگشت به نتایج",
      callback_data: "back_results"
    }
  ]);


  await sendTelegramMessage(
    chatId,
    message,
    keyboard
  );
}


/* =========================
   جستجوی فیلم
========================= */

async function searchMovies(
  chatId,
  searchText
) {

  const movies =
    await getMovies();

  const search =
    searchText
      .trim()
      .toLowerCase();


  const results =
    movies
      .filter(movie => {

        const title =
          String(
            movie["اسم فیلم"] || ""
          )
          .toLowerCase();

        return title.includes(search);

      })
      .slice(0, 10);


  if (!results.length) {

    await sendTelegramMessage(
      chatId,
      "❌ فیلمی با این نام پیدا نشد.\n\n" +
      "نام دیگری وارد کنید."
    );

    return;

  }


  const keyboard =
    results.map(
      (movie, index) => {

        const title =
          movie["اسم فیلم"] ||
          "بدون نام";

        const year =
          movie["سال"]
            ? ` — ${movie["سال"]}`
            : "";

        return [
          {
            text:
              `${index + 1}. ${title}${year}`,

            callback_data:
              `movie_${index}`
          }
        ];

      }
    );


  userStates.set(
    chatId,
    {
      mode: "movie_results",
      results: results
    }
  );


  await sendTelegramMessage(
    chatId,
    "🎬 نتایج جستجو:\n\n" +
    "فیلم موردنظر را انتخاب کنید:",
    keyboard
  );

}


/* =========================
   پردازش پیام
========================= */

async function processMessage(
  message
) {

  const chatId =
    message.chat.id;

  const text =
    String(
      message.text || ""
    ).trim();


  if (text === "/start") {

    userStates.delete(chatId);

    await sendTelegramMessage(
      chatId,

      "سلام 👋\n\n" +
      "به کلوپ سفید خوش آمدید 🎬\n\n" +
      "چه کاری می‌خواهید انجام دهید؟",

      getMainKeyboard()
    );

    return;
  }


  const state =
    userStates.get(chatId);


  if (
    state &&
    state.mode === "search_movie"
  ) {

    await searchMovies(
      chatId,
      text
    );

    return;
  }


  await sendTelegramMessage(
    chatId,

    "برای شروع، از منوی زیر یک گزینه را انتخاب کنید:",

    getMainKeyboard()
  );

}


/* =========================
   پردازش دکمه‌ها
========================= */

async function processCallback(
  callback
) {

  const chatId =
    callback.message.chat.id;

  const data =
    callback.data;


  /* جستجوی فیلم */

  if (data === "search_movie") {

    userStates.set(
      chatId,
      {
        mode: "search_movie"
      }
    );

    await sendTelegramMessage(
      chatId,
      "🔍 نام فیلم موردنظرتان را وارد کنید:"
    );

    return;
  }


  /* جستجوی سریال */

  if (data === "search_series") {

    await sendTelegramMessage(
      chatId,
      "📺 جستجوی سریال در مرحله بعد اضافه می‌شود."
    );

    return;
  }


  /* پیشنهاد تصادفی */

  if (data === "random_movie") {

    await sendTelegramMessage(
      chatId,
      "🎲 پیشنهاد تصادفی در مرحله بعد اضافه می‌شود."
    );

    return;
  }


  /* پیشنهاد کلوپ */

  if (data === "club_recommend") {

    await sendTelegramMessage(
      chatId,
      "⭐ پیشنهادهای کلوپ سفید در مرحله بعد اضافه می‌شود."
    );

    return;
  }


  /* انتخاب فیلم */

  if (
    data.startsWith("movie_")
  ) {

    const index =
      Number(
        data.replace("movie_", "")
      );

    const state =
      userStates.get(chatId);


    if (
      !state ||
      !state.results ||
      !state.results[index]
    ) {

      await sendTelegramMessage(
        chatId,
        "⚠️ این نتیجه دیگر در دسترس نیست.\n\n" +
        "لطفاً دوباره جستجو کنید."
      );

      return;
    }


    const movie =
      state.results[index];


    userStates.set(
      chatId,
      {
        ...state,
        selectedMovie: movie
      }
    );


    await showMovie(
      chatId,
      movie
    );

    return;
  }


  /* بازگشت */

  if (data === "back_results") {

    const state =
      userStates.get(chatId);


    if (
      !state ||
      !state.results
    ) {

      await sendTelegramMessage(
        chatId,
        "نتایج قبلی دیگر در دسترس نیست.\n\n" +
        "لطفاً دوباره جستجو کنید."
      );

      return;
    }


    const keyboard =
      state.results.map(
        (movie, index) => {

          const title =
            movie["اسم فیلم"] ||
            "بدون نام";

          const year =
            movie["سال"]
              ? ` — ${movie["سال"]}`
              : "";

          return [
            {
              text:
                `${index + 1}. ${title}${year}`,

              callback_data:
                `movie_${index}`
            }
          ];

        }
      );


    await sendTelegramMessage(
      chatId,

      "🎬 نتایج جستجو:",

      keyboard
    );

    return;
  }

}


/* =========================
   Webhook
========================= */

app.get("/", (req, res) => {

  res
    .status(200)
    .send("OXIW Telegram Bot OK");

});


app.post(
  "/telegram",
  async (req, res) => {

    console.log(
      "Telegram update:",
      JSON.stringify(req.body)
    );


    // پاسخ فوری به Telegram
    res
      .status(200)
      .send("OK");


    try {

      if (req.body.callback_query) {

        await processCallback(
          req.body.callback_query
        );

      }


      if (req.body.message) {

        await processMessage(
          req.body.message
        );

      }

    } catch (error) {

      console.error(
        "Bot error:",
        error
      );

    }

  }
);


/* =========================
   Start
========================= */

app.listen(
  PORT,
  () => {

    console.log(
      `OXIW Telegram Bot running on port ${PORT}`
    );

  }
);
