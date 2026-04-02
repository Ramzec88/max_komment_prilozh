// =============================================
// MAX Comments System — server.js
// Бот + REST API для мини-приложения комментариев
// =============================================

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import Bot from '@maxhub/max-bot-api';

// ─── Конфиг (из env Railway) ────────────────
const BOT_TOKEN        = process.env.MAX_BOT_TOKEN;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY; // service_role
const ADMIN_USER_ID    = process.env.ADMIN_USER_ID;
const MINIAPP_URL      = process.env.MINIAPP_URL;
const CHANNEL_ID       = process.env.CHANNEL_ID;
const PORT             = process.env.PORT || 3000;
const MAX_API          = 'https://platform-api.max.ru';

// ─── Именованные константы ───────────────────
const POST_TITLE_MAX_LEN = 80;
const COMMENT_MAX_LEN    = 1000;
const DUPLICATE_KEY_CODE = '23505'; // Postgres unique_violation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!ADMIN_USER_ID) {
  console.warn('[CONFIG] ADMIN_USER_ID не задан — функции администратора отключены');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Инициализация бота ──────────────────────
const bot = new Bot(BOT_TOKEN);

// ─── Express ────────────────────────────────
const app = express();

// CORS: разрешаем только MINIAPP_URL и значения из ALLOWED_ORIGINS
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : (MINIAPP_URL ? [MINIAPP_URL] : []);

app.use(cors({
  origin: (origin, cb) => {
    // Разрешаем server-to-server вызовы (без origin) и явно заданные домены
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
}));

app.use(express.json());

// Rate limiter: не более 10 комментариев в минуту на пользователя
const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => String(req.maxUser?.id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много комментариев, подождите немного' },
});

// =============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =============================================

function maxHeaders() {
  return {
    'Authorization': BOT_TOKEN,
    'Content-Type': 'application/json',
  };
}

