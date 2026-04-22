/**
 * 아천문중 세보 검색 — Google Apps Script Web App
 * GET: ?action=search&name=검색어
 */
const API_BASE =
  "https://script.google.com/macros/s/AKfycbyy30psVcEtx_A2IY2HqbdyMtFhVeofEr9sFD_pxMU3K9I2n5NuOh6GM3zhwqVoch5D5w/exec";

const form = document.getElementById("search-form");
const nameInput = document.getElementById("name-input");
const submitBtn = document.getElementById("submit-btn");
const statusArea = document.getElementById("status-area");
const resultList = document.getElementById("result-list");
const debugDetails = document.getElementById("debug-details");
const debugLogEl = document.getElementById("debug-log");
const sheetUpdateStampEl = document.getElementById("sheet-update-stamp");
const homeNoticeListEl = document.getElementById("home-notice-list");
const homeNoticeHintEl = document.getElementById("home-notice-hint");
const hdrWeatherEl = document.getElementById("hdr-weather");
const hdrWeatherTempEl = document.getElementById("hdr-weather-temp");

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";
if (DEBUG && debugDetails) debugDetails.classList.remove("hidden");

function debugLog(title, payload) {
  if (!DEBUG || !debugLogEl) return;
  const ts = new Date().toISOString().slice(11, 19);
  let body = "";
  try {
    body =
      typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  } catch {
    body = String(payload);
  }
  debugLogEl.textContent =
    `${debugLogEl.textContent}\n[${ts}] ${title}\n${body}\n`.trimStart();
}

// 상단 날짜 스탬프(디자인용)
try {
  const el = document.getElementById("today-stamp");
  if (el) {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    el.textContent = `${yyyy}.${mm}.${dd}`;
  }
} catch {
  // ignore
}

/* ---------- 헤더: 경북 영주 날씨(현재 기온/아이콘) ---------- */

const YJ_WEATHER = {
  lat: 36.8057, // 영주 대략
  lon: 128.624,
  tz: "Asia/Seoul",
};

function weatherCodeToIcon(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return "cloud";
  // Open-Meteo weather_code 기준(간단 매핑)
  if (c === 0) return "sunny";
  if (c === 1 || c === 2) return "partly_cloudy_day";
  if (c === 3) return "cloud";
  if (c === 45 || c === 48) return "foggy";
  if (c === 51 || c === 53 || c === 55) return "rainy";
  if (c === 56 || c === 57) return "weather_hail";
  if (c === 61 || c === 63 || c === 65) return "rainy";
  if (c === 66 || c === 67) return "weather_hail";
  if (c === 71 || c === 73 || c === 75) return "ac_unit"; // snow
  if (c === 77) return "ac_unit";
  if (c === 80 || c === 81 || c === 82) return "rainy";
  if (c === 85 || c === 86) return "ac_unit";
  if (c === 95 || c === 96 || c === 99) return "thunderstorm";
  return "cloud";
}

async function refreshHeaderWeather() {
  if (!hdrWeatherEl || !hdrWeatherTempEl) return;
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(YJ_WEATHER.lat));
    url.searchParams.set("longitude", String(YJ_WEATHER.lon));
    url.searchParams.set("current", "temperature_2m,weather_code");
    url.searchParams.set("timezone", YJ_WEATHER.tz);
    url.searchParams.set("temperature_unit", "celsius");

    const res = await fetch(url.toString(), { method: "GET" });
    const json = await res.json();
    const cur = json?.current;
    const t = cur?.temperature_2m;
    const code = cur?.weather_code;
    const temp = Number(t);
    if (Number.isFinite(temp)) hdrWeatherTempEl.textContent = `${Math.round(temp)}°`;
    const ic = weatherCodeToIcon(code);
    const iconEl = hdrWeatherEl.querySelector(".hdr-weather-ic");
    if (iconEl) iconEl.textContent = ic;
  } catch {
    // 실패 시 조용히 유지(네트워크/CORS 등)
  }
}

/** 마지막 검색 결과 — 가계도 인물 목록에 사용 */
let lastSearchRows = [];

/** 홈에서 선택한 문중원 (API 상세와 연동) */
let selectedPersonId = null;
let lastPersonDetail = null;
const SELECTED_PERSON_STORAGE_KEY = "ucheongim_selectedPersonId_v1";
let treeGenFilter = null; // { min:number, max:number } | null
// 1-10세 등 genRange 결과 캐시(세션)
const genRangePeopleCache = new Map(); // "min-max" -> people[]

// 가계도 표시 모드(특정 세대 구간 전용 레이아웃 등)
let treeViewMode = "default"; // "default" | "genrange"
let gen21SelectedRootId = ""; // 21-31세 전용: 선택된 25세(시조) id

function loadSelectedPersonIdFromStorage() {
  try {
    const v = localStorage.getItem(SELECTED_PERSON_STORAGE_KEY);
    return v ? String(v).trim() : "";
  } catch {
    return "";
  }
}

function saveSelectedPersonIdToStorage(id) {
  try {
    if (!id) localStorage.removeItem(SELECTED_PERSON_STORAGE_KEY);
    else localStorage.setItem(SELECTED_PERSON_STORAGE_KEY, String(id));
  } catch {
    // ignore
  }
}

/** id -> row 캐시(검색 결과 기반) */
let peopleByIdCache = new Map();
/** person API 캐시 */
const personByIdCache = new Map(); // id -> person object
const eightKinFatherIdCache = new Map(); // personId -> fatherId (string)

/** 8촌 연결선·점 색상: 본문/포인트 seal 녹색과 통일. 기하·정렬은 docs/8촌_렌더링_불변규칙.md 고정. */
const EIGHT_KIN_EDGE = "#166534";
const EIGHT_KIN_EDGE_SOFT = "rgba(22, 101, 52, 0.42)";

/** kinship 결과 캐시 (id1,id2 -> {text,ts}) */
const kinshipCache = new Map();
const kinshipInFlight = new Map(); // key -> Promise<string>
/** kinship 관계도(visual) 캐시: key -> { ts, data } */
const kinshipVisualCache = new Map();
let kinshipCalcSeq = 0;
const KINSHIP_CACHE_STORAGE_KEY = "ucheongim_kinship_cache_v1";
const KINSHIP_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30일
// 관계도는 화면용 임시 캐시(세션). 너무 오래 들고 있지 않음.
const KINSHIP_VISUAL_CACHE_TTL_MS = 1000 * 60 * 10; // 10분

function kinshipVisualCacheGet(key) {
  const v = kinshipVisualCache.get(key);
  if (!v) return null;
  const ts = Number(v.ts || 0);
  if (ts && Date.now() - ts > KINSHIP_VISUAL_CACHE_TTL_MS) {
    kinshipVisualCache.delete(key);
    return null;
  }
  return v.data || null;
}

function kinshipVisualCacheSet(key, data) {
  if (!key || !data) return;
  kinshipVisualCache.set(key, { ts: Date.now(), data });
  // 간단한 상한: 최근 16개만 유지
  if (kinshipVisualCache.size > 16) {
    const entries = [...kinshipVisualCache.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    entries.slice(0, Math.max(0, entries.length - 16)).forEach(([k]) => kinshipVisualCache.delete(k));
  }
}

function kinshipPairKey(id1, id2) {
  const a = String(id1 || "").trim();
  const b = String(id2 || "").trim();
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

function kinshipCacheLoadFromStorage() {
  try {
    const raw = localStorage.getItem(KINSHIP_CACHE_STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== "object") continue;
      const ts = Number(v.ts || 0);
      const text = String(v.text || "");
      if (!text) continue;
      if (ts && now - ts > KINSHIP_CACHE_TTL_MS) continue;
      kinshipCache.set(k, { text, ts: ts || now });
    }
  } catch {
    // ignore
  }
}

function kinshipCacheSaveToStorage() {
  try {
    const now = Date.now();
    const out = {};
    for (const [k, v] of kinshipCache.entries()) {
      if (!v?.text) continue;
      if (v.ts && now - v.ts > KINSHIP_CACHE_TTL_MS) continue;
      out[k] = { text: v.text, ts: v.ts || now };
    }
    localStorage.setItem(KINSHIP_CACHE_STORAGE_KEY, JSON.stringify(out));
  } catch {
    // ignore
  }
}

// 최초 1회만 로드
try {
  kinshipCacheLoadFromStorage();
} catch {
  // ignore
}

/** 문중 유적지 (위·경도는 실제 데이터로 바꿀 수 있음) */
const HERITAGE_SITES = [
  {
    name: "의성 지역 유적 (예시)",
    lat: 36.353,
    lng: 128.697,
    desc: "OpenStreetMap 타일 위 마커 예시입니다.",
  },
  {
    name: "시조 묘역 (예시)",
    lat: 36.382,
    lng: 128.651,
    desc: "좌표를 시트/API와 맞추어 수정하세요.",
  },
  {
    name: "문중 행사 장소 (예시)",
    lat: 36.336,
    lng: 128.724,
    desc: "필요 시 마커를 추가하세요.",
  },
];

let mapInstance = null;
let mapMarkersLayer = null;
/** 마지막으로 fitBounds 한 영역(지도 「맞춤」 버튼 복귀용) */
let lastMapFitBounds = null;

/** 화면에 보일 한글 라벨 */
const FIELD_LABELS = {
  name: "이름",
  이름: "이름",
  성명: "성명",
  한글명: "한글명",
  표기: "표기",
  세: "세",
  세대: "세대",
  본: "본",
  본관: "본관",
  파: "파",
  호: "호",
  자: "자",
  호칭: "호칭",
  부: "부",
  모: "모",
  부친: "부친",
  모친: "모친",
  배우자: "배우자",
  출생: "출생",
  사망: "사망",
  묘소: "묘소",
  비고: "비고",
  memo: "메모",
  note: "비고",
  row: "행",
  id: "문중원ID",
  문중원ID: "문중원ID",
};

const NAME_KEYS = ["이름", "성명", "name", "한글명", "표기명", "표기"];
const CLAN_MEMBER_ID_KEYS = [
  "문중원ID",
  "문중원Id",
  "문중원 id",
  "문중원_id",
  "문중원id",
  "clanMemberId",
  "memberId",
  "personId",
  "ID",
  "id",
];
const TAG_KEYS = ["세손", "세대", "세", "gen", "generation", "본", "본관", "파", "호"];
const PARENT_ID_KEYS = [
  "parentId",
  "fatherId",
  "fatherID",
  "fatId",
  "아버지의ID",
  "아버지ID",
  "부친ID",
  "부모ID",
  "father_id",
  "부_id",
];
const PARENT_NAME_KEYS = [
  "아버지 성함",
  "아버지성함",
  "아버지이름",
  "부친 성함",
  "부친성함",
  "부친",
  "부",
  "fatherName",
  "father",
  "Father",
  "아버지",
];

const ROOT_SENTINEL = "__root__";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showStatus(message, isError = false) {
  statusArea.textContent = message;
  const base = "mt-6 rounded-xl border px-4 py-6 text-center text-sm";
  statusArea.className = isError
    ? `${base} border-red-200 bg-red-50 text-red-800`
    : `${base} border-dashed border-stone-300 bg-white/60 text-stone-600`;
}

function hideStatus() {
  statusArea.className =
    "mt-6 hidden rounded-xl border border-dashed border-stone-300 bg-white/60 px-4 py-6 text-center text-sm text-stone-600";
  statusArea.textContent = "";
}

function labelForKey(key) {
  if (!key) return "";
  const k = String(key).trim();
  return FIELD_LABELS[k] || FIELD_LABELS[k.toLowerCase()] || k;
}

function pickFirstString(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim() !== "") {
      return String(obj[k]).trim();
    }
  }
  return "";
}

function initialsFromName(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  return s.length <= 2 ? s : s.slice(0, 2);
}

function isRunningOnlyResponse(data) {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return false;
  if (data.tree != null || data.root != null) return false;
  if (data.person != null && typeof data.person === "object") return false;
  if (data.detail != null && typeof data.detail === "object") return false;
  const st = String(data.status ?? "").toLowerCase();
  if (st !== "running") return false;
  const listKeys = [
    "rows",
    "data",
    "results",
    "items",
    "list",
    "records",
    "members",
    "문중원",
    "people",
  ];
  return !listKeys.some((k) => Array.isArray(data[k]) && data[k].length > 0);
}

function getClanMemberId(row, index) {
  if (!row || typeof row !== "object") return `idx_${index}`;
  for (const k of CLAN_MEMBER_ID_KEYS) {
    if (row[k] != null && String(row[k]).trim() !== "") {
      return String(row[k]).trim();
    }
  }
  return `idx_${index}`;
}

/** 동명이인 구분용: 세손/세대 한 줄 */
function formatSesongLine(row) {
  if (!row || typeof row !== "object") return "";
  const g = pickFirstString(row, ["세손", "gen", "세대", "세", "generation"]);
  if (!g) return "";
  const s = String(g).trim();
  if (s.includes("세")) return s;
  return `${s}세손`;
}

function formatFatherBrief(row) {
  if (!row || typeof row !== "object") return "기록 없음";
  const f = pickFirstString(row, PARENT_NAME_KEYS);
  if (f) return f;
  const fid = pickFirstString(row, PARENT_ID_KEYS);
  if (fid) return `문중원ID ${fid}`;
  return "기록 없음";
}

function readNodeGenLike(obj) {
  if (!obj || typeof obj !== "object") return null;
  const raw = pickFirstString(obj, ["gen", "세손", "세대", "세", "generation"]);
  if (!raw) return null;
  const m = String(raw).match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function joinPeopleText(val) {
  if (val == null) return "";
  if (Array.isArray(val)) return val.map(String).filter(Boolean).join(", ");
  return String(val).trim();
}

/** 쉼표·전각쉼표·顿号·줄바꿈으로 인물 이름 목록 분리 */
function splitPeopleList(val) {
  if (val == null || val === "") return [];
  if (Array.isArray(val)) {
    return val.map((s) => String(s).trim()).filter(Boolean);
  }
  return String(val)
    .split(/[,，、\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function rebuildPeopleByIdCache() {
  peopleByIdCache = new Map();
  lastSearchRows.forEach((row, i) => {
    const id = getClanMemberId(row, i);
    if (id) peopleByIdCache.set(String(id), row);
  });
}

async function getPersonById(id) {
  const key = String(id);
  if (personByIdCache.has(key)) return personByIdCache.get(key);
  // 검색 결과에 이미 있으면 네트워크 생략(직계 조상 연결 속도 개선)
  if (peopleByIdCache.has(key)) {
    const row = peopleByIdCache.get(key);
    personByIdCache.set(key, row);
    return row;
  }
  // Apps Script 구현에 따라 person 파라미터명이 제각각일 수 있음 → 여러 키를 순서대로 시도
  const attempts = [
    { action: "person", id: key },
    { action: "person", 문중원ID: key },
    { action: "person", memberId: key },
    { action: "person", clanMemberId: key },
    { action: "person", personId: key },
  ];
  let p = null;
  for (const params of attempts) {
    const json = await apiGetSilent(params);
    p = normalizePersonPayload(json);
    if (p) break;
  }
  if (p) personByIdCache.set(key, p);
  return p || null;
}

/**
 * 직계 조상 연결용: 캐시 우선, person은 흔한 파라미터만 빠르게 시도 후 실패 시에만 전체 getPersonById
 */
async function getPersonByIdForAncestorChain(id) {
  const key = String(id);
  if (personByIdCache.has(key)) return personByIdCache.get(key);
  if (peopleByIdCache.has(key)) {
    const row = peopleByIdCache.get(key);
    personByIdCache.set(key, row);
    return row;
  }
  const quickAttempts = [
    { action: "person", id: key },
    { action: "person", 문중원ID: key },
    { action: "person", memberId: key },
  ];
  for (const params of quickAttempts) {
    const json = await apiGetSilent(params, { maxAttempts: 2, retryDelayMs: 450 });
    const p = normalizePersonPayload(json);
    if (p) {
      personByIdCache.set(key, p);
      return p;
    }
  }
  return getPersonById(key);
}

/**
 * 부친 성함은 서버가 "아버지의ID"만 줄 수 있어서,
 * 1) 검색결과 캐시에서 역조회
 * 2) 없으면 person API로 fatherId 조회
 */
async function resolveFatherName(row) {
  if (!row || typeof row !== "object") return "기록 없음";
  const byName = pickFirstString(row, PARENT_NAME_KEYS);
  if (byName) return byName;
  const fid = pickFirstString(row, PARENT_ID_KEYS);
  if (!fid) return "기록 없음";

  const fromCache = peopleByIdCache.get(String(fid));
  if (fromCache) {
    const nm = pickFirstString(fromCache, NAME_KEYS);
    if (nm) return nm;
  }

  const p = await getPersonById(fid);
  const nm = p ? pickFirstString(p, NAME_KEYS) : "";
  return nm || `문중원ID ${fid}`;
}

function normalizeRows(data) {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === "object") {
    if (isRunningOnlyResponse(data)) return null;
    const keys = [
      "rows",
      "data",
      "results",
      "items",
      "list",
      "records",
      "members",
      "문중원",
      "people",
    ];
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k];
    }
    return [data];
  }
  return [{ value: String(data) }];
}

function entriesForCard(row) {
  if (row == null) return [];
  if (typeof row === "string") return [["내용", row]];
  if (typeof row !== "object") return [["내용", String(row)]];
  return Object.entries(row).filter(
    ([k, v]) =>
      v != null &&
      String(v).trim() !== "" &&
      String(k).toLowerCase() !== "status"
  );
}

function annotatePeople(people) {
  const used = new Set();
  return people.map((row, i) => {
    let id = getClanMemberId(row, i);
    const base = id;
    let n = 0;
    while (used.has(id)) id = `${base}_${++n}`;
    used.add(id);
    const name = pickFirstString(row, NAME_KEYS) || `인물${i + 1}`;
    return { id, name, row, i };
  });
}

function buildGraphRows(people) {
  const items = annotatePeople(people);
  const idSet = new Set(items.map((x) => x.id));
  const idByName = new Map(items.map((it) => [it.name, it.id]));

  function resolveParent(it) {
    const pid = pickFirstString(it.row, PARENT_ID_KEYS);
    if (pid && idSet.has(String(pid))) return String(pid);
    const pName = pickFirstString(it.row, PARENT_NAME_KEYS);
    if (pName && idByName.has(pName)) return idByName.get(pName);
    return null;
  }

  const rows = items.map((it) => {
    const p = resolveParent(it);
    return {
      id: it.id,
      parentId: p || ROOT_SENTINEL,
      name: it.name,
      row: it.row,
    };
  });
  rows.push({
    id: ROOT_SENTINEL,
    parentId: "",
    name: "검색 결과",
    row: null,
  });
  return rows;
}

/** 선택 인물을 뿌리로 한 후손만 남김 (d3.stratify용) */
function descendantStratifyRows(allRows, focusId) {
  const children = new Map();
  allRows.forEach((r) => {
    if (r.id === ROOT_SENTINEL) return;
    const p = r.parentId;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(r);
  });

  const keep = new Set();
  function dfs(id) {
    keep.add(id);
    (children.get(id) || []).forEach((c) => dfs(c.id));
  }
  dfs(focusId);

  return allRows
    .filter((r) => r.id !== ROOT_SENTINEL && keep.has(r.id))
    .map((r) => ({
      id: r.id,
      parentId:
        r.id === focusId
          ? ""
          : keep.has(r.parentId) && r.parentId !== ROOT_SENTINEL
            ? r.parentId
            : "",
      name: r.name,
      row: r.row,
    }))
    .filter((r) => (r.parentId === "" ? r.id === focusId : true));
}

/** 검색 결과: 동명이인 구분용 요약 + 클릭 시 selectPerson(문중원ID) */
function renderSearchResultCard(row, index) {
  const li = document.createElement("li");
  const clanId = getClanMemberId(row, index);
  li.className =
    "search-result-card cursor-pointer overflow-hidden rounded-2xl border border-stone-200/90 bg-white shadow-sm ring-1 ring-black/[0.03] transition hover:border-seal/40 hover:shadow-md focus-within:ring-2 focus-within:ring-seal/30";
  li.setAttribute("role", "button");
  li.setAttribute("tabindex", "0");
  li.dataset.personId = clanId;

  const asObj = typeof row === "object" && row && !Array.isArray(row) ? row : {};
  const displayName =
    pickFirstString(asObj, NAME_KEYS) || `문중원 ${index + 1}`;
  const sesong = formatSesongLine(asObj);
  const fatherId = pickFirstString(asObj, PARENT_ID_KEYS);
  if (fatherId) li.dataset.fatherId = String(fatherId).trim();
  const fatherTextInitial = pickFirstString(asObj, PARENT_NAME_KEYS)
    ? pickFirstString(asObj, PARENT_NAME_KEYS)
    : fatherId
      ? "불러오는 중…"
      : "기록 없음";

  li.innerHTML = `
    <div class="flex gap-3 p-4 sm:p-5">
      <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-seal/15 to-seal/5 text-base font-bold text-seal" aria-hidden="true">${escapeHtml(initialsFromName(displayName))}</div>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-lg font-bold text-ink-900">${escapeHtml(displayName)}</span>
          ${sesong ? `<span class="text-sm font-semibold text-stone-700">${escapeHtml(sesong)}</span>` : ""}
          <span class="text-sm text-stone-500">·</span>
          <span class="text-sm font-medium text-stone-700">문중원ID <span class="font-mono">${escapeHtml(clanId)}</span></span>
        </div>
        <p class="mt-1 text-sm text-stone-600">
          부친: <span class="father-name font-medium text-ink-800">${escapeHtml(fatherTextInitial)}</span>
          <span class="ml-2 text-xs text-seal">탭하여 상세 보기</span>
        </p>
      </div>
    </div>
  `;

  const activate = () => void selectPerson(clanId);
  li.addEventListener("click", activate);
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  });
  return li;
}

function renderResults(rows) {
  resultList.innerHTML = "";

  if (rows === null) {
    showStatus(
      "서버가 아직 준비 중입니다(status: running). 잠시 후 다시 검색해 보세요.",
      true
    );
    lastSearchRows = [];
    refreshTreePersonSelect();
    return;
  }
  if (!rows.length) {
    showStatus("검색 결과가 없습니다. 다른 이름으로 다시 시도해 보세요.");
    lastSearchRows = [];
    refreshTreePersonSelect();
    return;
  }

  hideStatus();
  lastSearchRows = rows.filter((r) => typeof r === "object" && r !== null);
  rebuildPeopleByIdCache();
  refreshTreePersonSelect();
  debugLog("search rows (first 3)", lastSearchRows.slice(0, 3));

  const maxCandidates = 12;
  const fragment = document.createDocumentFragment();
  const toShow = lastSearchRows.slice(0, maxCandidates);
  toShow.forEach((row, index) => {
    const card = renderSearchResultCard(row, index);
    fragment.appendChild(card);
    // 성능 최적화: 카드마다 person API로 부친 역조회하지 않음.
    // (검색결과 안에 부친이 함께 포함된 경우에만 즉시 이름으로 보강)
    const fatherId = pickFirstString(row, PARENT_ID_KEYS);
    if (fatherId && peopleByIdCache.has(String(fatherId))) {
      const fRow = peopleByIdCache.get(String(fatherId));
      const nm = pickFirstString(fRow, NAME_KEYS);
      const el = card.querySelector(".father-name");
      if (el && nm) el.textContent = nm;
    }
  });
  if (lastSearchRows.length > maxCandidates) {
    showStatus(`동명이인 후보가 많아 상위 ${maxCandidates}명만 표시합니다.`, false);
  }
  rows.forEach((row) => {
    if (typeof row !== "object" || row === null) {
      const li = document.createElement("li");
      li.className =
        "rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-700";
      li.textContent = String(row);
      fragment.appendChild(li);
    }
  });
  resultList.appendChild(fragment);

  // 2차 보강: 검색결과에 부친이 포함되지 않은 경우(= ID만 있는 경우),
  // person API로 부친 이름을 배치로 가져와 카드에 표시한다.
  // 본인 확인 체감 우선: 즉시 네트워크를 많이 쓰지 않도록 약간 지연 후 실행
  try {
    setTimeout(() => void hydrateFatherNamesForVisibleResults(), 450);
  } catch {
    void hydrateFatherNamesForVisibleResults();
  }
}

let fatherHydrateRunning = false;
async function hydrateFatherNamesForVisibleResults() {
  if (fatherHydrateRunning) return;
  fatherHydrateRunning = true;
  try {
    const cards = Array.from(document.querySelectorAll(".search-result-card"));
    const fatherIds = [
      ...new Set(cards.map((c) => c.dataset.fatherId).filter(Boolean)),
    ];
    const missing = fatherIds.filter((fid) => !peopleByIdCache.has(String(fid)));
    if (!missing.length) return;

    // 동시성 제한(네트워크/쿼터 보호)
    const concurrency = 2;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, missing.length) },
      async () => {
        while (cursor < missing.length) {
          const fid = missing[cursor++];
          const p = await getPersonById(fid);
          const nm = p ? pickFirstString(p, NAME_KEYS) : "";
          if (!nm) continue;
          cards.forEach((c) => {
            if (String(c.dataset.fatherId || "") === String(fid)) {
              const el = c.querySelector(".father-name");
              if (el) el.textContent = nm;
            }
          });
        }
      }
    );
    await Promise.all(workers);
  } finally {
    fatherHydrateRunning = false;
  }
}

function normalizePersonPayload(json) {
  if (!json || typeof json !== "object") return null;
  if (isRunningOnlyResponse(json)) return null;
  const p = json.person ?? json.data ?? json.detail ?? json.member;
  if (p && typeof p === "object" && !Array.isArray(p)) return p;
  if (json.name != null || json.이름 != null) return json;
  return null;
}

function normalizeEightKinList(json) {
  if (!json || typeof json !== "object") return [];
  return normalizeList(json, [
    "eightKin",
    "relations",
    "kin",
    "nodes",
    "data",
    "items",
    "list",
  ]);
}

function eightKinItemRelation(item) {
  if (!item || typeof item !== "object") return "";
  return String(
    item.relation ??
      item.관계 ??
      item.label ??
      item.role ??
      item.촌수 ??
      item.chon ??
      ""
  ).trim();
}

/** 8촌 친척 항목의 세대(세손) 숫자 — 없으면 null */
function kinItemGenNum(it) {
  if (!it || typeof it !== "object") return null;
  return readNodeGenLike(it);
}

/**
 * 직계 부계 [본인, 부, 조부, …]에서 8촌 기점: 부계 고조부(본인 기준 4대 위) 우선, 없으면 도달한 최상단
 */
function eightKinAnchorFromPaternalChain(chain) {
  if (!chain || chain.length === 0) return null;
  const GOJOBU_INDEX = 4;
  if (chain.length > GOJOBU_INDEX) {
    return {
      person: chain[GOJOBU_INDEX],
      role: "고조부(부계)",
      index: GOJOBU_INDEX,
    };
  }
  const top = chain[chain.length - 1];
  return {
    person: top,
    role: "직계 최상단(고조부까지 미도달)",
    index: chain.length - 1,
  };
}

function eightKinGenRowLabel(k) {
  if (k === "미상") return "세손 미상";
  const s = String(k).trim();
  return /^\d+(\.\d+)?$/.test(s) ? `${s}세손` : s;
}

function kinItemFatherId(it) {
  if (!it || typeof it !== "object") return "";
  return String(
    pickFirstString(it, [
      ...PARENT_ID_KEYS,
      "부친문중원ID",
      "부친문중원Id",
      "부친 문중원ID",
      "아버지문중원ID",
      "아버지 문중원ID",
      "부친ID",
      "부친id",
      "부친Id",
      "부ID",
      "부id",
      "부Id",
      "father문중원ID",
      "fatherId",
      "fatherID",
      "parentId",
      "parentID",
    ]) || ""
  ).trim();
}

/** 문중원ID 등 숫자 문자열은 숫자 순으로, 그 외는 localeCompare */
function compareClanMemberIds(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  const na = Number.parseInt(sa, 10);
  const nb = Number.parseInt(sb, 10);
  if (
    Number.isFinite(na) &&
    Number.isFinite(nb) &&
    String(na) === sa &&
    String(nb) === sb
  ) {
    return na - nb;
  }
  return sa.localeCompare(sb, "ko", { numeric: true });
}

function nameFromCachesById(id) {
  const key = String(id || "").trim();
  if (!key) return "";
  const p = personByIdCache.get(key) || peopleByIdCache.get(key);
  if (p && typeof p === "object") {
    const nm = pickFirstString(p, NAME_KEYS);
    if (nm) return String(nm).trim();
  }
  return "";
}

