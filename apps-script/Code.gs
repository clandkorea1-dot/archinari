/**
 * 의성김씨 아천문중 세보 - 통합 엔진 (로컬 apps-script/Code.gs 백업본)
 * - search / person(getDetail) / getTree / kinship / eightKin
 * - notice / property / voteResponse / voteTally (기본 B=선택·D=찬반 등; 속성으로 열 지정)
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
    else if (action === "voteTally" || action === "voteSummary") result = getVoteTally_(p); // 응답 시트 열은 속성으로 지정
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
 * 안건 열이 있으면: 의견(B)·찬반(D) 각각 해당 열에 값이 있는 행 중 시각이 가장 늦은 행의 안건 번호를 따로 구하고,
 * 의견 집계와 찬반 집계를 서로 다른 안건 번호로 필터할 수 있다. agendaId 쿼리가 있으면 양쪽 동일 안건으로 고정.
 * 안건 열이 모두 비어 있으면 전체 행 집계.
 *
 * 예) 구글 폼「설문지 응답 시트6」류: A=타임스탬프, **B=선택 문항(리스트에 표시할 선택 문장 집계)**,
 *   **D=찬반**, 안건 열이 있으면 그 다음 등 →
 *   VOTE_RESPONSE_SHEET_NAME = 설문지 응답 시트6
 *   VOTE_TALLY_COL_CHOICE = 2          (B, 선택지별 인원·문구 출처)
 *   VOTE_TALLY_COL_PRO = 4             (D, 찬반 막대)
 *   VOTE_TALLY_COL_QUESTION_ID = 2     (B와 동일이면 질문 ID 필터 없음 → B 헤더가 제목)
 *   VOTE_TALLY_COL_AGENDA = 5          (E, 선택)
 * (별도 B=질문 ID·C=선택 인 폼이면 속성으로 열만 바꿈.)
 * 응답 시트 1행: B1=의견/안건 질문 헤더, D1=찬반 질문 헤더(구글 폼 내보내기 기준).
 * 본문 응답은 2행부터이며, B14·B15 등은 시트·폼마다 다름(집계는 열 전체).
 * 질문 ID → 표시 문장: Script Properties 의 JSON 키 VOTE_QUESTION_TEXT_JSON (예: {"Q1":"문장..."}),
 *   또는 통합문서 시트 voteQuestionMap (A열 ID, B열 문장). 없으면 선택 열 헤더(1행)를 문장으로 사용.
 *   VOTE_TALLY_COL_TIMESTAMP = 1 (A, 최신 안건·최신 질문 ID 판별)
 *
 * 열이 폼 질문 순서와 다르면 숫자 기본값이 틀어짐 → 반드시 스크립트 속성으로 맞춤:
 *   VOTE_TALLY_COL_PRO / _CHOICE / _QUESTION_ID / _AGENDA / _COL_TIMESTAMP (1=A, 2=B …)
 * 또는 응답 시트 1행 헤더에 포함되는 짧은 문자열로 지정:
 *   VOTE_TALLY_MATCH_PRO, _CHOICE, _QUESTION_ID, _AGENDA, _TIMESTAMP
 * (예: MATCH_PRO=찬반, MATCH_CHOICE=귀하의 선택 — 구글 폼 질문 제목 일부)
 * 성공 응답의 tallyColumns 에 실제 사용한 열 번호가 나오므로 배포 후 확인 가능.
 * 통합문서 ID(URL /d/뒤): VOTE_TALLY_SPREADSHEET_ID (스크립트가 이 파일에 안 붙어 있을 때)
 *
 * 구형 수동 시트(voteResponse 탭, D·F열)는 속성 없을 때 기본값과 맞출 수 있음.
 * 안건 전용 열이 없는 설문(구글 폼)인데 E열에 다른 답이 있으면 잘못 필터됨 →
 *   스크립트 속성 VOTE_TALLY_DISABLE_AGENDA = 1 로 안건 구간 집계 끄기.
 * VOTE_RESPONSE_SHEET_NAME 을 비우면: 탭「설문지 응답 시트6」이 있으면 그걸 쓰고, 없으면 voteResponse.
 */
