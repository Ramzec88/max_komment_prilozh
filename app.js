// ─── СТЕЙТ ──────────────────────────────────
let initData    = '';
let currentUser = null;
let isAdmin     = false;
let postId      = null;   // message_id поста из канала
let isSending   = false;
let replyingTo  = null;   // { id, first_name, text } | null

// ─── DOM-ссылки (кешируем после DOMContentLoaded) ───
let replyBar, replyBarName, replyBarText;

// ─── INIT ────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  window.WebApp?.ready();

  replyBar     = document.getElementById('replyBar');
  replyBarName = document.getElementById('replyBarName');
  replyBarText = document.getElementById('replyBarText');

  document.getElementById('replyBarClose').addEventListener('click', clearReplyingTo);

  initData    = window.WebApp?.initData || '';
  currentUser = window.WebApp?.initDataUnsafe?.user || { id: 0, first_name: 'Пользователь' };
  isAdmin     = String(currentUser.id) === String(ADMIN_ID);

  // Получаем postId из start_param (формат: "post_<messageId>")
  const startParam = window.WebApp?.initDataUnsafe?.start_param || '';
  const match = startParam.match(/^post_(.+)$/);

  if (!match) {
    showError('Пост не найден. Попробуйте открыть заново.');
    return;
  }

  postId = match[1];

  window.WebApp?.BackButton?.show();
  window.WebApp?.BackButton?.onClick(() => window.WebApp?.close());

  await loadPost();
  await loadComments();

  window.visualViewport?.addEventListener('resize', scrollToBottom);
});

// ─── API ─────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-init-data': initData,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── ЗАГРУЗКА ПОСТА ──────────────────────────
async function loadPost() {
  try {
    const post = await api(`/api/post/${postId}`);
    document.getElementById('postTitle').textContent =
      post.title ? truncate(post.title, 42) : 'Комментарии';
    updateCountLabel(post.comment_count || 0);
  } catch {
    document.getElementById('postTitle').textContent = 'Комментарии';
  }
}

// ─── ЗАГРУЗКА КОММЕНТАРИЕВ ───────────────────
async function loadComments() {
  const list = document.getElementById('messagesList');
  list.innerHTML = '<div class="loader"><div class="spin"></div> Загружаем...</div>';

  try {
    const comments = await api(`/api/post/${postId}/comments`);
    renderComments(comments);
  } catch (err) {
    list.innerHTML = '';
    showError('Не удалось загрузить комментарии: ' + err.message);
  }
}

