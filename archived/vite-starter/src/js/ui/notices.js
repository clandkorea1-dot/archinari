import { fetchNotices } from '../api.js';

export async function loadInitialNotices() {
  const el = document.getElementById('notice-list');
  try {
    const result = await fetchNotices();
    el.innerHTML = '';
    result.items.forEach((notice) => {
      const div = document.createElement('div');
      div.className = 'card';
      div.innerHTML = `
        <strong>${notice.title}</strong><br />
        <span class="muted">${notice.createdAt} · ${notice.author}</span>
        <p>${notice.content}</p>
      `;
      el.appendChild(div);
    });
  } catch (error) {
    el.innerHTML = `<p class="muted">알림 로딩 오류: ${error.message}</p>`;
  }
}

