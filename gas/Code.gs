/**
 * Symphonic Starmine 2027 飲食出店 応募フォーム（保存側 / Google Apps Script ウェブアプリ）
 *
 * - API は全部 POST（本文は JSON・Content-Type は text/plain）。GET は「動いています」だけ返す。
 * - 本人は IDトークンを LINE の verify API で確かめて得た sub だけ。本文の userId は一切使わない。
 * - 共有ドライブに作るので Advanced Drive Service（Drive v3, supportsAllDrives: true）を使う。
 */

/* ===== 期間（ここ1か所だけ。画面の日付は status の返り値から出す） ===== */
var DEADLINE = '2027-02-22T00:00:00+09:00'; // これより前なら受付中（開始日は無い）
var DEADLINE_TEXT = '2027年2月21日（日）23:59';
var RESULT_DATE_TEXT = '2027年2月26日（金）';

/* ===== 固定値 ===== */
var TZ = 'Asia/Tokyo';
var SHEET_NAME = '応募';
var ROOT_FOLDER_NAME = '飲食出店 応募フォームの回答'; // 名前に「応募フォーム」「回答」を含める（Symphonic OS の Drive 取り込み除外のため。変えない）
var TEMP_FOLDER_NAME = '一時保管';
var REPLACED_FOLDER_NAME = '差し替え前';
var SPREADSHEET_NAME = '飲食出店 応募フォームの回答 シート';
var FOLDER_MIME = 'application/vnd.google-apps.folder';
var SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
var VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
var PUSH_URL = 'https://api.line.me/v2/bot/message/push';
var MAX_TEXT = 2000;
var MAX_FILE_BYTES = 10 * 1024 * 1024;
var MAX_FILES_PER_FIELD = 3;
var LINE_CHUNK = 4800;
var LINE_MAX_MESSAGES = 5;
var TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
var ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf'];
var EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp', 'application/pdf': 'pdf' };
var TYPE_CAR = 'キッチンカー';
var TYPE_TENT = 'テント（半張り）';
var SECTION_TITLES = { s1: '出店者情報', s2: 'キッチンカーの情報', s3: 'テント（半張り）の情報', s4: '出店内容' };

/* 末尾の固定列 */
var FIXED_LABELS = { receiptNo: '受付番号', createdAt: '受付日時', updatedAt: '最終変更日時', lineUserId: 'LINEユーザーID', lineName: 'LINE表示名' };
/* 後から足す項目の見出しはここへ（右端に足す。既存列の並びは変えない） */
var TAIL_LABELS = [];
var PAIRS = [['item2Name', 'item2Price']]; // 片方だけの入力は不可

/* 質問の定義。index.html の schema と同じ内容（test/run.mjs が食い違いを検出する）。
   build は不要。直すときは両方を直す。 */
