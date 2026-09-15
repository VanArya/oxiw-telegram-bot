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
  "https://www.googleapis.com/auth/spreadsheets"
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

async function getSeries() {

  const sheets =
    await getGoogleSheets();

  const response =
    await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "سریال"
    });

  const values =
    response.data.values || [];

  if (values.length < 2) {
    return [];
  }

  // نرمال‌سازی نام ستون‌ها
  const headers =
    values[0].map(header =>
      String(header)
        .trim()
        .replace(/\s+/g, " ")
    );

  return values
    .slice(1)
    .filter(row =>
      row.some(value =>
        String(value || "").trim() !== ""
      )
    )
    .map(row => {

      const series = {};

      headers.forEach((header, index) => {
        series[header] =
          row[index] || "";
      });

      return series;
    });
}

async function registerTelegramVisit(message) {
  const sheets = await getGoogleSheets();

  const user = message.from || {};

  const telegramId = user.id
    ? String(user.id)
    : "";

  const username = user.username
    ? "@" + user.username
    : "";

  const name =
    [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "بازدیدها",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        new Date(),
        "تلگرام",
        telegramId,
        username,
        name
      ]]
    }
  });

  console.log(
    "Telegram visit registered:",
    telegramId,
    username,
    name
  );
}

async function registerTelegramMovieView(message, movie) {
  const sheets = await getGoogleSheets();

  const user = message.from || {};

  const visitorId = user.id
    ? String(user.id)
    : "UNKNOWN";

  const username = user.username
    ? "@" + user.username
    : "";

  const name =
    [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || "مهمان";

  const movieName =
    movie["اسم فیلم"] ||
    movie["اسم  فیلم"] ||
    "بدون نام";

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "بازدید فیلم ها",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        new Date(),
        movieName,
        visitorId,
        username,
        name
      ]]
    }
  });

  console.log(
    "Telegram movie view registered:",
    movieName,
    visitorId,
    username,
    name
  );
}

async function registerTelegramSeriesView(message, series) {
  const sheets = await getGoogleSheets();

  const user = message.from || {};

  const visitorId = user.id
    ? String(user.id)
    : "UNKNOWN";

  const username = user.username
    ? "@" + user.username
    : "";

  const name =
    [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || "مهمان";

  const seriesName =
    series["اسم فیلم"] ||
    series["اسم  فیلم"] ||
    "بدون نام";

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "بازدید فیلم ها",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        new Date(),
        seriesName,
        visitorId,
        username,
        name
      ]]
    }
  });

  console.log(
    "Telegram series view registered:",
    seriesName,
    visitorId,
    username,
    name
  );
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


async function sendTelegramPhoto(
  chatId,
  photoUrl,
  caption,
  keyboard = null
) {

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;

  const payload = {
    chat_id: chatId,
    photo: photoUrl,
    caption: caption
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
    "Telegram photo response:",
    result
  );

  if (!result.ok) {

    throw new Error(
      result.description ||
      "Telegram sendPhoto failed"
    );

  }

  return result;
}


/* =========================
   منوی اصلی
========================= */

function getMainKeyboard() {

  return [

    [
      {
        text: "🎬 جستجوی فیلم",
        callback_data: "search_movie"
      },
      {
        text: "📺 جستجوی سریال",
        callback_data: "search_series"
      }
    ],

    [
      {
        text: "⭐ پیشنهاد کلوپ سفید",
        callback_data: "club_recommend"
      }
    ],

    [
      {
        text: "🆕 جدیدها",
        callback_data: "new_movies"
      },
      {
        text: "ℹ️ راهنما",
        callback_data: "help"
      }
    ]

  ];
}


function getHomeButton() {

  return [
    {
      text: "🏠 منوی اصلی",
      callback_data: "main_menu"
    }
  ];
}


/* =========================
   نمایش جزئیات فیلم
========================= */

async function showMovie(
  chatId,
  movie
) {

  try {
    const state = userStates.get(chatId);

    await registerTelegramMovieView(
      {
        from: state?.telegramUser || {}
      },
      movie
    );
  } catch (error) {
    console.error(
      "Telegram movie view log error:",
      error
    );
  }
  
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


  keyboard.push([
    {
      text: "🏠 منوی اصلی",
      callback_data: "main_menu"
    }
  ]);


  const posterUrl =
    String(
      movie["پوستر فیلم"] || ""
    ).trim();


  if (posterUrl) {

    try {

      const photoResult =
        await sendTelegramPhoto(
          chatId,
          posterUrl,
          message,
          keyboard
        );

      if (
        photoResult &&
        photoResult.ok
      ) {

        return;

      }

    } catch (error) {

      console.error(
        "Poster error:",
        error
      );

    }

  }


  await sendTelegramMessage(
    chatId,
    message,
    keyboard
  );
}

