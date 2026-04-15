const API_BASE = 'YOUR_APPS_SCRIPT_WEBAPP_URL';

export async function fetchJson(params = {}) {
  const url = new URL(API_BASE);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }
  return response.json();
}

export async function searchPeopleByName(name) {
  if (!name?.trim()) return { items: [] };
  // Replace with real API call when Apps Script is ready:
  // return fetchJson({ action: 'search', name });
  return {
    items: [
      { id: '101', name, fatherName: '김OO', generation: 28, spouseName: '이OO' },
      { id: '220', name, fatherName: '김△△', generation: 29, spouseName: '박OO' },
    ],
  };
}

export async function fetchNotices() {
  // return fetchJson({ action: 'notices', limit: 3 });
  return {
    items: [
      { title: '문중 알림 예시', createdAt: '2026-03-30', author: '관리자', content: '알림 데이터가 연결되면 여기에 표시됩니다.' },
    ],
  };
}

