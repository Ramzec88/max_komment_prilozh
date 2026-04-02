// =============================================
// MAX Comments System — server.js
// Бот + REST API для мини-приложения комментариев
// Роман: добавь этот файл к своему Railway проекту
// =============================================

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import Bot from '@maxhub/max-bot-api'; // твоя библиотека

// ─── Конфиг (из env Railway) ────────────────
const BOT_TOKEN        = process.env.MAX_BOT_TOKEN;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY; // service_role
const ADMIN_USER_ID    = process.env.ADMIN_USER_ID;
const MINIAPP_URL      = process.env.MINIAPP_URL;   // https://comments.mishka-max.ru
const CHANNEL_ID       = process.env.CHANNEL_ID;    // ID твоего канала в MAX
const PORT             = process.env.PORT || 3000;
const MAX_API          = 'https://platform-api.max.ru';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Инициализация бота ──────────────────────
const bot = new Bot(BOT_TOKEN);

// ─── Express ────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// =============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =============================================

// MAX Bot API: прямой HTTP вызов
async function maxApi(method, body, queryParams = {}) {
  const url = new URL(`${MAX_API}/${method}`);
  Object.entries(queryParams).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Authorization': BOT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Обновить inline кнопку с счётчиком комментариев под постом
async function updateCommentButton(messageId, count) {
  const label = count === 0
    ? '💬 Комментарии'
    : `💬 Комментарии (${count})`;

  // Диплинк передаёт message_id как start_param
  const deeplink = `${MINIAPP_URL}?startapp=post_${messageId}`;

  await fetch(`${MAX_API}/messages?message_id=${messageId}`, {
    method: 'PUT',
    headers: {
      'Authorization': BOT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      attachments: [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                {
                  type: 'open_app',   // Открывает мини-приложение
                  text: label,
                  url: deeplink,
                  intent: 'default',
                }
              ]
            ]
          }
        }
      ]
    }),
  });
}

// Валидация initData от MAX Bridge
function validateInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');
    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();
    const expected = crypto
      .createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex');

    if (expected !== hash) return null;

    const userStr = params.get('user');
    const startParam = params.get('start_param') || '';
    const user = userStr ? JSON.parse(userStr) : null;
    return { user, startParam };
  } catch {
    return null;
  }
}

// Middleware авторизации
function auth(req, res, next) {
  // В dev-режиме без initData — пропускаем
  if (process.env.NODE_ENV === 'development') {
    req.maxUser = { id: 0, first_name: 'Dev', username: 'dev' };
    req.isAdmin = true;
    req.startParam = req.headers['x-start-param'] || '';
    return next();
  }

  const initData = req.headers['x-init-data'];
  if (!initData) return res.status(401).json({ error: 'No initData' });

  const parsed = validateInitData(initData);
  if (!parsed?.user) return res.status(401).json({ error: 'Invalid initData' });

  req.maxUser = parsed.user;
  req.startParam = parsed.startParam;
  req.isAdmin = String(parsed.user.id) === String(ADMIN_USER_ID);
  next();
}

// =============================================
// BOT: Слушаем публикации в канале
// =============================================
// Когда ты публикуешь пост в канал — бот получает событие message_created
// и сохраняет пост + добавляет кнопку "Комментарии"

bot.onMessage(async (ctx) => {
  const msg = ctx.message;

  // Обрабатываем только сообщения из твоего канала
  if (String(msg.recipient?.chatId) !== String(CHANNEL_ID)) return;

  // Проверяем что это пост (от бота или от тебя как администратора)
  const messageId = msg.id;
  const text = msg.body?.text || '';
  const title = text.slice(0, 80).replace(/\n/g, ' ');

  try {
    // 1. Регистрируем пост в Supabase
    const { data: post, error } = await supabase
      .from('channel_posts')
      .insert({
        message_id: String(messageId),
        chat_id: String(CHANNEL_ID),
        title: title || 'Пост',
        comment_count: 0,
      })
      .select()
      .single();

    if (error && error.code !== '23505') { // 23505 = unique_violation (дубль)
      console.error('Supabase insert error:', error);
      return;
    }

    // 2. Добавляем кнопку "Комментарии" под постом
    await updateCommentButton(messageId, 0);
    console.log(`✅ Пост зарегистрирован: ${messageId} — "${title}"`);

  } catch (err) {
    console.error('Bot onMessage error:', err);
  }
});

