const express = require("express");
const { google } = require("googleapis");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const SPREADSHEET_ID =
  "17hDL6GiIKpEn3t6-qS99e2FTXnErrI9F-eDG5uOwthc";

const ADMIN_TELEGRAM_ID = "170870143";

function isAdmin(chatId) {
  return String(chatId) === ADMIN_TELEGRAM_ID;
}

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

/* =========================
   کیف پول توکن
========================= */

async function getOrCreateWallet(
  chatId,
  telegramUser
) {

  const sheets =
    await getGoogleSheets();

  const telegramId =
    String(
      telegramUser?.id || chatId
    );

  const name =
    [
      telegramUser?.first_name,
      telegramUser?.last_name
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

  const response =
    await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "کیف پول"
    });

  const values =
    response.data.values || [];

  /*
    اگر کیف پول وجود داشته باشد
    موجودی آن را برمی‌گردانیم.
  */

  for (let i = 1; i < values.length; i++) {

    const row =
      values[i];

    const rowTelegramId =
      String(row[0] || "").trim();

    if (rowTelegramId === telegramId) {

      return {
        telegramId: telegramId,
        name: row[1] || name,
        balance: Number(row[2] || 0),
        exists: true
      };
    }
  }

  /*
    اگر کیف پول وجود نداشته باشد،
    یک کیف پول جدید با موجودی صفر می‌سازیم.
  */

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "کیف پول",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        telegramId,
        name,
        0,
        new Date()
      ]]
    }
  });

  console.log(
    "New wallet created:",
    telegramId,
    name
  );

  return {
    telegramId: telegramId,
    name: name,
    balance: 0,
    exists: false
  };
}


