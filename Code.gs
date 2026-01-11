// 祝日カレンダーID候補（優先度順）
const HOLIDAY_CALENDAR_IDS = [
  'ja.japanese.official#holiday@group.v.calendar.google.com', // 公式（Workspace制限でブロックされることあり）
  'ja.japanese#holiday@group.v.calendar.google.com',          // 非公式（祝日+祭日混在、要フィルタ）
];
const HOLIDAY_CALENDAR_ID = HOLIDAY_CALENDAR_IDS[0]; // 後方互換用
const SHEET_HEADERS = [
  '日付',
  '曜',
  '出勤時刻',
  '休憩開始時刻',
  '休憩終了時刻',
  '退勤時刻',
  '実働(時間)',
  '作業内容',
  '作業場所',
  '備考',
];

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('勤怠管理')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(file) {
  return HtmlService.createHtmlOutputFromFile(file).getContent();
}

// ---------- 公開 API ----------

function getSettings() {
  try {
    const props = PropertiesService.getUserProperties();
    const settings = readSettings(props);
    return ok(settings);
  } catch (e) {
    return err('INTERNAL_ERROR', '設定取得に失敗しました', e);
  }
}

function saveSettings(partial) {
  try {
    const props = PropertiesService.getUserProperties();
    const merged = { ...defaultSettings(), ...readSettings(props), ...partial };
    props.setProperties({
      defaultWorkLocation: merged.defaultWorkLocation,
      projectName: merged.projectName,
      defaultBreakStart: merged.defaultBreakStart,
      defaultBreakMinutes: String(merged.defaultBreakMinutes),
      overtimeNonNegative: merged.overtimeNonNegative ? 'true' : 'false',
      autoFillBreakOnClockOut: merged.autoFillBreakOnClockOut ? 'true' : 'false',
    });
    return ok(merged);
  } catch (e) {
    return err('INTERNAL_ERROR', '設定保存に失敗しました', e);
  }
}

function getTodayStatus() {
  try {
    const today = nowJst();
    const dateStr = formatDate(today);
    const yyyyMM = formatYearMonth(today);
    const { sheet, sheetExists } = getMonthSheet(yyyyMM, { createIfMissing: true });
    const row = sheet ? findRowByDate(sheet, dateStr) : null;
    const rowData = row ? sheetRowToAttendance(sheet, row) : null;
    return ok({
      date: dateStr,
      yyyyMM,
      sheetExists: true, // 当月は存在しない場合も作成済み
      row: rowData,
      warnings: buildWarnings(rowData),
    });
  } catch (e) {
    return normalizeError(e);
  }
}

function clockIn() {
  try {
    const settings = readSettings(PropertiesService.getUserProperties());
    const now = nowJst();
    const dateStr = formatDate(now);
    const timeStr = formatTime(now);
    const yyyyMM = formatYearMonth(now);

    const { sheet } = getMonthSheet(yyyyMM, { createIfMissing: true });
    const rowIndex = ensureRow(sheet, dateStr, settings);
    const values = sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length).getValues()[0];

    if (!values[2]) {
      values[2] = timeStr; // 出勤
    }
    // 補完
    if (!values[7]) values[7] = settings.projectName;
    if (!values[8]) values[8] = settings.defaultWorkLocation;
    if (!values[3]) values[3] = settings.defaultBreakStart;

    sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length).setValues([values]);

    const row = sheetRowToAttendance(sheet, rowIndex);
    return ok({
      row,
      message: buildClockInMessage(settings.defaultWorkLocation),
    });
  } catch (e) {
    return normalizeError(e);
  }
}