// ─── РЕНДЕР ──────────────────────────────────
function renderComments(comments) {
  const list = document.getElementById('messagesList');
  list.innerHTML = '';

  if (!comments.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <div class="empty-title">Комментариев пока нет</div>
        <div class="empty-sub">Будь первым! Напишите своё мнение ниже.</div>
      </div>`;
    return;
  }

  let lastDate = null;

  comments.forEach(c => {
    const isMine = String(c.user_id) === String(currentUser?.id);
    const date = new Date(c.created_at);
    const dateKey = date.toDateString();

    if (dateKey !== lastDate) {
      lastDate = dateKey;
      list.appendChild(makeDateDivider(date));
    }

    list.appendChild(buildBubble(c, isMine));
  });

  scrollToBottom();
}

// Вставляет разделитель по дате, если текущая дата ещё не показана
function ensureDateDivider(list) {
  const now = new Date();
  const lastLabel = list.querySelector('.date-divider:last-of-type .date-divider-label');
  if ((lastLabel?.textContent || '') !== formatDateLabel(now)) {
    list.appendChild(makeDateDivider(now));
  }
}

function makeDateDivider(date) {
  const div = document.createElement('div');
  div.className = 'date-divider';
  div.innerHTML = `<span class="date-divider-label">${formatDateLabel(date)}</span>`;
  return div;
}

function buildBubble(c, isMine) {
  const canDelete = isMine || isAdmin;
  const canBan    = isAdmin && !isMine;
  const initials  = (c.first_name || '?').charAt(0).toUpperCase();
  const time      = new Date(c.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const row = document.createElement('div');
  row.className = `msg-row ${isMine ? 'mine' : 'other'}`;
  row.dataset.id = c.id;

  // Блок цитаты для ответов
  const quoteHTML = c.reply_to
    ? `<div class="reply-quote">
         <span class="reply-quote-author">${esc(c.reply_to.first_name)}</span>
         <span class="reply-quote-text">${esc(truncate(c.reply_to.text, 60))}</span>
       </div>`
    : '';

  // Кнопки действий через data-атрибуты — без inline onclick
  const replyBtn  = `<button class="bubble-reply" data-reply-id="${esc(c.id)}" data-reply-name="${esc(c.first_name)}" data-reply-text="${esc(c.text)}" title="Ответить">↩</button>`;
  const deleteBtn = canDelete
    ? `<button class="bubble-delete" data-comment-id="${esc(c.id)}" title="Удалить">✕</button>`
    : '';
  const banBtn    = canBan
    ? `<button class="bubble-ban" data-ban-id="${esc(String(c.user_id))}" data-ban-name="${esc(c.first_name)}" title="Заблокировать">🚫</button>`
    : '';

  row.innerHTML = `
    <div class="avatar" title="${esc(c.first_name)}">${initials}</div>
    <div class="bubble">
      ${!isMine ? `<div class="bubble-author">${esc(c.first_name)}${c.username ? ' @' + esc(c.username) : ''}</div>` : ''}
      ${quoteHTML}
      <div class="bubble-text">${esc(c.text)}</div>
      <div class="bubble-time">${time}</div>
      <div class="bubble-actions">${replyBtn}${deleteBtn}${banBtn}</div>
    </div>
  `;
  return row;
}

// ─── ОТПРАВКА ────────────────────────────────
const inputField = document.getElementById('inputField');
const sendBtn    = document.getElementById('sendBtn');

// Делегированный обработчик — reply, delete, ban
document.getElementById('messagesList').addEventListener('click', (e) => {
  const delBtn = e.target.closest('[data-comment-id]');
  if (delBtn) { deleteComment(delBtn.dataset.commentId, delBtn); return; }

  const repBtn = e.target.closest('[data-reply-id]');
  if (repBtn) {
    setReplyingTo({ id: repBtn.dataset.replyId, first_name: repBtn.dataset.replyName, text: repBtn.dataset.replyText });
    return;
  }

  const banBtn = e.target.closest('[data-ban-id]');
  if (banBtn) { banUser(banBtn.dataset.banId, banBtn.dataset.banName); return; }
});

inputField.addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  sendBtn.disabled = !this.value.trim();
});

inputField.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendComment();
  }
});

async function sendComment() {
  const text = inputField.value.trim();
  if (!text || isSending) return;

  isSending = true;
  sendBtn.disabled = true;

  try {
    const body = { text };
    if (replyingTo) body.reply_to_id = replyingTo.id;

    const comment = await api(`/api/post/${postId}/comments`, {
      method: 'POST',
      body,
    });

    // Сервер возвращает строку без join — добавляем reply_to из локального стейта
    if (replyingTo) comment.reply_to = { ...replyingTo };

    const list = document.getElementById('messagesList');

    const empty = list.querySelector('.empty-state');
    if (empty) list.innerHTML = '';

    ensureDateDivider(list);
    list.appendChild(buildBubble(comment, true));
    clearReplyingTo();

    inputField.value = '';
    inputField.style.height = 'auto';

    const post = await api(`/api/post/${postId}`);
    updateCountLabel(post.comment_count);

    window.WebApp?.HapticFeedback?.notificationOccurred('success');
    scrollToBottom();

  } catch (err) {
    if (err.message === 'Вы заблокированы') {
      showError('🚫 Вы заблокированы и не можете оставлять комментарии.');
    } else {
      if (err.message.includes('не найден')) clearReplyingTo();
      showToast('❌ ' + err.message);
    }
  } finally {
    isSending = false;
    sendBtn.disabled = !inputField.value.trim();
  }
}

// ─── УДАЛЕНИЕ ────────────────────────────────
async function deleteComment(id, btn) {
  if (!confirm('Удалить комментарий?')) return;

  btn.textContent = '…';
  try {
    await api(`/api/comments/${id}`, { method: 'DELETE' });

    const row = document.querySelector(`[data-id="${id}"]`);
    if (row) {
      row.style.opacity = '0';
      row.style.transform = 'scale(0.95)';
      row.style.transition = 'all 0.2s';
      setTimeout(() => row.remove(), 200);
    }

    const post = await api(`/api/post/${postId}`);
    updateCountLabel(post.comment_count);

    window.WebApp?.HapticFeedback?.notificationOccurred('success');
    showToast('Удалено');
  } catch (err) {
    showToast('❌ ' + err.message);
    btn.textContent = '✕';
  }
}

// ─── ОТВЕТ НА КОММЕНТАРИЙ ────────────────────
function setReplyingTo(comment) {
  replyingTo = comment;
  replyBarName.textContent = comment.first_name;
  replyBarText.textContent = truncate(comment.text, 40);
  replyBar.classList.add('show');
  inputField.focus();
}

function clearReplyingTo() {
  replyingTo = null;
  replyBar.classList.remove('show');
}

// ─── БАН ПОЛЬЗОВАТЕЛЯ (admin) ────────────────
async function banUser(userId, name) {
  if (!confirm(`Заблокировать пользователя ${name}?`)) return;
  try {
    await api(`/api/admin/ban/${userId}`, { method: 'POST', body: {} });
    showToast('Пользователь заблокирован');
  } catch (err) {
    showToast('❌ ' + err.message);
  }
}

// ─── UTILS ───────────────────────────────────
function updateCountLabel(count) {
  const s = count === 0 ? 'Нет комментариев'
    : count === 1 ? '1 комментарий'
    : (count >= 2 && count <= 4) ? `${count} комментария`
    : `${count} комментариев`;
  document.getElementById('commentCount').textContent = s;
}

function scrollToBottom() {
  const list = document.getElementById('messagesList');
  list.scrollTop = list.scrollHeight;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function formatDateLabel(date) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Сегодня';
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function showError(msg) {
  const bar = document.getElementById('errorBar');
  bar.textContent = msg;
  bar.classList.add('show');
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