async function hydrateFatherIdsForEightKin(ids, opts = {}) {
  const uniq = [...new Set(ids.map((x) => String(x || "").trim()).filter(Boolean))];
  const limit = opts.concurrency ?? 12;
  let cursor = 0;
  let done = 0;

  const hintEl = document.getElementById("eight-kin-hint-home");
  const total = uniq.length;
  if (hintEl) hintEl.textContent = `부친ID 보강 중… (0/${total})`;

  const work = async () => {
    while (cursor < uniq.length) {
      const id = uniq[cursor++];
      if (eightKinFatherIdCache.has(id)) {
        done += 1;
        continue;
      }
      const p = await getPersonByIdForAncestorChain(id);
      const fid = p ? pickFirstString(p, PARENT_ID_KEYS) : "";
      const out = fid ? String(fid).trim() : "";
      if (out) eightKinFatherIdCache.set(id, out);
      done += 1;
      if (hintEl && (done % 8 === 0 || done === total)) {
        hintEl.textContent = `부친ID 보강 중… (${done}/${total})`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => work()));
}

function attachEightKinZoomBehavior(svg, gRoot, toolbar) {
  if (typeof d3 === "undefined") return;
  const zoom = d3
    .zoom()
    .scaleExtent([0.12, 6])
    .on("zoom", (event) => {
      gRoot.setAttribute("transform", event.transform.toString());
    });
  const sel = d3.select(svg);
  sel.call(zoom);
  sel.on("dblclick.zoom", null);
  toolbar.querySelectorAll(".eight-kin-z").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.getAttribute("data-act");
      if (act === "in") sel.transition().duration(180).call(zoom.scaleBy, 1.28);
      else if (act === "out") sel.transition().duration(180).call(zoom.scaleBy, 1 / 1.28);
      else if (act === "reset") sel.transition().duration(220).call(zoom.transform, d3.zoomIdentity);
    });
  });
}

/**
 * 왼쪽 기준 → 오른쪽 세대 열.
 * 각 열: 부친 ID 오름차순 → 같은 부 아래 자녀는 자신 ID 순.
 * 부–자·형제 연결: seal 녹색 계열 (docs/8촌_렌더링_불변규칙.md). 시트 부모 ID 필드 필요.
 */