/*FIELDS_BEGIN*/
var FIELDS = [
  {"key":"company","label":"会社名（団体名）","type":"text","scope":"all","sec":"s1","req":true},
  {"key":"shop","label":"店舗名（屋号）","type":"text","scope":"all","sec":"s1","req":true},
  {"key":"rep","label":"代表者名","type":"text","scope":"all","sec":"s1","req":true},
  {"key":"contact","label":"当日担当者","type":"text","scope":"all","sec":"s1","req":true},
  {"key":"zip","label":"郵便番号","type":"zip","scope":"all","sec":"s1","req":true},
  {"key":"pref","label":"都道府県","type":"select","scope":"all","sec":"s1","req":true,"options":["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"]},
  {"key":"city","label":"市町村","type":"text","scope":"all","sec":"s1","req":true},
  {"key":"addr","label":"町名番地","type":"text","scope":"all","sec":"s1","req":true},
  {"key":"tel","label":"電話番号","type":"tel","scope":"all","sec":"s1","req":true},
  {"key":"email","label":"メールアドレス","type":"email","scope":"all","sec":"s1","req":true},
  {"key":"invoiceTo","label":"出店料請求書の宛名","type":"text","scope":"all","sec":"s1","req":true},
  {"key":"invoiceNo","label":"インボイス登録番号","type":"text","scope":"all","sec":"s1","req":false},
  {"key":"dayMobile","label":"当日担当者の携帯番号","type":"tel","scope":"all","sec":"s1","req":true},
  {"key":"type","label":"出店形態","type":"select","scope":"all","sec":"s1","req":true,"options":["キッチンカー","テント（半張り）"]},
  {"key":"carLen","label":"車両の全長（m）","type":"num","scope":"car","sec":"s2","req":true},
  {"key":"carWid","label":"車両の幅（m）","type":"num","scope":"car","sec":"s2","req":true},
  {"key":"carHei","label":"車両の高さ（m）","type":"num","scope":"car","sec":"s2","req":true},
  {"key":"carPlate","label":"車両ナンバー","type":"text","scope":"car","sec":"s2","req":true},
  {"key":"genUse","label":"発電機","type":"select","scope":"car","sec":"s2","req":true,"options":["持ち込む","持ち込まない"]},
  {"key":"genKva","label":"発電機の出力（kVA）","type":"num","scope":"car","sec":"s2","req":true,"when":{"key":"genUse","eq":"持ち込む"}},
  {"key":"genFuel","label":"発電機の燃料","type":"select","scope":"car","sec":"s2","req":true,"options":["ガソリン","軽油","その他"],"when":{"key":"genUse","eq":"持ち込む"}},
  {"key":"genFuelOther","label":"発電機の燃料（その他）","type":"text","scope":"car","sec":"s2","req":true,"when":{"key":"genFuel","eq":"その他"}},
  {"key":"carLpg","label":"LPガスの使用","sheet":"LPガスの使用（キッチンカー）","type":"select","scope":"car","sec":"s2","req":true,"options":["使う","使わない"]},
  {"key":"carExtra","label":"追加車両","type":"select","scope":"car","sec":"s2","req":true,"options":["なし","あり（2台目）"]},
  {"key":"file_car_photo","label":"キッチンカーの写真","type":"file","scope":"car","sec":"s2","req":true},
  {"key":"file_car_layout","label":"車内の配置図","type":"file","scope":"car","sec":"s2","req":true},
  {"key":"file_car_permit","label":"営業許可証の写し","type":"file","scope":"car","sec":"s2","req":true},
  {"key":"menuProcess","label":"メニューごとのメニュー名と簡単な調理工程","type":"area","scope":"tent","sec":"s3","req":true},
  {"key":"fire","label":"火気の使用","type":"select","scope":"tent","sec":"s3","req":true,"options":["使う","使わない"]},
  {"key":"tentLpg","label":"LPガスの使用","sheet":"LPガスの使用（テント）","type":"select","scope":"tent","sec":"s3","req":true,"options":["使う","使わない"]},
  {"key":"tentCars","label":"搬入で使用する車の台数","type":"select","scope":"tent","sec":"s3","req":true,"options":["1台","2台"]},
  {"key":"tentCarKinds","label":"搬入で使用する車の種類","type":"check","scope":"tent","sec":"s3","req":true,"options":["トラック","乗用車"]},
  {"key":"file_tent_photo","label":"ブースの写真・イメージ","type":"file","scope":"tent","sec":"s3","req":true},
  {"key":"item1Name","label":"出店商品①の商品名","type":"text","scope":"all","sec":"s4","req":true},
  {"key":"item1Price","label":"出店商品①の価格（税込）","type":"text","scope":"all","sec":"s4","req":true},
  {"key":"item2Name","label":"出店商品②の商品名","type":"text","scope":"all","sec":"s4","req":false},
  {"key":"item2Price","label":"出店商品②の価格（税込）","type":"text","scope":"all","sec":"s4","req":false},
  {"key":"moreItems","label":"3品目以降の商品名と価格（税込）","type":"area","scope":"all","sec":"s4","req":false},
  {"key":"staff","label":"当日のスタッフ人数","type":"int","scope":"all","sec":"s4","req":true},
  {"key":"cashless","label":"使用できるキャッシュレス決済","type":"check","scope":"all","sec":"s4","req":true,"options":["PayPay","クレジットカード","交通系IC","その他"]},
  {"key":"cashlessOther","label":"使用できるキャッシュレス決済（その他）","type":"text","scope":"all","sec":"s4","req":true,"when":{"key":"cashless","has":"その他"}},
  {"key":"history","label":"主な出店実績","type":"area","scope":"all","sec":"s4","req":false},
  {"key":"pr","label":"店舗のPR文","type":"area","scope":"all","sec":"s4","req":false},
  {"key":"file_menu_photo","label":"メインメニューの写真","type":"file","scope":"all","sec":"s4","req":true},
  {"key":"file_pl","label":"PL保険証の写し","type":"file","scope":"all","sec":"s4","req":true},
  {"key":"consents","label":"同意事項","type":"consent","scope":"all","sec":"s4","req":true,"items":[{"text":"募集要項の内容を確認し、同意します","scope":"all"},{"text":"2日間とも出店します","scope":"all"},{"text":"ドリンク・アルコール類は販売しません","scope":"all"},{"text":"ファストパス（限定テラスシート・プレミアムオプションの特典）をご提示のお客様に、列に関係なく最優先で販売します","scope":"all"},{"text":"生産物賠償責任保険（PL保険）に加入しています","scope":"all"},{"text":"製造5年以内の消火器を設置します","scope":"all"},{"text":"出店者およびその従業員は、暴力団、暴力団員、暴力団関係企業・団体またはその関係者、その他反社会的勢力ではありません","scope":"all"},{"text":"滋賀県草津市で有効な食品営業許可証を得た移動販売車を保有しています","scope":"car"}]},
  {"key":"inquiry","label":"ご質問等ございましたらご記入ください。","type":"area","scope":"all","sec":"s4","req":false}
];
/*FIELDS_END*/

/* ===== 見出し ===== */
function sheetLabel_(f) { return f.sheet || f.label; }
function allLabels_() {
  var labels = [];
  FIELDS.forEach(function (f) { labels.push(sheetLabel_(f)); });
  Object.keys(FIXED_LABELS).forEach(function (k) { labels.push(FIXED_LABELS[k]); });
  TAIL_LABELS.forEach(function (l) { labels.push(l); });
  return labels;
}
function fileFields_() { return FIELDS.filter(function (f) { return f.type === 'file'; }); }
function fieldByKey_(key) {
  for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === key) return FIELDS[i];
  return null;
}

/* ===== 小さな道具 ===== */
function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k) { return props_().getProperty(k) || ''; }
function setProp_(k, v) { props_().setProperty(k, v); }
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function err_(code, message, extra) {
  var o = { ok: false, error: code, message: message };
  if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
  return o;
}
function isClosed_() { return new Date().getTime() >= Date.parse(DEADLINE); }
function pad2_(n) { return n < 10 ? '0' + n : String(n); }
function nowText_() { return Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm:ss'); }
function esc_(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

/* ===== 入口 ===== */
function doGet() {
  return ContentService.createTextOutput('動いています');
}
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (x) {
    return out_(err_('badRequest', 'リクエストの形式が正しくありません。'));
  }
  return out_(handle_(body));
}
function handle_(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return err_('badRequest', 'リクエストの形式が正しくありません。');
    var who = identify_(body);
    if (!who) return err_('unauthorized', '本人確認に失敗しました。このページを開き直してください。');
    switch (body.action) {
      case 'status': return actionStatus_(who);
      case 'upload': return actionUpload_(who, body);
      case 'submit': return actionSubmit_(who, body);
      default: return err_('badRequest', 'リクエストの形式が正しくありません。');
    }
  } catch (x) {
    Logger.log('handle_ error: ' + (x && x.message));
    return err_('server', '処理に失敗しました。しばらくしてからもう一度お試しください。');
  }
}

