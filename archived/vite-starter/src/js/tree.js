export function initTreePage(state) {
  const subtabs = document.querySelectorAll('.subtab');
  const subtabPanels = document.querySelectorAll('.subtab-panel');
  const sectionButtons = document.querySelectorAll('.tree-section-btn');
  const treeStage = document.getElementById('tree-stage');

  subtabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      subtabs.forEach((b) => b.classList.remove('is-active'));
      subtabPanels.forEach((p) => p.classList.remove('active'));
      btn.classList.add('is-active');
      document.getElementById(`tree-subtab-${btn.dataset.subtab}`).classList.add('active');
      state.currentTreeSubtab = btn.dataset.subtab;
    });
  });

  sectionButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      sectionButtons.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.treeSection = btn.dataset.section;
      treeStage.innerHTML = `<p class="muted">현재 구간: ${btn.textContent}</p>`;
    });
  });

  document.getElementById('kinship-calc-btn').addEventListener('click', () => {
    const result = document.getElementById('kinship-result');
    result.innerHTML = `
      <p><strong>공통 조상</strong>: 고조부 김OO</p>
      <p><strong>관계</strong>: 6촌</p>
      <div class="tree-stage">사람 1 ───── 공통 조상 ───── 사람 2</div>
    `;
  });
}