// =============================================
// API: Получить пост по message_id
// =============================================
// GET /api/post/:messageId
app.get('/api/post/:messageId', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('channel_posts')
    .select('id, message_id, title, comment_count, created_at')
    .eq('message_id', req.params.messageId)
    .single();

  if (error) return res.status(404).json({ error: 'Post not found' });
  res.json(data);
});

// =============================================
// API: Получить комментарии поста
// =============================================
// GET /api/post/:messageId/comments
app.get('/api/post/:messageId/comments', auth, async (req, res) => {
  // Получаем post UUID по message_id
  const { data: post } = await supabase
    .from('channel_posts')
    .select('id')
    .eq('message_id', req.params.messageId)
    .single();

  if (!post) return res.status(404).json({ error: 'Post not found' });

  const { data, error } = await supabase
    .from('comments')
    .select('id, first_name, username, text, created_at, user_id')
    .eq('post_id', post.id)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// =============================================
// API: Добавить комментарий
// =============================================
// POST /api/post/:messageId/comments
app.post('/api/post/:messageId/comments', auth, async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length < 1) return res.status(400).json({ error: 'Empty text' });
  if (text.length > 1000) return res.status(400).json({ error: 'Too long' });

  // Ищем пост
  const { data: post } = await supabase
    .from('channel_posts')
    .select('id, message_id, comment_count')
    .eq('message_id', req.params.messageId)
    .single();

  if (!post) return res.status(404).json({ error: 'Post not found' });

  // Сохраняем комментарий
  const { data: comment, error } = await supabase
    .from('comments')
    .insert({
      post_id: post.id,
      user_id: req.maxUser.id,
      username: req.maxUser.username || null,
      first_name: req.maxUser.first_name || 'Пользователь',
      last_name: req.maxUser.last_name || null,
      text: text.trim(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Обновляем счётчик
  const newCount = (post.comment_count || 0) + 1;
  await supabase
    .from('channel_posts')
    .update({ comment_count: newCount })
    .eq('id', post.id);

  // Обновляем кнопку под постом в канале
  await updateCommentButton(post.message_id, newCount);

  res.json(comment);
});

// =============================================
// API: Удалить комментарий (только свой или admin)
// =============================================
// DELETE /api/comments/:commentId
app.delete('/api/comments/:commentId', auth, async (req, res) => {
  const { data: comment } = await supabase
    .from('comments')
    .select('id, user_id, post_id')
    .eq('id', req.params.commentId)
    .single();

  if (!comment) return res.status(404).json({ error: 'Not found' });

  // Только свой комментарий или admin
  if (!req.isAdmin && String(comment.user_id) !== String(req.maxUser.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await supabase
    .from('comments')
    .update({ is_deleted: true })
    .eq('id', req.params.commentId);

  // Пересчитываем счётчик
  const { data: post } = await supabase
    .from('channel_posts')
    .select('id, message_id, comment_count')
    .eq('id', comment.post_id)
    .single();

  if (post) {
    const newCount = Math.max(0, (post.comment_count || 1) - 1);
    await supabase
      .from('channel_posts')
      .update({ comment_count: newCount })
      .eq('id', post.id);
    await updateCommentButton(post.message_id, newCount);
  }

  res.json({ ok: true });
});

// =============================================
// API: Ручная регистрация поста (если бот пропустил)
// =============================================
// POST /api/admin/register-post
app.post('/api/admin/register-post', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });

  const { message_id, title } = req.body;
  if (!message_id) return res.status(400).json({ error: 'message_id required' });

  const { data, error } = await supabase
    .from('channel_posts')
    .upsert({
      message_id: String(message_id),
      chat_id: String(CHANNEL_ID),
      title: title || 'Пост',
      comment_count: 0,
    }, { onConflict: 'message_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await updateCommentButton(message_id, data.comment_count || 0);
  res.json(data);
});

// =============================================
// ЗАПУСК
// =============================================
bot.start();

app.listen(PORT, () => {
  console.log(`🐻 MAX Comments Bot + API запущен на порту ${PORT}`);
});

export default app;