/* ===== 本人確認 ===== */
/** 本人のIDを返す。確かめられなければ null（予備の道は作らない）。本文の userId は見ない。 */
function identify_(body) {
  var secret = prop_('TEST_SECRET');
  if (secret && typeof body.testSecret === 'string' && body.testSecret === secret &&
      typeof body.testUserId === 'string' && body.testUserId.indexOf('TEST_') === 0) {
    return { sub: body.testUserId, name: String(body.testName || 'テスト'), test: true };
  }
  var token = body.idToken;
  if (typeof token !== 'string' || !token) return null;
  var channelId = prop_('LINE_LOGIN_CHANNEL_ID');
  if (!channelId) return null;
  var res = UrlFetchApp.fetch(VERIFY_URL, {
    method: 'post',
    payload: { id_token: token, client_id: channelId },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return null;
  var j;
  try { j = JSON.parse(res.getContentText()); } catch (x) { return null; }
  if (!j || typeof j.sub !== 'string' || !j.sub) return null;
  return { sub: j.sub, name: typeof j.name === 'string' ? j.name : '', test: false };
}

/* ===== Drive（Advanced Drive Service v3） ===== */
var FILE_FIELDS_ = 'id,name,mimeType,description,parents,trashed,createdTime';
function driveGet_(id) {
  return Drive.Files.get(id, { fields: FILE_FIELDS_, supportsAllDrives: true });
}
function driveList_(q) {
  var items = [], token = '';
  do {
    var opt = { q: q, corpora: 'allDrives', supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 200, fields: 'nextPageToken,files(' + FILE_FIELDS_ + ')' };
    if (token) opt.pageToken = token;
    var r = Drive.Files.list(opt);
    items = items.concat(r.files || []);
    token = r.nextPageToken || '';
  } while (token);
  return items;
}
function driveCreateFolder_(name, parentId) {
  return Drive.Files.create({ name: name, mimeType: FOLDER_MIME, parents: [parentId] }, null, { supportsAllDrives: true });
}
function driveFindFolder_(name, parentId) {
  var found = driveList_("'" + esc_(parentId) + "' in parents and name = '" + esc_(name) + "' and mimeType = '" + FOLDER_MIME + "' and trashed = false");
  return found.length ? found[0] : null;
}
function driveEnsureFolder_(name, parentId) {
  return driveFindFolder_(name, parentId) || driveCreateFolder_(name, parentId);
}
function driveMove_(id, fromParents, toParent, newName) {
  var resource = {};
  if (newName) resource.name = newName;
  var opt = { supportsAllDrives: true };
  if (toParent) opt.addParents = toParent;
  var rm = (fromParents || []).filter(function (p) { return p !== toParent; });
  if (rm.length) opt.removeParents = rm.join(',');
  return Drive.Files.update(resource, id, null, opt);
}
function driveTrash_(id) {
  return Drive.Files.update({ trashed: true }, id, null, { supportsAllDrives: true });
}
function extOf_(name, mime) {
  var m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  if (m) return m[1].toLowerCase();
  return EXT_BY_MIME[mime] || 'dat';
}

/* ===== セットアップ・運用 ===== */
/** フォルダ・シートを作る（2回実行しても増えない）。エディタで1回実行する。 */
function setup() {
  var parentId = prop_('PARENT_FOLDER_ID');
  if (!parentId) throw new Error('スクリプトプロパティ PARENT_FOLDER_ID を入れてください。');
  var root = driveEnsureFolder_(ROOT_FOLDER_NAME, parentId);
  var temp = driveEnsureFolder_(TEMP_FOLDER_NAME, root.id);
  var sheetFile = null;
  var found = driveList_("'" + esc_(root.id) + "' in parents and name = '" + esc_(SPREADSHEET_NAME) + "' and mimeType = '" + SHEET_MIME + "' and trashed = false");
  if (found.length) sheetFile = found[0];
  else sheetFile = Drive.Files.create({ name: SPREADSHEET_NAME, mimeType: SHEET_MIME, parents: [root.id] }, null, { supportsAllDrives: true });
  setProp_('ROOT_FOLDER_ID', root.id);
  setProp_('TEMP_FOLDER_ID', temp.id);
  setProp_('SHEET_ID', sheetFile.id);
  var ss = SpreadsheetApp.openById(sheetFile.id);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    var sheets = ss.getSheets();
    if (sheets.length === 1 && sheets[0].getLastRow() === 0) { sh = sheets[0]; sh.setName(SHEET_NAME); }
    else sh = ss.insertSheet(SHEET_NAME);
  }
  ensureHeaders_(sh);
  Logger.log('setup done');
}
/** 時間トリガー（1日1回の片付け）と、シートを開いたときのメニューを作る。 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'cleanupTemp' || h === 'onOpen') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cleanupTemp').timeBased().everyDays(1).atHour(3).create();
  var sid = prop_('SHEET_ID');
  if (sid) ScriptApp.newTrigger('onOpen').forSpreadsheet(sid).onOpen().create();
}
/** 一時保管フォルダの直下にある、作成から24時間以上たったファイルだけをゴミ箱へ。ほかには触らない。 */
function cleanupTemp() {
  var tempId = prop_('TEMP_FOLDER_ID');
  if (!tempId) return 0;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { Logger.log('cleanupTemp: ロックが取れないので今日は何もしない'); return 0; }
  try {
    return cleanupTempLocked_(tempId);
  } finally {
    lock.releaseLock();
  }
}
function cleanupTempLocked_(tempId) {
  var limit = new Date().getTime() - TEMP_MAX_AGE_MS;
  var n = 0;
  driveList_("'" + esc_(tempId) + "' in parents and trashed = false").forEach(function (f) {
    if (f.mimeType === FOLDER_MIME) return;
    if (!f.parents || f.parents.indexOf(tempId) < 0) return;
    if (Date.parse(f.createdTime) > limit) return;
    driveTrash_(f.id);
    n++;
  });
  Logger.log('cleanupTemp: ' + n);
  return n;
}
/** 応募済みの印を消す（手で使う）。行を消しただけでは印は残る。 */
function resetApplied(sub) {
  if (!sub) throw new Error('LINEのユーザーIDを渡してください。');
  props_().deleteProperty('applied:' + sub);
  Logger.log('applied mark removed');
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('飲食出店フォーム')
    .addItem('公式LINEの鍵を設定', 'setLineToken')
    .addItem('LINEの最後の送信結果', 'showLineResult')
    .addToUi();
}
function setLineToken() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('公式LINEの鍵を設定', 'チャネルアクセストークン（長期）を貼り付けてください。', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var t = String(r.getResponseText() || '').trim();
  if (!t) { ui.alert('入力が空でした。'); return; }
  setProp_('LINE_CHANNEL_TOKEN', t);
  ui.alert('保存しました。');
}
function showLineResult() {
  SpreadsheetApp.getUi().alert(prop_('LINE_LAST_RESULT') || 'まだ送信していません。');
}
/** エディタで1回実行して、外部接続の許可を出す（許可画面のチェックを外すと二度と聞かれないため全部求める）。 */
function checkLine() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  var token = prop_('LINE_CHANNEL_TOKEN');
  if (!token) { Logger.log('LINE_CHANNEL_TOKEN が未設定です。'); return; }
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  Logger.log('LINE bot info: ' + res.getResponseCode());
}

