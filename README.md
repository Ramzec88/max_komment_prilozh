# 🐻 MAX Comments — Комментарии под постами канала
## Мишка Макс

---

## Как это работает

```
1. Ты публикуешь пост в канал MAX
         ↓
2. Бот получает событие (message_created)
   → Сохраняет пост в Supabase
   → Добавляет кнопку под постом: [💬 Комментарии]
         ↓
3. Подписчик нажимает кнопку
   → Открывается мини-приложение с чатом для ЭТОГО конкретного поста
         ↓
4. Подписчик пишет комментарий
   → Сохраняется в Supabase
   → Кнопка под постом обновляется: [💬 Комментарии (1)]
```

---

## Файлы

```
max-comments/
├── supabase-schema.sql   ← Таблицы БД (один раз)
├── server.js             ← Bot + REST API (Railway)
├── package.json          ← Зависимости Node.js
├── index.html            ← Фронтенд — разметка (Vercel/GitHub Pages)
├── style.css             ← Стили фронтенда
├── config.js             ← Конфиг фронтенда (API_BASE, ADMIN_ID) ← редактировать перед деплоем
├── app.js                ← Логика фронтенда
└── README.md
```

---

## Установка

### 1. Supabase
Запусти `supabase-schema.sql` в SQL Editor

### 2. Переменные среды Railway
```env
MAX_BOT_TOKEN=токен_бота
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...          # service_role key!
ADMIN_USER_ID=твой_user_id_в_MAX
MINIAPP_URL=https://comments.mishka-max.ru
CHANNEL_ID=id_твоего_канала
PORT=3000
```

### 3. Фронтенд — замени 2 значения в config.js
```js
const API_BASE = 'https://ВАШ-ПРОЕКТ.railway.app'; // URL Railway-сервера
const ADMIN_ID = 'ВАШ_USER_ID_В_MAX';              // ваш user_id в MAX
```
Задеплой все файлы фронтенда (`index.html`, `style.css`, `app.js`, `config.js`) на Vercel:
```bash
npx vercel deploy --prod
```

Добавь в Railway переменную окружения для CORS:
```env
ALLOWED_ORIGINS=https://ваш-vercel-url.vercel.app
```

### 4. Подключи мини-приложение в MAX
- business.max.ru → Чат-боты → Чат-бот и мини-приложение → Настроить
- URL: `https://ваш-vercel-url.vercel.app`
- Кнопка: без названия (кнопки добавляются программно)
- Сохранить

### 5. Назначь бота администратором канала
Без этого бот не получает события о постах!

---

## Узнать свой CHANNEL_ID

Временно добавь в бота:
```js
bot.onMessage((ctx) => {
  console.log('chat_id:', ctx.message.recipient?.chatId);
});
```
Опубликуй пост в канал → смотри Railway логи.

---

## Тип кнопки `open_app`

В документации MAX кнопка типа `open_app` открывает мини-приложение.
URL диплинка: `https://MINIAPP_URL?startapp=post_<messageId>`
В мини-приложении: `window.WebApp.initDataUnsafe.start_param` = `"post_<messageId>"`

---

## Ограничение: редактирование поста (24ч)

MAX позволяет редактировать сообщения только в течение 24 часов.
Кнопка счётчика обновляется через PUT /messages — это работает пока пост не старше суток.
Для старых постов счётчик на кнопке "замёрзнет", но комментарии продолжат собираться в БД.