function mountEightKinHorizontalTreeSvg(box, opts) {
  const {
    filtered,
    anchorInfo,
    anchorName,
    anchorGen,
    anchorId,
    anchorRole: anchorRoleOpt,
    fatherMap,
  } = opts;
  const anchorRole = anchorRoleOpt || "";

  box.innerHTML = "";
  const COL_W = 108;
  const PAD_L = 32;
  const PAD_T = 36;
  // 기본 세로 간격(가독성). 실제 배치는 "자녀 수"에 따라 유동적으로 더 벌어진다.
  const ROW_H = 30;
  const MIN_DY = 20; // 같은 열에서 이름끼리 최소 간격(겹침 방지)
  const GROUP_GAP = 18; // 부친 그룹(가족) 사이 간격
  const FONT_MAIN = 12.5;
  const FONT_CAP = 10;

  const toolbar = document.createElement("div");
  toolbar.className =
    "mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-stone-200/80 pb-2";
  toolbar.innerHTML = `
    <span class="text-[11px] text-stone-500">세대별 정렬: 부친 ID 순 → 자녀 ID 순 · 부–자·형제 연결 녹색(seal) · 드래그·휠 확대</span>
    <span class="flex gap-1">
      <button type="button" class="eight-kin-z rounded border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium text-stone-700 hover:bg-stone-50" data-act="in" title="확대">＋</button>
      <button type="button" class="eight-kin-z rounded border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium text-stone-700 hover:bg-stone-50" data-act="out" title="축소">－</button>
      <button type="button" class="eight-kin-z rounded border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium text-stone-700 hover:bg-stone-50" data-act="reset" title="화면 맞춤">맞춤</button>
    </span>`;

  const view = document.createElement("div");
  view.className =
    "eight-kin-tree-view relative h-[min(76vh,620px)] w-full overflow-hidden rounded-xl border border-stone-200/90 bg-[#fafaf9]";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.cursor = "grab";
  svg.style.touchAction = "none";
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "8촌 친척 가로 가계도");

  const gRoot = document.createElementNS("http://www.w3.org/2000/svg", "g");
  gRoot.setAttribute("class", "eight-kin-zoom-layer");
  const gEdge = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gNode = document.createElementNS("http://www.w3.org/2000/svg", "g");
  gRoot.appendChild(gEdge);
  gRoot.appendChild(gNode);
  svg.appendChild(gRoot);

  /** @type {Map<string, { id: string, name: string, gen: number|null, col: number, fatherId: string, x: number, y: number, w: number, h: number }>} */
  const byId = new Map();

  const effectiveAnchorId =
    anchorInfo && String(anchorId || "").trim()
      ? String(anchorId).trim()
      : anchorInfo
        ? "__kin_anchor__"
        : "";

  if (anchorInfo && effectiveAnchorId) {
    byId.set(effectiveAnchorId, {
      id: effectiveAnchorId,
      name: anchorName,
      gen: anchorGen != null ? Number(anchorGen) : null,
      col: 0,
      fatherId: "",
      x: 0,
      y: 0,
      w: 0,
      h: ROW_H,
    });
  }

  filtered.forEach((it, idx) => {
    const id = String(
      pickFirstString(it, [
        "문중원ID",
        "문중원id",
        "clanMemberId",
        "memberId",
        "personId",
        "ID",
        "id",
      ]) || getClanMemberId(it, idx)
    ).trim();
    if (!id || id.startsWith("idx_")) return;
    const name = String(it.name ?? it.이름 ?? it.label ?? "?").trim() || "?";
    const g = kinItemGenNum(it);
    let col = 1;
    if (anchorGen != null && g != null && Number.isFinite(Number(g))) {
      col = Math.max(0, Number(g) - Number(anchorGen));
    } else if (g != null && Number.isFinite(Number(g))) {
      col = Math.max(1, Number(g) % 32);
    }
    if (byId.has(id)) return;
    const fatherFromMap =
      fatherMap && fatherMap instanceof Map ? String(fatherMap.get(id) || "").trim() : "";
    byId.set(id, {
      id,
      name,
      gen: g != null ? Number(g) : null,
      col,
      fatherId: fatherFromMap || kinItemFatherId(it),
      x: 0,
      y: 0,
      w: 0,
      h: ROW_H,
    });
  });

  // father 노드가 목록에 없으면(하지만 선 연결을 위해 필요하면) 임시 노드를 만든다.
  // 이렇게 하면 "선 연결이 없던" 케이스(부친은 목록에 없고 자식만 있는 경우)도 연결이 생긴다.
  const ensureFatherStubs = () => {
    const toAdd = [];
    byId.forEach((n) => {
      const fid = String(n.fatherId || "").trim();
      if (!fid) return;
      if (byId.has(fid)) return;
      const nm = nameFromCachesById(fid) || fid;
      const col = Math.max(0, n.col - 1);
      toAdd.push({ id: fid, name: nm, col });
    });
    toAdd.forEach((x) => {
      if (byId.has(x.id)) return;
      byId.set(x.id, {
        id: x.id,
        name: x.name,
        gen: null,
        col: x.col,
        fatherId: "",
        x: 0,
        y: 0,
        w: 0,
        h: ROW_H,
      });
    });
    return toAdd.length;
  };
  const stubAdded = ensureFatherStubs();

  if (!byId.size) {
    box.innerHTML =
      '<p class="text-sm text-stone-600">표시할 인물(문중원ID)이 없습니다.</p>';
    return;
  }

  const maxCol = Math.max(0, ...[...byId.values()].map((n) => n.col));
  const byCol = new Map();
  for (let c = 0; c <= maxCol; c++) byCol.set(c, []);
  byId.forEach((n) => {
    if (!byCol.has(n.col)) byCol.set(n.col, []);
    byCol.get(n.col).push(n);
  });
  byCol.forEach((arr) => {
    arr.sort((a, b) => {
      if (a.id === effectiveAnchorId) return -1;
      if (b.id === effectiveAnchorId) return 1;
      const aHas = !!a.fatherId;
      const bHas = !!b.fatherId;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && bHas) {
        const cf = compareClanMemberIds(a.fatherId, b.fatherId);
        if (cf !== 0) return cf;
      }
      return compareClanMemberIds(a.id, b.id);
    });
  });

  const totalW = PAD_L + (maxCol + 1) * COL_W + 40;
  const colCenterX = (c) => PAD_L + c * COL_W + COL_W / 2;

  // 유동 배치:
  // - 같은 아버지의 자녀는 반드시 붙여서(연속) 배치
  // - 이름이 겹치지 않도록 최소 간격 보장
  // - 각 세대(열)의 그룹 순서는 "아버지 세대(이전 열)의 순서"를 우선 반영
  const layoutCol = (c) => {
    const arr = byCol.get(c) || [];
    // 노드 폭 계산은 공통
    arr.forEach((n) => {
      n.w = Math.min(180, Math.max(36, n.name.length * FONT_MAIN * 0.52 + 10));
      n.x = colCenterX(c);
    });

    // 그룹: fatherId가 있으면 그 fatherId로 묶고, 없으면 자신의 id로 1인 그룹
    const groups = new Map(); // key -> nodes[]
    arr.forEach((n) => {
      const key = n.fatherId ? `F:${n.fatherId}` : `S:${n.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    });

    const fatherY = (fid) => {
      const p = byId.get(String(fid));
      return p && Number.isFinite(p.y) ? p.y : Infinity;
    };

    const orderedKeys = [...groups.keys()].sort((a, b) => {
      const fa = a.startsWith("F:") ? a.slice(2) : "";
      const fb = b.startsWith("F:") ? b.slice(2) : "";
      // 이전 열(아버지 세대)의 y순서가 있으면 그걸 우선 사용
      if (fa && fb) {
        const ya = fatherY(fa);
        const yb = fatherY(fb);
        if (ya !== Infinity || yb !== Infinity) {
          if (ya === Infinity) return 1;
          if (yb === Infinity) return -1;
          if (ya !== yb) return ya - yb;
        }
        return compareClanMemberIds(fa, fb);
      }
      if (fa) return -1;
      if (fb) return 1;
      return a.localeCompare(b, "en");
    });

    let y = PAD_T + 34;
    orderedKeys.forEach((k) => {
      const nodes = groups.get(k) || [];
      // 자녀 수가 많으면 더 넓게 (최소 간격 MIN_DY를 보장)
      const inner = Math.max(ROW_H, Math.max(0, nodes.length - 1) * MIN_DY);
      const pad = Math.max(10, Math.min(22, nodes.length * 3));
      const blockH = inner + pad * 2;

      // 블록 안에서 균등 배치
      const step = nodes.length > 1 ? Math.max(MIN_DY, inner / (nodes.length - 1)) : 0;
      const y0 = y + pad + (nodes.length === 1 ? 0 : 0);
      nodes
        .slice()
        .sort((a, b) => compareClanMemberIds(a.id, b.id))
        .forEach((n, i) => {
          n.y = nodes.length === 1 ? y + pad + inner / 2 : y0 + i * step;
        });

      y += blockH + GROUP_GAP;
    });

    return y;
  };

  let maxY = 0;
  for (let c = 0; c <= maxCol; c++) {
    maxY = Math.max(maxY, layoutCol(c));
  }

  // 2) "가장 인원수가 많은(=세로 span이 가장 큰) 세대"의 가운데 선을 기준으로,
  // 다른 세대도 위/아래 균형 있게(센터 정렬) 이동
  const colSpans = [];
  for (let c = 0; c <= maxCol; c++) {
    const arr = byCol.get(c) || [];
    const ys = arr.map((n) => n.y).filter((y) => Number.isFinite(y));
    if (!ys.length) continue;
    const minY = Math.min(...ys);
    const maxYc = Math.max(...ys);
    colSpans.push({ c, minY, maxY: maxYc, span: maxYc - minY });
  }
  if (colSpans.length) {
    colSpans.sort((a, b) => b.span - a.span);
    const ref = colSpans[0];
    const refMid = (ref.minY + ref.maxY) / 2;

    colSpans.forEach((s) => {
      if (s.c === ref.c) return;
      const mid = (s.minY + s.maxY) / 2;
      const delta = refMid - mid;
      (byCol.get(s.c) || []).forEach((n) => {
        n.y += delta;
      });
    });

    // 화면 밖(위쪽)으로 밀리지 않도록 전체를 아래로 보정
    let globalMin = Infinity;
    let globalMax = -Infinity;
    for (let c = 0; c <= maxCol; c++) {
      (byCol.get(c) || []).forEach((n) => {
        if (!Number.isFinite(n.y)) return;
        globalMin = Math.min(globalMin, n.y);
        globalMax = Math.max(globalMax, n.y);
      });
    }
    const floorY = PAD_T + 34;
    if (globalMin < floorY) {
      const shift = floorY - globalMin;
      for (let c = 0; c <= maxCol; c++) {
        (byCol.get(c) || []).forEach((n) => {
          n.y += shift;
        });
      }
      globalMax += shift;
      globalMin = floorY;
    }
    maxY = Math.max(maxY, globalMax + GROUP_GAP);
  }

  const totalH = Math.max(220, maxY + PAD_T + 40);

  for (let c = 0; c <= maxCol; c++) {
    const cap = document.createElementNS("http://www.w3.org/2000/svg", "text");
    cap.setAttribute("x", String(colCenterX(c)));
    cap.setAttribute("y", String(PAD_T));
    cap.setAttribute("text-anchor", "middle");
    cap.setAttribute("font-size", String(FONT_CAP));
    cap.setAttribute("fill", "#a8a29e");
    cap.setAttribute("font-family", "Noto Sans KR, Pretendard, sans-serif");
    cap.textContent =
      c === 0
        ? anchorRole
          ? `기준 · ${anchorRole}`
          : "기준"
        : anchorGen != null
          ? `${Number(anchorGen) + c}세손`
          : `${c}열`;
    gNode.appendChild(cap);
  }

  byId.forEach((n) => {
    const te = document.createElementNS("http://www.w3.org/2000/svg", "text");
    // 이름은 좌측 정렬로 두어 "점-이름" 간격을 일정하게(긴 가로선처럼 보이는 효과 제거)
    te.setAttribute("x", String(n.x - n.w / 2));
    te.setAttribute("y", String(n.y));
    te.setAttribute("text-anchor", "start");
    te.setAttribute("dominant-baseline", "middle");
    te.setAttribute("font-size", String(n.id === effectiveAnchorId ? FONT_MAIN + 3 : FONT_MAIN));
    te.setAttribute("font-weight", n.id === effectiveAnchorId ? "700" : "500");
    te.setAttribute("fill", n.id === effectiveAnchorId ? "#166534" : "#1c1917");
    te.setAttribute("font-family", "Noto Sans KR, Pretendard, sans-serif");
    te.textContent = n.name;
    gNode.appendChild(te);
  });

  filtered.forEach((it, idx) => {
    const cid = String(
      pickFirstString(it, [
        "문중원ID",
        "문중원id",
        "clanMemberId",
        "memberId",
        "personId",
        "ID",
        "id",
      ]) || getClanMemberId(it, idx)
    ).trim();
    const fid = kinItemFatherId(it);
    if (!cid || !fid || !byId.has(cid) || !byId.has(fid)) return;
    // 그룹용: 부친->자녀 목록
  });

  const childrenByFather = new Map();
  byId.forEach((n) => {
    if (!n.fatherId) return;
    if (!byId.has(n.fatherId)) return;
    if (!childrenByFather.has(n.fatherId)) childrenByFather.set(n.fatherId, []);
    childrenByFather.get(n.fatherId).push(n);
  });

  // 같은 아버지의 자녀가 여럿이면: 버스(괄호 느낌)로 묶어 연결
  childrenByFather.forEach((kids, fid) => {
    const p = byId.get(fid);
    if (!p || !kids.length) return;
    kids.sort((a, b) => compareClanMemberIds(a.id, b.id));

    const minY = Math.min(...kids.map((k) => k.y));
    const maxY = Math.max(...kids.map((k) => k.y));
    const yMid = (minY + maxY) / 2;

    // "점(•)"은 한 x축에 정렬하고, 그 점들을 괄호 곡선으로 묶는다.
    // 점→이름 사이 선은 그리지 않아(가로선 제거) 공간을 넓게 쓴다.
    const xTextLeftMin = Math.min(...kids.map((k) => k.x - k.w / 2));
    const xDot = xTextLeftMin - 12;
    const padY = 10;
    const yTop = minY - padY;
    const yBot = maxY + padY;
    const bulge = 16;

    // 부친 → (자녀 점/괄호) 연결(부드러운 곡선)
    const xFrom = p.x + p.w / 2 + 6;
    const bend = Math.max(22, Math.min(72, (xDot - xFrom) * 0.55));
    const pathMain = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathMain.setAttribute(
      "d",
      `M${xFrom},${p.y} C${xFrom + bend},${p.y} ${xDot - bend},${yMid} ${xDot},${yMid}`
    );
    pathMain.setAttribute("fill", "none");
    pathMain.setAttribute("stroke", EIGHT_KIN_EDGE);
    pathMain.setAttribute("stroke-width", "1.1");
    pathMain.setAttribute("stroke-linecap", "round");
    pathMain.setAttribute("stroke-linejoin", "round");
    pathMain.setAttribute("opacity", "0.92");
    gEdge.appendChild(pathMain);

    // 점(•)들
    kids.forEach((ch) => {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(xDot));
      dot.setAttribute("cy", String(ch.y));
      dot.setAttribute("r", "1.8");
      dot.setAttribute("fill", EIGHT_KIN_EDGE);
      dot.setAttribute("opacity", "0.95");
      gEdge.appendChild(dot);
    });

    // 같은 자녀들의 점(•)을 수직선으로 연결(요청)
    if (kids.length >= 2) {
      const vline = document.createElementNS("http://www.w3.org/2000/svg", "path");
      vline.setAttribute("d", `M${xDot},${minY} L${xDot},${maxY}`);
      vline.setAttribute("fill", "none");
      vline.setAttribute("stroke", EIGHT_KIN_EDGE_SOFT);
      vline.setAttribute("stroke-width", "0.85");
      vline.setAttribute("stroke-linecap", "round");
      vline.setAttribute("opacity", "0.45");
      gEdge.appendChild(vline);
    }

    // 점 앞 괄호(세로로 길게 보이는 선)는 제거(A)
  });

  svg.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);
  view.appendChild(svg);
  box.appendChild(toolbar);
  box.appendChild(view);
  attachEightKinZoomBehavior(svg, gRoot, toolbar);
}

/**
 * 8촌 친척: 이름만(박스 없음) 세대별 층 + 연결선, d3.zoom으로 확대·축소·이동
 */
function mountEightKinTreeSvg(box, layers, opts = {}) {
  box.innerHTML = "";
  const W = 900;
  const padX = 36;
  const padY = 28;
  let y = padY;

  const toolbar = document.createElement("div");
  toolbar.className =
    "mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-stone-200/80 pb-2";
  toolbar.innerHTML = `
    <span class="text-[11px] text-stone-500">드래그·휠(또는 트랙패드)로 이동·확대</span>
    <span class="flex gap-1">
      <button type="button" class="eight-kin-z rounded border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium text-stone-700 hover:bg-stone-50" data-act="in" title="확대">＋</button>
      <button type="button" class="eight-kin-z rounded border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium text-stone-700 hover:bg-stone-50" data-act="out" title="축소">－</button>
      <button type="button" class="eight-kin-z rounded border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium text-stone-700 hover:bg-stone-50" data-act="reset" title="화면 맞춤">맞춤</button>
    </span>`;

  const view = document.createElement("div");
  view.className =
    "eight-kin-tree-view relative h-[min(72vh,560px)] w-full overflow-hidden rounded-xl border border-stone-200/90 bg-[#fafaf9]";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.cursor = "grab";
  svg.style.touchAction = "none";
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "8촌 친척 가계도");

  const gRoot = document.createElementNS("http://www.w3.org/2000/svg", "g");
  gRoot.setAttribute("class", "eight-kin-zoom-layer");
  const gEdge = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const gNode = document.createElementNS("http://www.w3.org/2000/svg", "g");
  gRoot.appendChild(gEdge);
  gRoot.appendChild(gNode);
  svg.appendChild(gRoot);

  const layerBoxes = [];

  layers.forEach((layer) => {
    if (layer.kind === "anchor") {
      const fs = 17;
      const baseline = y + fs;
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", String(W / 2));
      t.setAttribute("y", String(baseline));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("font-family", "Noto Sans KR, Pretendard, sans-serif");
      t.setAttribute("font-size", String(fs));
      t.setAttribute("font-weight", "700");
      t.setAttribute("fill", "#166534");
      t.textContent = layer.text;
      gNode.appendChild(t);
      if (layer.sub != null) {
        const cap = document.createElementNS("http://www.w3.org/2000/svg", "text");
        cap.setAttribute("x", String(W / 2));
        cap.setAttribute("y", String(baseline + 16));
        cap.setAttribute("text-anchor", "middle");
        cap.setAttribute("font-size", "10");
        cap.setAttribute("fill", "#78716c");
        cap.textContent = `${opts.anchorRole ? `${opts.anchorRole} · ` : ""}${layer.sub}세`;
        gNode.appendChild(cap);
        layerBoxes.push({
          cx: W / 2,
          yTop: y,
          yBottom: baseline + 20,
        });
        y = baseline + 36;
      } else {
        layerBoxes.push({ cx: W / 2, yTop: y, yBottom: baseline + 6 });
        y = baseline + 28;
      }
      return;
    }

    const fs = 12.5;
    const names = layer.names;
    const gap = 12;
    const widths = names.map((nm) =>
      Math.min(200, Math.max(36, nm.length * fs * 0.52 + 10))
    );
    const totalW = widths.reduce((acc, w, i) => acc + w + (i ? gap : 0), 0);
    let x = padX + (W - 2 * padX - totalW) / 2;
    if (totalW > W - 2 * padX) {
      x = padX;
    }

    const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    lbl.setAttribute("x", String(W / 2));
    lbl.setAttribute("y", String(y + 10));
    lbl.setAttribute("text-anchor", "middle");
    lbl.setAttribute("font-size", "9.5");
    lbl.setAttribute("fill", "#78716c");
    lbl.setAttribute("font-family", "Noto Sans KR, Pretendard, sans-serif");
    lbl.textContent = eightKinGenRowLabel(layer.key);
    gNode.appendChild(lbl);

    const baseline = y + 30;
    const centers = [];
    names.forEach((nm, j) => {
      const wj = widths[j];
      const cx = x + wj / 2;
      const te = document.createElementNS("http://www.w3.org/2000/svg", "text");
      te.setAttribute("x", String(cx));
      te.setAttribute("y", String(baseline));
      te.setAttribute("text-anchor", "middle");
      te.setAttribute("font-size", String(fs));
      te.setAttribute("font-family", "Noto Sans KR, Pretendard, sans-serif");
      te.setAttribute("fill", "#1c1917");
      te.textContent = nm;
      gNode.appendChild(te);
      centers.push(cx);
      x += wj + gap;
    });

    const cxRow =
      centers.length > 0 ? centers.reduce((a, b) => a + b, 0) / centers.length : W / 2;
    layerBoxes.push({
      cx: cxRow,
      yTop: y + 12,
      yBottom: baseline + 10,
    });
    y = baseline + 28;
  });

  const H = Math.max(y + padY, 160);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  for (let i = 0; i < layerBoxes.length - 1; i++) {
    const A = layerBoxes[i];
    const B = layerBoxes[i + 1];
    const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
    ln.setAttribute("x1", String(A.cx));
    ln.setAttribute("y1", String(A.yBottom));
    ln.setAttribute("x2", String(B.cx));
    ln.setAttribute("y2", String(B.yTop));
    ln.setAttribute("stroke", EIGHT_KIN_EDGE_SOFT);
    ln.setAttribute("stroke-width", "1.25");
    ln.setAttribute("stroke-linecap", "round");
    gEdge.appendChild(ln);
  }

  view.appendChild(svg);
  box.appendChild(toolbar);
  box.appendChild(view);

  attachEightKinZoomBehavior(svg, gRoot, toolbar);
}

function renderSelectedPersonBody(mergedRow, clanMemberId) {
  const body = document.getElementById("selected-person-body");
  if (!body) return;

  if (!mergedRow || typeof mergedRow !== "object") {
    body.innerHTML = `<p class="text-stone-600">상세 API(<code class="text-xs">action=person</code>)를 불러오지 못했습니다. 검색 요약만 사용할 수 있습니다.</p><p class="mt-2 font-mono text-xs text-stone-500">문중원ID: ${escapeHtml(clanMemberId)}</p>`;
    return;
  }

  const name = pickFirstString(mergedRow, NAME_KEYS) || "이름 미상";
  const sesong = formatSesongLine(mergedRow);
  const father = pickFirstString(mergedRow, PARENT_NAME_KEYS) || "";
  const fatherId = pickFirstString(mergedRow, PARENT_ID_KEYS) || "";
  // 모친: "그 인물의 부(아버지의ID)의 배우자"를 뜻함(요청)
  const fallbackMother =
    pickFirstString(mergedRow, [
      "어머니 성함",
      "어머니이름",
      "어머니",
      "모친",
      "모",
      "motherName",
      "mother",
      "Mother",
    ]) || "";
  const mother = fatherId ? "불러오는 중…" : fallbackMother || "기록 없음";

  const spouse =
    pickFirstString(mergedRow, ["배우자", "spouse", "spouseName", "配偶者"]) ||
    "";

  const rawChildren =
    mergedRow["자녀"] ?? mergedRow.children ?? mergedRow.Children ?? "";
  const rawOeson =
    mergedRow["외손"] ??
    mergedRow["외손자"] ??
    mergedRow["외손녀"] ??
    mergedRow["외손들"] ??
    mergedRow["외손목록"] ??
    "";

  const childrenList = splitPeopleList(
    mergedRow["자녀"] ?? mergedRow.children ?? mergedRow.Children
  );
  const oesonList = splitPeopleList(
    mergedRow["외손"] ??
      mergedRow["외손자"] ??
      mergedRow["외손녀"] ??
      mergedRow["외손들"] ??
      mergedRow["외손목록"]
  );
  const siblingList = splitPeopleList(
    mergedRow["형제"] ?? mergedRow.siblings ?? mergedRow.Siblings
  );

  const fatherDisp = father || (fatherId ? `문중원ID ${fatherId}` : "기록 없음");

  const chip = (label) =>
    `<span class="inline-block max-w-[8rem] truncate rounded-md border border-stone-200 bg-white px-1.5 py-0.5 text-center text-[11px] font-medium text-ink-800">${label}</span>`;

  const siblingChips =
    siblingList.length > 0
      ? siblingList.map((n) => chip(escapeHtml(n))).join("")
      : "";

  const childChips = (arr) =>
    arr.length > 0 ? arr.map((n) => chip(escapeHtml(n))).join("") : "";

  const limitList = (arr, max) => {
    const list = Array.isArray(arr) ? arr : [];
    if (list.length <= max) return { shown: list, more: 0 };
    return { shown: list.slice(0, max), more: list.length - max };
  };
  const limitedChildren = limitList(childrenList, 8);

  /** 형제(왼쪽 칩) → 본인·배우자(가운데): 시트에 적힌 순서대로 */
  const middleRow = `
    <div class="flex flex-wrap items-end justify-center gap-x-2 gap-y-2">
      ${
        siblingChips
          ? `<div class="flex max-w-full flex-col items-center justify-center gap-1">
              <div class="text-[10px] font-medium text-stone-500">형제·자매</div>
              <div class="flex max-w-full flex-wrap items-center justify-center gap-1">${siblingChips}</div>
            </div>`
          : ""
      }
      <div class="flex flex-wrap items-end justify-center gap-2">
        <div class="min-w-[5.5rem] rounded-xl border-2 border-seal/45 bg-seal/5 px-3 py-2 text-center shadow-sm">
          <div class="text-[10px] font-semibold uppercase tracking-wide text-seal">본인</div>
          <div class="mt-0.5 break-words text-sm font-bold leading-snug text-ink-900">${escapeHtml(name)}</div>
          ${sesong ? `<div class="mt-1 text-[10px] leading-tight text-stone-600">${escapeHtml(sesong)}</div>` : ""}
        </div>
        <div class="min-w-[4.5rem] rounded-xl border border-stone-200 bg-white px-2 py-2 text-center">
          <div class="text-[10px] font-medium text-stone-500">배우자</div>
          <div class="mt-0.5 break-words text-xs font-semibold text-ink-800">${spouse ? escapeHtml(spouse) : '<span class="font-normal text-stone-400">기록 없음</span>'}</div>
        </div>
      </div>
    </div>
  `;

  const childrenBlock =
    childrenList.length || oesonList.length
      ? `
    <div class="mt-1 flex flex-col items-center gap-2">
      <div class="h-3 w-px bg-stone-300" aria-hidden="true"></div>
      <div class="w-full rounded-xl border border-stone-200/90 bg-stone-50/80 px-2 py-2">
        ${
          childrenList.length
            ? `<p class="mb-1.5 text-center text-[10px] font-medium text-stone-500">자녀</p>
               <div class="flex flex-wrap justify-center gap-1">${childChips(limitedChildren.shown)}</div>
               ${limitedChildren.more ? `<p class="mt-1 text-center text-[10px] text-stone-500">외 ${limitedChildren.more}명</p>` : ""}`
            : ""
        }
        ${childrenList.length && oesonList.length ? `<div class="my-2 h-px w-full bg-stone-200/90" aria-hidden="true"></div>` : ""}
        ${oesonList.length ? `<p class="mb-1.5 text-center text-[10px] font-medium text-stone-500">외손</p><div class="flex flex-wrap justify-center gap-1">${childChips(oesonList)}</div>` : ""}
      </div>
    </div>
  `
      : "";

  body.innerHTML = `
    <div class="family-tree-mini space-y-2 text-stone-800">
      <p class="sr-only">부모, 형제·자매, 본인·배우자, 자녀 순으로 표시한 가계도 요약입니다.</p>

      <div class="flex flex-col items-center gap-0">
        <div class="flex w-full max-w-md items-stretch justify-center gap-3 sm:gap-4">
          <div class="flex min-h-[3.25rem] flex-1 flex-col items-center justify-center rounded-xl border border-stone-200 bg-stone-50/90 px-2 py-2 text-center">
            <span class="text-[10px] font-medium uppercase tracking-wide text-stone-500">부친</span>
            <span class="mt-0.5 break-words text-xs font-semibold text-ink-900">${escapeHtml(fatherDisp)}</span>
          </div>
          <div class="flex min-h-[3.25rem] flex-1 flex-col items-center justify-center rounded-xl border border-stone-200 bg-stone-50/90 px-2 py-2 text-center">
            <span class="text-[10px] font-medium uppercase tracking-wide text-stone-500">모친</span>
            <span id="selected-person-mother-val" class="mt-0.5 break-words text-xs font-semibold text-ink-900">${escapeHtml(mother)}</span>
          </div>
        </div>
        <div class="flex h-4 flex-col items-center justify-start" aria-hidden="true">
          <div class="h-4 w-px bg-stone-300"></div>
        </div>
      </div>

      ${middleRow}

      ${childrenBlock}
    </div>
  `;

  // 부친ID가 있으면: 부친 상세(action=person)에서 배우자(배우자/配偶者 등)를 가져와 모친으로 표시
  if (fatherId) {
    (async () => {
      const target = document.getElementById("selected-person-mother-val");
      if (!target) return;
      try {
        const pj = await apiGetSilent({ action: "person", id: fatherId });
        const p = normalizePersonPayload(pj) || pj;
        const sp =
          pickFirstString(p, ["배우자", "spouse", "spouseName", "配偶者"]) ||
          pickFirstString(p, ["배우자명", "배우자이름", "spouse_name"]) ||
          "";
        const disp = sp ? String(sp).trim() : fallbackMother || "기록 없음";
        target.textContent = disp;
      } catch {
        target.textContent = fallbackMother || "기록 없음";
      }
    })();
  }
}

function renderEightKinListHome(list) {
  const hintEl = document.getElementById("eight-kin-hint-home");
  const listEl = document.getElementById("eight-kin-list-home");
  if (listEl) listEl.innerHTML = "";
  if (!list.length) {
    if (hintEl) {
      hintEl.textContent =
        "8촌 친척 목록이 없습니다. 서버에 action=eightKin&id=문중원ID 를 구현하면 표시됩니다.";
    }
    return;
  }
  if (hintEl) {
    hintEl.textContent = "서버에서 받은 8촌 친척 관계 목록입니다.";
  }
  if (!listEl) return;
  list.forEach((item) => {
    const name = String(item.name ?? item.이름 ?? item.label ?? "?");
    const rel = eightKinItemRelation(item);
    const li = document.createElement("li");
    li.className =
      "rounded-lg border border-stone-100 bg-stone-50/80 px-3 py-2";
    li.innerHTML = `<span class="font-medium text-ink-900">${escapeHtml(name)}</span>${rel ? ` <span class="text-stone-600">· ${escapeHtml(rel)}</span>` : ""}`;
    listEl.appendChild(li);
  });
}

async function renderEightKinBox(eightJson, paternalChainOpt) {
  const box = document.getElementById("eight-kin-box");
  const hintEl = document.getElementById("eight-kin-hint-home");
  if (!box) return;

  let paternalChain = paternalChainOpt;
  if ((!paternalChain || !paternalChain.length) && selectedPersonId) {
    paternalChain = await buildFatherChainFromId(selectedPersonId, 24);
  }

  const list = normalizeEightKinList(eightJson);
  box.innerHTML = "";

  const anchorInfo = eightKinAnchorFromPaternalChain(paternalChain || []);
  const anchorGen = anchorInfo ? readNodeGenLike(anchorInfo.person) : null;
  const anchorName = anchorInfo
    ? pickFirstString(anchorInfo.person, NAME_KEYS) || "이름 미상"
    : "";
  const anchorId = anchorInfo
    ? String(
        pickFirstString(anchorInfo.person, [
          "문중원ID",
          "문중원id",
          "clanMemberId",
          "memberId",
          "personId",
          "ID",
          "id",
        ]) ||
          // person payload에 id 키가 없을 때: 검색 결과/캐시 방식과 맞추기 위해 fallback
          getClanMemberId(anchorInfo.person, anchorInfo.index || 0) ||
          ""
      ).trim()
    : "";

  if (!list.length) {
    if (hintEl) {
      hintEl.textContent =
        "8촌 친척 데이터가 비어 있습니다. 서버에 action=eightKin&id=문중원ID 를 구현하면 표시됩니다.";
    }
    if (anchorInfo) {
      mountEightKinHorizontalTreeSvg(box, {
        filtered: [],
        anchorInfo,
        anchorName,
        anchorGen,
        anchorId,
        anchorRole: anchorInfo.role || "",
      });
    }
    return;
  }

  // (홈 박스 설명과 중복되는 긴 안내문은 제거) — 여기서는 결과 요약만 표시
  if (hintEl) hintEl.textContent = "";

  let excludedAbove = 0;
  const baseFiltered = list.filter((it, idx) => {
    const id = String(
      pickFirstString(it, [
        "문중원ID",
        "문중원id",
        "clanMemberId",
        "memberId",
        "personId",
        "ID",
        "id",
      ]) || getClanMemberId(it, idx)
    ).trim();
    if (anchorId && id && id === anchorId) return false;

    const g = kinItemGenNum(it);
    if (anchorGen == null) return true;
    if (g == null) return true;
    if (g < anchorGen) {
      excludedAbove += 1;
      return false;
    }
    return true;
  });

  // 고조부(기점) 직계 후손만: fatherId 체인이 기점(anchorId)로 올라가는 경우만 포함
  const idToFather = new Map();
  baseFiltered.forEach((it, idx) => {
    const id = String(
      pickFirstString(it, [
        "문중원ID",
        "문중원id",
        "clanMemberId",
        "memberId",
        "personId",
        "ID",
        "id",
      ]) || getClanMemberId(it, idx)
    ).trim();
    if (!id || id.startsWith("idx_")) return;
    const fid = kinItemFatherId(it);
    if (fid) {
      const fs = String(fid).trim();
      idToFather.set(id, fs);
      eightKinFatherIdCache.set(id, fs);
    }
  });

  // 부친ID가 하나도 없으면: person API로 부친ID를 먼저 보강해야 선/직계필터가 가능함
  if (idToFather.size === 0) {
    const ids = baseFiltered.map((it, idx) =>
      String(
        pickFirstString(it, [
          "문중원ID",
          "문중원id",
          "clanMemberId",
          "memberId",
          "personId",
          "ID",
          "id",
        ]) || getClanMemberId(it, idx)
      ).trim()
    );
    await hydrateFatherIdsForEightKin(ids, { concurrency: 12 });
    ids.forEach((id) => {
      const fid = eightKinFatherIdCache.get(String(id));
      if (fid) idToFather.set(String(id), String(fid));
    });
  }

  // 직계(고조부) 후손만을 "반드시" 정리: 부족한 fatherId는 person API로 보강해서 체인을 확정한다.
  const resolveFatherId = async (id) => {
    const key = String(id || "").trim();
    if (!key) return "";
    if (idToFather.has(key)) return idToFather.get(key);
    if (eightKinFatherIdCache.has(key)) return eightKinFatherIdCache.get(key);
    const p = await getPersonByIdForAncestorChain(key);
    const fid = p ? pickFirstString(p, PARENT_ID_KEYS) : "";
    const out = fid ? String(fid).trim() : "";
    if (out) {
      idToFather.set(key, out);
      eightKinFatherIdCache.set(key, out);
    }
    return out;
  };

  const reachesAnchor = async (id) => {
    if (!anchorId) return false;
    let cur = String(id || "").trim();
    const seen = new Set();
    let steps = 0;
    while (cur && !seen.has(cur) && steps < 12) {
      seen.add(cur);
      const f = await resolveFatherId(cur);
      if (!f) return false;
      if (String(f) === String(anchorId)) return true;
      cur = String(f);
      steps += 1;
    }
    return false;
  };

  let excludedCollateral = 0;
  const filtered = [];
  // 병렬 제한(너무 많은 API 호출 방지)
  const limit = 8;
  let cursor = 0;
  const runWorker = async () => {
    while (cursor < baseFiltered.length) {
      const idx = cursor++;
      const it = baseFiltered[idx];
      const id = String(
        pickFirstString(it, [
          "문중원ID",
          "문중원id",
          "clanMemberId",
          "memberId",
          "personId",
          "ID",
          "id",
        ]) || getClanMemberId(it, idx)
      ).trim();
      if (!id || id.startsWith("idx_")) {
        excludedCollateral += 1;
        continue;
      }
      try {
        const ok = await reachesAnchor(id);
        if (ok) filtered.push(it);
        else excludedCollateral += 1;
      } catch {
        excludedCollateral += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => runWorker()));

  if (hintEl) {
    const parts = [];
    if (anchorInfo) parts.push(`기준: ${anchorName} (${anchorInfo.role})`);
    if (excludedAbove > 0) parts.push(`윗세대 제외 ${excludedAbove}명`);
    if (excludedCollateral > 0) parts.push(`방계 제외 ${excludedCollateral}명`);
    if (parts.length) hintEl.textContent = parts.join(" · ");
  }

  const groups = new Map();
  filtered.forEach((it) => {
    const gen =
      it.gen ??
      it.세손 ??
      it.generation ??
      it.세대 ??
      it.세 ??
      "";
    const genKey = gen === "" || gen == null ? "미상" : String(gen).replace(/\s+/g, "");
    if (!groups.has(genKey)) groups.set(genKey, []);
    groups.get(genKey).push(it);
  });

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "미상") return 1;
    if (b === "미상") return -1;
    const na = Number(a);
    const nb = Number(b);
    const aNum = !Number.isNaN(na);
    const bNum = !Number.isNaN(nb);
    if (aNum && bNum) return na - nb;
    if (aNum) return -1;
    if (bNum) return 1;
    return a.localeCompare(b);
  });

  mountEightKinHorizontalTreeSvg(box, {
    filtered,
    anchorInfo,
    anchorName,
    anchorGen,
    anchorId,
    anchorRole: anchorInfo?.role || "",
    fatherMap: idToFather,
  });
}

function renderEightKinTreePlaceholder(eightList) {
  const svgEl = document.getElementById("eight-kin-svg");
  if (!svgEl || typeof d3 === "undefined") return;
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  const msg =
    eightList && eightList.length
      ? `관계 ${eightList.length}건 수신됨 — D3 그래프는 스키마 확정 후 연결`
      : "문중원을 선택하면 eightKin 결과를 이곳에 시각화합니다.";
  svg
    .append("text")
    .attr("x", "50%")
    .attr("y", "50%")
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .attr("fill", "#78716c")
    .attr("font-size", 12)
    .text(msg);
}

/* ---------- 8촌 관계도(D3) ---------- */

function normalizeEightKinGraph(json) {
  if (!json || typeof json !== "object") return null;
  // 1) { nodes:[], links:[] } 형태
  const nodes = normalizeList(json, ["nodes", "people", "members", "data"]);
  const links = normalizeList(json, ["links", "edges", "relations"]);
  if (nodes.length && links.length) {
    const ns = nodes
      .map((n, i) => ({
        id: String(n.id ?? n.ID ?? n.personId ?? getClanMemberId(n, i)),
        name: String(n.name ?? n.이름 ?? n.label ?? n.title ?? "?"),
      }))
      .filter((n) => n.id);
    const idSet = new Set(ns.map((n) => n.id));
    const ls = links
      .map((l) => ({
        source: String(l.source ?? l.from ?? l.fromId ?? l.id1 ?? ""),
        target: String(l.target ?? l.to ?? l.toId ?? l.id2 ?? ""),
        label: String(l.label ?? l.relation ?? l.관계 ?? ""),
      }))
      .filter((l) => idSet.has(l.source) && idSet.has(l.target));
    if (ns.length && ls.length) return { type: "force", nodes: ns, links: ls };
  }

  // 2) 리스트만 있고 각 항목에 from/to가 있는 relations
  const rels = normalizeList(json, ["relations", "eightKin", "kin", "list", "items"]);
  const maybeFromTo = rels.some((r) => r && (r.fromId || r.toId || r.id1 || r.id2));
  if (rels.length && maybeFromTo) {
    const nsMap = new Map();
    const ls = [];
    rels.forEach((r) => {
      if (!r || typeof r !== "object") return;
      const a = String(r.fromId ?? r.id1 ?? "").trim();
      const b = String(r.toId ?? r.id2 ?? "").trim();
      if (!a || !b) return;
      const an = String(r.fromName ?? r.name1 ?? "").trim();
      const bn = String(r.toName ?? r.name2 ?? r.name ?? r.이름 ?? "").trim();
      if (!nsMap.has(a)) nsMap.set(a, { id: a, name: an || a });
      if (!nsMap.has(b)) nsMap.set(b, { id: b, name: bn || b });
      ls.push({
        source: a,
        target: b,
        label: String(r.relation ?? r.관계 ?? r.label ?? ""),
      });
    });
    const ns = [...nsMap.values()];
    if (ns.length && ls.length) return { type: "force", nodes: ns, links: ls };
  }

  // 3) { id, parentId } 표 트리 형태
  const flat = normalizeList(json, ["rows", "nodes", "data", "items", "list"]);
  const haveParent = flat.some((r) => r && (r.parentId || r.fatherId || r["아버지의ID"]));
  if (flat.length && haveParent) {
    const rows = [];
    flat.forEach((r, i) => {
      if (!r || typeof r !== "object") return;
      const id = String(r.id ?? r.ID ?? getClanMemberId(r, i)).trim();
      if (!id) return;
      const p = String(r.parentId ?? r.fatherId ?? r["아버지의ID"] ?? "").trim();
      const name = String(r.name ?? r.이름 ?? r.label ?? id).trim();
      rows.push({ id, parentId: p || "", name, row: r });
    });
    if (rows.length) return { type: "tree", rows };
  }

  return null;
}

function renderEightKinTree(eightJson) {
  const svgEl = document.getElementById("eight-kin-svg");
  const wrap = document.getElementById("eight-kin-svg-wrap");
  if (!svgEl || !wrap || typeof d3 === "undefined") return;
  try {
    delete svgEl.__treeZoom;
  } catch {
    // ignore
  }
  const svg = d3.select(svgEl);
  svg.on(".zoom", null);
  svg.selectAll("*").remove();

  const g = normalizeEightKinGraph(eightJson);
  if (!g) {
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 12)
      .text("8촌 관계도를 그릴 데이터 형식을 찾지 못했습니다.");
    return;
  }

  if (g.type === "tree") {
    // 가장 id가 selectedPersonId인 노드를 루트로 잡되, 없으면 첫 노드를 루트
    const rootId = selectedPersonId && g.rows.some((r) => r.id === selectedPersonId)
      ? selectedPersonId
      : g.rows[0].id;
    const stratRows = g.rows.map((r) => ({
      ...r,
      parentId: r.id === rootId ? "" : r.parentId || "",
    }));
    let root;
    try {
      root = d3
        .stratify()
        .id((d) => d.id)
        .parentId((d) => d.parentId || "")(stratRows);
    } catch {
      // fallback to force
      return;
    }
    paintD3TreeLayout(root, rootId, wrap, svgEl, false);
    return;
  }

  // force graph
  const width = wrap.clientWidth || 320;
  const height = wrap.clientHeight || 220;
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  const gRoot = svg.append("g");

  const zoom = d3.zoom().scaleExtent([0.5, 3]).on("zoom", (event) => {
    gRoot.attr("transform", event.transform);
  });
  svg.call(zoom);

  const link = gRoot
    .append("g")
    .attr("stroke", EIGHT_KIN_EDGE_SOFT)
    .attr("stroke-width", 1.5)
    .selectAll("line")
    .data(g.links)
    .join("line");

  const node = gRoot
    .append("g")
    .selectAll("g")
    .data(g.nodes)
    .join("g")
    .call(
      d3
        .drag()
        .on("start", (event, d) => {
          if (!event.active) sim.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event, d) => {
          if (!event.active) sim.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
    );

  node
    .append("circle")
    .attr("r", 16)
    .attr("fill", (d) => (String(d.id) === String(selectedPersonId) ? "#166534" : "#fff"))
    .attr("stroke", (d) => (String(d.id) === String(selectedPersonId) ? "#166534" : "#e7e5e4"))
    .attr("stroke-width", 2);

  node
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em")
    .attr("font-size", 11)
    .attr("fill", (d) => (String(d.id) === String(selectedPersonId) ? "#fff" : "#292524"))
    .text((d) => {
      const t = String(d.name || "").trim();
      return t.length > 4 ? `${t.slice(0, 4)}…` : t;
    });

  const sim = d3
    .forceSimulation(g.nodes)
    .force(
      "link",
      d3.forceLink(g.links).id((d) => d.id).distance(90)
    )
    .force("charge", d3.forceManyBody().strength(-240))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide(28));

  sim.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  attachTreeZoomState(svgEl, zoom, d3.zoomIdentity);
}

/**
 * 문중원ID 기준 상세: person + eightKin API, 홈 패널·가계도 카드 갱신
 */
async function selectPerson(clanMemberId) {
  const panel = document.getElementById("selected-person-panel");
  const badge = document.getElementById("selected-person-id-badge");
  if (!clanMemberId || !panel) return;

  selectedPersonId = clanMemberId;
  saveSelectedPersonIdToStorage(clanMemberId);
  panel.classList.remove("hidden");
  if (badge) badge.textContent = `문중원ID ${clanMemberId}`;

  const body = document.getElementById("selected-person-body");
  if (body) {
    body.innerHTML =
      '<p class="animate-pulse text-stone-500">상세 정보를 불러오는 중…</p>';
  }
  const hintHome = document.getElementById("eight-kin-hint-home");
  if (hintHome) hintHome.textContent = "불러오는 중…";
  const listHomeClear = document.getElementById("eight-kin-list-home");
  if (listHomeClear) listHomeClear.innerHTML = "";

  const [personJson, eightJson] = await Promise.all([
    (async () => {
      const a = await apiGetSilent({ action: "person", id: clanMemberId });
      const p = normalizePersonPayload(a);
      if (p) return a;
      return apiGetSilent({ action: "person", 문중원ID: clanMemberId });
    })(),
    apiGetSilent({ action: "eightKin", id: clanMemberId }),
  ]);
  debugLog("person json", personJson);
  debugLog("eightKin json", eightJson);

  const apiPerson = normalizePersonPayload(personJson);
  const items = annotatePeople(lastSearchRows);
  const rowMatch = items.find((x) => x.id === clanMemberId);
  const merged =
    apiPerson && rowMatch?.row
      ? { ...rowMatch.row, ...apiPerson }
      : apiPerson ?? rowMatch?.row ?? null;

  lastPersonDetail = merged;
  if (merged && typeof merged === "object") {
    personByIdCache.set(String(clanMemberId), merged);
  }
  renderSelectedPersonBody(merged, clanMemberId);

  // 선택된 기준 인물 패널은 즉시 먼저 뜨게 하고,
  // 8촌 렌더(특히 직계필터/부친 보강)는 다음 틱에 돌려 UI 체감 지연을 줄인다.
  const thisPickId = String(clanMemberId);
  try {
    setTimeout(() => {
      void (async () => {
        if (String(selectedPersonId || "") !== thisPickId) return;
        const eightList = normalizeEightKinList(eightJson);
        renderEightKinListHome(eightList);
        // 고조부 앵커 체인(8대) 조회와 D3 관계도 렌더를 겹쳐 실행해 체감 대기 단축
        const anchorChainP = buildFatherChainFromId(thisPickId, 8);
        renderEightKinTree(eightJson);
        const anchorChain = await anchorChainP;
        if (String(selectedPersonId || "") !== thisPickId) return;
        await renderEightKinBox(eightJson, anchorChain);
        debugLog("eightKin list normalized (first 5)", eightList.slice(0, 5));
      })();
    }, 0);
  } catch {
    const eightList = normalizeEightKinList(eightJson);
    renderEightKinListHome(eightList);
    const anchorChainP = buildFatherChainFromId(thisPickId, 8);
    renderEightKinTree(eightJson);
    const anchorChain = await anchorChainP;
    await renderEightKinBox(eightJson, anchorChain);
    debugLog("eightKin list normalized (first 5)", eightList.slice(0, 5));
  }

  // 카드에서 부친을 "불러오는 중…"으로 남기지 않도록: 선택 시에만 person API로 보강
  // 부친 성함이 없고 부친 ID만 있는 경우: 부친 person API로 성함 보강(패널/가계도 카드에 반영)
  if (merged && typeof merged === "object") {
    const fName = pickFirstString(merged, PARENT_NAME_KEYS);
    const fId = pickFirstString(merged, PARENT_ID_KEYS);
    if (!fName && fId) {
      // 본인 확인 체감 우선: 부친 성함 보강은 백그라운드로 처리
      void (async () => {
        const p = await getPersonById(fId);
        const nm = p ? pickFirstString(p, NAME_KEYS) : "";
        if (!nm) return;
        // 선택 인물이 바뀌었으면 중단
        if (String(selectedPersonId || "") !== String(clanMemberId || "")) return;
        // 로컬 표준 키로 주입
        merged["아버지 성함"] = nm;
        lastPersonDetail = merged;
        renderSelectedPersonBody(merged, clanMemberId);
        updateTreeDetailCard(clanMemberId);
        // 검색 결과 카드의 부친 표시도 함께 갱신
        const card = document.querySelector(
          `.search-result-card[data-person-id="${CSS.escape(String(clanMemberId))}"]`
        );
        const el = card?.querySelector(".father-name");
        if (el) el.textContent = nm;
      })();
    }
  }

  const sel = document.getElementById("tree-person-select");
  if (sel && [...sel.options].some((o) => o.value === clanMemberId)) {
    sel.value = clanMemberId;
  }
  updateTreeDetailCard(clanMemberId);
}

/**
 * @param {Record<string, string|number>} params
 * @param {{ maxAttempts?: number, onRetry?: (n:number,max:number)=>void }} opts
 */
async function apiGet(params, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 8;
  const delayMs = 1500;
  const url = new URL(API_BASE);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });
  const urlStr = url.toString();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      if (opts.onRetry) opts.onRetry(attempt + 1, maxAttempts);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 12000;
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(urlStr, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    }).finally(() => clearTimeout(t));
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        "서버 응답이 JSON이 아닙니다. Apps Script에서 JSON으로 반환하는지 확인하세요."
      );
    }
    if (!res.ok) {
      const msg = json?.message || json?.error || res.statusText;
      throw new Error(msg || `요청 실패 (${res.status})`);
    }
    if (!isRunningOnlyResponse(json)) return json;
  }

  throw new Error(
    "서버가 계속 준비 중(status: running)만 반환합니다. Apps Script를 새 버전으로 배포했는지, doGet에서 해당 action 분기와 JSON 반환을 확인해 주세요."
  );
}

/** 보조 API — 실패·running 시 null (알림·지도·역사) */
async function apiGetSilent(params, opts = {}) {
  const url = new URL(API_BASE);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });
  const urlStr = url.toString();
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1200;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      const controller = new AbortController();
      const timeoutMs = 12000;
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(urlStr, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      }).finally(() => clearTimeout(t));
      const text = await res.text();
      const json = JSON.parse(text);
      if (!res.ok) return null;
      if (!isRunningOnlyResponse(json)) return json;
    } catch {
      return null;
    }
  }
  return null;
}

/** running 응답을 기다리며 재시도(아천문중 콘텐츠용) */
async function apiGetWait(params, ui = {}) {
  const maxAttempts = ui.maxAttempts ?? 10;
  const retryDelayMs = ui.retryDelayMs ?? 1200;
  const onRetry = ui.onRetry ?? null;
  return apiGet(params, {
    maxAttempts,
    retryDelayMs,
    onRetry: onRetry
      ? onRetry
      : (n, max) => {
          const el = ui.hintEl;
          if (el) el.textContent = `서버 준비 중… (${n}/${max})`;
        },
  });
}

async function fetchSebo(name) {
  return apiGet(
    { action: "search", name: name.trim() },
    {
      maxAttempts: 8,
      onRetry: (n, max) => showStatus(`서버 준비 중… (${n}/${max})`),
    }
  );
}

function normalizeList(data, keys) {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === "object") {
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}

function normalizeMapPoints(data) {
  const raw = normalizeList(data, [
    "movements",
    "points",
    "markers",
    "sites",
    "data",
    "items",
    "results",
  ]);
  return raw.map(normalizeOneMapPoint).filter(Boolean);
}

function normalizeOneMapPoint(p) {
  if (!p || typeof p !== "object") return null;
  const lat = Number(p.lat ?? p.latitude ?? p.Lat);
  const lng = Number(p.lng ?? p.lon ?? p.longitude ?? p.Lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return {
    lat,
    lng,
    name: String(p.name ?? p.title ?? p.label ?? "유적지"),
    desc: String(p.loc ?? p.location ?? p.desc ?? p.description ?? p.memo ?? ""),
  };
}

function renderClanNotices(data) {
  const list = document.getElementById("clan-notice-list");
  const hint = document.getElementById("clan-notice-hint");
  if (!list) return;

  const items = normalizeList(data, ["notices", "data", "items", "list"]);
  if (hint) {
    hint.textContent = items.length
      ? "API action=notices"
      : "API에 notices가 없으면 아래는 비어 있습니다.";
  }
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML =
      '<li class="more-bento-empty text-sm">등록된 공지가 없습니다.</li>';
    return;
  }

  const pickAnyField = (obj, excludeKeys = new Set()) => {
    if (!obj || typeof obj !== "object") return "";
    for (const [k, v] of Object.entries(obj)) {
      if (excludeKeys.has(k)) continue;
      const s = String(v ?? "").trim();
      if (s) return s;
    }
    return "";
  };

  items.slice(0, 10).forEach((n) => {
    const li = document.createElement("li");
    li.className = "more-bento-notice-item text-left";
    const title =
      String(
        n.title ??
          n.subject ??
          n.heading ??
          n.제목 ??
          n["공지 제목"] ??
          n["제목(제목)"] ??
          ""
      ).trim() || pickAnyField(n, new Set(["date", "작성일", "등록일", "일자"])) || "제목 없음";
    const date = String(
      n.date ??
        n.writtenAt ??
        n.createdAt ??
        n.날자 ??
        n.작성일 ??
        n.등록일 ??
        n.일자 ??
        n.날짜 ??
        ""
    ).trim();
    const sum = String(
      n.summary ?? n.content ?? n.body ?? n.내용 ?? n.본문 ?? n.memo ?? ""
    )
      .trim()
      .slice(0, 160);
    const author = String(n.author ?? n.writer ?? n.작성자 ?? n.담당 ?? "").trim();
    li.innerHTML = `
      <div class="font-medium text-ink-900">${escapeHtml(title)}</div>
      <div class="mt-0.5 text-xs text-stone-500">${escapeHtml(date)}${author ? ` · ${escapeHtml(author)}` : ""}</div>
      ${sum ? `<div class="mt-1 text-xs text-stone-600">${escapeHtml(sum)}${sum.length >= 160 ? "…" : ""}</div>` : ""}
    `;
    list.appendChild(li);
  });
}

/** 아천문중 탭: 공지 + 역사 + 투표 */
async function loadClanTab() {
  // 정관(로컬 md) + 재산(property 시트) + 공지(notice 시트) + 투표응답(voteRespone 시트)
  await Promise.all([loadCharterMarkdown(), loadPropertySheet(), loadNoticesSheet(), loadVoteResponseSheet()]);
  // 연혁은 기존 history를 유지(있으면 표시)
  try {
    const histJson = await apiGetSilent({ action: "history", limit: "20" });
    renderMoreHistory(histJson);
  } catch {
    // ignore
  }
}

function renderHomeNotices(data) {
  if (!homeNoticeListEl) return;
  const items = normalizeList(data, ["notices", "data", "items", "list"]);
  homeNoticeListEl.innerHTML = "";
  if (homeNoticeHintEl) {
    homeNoticeHintEl.textContent = items.length
      ? "최신 공지 3건"
      : "공지사항이 없습니다.";
  }
  if (!items.length) return;

  const firstDate = String(items[0]?.date ?? items[0]?.writtenAt ?? items[0]?.createdAt ?? "").trim();
  if (sheetUpdateStampEl && firstDate) sheetUpdateStampEl.textContent = firstDate;

  items.slice(0, 3).forEach((n) => {
    const li = document.createElement("li");
    li.className =
      "rounded-xl border border-stone-200 bg-white/70 px-3 py-2.5";
    const title = String(n.title ?? n.subject ?? n.heading ?? "제목 없음");
    const date = String(n.date ?? n.writtenAt ?? n.createdAt ?? "");
    li.innerHTML = `
      <div class="font-medium text-ink-900">${escapeHtml(title)}</div>
      ${date ? `<div class="mt-0.5 text-xs text-stone-500">${escapeHtml(date)}</div>` : ""}
    `;
    homeNoticeListEl.appendChild(li);
  });
}

async function loadHomeNotices() {
  // 시트명: notice (권장 action=notice). 기존 호환: notices
  let json = null;
  try {
    json = await apiGetSilent({ action: "notice", limit: "3" });
  } catch {
    // ignore
  }
  if (!json) {
    try {
      json = await apiGetSilent({ action: "notices", limit: "3" });
    } catch {
      json = null;
    }
  }
  if (json) renderHomeNotices(json);
}

async function apiPostForm(params) {
  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") body.set(k, String(v));
  });
  const res = await fetch(API_BASE, {
    method: "POST",
    body,
    redirect: "follow",
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, message: text.slice(0, 200) };
  }
  return { ok: res.ok, json };
}

let lastVoteContext = null;

function normalizeVotePayload(data) {
  if (!data || typeof data !== "object") return null;
  const v = data.vote ?? data.agenda ?? data;
  const title = String(v.title ?? v.question ?? v.subject ?? "").trim();
  const agendaId = v.agendaId ?? v.id ?? v.agenda_id ?? "1";
  const options = v.options ?? v.choices ?? v.items;
  const votes = v.votes ?? v.counts ?? v.tally;
  if (!Array.isArray(options) || options.length === 0) return null;
  const voteArr = Array.isArray(votes) ? votes : [];
  return { title: title || "투표", agendaId: String(agendaId), options, votes: voteArr };
}

function renderVoteSection(data) {
  const hint = document.getElementById("vote-hint");
  const body = document.getElementById("vote-body");
  if (!body) return;

  lastVoteContext = null;
  const normalized = normalizeVotePayload(data);
  if (!normalized) {
    if (hint) {
      hint.textContent =
        "API action=vote 로 안건·선택지·득표수 배열을 주면 표시됩니다. 제출은 action=voteSubmit 입니다.";
    }
    body.innerHTML =
      '<p class="text-sm more-bento-empty">진행 중인 투표가 없습니다.</p>';
    return;
  }

  lastVoteContext = { agendaId: normalized.agendaId };
  if (hint) hint.textContent = "이름 입력 후 항목별 투표를 누르세요.";
  body.innerHTML = "";
  const h4 = document.createElement("h4");
  h4.className = "more-bento-h4 font-semibold text-[#1a2e2e]";
  h4.textContent = normalized.title;
  body.appendChild(h4);

  normalized.options.forEach((opt, i) => {
    const count = Number(normalized.votes[i] ?? 0) || 0;
    const row = document.createElement("div");
    row.className =
      "more-bento-vote-row flex flex-wrap items-center gap-2 border border-[#1a2e2e]/22 bg-[#faf8f3] px-3 py-2";
    const label = document.createElement("span");
    label.className = "min-w-0 flex-1 text-sm text-ink-800";
    label.textContent = String(opt);
    const meta = document.createElement("span");
    meta.className = "text-xs text-stone-500";
    meta.textContent = `${count}표`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "rounded-lg bg-seal px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#14532d]";
    btn.textContent = "투표";
    btn.addEventListener("click", () => void submitVoteOption(i));
    row.appendChild(label);
    row.appendChild(meta);
    row.appendChild(btn);
    body.appendChild(row);
  });
}

async function submitVoteOption(optionIndex) {
  const nameInput = document.getElementById("vote-voter-name");
  const voterName = nameInput?.value?.trim();
  if (!voterName) {
    window.alert("투표자 이름을 입력해 주세요.");
    return;
  }
  if (!lastVoteContext) return;

  const { ok, json } = await apiPostForm({
    action: "voteSubmit",
    agendaId: lastVoteContext.agendaId,
    voterName,
    selectedOption: String(optionIndex),
  });

  const success =
    ok &&
    json &&
    json.success !== false &&
    json.ok !== false &&
    json.error == null;
  if (success) {
    window.alert(String(json.message || "투표가 반영되었습니다."));
    await loadVoteSection();
  } else {
    window.alert(
      String(json?.message || json?.error || "투표 처리에 실패했습니다.")
    );
  }
}

async function loadVoteSection() {
  const voteJson = await apiGetSilent({ action: "vote" });
  renderVoteSection(voteJson);
}

function renderMoreHistory(data) {
  const body = document.getElementById("more-history-body");
  const hint = document.getElementById("more-history-hint");
  if (!body) return;

  const items = normalizeList(data, ["history", "data", "items", "list"]);
  body.innerHTML = "";
  if (hint) {
    hint.textContent = items.length
      ? "API action=history 연동"
      : "API에 history가 없으면 아래는 비어 있습니다. Apps Script에 ?action=history&limit=20 를 구현해 주세요.";
  }
  if (!items.length) {
    body.innerHTML =
      '<p class="text-sm more-bento-empty">등록된 자료 목록이 없습니다.</p>';
    return;
  }
  items.slice(0, 20).forEach((h) => {
    const year = String(h.year ?? h.연도 ?? "");
    const title = String(h.title ?? h.제목 ?? h.headline ?? "");
    const p = document.createElement("p");
    p.className =
      "more-bento-history-line border-b border-[#1a2e2e]/12 pb-2 text-sm last:border-0";
    p.innerHTML = `<span class="font-semibold text-seal">${escapeHtml(year)}</span> ${escapeHtml(title)}`;
    body.appendChild(p);
  });
}

function applyMapMarkers(points) {
  if (!mapInstance || typeof L === "undefined") return;
  if (!mapMarkersLayer) {
    mapMarkersLayer = L.layerGroup().addTo(mapInstance);
  }
  mapMarkersLayer.clearLayers();
  const bounds = [];
  points.forEach((s) => {
    const m = L.marker([s.lat, s.lng]).addTo(mapMarkersLayer);
    m.bindPopup(
      `<strong class="text-ink-900">${escapeHtml(s.name)}</strong><br><span class="text-sm text-stone-600">${escapeHtml(s.desc || "")}</span>`
    );
    bounds.push([s.lat, s.lng]);
  });
  if (bounds.length) {
    const b = L.latLngBounds(bounds);
    lastMapFitBounds = b;
    mapInstance.fitBounds(b, { padding: [28, 28], maxZoom: 12 });
  } else {
    lastMapFitBounds = null;
  }
}

function fitMapToMarkersOrDefault() {
  if (!mapInstance || typeof L === "undefined") return;
  requestAnimationFrame(() => mapInstance.invalidateSize(true));
  if (lastMapFitBounds && lastMapFitBounds.isValid && lastMapFitBounds.isValid()) {
    mapInstance.fitBounds(lastMapFitBounds, { padding: [28, 28], maxZoom: 12 });
  } else {
    mapInstance.setView([36.36, 128.68], 10);
  }
}

async function loadMapPointsIntoMap() {
  let points = [...HERITAGE_SITES];
  const json = await apiGetSilent({ action: "movements" });
  const apiPts = normalizeMapPoints(json);
  if (apiPts.length) points = apiPts;
  applyMapMarkers(points);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  resultList.innerHTML = "";
  hideStatus();

  if (!name) {
    showStatus("이름을 입력해 주세요.", true);
    return;
  }

  submitBtn.disabled = true;
  showStatus("불러오는 중…");

  try {
    const data = await fetchSebo(name);
    const rows = normalizeRows(data);
    renderResults(rows);
  } catch (err) {
    console.error(err);
    const hint =
      err.message?.includes("Failed to fetch") || err.name === "TypeError"
        ? " 네트워크 또는 CORS 문제일 수 있습니다. 브라우저 콘솔(F12)을 확인하고, Apps Script 배포가 '모든 사용자'이며 JSON을 반환하는지 점검하세요."
        : "";
    showStatus((err.message || "검색 중 오류가 났습니다.") + hint, true);
    lastSearchRows = [];
    refreshTreePersonSelect();
  } finally {
    submitBtn.disabled = false;
  }
});

/* ---------- 하단 내비 ---------- */

function showView(viewId) {
  document.querySelectorAll(".view-panel").forEach((el) => {
    el.classList.toggle("hidden", el.id !== viewId);
  });
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    const on = btn.dataset.view === viewId;
    btn.dataset.active = on ? "true" : "false";
  });

  const hdrMap = {
    "view-home": "hdr-tab-home",
    "view-tree": "hdr-tab-tree",
    "view-map": "hdr-tab-map",
    "view-more": "hdr-tab-more",
  };
  Object.entries(hdrMap).forEach(([v, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.active = v === viewId ? "true" : "false";
  });

  // 페이지별 헤더 서브메뉴(홈은 숨김)
  const subWrap = document.getElementById("hdr-submenu");
  const subTree = document.getElementById("hdr-submenu-tree");
  const subMap = document.getElementById("hdr-submenu-map");
  const subMore = document.getElementById("hdr-submenu-more");
  const isHome = viewId === "view-home";
  if (subWrap) subWrap.classList.toggle("hidden", isHome);
  if (subTree) subTree.classList.toggle("hidden", viewId !== "view-tree");
  if (subMap) subMap.classList.toggle("hidden", viewId !== "view-map");
  if (subMore) subMore.classList.toggle("hidden", viewId !== "view-more");

  if (viewId === "view-map") {
    ensureMap();
  }

  if (viewId === "view-home") {
    void loadHomeNotices();
  }

  if (viewId === "view-more") {
    void loadClanTab();
  }

  if (viewId === "view-tree") {
    requestAnimationFrame(() => {
      void updateTreeView();
    });
  }
}

function initBottomNav() {
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });
}

function initHeaderTabs() {
  const byId = (id) => document.getElementById(id);
  byId("hdr-tab-home")?.addEventListener("click", () => showView("view-home"));
  byId("hdr-tab-tree")?.addEventListener("click", () => showView("view-tree"));
  byId("hdr-tab-map")?.addEventListener("click", () => showView("view-map"));
  byId("hdr-tab-more")?.addEventListener("click", () => showView("view-more"));

  // 헤더 서브메뉴 버튼 동작
  document.getElementById("hdr-submenu")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button");
    if (!btn) return;

    const gen = btn.getAttribute("data-tree-gen");
    if (gen) {
      // 가계도 세대 필터
      if (gen === "1-10") setTreeGenFilter(1, 10);
      else if (gen === "9-11") setTreeGenFilter(9, 11); // (구버전 호환)
      else if (gen === "11-20") setTreeGenFilter(11, 20);
      else if (gen === "21-31") setTreeGenFilter(21, 31);
      else if (gen === "32+") setTreeGenFilter(32, 999);
      showView("view-tree");
      return;
    }

    const scrollToId = btn.getAttribute("data-scroll-to");
    if (scrollToId) {
      const el = document.getElementById(scrollToId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

/** 아천문중 벤토 페이지: 맨 위로 */
function initMorePageChrome() {
  document.getElementById("more-back-top")?.addEventListener("click", () => {
    document
      .querySelector("#view-more .more-bento-hero")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/** 가계도·8촌 관계도 SVG: ＋/－/맞춤 (초기 맞춤은 attachTreeZoomState 참조) */
function initTreeZoomHosts() {
  document.querySelectorAll(".tree-zoom-host").forEach((host) => {
    host.addEventListener("click", (e) => {
      const btn = e.target.closest(".tree-z");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      const svgEl = host.querySelector("svg");
      const st = svgEl?.__treeZoom;
      // 가로 스크롤 전용(1-10세): d3.zoom 대신 transform scale만 지원
      if (st?.simple) {
        const cur = Number(st.scale || 1);
        const next =
          act === "in" ? cur * 1.12 : act === "out" ? cur / 1.12 : 1;
        const s = Math.max(0.55, Math.min(1.6, next));
        svgEl.style.transformOrigin = "0 0";
        svgEl.style.transform = `scale(${s})`;
        svgEl.__treeZoom = { simple: true, scale: s };
        return;
      }
      if (!st?.zoom || st.initial == null) return;
      const { zoom, initial, sel } = st;
      if (act === "in") sel.transition().duration(180).call(zoom.scaleBy, 1.28);
      else if (act === "out") sel.transition().duration(180).call(zoom.scaleBy, 1 / 1.28);
      else if (act === "reset") sel.transition().duration(220).call(zoom.transform, initial);
    });
  });
}

// (요청) 붉은 점 슬라이드바 제거 — 페이지 전환은 가로 스크롤로만 한다.


function initMapFitButton() {
  document.getElementById("map-fit-btn")?.addEventListener("click", () => {
    fitMapToMarkersOrDefault();
  });
}

/* ---------- 아천문중(정관/재산/공지/투표응답): 요약 + 펼쳐보기 ---------- */

function setMoreCollapsed(key, collapsed) {
  const body = document.querySelector(`[data-more-body="${key}"]`);
  const btn = document.querySelector(`[data-more-toggle="${key}"]`);
  if (!body || !btn) return;
  body.classList.toggle("is-collapsed", !!collapsed);
  const isCollapsed = !!collapsed;
  btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
}

function initMoreExpanders() {
  document.getElementById("view-more")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".more-expand-btn");
    if (!btn) return;
    const key = btn.getAttribute("data-more-toggle");
    if (!key) return;
    const body = document.querySelector(`[data-more-body="${key}"]`);
    const isCollapsed = body?.classList?.contains("is-collapsed");
    setMoreCollapsed(key, !isCollapsed);
  });
}

function renderMarkdownInto(el, md) {
  if (!el) return;
  const src = String(md || "").trim();
  if (!src) {
    el.innerHTML = `<p class="more-bento-empty text-sm">표시할 내용이 없습니다.</p>`;
    return;
  }
  // marked가 있으면 markdown → html, 없으면 <pre>로 표시
  if (typeof marked !== "undefined" && marked?.parse) {
    try {
      el.innerHTML = marked.parse(src);
      return;
    } catch {
      // ignore
    }
  }
  el.innerHTML = `<pre class="whitespace-pre-wrap text-[12px] leading-relaxed">${escapeHtml(src)}</pre>`;
}

function isFileProtocol() {
  try {
    return String(location?.protocol || "") === "file:";
  } catch {
    return false;
  }
}

async function loadCharterMarkdown() {
  const hint = document.getElementById("more-charter-hint");
  const body = document.getElementById("more-charter-body");
  if (!body) return;
  if (hint) hint.textContent = "로컬 문서(docs/아천문중_정관.md)";
  if (isFileProtocol()) {
    body.innerHTML =
      `<p class="more-bento-empty text-sm">현재 <code class="text-xs">file://</code>로 열려 있어 문서를 불러올 수 없습니다. ` +
      `정적 서버(예: <code class="text-xs">http://localhost:3000</code>)로 열어 주세요.</p>`;
    return;
  }
  try {
    const url = new URL("docs/아천문중_정관.md", location.href);
    const res = await fetch(url.toString(), { cache: "no-store" });
    const md = await res.text();
    renderMarkdownInto(body, md);
    setMoreCollapsed("more-charter", true);
  } catch (err) {
    console.warn(err);
    if (hint) hint.textContent = `로컬 문서(docs/아천문중_정관.md) · 로드 실패`;
    body.innerHTML = `<p class="more-bento-empty text-sm">정관 문서를 불러오지 못했습니다.</p>`;
  }
}

function normalizePropertyPayload(json) {
  if (!json || typeof json !== "object") return [];
  if (json.status === "error") return [];
  const items = normalizeList(json, ["property", "properties", "data", "items", "list", "rows"]);
  return Array.isArray(items) ? items : [];
}

function propertyItemsToMarkdown(items) {
  if (!items || !items.length) return "";
  const lines = ["## 문중재산", ""];

  const nonEmptyPairs = (obj) => {
    if (!obj || typeof obj !== "object") return [];
    return Object.entries(obj)
      .map(([k, v]) => [String(k || "").trim(), String(v ?? "").trim()])
      .filter(([k, v]) => k && v);
  };

  const isColShape =
    items.length &&
    items[0] &&
    typeof items[0] === "object" &&
    ("col1" in items[0] || "col2" in items[0] || "col3" in items[0] || "col4" in items[0]);

  // property 시트 헤더가 비어있으면 col1~로 내려옴 → 고정 포맷으로 예쁘게 표시
  if (isColShape) {
    items.slice(0, 200).forEach((it, i) => {
      const loc = String(it.col1 ?? "").trim(); // 소재지(예: 적서동 727)
      const kind = String(it.col2 ?? "").trim(); // 지목(예: 전/답)
      const area = String(it.col3 ?? "").trim(); // 면적
      const owner = String(it.col4 ?? "").trim(); // 명의/비고
      const head = loc || `항목 ${i + 1}`;
      const meta = [kind ? `지목 ${kind}` : "", area ? `면적 ${area}` : ""].filter(Boolean).join(" · ");
      const sum = [meta, owner].filter(Boolean).join(" / ");
      lines.push(`- **${head}**${sum ? `: ${sum}` : ""}`);
    });
    lines.push("");
    return lines.join("\n");
  }

  items.slice(0, 200).forEach((it, i) => {
    const title = String(
      it.title ??
        it.name ??
        it.항목 ??
        it.명칭 ??
        it["재산명"] ??
        it["재산"] ??
        it["소재지"] ??
        ""
    ).trim();
    const date = String(it.date ?? it.일자 ?? it.등록일 ?? it.취득일 ?? "").trim();
    const body = String(it.body ?? it.desc ?? it.내용 ?? it.memo ?? it.비고 ?? "").trim();

    // 컬럼명이 제각각인 경우: 첫 번째 유효 필드를 제목으로 사용
    const pairs = nonEmptyPairs(it);
    const fallbackTitle = title || (pairs[0] ? pairs[0][1] : "");
    const head =
      fallbackTitle || date
        ? `${fallbackTitle || "항목"}${date ? ` (${date})` : ""}`
        : `항목 ${i + 1}`;

    // 요약: body가 없으면 나머지 필드 2~3개를 붙여준다
    let summary = body;
    if (!summary) {
      const rest = pairs
        .slice(1, 4)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ");
      summary = rest;
    }

    lines.push(`- **${head}**${summary ? `: ${summary}` : ""}`);
  });
  lines.push("");
  return lines.join("\n");
}

async function loadPropertySheet() {
  const hint = document.getElementById("more-property-hint");
  const body = document.getElementById("more-property-body");
  if (!body) return;
  if (hint) hint.textContent = "API action=property (시트: property)";
  body.innerHTML = `<p class="text-sm text-stone-500">불러오는 중…</p>`;
  if (isFileProtocol()) {
    body.innerHTML =
      `<p class="more-bento-empty text-sm">현재 <code class="text-xs">file://</code>로 열려 있어 API 호출이 차단될 수 있습니다. ` +
      `정적 서버로 열어 주세요.</p>`;
    return;
  }
  try {
    const json = await apiGetWait(
      { action: "property", limit: "200" },
      { hintEl: hint, maxAttempts: 10 }
    );
    const items = normalizePropertyPayload(json);
    const md = items.length ? propertyItemsToMarkdown(items) : "";
    if (md) renderMarkdownInto(body, md);
    else body.innerHTML = `<p class="more-bento-empty text-sm">등록된 문중재산 자료가 없습니다.</p>`;
    setMoreCollapsed("more-property", true);
  } catch (err) {
    console.warn(err);
    body.innerHTML =
      `<p class="more-bento-empty text-sm">property 시트를 불러오지 못했습니다.</p>` +
      `<p class="mt-2 text-[11px] text-stone-500">서버가 계속 <code class="text-xs">{\"status\":\"running\"}</code>만 반환하면 Apps Script 배포/권한/분기(action=property)와 JSON 반환을 확인해 주세요.</p>`;
  }
}

async function loadNoticesSheet() {
  // 1순위: action=notice, 2순위: action=notices (기존 호환)
  const hint = document.getElementById("clan-notice-hint");
  const list = document.getElementById("clan-notice-list");
  if (!list) return;
  if (hint) hint.textContent = "API action=notice (시트: notice) · 호환: notices";
  list.innerHTML = `<li class="more-bento-empty text-sm">불러오는 중…</li>`;
  if (isFileProtocol()) {
    list.innerHTML =
      `<li class="more-bento-empty text-sm">현재 <code class="text-xs">file://</code>로 열려 있어 API 호출이 차단될 수 있습니다. ` +
      `정적 서버로 열어 주세요.</li>`;
    setMoreCollapsed("more-notice", true);
    return;
  }
  let json = null;
  try {
    json = await apiGetWait(
      { action: "notice", limit: "30" },
      { hintEl: hint, maxAttempts: 10 }
    );
  } catch {
    // ignore
  }
  if (!json) {
    try {
      json = await apiGetWait(
        { action: "notices", limit: "30" },
        { hintEl: hint, maxAttempts: 10 }
      );
      if (hint) hint.textContent = "API action=notices (호환)";
    } catch {
      json = null;
    }
  }
  if (!json) {
    list.innerHTML =
      `<li class="more-bento-empty text-sm">공지사항을 불러오지 못했습니다.</li>` +
      `<li class="mt-2 text-[11px] text-stone-500">서버가 계속 <code class="text-xs">{\"status\":\"running\"}</code>만 반환하면 Apps Script 배포/권한/분기(action=notice/notices)와 JSON 반환을 확인해 주세요.</li>`;
    setMoreCollapsed("more-notice", true);
    return;
  }
  renderClanNotices(json);
  setMoreCollapsed("more-notice", true);
}

function normalizeVoteResponsePayload(json) {
  if (!json || typeof json !== "object") return [];
  if (json.status === "error") return [];
  const items = normalizeList(json, ["voteRespone", "voteResponse", "responses", "data", "items", "list", "rows"]);
  return Array.isArray(items) ? items : [];
}

function voteResponsesToMarkdown(items) {
  if (!items || !items.length) return "";
  const lines = ["## 투표 응답", ""];
  items.slice(0, 200).forEach((it, i) => {
    const name = String(it.name ?? it.voterName ?? it.이름 ?? it.투표자 ?? "").trim();
    const opt = String(it.option ?? it.choice ?? it.selectedOption ?? it.선택 ?? it.응답 ?? "").trim();
    const date = String(it.date ?? it.time ?? it.createdAt ?? it.일시 ?? "").trim();
    const head = `${name || "문중원"}${opt ? ` · ${opt}` : ""}${date ? ` (${date})` : ""}`;
    lines.push(`- ${head || `응답 ${i + 1}`}`);
  });
  lines.push("");
  return lines.join("\n");
}

async function loadVoteResponseSheet() {
  const hint = document.getElementById("vote-hint");
  const body = document.getElementById("vote-body");
  if (!body) return;
  if (hint) hint.textContent = "API action=voteResponse (시트: voteResponse) · 호환: voteRespone";
  body.innerHTML = `<p class="text-sm text-stone-500">불러오는 중…</p>`;
  if (isFileProtocol()) {
    body.innerHTML =
      `<p class="more-bento-empty text-sm">현재 <code class="text-xs">file://</code>로 열려 있어 API 호출이 차단될 수 있습니다. ` +
      `정적 서버로 열어 주세요.</p>`;
    setMoreCollapsed("more-vote", true);
    return;
  }
  let json = null;
  try {
    json = await apiGetWait(
      { action: "voteResponse", limit: "200" },
      { hintEl: hint, maxAttempts: 10 }
    );
  } catch {
    // ignore
  }
  if (!json) {
    try {
      json = await apiGetWait(
        { action: "voteRespone", limit: "200" },
        { hintEl: hint, maxAttempts: 10 }
      );
      if (hint) hint.textContent = "API action=voteRespone (호환)";
    } catch {
      json = null;
    }
  }
  if (!json) {
    body.innerHTML =
      `<p class="more-bento-empty text-sm">투표 응답을 불러오지 못했습니다.</p>` +
      `<p class="mt-2 text-[11px] text-stone-500">서버가 계속 <code class="text-xs">{\"status\":\"running\"}</code>만 반환하면 Apps Script 배포/권한/분기(action=voteRespone/voteResponse)와 JSON 반환을 확인해 주세요.</p>`;
    setMoreCollapsed("more-vote", true);
    return;
  }
  if (json.status === "error") {
    body.innerHTML = `<p class="more-bento-empty text-sm">${escapeHtml(String(json.error || "투표 응답 시트를 불러오지 못했습니다."))}</p>`;
    setMoreCollapsed("more-vote", true);
    return;
  }
  const items = normalizeVoteResponsePayload(json);
  const md = items.length ? voteResponsesToMarkdown(items) : "";
  if (md) renderMarkdownInto(body, md);
  else body.innerHTML = `<p class="more-bento-empty text-sm">등록된 투표 응답이 없습니다.</p>`;
  setMoreCollapsed("more-vote", true);
}

function renderAncestorsLine(people) {
  const line = document.getElementById("ancestors-line");
  const hint = document.getElementById("ancestors-hint");
  if (!line) return;
  line.classList.remove("hidden");
  line.innerHTML = "";
  if (!people.length) {
    if (hint) hint.textContent = "기준 인물을 선택하면 직계 조상이 자동 표시됩니다.";
    line.innerHTML = '<div class="text-sm text-stone-600">표시할 데이터가 없습니다.</div>';
    return;
  }
  if (hint) hint.textContent = `본인→시조 부계 ${people.length}명`;

  // 이미 [본인, 부, 조부, …] 순 — 재정렬하지 않음(표시 속도·직관)

  const row = document.createElement("div");
  row.className =
    "flex w-full max-w-full flex-wrap items-end justify-start gap-y-1.5 gap-x-0 py-0.5";
  people.forEach((p, idx) => {
    const block = document.createElement("div");
    block.className = "max-w-[3.75rem] shrink-0 px-0.5 text-center leading-none";
    const nm = pickFirstString(p, NAME_KEYS) || "?";
    const gen = readNodeGenLike(p);
    block.innerHTML = `<div class="break-words text-[10px] font-semibold leading-tight text-ink-900">${escapeHtml(nm)}</div>${
      gen != null
        ? `<div class="mt-px text-[9px] leading-none text-stone-500">(${gen}세)</div>`
        : ""
    }`;
    row.appendChild(block);

    if (idx < people.length - 1) {
      const conn = document.createElement("div");
      conn.className =
        "mx-0.5 mb-1.5 h-0 min-w-[0.55rem] shrink-0 self-end border-t border-dotted border-stone-400 sm:min-w-[0.75rem]";
      conn.setAttribute("aria-hidden", "true");
      row.appendChild(conn);
    }
  });
  line.appendChild(row);
}

function kinshipPersonRowId(row) {
  if (!row || typeof row !== "object") return "";
  const id = pickFirstString(row, CLAN_MEMBER_ID_KEYS);
  if (id) return String(id).trim();
  return String(row.id ?? row.문중원ID ?? "").trim();
}

/**
 * 촌수「관계도 보기」용: 두 사람의 부계를 **동시에 한 단계씩** 올리며 공통 조상이 나오면 즉시 중단.
 * (기존: 각각 80단계 순차 → 벽시계 약 2배)
 */
async function buildKinshipVisualFatherChains(id1, id2, maxDepth = 25) {
  const chainA = [];
  const chainB = [];
  let curA = String(id1 || "").trim();
  let curB = String(id2 || "").trim();
  const seenA = new Set();
  const seenB = new Set();

  const bestPair = () => {
    const idxA = new Map();
    chainA.forEach((p, i) => {
      const pid = kinshipPersonRowId(p);
      if (pid) idxA.set(pid, i);
    });
    let best = null;
    chainB.forEach((p, j) => {
      const pid = kinshipPersonRowId(p);
      if (!pid || !idxA.has(pid)) return;
      const sum = idxA.get(pid) + j;
      if (!best || sum < best.sum) best = { id: pid, sum, iA: idxA.get(pid), iB: j };
    });
    return best;
  };

  const seedFromDetail = (which, curId) => {
    if (!curId || String(selectedPersonId) !== curId) return curId;
    if (!lastPersonDetail || typeof lastPersonDetail !== "object") return curId;
    const ch = which === "A" ? chainA : chainB;
    const seen = which === "A" ? seenA : seenB;
    if (seen.has(curId)) return curId;
    seen.add(curId);
    ch.push(lastPersonDetail);
    return pickFirstString(lastPersonDetail, PARENT_ID_KEYS) || "";
  };

  curA = seedFromDetail("A", curA);
  curB = seedFromDetail("B", curB);
  let best = bestPair();
  if (best) return { chainA, chainB, best };

  for (let d = 0; d < maxDepth && (curA || curB); d++) {
    const takeA = !!(curA && !seenA.has(curA));
    const takeB = !!(curB && !seenB.has(curB));
    if (!takeA && !takeB) break;

    if (takeA && takeB && curA === curB) {
      const p = await getPersonByIdForAncestorChain(curA);
      seenA.add(curA);
      seenB.add(curB);
      if (p) {
        chainA.push(p);
        chainB.push(p);
        const nx = pickFirstString(p, PARENT_ID_KEYS) || "";
        curA = nx;
        curB = nx;
      } else {
        curA = "";
        curB = "";
      }
    } else {
      const [pA, pB] = await Promise.all([
        takeA ? getPersonByIdForAncestorChain(curA) : Promise.resolve(null),
        takeB ? getPersonByIdForAncestorChain(curB) : Promise.resolve(null),
      ]);

      if (takeA) {
        seenA.add(curA);
        if (pA) {
          chainA.push(pA);
          curA = pickFirstString(pA, PARENT_ID_KEYS) || "";
        } else curA = "";
      }
      if (takeB) {
        seenB.add(curB);
        if (pB) {
          chainB.push(pB);
          curB = pickFirstString(pB, PARENT_ID_KEYS) || "";
        } else curB = "";
      }
    }

    best = bestPair();
    if (best) return { chainA, chainB, best };
  }

  return { chainA, chainB, best: bestPair() };
}

async function buildFatherChainFromId(id, limit = 40) {
  const out = [];
  let cur = String(id || "").trim();
  const seen = new Set();

  // 선택 직후 상세는 이미 메모리에 있음 → 첫 번째 person API 호출 생략
  if (
    cur &&
    String(selectedPersonId) === cur &&
    lastPersonDetail &&
    typeof lastPersonDetail === "object"
  ) {
    out.push(lastPersonDetail);
    seen.add(cur);
    const next = pickFirstString(lastPersonDetail, PARENT_ID_KEYS);
    if (!next || out.length >= limit) return out;
    cur = String(next).trim();
  }

  while (cur && out.length < limit) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const p = await getPersonByIdForAncestorChain(cur);
    if (!p) break;
    out.push(p);
    const next = pickFirstString(p, PARENT_ID_KEYS);
    if (!next) break;
    cur = String(next).trim();
  }
  return out;
}