/** 시트 셀을 밀리초로 (구글 시트 Date 또는 파싱 가능한 문자열) */
function parseVoteTallyCellTime_(val) {
  if (val instanceof Date && !isNaN(val.getTime())) return val.getTime();
  const s = String(val || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return !isNaN(d.getTime()) ? d.getTime() : null;
}

/**
 * 응답 시트에서「최신 안건」한 건만 집계하기 위해 agendaId 결정.
 * 1) 타임스탬프 열이 있으면 가장 늦은 시각의 행의 안건번호
 * 2) 없으면 시트 하단(최근 추가 행)부터 비어 있지 않은 첫 행의 안건번호
 */
function resolveLatestVoteAgendaId_(data, ixAgenda, ixTime) {
  if (!data || data.length < 2) return "";
  /** 안건 번호가 비어 있는 맨 최근 행만 있으면 잘못된 "" 가 되므로, 값이 있는 행 중 시각이 가장 늦은 안건을 쓴다. */
  var bestTime = null;
  var agendaAtBest = "";
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var ag = String(row[ixAgenda] || "").trim();
    if (!ag) continue;
    var t = ixTime >= 0 ? parseVoteTallyCellTime_(row[ixTime]) : null;
    if (t != null) {
      if (bestTime == null || t >= bestTime) {
        bestTime = t;
        agendaAtBest = ag;
      }
    }
  }
  if (bestTime != null) return agendaAtBest;
  for (var bottom = data.length - 1; bottom >= 1; bottom--) {
    var rowB = data[bottom];
    var isEmpty = rowB.every(function (x) {
      return String(x ?? "").trim() === "";
    });
    if (isEmpty) continue;
    var ag2 = String(rowB[ixAgenda] || "").trim();
    if (ag2) return ag2;
  }
  return "";
}

/**
 * 특정 열(의견 B 또는 찬반 D)에 값이 있는 행만 보면서, 그중 타임스탬프가 가장 늦은 행의 안건 번호.
 * 의견·찬반을 「최신 한 건」씩 따로 잡을 때 사용한다.
 */
function resolveLatestAgendaForNonEmptyCol_(data, ixAgenda, ixTime, ixCol) {
  if (!data || data.length < 2) return "";
  var bestTime = null;
  var agendaAtBest = "";
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (!String(row[ixCol] || "").trim()) continue;
    var ag = String(row[ixAgenda] || "").trim();
    var t = ixTime >= 0 ? parseVoteTallyCellTime_(row[ixTime]) : null;
    if (t != null) {
      if (bestTime == null || t >= bestTime) {
        bestTime = t;
        agendaAtBest = ag;
      }
    }
  }
  if (bestTime != null) return agendaAtBest;
  for (var bottom = data.length - 1; bottom >= 1; bottom--) {
    var rowB = data[bottom];
    if (!String(rowB[ixCol] || "").trim()) continue;
    return String(rowB[ixAgenda] || "").trim();
  }
  return "";
}

/**
 * 안건 필터가 적용된 범위에서, 타임스탬프가 가장 늦은 행의 질문 ID(B 등).
 */
