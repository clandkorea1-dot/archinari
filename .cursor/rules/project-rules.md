# Project Rules — 의성김씨 아천문중 세보

## Project identity
- Project name: 의성김씨 아천문중 세보
- Subtitle: 디지털 족보 및 문중 정보 시스템
- This project is a mobile-first PWA for genealogy exploration.

## Architecture
- Data source: Google Sheets
- API layer: Google Apps Script returning JSON
- Frontend: Vite + vanilla HTML/CSS/JavaScript
- Visualization: D3.js with SVG for tree rendering
- Map: Leaflet.js
- Deployment target: static hosting on Netlify

## Pages
- 홈
- 가계도
- 선조의 발자취
- 아천문중

## Core UX rules
- Keep explanations and UI labels in Korean unless explicitly requested otherwise.
- Home must include: header, 본인 확인, 문중 알림판, 직계 요약 미리보기.
- 본인 확인 sets a default selected person, but all other clan members must remain searchable and viewable.
- For 동명이인, show father name and generation to disambiguate.
- In direct ancestor summary and card:
  - show 부/모, 조부/조모, 증조부/증조모, 고조부/고조모
  - maternal names come from spouse fields of direct male ancestors
- In the detailed direct ancestor table, prioritize paternal siblings instead of spouses.

## Family tree rules
- The family tree page has three tabs:
  - 세보 트리
  - 8촌 찾기
  - 촌수 계산기
- Generation range rendering (1-10 / 11-20 / 21-31 / 32+) must be isolated: never let SVG `style.width/height` or zoom/transform state leak across ranges; always reset on range switch.
- Tree rendering structure:
  - 1세~24세: card-style summary
  - 25세~30세: core clan branch tree
  - 31세: selection board
  - 32세 이후: selected subtree
- Direct ancestor lines must be visually thicker than normal lines.
- Keep room for four major branches from 25세 onward:
  - 광택
  - 광진
  - 광룡
  - 광혁

## Mapping rules
- Use the page name '선조의 발자취'
- Show map markers only where location data exists.
- Prepare the generation slider so year labels can be added later.
- Clicking a marker should open a short popup description.

## Acheon clan page
- Use these tabs:
  - 가문의 연표와 선조
  - 대동보와 족보이야기
  - 정관 / 문중재산
  - 문중원 투표

## Voting rules
- Phase 1 voting is intentionally simple.
- Allow one vote per agenda per displayed name.
- Do not add heavy auth unless explicitly requested later.

## Workflow
- Before making major structural changes, read:
  - @docs/final-spec.md
  - @docs/decisions.md
- Keep changes small and explain the plan before large edits.
- Prefer editing existing files over creating unnecessary new ones.
- When implementing new features, follow the current folder structure and avoid introducing frameworks unless requested.