function startBreak() {
  try {
    const settings = readSettings(PropertiesService.getUserProperties());
    const now = nowJst();
    const yyyyMM = formatYearMonth(now);
    const dateStr = formatDate(now);
    const timeStr = formatTime(now);
    const { sheet } = getMonthSheet(yyyyMM, { createIfMissing: true });
    const rowIndex = ensureRow(sheet, dateStr, settings);
    const range = sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length);
    const values = range.getValues()[0];
    // 出勤が必要
    if (!values[2]) {
      return err('INVALID_ARGUMENT', '先に出勤を打刻してください');
    }
    if (!values[3]) {
      values[3] = timeStr;
      range.setValues([values]);
    }
    const row = sheetRowToAttendance(sheet, rowIndex);
    return ok({ row });
  } catch (e) {
    return normalizeError(e);
  }
}

function endBreak() {
  try {
    const settings = readSettings(PropertiesService.getUserProperties());
    const now = nowJst();
    const yyyyMM = formatYearMonth(now);
    const dateStr = formatDate(now);
    const timeStr = formatTime(now);
    const { sheet } = getMonthSheet(yyyyMM, { createIfMissing: true });
    const rowIndex = ensureRow(sheet, dateStr, settings);
    const range = sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length);
    const values = range.getValues()[0];
    if (!values[3]) {
      return err('INVALID_ARGUMENT', '先に休憩開始を打刻してください');
    }
    if (!values[4]) {
      values[4] = timeStr;
      range.setValues([values]);
    }
    const row = sheetRowToAttendance(sheet, rowIndex);
    return ok({ row });
  } catch (e) {
    return normalizeError(e);
  }
}

function clockOut() {
  try {
    const settings = readSettings(PropertiesService.getUserProperties());
    const now = nowJst();
    const yyyyMM = formatYearMonth(now);
    const dateStr = formatDate(now);
    const timeStr = formatTime(now);
    const { sheet } = getMonthSheet(yyyyMM, { createIfMissing: true });
    const rowIndex = ensureRow(sheet, dateStr, settings);
    const range = sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length);
    const values = range.getValues()[0];

    // 出勤が必要
    if (!values[2]) {
      return err('INVALID_ARGUMENT', '先に出勤を打刻してください');
    }

    if (!values[5]) {
      // 退勤
      values[5] = timeStr;
    }

    // 休憩自動補完
    if (settings.autoFillBreakOnClockOut !== false) {
      if (!values[3]) values[3] = settings.defaultBreakStart;
      if (!values[4]) {
        const end = addMinutesToTime(values[3], settings.defaultBreakMinutes);
        values[4] = end;
      }
    }

    // 実働計算
    values[6] = computeWorkHours(values[2], values[3], values[4], values[5]);

    range.setValues([values]);
    const row = sheetRowToAttendance(sheet, rowIndex);

    return ok({
      row,
      message: buildClockOutMessage(values, settings.projectName, settings.defaultBreakMinutes),
    });
  } catch (e) {
    return normalizeError(e);
  }
}

function getMonthData(yyyyMM) {
  try {
    validateYyyyMm(yyyyMM);
    const { sheet, sheetExists } = getMonthSheet(yyyyMM, { createIfMissing: false });
    if (!sheet) {
      return ok({ yyyyMM, sheetExists, rows: [] });
    }
    const rows = sheetValuesToAttendance(sheet);
    return ok({ yyyyMM, sheetExists, rows });
  } catch (e) {
    return normalizeError(e);
  }
}

function getHolidays(yyyyMM) {
  try {
    validateYyyyMm(yyyyMM);
    const { set, status } = getHolidaySet(yyyyMM);
    return ok({ yyyyMM, holidaySourceStatus: status, holidays: Array.from(set) });
  } catch (e) {
    return normalizeError(e);
  }
}