async function getWalletBalance(
  chatId,
  telegramUser
) {

  const wallet =
    await getOrCreateWallet(
      chatId,
      telegramUser
    );

  return wallet.balance;
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
   ثبت رسید پرداخت
========================= */

async function registerPaymentReceipt(
  message,
  fileId
) {

  const sheets =
    await getGoogleSheets();

  const telegramUser =
    message.from || {};

  const telegramId =
    telegramUser.id
      ? String(telegramUser.id)
      : String(message.chat.id);

  const response =
    await sheets.spreadsheets.values.get({
      spreadsheetId:
        SPREADSHEET_ID,
      range:
        "درخواست پرداخت"
    });

  const values =
    response.data.values || [];

  /*
    پیدا کردن آخرین درخواست پرداخت
    همین کاربر که هنوز منتظر رسید است.
  */

  let targetRow = -1;

  for (
    let i = values.length - 1;
    i >= 1;
    i--
  ) {

    const row =
      values[i];

    const rowTelegramId =
      String(row[1] || "").trim();

    const status =
      String(row[6] || "").trim();

    if (
      rowTelegramId === telegramId &&
      status === "در انتظار رسید"
    ) {

      targetRow =
        i + 1;

      break;
    }
  }

  if (targetRow === -1) {

    return {
      success: false,
      reason: "NO_PENDING_REQUEST"
    };
  }

  /*
    ستون‌ها:
    1 زمان درخواست
    2 شماره تلگرام
    3 نام کاربر
    4 بسته
    5 مبلغ
    6 توکن
    7 وضعیت
    8 کد پیگیری
    9 رسید file_id
    10 زمان بررسی
    11 توضیح مدیر
  */

  await sheets.spreadsheets.values.update({

    spreadsheetId:
      SPREADSHEET_ID,

    range:
      `درخواست پرداخت!G${targetRow}:I${targetRow}`,

    valueInputOption:
      "USER_ENTERED",

    requestBody: {
      values: [[
        "در انتظار بررسی",
        "",
        fileId
      ]]
    }

  });

  console.log(
    "Payment receipt registered:",
    telegramId,
    "row:",
    targetRow
  );

  return {
    success: true,
    row: targetRow
  };
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

function getMainKeyboard(chatId) {

  const keyboard = [

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
        text: "💰 کیف پول",
        callback_data: "wallet"
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

  if (isAdmin(chatId)) {

    keyboard.push([
      {
        text: "👨‍💼 مدیریت",
        callback_data: "admin_panel"
      }
    ]);

  }

  return keyboard;
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

async function showMovie(chatId, movie, isRecommendation = false) {

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

  if (isRecommendation) {
  keyboard.push([
    {
      text: "🔄 پیشنهاد بعدی",
      callback_data: "recommend_next_cinema"
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

async function showSeries(chatId, series, isRecommendation = false) {

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

if (isRecommendation) {
  keyboard.push([
    {
      text: "🔄 پیشنهاد بعدی",
      callback_data: "recommend_next_series"
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

  const state =
    userStates.get(chatId) || {};

  const shownRecommendations =
    state.shownRecommendations || [];

  const available =
    recommended.filter(movie => {

      const code =
        String(
          movie["کد سیستم"] || ""
        ).trim();

      return !shownRecommendations.includes(code);
    });

  const candidates =
    available.length
      ? available
      : recommended;

  const randomIndex =
    Math.floor(
      Math.random() * candidates.length
    );

  const movie =
    candidates[randomIndex];

  const movieCode =
    String(
      movie["کد سیستم"] || ""
    ).trim();

  userStates.set(
    chatId,
    {
      ...state,
      shownRecommendations: [
        ...shownRecommendations,
        movieCode
      ]
    }
  );

  await showMovie(
  chatId,
  movie,
  true
);
}

async function recommendSeries(
  chatId
) {

  const allSeries =
  await getSeries();

const recommended =
  allSeries.filter(item =>
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

  const state =
    userStates.get(chatId) || {};

  const shownRecommendations =
    state.shownSeriesRecommendations || [];

  const available =
    recommended.filter(item => {

      const code =
        String(
          item["کد سیستم"] || ""
        ).trim();

      return !shownRecommendations.includes(code);
    });

  const candidates =
    available.length
      ? available
      : recommended;

  const randomIndex =
    Math.floor(
      Math.random() * candidates.length
    );

  const series =
    candidates[randomIndex];

  const seriesCode =
    String(
      series["کد سیستم"] || ""
    ).trim();

  userStates.set(
    chatId,
    {
      ...state,
      shownSeriesRecommendations: [
        ...shownRecommendations,
        seriesCode
      ]
    }
  );

  await showSeries(
    chatId,
    series,
    true
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

      getMainKeyboard(chatId)

    );

    return;
  }

  /* =========================
   دریافت رسید پرداخت
========================= */

if (
  message.photo &&
  message.photo.length
) {

  const photo =
    message.photo[
      message.photo.length - 1
    ];

  const fileId =
    photo.file_id;

  try {

    const result =
      await registerPaymentReceipt(
        message,
        fileId
      );

    if (!result.success) {

      await sendTelegramMessage(
        chatId,

        "⚠️ درخواست پرداختی که منتظر رسید باشد پیدا نشد.",

        [
          getHomeButton()
        ]
      );

      return;
    }

    await sendTelegramMessage(
      chatId,

      "✅ رسید شما دریافت شد.\n\n" +
      "درخواست پرداخت شما در انتظار بررسی مدیر قرار گرفت.\n\n" +
      "پس از تأیید پرداخت، توکن‌ها به کیف پول شما اضافه خواهند شد.",

      [
        [
          {
            text: "💰 کیف پول",
            callback_data: "wallet"
          }
        ],
        getHomeButton()
      ]
    );

  } catch (error) {

    console.error(
      "Payment receipt error:",
      error
    );

    await sendTelegramMessage(
      chatId,

      "❌ در ثبت رسید مشکلی پیش آمد.\n\n" +
      "لطفاً دوباره تلاش کنید.",

      [
        getHomeButton()
      ]
    );
  }

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

    getMainKeyboard(chatId)

  );
}

/* =========================
   نمایش درخواست‌های پرداخت
========================= */

async function showAdminPayments(chatId) {

  if (!isAdmin(chatId)) {
    await sendTelegramMessage(
      chatId,
      "⛔️ شما دسترسی مدیریت ندارید.",
      [
        getHomeButton()
      ]
    );
    return;
  }

  try {

    const sheets =
      await getGoogleSheets();

    const response =
      await sheets.spreadsheets.values.get({
        spreadsheetId:
          SPREADSHEET_ID,
        range:
          "درخواست پرداخت"
      });

    const values =
      response.data.values || [];

    const pendingRequests = [];

    for (
      let i = 1;
      i < values.length;
      i++
    ) {

      const row =
        values[i];

      const status =
        String(row[6] || "").trim();

      if (
        status === "در انتظار بررسی"
      ) {

        pendingRequests.push({
          rowNumber: i + 1,
          time: row[0] || "",
          telegramId: row[1] || "",
          name: row[2] || "بدون نام",
          packageName: row[3] || "",
          amount: Number(row[4] || 0),
          tokenAmount: Number(row[5] || 0),
          status: status,
          trackingCode: row[7] || "",
          receiptFileId: row[8] || ""
        });

      }

    }

    if (pendingRequests.length === 0) {

      await sendTelegramMessage(
        chatId,
        "💳 درخواست‌های پرداخت\n\n" +
        "✅ در حال حاضر هیچ درخواست پرداختی در انتظار بررسی نیست.",
        [
          [
            {
              text: "🔙 پنل مدیریت",
              callback_data: "admin_panel"
            }
          ],
          getHomeButton()
        ]
      );

      return;
    }

    await sendTelegramMessage(
      chatId,
      "💳 درخواست‌های پرداخت\n\n" +
      `📋 تعداد درخواست‌های در انتظار بررسی: ${pendingRequests.length}`,
      [
        [
          {
            text: "🔄 بروزرسانی",
            callback_data: "admin_payments"
          }
        ],
        [
          {
            text: "🔙 پنل مدیریت",
            callback_data: "admin_panel"
          }
        ],
        getHomeButton()
      ]
    );

    for (const request of pendingRequests) {

      const text =
        "💳 درخواست پرداخت\n\n" +
        `👤 نام: ${request.name}\n` +
        `🆔 شماره تلگرام: ${request.telegramId}\n` +
        `🎟 بسته: ${request.packageName}\n` +
        `🔢 تعداد توکن: ${request.tokenAmount}\n` +
        `💰 مبلغ: ${request.amount.toLocaleString("en-US")} تومان\n` +
        `🕐 زمان درخواست: ${request.time}\n` +
        `📌 ردیف شیت: ${request.rowNumber}`;

      if (request.receiptFileId) {

        await sendTelegramPhoto(
          chatId,
          request.receiptFileId,
          text,
          [
            [
              {
                text: "⏳ در انتظار بررسی",
                callback_data: `admin_payment_${request.rowNumber}`
              }
            ]
          ]
        );

      } else {

        await sendTelegramMessage(
          chatId,
          text +
          "\n\n⚠️ برای این درخواست رسید ثبت نشده است.",
          [
            [
              {
                text: "⏳ در انتظار بررسی",
                callback_data: `admin_payment_${request.rowNumber}`
              }
            ]
          ]
        );

      }

    }

  } catch (error) {

    console.error(
      "Admin payments error:",
      error
    );

    await sendTelegramMessage(
      chatId,
      "❌ در دریافت درخواست‌های پرداخت مشکلی پیش آمد.",
      [
        [
          {
            text: "🔙 پنل مدیریت",
            callback_data: "admin_panel"
          }
        ],
        getHomeButton()
      ]
    );

  }

}

/* =========================
   جزئیات درخواست پرداخت
========================= */

async function showAdminPaymentDetail(chatId, rowNumber) {

  if (!isAdmin(chatId)) {
    await sendTelegramMessage(
      chatId,
      "⛔️ شما دسترسی مدیریت ندارید.",
      [
        getHomeButton()
      ]
    );
    return;
  }

  try {

    const sheets =
      await getGoogleSheets();

    const response =
      await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `درخواست پرداخت!A${rowNumber}:K${rowNumber}`
      });

    const rows =
      response.data.values || [];

    if (!rows.length) {

      await sendTelegramMessage(
        chatId,
        "❌ درخواست پرداخت پیدا نشد.",
        [
          [
            {
              text: "🔙 درخواست‌های پرداخت",
              callback_data: "admin_payments"
            }
          ],
          getHomeButton()
        ]
      );

      return;
    }

    const row = rows[0];

    const status =
      String(row[6] || "").trim();

    if (status !== "در انتظار بررسی") {

      await sendTelegramMessage(
        chatId,
        "⚠️ این درخواست دیگر در وضعیت انتظار بررسی نیست.\n\n" +
        `وضعیت فعلی: ${status || "نامشخص"}`,
        [
          [
            {
              text: "🔙 درخواست‌های پرداخت",
              callback_data: "admin_payments"
            }
          ],
          getHomeButton()
        ]
      );

      return;
    }

    const telegramId =
      row[1] || "";

    const name =
      row[2] || "بدون نام";

    const packageName =
      row[3] || "";

    const amount =
      Number(row[4] || 0);

    const tokenAmount =
      Number(row[5] || 0);

    const trackingCode =
      row[7] || "";

    const receiptFileId =
      row[8] || "";

    const time =
      row[0] || "";

    let text =
      "💳 بررسی درخواست پرداخت\n\n" +
      `👤 نام: ${name}\n` +
      `🆔 شماره تلگرام: ${telegramId}\n` +
      `🎟 بسته: ${packageName}\n` +
      `🔢 تعداد توکن: ${tokenAmount}\n` +
      `💰 مبلغ: ${amount.toLocaleString("en-US")} تومان\n` +
      `🕐 زمان درخواست: ${time}\n`;

    if (trackingCode) {
      text +=
        `🔖 کد پیگیری: ${trackingCode}\n`;
    }

    text +=
      `📌 ردیف شیت: ${rowNumber}`;

    const keyboard = [
      [
        {
          text: "✅ تأیید پرداخت",
          callback_data: `admin_approve_${rowNumber}`
        }
      ],
      [
        {
          text: "❌ رد پرداخت",
          callback_data: `admin_reject_${rowNumber}`
        }
      ],
      [
        {
          text: "🔙 درخواست‌های پرداخت",
          callback_data: "admin_payments"
        }
      ],
      getHomeButton()
    ];

    if (receiptFileId) {

      await sendTelegramPhoto(
        chatId,
        receiptFileId,
        text,
        keyboard
      );

    } else {

      await sendTelegramMessage(
        chatId,
        text +
        "\n\n⚠️ رسیدی برای این درخواست ثبت نشده است.",
        keyboard
      );

    }

  } catch (error) {

    console.error(
      "Admin payment detail error:",
      error
    );

    await sendTelegramMessage(
      chatId,
      "❌ در دریافت جزئیات درخواست مشکلی پیش آمد.",
      [
        [
          {
            text: "🔙 درخواست‌های پرداخت",
            callback_data: "admin_payments"
          }
        ],
        getHomeButton()
      ]
    );

  }

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

      getMainKeyboard(chatId)

    );

    return;
  }

  /* =========================
     پنل مدیریت
  ========================= */

  if (data === "admin_panel") {

    if (!isAdmin(chatId)) {
      await sendTelegramMessage(
        chatId,
        "⛔️ شما دسترسی مدیریت ندارید.",
        [
          getHomeButton()
        ]
      );
      return;
    }

    await sendTelegramMessage(
      chatId,
      "👨‍💼 پنل مدیریت\n\n" +
      "از بخش‌های زیر انتخاب کنید:",
      [
        [
          {
            text: "💳 درخواست‌های پرداخت",
            callback_data: "admin_payments"
          }
        ],
        getHomeButton()
      ]
    );

    return;
  }

  /* =========================
     درخواست‌های پرداخت مدیریت
  ========================= */

  if (data === "admin_payments") {

    await showAdminPayments(chatId);

    return;
  }

  /* =========================
     جزئیات درخواست پرداخت
  ========================= */

  if (data.startsWith("admin_payment_")) {

    if (!isAdmin(chatId)) {

      await sendTelegramMessage(
        chatId,
        "⛔️ شما دسترسی مدیریت ندارید.",
        [
          getHomeButton()
        ]
      );

      return;
    }

    const rowNumber =
      Number(
        data.replace("admin_payment_", "")
      );

    if (!Number.isInteger(rowNumber) || rowNumber < 2) {

      await sendTelegramMessage(
        chatId,
        "❌ شناسه درخواست نامعتبر است.",
        [
          [
            {
              text: "🔙 درخواست‌های پرداخت",
              callback_data: "admin_payments"
            }
          ],
          getHomeButton()
        ]
      );

      return;
    }

    await showAdminPaymentDetail(
      chatId,
      rowNumber
    );

    return;
  }
  
  /* =========================
   کیف پول
========================= */

if (data === "wallet") {

  const state =
    userStates.get(chatId) || {};

  const telegramUser =
    state.telegramUser ||
    callback.from ||
    {};

  try {

    const wallet =
      await getOrCreateWallet(
        chatId,
        telegramUser
      );

    await sendTelegramMessage(
      chatId,

      "💰 کیف پول شما\n\n" +
      `موجودی فعلی: ${wallet.balance} توکن\n\n` +
      "🎬 هر دانلود = 1 توکن",

      [
        [
          {
            text: "💳 افزایش موجودی",
            callback_data: "buy_tokens"
          }
        ],
        getHomeButton()
      ]
    );

  } catch (error) {

    console.error(
      "Wallet error:",
      error
    );

    await sendTelegramMessage(
      chatId,
      "❌ در دریافت اطلاعات کیف پول مشکلی پیش آمد.",
      [
        getHomeButton()
      ]
    );
  }

  return;
}

/* =========================
   انتخاب بسته توکن
========================= */

if (data === "buy_tokens") {

  await sendTelegramMessage(
    chatId,

    "💳 افزایش موجودی\n\n" +
    "بسته موردنظر خود را انتخاب کنید:",

[
  [
    {
      text: "🎟 5 توکن — 40,000 تومان",
      callback_data: "token_package_5"
    },
    {
      text: "🎟 10 توکن — 80,000 تومان",
      callback_data: "token_package_10"
    }
  ],
  [
    {
      text: "🎟 15 توکن — 120,000 تومان",
      callback_data: "token_package_15"
    },
    {
      text: "🎟 20 توکن — 160,000 تومان",
      callback_data: "token_package_20"
    }
  ],
  [
    {
      text: "🎟 50 توکن — 400,000 تومان",
      callback_data: "token_package_50"
    },
    {
      text: "🎟 100 توکن — 800,000 تومان",
      callback_data: "token_package_100"
    }
  ],
  [
    {
      text: "🔙 بازگشت به کیف پول",
      callback_data: "wallet"
    }
  ],
  getHomeButton()
]
  );

  return;
}

/* =========================
   ثبت درخواست خرید توکن
========================= */

if (data.startsWith("token_package_")) {

  const tokenAmount =
    Number(
      data.replace("token_package_", "")
    );

  const validPackages = [
    5,
    10,
    15,
    20,
    50,
    100
  ];

  if (!validPackages.includes(tokenAmount)) {

    await sendTelegramMessage(
      chatId,
      "❌ بسته انتخابی معتبر نیست.",
      [
        getHomeButton()
      ]
    );

    return;
  }

  const pricePerToken = 8000;

  const baseAmount =
    tokenAmount * pricePerToken;

  const telegramUser =
    callback.from || {};

  const telegramId =
    telegramUser.id
      ? String(telegramUser.id)
      : String(chatId);

  const name =
    [
      telegramUser.first_name,
      telegramUser.last_name
    ]
      .filter(Boolean)
      .join(" ")
      .trim() || "مهمان";

  const packageName =
    `${tokenAmount} توکن`;

  try {

    const sheets =
      await getGoogleSheets();

    /*
      دریافت درخواست‌های پرداخت قبلی
      برای جلوگیری از تکراری شدن مبلغ
    */

    const response =
      await sheets.spreadsheets.values.get({
        spreadsheetId:
          SPREADSHEET_ID,
        range:
          "درخواست پرداخت"
      });

    const values =
      response.data.values || [];

    const usedAmounts =
      new Set();

    /*
      ستون مبلغ = ستون 5
      فقط درخواست‌های پرداختی که هنوز
      تعیین تکلیف نشده‌اند بررسی می‌شوند.
    */

    for (
      let i = 1;
      i < values.length;
      i++
    ) {

      const row =
        values[i];

      const status =
        String(row[6] || "").trim();

      const existingAmount =
        Number(row[4] || 0);

      if (
        existingAmount &&
        (
          status === "در انتظار رسید" ||
          status === "در انتظار بررسی"
        )
      ) {

        usedAmounts.add(
          existingAmount
        );
      }
    }

    /*
      ساخت مبلغ یونیک
      عدد اضافه بین 101 تا 999 تومان
    */

    let uniqueCode;
    let amount;
    let attempts = 0;

    do {

      uniqueCode =
        Math.floor(
          Math.random() * 899
        ) + 101;

      amount =
        baseAmount +
        uniqueCode;

      attempts++;

    } while (
      usedAmounts.has(amount) &&
      attempts < 100
    );

    /*
      اگر به هر دلیل مبلغ یونیک پیدا نشد
    */

    if (usedAmounts.has(amount)) {

      throw new Error(
        "Unable to generate unique payment amount."
      );
    }

    /*
      ثبت درخواست پرداخت
    */

    await sheets.spreadsheets.values.append({

      spreadsheetId:
        SPREADSHEET_ID,

      range:
        "درخواست پرداخت",

      valueInputOption:
        "USER_ENTERED",

      insertDataOption:
        "INSERT_ROWS",

      requestBody: {

        values: [[

          new Date(),

          telegramId,

          name,

          packageName,

          amount,

          tokenAmount,

          "در انتظار رسید",

          "",

          "",

          "",

          ""

        ]]

      }

    });

    /*
      ارسال مبلغ اختصاصی به کاربر
    */

    await sendTelegramMessage(

      chatId,

      "💳 درخواست خرید توکن ثبت شد.\n\n" +

      `🎟 بسته: ${packageName}\n` +

      `💰 مبلغ قابل پرداخت: ${amount.toLocaleString("en-US")} تومان\n\n` +

      "⚠️ لطفاً دقیقاً همین مبلغ را واریز کنید.\n\n" +

      "لطفاً مبلغ را به کارت زیر واریز کنید و " +
      "سپس تصویر رسید پرداخت را ارسال کنید.\n\n" +

      "💳 شماره کارت:\n" +
      "شماره کارت شما",

      [

        [
          {
            text: "📎 ارسال رسید",
            callback_data: "send_payment_receipt"
          }
        ],

        [
          {
            text: "💰 کیف پول",
            callback_data: "wallet"
          }
        ],

        getHomeButton()

      ]

    );

  } catch (error) {

    console.error(
      "Token purchase request error:",
      error
    );

    await sendTelegramMessage(

      chatId,

      "❌ در ثبت درخواست پرداخت مشکلی پیش آمد.\n\n" +
      "لطفاً دوباره تلاش کنید.",

      [
        getHomeButton()
      ]

    );

  }

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
   پیشنهاد بعدی سریال
========================= */

if (data === "recommend_next_series") {

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
   پیشنهاد بعدی سینمایی
========================= */

if (data === "recommend_next_cinema") {

  await recommendCinema(
    chatId
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