function resolveLatestQuestionIdInScope_(
  data,
  ixQid,
  ixAgenda,
  ixTime,
  latestAgendaId,
  hasAnyAgenda
) {
  if (!data || data.length < 2) return "";
  /** 질문 ID가 비어 있는 최신 행 때문에 ""만 잡히는 문제 방지: ID가 적힌 행 중 시각이 가장 늦은 ID를 사용 */
  var bestTime = null;
  var qidAtBest = "";
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (hasAnyAgenda && String(row[ixAgenda] || "").trim() !== latestAgendaId) continue;
    var qid = String(row[ixQid] || "").trim();
    if (!qid) continue;
    var t = ixTime >= 0 ? parseVoteTallyCellTime_(row[ixTime]) : null;
    if (t != null) {
      if (bestTime == null || t >= bestTime) {
        bestTime = t;
        qidAtBest = qid;
      }
    }
  }
  if (bestTime != null) return qidAtBest;
  for (var bottom = data.length - 1; bottom >= 1; bottom--) {
    var rowB = data[bottom];
    if (hasAnyAgenda && String(rowB[ixAgenda] || "").trim() !== latestAgendaId) continue;
    var isEmpty = rowB.every(function (x) {
      return String(x ?? "").trim() === "";
    });
    if (isEmpty) continue;
    var q2 = String(rowB[ixQid] || "").trim();
    if (q2) return q2;
  }
  return "";
}

/** 질문 ID → 표시용 문장 (JSON 속성, voteQuestionMap 시트, 헤더 폴백) */
function resolveVoteQuestionSentence_(props, ss, questionId, headerChoiceCol, headerQidCol) {
  var q = String(questionId || "").trim();
  try {
    var raw = props.getProperty("VOTE_QUESTION_TEXT_JSON");
    if (raw) {
      var m = JSON.parse(raw);
      if (m && m[q] != null && String(m[q]).trim()) return String(m[q]).trim();
    }
  } catch (e1) {
    // ignore
  }
  try {
    var shMap = ss.getSheetByName("voteQuestionMap");
    if (shMap && shMap.getLastRow() >= 2) {
      var vals = shMap.getDataRange().getValues();
      for (var i = 1; i < vals.length; i++) {
        if (String(vals[i][0] || "").trim() === q) {
          var sent = String(vals[i][1] || "").trim();
          if (sent) return sent;
        }
      }
    }
  } catch (e2) {
    // ignore
  }
  if (headerChoiceCol) return headerChoiceCol;
  if (headerQidCol) return headerQidCol;
  return q;
}

/**
 * 헤더 1행에서 부분 문자열로 열 찾기(대소문자 무시). 없으면 -1.
 */
function voteTallyHeaderMatchIndex_(headerRow, substring) {
  var sub = String(substring || "").trim();
  if (!sub) return -1;
  var low = sub.toLowerCase();
  for (var j = 0; j < headerRow.length; j++) {
    if (String(headerRow[j] || "").toLowerCase().indexOf(low) >= 0) return j;
  }
  return -1;
}

/**
 * 여러 키워드 중 첫 매칭 열(1-based). 없으면 -1.
 */
function voteTallyHeaderAutoMatch_(headerRow, keywords) {
  for (var k = 0; k < keywords.length; k++) {
    var ix = voteTallyHeaderMatchIndex_(headerRow, keywords[k]);
    if (ix >= 0) return ix + 1;
  }
  return -1;
}

/**
 * 숫자 속성 → 헤더 MATCH_* → 키워드 자동 추정 순으로 열 번호 결정(각각 1-based).
 */
