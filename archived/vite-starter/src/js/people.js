export function renderSelectedPersonCard(person) {
  const summary = document.getElementById('direct-summary');
  summary.innerHTML = `
    <div>
      <strong>${person.name}</strong><br />
      문중원 ID: ${person.id}<br />
      세손: ${person.generation}세<br />
      배우자: ${person.spouseName ?? '-'}<br />
    </div>
  `;
}

export function renderDirectSummary(person) {
  const summary = document.getElementById('direct-summary');
  summary.innerHTML = `
    <div><strong>본인</strong>: ${person.name}</div>
    <div><strong>부 / 모</strong>: 김OO / 이OO</div>
    <div><strong>조부 / 조모</strong>: 김OO / 박OO</div>
    <div><strong>증조부 / 증조모</strong>: 김OO / 최OO</div>
    <div><strong>고조부 / 고조모</strong>: 김OO / 정OO</div>
  `;
}

