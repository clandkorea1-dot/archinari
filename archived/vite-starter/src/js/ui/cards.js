export function createCard(title, bodyHtml) {
  const wrap = document.createElement('section');
  wrap.className = 'card';
  wrap.innerHTML = `<h3>${title}</h3>${bodyHtml}`;
  return wrap;
}