function resolveVoteTallyColumnNumbers_(props, headerRow) {
  var h = headerRow || [];
  function num(key, fallback) {
    var v = parseInt(String(props.getProperty(key) || "").trim(), 10);
    return v >= 1 ? v : fallback;
  }
  function fromMatch(key) {
    var sub = props.getProperty(key);
    if (!sub) return -1;
    var ix = voteTallyHeaderMatchIndex_(h, String(sub).trim());
    return ix >= 0 ? ix + 1 : -1;
  }

  var colTime = num("VOTE_TALLY_COL_TIMESTAMP", 0);
  if (colTime < 1) colTime = fromMatch("VOTE_TALLY_MATCH_TIMESTAMP");
  if (colTime < 1) colTime = voteTallyHeaderAutoMatch_(h, ["타임스탬프", "timestamp", "time stamp"]);
  if (colTime < 1) colTime = 1;

  var colAgenda = num("VOTE_TALLY_COL_AGENDA", 0);
  if (colAgenda < 1) colAgenda = fromMatch("VOTE_TALLY_MATCH_AGENDA");
  if (colAgenda < 1) colAgenda = voteTallyHeaderAutoMatch_(h, ["안건 번호", "안건번호", "안건 id", "안건"]);
  if (colAgenda < 1) colAgenda = 5;

  var colPro = num("VOTE_TALLY_COL_PRO", 0);
  if (colPro < 1) colPro = fromMatch("VOTE_TALLY_MATCH_PRO");
  if (colPro < 1) colPro = voteTallyHeaderAutoMatch_(h, ["찬반"]);
  if (colPro < 1) colPro = 4;

  var colQid = num("VOTE_TALLY_COL_QUESTION_ID", 0);
  if (colQid < 1) colQid = fromMatch("VOTE_TALLY_MATCH_QUESTION_ID");
  if (colQid < 1) colQid = voteTallyHeaderAutoMatch_(h, ["질문 id", "question id", "문항 id", "질문id"]);
  if (colQid < 1) colQid = 2;

  var colChoice = num("VOTE_TALLY_COL_CHOICE", 0);
  if (colChoice < 1) colChoice = fromMatch("VOTE_TALLY_MATCH_CHOICE");
  if (colChoice < 1) {
    var legacyOp = String(props.getProperty("VOTE_TALLY_COL_OPINION") || "").trim();
    if (legacyOp) colChoice = parseInt(legacyOp, 10) || 0;
  }
  /** 기본 B열: 설문지 응답 시트6 등에서 선택 문항이 보통 B */
  if (colChoice < 1) colChoice = 2;

  return {
    colPro: colPro,
    colChoice: colChoice,
    colQid: colQid,
    colAgenda: colAgenda,
    colTime: colTime,
  };
}

/** 집계용 응답 탭 이름: 속성 우선, 없으면 설문지 탭 → voteResponse 순 */
function resolveVoteResponseSheetName_(ss, props) {
  var explicit = String(props.getProperty("VOTE_RESPONSE_SHEET_NAME") || "").trim();
  if (explicit) return explicit;
  try {
    if (ss.getSheetByName("설문지 응답 시트6")) return "설문지 응답 시트6";
  } catch (e1) {
    // ignore
  }
  return "voteResponse";
}

