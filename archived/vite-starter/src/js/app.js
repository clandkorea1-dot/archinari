import { state } from './state.js';
import { initNavigation } from './ui/navigation.js';
import { initPersonSearch } from './search.js';
import { initTreePage } from './tree.js';
import { initMapPage } from './map.js';
import { initAcheonPage } from './history.js';
import { loadInitialNotices } from './ui/notices.js';

function bootstrap() {
  initNavigation(state);
  initPersonSearch(state);
  initTreePage(state);
  initMapPage(state);
  initAcheonPage(state);
  loadInitialNotices();
}

bootstrap();

