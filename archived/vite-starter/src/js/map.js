export function initMapPage() {
  const slider = document.getElementById('generation-slider');
  const stage = document.getElementById('map-stage');

  slider.addEventListener('input', () => {
    stage.innerHTML = `<p class="muted">${slider.value}세 기준 마커 표시 준비</p>`;
  });
}