async function updateAncestorsForSelected() {
  const hint = document.getElementById("ancestors-hint");
  if (!selectedPersonId) {
    renderAncestorsLine([]);
    return;
  }
  if (hint) hint.textContent = "직계 조상 정보를 불러오는 중…";
  // 느릴 때 체감 개선: 1명씩 추가하며 중간중간 렌더
  const out = [];
  let cur = String(selectedPersonId || "").trim();
  const seen = new Set();
  for (let step = 0; step < 220; step++) {
    if (!cur || seen.has(cur)) break;
    seen.add(cur);
    const p = step === 0 && lastPersonDetail ? lastPersonDetail : await getPersonByIdForAncestorChain(cur);
    if (!p) break;
    out.push(p);
    if (step % 6 === 0) renderAncestorsLine(out);
    const next = pickFirstString(p, PARENT_ID_KEYS);
    if (!next) break;
    cur = String(next).trim();
  }
  renderAncestorsLine(out);
  if (hint) hint.textContent = `직계 조상 ${out.length}명`;
}

function initHomeActions() {
  document
    .getElementById("ancestors-refresh-btn")
    ?.addEventListener("click", () => void updateAncestorsForSelected());
  document.getElementById("btn-home-open-notice")?.addEventListener("click", () => {
    showView("view-more");
  });
  document.getElementById("btn-home-open-tree")?.addEventListener("click", () => {
    showView("view-tree");
    if (selectedPersonId) void drawFamilyTree(selectedPersonId);
  });
  document.getElementById("btn-home-load-eight")?.addEventListener("click", async () => {
    if (!selectedPersonId) {
      window.alert("먼저 본인 확인에서 기준 인물을 선택해 주세요.");
      return;
    }
    const [json, anchorChain] = await Promise.all([
      apiGetSilent({ action: "eightKin", id: selectedPersonId }),
      buildFatherChainFromId(selectedPersonId, 8),
    ]);
    await renderEightKinBox(json, anchorChain);
  });
}

