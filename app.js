// ─── СТЕЙТ ──────────────────────────────────
let initData    = '';
let currentUser = null;
let isAdmin     = false;
let postId      = null;   // message_id поста из канала
let isSending   = false;

// ─── INIT ────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  window.WebApp?.ready();

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
  const initials = (c.first_name || '?').charAt(0).toUpperCase();
  const time = new Date(c.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const row = document.createElement('div');
  row.className = `msg-row ${isMine ? 'mine' : 'other'}`;
  row.dataset.id = c.id;

  // data-comment-id вместо inline onclick — защита от XSS через c.id
  row.innerHTML = `
    <div class="avatar" title="${esc(c.first_name)}">${initials}</div>
    <div class="bubble">
      ${!isMine ? `<div class="bubble-author">${esc(c.first_name)}${c.username ? ' @' + esc(c.username) : ''}</div>` : ''}
      <div class="bubble-text">${esc(c.text)}</div>
      <div class="bubble-time">${time}</div>
      ${canDelete ? `<button class="bubble-delete" data-comment-id="${esc(c.id)}" title="Удалить">✕</button>` : ''}
    </div>
  `;
  return row;
}

// ─── ОТПРАВКА ────────────────────────────────
const inputField = document.getElementById('inputField');
const sendBtn    = document.getElementById('sendBtn');

// Делегированный обработчик удаления — безопасная альтернатива inline onclick
document.getElementById('messagesList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-comment-id]');
  if (btn) deleteComment(btn.dataset.commentId, btn);
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
    const comment = await api(`/api/post/${postId}/comments`, {
      method: 'POST',
      body: { text },
    });

    const list = document.getElementById('messagesList');

    const empty = list.querySelector('.empty-state');
    if (empty) list.innerHTML = '';

    ensureDateDivider(list);
    list.appendChild(buildBubble(comment, true));

    inputField.value = '';
    inputField.style.height = 'auto';

    const post = await api(`/api/post/${postId}`);
    updateCountLabel(post.comment_count);

    window.WebApp?.HapticFeedback?.notificationOccurred('success');
    scrollToBottom();

  } catch (err) {
    showToast('❌ ' + err.message);
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