function getMonthSummary(yyyyMM) {
  try {
    validateYyyyMm(yyyyMM);
    const today = formatDate(nowJst());
    const monthStart = new Date(`${yyyyMM}-01T00:00:00+09:00`);
    const monthEnd = endOfMonth(monthStart);
    const asOfDate = minDate(today, formatDate(monthEnd));

    const { set, status } = getHolidaySet(yyyyMM);
    const rows = getMonthData(yyyyMM).data.rows;

    const businessDaysTotal = countBusinessDays(monthStart, monthEnd, set);
    const asOf = new Date(`${asOfDate}T00:00:00+09:00`);
    const businessDaysToDate = countBusinessDays(monthStart, asOf, set);

    let workedHoursToDate = 0;
    let missingWorkHoursCount = 0;
    let missingClockOutCount = 0;
    rows.forEach((r) => {
      if (r.date <= asOfDate) {
        // 土日・祝日は警告カウントから除外
        const d = new Date(`${r.date}T00:00:00+09:00`);
        const dow = d.getDay();
        const isWeekend = dow === 0 || dow === 6;
        const isHoliday = set.has(r.date);
        const isBusinessDay = !isWeekend && !isHoliday;
        
        if (typeof r.workHours === 'number') workedHoursToDate += r.workHours;
        // 営業日のみ未退勤・実働未計算をカウント
        if (isBusinessDay) {
          if (typeof r.workHours !== 'number') missingWorkHoursCount += 1;
          if (!r.clockOut) missingClockOutCount += 1;
        }
      }
    });

    const scheduledHoursTotal = businessDaysTotal * 8;
    const scheduledHoursToDate = businessDaysToDate * 8;
    let overtimeToDate = workedHoursToDate - scheduledHoursToDate;
    const settings = readSettings(PropertiesService.getUserProperties());
    if (settings.overtimeNonNegative) overtimeToDate = Math.max(0, overtimeToDate);

    return ok({
      yyyyMM,
      today,
      asOfDate,
      businessDaysTotal,
      businessDaysToDate,
      scheduledHoursTotal,
      workedHoursToDate,
      scheduledHoursToDate,
      overtimeToDate,
      holidaySourceStatus: status,
      warnings: {
        missingWorkHoursCount,
        missingClockOutCount,
      },
    });
  } catch (e) {
    return normalizeError(e);
  }
}

function ensureHolidayCalendar() {
  const candidates = getHolidayCalendarCandidates();
  const errors = [];
  
  for (const calendarId of candidates) {
    try {
      // subscribeを試行（selected: trueでカレンダー一覧に表示）
      const cal = CalendarApp.subscribeToCalendar(calendarId, { selected: true });
      if (cal) {
        // 成功したらキャッシュをクリアして新しいカレンダーで取得できるようにする
        const cache = CacheService.getScriptCache();
        const now = new Date();
        const yyyyMM = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');
        // 古いキャッシュをクリア（複数の候補IDがあるため全候補分）
        candidates.forEach((id) => {
          cache.remove(`holidays:${yyyyMM}:${id}`);
        });
        cache.remove(`holidays:${yyyyMM}:none`);
        
        return ok({
          holidaySourceStatus: 'ok',
          calendarId: calendarId,
          message: `祝日カレンダー（${calendarId}）を有効化しました`,
        });
      }
    } catch (e) {
      errors.push({ calendarId, error: e.message || String(e) });
    }
  }
  
  // 全候補が失敗した場合
  return err('HOLIDAY_FETCH_FAILED', '祝日カレンダーにアクセスできません（全候補で失敗）', {
    triedCalendars: candidates,
    errors: errors,
  });
}

// ---------- 内部ユーティリティ ----------

function readSettings(props) {
  const defaults = defaultSettings();
  return {
    defaultWorkLocation: props.getProperty('defaultWorkLocation') || defaults.defaultWorkLocation,
    projectName: props.getProperty('projectName') || defaults.projectName,
    defaultBreakStart: props.getProperty('defaultBreakStart') || defaults.defaultBreakStart,
    defaultBreakMinutes: Number(props.getProperty('defaultBreakMinutes')) || defaults.defaultBreakMinutes,
    overtimeNonNegative: props.getProperty('overtimeNonNegative') === 'true',
    autoFillBreakOnClockOut: props.getProperty('autoFillBreakOnClockOut') !== 'false',
  };
}