/* ---------- Leaflet ---------- */

function ensureMap() {
  if (typeof L === "undefined") return;
  const el = document.getElementById("map-leaflet");
  if (!el) return;

  if (!mapInstance) {
    mapInstance = L.map("map-leaflet", {
      scrollWheelZoom: true,
      tap: true,
      touchZoom: true,
      doubleClickZoom: true,
      zoomControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapInstance);
    mapMarkersLayer = L.layerGroup().addTo(mapInstance);
    mapInstance.setView([36.36, 128.68], 10);
    void loadMapPointsIntoMap();
  } else {
    void loadMapPointsIntoMap();
  }

  requestAnimationFrame(() => {
    mapInstance.invalidateSize(true);
    setTimeout(() => mapInstance.invalidateSize(true), 250);
  });
}

/* ---------- 가계도 상세 카드 (참조 코드의 detail-card 역할) ---------- */

function updateTreeDetailCard(personId) {
  const el = document.getElementById("tree-detail-card");
  if (!el) return;

  if (!personId || !lastSearchRows.length) {
    el.innerHTML =
      '<p class="text-stone-500">홈에서 세보를 검색한 뒤 인물을 선택하면 요약이 표시됩니다.</p>';
    return;
  }

  const row =
    selectedPersonId === personId && lastPersonDetail
      ? lastPersonDetail
      : annotatePeople(lastSearchRows).find((x) => x.id === personId)?.row;

  if (!row || typeof row !== "object") {
    el.innerHTML =
      '<p class="text-stone-500">선택한 인물을 찾을 수 없습니다.</p>';
    return;
  }

  const name = pickFirstString(row, NAME_KEYS) || "이름 미상";
  const genLine = formatSesongLine(row);
  const father = pickFirstString(row, PARENT_NAME_KEYS) || "기록 없음";
  const mother =
    pickFirstString(row, ["모친", "모", "mother", "Mother"]) || "기록 없음";
  const childrenStr = joinPeopleText(
    row["자녀"] ?? row.children ?? row.Children
  );
  const sibStr = joinPeopleText(row["형제"] ?? row.siblings ?? row.Siblings);

  const rowsHtml = [
    ["부친", father],
    ["모친", mother],
  ];
  if (childrenStr) rowsHtml.push(["자녀", childrenStr]);
  if (sibStr) rowsHtml.push(["형제", sibStr]);

  const dl = rowsHtml
    .map(
      ([k, v]) =>
        `<div><span class="text-stone-500">${escapeHtml(k)}</span> <span class="text-ink-800">${escapeHtml(v)}</span></div>`
    )
    .join("");

  const srcHint =
    selectedPersonId === personId && lastPersonDetail
      ? '<p class="mt-2 text-[11px] text-stone-400">문중원ID 기준 API 상세가 반영된 요약입니다.</p>'
      : "";

  el.innerHTML = `
    <p class="text-xs font-medium text-seal">문중원ID <span class="font-mono">${escapeHtml(personId)}</span></p>
    <div class="mt-1 text-lg font-bold text-ink-900">${escapeHtml(name)}</div>
    ${genLine ? `<p class="mt-1 text-sm text-stone-600">${escapeHtml(genLine)}</p>` : ""}
    <div class="mt-3 space-y-1.5 text-sm">${dl}</div>
    ${srcHint}
  `;
}

/* ---------- getTree → D3 ---------- */

function normalizeTreeNode(raw) {
  if (raw == null || typeof raw !== "object") return null;
  if (Array.isArray(raw)) {
    if (raw.length === 1) return normalizeTreeNode(raw[0]);
    return null;
  }
  const name = String(
    raw.name ?? raw.label ?? raw.title ?? raw.이름 ?? raw.성명 ?? "?"
  ).trim();
  const id =
    raw.id != null && String(raw.id).trim() !== ""
      ? String(raw.id).trim()
      : undefined;
  const gen = readNodeGenLike(raw);
  const kidsRaw = raw.children ?? raw.kids ?? raw.descendants ?? raw.nodes;
  let children = [];
  if (Array.isArray(kidsRaw)) {
    children = kidsRaw.map((c) => normalizeTreeNode(c)).filter(Boolean);
  }
  const o = { name: name || "?" };
  if (id) o.id = id;
  if (gen != null) o.gen = gen;
  if (children.length) o.children = children;
  return o;
}

function extractNestedTreeRoot(json) {
  if (!json || typeof json !== "object") return null;
  const inner = json.tree ?? json.root ?? json.data;
  const base = inner != null && typeof inner === "object" && !Array.isArray(inner) ? inner : json;
  const node = normalizeTreeNode(base);
  if (!node) return null;
  if (node.name === "?" && !node.children?.length) return null;
  return node;
}

function flatRowsForStratifyFromGetTree(json, focusId) {
  const arr = normalizeList(json, [
    "nodes",
    "rows",
    "people",
    "flat",
    "data",
    "items",
    "list",
  ]);
  if (!arr.length) return null;
  const graphItems = [];
  for (const r of arr) {
    const id = String(r.id ?? r.ID ?? "").trim();
    if (!id) continue;
    const p = String(
      r.parentId ?? r.parent_id ?? r.fatherId ?? r.father_id ?? ""
    ).trim();
    const name = String(r.name ?? r.이름 ?? r.label ?? id).trim();
    graphItems.push({
      id,
      parentId: p,
      name: name || id,
      row: r,
    });
  }
  if (!graphItems.length) return null;
  const idSet = new Set(graphItems.map((x) => x.id));
  if (!idSet.has(String(focusId))) return null;

  const rows = graphItems.map((it) => ({
    id: it.id,
    parentId:
      it.parentId && idSet.has(it.parentId) ? it.parentId : ROOT_SENTINEL,
    name: it.name,
    row: it.row,
  }));
  rows.push({
    id: ROOT_SENTINEL,
    parentId: "",
    name: "root",
    row: null,
  });
  return descendantStratifyRows(rows, focusId);
}

function nodeIsFocused(d, focusId, fromNested) {
  if (String(d.data?.id ?? "") === String(focusId)) return true;
  if (fromNested && !d.parent) return true;
  return false;
}

/** 가계도/8촌 트리 SVG: 처음 맞춤 변환을 저장해 「맞춤」 버튼으로 복귀 */
function attachTreeZoomState(svgEl, zoom, initialTransform) {
  if (!svgEl || !zoom || !initialTransform) return;
  svgEl.__treeZoom = {
    zoom,
    initial: initialTransform,
    sel: d3.select(svgEl),
  };
}

function paintD3TreeLayout(root, focusId, wrap, svgEl, fromNested) {
  const svg = d3.select(svgEl);
  const treeLinkStroke =
    svgEl && String(svgEl.id || "") === "eight-kin-svg"
      ? EIGHT_KIN_EDGE_SOFT
      : "#d6d3d1";
  // 이전 줌/핸들러가 쌓여 중첩되어 보이는 현상 방지
  svg.on(".zoom", null);

  const nodes = root.descendants();
  const links = root.links();

  // 세대별(gen/세손)로 "줄 맞춰" 그리기: y는 세대 고정, x는 같은 세대 내에서 정렬
  const genById = new Map();
  nodes.forEach((d) => {
    const g =
      d.data?.gen ??
      readNodeGenLike(d.data) ??
      readNodeGenLike(d.data?.row) ??
      null;
    if (g != null) genById.set(d, g);
  });

  const haveGen = [...genById.values()].some((v) => v != null);

  const pad = 48;
  const layerGap = 72;
  const colGap = 150;

  if (haveGen) {
    const gens = nodes
      .map((d) => genById.get(d))
      .filter((g) => typeof g === "number");
    const minGen = gens.length ? Math.min(...gens) : 0;

    // 같은 세대 안에서 부모/이름 기준으로 정렬
    const layers = new Map(); // gen -> node[]
    nodes.forEach((d) => {
      const g = genById.get(d);
      const key = typeof g === "number" ? g : minGen;
      if (!layers.has(key)) layers.set(key, []);
      layers.get(key).push(d);
    });

    function safeName(d) {
      return String(d.data?.name ?? "").trim();
    }

    const sortedGens = [...layers.keys()].sort((a, b) => a - b);
    sortedGens.forEach((g) => {
      layers.get(g).sort((a, b) => {
        const ap = safeName(a.parent || {});
        const bp = safeName(b.parent || {});
        if (ap !== bp) return ap.localeCompare(bp, "ko");
        return safeName(a).localeCompare(safeName(b), "ko");
      });
    });

    // 좌표 부여 (x=가로, y=세대)
    sortedGens.forEach((g, gi) => {
      const arr = layers.get(g);
      arr.forEach((d, i) => {
        d.x = i * colGap;
        d.y = (g - minGen) * layerGap;
      });
    });

    // bounds
    let xMin = Infinity,
      xMax = -Infinity,
      yMin = Infinity,
      yMax = -Infinity;
    nodes.forEach((d) => {
      xMin = Math.min(xMin, d.x);
      xMax = Math.max(xMax, d.x);
      yMin = Math.min(yMin, d.y);
      yMax = Math.max(yMax, d.y);
    });
    const innerW = Math.max(xMax - xMin + pad * 2 + 112, 280);
    const innerH = Math.max(yMax - yMin + pad * 2 + 64, 220);

    const gRoot = svg.append("g").attr("class", "tree-zoom-inner");

    const linkGen = d3
      .linkVertical()
      .x((d) => d.x - xMin + pad)
      .y((d) => d.y - yMin + pad);

    gRoot
      .append("g")
      .attr("fill", "none")
      .attr("stroke", treeLinkStroke)
      .attr("stroke-width", 1.5)
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("d", linkGen);

    const nodeG = gRoot
      .append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr(
        "transform",
        (d) => `translate(${d.x - xMin + pad},${d.y - yMin + pad})`
      );

    nodeG
      .append("rect")
      .attr("x", -56)
      .attr("y", -18)
      .attr("width", 112)
      .attr("height", 36)
      .attr("rx", 10)
      .attr("fill", (d) =>
        nodeIsFocused(d, focusId, fromNested) ? "#166534" : "#fff"
      )
      .attr("stroke", (d) =>
        nodeIsFocused(d, focusId, fromNested) ? "#166534" : "#e7e5e4"
      )
      .attr("stroke-width", 1.5);

    nodeG.append("title").text((d) => d.data.name || "");

    nodeG
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("fill", (d) =>
        nodeIsFocused(d, focusId, fromNested) ? "#fff" : "#292524"
      )
      .attr("font-size", 12)
      .attr("font-weight", (d) =>
        nodeIsFocused(d, focusId, fromNested) ? 700 : 500
      )
      .text((d) => {
        const text = d.data.name || "";
        const maxLen = 5;
        return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
      });

    svg.attr("viewBox", `0 0 ${innerW} ${innerH}`);

    const zoom = d3
      .zoom()
      .scaleExtent([0.35, 2.5])
      .on("zoom", (event) => {
        gRoot.attr("transform", event.transform);
      });
    svg.call(zoom);

    const fullW = wrap.clientWidth || 320;
    const fullH = wrap.clientHeight || 280;
    const scale = Math.min((fullW - 16) / innerW, (fullH - 16) / innerH, 1.2);
    const tx = fullW / 2 - (innerW * scale) / 2;
    const ty = fullH / 2 - (innerH * scale) / 2;
    const initialTransform = d3.zoomIdentity
      .translate(tx, ty)
      .scale(Math.max(scale, 0.45));
    svg.call(zoom.transform, initialTransform);
    attachTreeZoomState(svgEl, zoom, initialTransform);
    return;
  }

  // fallback: gen이 없으면 기본 트리 레이아웃
  const nodeV = 44;
  const nodeH = 150;
  const treeLayout = d3.tree().nodeSize([nodeV, nodeH]);
  treeLayout(root);

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  nodes.forEach((d) => {
    xMin = Math.min(xMin, d.x);
    xMax = Math.max(xMax, d.x);
    yMin = Math.min(yMin, d.y);
    yMax = Math.max(yMax, d.y);
  });

  const innerW = Math.max(yMax - yMin + pad * 2, 280);
  const innerH = Math.max(xMax - xMin + pad * 2, 200);

  const gRoot = svg.append("g").attr("class", "tree-zoom-inner");

  const linkGen = d3
    .linkHorizontal()
    .x((d) => d.y - yMin + pad)
    .y((d) => d.x - xMin + pad);

  gRoot
    .append("g")
    .attr("fill", "none")
    .attr("stroke", treeLinkStroke)
    .attr("stroke-width", 1.5)
    .selectAll("path")
    .data(links)
    .join("path")
    .attr("d", linkGen);

  const nodeG = gRoot
    .append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("transform", (d) => `translate(${d.y - yMin + pad},${d.x - xMin + pad})`);

  nodeG
    .append("rect")
    .attr("x", -56)
    .attr("y", -18)
    .attr("width", 112)
    .attr("height", 36)
    .attr("rx", 10)
    .attr("fill", (d) =>
      nodeIsFocused(d, focusId, fromNested) ? "#166534" : "#fff"
    )
    .attr("stroke", (d) =>
      nodeIsFocused(d, focusId, fromNested) ? "#166534" : "#e7e5e4"
    )
    .attr("stroke-width", 1.5);

  nodeG
    .append("title")
    .text((d) => d.data.name || "");

  nodeG
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em")
    .attr("fill", (d) =>
      nodeIsFocused(d, focusId, fromNested) ? "#fff" : "#292524"
    )
    .attr("font-size", 12)
    .attr("font-weight", (d) =>
      nodeIsFocused(d, focusId, fromNested) ? 700 : 500
    )
    .text((d) => {
      const text = d.data.name || "";
      const maxLen = 5;
      return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
    });

  svg.attr("viewBox", `0 0 ${innerW} ${innerH}`);

  const zoom = d3
    .zoom()
    .scaleExtent([0.35, 2.5])
    .on("zoom", (event) => {
      gRoot.attr("transform", event.transform);
    });

  svg.call(zoom);

  const fullW = wrap.clientWidth || 320;
  const fullH = wrap.clientHeight || 280;
  const scale = Math.min((fullW - 16) / innerW, (fullH - 16) / innerH, 1.2);
  const tx = fullW / 2 - (innerW * scale) / 2;
  const ty = fullH / 2 - (innerH * scale) / 2;
  const initialTransform = d3.zoomIdentity
    .translate(tx, ty)
    .scale(Math.max(scale, 0.45));
  svg.call(zoom.transform, initialTransform);
  attachTreeZoomState(svgEl, zoom, initialTransform);
}

/* ---------- D3 가계도 ---------- */

function refreshTreePersonSelect() {
  const sel = document.getElementById("tree-person-select");
  const hint = document.getElementById("tree-hint");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";

  if (!lastSearchRows.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "홈에서 검색 후 선택하세요";
    sel.appendChild(o);
    if (hint) hint.textContent = "";
    updateTreeDetailCard(null);
    void drawFamilyTree(null);
    return;
  }

  const itemsAll = annotatePeople(lastSearchRows);
  const items =
    treeGenFilter && Number.isFinite(treeGenFilter.min) && Number.isFinite(treeGenFilter.max)
      ? itemsAll.filter((it) => {
          const g = readNodeGenLike(it.row);
          if (g == null) return false;
          return g >= treeGenFilter.min && g <= treeGenFilter.max;
        })
      : itemsAll;

  items.forEach((it) => {
    const o = document.createElement("option");
    o.value = it.id;
    const ss = formatSesongLine(it.row);
    const fb = formatFatherBrief(it.row);
    let label = it.name;
    if (ss) label += ` · ${ss}`;
    label += ` · 부: ${fb}`;
    o.textContent = label;
    sel.appendChild(o);
  });

  if (prev && [...sel.options].some((opt) => opt.value === prev)) {
    sel.value = prev;
  }
  if (hint) {
    const base = `${items.length}명 · 부·자 연결이 있으면 아래에 트리로 표시됩니다.`;
    hint.textContent = treeGenFilter
      ? `${base} (필터: ${treeGenFilter.min}-${treeGenFilter.max}세)`
      : base;
  }
  const pickId = sel.value || (items[0] ? items[0].id : itemsAll[0]?.id);
  updateTreeDetailCard(pickId);
  void drawFamilyTree(pickId);
}

function setTreeGenFilter(min, max) {
  if (min == null || max == null) {
    treeGenFilter = null;
    treeViewMode = "default";
  } else {
    treeGenFilter = { min: Number(min), max: Number(max) };
    // (중요) 1-10세는 기존 전용 렌더러를 그대로 유지한다.
    // 11-20세는 1-10세와 "완전히 별도" 전용 렌더러를 사용한다.
    const k = `${treeGenFilter.min}-${treeGenFilter.max}`;
    if (k === "1-10") treeViewMode = "genrange_1_10";
    else if (k === "11-20") treeViewMode = "genrange_11_20";
    else if (k === "21-31") treeViewMode = "genrange_21_31";
    else treeViewMode = "default";
  }

  // 헤더 세대 버튼 활성 표시(선택 색상)
  try {
    const host = document.getElementById("hdr-submenu-tree");
    const btns = host ? Array.from(host.querySelectorAll("button[data-tree-gen]")) : [];
    const key =
      treeGenFilter && Number.isFinite(treeGenFilter.min) && Number.isFinite(treeGenFilter.max)
        ? `${treeGenFilter.min}-${treeGenFilter.max}`
        : "";
    btns.forEach((b) => {
      const gen = String(b.getAttribute("data-tree-gen") || "");
      let on = false;
      if (!key) on = false;
      else if (gen === "1-10" && key === "1-10") on = true;
      else if (gen === "11-20" && key === "11-20") on = true;
      else if (gen === "21-31" && key === "21-31") on = true;
      else if (gen === "32+" && treeGenFilter.min === 32) on = true;
      b.dataset.active = on ? "true" : "false";
    });
  } catch {
    // ignore
  }

  // 셀렉트 UI는 제거됐지만, 버튼 클릭 시 즉시 화면 갱신은 필요
  if (document.getElementById("view-tree") && !document.getElementById("view-tree")?.classList?.contains("hidden")) {
    void updateTreeView();
  }
}

async function fetchGenRangePeople(min, max) {
  // 서버에 action=genRange 구현을 권장. 없으면 null.
  const key = `${Number(min)}-${Number(max)}`;
  if (genRangePeopleCache.has(key)) return genRangePeopleCache.get(key);
  const json = await apiGetWait(
    { action: "genRange", min: String(min), max: String(max) },
    { maxAttempts: 8, retryDelayMs: 900 }
  );
  if (!json || typeof json !== "object") return null;
  const list = normalizeList(json, ["genRange", "people", "rows", "data", "items", "list"]);
  const out = Array.isArray(list) ? list : null;
  if (out) genRangePeopleCache.set(key, out);
  return out;
}

function pickExtraSmallLine(row) {
  if (!row || typeof row !== "object") return "";
  // people 시트 컬럼명이 '가지경로'/'참고'인 경우도 지원
  const a =
    pickFirstString(row, ["가지경로", "기타", "비고", "memo", "note"]) || "";
  const b =
    pickFirstString(row, ["참고", "분기", "branch", "파", "파계"]) || "";
  const aa = String(a || "").trim();
  const bb = String(b || "").trim();
  if (aa && bb && aa === bb) return aa; // 중복 제거
  return [aa, bb].filter(Boolean).join(" · ");
}

function paintGenRangeCircleTree(people, minGen, maxGen, wrap, svgEl) {
  const svg = d3.select(svgEl);
  svg.on(".zoom", null);
  svg.selectAll("*").remove();

  const width = wrap.clientWidth || 320;
  const height = wrap.clientHeight || 420;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const PAD_L = 44; // 왼쪽 세대 숫자 공간
  const PAD_T = 30;
  const ROW_GAP = 86; // 세대 간 y 간격
  const COL_GAP = 86; // 형제 간 x 간격
  const R = 18;

  const nodesRaw = annotatePeople(people).map((it) => {
    const g = readNodeGenLike(it.row);
    const fid = pickFirstString(it.row, PARENT_ID_KEYS);
    return {
      id: String(it.id),
      name: String(it.name || "").trim(),
      gen: typeof g === "number" ? g : null,
      fatherId: fid ? String(fid).trim() : "",
      extra: pickExtraSmallLine(it.row),
      row: it.row,
    };
  });

  // 1-10세 전용: 서버 세손이 불완전/불일치일 수 있으므로
  // "부친ID 체인"으로 세대를 다시 추정해 형제(같은 아버지ID)는 같은 줄에 오게 한다.
  const idTo = new Map(nodesRaw.map((n) => [n.id, n]));

  // 초기: gen이 minGen인 노드(루트)를 시작점으로 삼음. 없으면 가장 작은 gen을 루트로.
  const haveMinRoots = nodesRaw.some((n) => n.gen === minGen);
  const minExisting = nodesRaw
    .map((n) => n.gen)
    .filter((g) => typeof g === "number")
    .reduce((a, b) => Math.min(a, b), Infinity);
  const rootGen = haveMinRoots ? minGen : (Number.isFinite(minExisting) ? minExisting : minGen);

  // gen 추정치
  const inferred = new Map(); // id -> gen
  nodesRaw.forEach((n) => {
    if (n.gen === rootGen) inferred.set(n.id, rootGen);
  });

  // 전파: father(gen)+1
  // 여러 번 돌며 채움(최대 노드 수만큼)
  for (let iter = 0; iter < nodesRaw.length; iter++) {
    let changed = false;
    nodesRaw.forEach((n) => {
      const fid = n.fatherId;
      if (!fid) return;
      const fg = inferred.get(fid);
      if (typeof fg !== "number") return;
      const g2 = fg + 1;
      if (g2 < minGen || g2 > maxGen) return;
      if (!inferred.has(n.id) || inferred.get(n.id) !== g2) {
        inferred.set(n.id, g2);
        changed = true;
      }
    });
    if (!changed) break;
  }

  // 최종 nodes: inferred 우선, 없으면 기존 gen 사용
  const nodes = nodesRaw
    .map((n) => {
      const g = inferred.has(n.id) ? inferred.get(n.id) : n.gen;
      return { ...n, gen: typeof g === "number" ? g : null };
    })
    .filter((n) => typeof n.gen === "number" && n.gen >= minGen && n.gen <= maxGen);

  if (!nodes.length) {
    svg.append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 13)
      .text("해당 세대 범위의 인물이 없습니다.");
    return;
  }

  // gen -> nodes
  const byGen = new Map();
  nodes.forEach((n) => {
    if (!byGen.has(n.gen)) byGen.set(n.gen, []);
    byGen.get(n.gen).push(n);
  });

  const gens = [...byGen.keys()].sort((a, b) => a - b);
  const idToNode = new Map(nodes.map((n) => [n.id, n]));
  const idToX = new Map();
  const idToY = new Map();

  // 정렬: 부친ID → 본인ID (형제 나란히)
  gens.forEach((g) => {
    byGen.get(g).sort((a, b) => {
      const fa = a.fatherId || "";
      const fb = b.fatherId || "";
      if (fa !== fb) return compareClanMemberIds(fa, fb);
      return compareClanMemberIds(a.id, b.id);
    });
  });

  // 배치: 각 세대는 y 고정. x는 나열 후 1세를 중앙으로 보정
  gens.forEach((g, gi) => {
    const arr = byGen.get(g);
    arr.forEach((n, i) => {
      const x = PAD_L + 40 + i * COL_GAP;
      const y = PAD_T + (g - minGen) * ROW_GAP;
      idToX.set(n.id, x);
      idToY.set(n.id, y);
    });
  });

  // 1세를 화면 상단 중앙에 맞추기(1세가 있으면)
  const gen1 = byGen.get(minGen) || [];
  if (gen1.length) {
    // 1세 중 첫 번째 노드를 중앙으로
    const x0 = idToX.get(gen1[0].id);
    const dx = width / 2 - x0;
    nodes.forEach((n) => idToX.set(n.id, idToX.get(n.id) + dx));
  }

  const gRoot = svg.append("g").attr("class", "tree-zoom-inner");

  // 왼쪽 세대 숫자(1세,2세...)
  const gAxis = gRoot.append("g");
  gens.forEach((g) => {
    const y = PAD_T + (g - minGen) * ROW_GAP;
    gAxis.append("text")
      .attr("x", 14)
      .attr("y", y + 4)
      .attr("fill", "#78716c")
      .attr("font-size", 12)
      .attr("font-weight", 800)
      .text(`${g}세`);
  });

  // 연결선: 부-자 (2~10세)
  const links = [];
  nodes.forEach((n) => {
    if (!n.fatherId) return;
    // fatherId가 현재 범위 내에 있을 때만 연결
    if (!idToNode.has(n.fatherId)) return;
    links.push({ source: n.fatherId, target: n.id });
  });

  gRoot.append("g")
    .attr("fill", "none")
    .attr("stroke", "#d6d3d1")
    .attr("stroke-width", 1.2)
    .selectAll("path")
    .data(links)
    .join("path")
    .attr("d", (d) => {
      const x1 = idToX.get(d.source);
      const y1 = idToY.get(d.source);
      const x2 = idToX.get(d.target);
      const y2 = idToY.get(d.target);
      const midY = (y1 + y2) / 2;
      return `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
    });

  // 노드: 동그라미 + 이름 + (기타/분기)
  const nodeG = gRoot.append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("transform", (d) => `translate(${idToX.get(d.id)},${idToY.get(d.id)})`);

  nodeG.append("circle")
    .attr("r", R)
    .attr("fill", "#fff")
    .attr("stroke", "#166534")
    .attr("stroke-width", 1.6);

  nodeG.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em")
    .attr("font-size", 11.5)
    .attr("font-weight", 800)
    .attr("fill", "#166534")
    .text((d) => {
      const t = d.name || "";
      return t.length > 4 ? `${t.slice(0, 4)}…` : t;
    });

  nodeG.append("text")
    .attr("text-anchor", "middle")
    .attr("y", R + 16)
    .attr("font-size", 10)
    .attr("fill", "#78716c")
    .text((d) => d.extra || "");

  // zoom + 초기 맞춤
  const zoom = d3.zoom().scaleExtent([0.35, 2.8]).on("zoom", (event) => {
    gRoot.attr("transform", event.transform);
  });
  svg.call(zoom);

  // 기본은 “내용이 중앙에 오도록” 살짝 당김
  const initial = d3.zoomIdentity.translate(0, 0).scale(1);
  svg.call(zoom.transform, initial);
  attachTreeZoomState(svgEl, zoom, initial);
}

/**
 * 1-10세 전용(요청): 가로로 긴 캔버스 + 가로 스크롤.
 * - 세대는 x(열)로 배치
 * - 형제(동일 fatherId)는 id순으로 위/아래 배치하고 직사각형으로 묶음
 * - 원 안: 이름 + 세대수
 * - 원 밖: 참고/가지경로(가독성 있는 크기)
 */
function paintGenRangeHorizontalScrollTree(people, minGen, maxGen, wrap, svgEl) {
  // D3 zoom은 사용하지 않음(가로 스크롤)
  try {
    delete svgEl.__treeZoom;
  } catch {
    // ignore
  }
  // zoom 버튼은 제거됨. 불필요한 transform 잔재 제거
  try {
    svgEl.style.transform = "";
    svgEl.style.transformOrigin = "";
  } catch {
    // ignore
  }
  // 좌측 하단 +/−(간단 줌)용 상태 초기화
  svgEl.__treeZoom = { simple: true, scale: 1 };
  const svg = svgEl;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const widthHost = wrap.clientWidth || 360;
  const heightHost = wrap.clientHeight || 360;
  // 2페이지(좌: 1-5세 / 우: 6-10세). 한 페이지가 화면 폭 1개를 차지.
  const pageW = Math.max(320, widthHost);
  const PAD_L = 38;
  const PAD_T = 18;
  const PAD_B = 26;
  const pages = 2;
  const gensPerPage = 5;
  const COL_GAP = Math.max(92, Math.floor((pageW - PAD_L * 2) / (gensPerPage - 1))); // 기본 간격
  const ROW_GAP = 58;
  const GROUP_GAP = 20;
  const R = 18;
  const GEN_Y_STEP = 40; // (요청) 10세를 기준으로 윗세대는 위로
  const dyUp910 = Math.round((heightHost || 360) * 0.15); // (요청) 9·10세 묶음만 15% 위로

  const nodesRaw = annotatePeople(people).map((it) => {
    const g = readNodeGenLike(it.row);
    const fid = pickFirstString(it.row, PARENT_ID_KEYS);
    return {
      id: String(it.id),
      name: String(it.name || "").trim(),
      gen: typeof g === "number" ? g : null,
      fatherId: fid ? String(fid).trim() : "",
      extra: pickExtraSmallLine(it.row),
      row: it.row,
    };
  });

  // gen 추정: father(gen)+1 전파(기존 1-10 전용 로직 유지)
  const idTo = new Map(nodesRaw.map((n) => [n.id, n]));
  const haveMinRoots = nodesRaw.some((n) => n.gen === minGen);
  const minExisting = nodesRaw
    .map((n) => n.gen)
    .filter((g) => typeof g === "number")
    .reduce((a, b) => Math.min(a, b), Infinity);
  const rootGen = haveMinRoots ? minGen : (Number.isFinite(minExisting) ? minExisting : minGen);
  const inferred = new Map();
  nodesRaw.forEach((n) => {
    if (n.gen === rootGen) inferred.set(n.id, rootGen);
  });
  for (let iter = 0; iter < nodesRaw.length; iter++) {
    let changed = false;
    nodesRaw.forEach((n) => {
      if (!n.fatherId) return;
      const pg = inferred.get(n.fatherId);
      if (typeof pg !== "number") return;
      const want = pg + 1;
      if (!inferred.has(n.id)) {
        inferred.set(n.id, want);
        changed = true;
      }
    });
    if (!changed) break;
  }
  nodesRaw.forEach((n) => {
    if (typeof n.gen === "number") inferred.set(n.id, n.gen);
  });

  // (안정/정합) 1-10세 전용은 "부분 렌더"를 하지 않고 한 번에 전 범위를 그린다.
  // 부분 렌더는 앞/뒤 페이지가 비거나(앞만/뒤만) 깜빡이는 원인이 되었다.
  const renderMinGen = minGen;
  const renderMaxGen = maxGen;

  const nodes = nodesRaw
    .map((n) => ({ ...n, gen: inferred.get(n.id) ?? n.gen ?? null }))
    .filter((n) => typeof n.gen === "number" && n.gen >= renderMinGen && n.gen <= renderMaxGen);

  const idToName = new Map(nodesRaw.map((n) => [String(n.id), String(n.name || "").trim()]));
  const skipFatherNames = new Set(["경진", "언미", "습광"]);
  const shouldSkipFatherLine = (fatherId) => {
    const nm = idToName.get(String(fatherId)) || "";
    return skipFatherNames.has(String(nm).trim());
  };

  // 세대별 그룹(형제 묶음)
  const byGen = new Map();
  for (let g = minGen; g <= maxGen; g++) byGen.set(g, []);
  nodes.forEach((n) => byGen.get(n.gen).push(n));

  const idToPos = new Map(); // id -> {x,y,gen,fatherId,page}
  const groupBoxes = []; // {x,y,w,h,fatherId,yMid,xMidLeft,page}
  const groupLinks = []; // { fatherId, eldestId }
  const singleLinks = []; // { fatherId, xTo, yTo, page }

  let minYContent = Infinity;
  let maxYContent = -Infinity;
  let maxH = 220;
  // (요청) 세대 간격 구간별 조정 + 페이지 내 가운데 정렬
  const pageGens = [
    { page: 0, start: minGen, end: minGen + 4, multipliers: [0.9, 1, 1, 1] }, // 1-2는 10% 좁힘
    { page: 1, start: minGen + 5, end: minGen + 9, multipliers: [0.7, 0.7, 1, 1] }, // 6-7, 7-8은 30% 단축
  ];
  const xByGen = new Map(); // gen -> x
  pageGens.forEach((pg) => {
    const gaps = pg.multipliers.map((m) => COL_GAP * m);
    const span = gaps.reduce((a, b) => a + b, 0);
    const innerW = pageW - PAD_L * 2;
    const offset = Math.max(0, (innerW - span) / 2);
    let x = pg.page * pageW + PAD_L + offset;
    xByGen.set(pg.start, x);
    for (let i = 0; i < gaps.length; i++) {
      x += gaps[i];
      xByGen.set(pg.start + i + 1, x);
    }
  });

  for (let g = minGen; g <= maxGen; g++) {
    const arr = byGen.get(g) || [];
    // 같은 fatherId로 그룹. fatherId 없으면 1인 그룹
    const groups = new Map();
    arr.forEach((n) => {
      const k = n.fatherId ? `F:${n.fatherId}` : `S:${n.id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    });
    const orderedKeys = [...groups.keys()].sort((a, b) => {
      const fa = a.startsWith("F:") ? a.slice(2) : "";
      const fb = b.startsWith("F:") ? b.slice(2) : "";
      if (fa && fb) return compareClanMemberIds(fa, fb);
      if (fa) return -1;
      if (fb) return 1;
      return a.localeCompare(b, "en");
    });

    const pageIndex = g <= minGen + (gensPerPage - 1) ? 0 : 1;
    const x = xByGen.get(g) ?? (pageIndex * pageW + PAD_L);

    // (요청) 10세를 세로 70% 중심으로 두고, 윗대는 위로
    const yRef10 = PAD_T + (heightHost - PAD_T - PAD_B) * 0.7;
    const gen9Center = yRef10 - (maxGen - 9) * GEN_Y_STEP;
    // (요청) 6·7·8세는 9세와 같은 높이로(나란히)
    const targetCenter =
      g >= 6 && g <= 8
        ? gen9Center
        : (g === 9 || g === 10)
          ? gen9Center
          : yRef10 - (maxGen - g) * GEN_Y_STEP;

    // 이 세대(열)에서 필요한 총 높이를 먼저 계산해서 center 정렬
    const groupHeights = orderedKeys.map((k) => {
      const kids = groups.get(k) || [];
      const lastY = kids.length ? (kids.length - 1) * ROW_GAP : 0;
      const boxPad = 18;
      const h = kids.length >= 2 ? (lastY + boxPad * 2) : (R * 2);
      return h;
    });
    const columnH =
      groupHeights.reduce((a, b) => a + b, 0) +
      Math.max(0, groupHeights.length - 1) * GROUP_GAP +
      (groupHeights.length ? ROW_GAP : 0);
    let y = targetCenter - columnH / 2;
    // 화면 밖으로 너무 나가지 않게 클램프
    y = Math.max(PAD_T, Math.min(y, heightHost - PAD_B - columnH));

    const usedYs = [];
    const reserveY = (want) => {
      let y0 = want;
      const tooClose = (a, b) => Math.abs(a - b) < 34;
      while (usedYs.some((u) => tooClose(u, y0))) {
        y0 += 18;
      }
      usedYs.push(y0);
      return y0;
    };

    // (요청) 9세/10세는: 세대 내 전체 인물을 ID순으로 위↕아래 배치(중앙=8세 공우 기준 높이)
    // - 예: 3명이면 가운데 1명은 기준선, 나머지는 위/아래로
    // - 이 모드에서는 reserveY로 “흩어지지 않게” 그대로 배치한다.
    let fixedYById = null; // Map<id, y>
    if (Number(g) === 9 || Number(g) === 10) {
      const flat = [];
      orderedKeys.forEach((k) => {
        const kids = (groups.get(k) || []).slice().sort((a, b) => compareClanMemberIds(a.id, b.id));
        kids.forEach((n) => flat.push(n));
      });
      flat.sort((a, b) => compareClanMemberIds(a.id, b.id));
      fixedYById = new Map();
      // (요청) ID순 첫 번째가 기준선(gen9Center), 이후는 위↕아래로 번갈아 배치
      const zigzag = (idx) => {
        if (idx === 0) return 0;
        const n = Math.ceil(idx / 2);
        const sign = idx % 2 === 1 ? 1 : -1;
        return sign * n;
      };
      flat.forEach((n, idx) => {
        const yFixed = gen9Center + zigzag(idx) * ROW_GAP - dyUp910;
        fixedYById.set(String(n.id), yFixed);
      });

      // (요청) 특정 인물 위치 스왑
      const swapByName = (aName, bName) => {
        const a = flat.find((n) => String(n.name || "").trim() === aName);
        const b = flat.find((n) => String(n.name || "").trim() === bName);
        if (!a || !b) return;
        const ya = fixedYById.get(String(a.id));
        const yb = fixedYById.get(String(b.id));
        if (!Number.isFinite(ya) || !Number.isFinite(yb)) return;
        fixedYById.set(String(a.id), yb);
        fixedYById.set(String(b.id), ya);
      };
      if (Number(g) === 9) {
        // 9세: 용비 ↔ 용주
        swapByName("용비", "용주");
      }
      if (Number(g) === 10) {
        // 10세: 의 ↔ 영
        swapByName("의", "영");
      }
    }

    orderedKeys.forEach((k, kIdx) => {
      const kids = (groups.get(k) || []).slice().sort((a, b) => compareClanMemberIds(a.id, b.id));
      const topY = fixedYById
        ? Math.min(...kids.map((n) => fixedYById.get(String(n.id))).filter((v) => Number.isFinite(v)))
        : y;
      kids.forEach((n, i) => {
        let yy = fixedYById ? fixedYById.get(String(n.id)) : (y + i * ROW_GAP);
        // (요청) 6~9세 구간: 각 세대의 "첫번째 ID(정렬상 첫 원)"를 8세 공우와 같은 높이로 정렬
        // - 여기서는 8세 공우가 속한 기준선(=gen9Center)을 동일 기준으로 사용
        // - 정렬상 "첫 원" = 첫 그룹(kIdx=0)의 첫 자식(i=0)
        if (!fixedYById && kIdx === 0 && i === 0) {
          const gg = Number(g);
          if (gg >= 6 && gg <= 9) {
            yy = gen9Center;
            usedYs.push(yy); // 이후 형제/그룹이 너무 가까이 오지 않도록 예약
          }
        }
        // (요청) 1-2세, 6-8세: 단독 부자(형제 없는 경우)면 아버지와 같은 높이로 배치 → 직선 연결
        if (!fixedYById && kids.length === 1 && n.fatherId) {
          const gg = Number(g);
          const inBand = (gg === 2) || (gg >= 6 && gg <= 8);
          if (inBand) {
            const p = idToPos.get(String(n.fatherId));
            if (p && Number.isFinite(p.y)) yy = p.y;
          }
        }
        // 위에서 y를 강제한 경우(usedYs에 이미 push됨)는 reserveY를 건너뛰어 같은 높이를 유지
        if (!fixedYById && !(kIdx === 0 && i === 0 && Number(g) >= 6 && Number(g) <= 9)) {
          yy = reserveY(yy);
        }
        idToPos.set(n.id, { x, y: yy, gen: g, fatherId: n.fatherId, page: pageIndex });
        minYContent = Math.min(minYContent, yy);
        maxYContent = Math.max(maxYContent, yy);
      });
      const lastY = fixedYById
        ? Math.max(...kids.map((n) => fixedYById.get(String(n.id))).filter((v) => Number.isFinite(v)))
        : (y + (kids.length ? (kids.length - 1) * ROW_GAP : 0));
      const boxPadY = 18;
      if (kids.length >= 2) {
        const fatherId = k.startsWith("F:") ? k.slice(2) : "";
        const yMid = (topY + lastY) / 2;
        // (요청) 형제 묶음 박스 가로폭 = 원 지름(2R)
        const xLeft = x - R;
        groupBoxes.push({
          x: x - R,
          y: topY - boxPadY,
          w: R * 2,
          h: (lastY - topY) + boxPadY * 2,
          fatherId,
          yMid,
          xMidLeft: xLeft,
          page: pageIndex,
        });
        // (요청) 부모-자식 연결은 직선 1개만, 장자(=ID순 첫 번째 원)에 연결
        if (fatherId) {
          const eldestId = kids[0]?.id ? String(kids[0].id) : "";
          if (eldestId) groupLinks.push({ fatherId, eldestId });
        }
      } else if (kids.length === 1) {
        // (요청) 형제 없는 자식: 아버지↔자식은 직선 1개만
        const fatherId = k.startsWith("F:") ? k.slice(2) : "";
        if (fatherId) {
          singleLinks.push({
            fatherId,
            xTo: x - R,
            yTo: topY,
            page: pageIndex,
          });
        }
      }
      if (!fixedYById) {
        y = lastY + GROUP_GAP + ROW_GAP; // 다음 그룹 시작
      }
    });
    maxH = Math.max(maxH, y + 120);
  }

  const totalW = pageW * pages;
  const totalH = Math.max(360, Math.min(maxH, heightHost + 52));

  // 스크롤을 위해 실제 픽셀 폭을 크게 준다(뷰박스 스케일링 대신)
  svg.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);
  svg.setAttribute("width", String(totalW));
  svg.setAttribute("height", "100%");
  svg.style.width = `${totalW}px`;

  const NS = "http://www.w3.org/2000/svg";
  const gEdge = document.createElementNS(NS, "g");
  const gNode = document.createElementNS(NS, "g");
  // (요청) 전체 도형이 상단에 붙는 느낌 완화: 화면 높이의 10%만큼 아래로 이동
  const dyGlobal = Math.round((heightHost || 360) * 0.1);
  if (dyGlobal) {
    gEdge.setAttribute("transform", `translate(0,${dyGlobal})`);
    gNode.setAttribute("transform", `translate(0,${dyGlobal})`);
  }
  svg.appendChild(gEdge);
  svg.appendChild(gNode);

  // (요청) 5-6, 6-7, 7-8 세대 간 연결선: 각 세대의 "첫 번째 ID" 원끼리 연결
  const firstIdByGen = new Map(); // gen -> id
  for (let gg = minGen; gg <= maxGen; gg++) {
    const arr = (byGen.get(gg) || []).slice().sort((a, b) => compareClanMemberIds(a.id, b.id));
    if (arr.length) firstIdByGen.set(gg, String(arr[0].id));
  }
  const drawGenBridge = (a, b) => {
    const ida = firstIdByGen.get(a);
    const idb = firstIdByGen.get(b);
    if (!ida || !idb) return;
    const pa = idToPos.get(String(ida));
    const pb = idToPos.get(String(idb));
    if (!pa || !pb) return;
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", String(pa.x + R));
    l.setAttribute("y1", String(pa.y));
    l.setAttribute("x2", String(pb.x - R));
    l.setAttribute("y2", String(pb.y));
    l.setAttribute("stroke", "rgba(22, 101, 52, 0.28)");
    l.setAttribute("stroke-width", "1.1");
    l.setAttribute("stroke-linecap", "round");
    gEdge.appendChild(l);
  };
  drawGenBridge(5, 6);
  drawGenBridge(6, 7);
  drawGenBridge(7, 8);

  // 형제 그룹 박스(직사각형)
  groupBoxes.forEach((b) => {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", String(b.x));
    r.setAttribute("y", String(b.y));
    r.setAttribute("width", String(b.w));
    r.setAttribute("height", String(b.h));
    r.setAttribute("rx", "14");
    r.setAttribute("fill", "none");
    r.setAttribute("stroke", "rgba(0,0,0,0.22)");
    r.setAttribute("stroke-width", "1.1");
    gEdge.appendChild(r);
  });

  // 부모-자식 연결(요청): 직선 1개만, 장자의 원에 연결
  const seenGroup = new Set();
  groupLinks.forEach((ln) => {
    const k = `${ln.fatherId}|${ln.eldestId}`;
    if (seenGroup.has(k)) return;
    seenGroup.add(k);
    if (shouldSkipFatherLine(ln.fatherId)) return; // (요청) 특정 인물에서 나온 선 제거
    const s = idToPos.get(String(ln.fatherId));
    const t = idToPos.get(String(ln.eldestId));
    if (!s || !t) return;
    const fatherName = idToName.get(String(ln.fatherId)) || "";
    const childName = idToName.get(String(ln.eldestId)) || "";
    const x1 = s.x + R;
    const y1 = s.y;
    const x2 = t.x - R;
    const y2 = t.y;
    // (요청) 8세 공우 ↔ 9세 용비: 꺾은 직선
    if (String(fatherName).trim() === "공우" && String(childName).trim() === "용비") {
      const midX = (x1 + x2) / 2;
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", `M${x1},${y1} L${midX},${y1} L${midX},${y2} L${x2},${y2}`);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "rgba(22, 101, 52, 0.35)");
      p.setAttribute("stroke-width", "1.25");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      gEdge.appendChild(p);
      return;
    }
    // 기본: 직선 1개
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", String(x1));
    l.setAttribute("y1", String(y1));
    l.setAttribute("x2", String(x2));
    l.setAttribute("y2", String(y2));
    l.setAttribute("stroke", "rgba(22, 101, 52, 0.35)");
    l.setAttribute("stroke-width", "1.25");
    l.setAttribute("stroke-linecap", "round");
    gEdge.appendChild(l);
  });

  // 형제 없는 자식: 아버지 → 자식 직선
  singleLinks.forEach((ln) => {
    if (shouldSkipFatherLine(ln.fatherId)) return; // (요청) 특정 인물에서 나온 선 제거
    const s = idToPos.get(String(ln.fatherId));
    if (!s) return;
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", String(s.x + R));
    l.setAttribute("y1", String(s.y));
    l.setAttribute("x2", String(ln.xTo));
    l.setAttribute("y2", String(ln.yTo));
    l.setAttribute("stroke", "rgba(22, 101, 52, 0.35)");
    l.setAttribute("stroke-width", "1.25");
    l.setAttribute("stroke-linecap", "round");
    gEdge.appendChild(l);
  });

  // 노드(원 + 텍스트)
  nodes.forEach((n) => {
    const pos = idToPos.get(n.id);
    if (!pos) return;
    const gx = document.createElementNS(NS, "g");
    gx.setAttribute("transform", `translate(${pos.x},${pos.y})`);

    const c = document.createElementNS(NS, "circle");
    c.setAttribute("r", String(R));
    c.setAttribute("fill", "#fff");
    c.setAttribute("stroke", "#166534");
    c.setAttribute("stroke-width", "1.6");
    gx.appendChild(c);

    const name = (n.name || "?").trim();
    const nameShort = name.length > 4 ? `${name.slice(0, 4)}…` : name;

    const tx = document.createElementNS(NS, "text");
    tx.setAttribute("text-anchor", "middle");
    tx.setAttribute("fill", "#166534");
    tx.setAttribute("font-weight", "800");
    tx.setAttribute("font-size", "10.5");
    const t1 = document.createElementNS(NS, "tspan");
    t1.setAttribute("x", "0");
    t1.setAttribute("dy", "-0.15em");
    t1.textContent = nameShort;
    const t2 = document.createElementNS(NS, "tspan");
    t2.setAttribute("x", "0");
    t2.setAttribute("dy", "1.15em");
    t2.setAttribute("font-size", "9.5");
    t2.setAttribute("font-weight", "700");
    t2.textContent = `${pos.gen}세`;
    tx.appendChild(t1);
    tx.appendChild(t2);
    gx.appendChild(tx);

    // 원 밖(아래) 참고/가지경로 (요청: 진하게)
    const extra = String(n.extra || "").trim();
    if (extra) {
      const ex = document.createElementNS(NS, "text");
      ex.setAttribute("text-anchor", "middle");
      ex.setAttribute("y", String(R + 18));
      ex.setAttribute("font-size", "10.5");
      ex.setAttribute("fill", "#1c1917");
      ex.setAttribute("font-weight", "700");
      const shown = extra.length > 22 ? `${extra.slice(0, 22)}…` : extra;
      ex.textContent = shown;
      gx.appendChild(ex);
    }

    gNode.appendChild(gx);
  });

  // 세로 중앙 정렬(요청: 상단 치우침 방지) — 전체를 y축으로 이동
  try {
    if (Number.isFinite(minYContent) && Number.isFinite(maxYContent)) {
      const contentH = maxYContent - minYContent;
      const targetMid = (heightHost || totalH) / 2;
      const curMid = (minYContent + maxYContent) / 2;
      const dy = Math.max(-120, Math.min(120, targetMid - curMid));
      if (dy) {
        gEdge.setAttribute("transform", `translate(0,${dy})`);
        gNode.setAttribute("transform", `translate(0,${dy})`);
      }
    }
  } catch {
    // ignore
  }

  // 시작 시 1페이지(좌)로
  try {
    wrap.scrollLeft = 0;
  } catch {
    // ignore
  }
}

