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

/** 마지막 검색 결과 — 가계도 인물 목록에 사용 */
let lastSearchRows = [];

/** 홈에서 선택한 문중원 (API 상세와 연동) */
let selectedPersonId = null;
let lastPersonDetail = null;
const SELECTED_PERSON_STORAGE_KEY = "ucheongim_selectedPersonId_v1";
let treeGenFilter = null; // { min:number, max:number } | null

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

/** kinship 결과 캐시 (id1,id2 -> {text,ts}) */
const kinshipCache = new Map();
const kinshipInFlight = new Map(); // key -> Promise<string>
let kinshipCalcSeq = 0;
const KINSHIP_CACHE_STORAGE_KEY = "ucheongim_kinship_cache_v1";
const KINSHIP_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30일

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

  const maxCandidates = 8;
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
  void hydrateFatherNamesForVisibleResults();
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
    pickFirstString(it, [...PARENT_ID_KEYS, "부친문중원ID", "father문중원ID"]) || ""
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
 * 부–자: 연한 푸른색 실선 (시트 부모 ID 필드 필요).
 */
function mountEightKinHorizontalTreeSvg(box, opts) {
  const {
    filtered,
    anchorInfo,
    anchorName,
    anchorGen,
    anchorId,
    anchorRole: anchorRoleOpt,
  } = opts;
  const anchorRole = anchorRoleOpt || "";

  box.innerHTML = "";
  const COL_W = 108;
  const PAD_L = 32;
  const PAD_T = 36;
  const ROW_H = 22;
  const FONT_MAIN = 12.5;
  const FONT_CAP = 10;

  const toolbar = document.createElement("div");
  toolbar.className =
    "mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-stone-200/80 pb-2";
  toolbar.innerHTML = `
    <span class="text-[11px] text-stone-500">세대별 정렬: 부친 ID 순 → 자녀 ID 순 · 부–자 연한 푸른 실선 · 드래그·휠 확대</span>
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
    byId.set(id, {
      id,
      name,
      gen: g != null ? Number(g) : null,
      col,
      fatherId: kinItemFatherId(it),
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
  };
  ensureFatherStubs();

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

  const maxRows = Math.max(1, ...[...byCol.values()].map((a) => a.length));
  const totalH = PAD_T * 2 + maxRows * ROW_H + 48;
  const totalW = PAD_L + (maxCol + 1) * COL_W + 40;

  const colCenterX = (c) => PAD_L + c * COL_W + COL_W / 2;

  byCol.forEach((arr, c) => {
    const colH = arr.length * ROW_H;
    let startY = PAD_T + 28 + (maxRows * ROW_H - colH) / 2;
    arr.forEach((n, i) => {
      n.x = colCenterX(c);
      n.y = startY + i * ROW_H + ROW_H / 2;
      n.w = Math.min(140, Math.max(36, n.name.length * FONT_MAIN * 0.52 + 10));
    });
  });

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
    te.setAttribute("x", String(n.x));
    te.setAttribute("y", String(n.y));
    te.setAttribute("text-anchor", "middle");
    te.setAttribute("dominant-baseline", "middle");
    te.setAttribute("font-size", String(n.id === effectiveAnchorId ? FONT_MAIN + 3 : FONT_MAIN));
    te.setAttribute("font-weight", n.id === effectiveAnchorId ? "700" : "500");
    te.setAttribute("fill", n.id === effectiveAnchorId ? "#8b2942" : "#1c1917");
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

  const stroke = "#7dd3fc";

  const drawPath = (d, width = 1.15, opacity = 0.92) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", stroke);
    path.setAttribute("stroke-width", String(width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("opacity", String(opacity));
    gEdge.appendChild(path);
  };

  // 같은 아버지의 자녀가 여럿이면: 버스(괄호 느낌)로 묶어 연결
  childrenByFather.forEach((kids, fid) => {
    const p = byId.get(fid);
    if (!p || !kids.length) return;
    kids.sort((a, b) => compareClanMemberIds(a.id, b.id));

    if (kids.length === 1) {
      const ch = kids[0];
      const x1 = p.x + p.w / 2 + 6;
      const y1 = p.y;
      const x2 = ch.x - ch.w / 2 - 6;
      const y2 = ch.y;
      const mx = (x1 + x2) / 2;
      const d = `M${x1},${y1} L${mx},${y1} L${mx},${y2} L${x2},${y2}`;
      drawPath(d, 1.15, 0.92);
      return;
    }

    // 버스 x 위치(부친과 자녀 중간)
    const minY = Math.min(...kids.map((k) => k.y));
    const maxY = Math.max(...kids.map((k) => k.y));
    const xFrom = p.x + p.w / 2 + 6;
    const xTo = Math.min(...kids.map((k) => k.x - k.w / 2 - 6));
    const xBus = xFrom + Math.max(14, Math.min(42, (xTo - xFrom) * 0.55));
    const yMid = (minY + maxY) / 2;

    // 부친 → 버스(살짝 곡선)
    drawPath(`M${xFrom},${p.y} Q${xBus - 6},${p.y} ${xBus},${yMid}`, 1.2, 0.92);
    // 버스 세로줄
    drawPath(`M${xBus},${minY} L${xBus},${maxY}`, 1.2, 0.72);
    // 버스 → 각 자녀
    kids.forEach((ch) => {
      const x2 = ch.x - ch.w / 2 - 6;
      drawPath(`M${xBus},${ch.y} L${x2},${ch.y}`, 1.15, 0.92);
    });
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
      t.setAttribute("fill", "#8b2942");
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
    ln.setAttribute("stroke", "#d6d3d1");
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
  const mother =
    pickFirstString(mergedRow, [
      "어머니 성함",
      "어머니이름",
      "어머니",
      "모친",
      "모",
      "motherName",
      "mother",
      "Mother",
    ]) || "기록 없음";

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
            <span class="mt-0.5 break-words text-xs font-semibold text-ink-900">${escapeHtml(mother)}</span>
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
    if (fid) idToFather.set(id, fid);
  });

  let excludedCollateral = 0;
  const canApplyDirectFilter = (() => {
    // fatherId 체인이 거의 없거나, anchorId로 올라가는 케이스가 하나도 없으면
    // (즉 데이터 스키마/값이 안 맞는 상태) 아침처럼 목록을 그대로 보여주고 선만 연결한다.
    if (!anchorId) return false;
    if (idToFather.size < 4) return false;
    // 하나라도 anchorId로 도달하는 케이스가 있어야 필터 적용
    let okCount = 0;
    for (const id of idToFather.keys()) {
      let cur = String(id);
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const f = idToFather.get(cur);
        if (!f) break;
        if (String(f) === String(anchorId)) {
          okCount += 1;
          break;
        }
        cur = String(f);
      }
      if (okCount >= 2) break;
    }
    return okCount >= 1;
  })();

  const isDirectDescendant = (id) => {
    if (!canApplyDirectFilter) return true;
    let cur = String(id);
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const f = idToFather.get(cur);
      if (!f) return false;
      if (String(f) === String(anchorId)) return true;
      cur = String(f);
    }
    return false;
  };

  const filtered = baseFiltered.filter((it, idx) => {
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
    if (!id || id.startsWith("idx_")) return true; // id 없는 행은 그냥 남김(표시 단계에서 걸러질 수 있음)
    const ok = isDirectDescendant(id);
    if (!ok) excludedCollateral += 1;
    return ok;
  });

  if (hintEl) {
    const parts = [];
    if (anchorInfo) parts.push(`기준: ${anchorName} (${anchorInfo.role})`);
    if (excludedAbove > 0) parts.push(`윗세대 제외 ${excludedAbove}명`);
    if (canApplyDirectFilter) {
      if (excludedCollateral > 0) parts.push(`방계 제외 ${excludedCollateral}명`);
    } else {
      parts.push("부친ID 부족으로 방계 제외를 확정할 수 없음(가능한 선만 연결)");
    }
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
    .attr("stroke", "#d6d3d1")
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
    .attr("fill", (d) => (String(d.id) === String(selectedPersonId) ? "#8b2942" : "#fff"))
    .attr("stroke", (d) => (String(d.id) === String(selectedPersonId) ? "#8b2942" : "#e7e5e4"))
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

  const eightList = normalizeEightKinList(eightJson);
  renderEightKinListHome(eightList);
  // 8촌 트리(관계도) 실제 렌더
  renderEightKinTree(eightJson);
  // 8촌은 고조부(최대 4대 위)까지만 필요 → 짧게 조회해 빠르게 표시
  const anchorChain = await buildFatherChainFromId(clanMemberId, 8);
  await renderEightKinBox(eightJson, anchorChain);
  // 직계 조상(시조까지)은 별도(백그라운드)로 길게 가져와 UI 블로킹 최소화
  void (async () => {
    const longChain = await buildFatherChainFromId(clanMemberId, 220);
    renderAncestorsLine(longChain);
  })();
  debugLog("eightKin list normalized (first 5)", eightList.slice(0, 5));

  // 카드에서 부친을 "불러오는 중…"으로 남기지 않도록: 선택 시에만 person API로 보강
  // 부친 성함이 없고 부친 ID만 있는 경우: 부친 person API로 성함 보강(패널/가계도 카드에 반영)
  if (merged && typeof merged === "object") {
    const fName = pickFirstString(merged, PARENT_NAME_KEYS);
    const fId = pickFirstString(merged, PARENT_ID_KEYS);
    if (!fName && fId) {
      const p = await getPersonById(fId);
      const nm = p ? pickFirstString(p, NAME_KEYS) : "";
      if (nm) {
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
      }
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
      '<li class="text-sm text-stone-500">등록된 공지가 없습니다.</li>';
    return;
  }
  items.slice(0, 10).forEach((n) => {
    const li = document.createElement("li");
    li.className =
      "rounded-xl border border-stone-100 bg-stone-50/80 px-3 py-2.5 text-left";
    const title = String(n.title ?? n.subject ?? n.heading ?? "제목 없음");
    const date = String(n.date ?? n.writtenAt ?? n.createdAt ?? "");
    const sum = String(n.summary ?? n.content ?? n.body ?? "").slice(0, 160);
    const author = String(n.author ?? n.writer ?? "");
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
  const [noticeJson, histJson, voteJson] = await Promise.all([
    apiGetSilent({ action: "notices", limit: "10" }),
    apiGetSilent({ action: "history", limit: "20" }),
    apiGetSilent({ action: "vote" }),
  ]);
  renderClanNotices(noticeJson);
  renderMoreHistory(histJson);
  renderVoteSection(voteJson);
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
  const noticeJson = await apiGetSilent({ action: "notices", limit: "3" });
  renderHomeNotices(noticeJson);
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
      '<p class="text-sm text-stone-500">진행 중인 투표가 없습니다.</p>';
    return;
  }

  lastVoteContext = { agendaId: normalized.agendaId };
  if (hint) hint.textContent = "이름 입력 후 항목별 투표를 누르세요.";
  body.innerHTML = "";
  const h4 = document.createElement("h4");
  h4.className = "font-semibold text-ink-900";
  h4.textContent = normalized.title;
  body.appendChild(h4);

  normalized.options.forEach((opt, i) => {
    const count = Number(normalized.votes[i] ?? 0) || 0;
    const row = document.createElement("div");
    row.className =
      "flex flex-wrap items-center gap-2 rounded-xl border border-stone-100 bg-stone-50/80 px-3 py-2";
    const label = document.createElement("span");
    label.className = "min-w-0 flex-1 text-sm text-ink-800";
    label.textContent = String(opt);
    const meta = document.createElement("span");
    meta.className = "text-xs text-stone-500";
    meta.textContent = `${count}표`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "rounded-lg bg-seal px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#732238]";
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
      '<p class="text-sm text-stone-500">등록된 자료 목록이 없습니다.</p>';
    return;
  }
  items.slice(0, 20).forEach((h) => {
    const year = String(h.year ?? h.연도 ?? "");
    const title = String(h.title ?? h.제목 ?? h.headline ?? "");
    const p = document.createElement("p");
    p.className = "border-b border-stone-100 pb-2 text-sm last:border-0";
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
    mapInstance.fitBounds(bounds, { padding: [28, 28], maxZoom: 12 });
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
      const sel = document.getElementById("tree-person-select");
      const v = sel?.value;
      if (v) void drawFamilyTree(v);
      else if (lastSearchRows.length) {
        const first = annotatePeople(lastSearchRows)[0];
        if (first) void drawFamilyTree(first.id);
      }
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
      if (gen === "9-11") setTreeGenFilter(9, 11);
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
  const chain = await buildFatherChainFromId(selectedPersonId, 220);
  renderAncestorsLine(chain);
}

function initHomeActions() {
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
    const json = await apiGetSilent({ action: "eightKin", id: selectedPersonId });
    const anchorChain = await buildFatherChainFromId(selectedPersonId, 8);
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

function paintD3TreeLayout(root, focusId, wrap, svgEl, fromNested) {
  const svg = d3.select(svgEl);
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
      .attr("stroke", "#d6d3d1")
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
        nodeIsFocused(d, focusId, fromNested) ? "#8b2942" : "#fff"
      )
      .attr("stroke", (d) =>
        nodeIsFocused(d, focusId, fromNested) ? "#8b2942" : "#e7e5e4"
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
    svg.call(
      zoom.transform,
      d3.zoomIdentity.translate(tx, ty).scale(Math.max(scale, 0.45))
    );
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
    .attr("stroke", "#d6d3d1")
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
      nodeIsFocused(d, focusId, fromNested) ? "#8b2942" : "#fff"
    )
    .attr("stroke", (d) =>
      nodeIsFocused(d, focusId, fromNested) ? "#8b2942" : "#e7e5e4"
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
  svg.call(
    zoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(Math.max(scale, 0.45))
  );
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
  } else {
    treeGenFilter = { min: Number(min), max: Number(max) };
  }
  refreshTreePersonSelect();
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

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  if (!focusId || !lastSearchRows.length) {
    updateTreeDetailCard(null);
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
  if (hint) hint.textContent = "서버에서 가계도(getTree)를 불러오는 중…";

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

  const fullRows = buildGraphRows(lastSearchRows);
  const treeRows = descendantStratifyRows(fullRows, focusId);

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

  paintD3TreeLayout(root, focusId, wrap, svgEl, false);
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
    const id1 = document.getElementById("kinship-id1")?.value?.trim();
    const id2 = document.getElementById("kinship-id2")?.value?.trim();
    const out = document.getElementById("kinship-calc-result");
    const visualBtn = document.getElementById("kinship-visual-btn");
    const visualHint = document.getElementById("kinship-visual-hint");
    const visualWrap = document.getElementById("kinship-visual");
    if (!id1 || !id2) {
      window.alert("두 문중원ID를 모두 입력해 주세요.");
      return;
    }
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
          const wait = Math.min(8000, 1200 + i * 600);
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
          visualBtn.classList.remove("hidden");
        }
        if (visualHint) visualHint.classList.remove("hidden");
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
    if (!id1 || !id2) return;
    btn.disabled = true;
    try {
      await renderKinshipVisual(id1, id2);
    } finally {
      btn.disabled = false;
    }
  });
}

async function renderKinshipVisual(id1, id2) {
  const wrap = document.getElementById("kinship-visual");
  if (!wrap) return;
  wrap.classList.remove("hidden");
  wrap.innerHTML = `<div class="text-sm text-stone-600">관계도를 구성하는 중…</div>`;

  // 부계 직계(아버지) 라인만으로 공통 조상을 찾고, 좌/우 최대 18명씩 표시
  const [aChain, bChain] = await Promise.all([
    buildFatherChainFromId(id1, 80),
    buildFatherChainFromId(id2, 80),
  ]);

  const idxA = new Map(aChain.map((p, i) => [String(p.id ?? p.문중원ID ?? ""), i]));
  let best = null; // { id, sum }
  bChain.forEach((p, j) => {
    const pid = String(p.id ?? p.문중원ID ?? "");
    if (!pid || !idxA.has(pid)) return;
    const sum = idxA.get(pid) + j;
    if (!best || sum < best.sum) best = { id: pid, sum };
  });

  if (!best) {
    wrap.innerHTML = `<div class="text-sm text-stone-600">공통 조상을 찾지 못했습니다.</div>`;
    return;
  }

  const aToAnc = aChain.slice(0, idxA.get(best.id) + 1);
  const bToAnc = bChain.slice(0, (bChain.findIndex((p) => String(p.id ?? p.문중원ID ?? "") === best.id) + 1));

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

// 저장된 기준 인물이 있으면 자동 복원
try {
  const saved = loadSelectedPersonIdFromStorage();
  if (saved) void selectPerson(saved);
} catch {
  // ignore
}

// 홈 공지 로드
void loadHomeNotices();