// MAX Bot API: прямой HTTP вызов (POST)
async function maxApi(method, body, queryParams = {}) {
  const url = new URL(`${MAX_API}/${method}`);
  Object.entries(queryParams).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: maxHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

// Обновить inline кнопку с счётчиком комментариев под постом
async function updateCommentButton(messageId, count) {
  const label = count === 0
    ? '💬 Комментарии'
    : `💬 Комментарии (${count})`;

  const deeplink = `${MINIAPP_URL}?startapp=post_${messageId}`;

  await fetch(`${MAX_API}/messages?message_id=${messageId}`, {
    method: 'PUT',
    headers: maxHeaders(),
    body: JSON.stringify({
      attachments: [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                {
                  type: 'open_app',
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

// HMAC-SHA256 верификация подписи initData
function computeHmacHex(token, checkString) {
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  return crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
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

    if (computeHmacHex(BOT_TOKEN, checkString) !== hash) return null;

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
  req.isAdmin = ADMIN_USER_ID
    ? String(parsed.user.id) === String(ADMIN_USER_ID)
    : false;
  next();
}

// =============================================
// BOT: Слушаем публикации в канале
// =============================================

bot.onMessage(async (ctx) => {
  const msg = ctx.message;

  if (String(msg.recipient?.chatId) !== String(CHANNEL_ID)) return;

  const messageId = msg.id;
  const text = msg.body?.text || '';
  const title = text.slice(0, POST_TITLE_MAX_LEN).replace(/\n/g, ' ');

  try {
    const { error } = await supabase
      .from('channel_posts')
      .insert({
        message_id: String(messageId),
        chat_id: String(CHANNEL_ID),
        title: title || 'Пост',
        comment_count: 0,
      })
      .select()
      .single();

    if (error && error.code !== DUPLICATE_KEY_CODE) {
      console.error('Supabase insert error:', error);
      return;
    }

    await updateCommentButton(messageId, 0);
    console.log(`✅ Пост зарегистрирован: ${messageId} — "${title}"`);

  } catch (err) {
    console.error('Bot onMessage error:', err);
  }
});

// =============================================
// API: Получить пост по message_id
// =============================================
app.get('/api/post/:messageId', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('channel_posts')
      .select('id, message_id, title, comment_count, created_at')
      .eq('message_id', req.params.messageId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Post not found' });
    res.json(data);
  } catch (err) {
    console.error('GET /api/post/:messageId', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================
// API: Получить комментарии поста
// =============================================
app.get('/api/post/:messageId/comments', auth, async (req, res) => {
  try {
    const { data: post } = await supabase
      .from('channel_posts')
      .select('id')
      .eq('message_id', req.params.messageId)
      .single();

    if (!post) return res.status(404).json({ error: 'Post not found' });

    const { data, error } = await supabase
      .from('comments')
      .select('id, first_name, username, text, created_at, user_id, reply_to_id, reply_to:reply_to_id (id, first_name, text)')
      .eq('post_id', post.id)
      .eq('is_deleted', false)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: 'Internal error' });
    res.json(data);
  } catch (err) {
    console.error('GET /api/post/:messageId/comments', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================
// API: Добавить комментарий
// =============================================
app.post('/api/post/:messageId/comments', auth, commentLimiter, async (req, res) => {
  const { text, reply_to_id = null } = req.body;
  if (!text || text.trim().length < 1) return res.status(400).json({ error: 'Empty text' });
  if (text.length > COMMENT_MAX_LEN) return res.status(400).json({ error: 'Too long' });
  if (reply_to_id && !UUID_RE.test(reply_to_id)) {
    return res.status(400).json({ error: 'Некорректный reply_to_id' });
  }

  try {
    const { data: post } = await supabase
      .from('channel_posts')
      .select('id, message_id, comment_count')
      .eq('message_id', req.params.messageId)
      .single();

    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Проверяем бан
    const { data: banRow } = await supabase
      .from('banned_users')
      .select('user_id')
      .eq('user_id', req.maxUser.id)
      .maybeSingle();
    if (banRow) return res.status(403).json({ error: 'Вы заблокированы' });

    // Валидация reply_to_id
    if (reply_to_id) {
      const { data: parent } = await supabase
        .from('comments')
        .select('id, post_id')
        .eq('id', reply_to_id)
        .eq('is_deleted', false)
        .maybeSingle();
      if (!parent) return res.status(400).json({ error: 'Комментарий для ответа не найден' });
      if (String(parent.post_id) !== String(post.id)) {
        return res.status(400).json({ error: 'Нельзя отвечать на комментарий из другого поста' });
      }
    }

    const { data: comment, error } = await supabase
      .from('comments')
      .insert({
        post_id: post.id,
        user_id: req.maxUser.id,
        username: req.maxUser.username || null,
        first_name: req.maxUser.first_name || 'Пользователь',
        last_name: req.maxUser.last_name || null,
        text: text.trim(),
        reply_to_id: reply_to_id || null,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: 'Internal error' });

    const newCount = (post.comment_count || 0) + 1;
    await supabase
      .from('channel_posts')
      .update({ comment_count: newCount })
      .eq('id', post.id);

    await updateCommentButton(post.message_id, newCount);

    res.json(comment);
  } catch (err) {
    console.error('POST /api/post/:messageId/comments', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================
// API: Удалить комментарий (только свой или admin)
// =============================================
app.delete('/api/comments/:commentId', auth, async (req, res) => {
  try {
    const { data: comment } = await supabase
      .from('comments')
      .select('id, user_id, post_id')
      .eq('id', req.params.commentId)
      .single();

    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    if (!req.isAdmin && String(comment.user_id) !== String(req.maxUser.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await supabase
      .from('comments')
      .update({ is_deleted: true })
      .eq('id', req.params.commentId);

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
  } catch (err) {
    console.error('DELETE /api/comments/:commentId', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================
// API: Ручная регистрация поста (если бот пропустил)
// =============================================
app.post('/api/admin/register-post', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });

  const { message_id, title } = req.body;
  if (!message_id) return res.status(400).json({ error: 'message_id required' });

  try {
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

    if (error) return res.status(500).json({ error: 'Internal error' });

    await updateCommentButton(message_id, data.comment_count || 0);
    res.json(data);
  } catch (err) {
    console.error('POST /api/admin/register-post', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================
// API: Заблокировать пользователя (только admin)
// =============================================
app.post('/api/admin/ban/:userId', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });

  const targetId = parseInt(req.params.userId, 10);
  if (!targetId || String(targetId) !== req.params.userId) {
    return res.status(400).json({ error: 'Invalid userId' });
  }
  if (ADMIN_USER_ID && String(targetId) === String(ADMIN_USER_ID)) {
    return res.status(400).json({ error: 'Нельзя заблокировать администратора' });
  }

  const { reason } = req.body;

  try {
    const { error } = await supabase
      .from('banned_users')
      .insert({ user_id: targetId, banned_by: req.maxUser.id, reason: reason || null });

    if (error) {
      if (error.code === DUPLICATE_KEY_CODE) {
        return res.status(409).json({ error: 'Пользователь уже заблокирован' });
      }
      return res.status(500).json({ error: 'Internal error' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/ban/:userId', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================
// API: Разблокировать пользователя (только admin)
// =============================================
app.delete('/api/admin/ban/:userId', auth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });

  const targetId = parseInt(req.params.userId, 10);
  if (!targetId || String(targetId) !== req.params.userId) {
    return res.status(400).json({ error: 'Invalid userId' });
  }

  try {
    const { error } = await supabase
      .from('banned_users')
      .delete()
      .eq('user_id', targetId);

    if (error) return res.status(500).json({ error: 'Internal error' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/admin/ban/:userId', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================
// ЗАПУСК
// =============================================
bot.start();

app.listen(PORT, () => {
  console.log(`🐻 MAX Comments Bot + API запущен на порту ${PORT}`);
});

export default app;