async function showSeries(
  chatId,
  series
) {

  try {
    const state =
      userStates.get(chatId);

    await registerTelegramSeriesView(
      {
        from:
          state?.telegramUser || {}
      },
      series
    );

  } catch (error) {

    console.error(
      "Telegram series view log error:",
      error
    );

  }
  
    let message =
    `📺 ${series["اسم فیلم"] || "بدون نام"}\n\n`;

  if (
    series["سال شروع"] ||
    series["سال پایان"]
  ) {

    message +=
      `📅 سال پخش: ` +
      `${series["سال شروع"] || "نامشخص"}` +
      ` تا ` +
      `${series["سال پایان"] || "نامشخص"}\n`;
  }

  if (series["تعداد فصل و قسمت"]) {

    message +=
      `📺 تعداد فصل و قسمت: ` +
      `${series["تعداد فصل و قسمت"]}\n`;
  }

  if (series["ژانر"]) {

    message +=
      `🎭 ژانر: ${series["ژانر"]}\n`;
  }

  if (series["امتیاز"]) {

    message +=
      `⭐ امتیاز: ${series["امتیاز"]}\n`;
  }

  if (series["زبان"]) {

    message +=
      `🌐 زبان: ${series["زبان"]}\n`;
  }

  if (series["بازیگران"]) {

    message +=
      `\n👥 بازیگران:\n${series["بازیگران"]}\n`;
  }

  if (series["خلاصه داستان"]) {

    message +=
      `\n📝 خلاصه داستان:\n${series["خلاصه داستان"]}\n`;
  }

  const keyboard = [];


  if (series["لینک تریلر"]) {

    keyboard.push([
      {
        text: "▶️ تریلر",
        url: series["لینک تریلر"]
      }
    ]);

  }


  keyboard.push([
    {
      text: "🔙 بازگشت به نتایج",
      callback_data: "back_series_results"
    }
  ]);


  keyboard.push([
    {
      text: "🏠 منوی اصلی",
      callback_data: "main_menu"
    }
  ]);


  const posterUrl =
    String(
      series["پوستر فیلم"] || ""
    ).trim();


  if (posterUrl) {

    try {

      const photoResult =
        await sendTelegramPhoto(
          chatId,
          posterUrl,
          message,
          keyboard
        );

      if (
        photoResult &&
        photoResult.ok
      ) {
        return;
      }

    } catch (error) {

      console.error(
        "Series poster error:",
        error
      );

    }

  }


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
      "نام دیگری وارد کنید.",

      [
        getHomeButton()
      ]
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


  keyboard.push(
    getHomeButton()
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

async function searchSeries(
  chatId,
  searchText
) {

  const series =
    await getSeries();

console.log(
  "SERIES SAMPLE:",
  JSON.stringify(series.slice(0, 3))
);
  
  const search =
    searchText
      .trim()
      .toLowerCase();

  const results =
    series
      .filter(item => {

        const title =
          String(
            item["اسم فیلم"] || ""
          ).toLowerCase();

        return title.includes(search);

      })
      .slice(0, 10);


  if (!results.length) {

    await sendTelegramMessage(

      chatId,

      "❌ سریالی با این نام پیدا نشد.\n\n" +
      "نام دیگری وارد کنید.",

      [
        getHomeButton()
      ]

    );

    return;
  }


  const keyboard =
    results.map(
      (item, index) => {

        const title =
          item["اسم فیلم"] ||
          "بدون نام";

        const year =
          item["سال"]
            ? ` — ${item["سال"]}`
            : "";

        return [
          {
            text:
              `${index + 1}. ${title}${year}`,

            callback_data:
              `series_${index}`
          }
        ];

      }
    );


  keyboard.push(
    getHomeButton()
  );


  userStates.set(

    chatId,

    {
      mode: "series_results",
      results: results
    }

  );


  await sendTelegramMessage(

    chatId,

    "📺 نتایج جستجوی سریال:\n\n" +
    "سریال موردنظر را انتخاب کنید:",

    keyboard

  );
}

/* =========================
   پیشنهاد کلوپ سفید
========================= */

async function recommendCinema(
  chatId
) {

  const movies =
    await getMovies();

  const recommended =
    movies.filter(movie =>
      String(
        movie["پیشنهادی"] || ""
      ).trim() === "پیشنهادی"
    );

  if (!recommended.length) {

    await sendTelegramMessage(
      chatId,
      "❌ در حال حاضر فیلم پیشنهادی‌ای وجود ندارد.",
      [
        getHomeButton()
      ]
    );

    return;
  }

  const randomIndex =
    Math.floor(
      Math.random() * recommended.length
    );

  const movie =
    recommended[randomIndex];

  await showMovie(
    chatId,
    movie
  );
}


async function recommendSeries(
  chatId
) {

  const series =
    await getSeries();

  const recommended =
    series.filter(item =>
      String(
        item["پیشنهادی"] || ""
      ).trim() === "پیشنهادی"
    );

  if (!recommended.length) {

    await sendTelegramMessage(
      chatId,
      "❌ در حال حاضر سریال پیشنهادی‌ای وجود ندارد.",
      [
        getHomeButton()
      ]
    );

    return;
  }

  const randomIndex =
    Math.floor(
      Math.random() * recommended.length
    );

  const selectedSeries =
    recommended[randomIndex];

  await showSeries(
    chatId,
    selectedSeries
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

    try {
  await registerTelegramVisit(message);
} catch (error) {
  console.error(
    "Telegram visit log error:",
    error
  );
}
    
    await sendTelegramMessage(

      chatId,

      "🎬 کلوپ سفید | OXIW\n\n" +
      "به کلوپ سفید خوش آمدید.\n\n" +
      "چه کاری می‌خواهید انجام دهید؟",

      getMainKeyboard()

    );

    return;
  }


  const state =
    userStates.get(chatId);

if (message.from) {
  const currentState =
    userStates.get(chatId) || {};

  currentState.telegramUser =
    message.from;

  userStates.set(
    chatId,
    currentState
  );
}

  
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

  if (
  state &&
  state.mode === "search_series"
) {

  await searchSeries(
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

  if (callback.from) {
    const currentState =
      userStates.get(chatId) || {};

    currentState.telegramUser =
      callback.from;

    userStates.set(
      chatId,
      currentState
    );
  }
  
  /* تأیید کلیک دکمه */

  try {

    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,

      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          callback_query_id:
            callback.id
        })

      }
    );

  } catch (error) {

    console.error(
      "Callback acknowledgement error:",
      error
    );

  }


  /* =========================
     منوی اصلی
  ========================= */

  if (data === "main_menu") {

    userStates.delete(chatId);

    await sendTelegramMessage(

      chatId,

      "🎬 کلوپ سفید | OXIW\n\n" +
      "به کلوپ سفید خوش آمدید.\n\n" +
      "چه کاری می‌خواهید انجام دهید؟",

      getMainKeyboard()

    );

    return;
  }


  /* =========================
     جستجوی فیلم
  ========================= */

  if (data === "search_movie") {

    userStates.set(

      chatId,

      {
        mode: "search_movie"
      }

    );


    await sendTelegramMessage(

      chatId,

      "🔍 نام فیلم موردنظرتان را وارد کنید:",

      [
        getHomeButton()
      ]

    );

    return;
  }


  /* =========================
     جستجوی سریال
  ========================= */

if (data === "search_series") {

  userStates.set(

    chatId,

    {
      mode: "search_series"
    }

  );

  await sendTelegramMessage(

    chatId,

    "📺 نام سریال موردنظرتان را وارد کنید:",

    [
      getHomeButton()
    ]

  );

  return;
}


  /* =========================
     جدیدها
  ========================= */

  if (data === "new_movies") {

    await sendTelegramMessage(

      chatId,

      "🆕 بخش جدیدها به‌زودی اضافه می‌شود.",

      [
        getHomeButton()
      ]

    );

    return;
  }


  /* =========================
     راهنما
  ========================= */

  if (data === "help") {

    await sendTelegramMessage(

      chatId,

      "ℹ️ راهنمای کلوپ سفید\n\n" +

      "🎬 برای پیدا کردن فیلم، " +
      "جستجوی فیلم را انتخاب کنید.\n\n" +

      "📺 بخش سریال در مرحله بعد فعال می‌شود.\n\n" +

      "🎲 پیشنهاد تصادفی و ⭐ پیشنهاد کلوپ سفید " +
      "نیز در مراحل بعد فعال می‌شوند.",

      [
        getHomeButton()
      ]

    );

    return;
  }


  /* =========================
     پیشنهاد تصادفی
  ========================= */

 if (data === "random_movie") {

  await sendTelegramMessage(
    chatId,

    "🎲 پیشنهاد تصادفی\n\n" +
    "چه نوع محتوایی می‌خواهید؟",

    [
      [
        {
          text: "🎬 سینمایی خارجی",
          callback_data: "random_cinema"
        }
      ],
      [
        {
          text: "📺 سریال خارجی",
          callback_data: "random_series"
        }
      ],
      getHomeButton()
    ]

  );

  return;
}


  /* =========================
     پیشنهاد کلوپ
  ========================= */

  if (data === "club_recommend") {

  await sendTelegramMessage(
    chatId,

    "⭐ پیشنهاد کلوپ سفید\n\n" +
    "چه نوع محتوایی می‌خواهید؟",

    [
      [
        {
          text: "🎬 سینمایی خارجی",
          callback_data: "recommend_cinema"
        }
      ],
      [
        {
          text: "📺 سریال خارجی",
          callback_data: "recommend_series"
        }
      ],
      getHomeButton()
    ]

  );

  return;
}

  /* =========================
     پیشنهاد سینمایی کلوپ سفید
  ========================= */

  if (data === "recommend_cinema") {

    await recommendCinema(
      chatId
    );

    return;
  }


  /* =========================
     پیشنهاد سریال کلوپ سفید
  ========================= */

  if (data === "recommend_series") {

    await recommendSeries(
      chatId
    );

    return;
  }
  
/* =========================
   انتخاب سریال
========================= */

if (
  data.startsWith("series_")
) {

  const index =
    Number(
      data.replace("series_", "")
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
      "لطفاً دوباره جستجو کنید.",

      [
        getHomeButton()
      ]

    );

    return;
  }


  const series =
    state.results[index];


  userStates.set(

    chatId,

    {
      ...state,
      selectedSeries: series
    }

  );


  await showSeries(
    chatId,
    series
  );


  return;
}
  
  /* =========================
     انتخاب فیلم
  ========================= */

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
        "لطفاً دوباره جستجو کنید.",

        [
          getHomeButton()
        ]

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


  /* =========================
     بازگشت به نتایج
  ========================= */

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
        "لطفاً دوباره جستجو کنید.",

        [
          getHomeButton()
        ]

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


    keyboard.push(
      getHomeButton()
    );


    await sendTelegramMessage(

      chatId,

      "🎬 نتایج جستجو:\n\n" +
      "فیلم موردنظر را انتخاب کنید:",

      keyboard

    );

    return;
  }

