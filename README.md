# 의성김씨 아천문중 세보 PWA

이 프로젝트는 **정적 HTML/CSS/JS** 기반 PWA(프로토타입)입니다.
데이터는 Google Apps Script(Web App) JSON API로 연동합니다.

## 실행(로컬에서 Live 확인)

```bash
npx --yes serve .
```

터미널에 출력되는 주소로 접속하세요.

## 현재 폴더 구조

```text
ucheongim-family-pwa/
├─ index.html
├─ main.js
├─ style.css
├─ README.md
│
├─ docs/
│  ├─ README.md
│  ├─ final-spec.md
│  ├─ prd.md
│  ├─ requirements.md
│
└─ archived/
   ├─ docs-raw/       # docs 초안/메모(보관)
   └─ vite-starter/   # Vite + 모듈형 초안(보관)
```

## archived/vite-starter

초기에 준비해 둔 **Vite + 모듈 기반** 스타터를 보관합니다.
추후 서비스워커/캐시 전략/빌드 최적화를 체계적으로 가져가려면 이 구조로 승격하는 것을 권장합니다.