function getVoteTally_(p) {
  var props = PropertiesService.getScriptProperties();

  var ss = getSpreadsheetForVoteTally_();
  if (ss && ss.__openError) {
    return {
      ok: false,
      error:
        "통합문서를 열 수 없습니다(VOTE_TALLY_SPREADSHEET_ID). 공유 권한·ID 확인: " + ss.__openError,
      proCon: {},
      opinionChoice: {},
      sheet: "",
    };
  }
  var sheetName = resolveVoteResponseSheetName_(ss, props);
  var sh = ss.getSheetByName(sheetName);
  if (!sh) {
    return {
      ok: false,
      error:
        "시트 '" +
        sheetName +
        "'를 찾을 수 없습니다. 통합문서에 탭 이름을 확인하거나 스크립트 속성 VOTE_RESPONSE_SHEET_NAME 을 지정하세요.",
      proCon: {},
      opinionChoice: {},
      sheet: sheetName,
    };
  }
  const paramAgenda = String((p && p.agendaId) || "").trim();
  const data = sh.getDataRange().getValues();
  var headerRow = data.length ? data[0] : [];
  var cols = resolveVoteTallyColumnNumbers_(props, headerRow);
  var colPro = cols.colPro;
  var colChoice = cols.colChoice;
  var colQid = cols.colQid;
  var colAgenda = cols.colAgenda;
  var colTime = cols.colTime;

  if (!colPro || colPro < 1) colPro = 4;
  if (!colChoice || colChoice < 1) colChoice = 2;
  if (!colQid || colQid < 1) colQid = 2;
  if (!colAgenda || colAgenda < 1) colAgenda = 5;
  if (!colTime || colTime < 1) colTime = 1;
  var ixPro = colPro - 1;
  var ixChoice = colChoice - 1;
  var ixQid = colQid - 1;
  var ixAgenda = colAgenda - 1;
  var ixTime = colTime - 1;
  var disableAgenda = /^1|true|yes$/i.test(
    String(props.getProperty("VOTE_TALLY_DISABLE_AGENDA") || "").trim()
  );
  var hasAnyAgenda = false;
  if (!disableAgenda) {
    for (var ha = 1; ha < data.length; ha++) {
      if (String(data[ha][ixAgenda] || "").trim()) {
        hasAnyAgenda = true;
        break;
      }
    }
  }
  var latestAgendaIdChoice = "";
  var latestAgendaIdPro = "";
  if (!disableAgenda && hasAnyAgenda) {
    if (paramAgenda) {
      latestAgendaIdChoice = paramAgenda;
      latestAgendaIdPro = paramAgenda;
    } else {
      latestAgendaIdChoice = resolveLatestAgendaForNonEmptyCol_(
        data,
        ixAgenda,
        ixTime,
        ixChoice
      );
      latestAgendaIdPro = resolveLatestAgendaForNonEmptyCol_(data, ixAgenda, ixTime, ixPro);
      if (!latestAgendaIdChoice)
        latestAgendaIdChoice = resolveLatestVoteAgendaId_(data, ixAgenda, ixTime);
      if (!latestAgendaIdPro)
        latestAgendaIdPro = resolveLatestVoteAgendaId_(data, ixAgenda, ixTime);
    }
  }

  /** 질문 ID 열과 선택 집계 열이 같으면(구형 한 열만 사용) ID 필터 없이 집계 */
  var sameChoiceAsQid = colChoice === colQid;

  var latestQuestionId = resolveLatestQuestionIdInScope_(
    data,
    ixQid,
    ixAgenda,
    ixTime,
    latestAgendaIdChoice,
    hasAnyAgenda
  );
  var hasAnyQuestionId = false;
  if (!sameChoiceAsQid) {
    for (var hq = 1; hq < data.length; hq++) {
      var rq = data[hq];
      if (hasAnyAgenda && String(rq[ixAgenda] || "").trim() !== latestAgendaIdChoice) continue;
      if (String(rq[ixQid] || "").trim()) {
        hasAnyQuestionId = true;
        break;
      }
    }
  }

  var headerChoice =
    data[0] && data[0][ixChoice] != null ? String(data[0][ixChoice]).trim() : "";
  var headerQid =
    data[0] && data[0][ixQid] != null ? String(data[0][ixQid]).trim() : "";

  /**
   * (중요 개선) 같은 B열에 과거 질문들의 드롭다운 응답이 함께 쌓이는 경우,
   * "현재 질문"만 집계하려면 응답 행 단위로 질문 묶음을 구분해야 한다.
   *
   * onFormSubmit 트리거가 만들어주는 아래 스냅샷 열이 있으면,
   * 현재 헤더(1행)의 선택/찬반 질문 제목과 "일치하는 행만" 필터링한다.
   * - 선택문항(헤더)
   * - 찬반문항(헤더)
   *
   * 추가로, 헤더가 바뀐 경우 과거 표가 섞이지 않도록 `질문스냅샷시각` 기준으로
   * "현재 헤더 조합이 처음 등장한 시각" 이후 응답만 집계한다.
   */
  function normalizeHeaderSnapText_(s) {
    return String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim();
  }
  function headerContains_(cell, needles) {
    var t = normalizeHeaderSnapText_(cell).toLowerCase();
    for (var i = 0; i < needles.length; i++) {
      if (t.indexOf(String(needles[i]).toLowerCase()) < 0) return false;
    }
    return true;
  }
  function findHeaderIndexContains_(headerRow, needles) {
    for (var j = 0; j < (headerRow || []).length; j++) {
      if (headerContains_(headerRow[j], needles)) return j;
    }
    return -1;
  }

  var ixChoiceHeaderSnap = -1;
  var ixProHeaderSnap = -1;
  var ixHeaderSnapAt = -1;
  if (headerRow && headerRow.length) {
    // (우선) 정확한 열 이름을 먼저 찾는다. (다른 질문 헤더에 '선택' 같은 단어가 들어가도 오탐 방지)
    ixChoiceHeaderSnap = headerRow.indexOf("선택문항(헤더)");
    ixProHeaderSnap = headerRow.indexOf("찬반문항(헤더)");
    ixHeaderSnapAt = headerRow.indexOf("질문스냅샷시각");
    // (보조) 표기 흔들림이 있으면 포함 검색으로 보완
    if (ixChoiceHeaderSnap < 0) ixChoiceHeaderSnap = findHeaderIndexContains_(headerRow, ["선택", "헤더"]);
    if (ixProHeaderSnap < 0) ixProHeaderSnap = findHeaderIndexContains_(headerRow, ["찬반", "헤더"]);
    if (ixHeaderSnapAt < 0) ixHeaderSnapAt = findHeaderIndexContains_(headerRow, ["스냅샷", "시각"]);
  }
  var currentChoiceHeader = normalizeHeaderSnapText_(headerChoice);
  var currentProHeader = normalizeHeaderSnapText_(
    data[0] && data[0][ixPro] != null ? String(data[0][ixPro]).trim() : ""
  );

  // "현재 헤더 조합"이 처음 등장한 시각(최소) 계산: 이 이전 응답은 과거 표로 간주하고 제외
  var voteScopeStartMs = null;
  if (
    ixChoiceHeaderSnap >= 0 &&
    ixProHeaderSnap >= 0 &&
    ixHeaderSnapAt >= 0 &&
    currentChoiceHeader &&
    currentProHeader
  ) {
    for (var rs = 1; rs < data.length; rs++) {
      var rowS = data[rs];
      var snapCh = normalizeHeaderSnapText_(rowS[ixChoiceHeaderSnap]);
      var snapPr = normalizeHeaderSnapText_(rowS[ixProHeaderSnap]);
      if (snapCh !== currentChoiceHeader) continue;
      if (snapPr !== currentProHeader) continue;
      var tms = parseVoteTallyCellTime_(rowS[ixHeaderSnapAt]);
      if (tms == null) continue;
      if (voteScopeStartMs == null || tms < voteScopeStartMs) voteScopeStartMs = tms;
    }
  }

  if (sameChoiceAsQid) {
    latestQuestionId = "";
    hasAnyQuestionId = false;
  }

  var questionSentence = resolveVoteQuestionSentence_(
    props,
    ss,
    latestQuestionId,
    headerChoice,
    headerQid
  );

  const proCon = {};
  const opinionChoice = {};
  /** 의견(B)·찬반(D) 각각 「해당 열에 값이 있는 행 중 최신 안건」으로 따로 집계 */
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (hasAnyAgenda && !disableAgenda) {
      if (String(row[ixAgenda] || "").trim() !== latestAgendaIdChoice) continue;
    }
    if (hasAnyQuestionId) {
      if (String(row[ixQid] || "").trim() !== latestQuestionId) continue;
    }
    // 선택 스냅샷 열이 있으면 "현재 선택 질문"과 일치하는 응답만 집계
    if (ixChoiceHeaderSnap >= 0 && currentChoiceHeader) {
      var snap = normalizeHeaderSnapText_(row[ixChoiceHeaderSnap]);
      if (snap !== currentChoiceHeader) continue;
    }
    // 스냅샷 시각이 있으면 "현재 표 시작 시각" 이후만 집계
    if (voteScopeStartMs != null && ixHeaderSnapAt >= 0) {
      var tms1 = parseVoteTallyCellTime_(row[ixHeaderSnapAt]);
      if (tms1 == null || tms1 < voteScopeStartMs) continue;
    }
    var ch = String(row[ixChoice] || "").trim();
    if (ch) opinionChoice[ch] = (opinionChoice[ch] || 0) + 1;
  }
  for (var r2 = 1; r2 < data.length; r2++) {
    var row2 = data[r2];
    if (hasAnyAgenda && !disableAgenda) {
      if (String(row2[ixAgenda] || "").trim() !== latestAgendaIdPro) continue;
    }
    // 찬반 스냅샷 열이 있으면 "현재 찬반 질문"과 일치하는 응답만 집계
    if (ixProHeaderSnap >= 0 && currentProHeader) {
      var snap2 = normalizeHeaderSnapText_(row2[ixProHeaderSnap]);
      if (snap2 !== currentProHeader) continue;
    }
    if (voteScopeStartMs != null && ixHeaderSnapAt >= 0) {
      var tms2 = parseVoteTallyCellTime_(row2[ixHeaderSnapAt]);
      if (tms2 == null || tms2 < voteScopeStartMs) continue;
    }
    var pc = String(row2[ixPro] || "").trim();
    if (pc) proCon[pc] = (proCon[pc] || 0) + 1;
  }
  var tallyColumns = {
    timestamp: colTime,
    questionId: colQid,
    choice: colChoice,
    proCon: colPro,
    agenda: colAgenda,
  };
  /** 응답 시트 1행: B1=안건·의견 질문 헤더, D1=찬반 질문 헤더(열 번호는 tallyColumns 와 일치) */
  var cellB1 =
    data[0] && data[0][1] != null ? String(data[0][1]).trim() : "";
  var cellD1 =
    data[0] && data[0][ixPro] != null ? String(data[0][ixPro]).trim() : "";
  var out = {
    ok: true,
    proCon: proCon,
    opinionChoice: opinionChoice,
    sheet: sheetName,
    latestAgendaId: latestAgendaIdChoice,
    latestAgendaIdForChoice: latestAgendaIdChoice,
    latestAgendaIdForPro: latestAgendaIdPro,
    latestAgendaOnly: !paramAgenda && hasAnyAgenda,
    latestQuestionId: latestQuestionId,
    questionSentence: questionSentence,
    tallyColumns: tallyColumns,
    agendaFilterDisabled: disableAgenda,
    voteSheetTitles: {
      b1: cellB1,
      d1: cellD1,
    },
  };
  var wantDebug = p && String(p.debug || "").trim() === "1";
  if (wantDebug && headerRow.length) {
    out.headerPreview = headerRow.map(function (cell, i) {
      return { col: i + 1, header: String(cell != null ? cell : "").trim() };
    });
    out.scopeDebug = {
      currentChoiceHeader: currentChoiceHeader,
      currentProHeader: currentProHeader,
      ixChoiceHeaderSnap: ixChoiceHeaderSnap >= 0 ? ixChoiceHeaderSnap + 1 : -1,
      ixProHeaderSnap: ixProHeaderSnap >= 0 ? ixProHeaderSnap + 1 : -1,
      ixHeaderSnapAt: ixHeaderSnapAt >= 0 ? ixHeaderSnapAt + 1 : -1,
      voteScopeStartMs: voteScopeStartMs,
      voteScopeStartIso: voteScopeStartMs ? new Date(voteScopeStartMs).toISOString() : "",
      note:
        "scopeDebug는 디버그용입니다. ix*는 1-based 열 번호(A=1)입니다.",
    };
  }
  return out;
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

