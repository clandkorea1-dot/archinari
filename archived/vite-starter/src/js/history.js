export function initAcheonPage(state) {
  const tabs = document.querySelectorAll('.acheon-tab');
  const content = document.getElementById('acheon-content');

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.currentAcheonTab = btn.dataset.acheonTab;

      const mapping = {
        timeline: '가문의 연표와 선조 콘텐츠 영역',
        daedongbo: '대동보와 족보이야기 콘텐츠 영역',
        bylaws: '정관 / 문중재산 콘텐츠 영역',
        vote: '문중원 투표 콘텐츠 영역',
      };
      content.innerHTML = `<p class="muted">${mapping[btn.dataset.acheonTab]}</p>`;
    });
  });
}

