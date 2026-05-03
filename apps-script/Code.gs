/**
 * 의성김씨 아천문중 세보 - 통합 엔진 (로컬 apps-script/Code.gs 백업본)
 * - search / person(getDetail) / getTree / kinship / eightKin
 * - notice / property / voteResponse / voteTally (응답 시트 D·F열 집계)
 * - genRange(min,max): 1-10세 전용 트리 데이터 (형제 포함)
 * - vote: 안건 JSON (Script Properties 또는 voteAgenda 시트)
 * - history / movements: 시트 history, movements
 * - doPost voteSubmit: voteResponse 시트에 한 행 추가
 *
 * 배포: 스크립트 편집기 → 배포 → 웹 앱. URL은 main.js 의 API_BASE 와 동일해야 합니다.
 *
 * (중요) 가계도 32~36세 하단「외손」규칙은 people 시트 **성별(E)·외손(I)** 열을 내려줘야 한다.
 * 아래가 빠진 구버전이면 genRange/search/getDetail 응답에 성별·외손이 없음 → 반드시 이 백업본 전체를 붙여 넣고 새 버전 배포.
 */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = String(p.action || "").trim();
  const name = p.name;
  // id 파라미터 호환
  const rawId = p.id ?? p.문중원ID ?? p.memberId ?? p.personId ?? p.clanMemberId ?? "";
  const id1 = String(p.id1 ?? rawId ?? "").trim();
  const id2 = String(p.id2 ?? "").trim();
  let result;
  try {
    if (action === "search") result = searchPersonsByName(name);
    else if (action === "person" || action === "getDetail") result = getDetail(id1);
    else if (action === "getTree") result = getTreeData(id1);
    else if (action === "kinship") result = calculateKinship(id1, id2);
    else if (action === "eightKin") result = getEightKin(id1);
    // 아천문중 페이지(구글시트)
    else if (action === "notice") result = getNoticeList(p); // 시트: notice
    else if (action === "property") result = getPropertyList(p); // 시트: property
    else if (action === "voteResponse") result = getVoteResponseList(p); // 시트: voteResponse
    else if (action === "voteRespone") result = getVoteResponseList(p); // 오타 호환(같은 결과)
    else if (action === "voteTally" || action === "voteSummary") result = getVoteTally_(p); // voteResponse D·F열 집계
    // 가계도 1-10세 전용 데이터
    else if (action === "genRange") result = getGenRange(p); // people 시트에서 세손 구간(+형제)
    // PWA: 문중원투표 안건 / 연혁 / 지도 마커
    else if (action === "vote") result = getVoteAgenda_(p);
    else if (action === "history") result = getHistoryList_(p);
    else if (action === "movements") result = getMovementsList_(p);
    else result = { status: "error", error: "unknown action: " + action };
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    const msg = String(err && err.stack ? err.stack : err);
    return ContentService.createTextOutput(JSON.stringify({ status: "error", error: msg }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/** PWA POST: action=voteSubmit (application/x-www-form-urlencoded) */
function doPost(e) {
  const p = (e && e.parameter) || {};
  const action = String(p.action || "").trim();
  try {
    if (action === "voteSubmit") {
      const result = handleVoteSubmit_(p);
      return ContentService.createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(
      JSON.stringify({ status: "error", error: "unknown post action: " + action })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    const msg = String(err && err.stack ? err.stack : err);
    return ContentService.createTextOutput(JSON.stringify({ status: "error", error: msg }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * voteResponse 시트 1행 헤더 예:
 * 타임스탬프 | 문중원ID (또는 성함) | 의견 | 찬반 | 안건번호 | 항목/의견 선택
 * append 순서는 위와 동일 (타임스탬프는 서버에서 new Date()).
 */
/**
 * 여러 구글 폼이 같은 통합문서를 쓸 때: 폼마다 응답 탭을 분리하고, 집계할 탭만 VOTE_RESPONSE_SHEET_NAME 으로 지정.
 * 스크립트가 그 통합문서에 컨테이너로 묶여 있지 않으면 스크립트 속성 VOTE_TALLY_SPREADSHEET_ID 에 통합문서 ID를 넣음(URL의 /d/ 이후 긴 문자열).
 */
function getSpreadsheetForVoteTally_() {
  var props = PropertiesService.getScriptProperties();
  var id = String(props.getProperty("VOTE_TALLY_SPREADSHEET_ID") || "").trim();
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e1) {
      return {
        __openError: String(e1 && e1.message ? e1.message : e1),
      };
    }
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * GET action=voteTally (또는 voteSummary)
 * 1행 헤더, 2행부터 집계. 열·탭은 폼 질문 순서마다 다름 → 스크립트 속성으로 맞춤.
 *
 * 예) 탭「설문지 응답 시트6」: B=항목/의견 선택, D=찬성/반대 →
 *   VOTE_RESPONSE_SHEET_NAME = 설문지 응답 시트6
 *   VOTE_TALLY_COL_OPINION = 2   (B)
 *   VOTE_TALLY_COL_PRO = 4       (D)
 * 통합문서 ID(URL /d/뒤): VOTE_TALLY_SPREADSHEET_ID (스크립트가 이 파일에 안 붙어 있을 때)
 *
 * 구형 수동 시트(voteResponse 탭, D·F열)는 속성 없을 때 기본값과 맞출 수 있음.
 */
function getVoteTally_(p) {
  var props = PropertiesService.getScriptProperties();
  var sheetName = String(props.getProperty("VOTE_RESPONSE_SHEET_NAME") || "voteResponse").trim();
  if (!sheetName) sheetName = "voteResponse";
  var colPro = parseInt(String(props.getProperty("VOTE_TALLY_COL_PRO") || "4"), 10);
  /* 구글 폼 응답: 항목 선택이 B열인 경우가 많아 기본 2. 수동 voteResponse F열이면 속성에 6 */
  var colOp = parseInt(String(props.getProperty("VOTE_TALLY_COL_OPINION") || "2"), 10);
  var colAgenda = parseInt(String(props.getProperty("VOTE_TALLY_COL_AGENDA") || "5"), 10);
  if (!colPro || colPro < 1) colPro = 4;
  if (!colOp || colOp < 1) colOp = 2;
  if (!colAgenda || colAgenda < 1) colAgenda = 5;
  var ixPro = colPro - 1;
  var ixOp = colOp - 1;
  var ixAgenda = colAgenda - 1;

  var ss = getSpreadsheetForVoteTally_();
  if (ss && ss.__openError) {
    return {
      ok: false,
      error:
        "통합문서를 열 수 없습니다(VOTE_TALLY_SPREADSHEET_ID). 공유 권한·ID 확인: " + ss.__openError,
      proCon: {},
      opinionChoice: {},
      sheet: sheetName,
    };
  }
  const sh = ss.getSheetByName(sheetName);
  if (!sh) {
    return {
      ok: false,
      error: "시트 '" + sheetName + "'를 찾을 수 없습니다. (스크립트 속성 VOTE_RESPONSE_SHEET_NAME 확인)",
      proCon: {},
      opinionChoice: {},
      sheet: sheetName,
    };
  }
  const agendaFilter = String((p && p.agendaId) || "").trim();
  const data = sh.getDataRange().getValues();
  const proCon = {};
  const opinionChoice = {};
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (agendaFilter && String(row[ixAgenda] || "").trim() !== agendaFilter) continue;
    var pc = String(row[ixPro] || "").trim();
    var oc = String(row[ixOp] || "").trim();
    if (pc) proCon[pc] = (proCon[pc] || 0) + 1;
    if (oc) opinionChoice[oc] = (opinionChoice[oc] || 0) + 1;
  }
  return {
    ok: true,
    proCon: proCon,
    opinionChoice: opinionChoice,
    sheet: sheetName,
  };
}

function handleVoteSubmit_(p) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("voteResponse");
  if (!sh) throw new Error("시트 'voteResponse'를 찾을 수 없습니다.");
  sh.appendRow([
    new Date(),
    String(p.voterName || ""),
    String(p.opinion || ""),
    String(p.proCon || ""),
    String(p.agendaId || ""),
    String(p.selectedOptionLabel || ""),
  ]);
  return { ok: true, success: true, message: "투표가 반영되었습니다." };
}

/**
 * PWA normalizeVotePayload 가 기대하는 형태: { vote: { title, agendaId, options[], votes[] } }
 * 1) Script Properties 키 VOTE_AGENDA_JSON 에 전체 JSON 문자열
 *    예: {"title":"안건","agendaId":"1","options":["찬성","반대"],"votes":[0,0]}
 * 2) 없으면 시트 voteAgenda 2행: A=agendaId, B=title, C=선택지(콤마구분), D=득표(콤마구분)
 */
function getVoteAgenda_(p) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty("VOTE_AGENDA_JSON");
    if (raw) {
      const vote = JSON.parse(raw);
      return { vote: vote };
    }
  } catch (e1) {
    // ignore
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("voteAgenda");
  if (sh && sh.getLastRow() >= 2) {
    const nc = Math.max(4, sh.getLastColumn());
    const row = sh.getRange(2, 1, 2, nc).getValues()[0];
    const agendaId = String(row[0] || "1").trim();
    const title = String(row[1] || "투표").trim();
    const optsStr = String(row[2] || "");
    const votesStr = String(row[3] || "");
    const options = optsStr
      .split(/[,|]/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    const votes = votesStr.split(/[,|]/).map(function (s) {
      return Number(String(s).trim()) || 0;
    });
    while (votes.length < options.length) votes.push(0);
    if (options.length) {
      return {
        vote: {
          title: title,
          agendaId: agendaId,
          options: options,
          votes: votes.slice(0, options.length),
        },
      };
    }
  }
  return { vote: { title: "", agendaId: "", options: [], votes: [] } };
}

/** 시트 history — 행 객체에 year/연도, title/제목 등 헤더로 내려가면 PWA가 표시 */
function getHistoryList_(p) {
  const res = sheetRowsAsObjects_("history", { limit: p.limit || 20 });
  if (!res.ok) return { status: "error", error: res.error, history: [], sheet: "history" };
  return { history: res.items, sheet: "history" };
}

/** 시트 movements — lat/lng 또는 위도/경도 등 (main.js normalizeOneMapPoint 호환) */
function getMovementsList_(p) {
  const res = sheetRowsAsObjects_("movements", { limit: p.limit || 50 });
  if (!res.ok) return { status: "error", error: res.error, movements: [], sheet: "movements" };
  const movements = res.items.map(rowToMapPoint_).filter(Boolean);
  return { movements: movements, sheet: "movements" };
}

function rowToMapPoint_(obj) {
  if (!obj || typeof obj !== "object") return null;
  const lat = Number(obj.lat ?? obj.latitude ?? obj.위도 ?? obj.Lat);
  const lng = Number(obj.lng ?? obj.lon ?? obj.longitude ?? obj.경도 ?? obj.Lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat: lat,
    lng: lng,
    name: String(obj.name ?? obj.title ?? obj.label ?? obj.이름 ?? "유적지"),
    desc: String(
      obj.desc ?? obj.loc ?? obj.location ?? obj.description ?? obj.memo ?? obj.설명 ?? ""
    ),
  };
}

/** 헤더 1행에서 names 중 첫 매칭 열 인덱스(없으면 -1) */
function headerIndex_(headerRow, names) {
  const h = headerRow.map(function (x) {
    return String(x || "").trim();
  });
  for (var j = 0; j < names.length; j++) {
    const ix = h.indexOf(names[j]);
    if (ix >= 0) return ix;
  }
  return -1;
}

/* -------------------- people 캐시 -------------------- */
let cache = null;
function getCache() {
  if (cache) return cache;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("people");
  if (!sh) throw new Error("시트 'people'을 찾을 수 없습니다.");
  const data = sh.getDataRange().getValues();
  const h = data.shift();
  const i = {
    id: h.indexOf("문중원ID"),
    name: h.indexOf("이름"),
    gen: h.indexOf("세손"),
    fatId: h.indexOf("아버지의ID"),
    birth: h.indexOf("출생년도"),
    spouse: h.indexOf("배우자"),
    // 사용자 시트 실제 컬럼명: 가지경로 / 참고
    etc: h.indexOf("가지경로"),
    branch: h.indexOf("참고"),
    // E열=성별, I열=외손(헤더 표준명) — 위치는 헤더 이름으로 결정
    gender: headerIndex_(h, ["성별", "gender", "sex", "Sex", "Gender"]),
    oeson: headerIndex_(h, ["외손", "외손자", "외손녀", "외손들", "외손목록"]),
  };
  if (i.id < 0) throw new Error("people 시트 헤더에 '문중원ID' 컬럼이 없습니다.");
  if (i.name < 0) throw new Error("people 시트 헤더에 '이름' 컬럼이 없습니다.");
  if (i.fatId < 0) throw new Error("people 시트 헤더에 '아버지의ID' 컬럼이 없습니다.");
  const byId = {};
  const byName = {};
  const childrenMap = {};
  data.forEach((r) => {
    const pid = String(r[i.id] ?? "").trim();
    if (!pid) return;
    const person = {
      id: pid,
      name: String(r[i.name] ?? "").trim(),
      gen: r[i.gen],
      fatId: String(r[i.fatId] ?? "").trim(),
      birth: r[i.birth],
      spouse: r[i.spouse],
      // 프론트가 기대하는 키로 내려주기 위해 내부 표준화
      기타: i.etc >= 0 ? String(r[i.etc] ?? "").trim() : "",
      분기: i.branch >= 0 ? String(r[i.branch] ?? "").trim() : "",
      성별: i.gender >= 0 ? String(r[i.gender] ?? "").trim() : "",
      외손: i.oeson >= 0 ? String(r[i.oeson] ?? "").trim() : "",
    };
    byId[person.id] = person;
    if (!byName[person.name]) byName[person.name] = [];
    byName[person.name].push(person);
    const fid = person.fatId || "";
    if (!childrenMap[fid]) childrenMap[fid] = [];
    childrenMap[fid].push(person);
  });
  cache = { byId, byName, childrenMap };
  return cache;
}
function parseGenNumber_(raw) {
  const m = String(raw ?? "").match(/(\d+)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}
/* -------------------- search -------------------- */
function searchPersonsByName(name) {
  const c = getCache();
  const q = String(name ?? "").trim();
  if (!q) return [];
  return (c.byName[q] || []).map((p) => {
    const father = c.byId[p.fatId];
    return {
      id: p.id,
      name: p.name,
      gen: p.gen,
      fatId: p.fatId,
      birth: p.birth,
      spouse: p.spouse,
      fatherName: father ? father.name : "기록 없음",
      // (요청) 원 아래 표시용
      기타: p.기타 ?? "",
      분기: p.분기 ?? "",
      성별: p.성별 ?? "",
      외손: p.외손 ?? "",
    };
  });
}
/* -------------------- person(detail) -------------------- */
function getDetail(id) {
  const c = getCache();
  const meId = String(id ?? "").trim();
  if (!meId) return null;
  const me = c.byId[meId];
  if (!me) return null;
  const father = c.byId[me.fatId];
  const children = (c.childrenMap[meId] || []).map((p) => p.name);
  const siblings = me.fatId
    ? (c.childrenMap[me.fatId] || []).filter((x) => x.id !== meId).map((x) => x.name)
    : [];
  return {
    id: me.id,
    name: me.name,
    gen: me.gen,
    fatId: me.fatId,
    birth: me.birth,
    spouse: me.spouse,
    fatherName: father ? father.name : "기록 없음",
    children,
    siblings,
    기타: me.기타 ?? "",
    분기: me.분기 ?? "",
    성별: me.성별 ?? "",
    외손: me.외손 ?? "",
  };
}
/* -------------------- kinship -------------------- */
function calculateKinship(id1, id2) {
  const aId = String(id1 ?? "").trim();
  const bId = String(id2 ?? "").trim();
  if (!aId || !bId) return { status: "error", error: "id1, id2가 필요합니다." };
  if (aId === bId) return { distance: 0, 촌수: 0, relation: "동일 인물" };
  const c = getCache();
  const a = c.byId[aId];
  const b = c.byId[bId];
  if (!a) return { status: "error", error: `id1(${aId})을 people 시트에서 찾지 못했습니다.` };
  if (!b) return { status: "error", error: `id2(${bId})을 people 시트에서 찾지 못했습니다.` };
  const cacheSvc = CacheService.getScriptCache();
  const key = "kinship:" + [aId, bId].sort().join("|");
  const cached = cacheSvc.get(key);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {}
  }
  const distA = buildAncestorDistanceMap_(c, aId, 20000);
  const distB = buildAncestorDistanceMap_(c, bId, 20000);
  let best = null; // { ancId, dist }
  Object.keys(distA).forEach((ancId) => {
    if (distB[ancId] == null) return;
    const d = distA[ancId] + distB[ancId];
    if (best == null || d < best.dist) best = { ancId, dist: d };
  });
  if (!best) {
    const res = {
      status: "error",
      error: "공통 조상을 찾지 못했습니다(상위 조상 정보가 부족하거나 연결이 끊겼을 수 있음).",
    };
    cacheSvc.put(key, JSON.stringify(res), 60 * 10);
    return res;
  }
  const anc = c.byId[best.ancId];
  const relation = anc
    ? `공통 조상: ${anc.name} (문중원ID ${anc.id})`
    : `공통 조상ID ${best.ancId}`;
  const res = {
    distance: best.dist,
    촌수: best.dist,
    relation,
    a: { id: a.id, name: a.name },
    b: { id: b.id, name: b.name },
  };
  cacheSvc.put(key, JSON.stringify(res), 60 * 60 * 6);
  return res;
}
function buildAncestorDistanceMap_(c, startId, maxSteps) {
  const dist = {};
  let cur = startId;
  let d = 0;
  const seen = {};
  while (cur && d <= maxSteps) {
    if (seen[cur]) break;
    seen[cur] = true;
    dist[cur] = d;
    const p = c.byId[cur];
    if (!p) break;
    const next = String(p.fatId ?? "").trim();
    if (!next) break;
    cur = next;
    d += 1;
  }
  return dist;
}
/* -------------------- eightKin -------------------- */
function getEightKin(id) {
  const centerId = String(id ?? "").trim();
  if (!centerId) return { status: "error", error: "id가 필요합니다." };
  const c = getCache();
  const me = c.byId[centerId];
  if (!me) return { status: "error", error: `id(${centerId})을 people 시트에서 찾지 못했습니다.` };
  const cacheSvc = CacheService.getScriptCache();
  const cacheKey = "eightKin:" + centerId;
  const cached = cacheSvc.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {}
  }
  const adj = {};
  function addEdge(a, b) {
    if (!a || !b) return;
    if (!adj[a]) adj[a] = [];
    if (!adj[b]) adj[b] = [];
    adj[a].push(b);
    adj[b].push(a);
  }
  Object.keys(c.byId).forEach((pid) => {
    const p = c.byId[pid];
    const fid = String(p.fatId || "").trim();
    if (fid) addEdge(pid, fid);
    (c.childrenMap[pid] || []).forEach((ch) => addEdge(pid, ch.id));
  });
  const maxDepth = 8;
  const dist = {};
  const q = [centerId];
  dist[centerId] = 0;
  while (q.length) {
    const cur = q.shift();
    const d = dist[cur];
    if (d >= maxDepth) continue;
    const nexts = adj[cur] || [];
    for (let i = 0; i < nexts.length; i++) {
      const nx = nexts[i];
      if (dist[nx] != null) continue;
      dist[nx] = d + 1;
      q.push(nx);
    }
  }
  const ids = Object.keys(dist);
  const nodes = ids.map((pid) => {
    const p = c.byId[pid];
    return {
      id: pid,
      name: p ? p.name : pid,
      gen: p ? p.gen : null,
      depth: dist[pid],
    };
  });
  const linkSet = {};
  const links = [];
  ids.forEach((a) => {
    (adj[a] || []).forEach((b) => {
      if (dist[b] == null) return;
      const k = a < b ? a + "|" + b : b + "|" + a;
      if (linkSet[k]) return;
      linkSet[k] = true;
      const pa = c.byId[a];
      const pb = c.byId[b];
      let kind = "link";
      if (pa && String(pa.fatId || "").trim() === b) kind = "father";
      else if (pb && String(pb.fatId || "").trim() === a) kind = "father";
      links.push({ source: a, target: b, kind });
    });
  });
  const list = nodes
    .filter((n) => n.id !== centerId)
    .sort((x, y) => (x.depth ?? 999) - (y.depth ?? 999))
    .map((n) => ({
      id: n.id,
      name: n.name,
      gen: n.gen,
      distance: n.depth,
      relation: `그래프 거리 ${n.depth}`,
    }));
  const res = { center: { id: me.id, name: me.name }, nodes, links, list };
  cacheSvc.put(cacheKey, JSON.stringify(res), 60 * 60 * 6);
  return res;
}
/* -------------------- getTree -------------------- */
function getTreeData(id) {
  const rootId = String(id ?? "").trim();
  if (!rootId) return null;
  const c = getCache();
  const visited = {};
  function build(pid) {
    if (!pid) return null;
    if (visited[pid]) return null;
    visited[pid] = true;
    const p = c.byId[pid];
    if (!p) return null;
    const children = (c.childrenMap[pid] || []).map((ch) => build(ch.id)).filter(Boolean);
    return { id: p.id, name: p.name, gen: p.gen, children };
  }
  return build(rootId);
}
/* -------------------- notice/property/voteResponse -------------------- */
function sheetRowsAsObjects_(sheetName, opts) {
  opts = opts || {};
  const limit = Math.min(Number(opts.limit || 50) || 50, 500);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(sheetName);
  if (!sh) return { ok: false, sheet: sheetName, items: [], error: "시트 없음: " + sheetName };
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return { ok: true, sheet: sheetName, items: [] };
  const header = values[0].map((h) => String(h || "").trim());
  const rows = values.slice(1);
  const items = [];
  for (let i = 0; i < rows.length && items.length < limit; i++) {
    const r = rows[i];
    const isEmpty = r.every((x) => String(x ?? "").trim() === "");
    if (isEmpty) continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c] || "col" + (c + 1);
      obj[key] = r[c];
    }
    items.push(obj);
  }
  return { ok: true, sheet: sheetName, items };
}
function getNoticeList(p) {
  const res = sheetRowsAsObjects_("notice", { limit: p.limit || 30 });
  if (!res.ok) return { status: "error", error: res.error, sheet: "notice", notices: [] };
  return { notices: res.items, sheet: "notice" };
}
function getPropertyList(p) {
  const res = sheetRowsAsObjects_("property", { limit: p.limit || 200 });
  if (!res.ok) return { status: "error", error: res.error, sheet: "property", property: [] };
  return { property: res.items, sheet: "property" };
}
function getVoteResponseList(p) {
  const res = sheetRowsAsObjects_("voteResponse", { limit: p.limit || 200 });
  if (!res.ok) return { status: "error", error: res.error, sheet: "voteResponse", voteResponse: [] };
  return { voteResponse: res.items, sheet: "voteResponse" };
}
/* -------------------- genRange(1-10세 전용) + 형제 포함 -------------------- */
function getGenRange(p) {
  const min = Number(p.min ?? 1);
  const max = Number(p.max ?? 10);
  const c = getCache();
  // id -> 세손 숫자
  const genById = {};
  Object.keys(c.byId).forEach((id) => {
    const me = c.byId[id];
    const g = parseGenNumber_(me.gen);
    if (g != null) genById[me.id] = g;
  });
  // 1) min~max 세손이 “확정”된 인물들
  const base = Object.keys(c.byId)
    .map((id) => c.byId[id])
    .filter((me) => {
      const g = genById[me.id];
      return Number.isFinite(g) && g >= min && g <= max;
    });
  // 2) base에 들어온 사람들의 아버지ID 목록
  const wantFatherIds = new Set(
    base.map((x) => String(x.fatId || "").trim()).filter(Boolean)
  );
  const picked = new Map(); // id -> row
  const pushPerson = (me, inferredGen) => {
    const g = inferredGen ?? genById[me.id] ?? null;
    if (g != null && (g < min || g > max)) return;
    picked.set(me.id, {
      문중원ID: me.id,
      이름: me.name,
      세손: g,
      아버지의ID: me.fatId,
      기타: String(me.기타 ?? "").trim(), // people의 "가지경로"가 여기로 들어옴
      분기: String(me.분기 ?? "").trim(), // people의 "참고"가 여기로 들어옴
      성별: String(me.성별 ?? "").trim(),
      외손: String(me.외손 ?? "").trim(),
    });
  };
  // base는 무조건 포함
  base.forEach((me) => pushPerson(me, genById[me.id]));
  // 같은 아버지의 모든 자녀(=형제) 포함
  wantFatherIds.forEach((fid) => {
    const kids = c.childrenMap[fid] || [];
    const fatherGen = genById[fid];
    kids.forEach((me) => {
      const known = genById[me.id];
      const inferred =
        known != null ? known : (Number.isFinite(fatherGen) ? fatherGen + 1 : null);
      pushPerson(me, inferred);
    });
  });
  const out = [...picked.values()];
  // 정렬: 세손 → 아버지의ID → 본인ID (형제 나란히)
  out.sort((a, b) => {
    const ga = Number(a.세손 ?? 999);
    const gb = Number(b.세손 ?? 999);
    if (ga !== gb) return ga - gb;
    const fa = String(a.아버지의ID || "");
    const fb = String(b.아버지의ID || "");
    if (fa !== fb) return fa.localeCompare(fb);
    return String(a.문중원ID || "").localeCompare(String(b.문중원ID || ""));
  });
  return { genRange: out, min, max };
}