/* ------------------------------------------------------------------
 * (요청) 구글 폼 응답 행에 "질문 묶음" 스냅샷 남기기
 * - 폼 질문/제목이 바뀌어도 응답 행 단위로 어떤 질문이었는지 추적 가능
 * - 응답 시트 1행의 헤더(선택 문항/찬반 문항)를 해당 응답 행에 복사 기록
 *
 * 사용 방법(최초 1회):
 * 1) Apps Script 편집기에서 `setupVoteOnFormSubmitTrigger_()`를 한 번 실행(권한 승인)
 * 2) 이후 폼 응답이 들어올 때마다 자동으로 메타가 기록됨
 * ------------------------------------------------------------------ */

function resolveVoteResponseSheetNameForSubmit_(ss, props) {
  var explicit = String(props.getProperty("VOTE_RESPONSE_SHEET_NAME") || "").trim();
  if (explicit) return explicit;
  // 기본값: 집계 로직과 동일한 우선순위
  try {
    if (ss.getSheetByName("설문지 응답 시트6")) return "설문지 응답 시트6";
  } catch (e1) {}
  return "voteResponse";
}

function ensureVoteResponseMetaColumns_(sh, headerRow) {
  var header = headerRow || sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] || [];
  var names = header.map(function (x) {
    return String(x == null ? "" : x).trim();
  });
  function findOrAppend(colName) {
    var ix = names.indexOf(colName);
    if (ix >= 0) return ix + 1; // 1-based
    var newCol = names.length + 1;
    sh.insertColumnAfter(names.length || 1);
    sh.getRange(1, newCol).setValue(colName);
    names.push(colName);
    return newCol;
  }
  return {
    colChoiceHeaderSnap: findOrAppend("선택문항(헤더)"),
    colProConHeaderSnap: findOrAppend("찬반문항(헤더)"),
    colHeaderSnapAt: findOrAppend("질문스냅샷시각"),
  };
}

