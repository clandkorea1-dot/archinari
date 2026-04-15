export function initNavigation(state) {
  const buttons = document.querySelectorAll('.nav-btn');
  const pages = document.querySelectorAll('.page-section');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('is-active'));
      pages.forEach((page) => page.classList.remove('active'));
      btn.classList.add('is-active');
      document.getElementById(btn.dataset.page).classList.add('active');
      state.currentPage = btn.dataset.page;
    });
  });
}