function defaultSettings() {
  return {
    defaultWorkLocation: 'テレワーク',
    projectName: '',
    defaultBreakStart: '13:00',
    defaultBreakMinutes: 60,
    overtimeNonNegative: false,
    autoFillBreakOnClockOut: true,
  };
}

function getSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('spreadsheetId');
  if (!id) throw buildError('SPREADSHEET_NOT_CONFIGURED', 'spreadsheetId が設定されていません');
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    throw buildError('SHEET_ACCESS_FAILED', 'スプレッドシートにアクセスできません', e);
  }
}

function getMonthSheet(yyyyMM, { createIfMissing }) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(yyyyMM);
  const sheetExists = !!sheet;
  if (!sheet && createIfMissing) {
    sheet = ss.insertSheet(yyyyMM);
    sheet.appendRow(SHEET_HEADERS);
    sheet.setFrozenRows(1);
    // その月の全日付を事前に作成
    prefillMonthRows(sheet, yyyyMM);
  }
  return { sheet, sheetExists };
}

function prefillMonthRows(sheet, yyyyMM) {
  const monthStart = new Date(`${yyyyMM}-01T00:00:00+09:00`);
  const monthEnd = endOfMonth(monthStart);
  const days = monthEnd.getDate();
  const rows = [];
  for (let day = 1; day <= days; day += 1) {
    const d = new Date(monthStart.getTime());
    d.setDate(day);
    const dateStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
    const dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    rows.push([dateStr, dow, '', '', '', '', '', '', '', '']);
  }
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, SHEET_HEADERS.length).setValues(rows);
  }
}

function ensureRow(sheet, dateStr, settings) {
  const row = findRowByDate(sheet, dateStr);
  if (row) return row;
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(`${dateStr}T00:00:00+09:00`).getDay()];
  const newRow = [
    dateStr,
    dow,
    '',
    '',
    '',
    '',
    '',
    settings.projectName,
    settings.defaultWorkLocation,
    '',
  ];
  sheet.appendRow(newRow);
  return sheet.getLastRow();
}

function findRowByDate(sheet, dateStr) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (normalizeDateValue(values[i][0]) === dateStr) return i + 2;
  }
  return null;
}

function sheetRowToAttendance(sheet, rowIndex) {
  const v = sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length).getValues()[0];
  return {
    date: normalizeDateValue(v[0]),
    dow: v[1],
    clockIn: normalizeTimeValue(v[2]) || undefined,
    breakStart: normalizeTimeValue(v[3]) || undefined,
    breakEnd: normalizeTimeValue(v[4]) || undefined,
    clockOut: normalizeTimeValue(v[5]) || undefined,
    workHours: v[6] === '' ? undefined : Number(v[6]),
    workContent: v[7] || undefined,
    workLocation: v[8] || undefined,
    note: v[9] || undefined,
    rowIndex,
  };
}

function sheetValuesToAttendance(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, SHEET_HEADERS.length).getValues();
  return values.map((v, i) => ({
    date: normalizeDateValue(v[0]),
    dow: v[1],
    clockIn: normalizeTimeValue(v[2]) || undefined,
    breakStart: normalizeTimeValue(v[3]) || undefined,
    breakEnd: normalizeTimeValue(v[4]) || undefined,
    clockOut: normalizeTimeValue(v[5]) || undefined,
    workHours: v[6] === '' ? undefined : Number(v[6]),
    workContent: v[7] || undefined,
    workLocation: v[8] || undefined,
    note: v[9] || undefined,
    rowIndex: i + 2,
  }));
}

function normalizeDateValue(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  if (typeof val === 'string') return val;
  return '';
}

function normalizeTimeValue(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'Asia/Tokyo', 'HH:mm');
  }
  if (typeof val === 'string') return val;
  return '';
}
function buildWarnings(row) {
  if (!row) {
    return {
      missingClockIn: true,
      missingClockOut: true,
      missingBreakStart: true,
      missingBreakEnd: true,
      missingWorkHours: true,
    };
  }
  return {
    missingClockIn: !row.clockIn,
    missingClockOut: !row.clockOut,
    missingBreakStart: !row.breakStart,
    missingBreakEnd: !row.breakEnd,
    missingWorkHours: row.workHours == null,
  };
}