/* ===== シート ===== */
function getSheet_() {
  var sid = prop_('SHEET_ID');
  if (!sid) throw new Error('setup() が終わっていません。');
  var sh = SpreadsheetApp.openById(sid).getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('シート「' + SHEET_NAME + '」がありません。');
  return sh;
}
/** 見出し行を確かめ、足りない見出しだけ右端に足す。見出しの配列を返す。 */
function ensureHeaders_(sh) {
  var lastCol = sh.getLastColumn();
  var headers = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  var added = false;
  allLabels_().forEach(function (l) {
    if (headers.indexOf(l) < 0) {
      headers.push(l);
      sh.getRange(1, headers.length).setNumberFormat('@').setValue(l);
      added = true;
    }
  });
  if (added) {
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return headers;
}
function findRow_(sh, headers, receiptNo) {
  var col = headers.indexOf(FIXED_LABELS.receiptNo);
  var last = sh.getLastRow();
  if (col < 0 || last < 2) return 0;
  var vals = sh.getRange(2, col + 1, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === receiptNo) return i + 2;
  return 0;
}
function fileUrl_(id) { return 'https://drive.google.com/file/d/' + id + '/view'; }
function idsFromCell_(v) {
  var ids = [], re = /\/d\/([A-Za-z0-9_-]+)/g, m, s = String(v || '');
  while ((m = re.exec(s))) ids.push(m[1]);
  return ids;
}
/** 1応募ぶんの「見出し→文字」。フォームが持つ列だけ。 */
function cellsFor_(v, filesByKey, finalFiles) {
  var cells = {};
  FIELDS.forEach(function (f) {
    var label = sheetLabel_(f), val = v[f.key];
    if (f.type === 'file') {
      cells[label] = (finalFiles[f.key] || []).map(function (x) { return fileUrl_(x.id); }).join('\n');
    } else if (f.type === 'consent') {
      cells[label] = (val && val.length) ? '同意済み' : '';
    } else if (f.type === 'check') {
      cells[label] = (val || []).join('、');
    } else {
      cells[label] = val == null ? '' : String(val);
    }
  });
  return cells;
}
function rowToEntry_(headers, rowVals) {
  var data = {}, files = {};
  var type = '';
  FIELDS.forEach(function (f) {
    var idx = headers.indexOf(sheetLabel_(f));
    var raw = idx >= 0 && rowVals[idx] != null ? String(rowVals[idx]) : '';
    if (f.key === 'type') type = raw;
    if (f.type === 'file') files[f.key] = idsFromCell_(raw);
    else if (f.type === 'check') data[f.key] = raw ? raw.split('、').filter(function (x) { return x; }) : [];
    else if (f.type === 'consent') {
      data[f.key] = raw ? f.items.filter(function (c) { return scopeMatch_(c.scope, type); }).map(function (c) { return c.text; }) : [];
    } else data[f.key] = raw;
  });
  return { data: data, files: files };
}
function scopeMatch_(scope, type) {
  return scope === 'all' || (scope === 'car' && type === TYPE_CAR) || (scope === 'tent' && type === TYPE_TENT);
}

/* ===== status ===== */
function loadEntry_(receiptNo) {
  var sh = getSheet_();
  var headers = ensureHeaders_(sh);
  var row = findRow_(sh, headers, receiptNo);
  if (!row) return null;
  var vals = sh.getRange(row, 1, 1, headers.length).getValues()[0];
  var e = rowToEntry_(headers, vals);
  var files = {};
  Object.keys(e.files).forEach(function (k) {
    files[k] = e.files[k].map(function (id) {
      var name = id;
      try { name = driveGet_(id).name; } catch (x) { /* 読めなければIDのまま */ }
      return { id: id, name: name };
    });
  });
  return { receiptNo: receiptNo, data: e.data, files: files };
}
function actionStatus_(who) {
  var closed = isClosed_();
  var receipt = prop_('applied:' + who.sub);
  var res = { ok: true, closed: closed, applied: !!receipt, canEdit: !closed && !!receipt, deadlineText: DEADLINE_TEXT, resultDateText: RESULT_DATE_TEXT };
  if (receipt) {
    var entry = loadEntry_(receipt);
    if (!entry) return err_('rowNotFound', 'ご応募内容を読み込めませんでした。運営までお問い合わせください。');
    res.entry = entry;
  }
  return res;
}

/* ===== upload ===== */
function actionUpload_(who, body) {
  if (isClosed_()) return err_('closed', '応募の受付は終了しました。');
  var f = typeof body.field === 'string' ? fieldByKey_(body.field) : null;
  if (!f || f.type !== 'file') return err_('badRequest', 'リクエストの形式が正しくありません。');
  var mime = typeof body.mimeType === 'string' ? body.mimeType : '';
  if (ALLOWED_MIME.indexOf(mime) < 0) return err_('badType', '画像（JPEG・PNG・HEIC・WebP）またはPDFを選んでください。');
  var b64 = typeof body.base64 === 'string' ? body.base64 : '';
  if (!b64) return err_('badRequest', 'リクエストの形式が正しくありません。');
  if (b64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8) return err_('tooLarge', 'ファイルは10MBまでです。');
  var bytes = Utilities.base64Decode(b64);
  if (bytes.length > MAX_FILE_BYTES) return err_('tooLarge', 'ファイルは10MBまでです。');
  if (bytes.length === 0) return err_('badRequest', 'リクエストの形式が正しくありません。');
  var name = String(body.name || 'file').split(/[\\/]/).pop().replace(/[\r\n\t]/g, ' ').slice(0, 100) || 'file';
  var tempId = prop_('TEMP_FOLDER_ID');
  if (!tempId) throw new Error('setup() が終わっていません。');
  var blob = Utilities.newBlob(bytes, mime, name);
  var file = Drive.Files.create({ name: name, mimeType: mime, parents: [tempId], description: 'owner:' + who.sub }, blob, { supportsAllDrives: true });
  return { ok: true, fileId: file.id, name: name };
}

/* ===== 検証（サーバー側） ===== */
function isActive_(f, type, out) {
  if (!scopeMatch_(f.scope, type)) return false;
  if (f.when) {
    var dep = out[f.when.key];
    if (f.when.eq !== undefined) return dep === f.when.eq;
    return Array.isArray(dep) && dep.indexOf(f.when.has) >= 0;
  }
  return true;
}
function normalize_(data) {
  var errors = [], out = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: [{ field: 'type', message: '入力内容を確認できませんでした。' }], out: out };
  }
  var type = typeof data.type === 'string' ? data.type.trim() : '';
  FIELDS.forEach(function (f) {
    if (f.type === 'file') return;
    var multi = f.type === 'check' || f.type === 'consent';
    if (!isActive_(f, type, out)) { out[f.key] = multi ? [] : ''; return; }
    var raw = data[f.key];
    var bad = function (msg) { errors.push({ field: f.key, message: f.label + msg }); out[f.key] = multi ? [] : ''; };
    if (multi) {
      var arr = raw === undefined ? [] : raw;
      if (!Array.isArray(arr) || arr.some(function (x) { return typeof x !== 'string'; })) return bad('を確認できませんでした。');
      var uniq = [];
      arr.forEach(function (x) { if (uniq.indexOf(x) < 0) uniq.push(x); });
      if (f.type === 'check') {
        if (uniq.some(function (x) { return f.options.indexOf(x) < 0; })) return bad('の選択内容が正しくありません。');
        if (f.req && uniq.length < 1) return bad('を選択してください。');
        out[f.key] = uniq;
      } else {
        var need = f.items.filter(function (c) { return scopeMatch_(c.scope, type); }).map(function (c) { return c.text; });
        var missing = need.some(function (t) { return uniq.indexOf(t) < 0; });
        if (missing) return bad('のすべての項目にチェックしてください。');
        out[f.key] = need;
      }
      return;
    }
    if (raw === undefined || raw === null) raw = '';
    if (typeof raw !== 'string') return bad('を確認できませんでした。');
    var s = f.type === 'area' ? raw.replace(/\r\n?/g, '\n').trim() : raw.replace(/[\r\n]+/g, ' ').trim();
    if (s.length > MAX_TEXT) return bad('は' + MAX_TEXT + '字以内でご記入ください。');
    if (s === '') {
      if (f.req) return bad(f.type === 'select' ? 'を選択してください。' : 'を入力してください。');
      out[f.key] = '';
      return;
    }
    var ok = true;
    if (f.type === 'select') ok = f.options.indexOf(s) >= 0;
    else if (f.type === 'zip') ok = /^[0-9]{3}-?[0-9]{4}$/.test(s);
    else if (f.type === 'tel') ok = /^[0-9][0-9-]{8,12}$/.test(s);
    else if (f.type === 'email') ok = s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    else if (f.type === 'num') ok = /^[0-9]+(\.[0-9]+)?$/.test(s) && parseFloat(s) > 0 && parseFloat(s) <= 9999;
    else if (f.type === 'int') ok = /^[0-9]+$/.test(s) && parseInt(s, 10) >= 1 && parseInt(s, 10) <= 9999;
    if (!ok) return bad(f.type === 'select' ? 'の選択内容が正しくありません。' : 'の形式をご確認ください。');
    out[f.key] = s;
  });
  // 片方だけの入力は不可（11/22 コーキの指示）。両方書くか、両方空
  PAIRS.forEach(function (pr) {
    var a = out[pr[0]], b = out[pr[1]];
    if (errors.some(function (e) { return e.field === pr[0] || e.field === pr[1]; })) return;
    if (a && !b) errors.push({ field: pr[1], message: labelOf_(pr[1]) + 'を入力してください。' });
    if (!a && b) errors.push({ field: pr[0], message: labelOf_(pr[0]) + 'を入力してください。' });
  });
  return { errors: errors, out: out };
}
function labelOf_(key) { for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === key) return FIELDS[i].label; return key; }
function normalizeFiles_(files, type, out) {
  var errors = [], ids = {};
  var src = (files && typeof files === 'object' && !Array.isArray(files)) ? files : {};
  var seen = {};
  fileFields_().forEach(function (f) {
    if (!isActive_(f, type, out)) { ids[f.key] = []; return; }
    var arr = src[f.key];
    if (arr === undefined) arr = [];
    if (!Array.isArray(arr) || arr.some(function (x) { return typeof x !== 'string' || !/^[A-Za-z0-9_-]{10,100}$/.test(x); })) {
      errors.push({ field: f.key, message: f.label + 'を確認できませんでした。' }); ids[f.key] = []; return;
    }
    if (arr.length < 1 && f.req) { errors.push({ field: f.key, message: f.label + 'をアップロードしてください。' }); ids[f.key] = []; return; }
    if (arr.length > MAX_FILES_PER_FIELD) { errors.push({ field: f.key, message: f.label + 'は' + MAX_FILES_PER_FIELD + 'ファイルまでです。' }); ids[f.key] = []; return; }
    var okList = [];
    arr.forEach(function (id) {
      if (seen[id]) { errors.push({ field: f.key, message: f.label + 'のファイルが重複しています。' }); return; }
      seen[id] = true; okList.push(id);
    });
    ids[f.key] = okList;
  });
  return { errors: errors, ids: ids };
}
function invalid_(errors) {
  return err_('invalid', '入力内容をご確認ください。', { fields: errors });
}