function initTreeMiniZoomButtons() {
  const wrap = document.getElementById("tree-svg-wrap");
  const svgEl = document.getElementById("tree-svg");
  const btnIn = document.getElementById("tree-zoom-in");
  const btnOut = document.getElementById("tree-zoom-out");
  if (!wrap || !svgEl || !btnIn || !btnOut) return;

  const apply = (scale) => {
    const s = Math.max(0.6, Math.min(1.7, Number(scale) || 1));
    svgEl.style.transformOrigin = "0 0";
    svgEl.style.transform = `scale(${s})`;
    svgEl.__treeZoom = { simple: true, scale: s };
  };

  btnIn.addEventListener("click", () => {
    const cur = Number(svgEl.__treeZoom?.scale || 1);
    apply(cur * 1.12);
  });
  btnOut.addEventListener("click", () => {
    const cur = Number(svgEl.__treeZoom?.scale || 1);
    apply(cur / 1.12);
  });
}

/**
 * 11-20세 전용(요청):
 * - 11세 "춘"을 루트로 둔다(선조와 연결선 없음).
 * - "춘"의 아들(= fatherId가 춘인 12세)마다 색상을 분리하고, 그 자손을 20세까지 표시.
 * - 가로로 긴 연표형: 위에 세대 구분선(11~20), 아래에 인물.
 * - 가지(아들 단위) 접기/펼치기 지원.
 * - 각 인물에는 시트의 참고열(참고/가지경로/비고 등) 표시.
 */