/* =========================
   بازگشت به نتایج سریال
========================= */

if (
  data === "back_series_results"
) {

  const state =
    userStates.get(chatId);


  if (
    !state ||
    !state.results
  ) {

    await sendTelegramMessage(

      chatId,

      "نتایج قبلی دیگر در دسترس نیست.\n\n" +
      "لطفاً دوباره جستجو کنید.",

      [
        getHomeButton()
      ]

    );

    return;
  }


  const keyboard =
    state.results.map(
      (series, index) => {

        const title =
          series["اسم فیلم"] ||
          "بدون نام";


        const year =
          series["سال"]
            ? ` — ${series["سال"]}`
            : "";


        return [
          {
            text:
              `${index + 1}. ${title}${year}`,

            callback_data:
              `series_${index}`
          }
        ];

      }
    );


  keyboard.push(
    getHomeButton()
  );


  await sendTelegramMessage(

    chatId,

    "📺 نتایج جستجوی سریال:\n\n" +
    "سریال موردنظر را انتخاب کنید:",

    keyboard

  );

  return;
}
  
}


/* =========================
   Webhook
========================= */

app.get(
  "/",
  (req, res) => {

    res
      .status(200)
      .send(
        "OXIW Telegram Bot OK"
      );

  }
);


app.post(
  "/telegram",
  async (req, res) => {

    console.log(
      "Telegram update:",
      JSON.stringify(req.body)
    );


    /* پاسخ فوری به Telegram */

    res
      .status(200)
      .send("OK");


    try {

      if (
        req.body.callback_query
      ) {

        await processCallback(
          req.body.callback_query
        );

      }


      if (
        req.body.message
      ) {

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