/* ===== submit ===== */
function actionSubmit_(who, body) {
  if (isClosed_()) return err_('closed', '応募の受付は終了しました。');
  var mode = body.mode;
  if (mode !== 'new' && mode !== 'update') return err_('badRequest', 'リクエストの形式が正しくありません。');
  var v = normalize_(body.data);
  var type = v.out.type || '';
  var f = normalizeFiles_(body.files, type, v.out);
  var errors = v.errors.concat(f.errors);
  if (errors.length) return invalid_(errors);

  /* ファイルの持ち主確認（Drive の get）はロックの外で先にやる */
  var pre = prepareFiles_(who, mode, f.ids);
  if (pre.error) return pre.error;

  var lock = LockService.getScriptLock();
  try { lock.waitLock(45000); } catch (x) { return err_('busy', '混み合っています。しばらくしてからもう一度お試しください。'); }
  var res;
  try {
    res = submitLocked_(who, mode, v.out, f.ids, body, pre);
  } finally {
    lock.releaseLock();
  }
  if (res.ok && res._line) {
    var line = res._line;
    delete res._line;
    sendLine_(who, line.text);
  }
  return res;
}
function isOwnFile_(info, sub, parents) {
  if (!info || info.trashed || info.description !== 'owner:' + sub || ALLOWED_MIME.indexOf(info.mimeType) < 0) return false;
  return (info.parents || []).some(function (p) { return p && parents.indexOf(p) >= 0; });
}
/** ロックの外：応募済みの確認・ファイルの持ち主と置き場所の確認。 */
function prepareFiles_(who, mode, idsByField) {
  var sub = who.sub;
  var existing = prop_('applied:' + sub);
  if (mode === 'new' && existing) return { error: err_('alreadyApplied', 'すでにご応募いただいています。このページを開き直してください。') };
  if (mode === 'update' && !existing) return { error: err_('notApplied', 'ご応募が確認できませんでした。') };
  var tempId = prop_('TEMP_FOLDER_ID');
  var pre = { existing: existing, entryFolderId: '', oldIds: [], infos: {}, preserve: {}, oldInfo: {} };
  if (mode === 'update') {
    var sh = getSheet_();
    var headers = ensureHeaders_(sh);
    var row = findRow_(sh, headers, existing);
    if (!row) return { error: err_('rowNotFound', 'ご応募内容を読み込めませんでした。運営までお問い合わせください。') };
    pre.entryFolderId = prop_('folder:' + existing);
    var old = rowToEntry_(headers, sh.getRange(row, 1, 1, headers.length).getValues()[0]);
    Object.keys(old.files).forEach(function (k) { pre.oldIds = pre.oldIds.concat(old.files[k]); });
  }
  var parents = [tempId];
  if (pre.entryFolderId) parents.push(pre.entryFolderId);
  var fileErrors = [], finalSet = {};
  fileFields_().forEach(function (fld) {
    (idsByField[fld.key] || []).forEach(function (id) {
      finalSet[id] = true;
      var info = null;
      try { info = driveGet_(id); } catch (x) { info = null; }
      if (isOwnFile_(info, sub, parents)) pre.infos[id] = info;
      else if (pre.oldIds.indexOf(id) >= 0) pre.preserve[id] = true; // シートに元からある他人・不明のファイルは触らずそのまま残す
      else fileErrors.push({ field: fld.key, message: fld.label + 'のファイルを確認できませんでした。もう一度アップロードしてください。' });
    });
  });
  if (fileErrors.length) return { error: invalid_(fileErrors) };
  /* 外されるファイル：本人のもので、本人の応募フォルダにあるものだけ動かす */
  pre.oldIds.forEach(function (id) {
    if (finalSet[id] || !pre.entryFolderId) return;
    var info = null;
    try { info = driveGet_(id); } catch (x) { return; }
    if (isOwnFile_(info, sub, [pre.entryFolderId])) pre.oldInfo[id] = info;
  });
  return pre;
}
function issueReceiptNo_() {
  var n = parseInt(prop_('SEQ') || '0', 10) + 1;
  setProp_('SEQ', String(n));
  return 'SS27-' + Utilities.formatDate(new Date(), TZ, 'MMdd-HHmmss') + '-' + (n < 10 ? '0' + n : String(n));
}
function safeFolderName_(receiptNo, shop) {
  return (receiptNo + ' ' + String(shop).replace(/[\r\n\t\/\\]/g, ' ')).slice(0, 120);
}
/** 受付番号の列で最後に埋まっている行の次（運営がその下に書いたメモの行には引きずられない）。 */
function ownedCols_(headers) {
  var cols = [];
  allLabels_().forEach(function (l) {
    var i = headers.indexOf(l);
    if (i >= 0 && TAIL_LABELS.indexOf(l) < 0) cols.push(i);
  });
  return cols;
}
function nextRow_(sh, headers) {
  var col = headers.indexOf(FIXED_LABELS.receiptNo);
  var last = sh.getLastRow(), r = 1;
  if (col >= 0 && last >= 2) {
    var vals = sh.getRange(2, col + 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) !== '') r = i + 2;
  }
  r += 1;
  /* 書く予定の列（フォームの列と固定列）が全部空の最初の行まで下へ進める（運営のメモ行を上書きしない） */
  if (r <= last) {
    var owned = ownedCols_(headers);
    var rows = sh.getRange(r, 1, last - r + 1, headers.length).getValues();
    for (var k = 0; k < rows.length; k++) {
      var used = owned.some(function (c) { return String(rows[k][c] == null ? '' : rows[k][c]) !== ''; });
      if (!used) return r + k;
    }
    return last + 1;
  }
  return r;
}
/** 先頭が = + - @ ' の文字は、先頭に ' を付けて書く（Sheets は ' を表示せず、読むときも返さない）。 */
function sheetText_(v) {
  var s = v == null ? '' : String(v);
  return /^['=+\-@]/.test(s) ? "'" + s : s;
}
/** フォームが持つ列・固定列（cells のキー）だけを書く。連続する列ごとにまとめて書き、運営の列には値も書式も触らない。 */
function writeCells_(sh, row, headers, cells) {
  var cols = [];
  Object.keys(cells).forEach(function (l) {
    var i = headers.indexOf(l);
    if (i >= 0) cols.push({ col: i + 1, val: cells[l] });
  });
  cols.sort(function (a, b) { return a.col - b.col; });
  var written = [], i = 0;
  while (i < cols.length) {
    var j = i;
    while (j + 1 < cols.length && cols[j + 1].col === cols[j].col + 1) j++;
    var rng = sh.getRange(row, cols[i].col, 1, j - i + 1);
    var old = rng.getValues()[0];
    var oldFmt = rng.getNumberFormats()[0];
    for (var k = 0; k <= j - i; k++) written.push({ row: row, col: cols[i].col + k, old: old[k], fmt: oldFmt[k] });
    rng.setNumberFormat('@');
    rng.setValues([cols.slice(i, j + 1).map(function (c) { return sheetText_(c.val); })]);
    i = j + 1;
  }
  return written;
}
function restoreCells_(sh, written) {
  written.slice().reverse().forEach(function (w) {
    try {
      var cell = sh.getRange(w.row, w.col);
      cell.setNumberFormat(w.fmt || 'General'); // 元の書式を戻してから値を戻す
      cell.setValue(typeof w.old === 'string' ? sheetText_(w.old) : w.old); // 文字以外（Date・数値）はそのまま
    } catch (x) { /* できる範囲で戻す */ }
  });
  try { SpreadsheetApp.flush(); } catch (y) { /* 戻せなかったら諦める */ }
}
/** ロックの中：応募済みの確認・番号・移動・書き込み・印だけ。 */
function submitLocked_(who, mode, v, idsByField, body, pre) {
  var sub = who.sub;
  var existing = prop_('applied:' + sub);
  if (mode === 'new' && existing) return err_('alreadyApplied', 'すでにご応募いただいています。このページを開き直してください。');
  if (mode === 'update') {
    if (!existing) return err_('notApplied', 'ご応募が確認できませんでした。');
    if (existing !== pre.existing) return err_('busy', '混み合っています。しばらくしてからもう一度お試しください。');
  }
  var sh = getSheet_();
  var headers = ensureHeaders_(sh);
  var rootId = prop_('ROOT_FOLDER_ID');
  var row = 0, entryFolderId = pre.entryFolderId, receiptNo = existing;
  if (mode === 'update') {
    row = findRow_(sh, headers, existing);
    if (!row) return err_('rowNotFound', 'ご応募内容を読み込めませんでした。運営までお問い合わせください。');
    /* 確認のあとでファイル列が変わっていたら、書く前にやり直させる（画面の送り直しで prepareFiles_ からやり直し） */
    var nowOld = rowToEntry_(headers, sh.getRange(row, 1, 1, headers.length).getValues()[0]);
    var nowIds = [];
    Object.keys(nowOld.files).forEach(function (k) { nowIds = nowIds.concat(nowOld.files[k]); });
    if (nowIds.slice().sort().join(',') !== pre.oldIds.slice().sort().join(',')) return err_('busy', '混み合っています。しばらくしてからもう一度お試しください。');
  } else row = nextRow_(sh, headers);

  /* 動かす直前に、ゴミ箱に入っていないかだけ確かめ直す */
  var fresh = {}, trashedErrors = [];
  fileFields_().forEach(function (fld) {
    (idsByField[fld.key] || []).forEach(function (id) {
      if (pre.preserve[id]) return;
      var info = null;
      try { info = driveGet_(id); } catch (x) { info = null; }
      if (!info || info.trashed) trashedErrors.push({ field: fld.key, message: fld.label + 'のファイルを確認できませんでした。もう一度アップロードしてください。' });
      else fresh[id] = info;
    });
  });
  if (trashedErrors.length) return invalid_(trashedErrors);

  var journal = [], createdFolder = '', written = [];
  try {
    if (mode === 'new') {
      receiptNo = issueReceiptNo_();
      createdFolder = driveCreateFolder_(safeFolderName_(receiptNo, v.shop), rootId).id;
      entryFolderId = createdFolder;
    } else {
      if (!entryFolderId) { createdFolder = driveCreateFolder_(safeFolderName_(receiptNo, v.shop), rootId).id; entryFolderId = createdFolder; }
      driveEnsureRename_(entryFolderId, safeFolderName_(receiptNo, v.shop));
    }
    /* 外されたファイルは消さずに 差し替え前 へ */
    var replacedId = '';
    Object.keys(pre.oldInfo).forEach(function (id) {
      var info = pre.oldInfo[id];
      if (!replacedId) replacedId = driveEnsureFolder_(REPLACED_FOLDER_NAME, entryFolderId).id;
      driveMove_(id, info.parents, replacedId, null);
      journal.push({ id: id, parents: info.parents, name: info.name, to: replacedId });
    });
    /* 残すものと新しいものを、欄ごとの連番の名前で応募フォルダへ */
    var finalFiles = {};
    fileFields_().forEach(function (fld) {
      finalFiles[fld.key] = (idsByField[fld.key] || []).map(function (id, i) {
        if (pre.preserve[id]) return { id: id, name: id };
        var info = fresh[id];
        var nm = fld.label + '_' + (i + 1) + '.' + extOf_(info.name, info.mimeType);
        if (info.parents.indexOf(entryFolderId) < 0 || info.name !== nm) {
          driveMove_(id, info.parents, entryFolderId, nm);
          journal.push({ id: id, parents: info.parents, name: info.name, to: entryFolderId });
        }
        return { id: id, name: nm };
      });
    });

    var cells = cellsFor_(v, idsByField, finalFiles);
    var name = who.name || String(body.displayName || '').slice(0, 100);
    if (mode === 'new') {
      cells[FIXED_LABELS.receiptNo] = receiptNo;
      cells[FIXED_LABELS.createdAt] = nowText_();
      cells[FIXED_LABELS.updatedAt] = '';
      cells[FIXED_LABELS.lineUserId] = sub;
      cells[FIXED_LABELS.lineName] = name;
    } else {
      cells[FIXED_LABELS.updatedAt] = nowText_();
      if (name) cells[FIXED_LABELS.lineName] = name;
    }
    written = writeCells_(sh, row, headers, cells);
    SpreadsheetApp.flush(); // 書き込みのエラーをここで catch に入れる（印を付ける前）
    if (mode === 'new') {
      setProp_('folder:' + receiptNo, entryFolderId);
      setProp_('applied:' + sub, receiptNo);
    }
    var counts = {};
    Object.keys(finalFiles).forEach(function (k) { counts[k] = finalFiles[k].length; });
    return { ok: true, receiptNo: receiptNo, updated: mode === 'update', _line: { text: buildLineText_(v, counts, receiptNo, mode === 'update') } };
  } catch (x) {
    Logger.log('submit failed: ' + (x && x.message));
    restoreCells_(sh, written); // new は書いた行を空に、update は元の値に戻す
    journal.reverse().forEach(function (j) {
      try { driveMove_(j.id, [j.to], j.parents[0], j.name); } catch (y) { /* できる範囲で戻す */ }
    });
    if (createdFolder) { try { driveTrash_(createdFolder); } catch (y) { /* 空のフォルダが残るだけ */ } }
    return err_('saveFailed', '保存に失敗しました。しばらくしてからもう一度お試しください。');
  }
}
function driveEnsureRename_(folderId, name) {
  var cur = driveGet_(folderId);
  if (cur.name !== name) Drive.Files.update({ name: name }, folderId, null, { supportsAllDrives: true });
}

/* ===== 公式LINEの控え ===== */
function lineValue_(f, v, counts) {
  if (f.type === 'file') return counts[f.key] ? counts[f.key] + '件' : '';
  if (f.type === 'consent') return (v[f.key] && v[f.key].length) ? '同意済み' : '';
  if (f.type === 'check') return (v[f.key] || []).join('、');
  return v[f.key] == null ? '' : String(v[f.key]);
}
function buildLineText_(v, counts, receiptNo, isUpdate) {
  var lines = [];
  lines.push(v.shop + ' 様');
  lines.push('');
  lines.push(isUpdate ? 'ご応募内容の変更を受け付けました。' : 'Symphonic Starmine 2027 飲食出店へのご応募を受け付けました。');
  lines.push('■受付番号');
  lines.push(receiptNo);
  ['s1', 's2', 's3', 's4'].forEach(function (sec) {
    var body = [];
    FIELDS.forEach(function (f) {
      if (f.sec !== sec) return;
      var val = lineValue_(f, v, counts);
      if (val === '') return;
      body.push(f.label + '：' + val);
    });
    if (!body.length) return;
    lines.push('');
    lines.push('■' + SECTION_TITLES[sec]);
    body.forEach(function (l) { lines.push(l); });
  });
  lines.push('');
  lines.push(DEADLINE_TEXT + 'の締め切りまで、下記のリンクから内容の確認・変更ができます。');
  var url = prop_('ENTRY_FORM_URL');
  if (url) lines.push(url);
  lines.push('選考結果は' + RESULT_DATE_TEXT + '中に公式LINEでご連絡します。');
  return lines.join('\n');
}
function splitText_(text, limit) {
  var chunks = [], cur = [], curLen = 0;
  var flush = function () { if (cur.length) { chunks.push(cur.join('\n')); cur = []; curLen = 0; } };
  text.split('\n').forEach(function (line) {
    while (line.length > limit) {
      flush();
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    var add = (cur.length ? 1 : 0) + line.length;
    if (curLen + add > limit) flush();
    curLen += (cur.length ? 1 : 0) + line.length;
    cur.push(line);
  });
  flush();
  return chunks;
}
function saveLineResult_(code, text) {
  setProp_('LINE_LAST_RESULT', (nowText_() + ' | ' + code + ' | ' + String(text || '').slice(0, 200)).slice(0, 8000));
}
/** 送れなくても保存は成功のまま。結果は LINE_LAST_RESULT に残す（鍵は入れない）。 */
function sendLine_(who, text) {
  try {
    if (who.test) { saveLineResult_('skipped(test)', ''); return; }
    var token = prop_('LINE_CHANNEL_TOKEN');
    if (!token) { saveLineResult_('no-token', 'LINE_CHANNEL_TOKEN が未設定です'); return; }
    var chunks = splitText_(text, LINE_CHUNK);
    var truncated = chunks.length > LINE_MAX_MESSAGES;
    chunks = chunks.slice(0, LINE_MAX_MESSAGES);
    var res = UrlFetchApp.fetch(PUSH_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: who.sub, messages: chunks.map(function (t) { return { type: 'text', text: t }; }) }),
      muteHttpExceptions: true
    });
    saveLineResult_(res.getResponseCode(), (truncated ? '[5通まで] ' : '') + res.getContentText());
  } catch (x) {
    try { saveLineResult_('error', x && x.message); } catch (y) { /* 何もしない */ }
  }
}