function paintGenRange11to20TimelineTree(people, minGen, maxGen, wrap, svgEl) {
  // (중요) 11-20세는 1-10세와 완전 독립 렌더러.
  // 지금 단계 목표: "세대별 컬럼 배치"만 먼저 정확히 고정.
  try {
    delete svgEl.__treeZoom;
  } catch {
    // ignore
  }
  try {
    svgEl.style.transform = "";
    svgEl.style.transformOrigin = "";
  } catch {
    // ignore
  }
  svgEl.__treeZoom = { simple: true, scale: 1 };
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

  const widthHost = wrap.clientWidth || 360;
  const heightHost = wrap.clientHeight || 360;

  const PAD_L = 18;
  const PAD_R = 18;
  const PAD_T = 14;
  const PAD_B = 16;
  // (요청) 세대 셀(컬럼) 크기를 줄여 가로 길이를 줄인다.
  const COL_W = 108;
  const COL_GAP = 10;
  const R = 14;
  const HEADER_H = 8; // 상단에는 세대 숫자만 남김(도형/컨트롤 제거)

  const gens = [];
  for (let g = minGen; g <= maxGen; g++) gens.push(g);

  const svg = d3.select(svgEl);

  const nodesRaw = annotatePeople(people).map((it) => {
    const g = readNodeGenLike(it.row);
    const fid = pickFirstString(it.row, PARENT_ID_KEYS);
    return {
      id: String(it.id),
      name: String(it.name || "").trim(),
      gen: typeof g === "number" ? g : null,
      fatherId: fid ? String(fid).trim() : "",
      extra: pickExtraSmallLine(it.row),
      row: it.row,
    };
  });

  const norm = (s) => String(s || "").replace(/\s+/g, "").trim();
  const root11 =
    nodesRaw.find((n) => n.gen === 11 && norm(n.name).includes("춘")) ||
    nodesRaw.find((n) => n.gen === 11) ||
    null;

  if (!root11) {
    // (중요) 11-20세는 타 렌더러(예: 1-10세)로 폴백하지 않는다.
    // 데이터가 예상과 다르면 "이 렌더러 안에서" 안전하게 실패 표시만 한다.
    svg
      .attr("viewBox", `0 0 ${widthHost} ${heightHost}`)
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 13)
      .text("11세 기준 인물(춘)을 찾지 못했습니다.");
    return;
  }

  const nodesInRange = nodesRaw.filter(
    (n) => typeof n.gen === "number" && n.gen >= minGen && n.gen <= maxGen
  );
  if (!nodesInRange.length) {
    svg.append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 13)
      .text("해당 세대 범위의 인물이 없습니다.");
    return;
  }

  // 춘 후손만 수집: fatherId 체인을 따라 내려가며 20세까지
  const childrenByFather = new Map();
  nodesInRange.forEach((n) => {
    const fid = String(n.fatherId || "").trim();
    if (!fid) return;
    if (!childrenByFather.has(fid)) childrenByFather.set(fid, []);
    childrenByFather.get(fid).push(n);
  });
  childrenByFather.forEach((arr) => arr.sort((a, b) => compareClanMemberIds(a.id, b.id)));

  const descendantsByGen = new Map();
  gens.forEach((g) => descendantsByGen.set(g, []));
  descendantsByGen.get(11).push(root11);

  const seen = new Set([String(root11.id)]);
  const q = [root11];
  while (q.length) {
    const cur = q.shift();
    const kids = childrenByFather.get(String(cur.id)) || [];
    kids.forEach((k) => {
      const id = String(k.id);
      if (seen.has(id)) return;
      seen.add(id);
      if (typeof k.gen === "number" && k.gen >= minGen && k.gen <= maxGen) {
        descendantsByGen.get(k.gen)?.push(k);
      }
      q.push(k);
    });
  }

  // 11세는 "춘만 남김"
  descendantsByGen.set(11, [root11]);
  gens.forEach((g) => {
    if (g === 11) return;
    const arr = descendantsByGen.get(g) || [];
    arr.sort((a, b) => compareClanMemberIds(a.id, b.id));
  });

  // 3단 접기 상태:
  // 1) 세대 컬럼 접기 2) 가지(12세 아들) 접기 3) 개인(해당 인물의 하위) 접기
  const stKey = "__tree11_20_fold3";
  const st = (svgEl[stKey] && typeof svgEl[stKey] === "object") ? svgEl[stKey] : {};
  if (!st.collapsedGens || !(st.collapsedGens instanceof Set)) st.collapsedGens = new Set();
  if (!st.collapsedBranches || !(st.collapsedBranches instanceof Set)) st.collapsedBranches = new Set();
  if (!st.collapsedPersons || !(st.collapsedPersons instanceof Set)) st.collapsedPersons = new Set();
  svgEl[stKey] = st;

  const isGenCollapsed = (g) => st.collapsedGens.has(String(g));
  const isBranchCollapsed = (bid) => st.collapsedBranches.has(String(bid));
  const isPersonCollapsed = (id) => st.collapsedPersons.has(String(id));

  // 가지(12세 아들) 판별: fatherId 체인으로 "춘의 아들"까지 끌어올림
  const idToNode = new Map(nodesRaw.map((n) => [String(n.id), n]));
  const branchOf = (node) => {
    if (!node) return "";
    if (String(node.id) === String(root11.id)) return String(root11.id);
    if (node.gen === 12 && String(node.fatherId) === String(root11.id)) return String(node.id);
    let cur = node;
    for (let guard = 0; guard < 50; guard++) {
      const pid = String(cur.fatherId || "").trim();
      if (!pid) return "";
      const p = idToNode.get(pid);
      if (!p) return "";
      if (p.gen === 12 && String(p.fatherId) === String(root11.id)) return String(p.id);
      cur = p;
    }
    return "";
  };

  // 접기 반영해서 "보이는 노드"만 다시 수집(BFS)
  const visibleByGen = new Map();
  gens.forEach((g) => visibleByGen.set(g, []));
  visibleByGen.set(11, [root11]); // 11세는 춘만 고정

  const seenV = new Set([String(root11.id)]);
  const qv = [root11];
  while (qv.length) {
    const cur = qv.shift();
    const cid = String(cur.id);
    if (cid !== String(root11.id) && isPersonCollapsed(cid)) {
      // 개인 접힘: 하위는 탐색하지 않음
      continue;
    }
    const kids = childrenByFather.get(cid) || [];
    kids.forEach((k) => {
      const id = String(k.id);
      if (seenV.has(id)) return;
      seenV.add(id);
      const g = Number(k.gen);
      if (!Number.isFinite(g) || g < minGen || g > maxGen) {
        qv.push(k);
        return;
      }
      if (g === 11) return; // 11세는 춘만
      if (isGenCollapsed(g)) return;
      const bid = branchOf(k);
      if (bid && bid !== String(root11.id) && isBranchCollapsed(bid)) return;
      visibleByGen.get(g)?.push(k);
      qv.push(k);
    });
  }
  gens.forEach((g) => {
    if (g === 11) return;
    const arr = visibleByGen.get(g) || [];
    arr.sort((a, b) => compareClanMemberIds(a.id, b.id));
  });

  // (표시용 예외) 형제 나란히 배치:
  // - 18세: 영권을 영균 바로 아래로
  // - 20세: 응운을 응세 바로 아래로
  const reorderAfterByName = (gen, nameA, nameB) => {
    const arr = visibleByGen.get(gen) || [];
    if (arr.length < 2) return;
    const nrm = (s) => String(s || "").replace(/\s+/g, "").trim();
    const ia = arr.findIndex((x) => nrm(x.name) === nrm(nameA));
    const ib = arr.findIndex((x) => nrm(x.name) === nrm(nameB));
    if (ia < 0 || ib < 0) return;
    if (ib === ia + 1) return; // already adjacent in desired order
    const b = arr.splice(ib, 1)[0];
    const newIa = arr.findIndex((x) => nrm(x.name) === nrm(nameA));
    if (newIa < 0) return;
    arr.splice(newIa + 1, 0, b);
    visibleByGen.set(gen, arr);
  };
  reorderAfterByName(18, "영균", "영권");
  reorderAfterByName(20, "응세", "응운");

  // 12세 가지 목록(브랜치 접기용 버튼)
  const branches12 = (childrenByFather.get(String(root11.id)) || [])
    .filter((n) => Number(n.gen) === 12)
    .slice()
    .sort((a, b) => compareClanMemberIds(a.id, b.id));

  // (요청) 12세 옥/윤/혁/연 가지별 고유 색상
  const normName = (s) => String(s || "").replace(/\s+/g, "").trim();
  const branchColorById = new Map(); // 12세(가지) id -> color
  const colorForBranchName = (nm) => {
    const t = normName(nm);
    if (t.includes("옥")) return "#2563eb"; // blue-600
    if (t.includes("윤")) return "#16a34a"; // green-600
    if (t.includes("혁")) return "#dc2626"; // red-600
    if (t.includes("연")) return "#7c3aed"; // violet-600
    return "#334155"; // slate-700 (기타)
  };
  branches12.forEach((b) => branchColorById.set(String(b.id), colorForBranchName(b.name)));

  const colorOfBranchId = (bid) => branchColorById.get(String(bid)) || "#334155";

  // (중요) "작아 보이는" 문제 해결:
  // - viewBox만 넓히면 요소 폭(100%)에 맞춰 자동 축소됨
  // - 11-20세는 SVG 요소 자체를 가로로 길게 만들어(픽셀 폭) 스크롤로 보이게 한다.
  const canvasW = Math.max(
    PAD_L + PAD_R + gens.length * COL_W + (gens.length - 1) * COL_GAP,
    widthHost
  );
  svg
    .attr("viewBox", `0 0 ${canvasW} ${heightHost}`)
    .attr("width", canvasW)
    .attr("height", heightHost);
  try {
    svgEl.style.width = `${canvasW}px`;
    svgEl.style.height = `${heightHost}px`;
  } catch {
    // ignore
  }

  // 세대 라벨(위) + 컬럼 박스(배치 기준)
  const grid = svg.append("g").attr("aria-label", "세대 컬럼");
  gens.forEach((g, idx) => {
    const x = PAD_L + idx * (COL_W + COL_GAP);
    grid.append("text")
      .attr("x", x + COL_W / 2)
      .attr("y", PAD_T + 12)
      .attr("text-anchor", "middle")
      .attr("font-size", 12)
      .attr("font-weight", 900)
      .attr("fill", "#0f172a")
      .text(`${g}세`);
    grid.append("rect")
      .attr("x", x)
      .attr("y", PAD_T + 22)
      .attr("width", COL_W)
      .attr("height", heightHost - PAD_T - PAD_B - 22)
      .attr("rx", 12)
      .attr("fill", "rgba(15,23,42,0.02)")
      .attr("stroke", "rgba(15,23,42,0.10)");
  });

  // 위치 계산(세로 꽉 차게)
  const colTop = PAD_T + HEADER_H + 18;
  const colBottom = heightHost - PAD_B - 18;
  // (요청) 세대 내 이름 위치(세로 간격) 7% 축소
  const colMid = (colTop + colBottom) / 2;
  const colHalf = ((colBottom - colTop) / 2) * 0.93;
  const colTopTight = colMid - colHalf;
  const colBottomTight = colMid + colHalf;
  const idToPos = new Map(); // id -> {x,y}

  // ---------------- 12세 규칙(요청) ----------------
  // - 아버지 id순으로 후대 자손을 렌더링
  // - 형제(같은 아버지)의 순서는 id순
  // - 균등 분배보다 "부자 연결이 보기 좋도록" 아버지 y를 기준으로 군집 배치
  const sortByFatherThenId = (list) => {
    const arr = Array.isArray(list) ? list.slice() : [];
    arr.sort((a, b) => {
      const fa = String(a?.fatherId || "").trim();
      const fb = String(b?.fatherId || "").trim();
      if (fa !== fb) return compareClanMemberIds(fa, fb);
      return compareClanMemberIds(String(a?.id || ""), String(b?.id || ""));
    });
    return arr;
  };
  gens.forEach((g) => {
    if (g < 12) return;
    const arr = visibleByGen.get(g) || [];
    if (!arr.length) return;
    visibleByGen.set(g, sortByFatherThenId(arr));
  });

  gens.forEach((g, idx) => {
    const x0 = PAD_L + idx * (COL_W + COL_GAP);
    const cx = x0 + COL_W / 2;
    const list = visibleByGen.get(g) || (g === 11 ? [root11] : []);
    const n = list.length;
    if (!n) return;
    if (n === 1) {
      idToPos.set(String(list[0].id), { x: cx, y: (colTopTight + colBottomTight) / 2 });
      return;
    }
    const step = (colBottomTight - colTopTight) / (n - 1);
    list.forEach((it, i) => {
      idToPos.set(String(it.id), { x: cx, y: colTopTight + step * i });
    });
  });

  // 아버지 y 기준 군집 배치(연결이 보기 좋도록)
  const clampY = (y) => Math.max(colTopTight, Math.min(colBottomTight, Number(y)));
  const computeFatherAlignedY = () => {
    // 세대별로 "현재 idToPos"를 바탕으로 아버지 y를 읽어서 자식 y를 재배치한다.
    for (const g of gens) {
      if (g < 12) continue;
      const arr = visibleByGen.get(g) || [];
      if (!arr.length) continue;

      // fatherId -> children
      const groups = new Map();
      arr.forEach((n) => {
        const fid = String(n?.fatherId || "").trim();
        const key = fid || `__no_father__:${String(n?.id || "")}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(n);
      });
      const orderedKeys = [...groups.keys()].sort((a, b) => {
        const fa = a.startsWith("__no_father__") ? "" : a;
        const fb = b.startsWith("__no_father__") ? "" : b;
        if (fa !== fb) return compareClanMemberIds(fa, fb);
        return a.localeCompare(b, "en");
      });

      // 간격: 너무 촘촘하면 선이 겹치고, 너무 넓으면 연결이 흐트러짐
      // (요청) 문중원(형제) 간격을 다시 30% 더 넓게(36 * 1.3 ≈ 46.8)
      const DY = 47;

      orderedKeys.forEach((key) => {
        const kids = groups.get(key) || [];
        kids.sort((a, b) => compareClanMemberIds(String(a.id), String(b.id)));
        const fid = key.startsWith("__no_father__") ? "" : key;
        const fp = fid ? idToPos.get(String(fid)) : null;
        if (!fp || typeof fp.y !== "number") {
          // 아버지 y를 모르면 기존 균등 배치 유지
          return;
        }
        const centerY = clampY(fp.y);
        const mid = (kids.length - 1) / 2;
        kids.forEach((k, i) => {
          const cur = idToPos.get(String(k.id));
          if (!cur) return;
          const want = centerY + (i - mid) * DY;
          idToPos.set(String(k.id), { x: cur.x, y: clampY(want) });
        });
      });
    }
  };
  computeFatherAlignedY();

  // ---- 표시 예외(교차 최소화/형제 정렬/선 단순화) ----
  // 1) "연의 여1"은 "회보" 위(바로 위)로: 같은 세대 목록 내 순서 조정
  // 2) "을보"의 아들 "사": 부자 연결선이 교차하지 않게 child y를 father y에 최대한 맞춤
  // 3) "흠조"의 아들 "윤석": 위와 동일
  // 4) "영권"의 아들 "난": 난을 영권 우측(x+)으로 보내 선을 단순화
  const nrmName = (s) => String(s || "").replace(/\s+/g, "").trim();
  const findNodeIdByName = (name) => {
    const t = nrmName(name);
    if (!t) return "";
    // visibleByGen을 우선(현재 화면에 보이는 인물)
    for (const g of gens) {
      const arr = visibleByGen.get(g) || [];
      const hit = arr.find((x) => nrmName(x.name) === t);
      if (hit) return String(hit.id);
    }
    // fallback: 전체 범위
    const hit2 = nodesInRange.find((x) => nrmName(x.name) === t);
    return hit2 ? String(hit2.id) : "";
  };

  const moveAboveByName = (nameA, nameB) => {
    const a = nrmName(nameA);
    const b = nrmName(nameB);
    if (!a || !b) return;
    for (const g of gens) {
      const arr = visibleByGen.get(g) || [];
      const ia = arr.findIndex((x) => nrmName(x.name) === a);
      const ib = arr.findIndex((x) => nrmName(x.name) === b);
      if (ia < 0 || ib < 0) continue;
      if (ia === ib - 1) return; // already right above
      const nodeA = arr.splice(ia, 1)[0];
      const ib2 = arr.findIndex((x) => nrmName(x.name) === b);
      if (ib2 < 0) return;
      arr.splice(Math.max(0, ib2), 0, nodeA);
      visibleByGen.set(g, arr);
      return;
    }
  };

  const nudgeUniqueY = (gen, wantY) => {
    // 같은 세대에서 y 충돌을 피하기 위한 미세 이동
    const arr = visibleByGen.get(gen) || [];
    const used = new Set(
      arr.map((n) => idToPos.get(String(n.id))?.y).filter((v) => typeof v === "number")
        .map((v) => Math.round(v))
    );
    let y = Number(wantY);
    let guard = 0;
    while (used.has(Math.round(y)) && guard < 40) {
      y += 12;
      if (y > colBottomTight) y = colTopTight + 6 * (guard % 3);
      guard += 1;
    }
    return Math.max(colTopTight, Math.min(colBottomTight, y));
  };

  const nudgeChildGroupByFatherName = (fatherName, dy) => {
    const fid = findNodeIdByName(fatherName);
    if (!fid) return;
    // 화면에 보이는 인물(visibleByGen) 중 fatherId가 일치하는 자식만 이동
    for (const g of gens) {
      if (g <= 11) continue;
      const arr = visibleByGen.get(g) || [];
      arr.forEach((n) => {
        if (String(n?.fatherId || "") !== String(fid)) return;
        const cid = String(n.id);
        const cp = idToPos.get(cid);
        if (!cp) return;
        const y2 = nudgeUniqueY(g, clampY(cp.y + Number(dy || 0)));
        idToPos.set(cid, { x: cp.x, y: y2 });
      });
    }
  };

  const alignXOffsetByName = (nameA, nameB) => {
    const a = findNodeIdByName(nameA);
    const b = findNodeIdByName(nameB);
    if (!a || !b) return;
    const bx = Number(xOffsetById.get(String(b)) || 0);
    xOffsetById.set(String(a), bx);
  };

  const alignChildToFatherByName = (fatherName, childName) => {
    const fid = findNodeIdByName(fatherName);
    const cid = findNodeIdByName(childName);
    if (!fid || !cid) return;
    const fp = idToPos.get(fid);
    const cp = idToPos.get(cid);
    if (!fp || !cp) return;
    const child = idToNode.get(cid);
    const gen = child?.gen;
    if (typeof gen !== "number") return;
    const y2 = nudgeUniqueY(gen, fp.y);
    idToPos.set(cid, { x: cp.x, y: y2 });
  };

  const xOffsetById = new Map(); // id -> dx
  const shiftRightOfByName = (childName, fatherName) => {
    const cid = findNodeIdByName(childName);
    const fid = findNodeIdByName(fatherName);
    if (!cid || !fid) return;
    const fp = idToPos.get(fid);
    const cp = idToPos.get(cid);
    if (!fp || !cp) return;
    // 같은 세대 컬럼의 중심 x에서 조금 우측으로
    xOffsetById.set(cid, Math.round(COL_W * 0.32));
    // y도 father에 약간 맞춤(선 단순화)
    const child = idToNode.get(cid);
    const gen = child?.gen;
    if (typeof gen === "number") {
      const y2 = nudgeUniqueY(gen, fp.y);
      idToPos.set(cid, { x: cp.x, y: y2 });
    }
  };

  // 1) 형제 정렬
  moveAboveByName("여1", "회보");
  // 정렬을 바꿨으니, 해당 세대는 y를 재분배(해당 세대만 다시)
  // (전체를 다시 계산하면 비용이 커서, 필요한 세대만 재배치)
  const maybeReflowGenByNames = (nameA, nameB) => {
    const a = nrmName(nameA);
    const b = nrmName(nameB);
    for (const g of gens) {
      const arr = visibleByGen.get(g) || [];
      if (!arr.some((x) => nrmName(x.name) === a) || !arr.some((x) => nrmName(x.name) === b)) continue;
      const idx = gens.indexOf(g);
      if (idx < 0) return;
      const x0 = PAD_L + idx * (COL_W + COL_GAP);
      const cx = x0 + COL_W / 2;
      const n = arr.length;
      if (!n) return;
      if (n === 1) {
        idToPos.set(String(arr[0].id), { x: cx, y: (colTopTight + colBottomTight) / 2 });
        return;
      }
      const step = (colBottomTight - colTopTight) / (n - 1);
      arr.forEach((it, i) => {
        idToPos.set(String(it.id), { x: cx, y: colTopTight + step * i });
      });
      return;
    }
  };
  maybeReflowGenByNames("여1", "회보");

  // 2) 교차 방지(부자 y 정렬)
  alignChildToFatherByName("을보", "사");
  alignChildToFatherByName("흠조", "윤석");

  // 3) 선 단순화(난을 영권 우측)
  shiftRightOfByName("난", "영권");

  // 4) (요청) 용견의 아들들을 조금 아래로 내려 현주의 여와 겹침 완화
  // dy는 "조금" 수준으로만 이동(과도 이동 방지)
  nudgeChildGroupByFatherName("용견", 18);

  // 5) (요청) 19세 난을 린과 같은 축(같은 x 오프셋)으로 맞추고,
  // 난의 아들 몽경이 제자리를 찾도록 난-몽경 연결을 더 직관적으로 정렬
  alignXOffsetByName("난", "린");
  alignChildToFatherByName("난", "몽경");

  // 막대선 연결(부→자): 스파인+가로바 형태
  const linkG = svg.append("g").attr("aria-label", "후손 연결선");
  const LINK_W = 6 * 0.9; // 굵기 10% 감소
  const OP_MAIN = 0.35 * 0.9; // 진하기 10% 감소
  const OP_SPINE = 0.26 * 0.9;
  const drawBarConnector = (px, py, childPoints, color) => {
    if (!childPoints.length) return;
    const xSpine = px + (COL_W + COL_GAP) / 2 - 10;
    const ys = childPoints.map((p) => p.y).sort((a, b) => a - b);
    const y1 = ys[0];
    const y2 = ys[ys.length - 1];
    const stroke = String(color || "rgba(15,23,42,0.22)");
    const soft = stroke.startsWith("rgba") ? stroke : stroke;
    // parent -> spine
    linkG.append("line")
      .attr("x1", px + R)
      .attr("y1", py)
      .attr("x2", xSpine)
      .attr("y2", py)
      .attr("stroke", soft)
      .attr("stroke-opacity", stroke.startsWith("rgba") ? 1 : OP_MAIN)
      .attr("stroke-width", LINK_W)
      .attr("stroke-linecap", "round");
    // spine
    linkG.append("line")
      .attr("x1", xSpine)
      .attr("y1", Math.min(py, y1))
      .attr("x2", xSpine)
      .attr("y2", Math.max(py, y2))
      .attr("stroke", soft)
      .attr("stroke-opacity", stroke.startsWith("rgba") ? 1 : OP_SPINE)
      .attr("stroke-width", LINK_W)
      .attr("stroke-linecap", "round");
    // spine -> each child
    childPoints.forEach((cp) => {
      linkG.append("line")
        .attr("x1", xSpine)
        .attr("y1", cp.y)
        .attr("x2", cp.x - R)
        .attr("y2", cp.y)
        .attr("stroke", soft)
        .attr("stroke-opacity", stroke.startsWith("rgba") ? 1 : OP_MAIN)
        .attr("stroke-width", LINK_W)
        .attr("stroke-linecap", "round");
    });
  };

  // 부모별로 보이는 자식 연결 그리기
  const visibleIds = new Set([...idToPos.keys()].map(String));
  [...visibleIds].forEach((pid) => {
    const ppos = idToPos.get(pid);
    if (!ppos) return;
    const kids = childrenByFather.get(pid) || [];
    const visibleKids = kids.filter((k) => visibleIds.has(String(k.id)));
    const childPoints = visibleKids.map((k) => idToPos.get(String(k.id))).filter(Boolean);
    if (!childPoints.length) return;

    // 연결선 색상: "자식이 속한 12세 가지" 색상(단, 11세→12세는 그 12세 본인 색)
    const firstKid = visibleKids[0];
    const bid = branchOf(firstKid);
    const color = bid && bid !== String(root11.id) ? colorOfBranchId(bid) : "rgba(15,23,42,0.22)";
    drawBarConnector(ppos.x, ppos.y, childPoints, color);
  });

  // 노드 렌더(클릭: 개인 접기/펼치기)
  const nodeG = svg.append("g").attr("aria-label", "인물 배치");
  gens.forEach((g, idx) => {
    const list = visibleByGen.get(g) || (g === 11 ? [root11] : []);
    list.forEach((n) => {
      const pos = idToPos.get(String(n.id));
      if (!pos) return;
      const dx = Number(xOffsetById.get(String(n.id)) || 0);
      const cx = pos.x + dx;
      const cy = pos.y;
      const nm = String(n.name || "").trim();
      const ex = String(n.extra || "").trim();
      const nmShort = nm.length > 6 ? `${nm.slice(0, 6)}…` : nm;

      const isCollapsed = isPersonCollapsed(String(n.id));
      const bid = branchOf(n);
      const nodeStroke =
        g === 11
          ? "#0f172a"
          : (bid && bid !== String(root11.id) ? colorOfBranchId(bid) : "rgba(15,23,42,0.35)");
      const gNode = nodeG.append("g")
        .attr("transform", `translate(${cx},${cy})`)
        .style("cursor", g === 11 ? "default" : "pointer")
        .on("click", () => {
          if (g === 11) return;
          const key = String(n.id);
          if (st.collapsedPersons.has(key)) st.collapsedPersons.delete(key);
          else st.collapsedPersons.add(key);
          paintGenRange11to20TimelineTree(people, minGen, maxGen, wrap, svgEl);
        });
      gNode.append("circle")
        .attr("r", R)
        .attr("fill", isCollapsed ? "rgba(15,23,42,0.06)" : "rgba(255,255,255,0.92)")
        .attr("stroke", nodeStroke)
        .attr("stroke-width", g === 11 ? 2 : 1.7);
      gNode.append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.35em")
        .attr("font-size", 11.5)
        .attr("font-weight", 900)
        .attr("fill", g === 11 ? "#0f172a" : "rgba(15,23,42,0.9)")
        .text(nmShort || String(n.id));

      if (ex) {
        const exShort = ex.length > 14 ? `${ex.slice(0, 14)}…` : ex;
        gNode.append("text")
          .attr("text-anchor", "middle")
          .attr("y", R + 14)
          .attr("font-size", 10)
          .attr("font-weight", 800)
          .attr("fill", "rgba(15,23,42,0.62)")
          .text(exShort);
      }
    });
  });
}

function toggleGen21UI(on) {
  const baseWrap = document.getElementById("tree-svg-wrap");
  const gen21Wrap = document.getElementById("tree-gen21-wrap");
  if (baseWrap) baseWrap.classList.toggle("hidden", !!on);
  if (gen21Wrap) gen21Wrap.classList.toggle("hidden", !on);
}

function renderGen21PickButtons(people21to25) {
  const host = document.getElementById("tree-gen21-pick25");
  const hint = document.getElementById("tree-gen21-top-hint");
  if (!host) return;
  host.innerHTML = "";

  const itemsAll = annotatePeople(Array.isArray(people21to25) ? people21to25 : []).map((it) => ({
    id: String(it.id),
    name: String(it.name || "").trim(),
    gen: readNodeGenLike(it.row),
  }));
  const list25 = itemsAll
    .filter((x) => Number(x.gen) === 25)
    .sort((a, b) => compareClanMemberIds(a.id, b.id));

  const picks = list25.slice(0, 4); // (요청) 25세 4명을 선택 버튼으로 표시
  if (hint) {
    hint.textContent = "상단(21–25) 렌더링 방식은 미정 · 25세 시조 선택만 고정";
  }
  if (!picks.length) {
    host.innerHTML = `<span class="text-[11px] text-stone-500">25세 인물이 없습니다.</span>`;
    return;
  }

  if (!gen21SelectedRootId || !picks.some((p) => p.id === String(gen21SelectedRootId))) {
    gen21SelectedRootId = picks[0].id;
  }

  picks.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "rounded-full border border-stone-200 bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-stone-700 hover:bg-stone-50";
    btn.dataset.active = p.id === String(gen21SelectedRootId) ? "true" : "false";
    btn.textContent = `${p.name || p.id}`;
    btn.addEventListener("click", () => {
      gen21SelectedRootId = p.id;
      // 버튼 active 갱신
      try {
        host.querySelectorAll("button").forEach((b) => (b.dataset.active = "false"));
        btn.dataset.active = "true";
      } catch {
        // ignore
      }
      void updateTreeView(); // 21-31 전용 하단 재렌더
    });
    host.appendChild(btn);
  });
}

function paintTreeLikeEightKinRenderer(rows, rootId, wrap, svgEl) {
  // (중요) 8촌 친척 트리 구현 방식(기존): tree graph이면 paintD3TreeLayout를 사용한다.
  const svg = d3.select(svgEl);
  svg.on(".zoom", null);
  svg.selectAll("*").remove();
  try {
    delete svgEl.__treeZoom;
  } catch {
    // ignore
  }

  const list = Array.isArray(rows) ? rows : [];
  const rid = String(rootId || "").trim() || (list[0] ? String(list[0].id) : "");
  if (!rid || !list.length) {
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 12.5)
      .text("표시할 데이터가 없습니다.");
    return;
  }

  const idSet = new Set(list.map((r) => String(r.id)));
  const stratRows = list.map((r) => {
    const id = String(r.id);
    const parentId = id === rid ? "" : String(r.parentId || "").trim();
    // 부모가 목록에 없으면(직계 밖/데이터 누락) 루트로 올려 안전하게 표시
    const safeParent = parentId && idSet.has(parentId) ? parentId : "";
    return { ...r, id, parentId: safeParent };
  });

  let root;
  try {
    root = d3
      .stratify()
      .id((d) => d.id)
      .parentId((d) => d.parentId || "")(stratRows);
  } catch {
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 12.5)
      .text("트리 데이터 구성이 올바르지 않습니다.");
    return;
  }
  paintD3TreeLayout(root, rid, wrap, svgEl, false);
}

function paintGenRange21to31DescEightRule(rootId, people, minGen, maxGen, wrap, svgEl) {
  // (중요) 21-31세 하단 렌더링 규칙은 "8촌 친척 트리 구현 방식"을 그대로 사용한다.
  const rid = String(rootId || "").trim();
  const svg = d3.select(svgEl);
  svg.on(".zoom", null);
  svg.selectAll("*").remove();
  if (!rid) {
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 12.5)
      .text("25세 시조를 선택하세요.");
    return;
  }

  const nodesRaw = annotatePeople(Array.isArray(people) ? people : []).map((it) => {
    const g = readNodeGenLike(it.row);
    const fid = pickFirstString(it.row, PARENT_ID_KEYS);
    return {
      id: String(it.id),
      name: String(it.name || "").trim(),
      gen: typeof g === "number" ? g : null,
      fatherId: fid ? String(fid).trim() : "",
      row: it.row,
    };
  });
  const idToNode = new Map(nodesRaw.map((n) => [String(n.id), n]));
  const root = idToNode.get(rid);
  if (!root) {
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 12.5)
      .text("선택된 25세 시조를 데이터에서 찾지 못했습니다.");
    return;
  }

  // children map
  const childrenByFather = new Map();
  nodesRaw.forEach((n) => {
    const fid = String(n.fatherId || "").trim();
    if (!fid) return;
    if (!childrenByFather.has(fid)) childrenByFather.set(fid, []);
    childrenByFather.get(fid).push(n);
  });
  childrenByFather.forEach((arr) => arr.sort((a, b) => compareClanMemberIds(a.id, b.id)));

  // 직계 후손만 수집(BFS) + 범위(21-31) 내만 렌더링
  const keep = new Map(); // id -> node
  const seen = new Set([rid]);
  const q = [root];
  while (q.length) {
    const cur = q.shift();
    const kids = childrenByFather.get(String(cur.id)) || [];
    kids.forEach((k) => {
      const id = String(k.id);
      if (seen.has(id)) return;
      seen.add(id);
      q.push(k);
    });
  }
  // 루트 + 후손 중 범위 내만 keep
  nodesRaw.forEach((n) => {
    const id = String(n.id);
    if (!seen.has(id)) return;
    if (typeof n.gen !== "number") return;
    if (n.gen < minGen || n.gen > maxGen) return;
    keep.set(id, n);
  });
  // 루트는 반드시 포함
  if (typeof root.gen === "number" && root.gen >= minGen && root.gen <= maxGen) {
    keep.set(rid, root);
  }

  const rows = [...keep.values()]
    .map((n) => ({
      id: String(n.id),
      parentId: String(n.fatherId || "").trim(),
      name: String(n.name || n.id).trim(),
      row: n.row,
    }))
    .sort((a, b) => {
      // 8촌 규칙 정렬: parentId -> id
      const fa = String(a.parentId || "");
      const fb = String(b.parentId || "");
      if (fa !== fb) return compareClanMemberIds(fa, fb);
      return compareClanMemberIds(String(a.id), String(b.id));
    });

  if (!rows.length) {
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 12.5)
      .text("표시할 직계 후손 데이터가 없습니다.");
    return;
  }

  paintTreeLikeEightKinRenderer(rows, rid, wrap, svgEl);
}

async function updateTreeView() {
  const svgEl = document.getElementById("tree-svg");
  const wrap = document.getElementById("tree-svg-wrap");
  const hint = document.getElementById("tree-hint");
  if (!svgEl || !wrap || typeof d3 === "undefined") return;

  // 21-31세 전용 UI 표시/숨김
  toggleGen21UI(treeViewMode === "genrange_21_31" && !!treeGenFilter);

  if (!lastSearchRows.length) {
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    svg.append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 13)
      .text("홈에서 세보를 검색한 뒤 기준 인물을 선택하세요.");
    if (hint) hint.textContent = "";
    // 검색이 없어도 genRange(서버)로 그릴 수 있으면 그린다
    if (
      (treeViewMode === "genrange_1_10" || treeViewMode === "genrange_11_20" || treeViewMode === "genrange_21_31") &&
      treeGenFilter
    ) {
      let people = null;
      try {
        people = await fetchGenRangePeople(treeGenFilter.min, treeGenFilter.max);
      } catch {
        people = null;
      }
      if (people && people.length) {
        if (hint) hint.textContent = `표시 범위: ${treeGenFilter.min}-${treeGenFilter.max}세 (전용 트리)`;
        if (treeViewMode === "genrange_11_20") {
          paintGenRange11to20TimelineTree(people, 11, 20, wrap, svgEl);
        } else if (treeViewMode === "genrange_21_31") {
          // 21-31세 전용: 상단(21-25) + 하단(25시조→31) 렌더
          const topWrap = document.getElementById("tree-gen21-top-svg-wrap");
          const topSvg = document.getElementById("tree-gen21-top-svg");
          const bottomWrap = document.getElementById("tree-gen21-bottom-svg-wrap");
          const bottomSvg = document.getElementById("tree-gen21-bottom-svg");
          const bottomHint = document.getElementById("tree-gen21-bottom-hint");
          if (topWrap && topSvg && bottomWrap && bottomSvg) {
            renderGen21PickButtons(people);
            // 상단 렌더링은 미정: 현재는 안내 텍스트만 표시
            const s = d3.select(topSvg);
            s.selectAll("*").remove();
            s
              .append("text")
              .attr("x", "50%")
              .attr("y", "50%")
              .attr("text-anchor", "middle")
              .attr("fill", "#78716c")
              .attr("font-size", 12.5)
              .text("상단(21–25) 렌더링 방식은 추후 결정");

            if (bottomHint) bottomHint.textContent = gen21SelectedRootId ? `시조(25세): ${gen21SelectedRootId}` : "25세 시조를 선택하세요.";
            paintGenRange21to31DescEightRule(gen21SelectedRootId, people, 21, 31, bottomWrap, bottomSvg);
          }
          return;
        } else {
          // 1-10세 전용 렌더러(건드리지 않음)
          paintGenRangeHorizontalScrollTree(people, 1, 10, wrap, svgEl);
        }
        return;
      }
    }
    return;
  }

  if (
    (treeViewMode === "genrange_1_10" || treeViewMode === "genrange_11_20" || treeViewMode === "genrange_21_31") &&
    treeGenFilter
  ) {
    if (hint) hint.textContent = `표시 범위: ${treeGenFilter.min}-${treeGenFilter.max}세 (전용 트리)`;
    // 서버 genRange가 있으면 사용, 없으면 현재 검색 결과에서만 구성
    let people = await fetchGenRangePeople(treeGenFilter.min, treeGenFilter.max);
    if (!people) people = lastSearchRows;
    if (!people || !people.length) {
      const svg = d3.select(svgEl);
      svg.selectAll("*").remove();
      svg.append("text")
        .attr("x", "50%")
        .attr("y", "50%")
        .attr("text-anchor", "middle")
        .attr("fill", "#78716c")
        .attr("font-size", 12.5)
        .text(
          treeViewMode === "genrange_11_20"
            ? "11-20세 트리를 그릴 데이터가 없습니다. 서버에 action=genRange(min,max)를 추가해 주세요."
            : treeViewMode === "genrange_21_31"
              ? "21-31세 트리를 그릴 데이터가 없습니다. 서버에 action=genRange(min,max)를 추가해 주세요."
              : "1-10세 트리를 그릴 데이터가 없습니다. 서버에 action=genRange(min,max)를 추가해 주세요."
        );
      return;
    }
    if (treeViewMode === "genrange_11_20") {
      paintGenRange11to20TimelineTree(people, 11, 20, wrap, svgEl);
    } else if (treeViewMode === "genrange_21_31") {
      const topWrap = document.getElementById("tree-gen21-top-svg-wrap");
      const topSvg = document.getElementById("tree-gen21-top-svg");
      const bottomWrap = document.getElementById("tree-gen21-bottom-svg-wrap");
      const bottomSvg = document.getElementById("tree-gen21-bottom-svg");
      const bottomHint = document.getElementById("tree-gen21-bottom-hint");
      if (topWrap && topSvg && bottomWrap && bottomSvg) {
        renderGen21PickButtons(people);
        const s = d3.select(topSvg);
        s.selectAll("*").remove();
        s
          .append("text")
          .attr("x", "50%")
          .attr("y", "50%")
          .attr("text-anchor", "middle")
          .attr("fill", "#78716c")
          .attr("font-size", 12.5)
          .text("상단(21–25) 렌더링 방식은 추후 결정");
        if (bottomHint) bottomHint.textContent = gen21SelectedRootId ? `시조(25세): ${gen21SelectedRootId}` : "25세 시조를 선택하세요.";
        paintGenRange21to31DescEightRule(gen21SelectedRootId, people, 21, 31, bottomWrap, bottomSvg);
      }
    } else {
      // 1-10세 전용 렌더러(건드리지 않음)
      paintGenRangeHorizontalScrollTree(people, 1, 10, wrap, svgEl);
    }
    // 전체를 한 번에 그리므로 스크롤 중 재렌더는 하지 않는다(깜빡임/속도 저하 방지).
    return;
  }

  // 기본(기존) 렌더
  toggleGen21UI(false);
  if (hint) {
    hint.textContent = treeGenFilter
      ? `표시 범위: ${treeGenFilter.min}-${treeGenFilter.max}세`
      : "표시 범위: 전체";
  }
  const focus = selectedPersonId || annotatePeople(lastSearchRows)[0]?.id || null;
  await drawFamilyTree(focus);
}

/**
 * 1) API action=getTree&id=… (중첩 JSON 또는 flat id/parentId)
 * 2) 실패 시 검색 결과(lastSearchRows)로 클라이언트 트리
 */
async function drawFamilyTree(focusId) {
  const svgEl = document.getElementById("tree-svg");
  const wrap = document.getElementById("tree-svg-wrap");
  const hint = document.getElementById("tree-hint");
  if (!svgEl || !wrap || typeof d3 === "undefined") return;

  try {
    delete svgEl.__treeZoom;
  } catch {
    // ignore
  }

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  // (요청) 각 박스의 개인 트리(getTree 기반)는 현재 표시하지 않음.
  // 향후 세대별/전용 트리 UI가 설치될 예정이므로, 여기서는 SVG를 비워 둔다.
  if (hint) hint.textContent = "";
  return;

  if (!focusId || !lastSearchRows.length) {
    updateTreeDetailCard(null);
    if (hint) {
      hint.textContent = lastSearchRows.length
        ? "표시할 기준 인물이 없습니다."
        : "홈에서 세보를 검색한 뒤 기준 인물을 선택해 주세요.";
    }
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 13)
      .text("홈에서 세보를 검색한 뒤 인물을 선택하세요.");
    return;
  }

  updateTreeDetailCard(focusId);
  if (hint) {
    hint.textContent = treeGenFilter
      ? `표시 범위: ${treeGenFilter.min}-${treeGenFilter.max}세`
      : "표시 범위: 전체";
  }

  const treeJson = await apiGetSilent({ action: "getTree", id: focusId });

  const nested = extractNestedTreeRoot(treeJson);
  if (nested) {
    try {
      const hRoot = d3.hierarchy(nested, (d) =>
        d.children && d.children.length ? d.children : null
      );
      if (hRoot) {
        if (hint) hint.textContent = "서버 트리(getTree · 중첩 JSON)";
        paintD3TreeLayout(hRoot, focusId, wrap, svgEl, true);
        return;
      }
    } catch (err) {
      console.warn("getTree hierarchy", err);
    }
  }

  const flatStrat = flatRowsForStratifyFromGetTree(treeJson, focusId);
  if (flatStrat && flatStrat.length) {
    try {
      const sRoot = d3
        .stratify()
        .id((d) => d.id)
        .parentId((d) => d.parentId)(flatStrat);
      if (hint) hint.textContent = "서버 트리(getTree · 표 형식)";
      paintD3TreeLayout(sRoot, focusId, wrap, svgEl, false);
      return;
    } catch (err) {
      console.warn("getTree stratify", err);
    }
  }

  if (hint) {
    hint.textContent =
      "getTree 없음 또는 형식 불일치 · 검색 결과의 부·자 연결로 표시합니다.";
  }

  // 세대 필터가 있으면: 해당 범위만 표시(검색 결과 기반)
  const basePeople = Array.isArray(lastSearchRows) ? lastSearchRows : [];
  const filteredPeople =
    treeGenFilter && Number.isFinite(treeGenFilter.min) && Number.isFinite(treeGenFilter.max)
      ? basePeople.filter((r) => {
          const g = readNodeGenLike(r);
          return typeof g === "number" && g >= treeGenFilter.min && g <= treeGenFilter.max;
        })
      : basePeople;

  if (treeGenFilter && filteredPeople.length === 0) {
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 13)
      .text("해당 세대 범위의 인물이 없습니다.");
    return;
  }

  // focusId가 필터 결과에 없으면 첫 인물로 대체
  const annotated = annotatePeople(filteredPeople);
  const idSet = new Set(annotated.map((x) => String(x.id)));
  const effectiveFocus = idSet.has(String(focusId)) ? focusId : (annotated[0]?.id || focusId);

  const fullRows = buildGraphRows(filteredPeople);
  const treeRows = descendantStratifyRows(fullRows, effectiveFocus);

  if (!treeRows.length) {
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("fill", "#78716c")
      .attr("font-size", 13)
      .text("표시할 인물이 없습니다.");
    return;
  }

  let root;
  try {
    root = d3
      .stratify()
      .id((d) => d.id)
      .parentId((d) => d.parentId)(treeRows);
  } catch (err) {
    console.warn(err);
    if (hint) hint.textContent += " (트리 구성 오류 — 부모·자식 id를 확인하세요.)";
    svg
      .append("text")
      .attr("x", "50%")
      .attr("y", "50%")
      .attr("text-anchor", "middle")
      .attr("fill", "#b91c1c")
      .attr("font-size", 12)
      .text("가계도를 구성할 수 없습니다. 데이터의 부모 참조를 확인하세요.");
    return;
  }

  paintD3TreeLayout(root, effectiveFocus, wrap, svgEl, false);
}

function initTreeControls() {
  const sel = document.getElementById("tree-person-select");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const v = sel.value;
    updateTreeDetailCard(v || null);
    void drawFamilyTree(v || null);
  });
}

/** 촌수 계산: 입력이 문중원ID 형태면 true (숫자만, 1~24자리) */
function kinshipInputLooksLikeId(raw) {
  return /^\d{1,24}$/.test(String(raw || "").trim());
}

/** rows에서 이름(공백 무시·소문자 비한글 무해) 일치 행 수집 */
function kinshipRowsMatchingName(nameQuery, rows) {
  const norm = (s) =>
    String(s || "")
      .trim()
      .replace(/\s+/g, "")
      .toLowerCase();
  const q = norm(nameQuery);
  if (!q) return [];
  const out = [];
  (rows || []).forEach((row, idx) => {
    if (!row || typeof row !== "object") return;
    const nm = norm(pickFirstString(row, NAME_KEYS));
    if (nm && nm === q) out.push({ row, idx });
  });
  return out;
}

function hideKinshipDisambig() {
  const el = document.getElementById("kinship-disambig");
  if (el) {
    el.classList.add("hidden");
    el.innerHTML = "";
  }
}

/**
 * @param {{ slot: number, candidates: { id: string, row: object }[] }[]} sections
 */
function renderKinshipDisambig(sections) {
  const host = document.getElementById("kinship-disambig");
  if (!host) return;
  if (!sections || !sections.length) {
    hideKinshipDisambig();
    return;
  }
  host.classList.remove("hidden");
  const parts = [];
  sections.forEach((sec, si) => {
    const label = sec.slot === 1 ? "①" : "②";
    parts.push(
      `<p class="mb-1 text-[10px] font-semibold text-stone-600 ${si ? "mt-3 border-t border-stone-200/80 pt-2" : ""}">${label} 동명이인이 있습니다. 해당하는 한 분을 누르면 ID로 바꾼 뒤 다시 계산합니다.</p>`
    );
    for (const c of sec.candidates) {
      const nm = escapeHtml(pickFirstString(c.row, NAME_KEYS) || "?");
      const ses = escapeHtml(formatSesongLine(c.row) || "");
      const dad = escapeHtml(formatFatherBrief(c.row));
      const id = escapeHtml(String(c.id));
      parts.push(
        `<button type="button" class="kinship-pick mb-1.5 block w-full max-w-full rounded-lg border border-stone-300 bg-white px-2.5 py-2 text-left text-[11px] text-ink-800 transition hover:bg-stone-50" data-slot="${sec.slot}" data-id="${id}"><span class="font-semibold">${nm}</span>${ses ? ` · ${ses}` : ""}<span class="text-stone-600"> · 부친 ${dad}</span> · <span class="font-medium text-seal">ID ${id}</span></button>`
      );
    }
  });
  host.innerHTML = parts.join("");
  host.querySelectorAll(".kinship-pick").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const sl = Number(btn.getAttribute("data-slot"));
      const inp = document.getElementById(sl === 1 ? "kinship-id1" : "kinship-id2");
      if (inp) inp.value = id;
      hideKinshipDisambig();
      document.getElementById("kinship-calc-btn")?.click();
    });
  });
}

/**
 * @returns {Promise<{ ok: true, id: string } | { ok: false, message?: string, ambiguous?: true, slot?: number, candidates?: {id:string,row:object}[] }>}
 */
async function resolveKinshipSlotInput(raw, slot) {
  const q = String(raw || "").trim();
  if (!q) return { ok: false, message: "입력이 비어 있습니다." };
  if (kinshipInputLooksLikeId(q)) return { ok: true, id: q };

  let matched = kinshipRowsMatchingName(q, lastSearchRows);
  if (!matched.length) {
    try {
      const data = await fetchSebo(q);
      const rows = normalizeRows(data);
      matched = kinshipRowsMatchingName(q, rows);
    } catch {
      return {
        ok: false,
        message: `「${q}」검색에 실패했습니다. 문중원ID를 입력하거나, 홈에서 이름 검색 후 다시 시도해 주세요.`,
      };
    }
  }

  const byId = new Map();
  matched.forEach(({ row, idx }) => {
    const id = String(getClanMemberId(row, idx)).trim();
    if (!id || id.startsWith("idx_")) return;
    if (!byId.has(id)) byId.set(id, row);
  });
  const candidates = [...byId.entries()].slice(0, 8).map(([id, row]) => ({ id, row }));
  if (!candidates.length) {
    return { ok: false, message: `「${q}」과(와) 일치하는 사람을 찾지 못했습니다.` };
  }
  if (candidates.length === 1) return { ok: true, id: candidates[0].id };
  return { ok: false, ambiguous: true, slot, candidates };
}

function initPersonDetailActions() {
  document.getElementById("btn-open-tree-tab")?.addEventListener("click", () => {
    showView("view-tree");
    if (selectedPersonId) {
      const sel = document.getElementById("tree-person-select");
      if (sel && [...sel.options].some((o) => o.value === selectedPersonId)) {
        sel.value = selectedPersonId;
      }
      void drawFamilyTree(selectedPersonId);
    }
  });

  document.getElementById("kinship-calc-btn")?.addEventListener("click", async () => {
    const raw1 = document.getElementById("kinship-id1")?.value?.trim() ?? "";
    const raw2 = document.getElementById("kinship-id2")?.value?.trim() ?? "";
    const out = document.getElementById("kinship-calc-result");
    const visualBtn = document.getElementById("kinship-visual-btn");
    const visualHint = document.getElementById("kinship-visual-hint");
    const visualWrap = document.getElementById("kinship-visual");
    hideKinshipDisambig();
    if (!raw1 || !raw2) {
      window.alert("①·②에 문중원ID 또는 이름을 모두 입력해 주세요.");
      return;
    }

    const [r1, r2] = await Promise.all([
      resolveKinshipSlotInput(raw1, 1),
      resolveKinshipSlotInput(raw2, 2),
    ]);

    const sections = [];
    if (!r1.ok) {
      if (r1.ambiguous) sections.push({ slot: r1.slot, candidates: r1.candidates });
      else {
        window.alert(r1.message || "① 입력을 확인해 주세요.");
        return;
      }
    }
    if (!r2.ok) {
      if (r2.ambiguous) sections.push({ slot: r2.slot, candidates: r2.candidates });
      else {
        window.alert(r2.message || "② 입력을 확인해 주세요.");
        return;
      }
    }
    if (sections.length) {
      if (out) {
        out.classList.remove("hidden");
        out.textContent =
          "이름이 여러 명일 때는 아래에서 한 분씩 눌러 주세요. 선택 시 해당 칸이 문중원ID로 바뀌고 자동으로 다시 계산합니다.";
      }
      if (visualBtn) visualBtn.classList.add("hidden");
      if (visualHint) visualHint.classList.add("hidden");
      if (visualWrap) visualWrap.classList.add("hidden");
      renderKinshipDisambig(sections);
      return;
    }

    const id1 = r1.id;
    const id2 = r2.id;
    const seq = ++kinshipCalcSeq;
    const key = kinshipPairKey(id1, id2);
    const isProgressLikeText = (t) => {
      const s = String(t || "").trim();
      if (!s) return false;
      const lower = s.toLowerCase();
      return (
        lower.includes("계산") ||
        lower.includes("분석") ||
        lower.includes("처리") ||
        lower.includes("진행") ||
        lower.includes("running")
      );
    };

    if (out) {
      out.classList.remove("hidden");
      if (visualBtn) visualBtn.classList.add("hidden");
      if (visualHint) visualHint.classList.add("hidden");
      if (visualWrap) visualWrap.classList.add("hidden");
      const cached = kinshipCache.get(key);
      if (cached?.text) {
        // "계산 중" 같은 진행 문구는 캐시로 남기지 않는다(과거 버전 잔재 정리)
        if (isProgressLikeText(cached.text)) {
          kinshipCache.delete(key);
          kinshipCacheSaveToStorage();
        } else {
          out.textContent = `${cached.text} (캐시됨)`;
          return;
        }
      }
      out.textContent = "조상 데이터를 분석하여 촌수를 계산 중입니다…";
    }

    const parseKinshipText = (json) => {
      if (!json || typeof json !== "object") return "";
      const serverErr = String(json.error ?? json.Error ?? "").trim();
      if (serverErr) return `오류: ${serverErr}`;
      const n = json.distance ?? json.촌수 ?? json.chon ?? json.degree;
      const desc = String(
        json.relation ?? json.description ?? json.message ?? json.label ?? ""
      ).trim();

      if (n != null && n !== "") {
        // 보기 좋게: "촌수: 숫자 (공통 조상 이름, 세손 숫자)"만 표시
        const ancName = String(json.commonAncestorName ?? json.공통조상 ?? json.ancestorName ?? "").trim();
        const ancGen = readNodeGenLike(json.commonAncestor ?? json.ancestor ?? json.조상 ?? null);
        const tail = ancName
          ? `공통 조상: ${ancName}${ancGen != null ? `, ${ancGen}세손` : ""}`
          : "";
        return tail ? `촌수: ${n} (${tail})` : `촌수: ${n}`;
      }
      // 서버가 "계산 중" 안내만 주는 경우는 최종 결과가 아니므로 계속 폴링한다.
      const lower = desc.toLowerCase();
      const looksLikeProgress =
        lower.includes("계산") ||
        lower.includes("분석") ||
        lower.includes("처리") ||
        lower.includes("진행") ||
        lower.includes("running");
      if (desc && !looksLikeProgress) return desc;
      return "";
    };

    const run = async () => {
      // 같은 요청 중복 클릭 방지
      if (kinshipInFlight.has(key)) return kinshipInFlight.get(key);

      const p = (async () => {
      // running/진행 메시지 폴링: 총 12회(약 30~40초)까지 기다림
        const maxAttempts = 12;
        let lastJson = null;
      let lastDesc = "";
        // 빠른 경로: 이미 완성된 JSON이면 긴 폴링 루프 생략
        lastJson = await apiGetSilent(
          { action: "kinship", id1, id2 },
          { maxAttempts: 2, retryDelayMs: 450 }
        );
        {
          const desc = String(
            lastJson?.relation ??
              lastJson?.description ??
              lastJson?.message ??
              lastJson?.label ??
              ""
          ).trim();
          if (desc) lastDesc = desc;
          const text0 = parseKinshipText(lastJson);
          if (text0) return text0;
        }

        for (let i = 0; i < maxAttempts; i++) {
          if (seq !== kinshipCalcSeq) return ""; // 새로운 계산이 시작되면 중단
          if (out) out.textContent = `조상 데이터를 분석하여 촌수를 계산 중입니다… (${i + 1}/${maxAttempts})`;

          try {
            // apiGet은 running 응답이면 내부에서 재시도하지만, kinship은 더 느릴 수 있어
            // 여기서는 1회 호출(12초 타임아웃) + 사이 간격 백오프로 폴링
            lastJson = await apiGet({ action: "kinship", id1, id2 }, { maxAttempts: 1, timeoutMs: 12000 });
          } catch {
            lastJson = null;
          }

          const desc = String(
            lastJson?.relation ??
              lastJson?.description ??
              lastJson?.message ??
              lastJson?.label ??
              ""
          ).trim();
          if (desc) lastDesc = desc;

          const text = parseKinshipText(lastJson);
          if (text) return text;

          // status: running 또는 null인 경우 잠깐 대기 후 재시도(점점 길게)
          const wait = Math.min(6000, 700 + i * 400);
          await new Promise((r) => setTimeout(r, wait));
        }
        // 끝까지 결과 숫자(촌수)가 오지 않는 경우: 서버가 진행 메시지만 주는 상태일 수 있음
        return lastDesc ? `서버가 최종 촌수 값을 반환하지 않습니다: ${lastDesc}` : "";
      })().finally(() => kinshipInFlight.delete(key));

      kinshipInFlight.set(key, p);
      return p;
    };

    const text = await run();
    if (!out) return;
    if (seq !== kinshipCalcSeq) return;
    if (text) {
      // 진행 문구는 캐시하지 않고, 최종값(촌수/확정 메시지)만 캐시
      if (!isProgressLikeText(text)) {
        kinshipCache.set(key, { text, ts: Date.now() });
        kinshipCacheSaveToStorage();
      }
      out.textContent = text;
      // 관계도는 자동으로 그리지 않고 버튼으로만 실행(속도 개선)
      if (/^촌수\s*:\s*\d+/.test(text)) {
        if (visualBtn) {
          visualBtn.dataset.id1 = id1;
          visualBtn.dataset.id2 = id2;
          visualBtn.dataset.key = key;
          visualBtn.classList.remove("hidden");
        }
        if (visualHint) visualHint.classList.remove("hidden");

        // 체감 개선: 촌수 숫자가 확정되면 관계도에 필요한 부계 체인을 백그라운드로 미리 가져온다.
        // 사용자가 곧바로 "관계도 보기"를 누를 때 대기 시간을 줄이기 위함.
        const cachedVisual = kinshipVisualCacheGet(key);
        if (!cachedVisual) {
          void (async () => {
            try {
              const data = await buildKinshipVisualFatherChains(id1, id2, 25);
              if (data?.best?.id) kinshipVisualCacheSet(key, data);
            } catch {
              // ignore (prefetch)
            }
          })();
        }
      }
      return;
    }
    out.textContent =
      "시간이 오래 걸립니다. 서버(Apps Script)에서 kinship 계산이 끝나지 않거나 running 응답만 반환 중일 수 있습니다. 잠시 후 다시 시도해 주세요.";
  });

  // 관계도 보기 버튼: 클릭 시에만 렌더
  document.getElementById("kinship-visual-btn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const id1 = btn?.dataset?.id1;
    const id2 = btn?.dataset?.id2;
    const key = btn?.dataset?.key || (id1 && id2 ? kinshipPairKey(id1, id2) : "");
    if (!id1 || !id2) return;
    btn.disabled = true;
    try {
      await renderKinshipVisual(id1, id2, key);
    } finally {
      btn.disabled = false;
    }
  });
}

async function renderKinshipVisual(id1, id2, keyOpt = "") {
  const wrap = document.getElementById("kinship-visual");
  if (!wrap) return;
  wrap.classList.remove("hidden");
  wrap.innerHTML = `<div class="text-sm text-stone-600">관계도를 구성하는 중…</div>`;

  // 부계 직계: 두 줄을 동시에 한 단계씩 올려 공통 조상이 나오면 즉시 중단(표시는 좌·우 각 18명까지)
  const key = keyOpt || kinshipPairKey(id1, id2);
  const cached = kinshipVisualCacheGet(key);
  const data = cached || (await buildKinshipVisualFatherChains(id1, id2, 25));
  if (!cached && data?.best?.id) kinshipVisualCacheSet(key, data);
  const { chainA: aChain, chainB: bChain, best } = data || {};

  if (!best || !best.id) {
    wrap.innerHTML = `<div class="text-sm text-stone-600">공통 조상을 찾지 못했습니다.</div>`;
    return;
  }

  const aToAnc = aChain.slice(0, best.iA + 1);
  const bToAnc = bChain.slice(0, best.iB + 1);

  const left = aToAnc.slice(0, -1).slice(0, 18);
  const right = bToAnc.slice(0, -1).slice(0, 18);
  const anc = aToAnc[aToAnc.length - 1];
  const ancName = pickFirstString(anc, NAME_KEYS) || "?";
  const ancGen = anc.gen ?? anc.세손 ?? anc.generation ?? "";

  const renderSide = (arr) =>
    arr
      .map((p) => {
        const nm = pickFirstString(p, NAME_KEYS) || "?";
        const gen = p.gen ?? p.세손 ?? p.generation ?? "";
        return `<div class="shrink-0 rounded-xl border border-stone-200 bg-white/80 px-3 py-2 text-center">
          <div class="text-xs font-bold text-ink-900">${escapeHtml(nm)}</div>
          ${gen !== "" && gen != null ? `<div class="mt-0.5 text-[11px] text-stone-600">(${escapeHtml(gen)}세손)</div>` : ""}
        </div>`;
      })
      .join(`<div class="h-px w-8 border-t border-dashed border-stone-400/80"></div>`);

  wrap.innerHTML = `
    <div class="flex items-stretch gap-3">
      <div class="min-w-0 flex-1 overflow-x-auto">
        <div class="flex items-center gap-2">
          ${renderSide(left)}
        </div>
      </div>

      <div class="shrink-0 self-center rounded-2xl border border-blue-200 bg-blue-50 px-3 py-2 text-center">
        <div class="text-xs font-extrabold text-blue-900">${escapeHtml(ancName)}</div>
        ${ancGen !== "" && ancGen != null ? `<div class="mt-0.5 text-[11px] font-semibold text-blue-800">(${escapeHtml(ancGen)}세손)</div>` : ""}
        <div class="mt-1 text-[11px] text-blue-700">공통 조상</div>
      </div>

      <div class="min-w-0 flex-1 overflow-x-auto">
        <div class="flex items-center gap-2">
          ${renderSide(right)}
        </div>
      </div>
    </div>
    <p class="mt-2 text-[11px] text-stone-500">좌/우 최대 18명씩 표시합니다.</p>
  `;
}

initBottomNav();
initTreeControls();
initPersonDetailActions();
initHomeActions();
initHeaderTabs();
initMorePageChrome();
initMoreExpanders();
initTreeZoomHosts();
initTreeMiniZoomButtons();
initMapFitButton();

// 저장된 기준 인물이 있으면 자동 복원
try {
  const saved = loadSelectedPersonIdFromStorage();
  if (saved) void selectPerson(saved);
} catch {
  // ignore
}

// 홈 공지 로드
void loadHomeNotices();

// 헤더 날씨(영주) 로드 + 주기 갱신(15분)
void refreshHeaderWeather();
try {
  setInterval(() => void refreshHeaderWeather(), 15 * 60 * 1000);
} catch {
  // ignore
}