function buildClockInMessage(workLocation) {
  return `おはようございます。\n業務を開始します。\n作業場所：${workLocation}`;
}

function buildClockOutMessage(values, projectName, breakMinutes) {
  const clockIn = normalizeTimeValue(values[2]) || '--:--';
  const breakStart = normalizeTimeValue(values[3]) || '--:--';
  const breakEndRaw = normalizeTimeValue(values[4]);
  const breakEnd = breakEndRaw || addMinutesToTime(breakStart, breakMinutes) || '--:--';
  const clockOut = normalizeTimeValue(values[5]) || '--:--';
  const dateStr = normalizeDateValue(values[0]);
  const date = dateStr ? dateStr.slice(5).replace('-', '/') : '--/--';
  return [
    'お疲れ様です。',
    '本日の業務を終了します。',
    `====${date} 作業実績===`,
    `${clockIn} - ${breakStart} [作業] ${projectName}`,
    `${breakStart} - ${breakEnd} [昼休憩]`,
    `${breakEnd} - ${clockOut} [作業] ${projectName}`,
  ].join('\n');
}

function computeWorkHours(clockIn, breakStart, breakEnd, clockOut) {
  if (!clockIn || !breakStart || !breakEnd || !clockOut) return '';
  const ci = timeToMinutes(clockIn);
  const bs = timeToMinutes(breakStart);
  const be = timeToMinutes(breakEnd);
  const co = timeToMinutes(clockOut);
  let workMinutes = (co - ci) - (be - bs);
  if (isNaN(workMinutes)) return '';
  if (workMinutes < 0) workMinutes = 0;
  return Math.round((workMinutes / 60) * 100) / 100;
}

