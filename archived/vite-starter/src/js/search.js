import { searchPeopleByName } from './api.js';
import { renderDirectSummary, renderSelectedPersonCard } from './people.js';

export function initPersonSearch(state) {
  const input = document.getElementById('person-name-input');
  const button = document.getElementById('person-search-btn');
  const list = document.getElementById('candidate-list');

  async function runSearch() {
    const name = input.value.trim();
    list.innerHTML = '<p class="muted">검색 중...</p>';
    try {
      const result = await searchPeopleByName(name);
      if (!result.items?.length) {
        list.innerHTML = '<p class="muted">검색 결과가 없습니다.</p>';
        return;
      }

      list.innerHTML = '';
      result.items.forEach((person) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = `${person.name} / 부: ${person.fatherName} / ${person.generation}세`;
        item.addEventListener('click', () => {
          state.selectedPersonId = person.id;
          state.selectedPerson = person;
          renderSelectedPersonCard(person);
          renderDirectSummary(person);
        });
        list.appendChild(item);
      });
    } catch (error) {
      list.innerHTML = `<p class="muted">오류: ${error.message}</p>`;
    }
  }

  button.addEventListener('click', runSearch);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runSearch();
  });
}