/**
 * 폼 응답 트리거 핸들러
 * - e.range: 새로 추가된 응답 행의 첫 셀(range) (보통 A열 타임스탬프)
 */
function onFormSubmit(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var props = PropertiesService.getScriptProperties();
    var sheetName = resolveVoteResponseSheetNameForSubmit_(ss, props);
    var sh = ss.getSheetByName(sheetName);
    if (!sh || !e || !e.range) return;
    var targetSheet = e.range.getSheet();
    if (!targetSheet || targetSheet.getSheetId() !== sh.getSheetId()) return;

    var row = e.range.getRow();
    if (row < 2) return;

    var data = sh.getDataRange().getValues();
    var headerRow = data.length ? data[0] : [];
    var cols = resolveVoteTallyColumnNumbers_(props, headerRow);
    var colChoice = cols && cols.colChoice ? cols.colChoice : 2; // 기본 B
    var colPro = cols && cols.colPro ? cols.colPro : 4; // 기본 D

    var metaCols = ensureVoteResponseMetaColumns_(sh, headerRow);
    var choiceHeader = String(sh.getRange(1, colChoice).getDisplayValue() || "").trim();
    var proHeader = String(sh.getRange(1, colPro).getDisplayValue() || "").trim();
    var stamp = new Date();

    sh.getRange(row, metaCols.colChoiceHeaderSnap).setValue(choiceHeader);
    sh.getRange(row, metaCols.colProConHeaderSnap).setValue(proHeader);
    sh.getRange(row, metaCols.colHeaderSnapAt).setValue(stamp);
  } catch (err) {
    // 트리거는 조용히 실패할 수 있어, 로그를 남긴다.
    try {
      Logger.log(String(err && err.stack ? err.stack : err));
    } catch (_) {}
  }
}

/**
 * (최초 1회) 폼 제출 트리거 설치 함수
 * - 스크립트 편집기에서 실행하면 권한 승인 후 트리거가 생성됩니다.
 */
function setupVoteOnFormSubmitTrigger_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // 중복 생성 방지: 동일 핸들러/스프레드시트 트리거가 이미 있으면 종료
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    if (t.getHandlerFunction && t.getHandlerFunction() === "onFormSubmit") {
      var src = t.getTriggerSource && t.getTriggerSource();
      if (String(src) === String(ScriptApp.TriggerSource.SPREADSHEETS)) return { ok: true, already: true };
    }
  }
  ScriptApp.newTrigger("onFormSubmit").forSpreadsheet(ss).onFormSubmit().create();
  return { ok: true, created: true };
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