function timeToMinutes(t) {
  const normalized = normalizeTimeValue(t);
  if (!normalized) return NaN;
  const parts = normalized.split(':');
  if (parts.length < 2) return NaN;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

function addMinutesToTime(timeStr, minutes) {
  const base = timeToMinutes(timeStr);
  if (Number.isNaN(base)) return '';
  const total = base + Number(minutes || 0);
  if (Number.isNaN(total)) return '';
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${('0' + h).slice(-2)}:${('0' + m).slice(-2)}`;
}

function nowJst() {
  // Return a fresh Date; timezone-adjusted string化は各format関数で行う
  return new Date();
}

function formatDate(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function formatTime(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm');
}

function formatYearMonth(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM');
}

function endOfMonth(dateObj) {
  const d = new Date(dateObj.getTime());
  d.setMonth(d.getMonth() + 1, 0);
  return d;
}

function minDate(a, b) {
  return a < b ? a : b;
}

function validateYyyyMm(yyyyMM) {
  if (!/^\d{4}-\d{2}$/.test(yyyyMM)) {
    throw buildError('INVALID_ARGUMENT', 'yyyyMM の形式が不正です');
  }
}

// 祝日カレンダーID候補リスト取得（ScriptProperties優先 → デフォルト候補）
function getHolidayCalendarCandidates() {
  const custom = PropertiesService.getScriptProperties().getProperty('holidayCalendarId');
  if (custom) {
    // カスタム設定があれば最優先、その後デフォルト候補
    return [custom, ...HOLIDAY_CALENDAR_IDS.filter((id) => id !== custom)];
  }
  return HOLIDAY_CALENDAR_IDS;
}

// 祝日カレンダーID取得（後方互換: 最優先候補を返す）
function getHolidayCalendarId() {
  return getHolidayCalendarCandidates()[0];
}

// カレンダー取得を試行（getById → subscribe → getById）
function tryGetCalendar(calendarId) {
  let cal = CalendarApp.getCalendarById(calendarId);
  if (cal) return cal;
  // 未登録の場合はsubscribeを試す
  try {
    cal = CalendarApp.subscribeToCalendar(calendarId, { selected: false });
    if (cal) return cal;
  } catch (e) {
    // subscribeに失敗した場合は無視（次の候補へ）
  }
  return null;
}

// 祝日カレンダーを解決（候補を順に試行し、最初に成功したものを返す）
function resolveHolidayCalendar() {
  const candidates = getHolidayCalendarCandidates();
  for (const id of candidates) {
    const cal = tryGetCalendar(id);
    if (cal) {
      return { cal, calendarId: id };
    }
  }
  return { cal: null, calendarId: null };
}

// イベントが公的祝日かどうかを判定（Qiita記事参照: descriptionに「祝日」を含むもののみ）
// 参考: https://qiita.com/sakaimo/items/0a0a31697dd821e775cd
function isPublicHoliday(event) {
  try {
    const desc = event.getDescription() || '';
    // descriptionが空の場合は従来通り祝日扱い（official IDの場合など）
    if (!desc) return true;
    // 「祝日」を含む場合のみ公的祝日とみなす（「祭日」「行事」は除外）
    return desc.includes('祝日');
  } catch (e) {
    // getDescription()が失敗した場合は祝日扱い（安全側に倒す）
    return true;
  }
}

// 祝日取得 + キャッシュ（カレンダーID込みでキャッシュキー生成）
function getHolidaySet(yyyyMM) {
  const { cal, calendarId } = resolveHolidayCalendar();
  
  // キャッシュキーにカレンダーIDを含める（ID変更時に即反映）
  const cacheKeyId = calendarId || 'none';
  const cache = CacheService.getScriptCache();
  const cacheKey = `holidays:${yyyyMM}:${cacheKeyId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    return { set: new Set(parsed.holidays), status: parsed.status, calendarId: parsed.calendarId };
  }
  
  const monthStart = new Date(`${yyyyMM}-01T00:00:00+09:00`);
  const monthEnd = endOfMonth(monthStart);
  let status = 'ok';
  let holidays = [];
  
  if (!cal) {
    status = 'unavailable';
  } else {
    try {
      const events = cal.getEvents(monthStart, addDays(monthEnd, 1));
      const set = new Set();
      events.forEach((ev) => {
        // 公的祝日のみをフィルタ
        if (isPublicHoliday(ev)) {
          const d = Utilities.formatDate(ev.getStartTime(), 'Asia/Tokyo', 'yyyy-MM-dd');
          set.add(d);
        }
      });
      holidays = Array.from(set);
    } catch (e) {
      status = 'unavailable';
    }
  }
  
  cache.put(cacheKey, JSON.stringify({ holidays, status, calendarId }), 21600); // 6h
  return { set: new Set(holidays), status, calendarId };
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function countBusinessDays(start, end, holidaySet) {
  let count = 0;
  const d = new Date(start);
  while (d <= end) {
    const dow = d.getDay();
    const dateStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = holidaySet.has(dateStr);
    if (!isWeekend && !isHoliday) count += 1;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ---------- エラー/レスポンス ----------

function ok(data) {
  return { ok: true, data };
}

function err(code, message, detail) {
  let serializedDetail = null;
  if (detail) {
    if (detail instanceof Error) {
      serializedDetail = { name: detail.name, message: detail.message, stack: detail.stack };
    } else if (typeof detail === 'object') {
      try {
        serializedDetail = JSON.parse(JSON.stringify(detail));
      } catch (e) {
        serializedDetail = String(detail);
      }
    } else {
      serializedDetail = String(detail);
    }
  }
  return { ok: false, error: { code, message, detail: serializedDetail } };
}

function buildError(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  return e;
}

function normalizeError(e) {
  if (e && e.code) return err(e.code, e.message || '', e.detail);
  // Error オブジェクトを渡すと err() 内でシリアライズされる
  return err('INTERNAL_ERROR', '内部エラーが発生しました', e);
}
