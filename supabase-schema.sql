-- =============================================
-- MAX Comments System — Supabase Schema
-- Мишка Макс: Комментарии под постами канала
-- =============================================

-- Таблица постов канала (регистрируем каждый пост при публикации)
CREATE TABLE IF NOT EXISTS channel_posts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    TEXT NOT NULL UNIQUE,   -- MAX message_id поста в канале
  chat_id       TEXT NOT NULL,          -- ID канала
  title         TEXT,                   -- Первые ~80 символов текста поста
  comment_count INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Таблица комментариев
CREATE TABLE IF NOT EXISTS comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID NOT NULL REFERENCES channel_posts(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL,          -- user.id из MAX initData
  username    TEXT,
  first_name  TEXT NOT NULL DEFAULT 'Пользователь',
  last_name   TEXT,
  text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
  is_deleted  BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_channel_posts_message_id ON channel_posts(message_id);

-- RLS
ALTER TABLE channel_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

-- Анонимный клиент может читать посты и комментарии, писать комментарии
-- (валидация пользователя через initData на backend — service_role)
CREATE POLICY "read posts" ON channel_posts FOR SELECT USING (true);
CREATE POLICY "read comments" ON comments FOR SELECT USING (NOT is_deleted);

-- Service role (backend) обходит RLS автоматически

-- =============================================
-- REPLIES: ответы на комментарии
-- =============================================
ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES comments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_comments_reply_to_id ON comments(reply_to_id);

-- =============================================
-- BAN: таблица заблокированных пользователей
-- =============================================
CREATE TABLE IF NOT EXISTS banned_users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    BIGINT NOT NULL UNIQUE,
  banned_by  BIGINT NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE banned_users ENABLE ROW LEVEL SECURITY;
-- Только service_role (backend) имеет доступ — публичный доступ закрыт
CREATE POLICY "no public access" ON banned_users USING (false);
