// node test/run.mjs
// Code.gs を vm で読み込み、Google・LINE の部品をにせ物にして動かす試験。本物には一切つながない。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'gas/Code.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FOLDER = 'application/vnd.google-apps.folder';
const SHEETM = 'application/vnd.google-apps.spreadsheet';

/* ---------- にせ物 ---------- */
function makeEnv(opt = {}) {
  const props = new Map();
  const hooks = { flushCount: 0, flushError: false, onLock: null, locked: false, events: [] };
  const set = (k, v) => props.set(k, v);
  const drive = new Map();
  let nid = 0;
  const newId = () => 'FID' + String(++nid).padStart(12, '0');
  const needShared = (o, where) => { if (!o || o.supportsAllDrives !== true) throw new Error('supportsAllDrives が無い: ' + where); };
  const addFile = (r) => {
    const f = { id: newId(), name: r.name, mimeType: r.mimeType || 'application/octet-stream', parents: [...(r.parents || [])], description: r.description || '', trashed: false, createdTime: new Date().toISOString(), bytes: r.bytes || null };
    drive.set(f.id, f);
    return f;
  };
  const pub = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: [...f.parents], description: f.description, trashed: f.trashed, createdTime: f.createdTime });
  const Drive = {
    Files: {
      create(res, blob, o) {
        needShared(o, 'create');
        return pub(addFile({ ...res, bytes: blob ? blob.bytes : null }));
      },
      get(id, o) {
        needShared(o, 'get');
        hooks.events.push('get');
        const f = drive.get(id);
        if (!f) throw new Error('not found ' + id);
        return pub(f);
      },
      update(res, id, media, o) {
        needShared(o, 'update');
        const f = drive.get(id);
        if (!f) throw new Error('not found ' + id);
        if (res.name !== undefined) f.name = res.name;
        if (res.trashed !== undefined) f.trashed = res.trashed;
        if (o.removeParents) f.parents = f.parents.filter((p) => !o.removeParents.split(',').includes(p));
        if (o.addParents) for (const p of o.addParents.split(',')) if (!f.parents.includes(p)) f.parents.push(p);
        return pub(f);
      },
      list(o) {
        needShared(o, 'list');
        const conds = o.q.split(' and ').map((c) => c.trim());
        const files = [...drive.values()].filter((f) => conds.every((c) => {
          let m;
          if ((m = /^'(.*)' in parents$/.exec(c))) return f.parents.includes(m[1]);
          if (c === 'trashed = false') return !f.trashed;
          if ((m = /^name = '(.*)'$/.exec(c))) return f.name === m[1].replace(/\\'/g, "'");
          if ((m = /^mimeType = '(.*)'$/.exec(c))) return f.mimeType === m[1];
          throw new Error('fake list: 未対応のq ' + c);
        }));
        return { files: files.map(pub) };
      }
    }
  };
  // シート
  const sheets = new Map(); // fileId -> {tabs: Map(name -> tab)}
  const mkTab = (name) => {
    const tab = { name, cells: new Map(), fmt: new Map(), frozen: 0, lastRow: 0, lastCol: 0, formulas: [] };
    const key = (r, c) => r + ',' + c;
    const rangeOf = (r, c, nr = 1, nc = 1) => ({
      getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(tab.cells.has(key(r + i, c + j)) ? tab.cells.get(key(r + i, c + j)) : ''); o.push(row); } return o; },
      getNumberFormats: () => { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(tab.fmt.get(key(r + i, c + j)) || 'General'); o.push(row); } return o; },
      setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) tab.fmt.set(key(r + i, c + j), f); return this; },
      setValue(v) { return this.setValues([[v]]); },
      setValues(vals) {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
          let v = vals[i][j];
          // 本物の挙動：書式が@でも「=」「+」「-」「@」始まりは数式扱い（#NAME? などになる）。先頭が ' なら文字で、' は表示も getValues も返さない
          if (typeof v === 'string') {
            if (v.startsWith("'")) v = v.slice(1);
            else if (/^[=+\-@]/.test(v)) { tab.formulas.push(key(r + i, c + j)); v = '#NAME?'; }
          }
          tab.cells.set(key(r + i, c + j), v);
          tab.lastRow = Math.max(tab.lastRow, r + i); tab.lastCol = Math.max(tab.lastCol, c + j);
        }
        return this;
      },
      setFontWeight() { return this; }
    });
    tab.getRange = rangeOf;
    tab.getLastRow = () => tab.lastRow;
    tab.getLastColumn = () => tab.lastCol;
    tab.setFrozenRows = (n) => { tab.frozen = n; };
    tab.setName = (n) => { tab.name = n; };
    tab.getName = () => tab.name;
    tab.cell = (r, c) => (tab.cells.has(key(r, c)) ? tab.cells.get(key(r, c)) : '');
    return tab;
  };
  const SpreadsheetApp = {
    openById(id) {
      if (!drive.has(id) || drive.get(id).mimeType !== SHEETM) throw new Error('sheet not found');
      if (!sheets.has(id)) sheets.set(id, { tabs: [mkTab('シート1')] });
      const s = sheets.get(id);
      return {
        getSheets: () => s.tabs,
        getSheetByName: (n) => s.tabs.find((t) => t.name === n) || null,
        insertSheet: (n) => { const t = mkTab(n); s.tabs.push(t); return t; }
      };
    },
    flush() { hooks.flushCount++; if (hooks.flushError) throw new Error('flush error'); },
    getUi() { throw new Error('ui なし'); }
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)), deleteProperty: (k) => props.delete(k) }) };
  const LockService = { getScriptLock: () => ({
    waitLock() { if (hooks.locked) throw new Error('lock'); hooks.events.push('lock'); if (hooks.onLock) hooks.onLock(); hooks.locked = true; },
    tryLock() { if (hooks.locked) return false; hooks.locked = true; return true; },
    releaseLock() { hooks.locked = false; hooks.events.push('unlock'); } }) };
  const fetchLog = [];
  const behavior = { verifyOk: (tok) => /^idt:/.test(tok), pushStatus: 200 };
  const UrlFetchApp = {
    fetch(url, o) {
      fetchLog.push({ url, o });
      if (url === 'https://api.line.me/oauth2/v2.1/verify') {
        const ok = behavior.verifyOk(o.payload.id_token) && o.payload.client_id === props.get('LINE_LOGIN_CHANNEL_ID');
        return { getResponseCode: () => (ok ? 200 : 400), getContentText: () => (ok ? JSON.stringify({ sub: o.payload.id_token.slice(4), name: 'LINE名' }) : '{"error":"invalid_request"}') };
      }
      if (url === 'https://api.line.me/v2/bot/message/push') {
        return { getResponseCode: () => behavior.pushStatus, getContentText: () => (behavior.pushStatus === 200 ? '{}' : '{"message":"fail"}') };
      }
      if (url === 'https://api.line.me/v2/bot/info') return { getResponseCode: () => 200, getContentText: () => '{}' };
      throw new Error('想定外の外部接続: ' + url);
    }
  };
  const jst = (d) => new Date(d.getTime() + 9 * 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const Utilities = {
    base64Decode: (s) => [...Buffer.from(s, 'base64')],
    newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
    formatDate(d, tz, fmt) {
      assert.equal(tz, 'Asia/Tokyo');
      const j = jst(d);
      const parts = { yyyy: j.getUTCFullYear(), MM: p2(j.getUTCMonth() + 1), dd: p2(j.getUTCDate()), HH: p2(j.getUTCHours()), mm: p2(j.getUTCMinutes()), ss: p2(j.getUTCSeconds()) };
      return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, (k) => parts[k]);
    }
  };
  const ContentService = { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; }, getContent() { return this.t; } }) };
  const triggers = [];
  const ScriptApp = {
    AuthMode: { FULL: 'FULL' }, requireAllScopes() {},
    getProjectTriggers: () => [...triggers],
    deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); },
    newTrigger: (h) => { const t = { h, getHandlerFunction: () => h }; const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, forSpreadsheet: () => b, onOpen: () => b, create: () => { triggers.push(t); return t; } }; return b; }
  };
  const ctx = vm.createContext({ Drive, SpreadsheetApp, PropertiesService, LockService, UrlFetchApp, Utilities, ContentService, ScriptApp, Logger: { log() {} }, console });
  vm.runInContext(CODE, ctx, { filename: 'Code.gs' });
  set('PARENT_FOLDER_ID', 'PARENTFOLDER0001');
  drive.set('PARENTFOLDER0001', { id: 'PARENTFOLDER0001', name: '11_飲食出店者', mimeType: FOLDER, parents: [], description: '', trashed: false, createdTime: new Date().toISOString() });
  set('LINE_LOGIN_CHANNEL_ID', 'CH1');
  set('LINE_CHANNEL_TOKEN', 'tok-secret-xyz');
  set('ENTRY_FORM_URL', 'https://liff.line.me/TEST-LIFF');
  if (opt.testSecret) set('TEST_SECRET', opt.testSecret);
  ctx.setup();
  const run = (code) => vm.runInContext(code, ctx);
  const env = {
    ctx, props, drive, sheets, hooks, fetchLog, behavior, triggers, run, set,
    sheet: () => sheets.get(props.get('SHEET_ID')).tabs.find((t) => t.name === '応募'),
    call(body) { const o = ctx.doPost({ postData: { contents: JSON.stringify(body) } }); return JSON.parse(o.getContent()); },
    pushes: () => fetchLog.filter((x) => x.url.includes('/push')).map((x) => JSON.parse(x.o.payload)),
    as: (sub) => ({ idToken: 'idt:' + sub }),
    temp: () => props.get('TEMP_FOLDER_ID'),
    upload(sub, field, o = {}) {
      return env.call({ action: 'upload', ...env.as(sub), field, name: o.name || 'a.jpg', mimeType: o.mime || 'image/jpeg', base64: 'b64' in o ? o.b64 : Buffer.from('hello').toString('base64') });
    },
    colOf(label) { const t = env.sheet(); for (let c = 1; c <= t.lastCol; c++) if (t.cell(1, c) === label) return c; return 0; }
  };
  return env;
}

/* ---------- データの型 ---------- */
const CONSENTS = JSON.parse(HTML.match(/<script type="application\/json" id="schema">([\s\S]*?)<\/script>/)[1]).sections[3].items.find((i) => i.key === 'consents').items;
const consentTexts = (car) => CONSENTS.filter((c) => car || c.scope !== 'car').map((c) => c.text);
const base = () => ({
  company: '株式会社テスト', shop: 'テスト食堂', rep: '代表 太郎', contact: '担当 花子', zip: '525-0001', pref: '滋賀県', city: '草津市', addr: '烏丸町1-1 ビル101',
  tel: '077-000-0000', email: 'test@example.com', invoiceTo: '株式会社テスト', invoiceNo: '', dayMobile: '090-0000-0000',
  item1Name: 'からあげ', item1Price: '600円', item2Name: 'ポテト', item2Price: '400円', moreItems: '', staff: '2', cashless: ['PayPay'], cashlessOther: '', history: '', pr: '', inquiry: ''
});
const carData = (o = {}) => ({ ...base(), type: 'キッチンカー', carLen: '5.2', carWid: '1.9', carHei: '2.8', carPlate: '滋賀 800 さ 12-34', genUse: '持ち込む', genKva: '2.8', genFuel: 'ガソリン', genFuelOther: '', carLpg: '使う', carExtra: 'なし', consents: consentTexts(true), ...o });
const tentData = (o = {}) => ({ ...base(), type: 'テント（半張り）', menuProcess: '唐揚げ … 揚げて提供', fire: '使う', tentLpg: '使わない', tentCars: '1台', tentCarKinds: ['トラック'], consents: consentTexts(false), ...o });
async function carFiles(env, sub, n = {}) {
  const f = {};
  for (const [k, c] of Object.entries({ file_car_photo: 1, file_car_layout: 1, file_car_permit: 1, file_menu_photo: 1, file_pl: 1, ...n })) {
    f[k] = [];
    for (let i = 0; i < c; i++) f[k].push(env.upload(sub, k, { name: k + i + '.jpg' }).fileId);
  }
  return f;
}
const tentFiles = (env, sub) => ({ file_tent_photo: [env.upload(sub, 'file_tent_photo').fileId], file_menu_photo: [env.upload(sub, 'file_menu_photo').fileId], file_pl: [env.upload(sub, 'file_pl', { mime: 'application/pdf', name: 'pl.pdf' }).fileId] });
const submit = (env, sub, mode, data, files, extra = {}) => env.call({ action: 'submit', ...env.as(sub), mode, data, files, ...extra });
const NOFILES = { file_car_photo: [], file_car_layout: [], file_car_permit: [], file_tent_photo: [], file_menu_photo: [], file_pl: [] };
const ids = (r) => (r.fields || []).map((x) => x.field);

/* ---------- 試験の並び ---------- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('setup は2回実行しても増えない／フォルダ・シート・見出しができる', () => {
  const env = makeEnv();
  const count = () => [...env.drive.values()].length;
  const n1 = count(), ids1 = ['ROOT_FOLDER_ID', 'TEMP_FOLDER_ID', 'SHEET_ID'].map((k) => env.props.get(k));
  env.ctx.setup();
  assert.equal(count(), n1);
  assert.deepEqual(['ROOT_FOLDER_ID', 'TEMP_FOLDER_ID', 'SHEET_ID'].map((k) => env.props.get(k)), ids1);
  const root = env.drive.get(env.props.get('ROOT_FOLDER_ID'));
  assert.equal(root.name, '飲食出店 応募フォームの回答');
  assert.deepEqual(root.parents, ['PARENTFOLDER0001']);
  assert.equal(env.drive.get(env.temp()).name, '一時保管');
  assert.equal(env.drive.get(env.props.get('SHEET_ID')).name, '飲食出店 応募フォームの回答 シート');
  assert.ok(env.sheet(), 'タブ「応募」');
  assert.equal(env.sheet().cell(1, 1), '会社名（団体名）');
  assert.equal(env.sheet().cell(1, env.sheet().lastCol), 'LINE表示名');
  assert.equal(new Set(Array.from({ length: env.sheet().lastCol }, (_, i) => env.sheet().cell(1, i + 1))).size, env.sheet().lastCol, '見出しに重複なし');
});

test('doGet は「動いています」だけ／壊れた本文は badRequest', () => {
  const env = makeEnv();
  assert.equal(env.ctx.doGet({ parameter: { action: 'status' } }).getContent(), '動いています');
  const o = JSON.parse(env.ctx.doPost({ postData: { contents: 'xxx' } }).getContent());
  assert.equal(o.ok, false); assert.equal(o.error, 'badRequest');
});

test('IDトークンなし／verify失敗で全actionが断られる。本文のuserIdは使われない', () => {
  const env = makeEnv();
  for (const action of ['status', 'upload', 'submit']) {
    for (const extra of [{}, { idToken: 'bad-token' }, { idToken: '' }, { userId: 'Uevil', lineUserId: 'Uevil' }, { idToken: 'bad', userId: 'Uevil' }]) {
      const r = env.call({ action, field: 'file_pl', name: 'a.jpg', mimeType: 'image/jpeg', base64: 'aGk=', mode: 'new', data: carData(), files: NOFILES, ...extra });
      assert.equal(r.ok, false, action + JSON.stringify(extra));
      assert.equal(r.error, 'unauthorized');
    }
  }
  assert.equal(env.sheet().lastRow, 1, 'シートに何も書かれない');
  assert.equal([...env.props.keys()].filter((k) => k.startsWith('applied:')).length, 0);
  // チャネルIDが未設定なら有効なトークンでも通さない
  env.props.delete('LINE_LOGIN_CHANNEL_ID');
  assert.equal(env.call({ action: 'status', ...env.as('Uabc') }).error, 'unauthorized');
});

test('有効なトークンのときだけ sub が本人。本文のuserId・lineUserIdは無視される', () => {
  const env = makeEnv();
  const files = {};
  const sub = 'Uabc';
  Object.assign(files, tentFiles(env, sub));
  const r = submit(env, sub, 'new', { ...tentData(), lineUserId: 'Uevil' }, { ...NOFILES, ...files }, { userId: 'Uevil', lineUserId: 'Uevil', testUserId: 'TEST_x' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(env.props.has('applied:Uabc'));
  assert.ok(![...env.props.keys()].some((k) => k.includes('Uevil')));
  assert.equal(env.sheet().cell(2, env.colOf('LINEユーザーID')), 'Uabc');
  assert.equal(env.pushes()[0].to, 'Uabc');
});

test('TEST_SECRET が空なら testUserId は使えない／入っていても条件を満たさなければ使えない', () => {
  const env = makeEnv();
  for (const b of [{ testUserId: 'TEST_1' }, { testSecret: '', testUserId: 'TEST_1' }, { testSecret: 'x', testUserId: 'TEST_1' }, { testSecret: undefined, testUserId: 'TEST_1' }]) {
    assert.equal(env.call({ action: 'status', ...b }).error, 'unauthorized');
  }
  const e2 = makeEnv({ testSecret: 'sekret' });
  assert.equal(e2.call({ action: 'status', testSecret: 'wrong', testUserId: 'TEST_1' }).error, 'unauthorized');
  assert.equal(e2.call({ action: 'status', testSecret: 'sekret', testUserId: 'Ureal' }).error, 'unauthorized');
  assert.equal(e2.call({ action: 'status', testUserId: 'TEST_1' }).error, 'unauthorized');
  assert.equal(e2.call({ action: 'status', testSecret: 'sekret', testUserId: 'TEST_1' }).ok, true);
  // 抜け道で応募してもLINEには送らない
  const files = tentFiles({ ...e2, as: () => ({ testSecret: 'sekret', testUserId: 'TEST_1' }), upload: (s, f, o = {}) => e2.call({ action: 'upload', testSecret: 'sekret', testUserId: 'TEST_1', field: f, name: 'a.jpg', mimeType: o.mime || 'image/jpeg', base64: 'aGVsbG8=' }) }, 'TEST_1');
  const r = e2.call({ action: 'submit', testSecret: 'sekret', testUserId: 'TEST_1', mode: 'new', data: tentData(), files: { ...NOFILES, ...files } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(e2.pushes().length, 0);
  assert.match(e2.props.get('LINE_LAST_RESULT'), /skipped\(test\)/);
});

test('new → 2回目のnewは alreadyApplied／updateで受付番号が変わらない・運営の列が残る', () => {
  const env = makeEnv();
  const sub = 'Uone';
  const t = env.sheet();
  const r1 = submit(env, sub, 'new', tentData(), { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.match(r1.receiptNo, /^SS27-\d{4}-\d{6}-\d{2,3}$/);
  assert.equal(r1.updated, false);
  // 運営が列を足して値を書く
  const col = t.lastCol + 1; t.cells.set('1,' + col, '選考結果'); t.cells.set('2,' + col, '採用'); t.lastCol = col;
  const r2 = submit(env, sub, 'new', tentData(), { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(r2.error, 'alreadyApplied');
  assert.equal(t.lastRow, 2);
  const files = { ...NOFILES, ...tentFiles(env, sub) };
  const r3 = submit(env, sub, 'update', tentData({ shop: '改名食堂', staff: '3' }), files);
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(r3.receiptNo, r1.receiptNo);
  assert.equal(r3.updated, true);
  assert.equal(t.lastRow, 2, '行は増えない');
  assert.equal(t.cell(2, env.colOf('店舗名（屋号）')), '改名食堂');
  assert.equal(t.cell(2, env.colOf('受付番号')), r1.receiptNo);
  assert.equal(t.cell(2, col), '採用', '運営の列は残る');
  assert.equal(t.cell(1, col), '選考結果');
  assert.notEqual(t.cell(2, env.colOf('最終変更日時')), '');
  assert.equal(t.cell(2, env.colOf('受付日時')) !== '', true);
  // 応募フォルダ名の追従
  const folder = env.drive.get(env.props.get('folder:' + r1.receiptNo));
  assert.equal(folder.name, r1.receiptNo + ' 改名食堂');
  // status は応募内容を戻せる形で返す
  const st = env.call({ action: 'status', ...env.as(sub) });
  assert.equal(st.applied, true); assert.equal(st.canEdit, true); assert.equal(st.closed, false);
  assert.equal(st.deadlineText, '2027年2月21日（日）23:59'); assert.equal(st.resultDateText, '2027年2月26日（金）');
  assert.equal(st.entry.receiptNo, r1.receiptNo);
  assert.equal(st.entry.data.shop, '改名食堂'); assert.equal(st.entry.data.type, 'テント（半張り）');
  assert.deepEqual(st.entry.data.tentCarKinds, ['トラック']);
  assert.equal(st.entry.data.consents.length, 7);
  assert.equal(st.entry.files.file_pl.length, 1); assert.match(st.entry.files.file_pl[0].name, /^PL保険証の写し_1\.pdf$/);
  // 更新できる前提：未応募のupdateは断る
  assert.equal(submit(env, 'Unobody', 'update', tentData(), { ...NOFILES, ...tentFiles(env, 'Unobody') }).error, 'notApplied');
});

test('ファイルは応募フォルダへ移り「<欄名>_<n>.<拡張子>」になる／外したファイルは 差し替え前 へ（消さない）', () => {
  const env = makeEnv();
  const sub = 'Ufile';
  const f1 = { ...NOFILES, file_tent_photo: [env.upload(sub, 'file_tent_photo', { name: 'x.png', mime: 'image/png' }).fileId, env.upload(sub, 'file_tent_photo', { name: 'y.JPG' }).fileId], file_menu_photo: [env.upload(sub, 'file_menu_photo').fileId], file_pl: [env.upload(sub, 'file_pl', { mime: 'application/pdf', name: 'p.pdf' }).fileId] };
  const r = submit(env, sub, 'new', tentData(), f1);
  assert.equal(r.ok, true, JSON.stringify(r));
  const folderId = env.props.get('folder:' + r.receiptNo);
  assert.equal(env.drive.get(folderId).name, r.receiptNo + ' テスト食堂');
  assert.deepEqual(env.drive.get(folderId).parents, [env.props.get('ROOT_FOLDER_ID')]);
  const f = env.drive.get(f1.file_tent_photo[0]);
  assert.equal(f.name, 'ブースの写真・イメージ_1.png'); assert.deepEqual(f.parents, [folderId]);
  assert.equal(env.drive.get(f1.file_tent_photo[1]).name, 'ブースの写真・イメージ_2.jpg');
  assert.equal(f.description, 'owner:' + sub);
  const cell = env.sheet().cell(2, env.colOf('ブースの写真・イメージ'));
  assert.equal(cell.split('\n').length, 2); assert.ok(cell.includes('/d/' + f1.file_tent_photo[0] + '/view'));
  assert.equal(env.sheet().cell(2, env.colOf('キッチンカーの写真')), '');
  // 更新で1枚外し、新しい1枚を足す
  const added = env.upload(sub, 'file_tent_photo', { name: 'new.webp', mime: 'image/webp' }).fileId;
  const f2 = { ...f1, file_tent_photo: [f1.file_tent_photo[1], added] };
  const r2 = submit(env, sub, 'update', tentData(), f2);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const removed = env.drive.get(f1.file_tent_photo[0]);
  assert.equal(removed.trashed, false, '消さない');
  const repl = [...env.drive.values()].find((x) => x.name === '差し替え前' && x.parents.includes(folderId));
  assert.ok(repl, '差し替え前フォルダ'); assert.deepEqual(removed.parents, [repl.id]);
  assert.equal(env.drive.get(f1.file_tent_photo[1]).name, 'ブースの写真・イメージ_1.jpg');
  assert.equal(env.drive.get(added).name, 'ブースの写真・イメージ_2.webp');
  // 差し替え前にあるファイルはもう使えない
  const r3 = submit(env, sub, 'update', tentData(), { ...f2, file_tent_photo: [f1.file_tent_photo[0]] });
  assert.equal(r3.error, 'invalid');
  // 出店形態を変えると、隠れた側のファイルは入れられず、もう片方のファイルは差し替え前へ
  const car = carData();
  const cf = {}; for (const [k, c] of Object.entries({ file_car_photo: 1, file_car_layout: 1, file_car_permit: 1 })) cf[k] = [env.upload(sub, k).fileId];
  const r4 = submit(env, sub, 'update', car, { ...NOFILES, ...cf, file_menu_photo: f1.file_menu_photo, file_pl: f1.file_pl, file_tent_photo: f2.file_tent_photo });
  assert.equal(r4.ok, true, JSON.stringify(r4));
  assert.equal(env.sheet().cell(2, env.colOf('ブースの写真・イメージ')), '', 'テントのファイル列は空');
  assert.equal(env.drive.get(added).parents[0], repl.id, 'テントの写真は差し替え前へ');
});

test('他人のownerのファイルID・親が違うファイル・ゴミ箱のファイルは submit で断られる', () => {
  const env = makeEnv();
  const a = 'Ua', b = 'Ub';
  const fa = tentFiles(env, a);
  const fb = tentFiles(env, b);
  const r = submit(env, b, 'new', tentData(), { ...NOFILES, ...fb, file_pl: fa.file_pl });
  assert.equal(r.ok, false); assert.equal(r.error, 'invalid'); assert.deepEqual(ids(r), ['file_pl']);
  assert.equal(env.sheet().lastRow, 1); assert.ok(!env.props.has('applied:' + b));
  // 一時保管の外のファイル
  const stray = [...env.drive.values()].find((x) => x.id === fb.file_pl[0]);
  const other = env.ctx.Drive.Files.create({ name: 'q.pdf', mimeType: 'application/pdf', parents: ['PARENTFOLDER0001'], description: 'owner:' + b }, null, { supportsAllDrives: true });
  assert.equal(submit(env, b, 'new', tentData(), { ...NOFILES, ...fb, file_pl: [other.id] }).error, 'invalid');
  // ownerなし
  const noOwner = env.ctx.Drive.Files.create({ name: 'q.pdf', mimeType: 'application/pdf', parents: [env.temp()], description: '' }, null, { supportsAllDrives: true });
  assert.equal(submit(env, b, 'new', tentData(), { ...NOFILES, ...fb, file_pl: [noOwner.id] }).error, 'invalid');
  // 存在しないID
  assert.equal(submit(env, b, 'new', tentData(), { ...NOFILES, ...fb, file_pl: ['ZZZZZZZZZZZZZZZZZZ'] }).error, 'invalid');
  // 他人が応募済みのフォルダのファイルも使えない（Aが応募→BがAの確定済みIDを使う）
  assert.equal(submit(env, a, 'new', tentData(), { ...NOFILES, ...fa }).ok, true);
  const rr = submit(env, b, 'new', tentData(), { ...NOFILES, ...fb, file_pl: fa.file_pl });
  assert.equal(rr.error, 'invalid');
  assert.ok(stray);
});

test('締切後は upload・submit を断る／status は closed=true で応募済みなら entry を返す', () => {
  const env = makeEnv();
  const sub = 'Uclosed';
  const files = { ...NOFILES, ...tentFiles(env, sub) };
  assert.equal(submit(env, sub, 'new', tentData(), files).ok, true);
  const pending = env.upload(sub, 'file_pl').fileId;
  env.run("DEADLINE = '2020-01-01T00:00:00+09:00'");
  assert.equal(env.upload(sub, 'file_pl').error, 'closed');
  assert.equal(submit(env, sub, 'update', tentData(), files).error, 'closed');
  assert.equal(submit(env, 'Unew', 'new', tentData(), files).error, 'closed');
  const st = env.call({ action: 'status', ...env.as(sub) });
  assert.equal(st.closed, true); assert.equal(st.canEdit, false); assert.equal(st.applied, true); assert.ok(st.entry && st.entry.receiptNo);
  const st2 = env.call({ action: 'status', ...env.as('Unone') });
  assert.equal(st2.closed, true); assert.equal(st2.applied, false); assert.equal(st2.entry, undefined);
  assert.ok(pending);
  // 締切ちょうど（DEADLINE と同時刻）は受付しない
  env.run('DEADLINE = new Date(Date.now() + 1000 * 60).toISOString()');
  assert.equal(env.call({ action: 'status', ...env.as('Unone') }).closed, false);
});

test('出店商品②は任意。ただし商品名と価格の片方だけは不可（画面と保存側）', () => {
  const env = makeEnv();
  const sub = 'Upair';
  let r = submit(env, sub, 'new', tentData({ item2Name: '', item2Price: '400円' }), { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(r.error, 'invalid'); assert.deepEqual(ids(r), ['item2Name']);
  r = submit(env, sub, 'new', tentData({ item2Name: 'ポテト', item2Price: '' }), { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(r.error, 'invalid'); assert.deepEqual(ids(r), ['item2Price']);
  r = submit(env, sub, 'new', tentData({ item2Name: '', item2Price: '' }), { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(HTML, /\[\['item2Name', 'item2Price'\]\]/);
  assert.match(HTML, /"key":"item2Name"[^}]*"req":false/); assert.match(HTML, /"key":"item2Price"[^}]*"req":false/);
});

test('出店形態ごとの必須・選択肢・形式の検証', () => {
  const env = makeEnv();
  const sub = 'Uval';
  const f = { ...NOFILES, ...tentFiles(env, sub) };
  const check = (data, files, expected) => {
    const r = submit(env, sub, 'new', data, files);
    assert.equal(r.ok, false, JSON.stringify(data).slice(0, 80));
    assert.equal(r.error, 'invalid');
    for (const e of expected) assert.ok(ids(r).includes(e), e + ' が指摘されるはず: ' + ids(r));
    assert.equal(env.sheet().lastRow, 1);
    return r;
  };
  check({}, f, ['company', 'shop', 'type', 'zip', 'email']);
  check(tentData({ type: '' }), f, ['type']);
  check(tentData({ type: 'ワゴン' }), f, ['type']);
  // テントの必須
  const noTent = tentData(); delete noTent.menuProcess; delete noTent.fire; noTent.tentCarKinds = [];
  check(noTent, f, ['menuProcess', 'fire', 'tentCarKinds']);
  check(tentData({ fire: '多分使う' }), f, ['fire']);
  check(tentData({ tentCars: '3台' }), f, ['tentCars']);
  check(tentData({ tentCarKinds: ['バス'] }), f, ['tentCarKinds']);
  check(tentData({ email: 'not-mail' }), f, ['email']);
  check(tentData({ zip: '５２５－０００１' }), f, ['zip']);
  check(tentData({ tel: 'abc' }), f, ['tel']);
  check(tentData({ staff: '0' }), f, ['staff']);
  check(tentData({ staff: '1.5' }), f, ['staff']);
  check(tentData({ pref: '日本国' }), f, ['pref']);
  check(tentData({ shop: 'あ'.repeat(2001) }), f, ['shop']);
  check(tentData({ pr: 'あ'.repeat(2001) }), f, ['pr']);
  check(tentData({ company: 123 }), f, ['company']);
  check(tentData({ cashless: [] }), f, ['cashless']);
  check(tentData({ cashless: ['PayPay', 'その他'], cashlessOther: '' }), f, ['cashlessOther']);
  check(tentData({ consents: consentTexts(false).slice(1) }), f, ['consents']);
  check(tentData({ consents: [] }), f, ['consents']);
  // テントなのにファイルが無い／多すぎる
  check(tentData(), { ...f, file_tent_photo: [] }, ['file_tent_photo']);
  check(tentData(), { ...f, file_pl: [] }, ['file_pl']);
  check(tentData(), { ...f, file_pl: [f.file_pl[0], f.file_menu_photo[0], f.file_tent_photo[0], 'AAAAAAAAAAAAAAAA'] }, ['file_pl']);
  check(tentData(), { ...f, file_pl: ['../etc/passwd'] }, ['file_pl']);
  // キッチンカーの必須と条件欄
  const cf = { ...NOFILES, file_menu_photo: f.file_menu_photo, file_pl: f.file_pl };
  check(carData(), cf, ['file_car_photo', 'file_car_layout', 'file_car_permit']);
  const carFull = { ...cf, ...Object.fromEntries(['file_car_photo', 'file_car_layout', 'file_car_permit'].map((k) => [k, [env.upload(sub, k).fileId]])) };
  const noCar = carData(); for (const k of ['carLen', 'carWid', 'carHei', 'carPlate', 'genUse', 'carLpg', 'carExtra']) delete noCar[k];
  check(noCar, carFull, ['carLen', 'carWid', 'carHei', 'carPlate', 'genUse', 'carLpg', 'carExtra']);
  check(carData({ carLen: '-1' }), carFull, ['carLen']);
  check(carData({ carWid: 'abc' }), carFull, ['carWid']);
  check(carData({ genKva: '', genFuel: '' }), carFull, ['genKva', 'genFuel']);
  check(carData({ genFuel: 'その他', genFuelOther: '' }), carFull, ['genFuelOther']);
  check(carData({ genFuel: '水素' }), carFull, ['genFuel']);
  check(carData({ carExtra: 'あり（3台目）' }), carFull, ['carExtra']);
  check(carData({ consents: consentTexts(false) }), carFull, ['consents']); // 食品営業許可証の同意が無い
  // 規定サイズ超えは止めない（注意は画面側だけ）
  const over = submit(env, sub, 'new', carData({ carLen: '7.5', carWid: '3', carHei: '4' }), carFull);
  assert.equal(over.ok, true, JSON.stringify(over));
});

test('隠れた欄は空で保存される（形態違い・発電機なし・燃料その他でない）', () => {
  const env = makeEnv();
  const sub = 'Uhid';
  const tf = tentFiles(env, sub);
  // テントの人がキッチンカー欄を送ってきても保存しない
  const dirty = tentData({ carLen: '5', carPlate: 'x', genUse: '持ち込む', genKva: '3', genFuel: 'その他', genFuelOther: 'z', carLpg: '使う', carExtra: 'なし', file_car_photo: 'x' });
  const dirtyFiles = { ...NOFILES, ...tf, file_car_photo: [env.upload(sub, 'file_car_photo').fileId] };
  const r = submit(env, sub, 'new', dirty, dirtyFiles);
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const l of ['車両の全長（m）', '車両ナンバー', '発電機', '発電機の出力（kVA）', '発電機の燃料', '発電機の燃料（その他）', 'LPガスの使用（キッチンカー）', '追加車両', 'キッチンカーの写真']) assert.equal(env.sheet().cell(2, env.colOf(l)), '', l);
  assert.equal(env.sheet().cell(2, env.colOf('LPガスの使用（テント）')), '使わない');
  // 発電機を持ち込まない／燃料がその他でない → 出力・燃料欄は空
  const sub2 = 'Uhid2';
  const cf = { ...(env.upload(sub2, 'file_car_photo') && {}) };
  const files = {}; for (const k of ['file_car_photo', 'file_car_layout', 'file_car_permit', 'file_menu_photo', 'file_pl']) files[k] = [env.upload(sub2, k).fileId];
  const r2 = submit(env, sub2, 'new', carData({ genUse: '持ち込まない', genKva: '9', genFuel: 'ガソリン', genFuelOther: 'zz', cashless: ['PayPay'], cashlessOther: 'q' }), { ...NOFILES, ...files });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const row = env.sheet().lastRow;
  for (const l of ['発電機の出力（kVA）', '発電機の燃料', '発電機の燃料（その他）', '使用できるキャッシュレス決済（その他）']) assert.equal(env.sheet().cell(row, env.colOf(l)), '', l);
  assert.ok(cf);
});

test('「=」「+」「-」「@」で始まる値は文字のまま・0始まりが消えない・書式は@', () => {
  const env = makeEnv();
  const sub = 'Uform';
  const f = { ...NOFILES, ...tentFiles(env, sub) };
  const r = submit(env, sub, 'new', tentData({ shop: '=SUM(1,2)', company: '+81 shop', rep: '-1', contact: '@cmd', item1Name: '=HYPERLINK("http://x")', zip: '0010001', tel: '0120-000-000', dayMobile: '090-0000-0000', pr: '=1+1\n改行あり' }), f);
  assert.equal(r.ok, true, JSON.stringify(r));
  const t = env.sheet();
  const get = (l) => t.cell(2, env.colOf(l));
  assert.equal(get('店舗名（屋号）'), '=SUM(1,2)'); assert.equal(get('会社名（団体名）'), '+81 shop'); assert.equal(get('代表者名'), '-1'); assert.equal(get('当日担当者'), '@cmd');
  assert.equal(get('郵便番号'), '0010001'); assert.equal(get('電話番号'), '0120-000-000');
  assert.equal(typeof get('郵便番号'), 'string');
  assert.deepEqual(t.formulas, [], '数式として入ったセルは無い');
  // update でも同じ
  const f2 = { ...NOFILES, ...tentFiles(env, sub) };
  assert.equal(submit(env, sub, 'update', tentData({ shop: '=1+1', zip: '0020002' }), f2).ok, true);
  assert.equal(get('店舗名（屋号）'), '=1+1'); assert.equal(get('郵便番号'), '0020002');
  assert.deepEqual(t.formulas, []);
});

test('受付番号：形式・かぶらない・100を超えたら3桁', () => {
  const env = makeEnv();
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const sub = 'Useq' + i;
    const r = submit(env, sub, 'new', tentData(), { ...NOFILES, ...tentFiles(env, sub) });
    assert.equal(r.ok, true);
    assert.match(r.receiptNo, /^SS27-\d{4}-\d{6}-\d{2}$/);
    assert.ok(!seen.has(r.receiptNo)); seen.add(r.receiptNo);
  }
  assert.ok([...seen][0].endsWith('-01') && [...seen][5].endsWith('-06'));
  env.props.set('SEQ', '98');
  const a = submit(env, 'Useq98', 'new', tentData(), { ...NOFILES, ...tentFiles(env, 'Useq98') });
  const b = submit(env, 'Useq99', 'new', tentData(), { ...NOFILES, ...tentFiles(env, 'Useq99') });
  assert.ok(a.receiptNo.endsWith('-99')); assert.ok(b.receiptNo.endsWith('-100'));
});

test('upload：種類・大きさ・欄名の検証／一時保管に owner 付きで入る', () => {
  const env = makeEnv();
  const ok = env.upload('Uup', 'file_pl', { name: '../../x/保険証.pdf', mime: 'application/pdf' });
  assert.equal(ok.ok, true); assert.equal(ok.name, '保険証.pdf');
  const f = env.drive.get(ok.fileId);
  assert.deepEqual(f.parents, [env.temp()]); assert.equal(f.description, 'owner:Uup'); assert.equal(f.mimeType, 'application/pdf');
  assert.equal(env.upload('Uup', 'file_pl', { mime: 'text/html' }).error, 'badType');
  assert.equal(env.upload('Uup', 'file_pl', { mime: 'image/svg+xml' }).error, 'badType');
  assert.equal(env.upload('Uup', 'shop').error, 'badRequest');
  assert.equal(env.upload('Uup', 'nope').error, 'badRequest');
  assert.equal(env.upload('Uup', 'file_pl', { b64: '' }).error, 'badRequest');
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString('base64');
  assert.equal(env.upload('Uup', 'file_pl', { b64: big }).error, 'tooLarge');
  const just = Buffer.alloc(10 * 1024 * 1024, 1).toString('base64');
  assert.equal(env.upload('Uup', 'file_pl', { b64: just }).ok, true);
  for (const m of ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf']) assert.equal(env.upload('Uup', 'file_pl', { mime: m }).ok, true, m);
});

test('cleanupTemp は一時保管の直下の24時間以上たったファイルだけをゴミ箱へ。ほかには触らない', () => {
  const env = makeEnv();
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const recent = new Date(Date.now() - 3600 * 1000).toISOString();
  const mk = (name, parent, created, mime = 'image/jpeg') => { const f = env.ctx.Drive.Files.create({ name, mimeType: mime, parents: [parent], description: 'owner:U' }, null, { supportsAllDrives: true }); env.drive.get(f.id).createdTime = created; return f.id; };
  const root = env.props.get('ROOT_FOLDER_ID');
  const sub = 'Uclean';
  const submitted = submit(env, sub, 'new', tentData(), { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(submitted.ok, true);
  const entry = env.props.get('folder:' + submitted.receiptNo);
  const entryFileIds = [...env.drive.values()].filter((f) => f.parents.includes(entry)).map((f) => f.id);
  for (const id of entryFileIds) env.drive.get(id).createdTime = old;
  const targets = { oldTemp: mk('o1', env.temp(), old), oldTemp2: mk('o2', env.temp(), old, 'application/pdf'), recentTemp: mk('r', env.temp(), recent), oldInRoot: mk('root', root, old), oldInParent: mk('par', 'PARENTFOLDER0001', old), oldEntry: entryFileIds[0] };
  const sheetId = env.props.get('SHEET_ID'); env.drive.get(sheetId).createdTime = old;
  const subfolder = env.ctx.Drive.Files.create({ name: 'sub', mimeType: FOLDER, parents: [env.temp()] }, null, { supportsAllDrives: true }).id;
  env.drive.get(subfolder).createdTime = old;
  const inSub = mk('insub', subfolder, old);
  const n = env.ctx.cleanupTemp();
  assert.equal(n, 2);
  assert.equal(env.drive.get(targets.oldTemp).trashed, true); assert.equal(env.drive.get(targets.oldTemp2).trashed, true);
  for (const k of ['recentTemp', 'oldInRoot', 'oldInParent', 'oldEntry']) assert.equal(env.drive.get(targets[k]).trashed, false, k);
  assert.equal(env.drive.get(subfolder).trashed, false); assert.equal(env.drive.get(inSub).trashed, false);
  assert.equal(env.drive.get(sheetId).trashed, false);
  for (const f of env.drive.values()) if (f.parents.includes(entry)) assert.equal(f.trashed, false);
  assert.equal(env.drive.get(entry).trashed, false);
});

test('LINEの控え：本文の形・空の項目が出ない・ファイルは件数・宛先は本人・送れなくても保存は成功', () => {
  const env = makeEnv();
  const sub = 'Uline';
  const files = {}; for (const [k, n] of Object.entries({ file_car_photo: 2, file_car_layout: 1, file_car_permit: 1, file_menu_photo: 1, file_pl: 1 })) { files[k] = []; for (let i = 0; i < n; i++) files[k].push(env.upload(sub, k).fileId); }
  const r = submit(env, sub, 'new', carData({ invoiceNo: '', pr: '', moreItems: '' }), { ...NOFILES, ...files });
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = env.pushes();
  assert.equal(p.length, 1); assert.equal(p[0].to, sub); assert.equal(p[0].messages.length, 1);
  const text = p[0].messages[0].text;
  assert.ok(text.startsWith('テスト食堂 様\n\nSymphonic Starmine 2027 飲食出店へのご応募を受け付けました。\n■受付番号\n' + r.receiptNo + '\n'));
  assert.ok(text.includes('■出店者情報\n会社名（団体名）：株式会社テスト'));
  assert.ok(text.includes('■キッチンカーの情報')); assert.ok(!text.includes('■テント（半張り）の情報'));
  assert.ok(text.includes('■出店内容'));
  assert.ok(text.includes('キッチンカーの写真：2件')); assert.ok(text.includes('車内の配置図：1件'));
  assert.ok(text.includes('使用できるキャッシュレス決済：PayPay'));
  for (const empty of ['インボイス登録番号', '店舗のPR文', '3品目以降', '主な出店実績', 'ご質問等', '発電機の燃料（その他）', 'ブースの写真', 'メニューごとのメニュー名']) assert.ok(!text.includes(empty), empty + ' は出ないはず');
  assert.ok(!/：\s*\n/.test(text) && !/：$/m.test(text), '値の空な行が無い');
  assert.ok(text.endsWith('2027年2月21日（日）23:59の締め切りまで、下記のリンクから内容の確認・変更ができます。\nhttps://liff.line.me/TEST-LIFF\n選考結果は2027年2月26日（金）中に公式LINEでご連絡します。'));
  assert.equal(JSON.stringify(env.fetchLog.filter((x) => x.url.includes('/push')).map((x) => x.o.headers.Authorization)), '["Bearer tok-secret-xyz"]');
  assert.match(env.props.get('LINE_LAST_RESULT'), / \| 200 \| /);
  assert.ok(!env.props.get('LINE_LAST_RESULT').includes('tok-secret-xyz'), '鍵は残さない');
  // 変更のときの文
  const f2 = { ...NOFILES, ...files };
  assert.equal(submit(env, sub, 'update', carData({ invoiceNo: 'T1234567890123' }), f2).ok, true);
  const t2 = env.pushes()[1].messages[0].text;
  assert.ok(t2.includes('ご応募内容の変更を受け付けました。') && !t2.includes('へのご応募を受け付けました。'));
  assert.ok(t2.includes('インボイス登録番号：T1234567890123'));
  // 送れない（鍵なし／LINE側エラー）でも保存は成功
  const s3 = 'Uline3';
  env.behavior.pushStatus = 500;
  const r3 = submit(env, s3, 'new', tentData(), { ...NOFILES, ...tentFiles(env, s3) });
  assert.equal(r3.ok, true); assert.ok(env.props.has('applied:' + s3));
  assert.match(env.props.get('LINE_LAST_RESULT'), / \| 500 \| /);
  env.props.delete('LINE_CHANNEL_TOKEN');
  const s4 = 'Uline4';
  const r4 = submit(env, s4, 'new', tentData(), { ...NOFILES, ...tentFiles(env, s4) });
  assert.equal(r4.ok, true); assert.match(env.props.get('LINE_LAST_RESULT'), /no-token/);
});

test('LINEの本文は4,800字で分かれ、1回5通まで', () => {
  const env = makeEnv();
  const sub = 'Ulong';
  const long = 'ぬ'.repeat(2000);
  const d = tentData({ menuProcess: long, moreItems: long, history: long, pr: long, inquiry: long });
  const r = submit(env, sub, 'new', d, { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = env.pushes();
  assert.equal(p.length, 1);
  const m = p[0].messages;
  assert.ok(m.length >= 2 && m.length <= 5, 'messages=' + m.length);
  for (const x of m) assert.ok(x.text.length <= 4800, 'len=' + x.text.length);
  assert.equal(m.map((x) => x.text).join('\n').split('ぬ').length - 1, 10000, '内容が欠けない');
  // splitText_ の単体
  assert.deepEqual([...env.ctx.splitText_('a\nb\nc', 3)], ['a\nb', 'c']);
  assert.equal(env.ctx.splitText_('x'.repeat(9700), 4800).length, 3);
  assert.equal(env.ctx.splitText_('短い', 4800).length, 1);
  // 5通を超える分は送らない
  const big = Array.from({ length: 8 }, () => 'z'.repeat(4000)).join('\n');
  env.ctx.sendLine_({ sub: 'Ucap', test: false }, big);
  const last = env.pushes().pop();
  assert.equal(last.messages.length, 5);
  assert.match(env.props.get('LINE_LAST_RESULT'), /5通まで/);
});

test('保存に失敗したら応募済みの印を付けず、ファイルを一時保管へ戻す', () => {
  const env = makeEnv();
  const sub = 'Ufail';
  const f = { ...NOFILES, ...tentFiles(env, sub) };
  const sh = env.sheet();
  const orig = sh.getRange;
  sh.getRange = (r, c, nr, nc) => { const g = orig(r, c, nr, nc); if (r > 1) g.setValues = () => { throw new Error('boom'); }; return g; };
  const r = submit(env, sub, 'new', tentData(), f);
  sh.getRange = orig;
  assert.equal(r.ok, false); assert.equal(r.error, 'saveFailed');
  assert.ok(!env.props.has('applied:' + sub));
  for (const id of Object.values(f).flat()) assert.deepEqual(env.drive.get(id).parents, [env.temp()], 'ファイルは一時保管に戻る');
  const again = submit(env, sub, 'new', tentData(), f);
  assert.equal(again.ok, true, JSON.stringify(again));
});

test('resetApplied で印が消えて、もう一度 new できる', () => {
  const env = makeEnv();
  const sub = 'Ureset';
  assert.equal(submit(env, sub, 'new', tentData(), { ...NOFILES, ...tentFiles(env, sub) }).ok, true);
  env.ctx.resetApplied(sub);
  assert.ok(!env.props.has('applied:' + sub));
  assert.equal(submit(env, sub, 'new', tentData(), { ...NOFILES, ...tentFiles(env, sub) }).ok, true);
  assert.throws(() => env.ctx.resetApplied(''));
});

test('見出しは名前で探す：運営が列の途中に足しても、後から足した項目は右端に足される', () => {
  const env = makeEnv();
  const t = env.sheet();
  // 運営が先頭に列を足す（既存列の位置がずれる）
  for (let r = t.lastRow; r >= 1; r--) for (let c = t.lastCol; c >= 1; c--) t.cells.set(r + ',' + (c + 1), t.cell(r, c));
  t.cells.set('1,1', '運営メモ'); t.cells.set('2,1', 'メモ'); t.lastCol += 1;
  const sub = 'Ucols';
  const r = submit(env, sub, 'new', tentData(), { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(t.cell(2, env.colOf('店舗名（屋号）')), 'テスト食堂');
  assert.equal(t.cell(2, 1), 'メモ', '運営の列のセルは上書きしない');
  // TAIL_LABELS に項目を足すと右端に足される
  env.run("TAIL_LABELS = ['追加の項目']");
  const before = t.lastCol;
  env.call({ action: 'status', ...env.as(sub) });
  assert.equal(t.cell(1, before + 1), '追加の項目');
  assert.equal(t.cell(1, 1), '運営メモ');
});

test('installTriggers / checkLine / onOpen が動く（予約のみ）', () => {
  const env = makeEnv();
  env.ctx.installTriggers(); env.ctx.installTriggers();
  assert.deepEqual(env.triggers.map((t) => t.h).sort(), ['cleanupTemp', 'onOpen']);
  env.ctx.checkLine();
  assert.equal(env.fetchLog.filter((x) => x.url.includes('bot/info')).length, 1);
});

test('index.html と Code.gs の質問定義（キー・文言・選択肢・必須・条件）が一致する', () => {
  const schema = JSON.parse(HTML.match(/<script type="application\/json" id="schema">([\s\S]*?)<\/script>/)[1]);
  const env = makeEnv();
  const server = JSON.parse(JSON.stringify(env.run('FIELDS')));
  const client = [];
  for (const s of schema.sections) for (const f of s.items) if (f.key) client.push(f);
  assert.deepEqual(server.map((f) => f.key), client.map((f) => f.key));
  for (let i = 0; i < server.length; i++) {
    const c = client[i], s = server[i];
    for (const k of ['key', 'label', 'sheet', 'type', 'scope', 'sec', 'req', 'options', 'when']) assert.deepEqual(s[k], c[k], s.key + '.' + k);
    if (c.items) assert.deepEqual(s.items, c.items.map((x) => ({ text: x.text, scope: x.scope || 'all' })));
  }
  assert.equal(schema.sections.map((s) => s.title).join('|'), '出店者情報|キッチンカーの情報|テント（半張り）の情報|出店内容');
  assert.equal(client.length, 47);
  assert.equal(env.run('FIELDS.filter(f => f.type === "file").length'), 6);
  assert.equal(env.run('SECTION_TITLES.s2'), 'キッチンカーの情報');
  assert.deepEqual(client.filter((f) => f.type === 'file').map((f) => f.key), ['file_car_photo', 'file_car_layout', 'file_car_permit', 'file_tent_photo', 'file_menu_photo', 'file_pl']);
  const labels = client.map((f) => f.sheet || f.label);
  assert.equal(new Set(labels).size, labels.length, '見出しが重複しない');
  assert.equal(schema.sections[1].items.filter((f) => f.type === 'select').every((f) => f.options.length >= 2), true);
});

test('index.html：決まりごとの静的な確認（日付の直書きなし・設定値・novalidate・text/plain・mock はローカルだけ）', () => {
  assert.ok(!HTML.includes('2027年2月21日') && !HTML.includes('2月26日') && !HTML.includes('2027-02'), '締切・発表日の直書きなし');
  assert.match(HTML, /const LIFF_ID = '(\d{10}-[A-Za-z0-9]{8})?';/); assert.match(HTML, /const API_URL = '(https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec)?';/);
  assert.ok(HTML.includes("const ADD_FRIEND_URL = 'https://lin.ee/OSrDrX3';"));
  assert.ok(HTML.includes('novalidate'));
  assert.ok(HTML.includes("'Content-Type': 'text/plain;charset=utf-8'"));
  assert.ok(!/method:\s*'GET'/.test(HTML));
  assert.ok(HTML.includes("const MOCK = IS_LOCAL && params.get('mock') === '1';"));
  assert.ok(HTML.includes("location.hostname === 'localhost' || location.hostname === '127.0.0.1'"));
  assert.ok(HTML.includes('family=Noto+Sans+JP:wght@400;500;700'));
  assert.ok(HTML.includes('https://static.line-scdn.net/liff/edge/2/sdk.js'));
  assert.ok(!/box-shadow|linear-gradient|radial-gradient/.test(HTML), '影・グラデーションなし');
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(HTML.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')), '絵文字なし');
  assert.ok(!/type="radio"|type: 'radio'/.test(HTML), 'ラジオは使わない');
  assert.ok(!/userId/.test(HTML.replace(/Umock/g, '')) || !/userId\s*:/.test(HTML.replace(/mockLiff[\s\S]*?\n    \},\n    getIDToken/, '')), '本文にuserIdを載せない');
  for (const s of ['読み込み中です...', 'タイムアウトしました。開き直してください', '読み込みに失敗しました。開き直してください', '友だち追加する', '友だち追加のあと、このページを開き直してください。', '応募の受付は終了しました。', '変更を保存する', '応募する', '送信中...', '次の項目をご確認ください', 'ご応募を受け付けました', 'ご応募内容の変更を保存しました', 'ご応募内容の控えを公式LINEでお送りしました。', '設定が終わっていません', '住所を検索', '規定サイズ（全長6m×全幅2.5m×全高3.5m）を超えています。', 'ご応募は、LINEアカウント1つにつき1回までです。送信後も', '選択してください', 'ご応募には公式LINE『飲食出店窓口Symphonic』の友だち登録が必要です。']) assert.ok(HTML.includes(s), s);
  // 画面の script が構文として正しい
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]);
});

test('appsscript.json：Asia/Tokyo・V8・ウェブアプリ設定・Drive v3・スコープ', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas/appsscript.json'), 'utf8'));
  assert.equal(j.timeZone, 'Asia/Tokyo'); assert.equal(j.runtimeVersion, 'V8');
  assert.deepEqual(j.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  assert.deepEqual(j.dependencies.enabledAdvancedServices, [{ userSymbol: 'Drive', version: 'v3', serviceId: 'drive' }]);
  for (const s of ['drive', 'spreadsheets', 'script.external_request', 'script.scriptapp', 'script.container.ui']) assert.ok(j.oauthScopes.some((x) => x.endsWith('/' + s)), s);
});

test('Code.gs：日付はいちばん上の3か所だけ／DriveApp を使わない／本文のuserIdを読まない', () => {
  assert.equal((CODE.match(/2027年2月21日（日）23:59/g) || []).length, 1);
  assert.equal((CODE.match(/2027年2月26日（金）/g) || []).length, 1);
  assert.equal((CODE.match(/2027-02-22T00:00:00\+09:00/g) || []).length, 1);
  assert.ok(!/DriveApp/.test(CODE));
  assert.ok(!/body\.userId|body\.lineUserId|data\.lineUserId|e\.parameter/.test(CODE));
  assert.ok(!/Sheets\.Spreadsheets|SpreadsheetApp\.getActive/.test(CODE));
});


test('先頭が = + - @ \' の文字は先頭に \' を付けて書く（本物のSheetsでは書式@でも数式になるため）。読み戻しに \' は付かない', () => {
  const env = makeEnv();
  const sub = 'Uapos';
  const vals = { shop: '=テスト食堂', company: '+81 shop', rep: '-1', contact: '@cmd', item1Name: "'引用符始まり", pr: '=1+1\n2行目' };
  const r = submit(env, sub, 'new', tentData(vals), { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(r.ok, true, JSON.stringify(r));
  const t = env.sheet();
  assert.deepEqual(t.formulas, [], '数式として入ったセルは無い');
  for (const [k, l] of [['shop', '店舗名（屋号）'], ['company', '会社名（団体名）'], ['rep', '代表者名'], ['contact', '当日担当者'], ['item1Name', '出店商品①の商品名'], ['pr', '店舗のPR文']]) assert.equal(t.cell(2, env.colOf(l)), vals[k], k);
  const st = env.call({ action: 'status', ...env.as(sub) });
  for (const k of Object.keys(vals)) assert.equal(st.entry.data[k], vals[k], 'status の entry に \' が付かない: ' + k);
  // LINE表示名が「=」で始まっても数式にならない
  const sub2 = 'Uapos2';
  assert.equal(submit(env, sub2, 'new', tentData({ shop: '-x' }), { ...NOFILES, ...tentFiles(env, sub2) }, { displayName: '=名前' }).ok, true);
  assert.deepEqual(t.formulas, []);
  // update も同じ
  assert.equal(submit(env, sub, 'update', tentData({ shop: '=更新後' }), { ...NOFILES, ...tentFiles(env, sub) }).ok, true);
  assert.equal(t.cell(2, env.colOf('店舗名（屋号）')), '=更新後'); assert.deepEqual(t.formulas, []);
  assert.equal(env.call({ action: 'status', ...env.as(sub) }).entry.data.shop, '=更新後');
});

test('書き込みエラー（flush）は catch に入り、new は書いた行を空にして印を付けない／update は元の値に戻る', () => {
  const env = makeEnv();
  const sub = 'Uflush';
  const f = { ...NOFILES, ...tentFiles(env, sub) };
  env.hooks.flushError = true;
  const r = submit(env, sub, 'new', tentData(), f);
  assert.equal(r.error, 'saveFailed');
  assert.ok(!env.props.has('applied:' + sub), '印なし');
  const t = env.sheet();
  for (let c = 1; c <= t.lastCol; c++) assert.equal(t.cell(2, c), '', '書いた行は空に戻る: col ' + c);
  for (const id of Object.values(f).flat()) assert.deepEqual(env.drive.get(id).parents, [env.temp()]);
  env.hooks.flushError = false;
  const again = submit(env, sub, 'new', tentData(), f);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(t.cell(2, env.colOf('受付番号')), again.receiptNo, '空に戻した行が再利用される');
  assert.equal(t.lastRow, 2);
  // update の失敗：シートの値が元に戻る
  const before = { shop: t.cell(2, env.colOf('店舗名（屋号）')), staff: t.cell(2, env.colOf('当日のスタッフ人数')), upd: t.cell(2, env.colOf('最終変更日時')), file: t.cell(2, env.colOf('PL保険証の写し')) };
  const f2 = { ...NOFILES, ...tentFiles(env, sub) };
  env.hooks.flushError = true;
  const u = submit(env, sub, 'update', tentData({ shop: '失敗する更新', staff: '9' }), f2);
  assert.equal(u.error, 'saveFailed');
  assert.equal(t.cell(2, env.colOf('店舗名（屋号）')), before.shop); assert.equal(t.cell(2, env.colOf('当日のスタッフ人数')), before.staff);
  assert.equal(t.cell(2, env.colOf('最終変更日時')), before.upd); assert.equal(t.cell(2, env.colOf('PL保険証の写し')), before.file);
  assert.equal(env.props.get('applied:' + sub), again.receiptNo);
  for (const id of Object.values(f2).flat()) assert.deepEqual(env.drive.get(id).parents, [env.temp()], '新しいファイルは一時保管へ戻る');
});

test('新しい行は「受付番号の列で最後に埋まっている行＋1」／運営の列のセルには値も書式も触らない', () => {
  const env = makeEnv();
  const t = env.sheet();
  const a = submit(env, 'Urow1', 'new', tentData(), { ...NOFILES, ...tentFiles(env, 'Urow1') });
  assert.equal(a.ok, true);
  // 運営が列の途中に「運営列」を足す（フォームの列の間）。その列の2行目以降にも値を入れ、受付番号の無い行（メモ）を下に作る
  const mid = env.colOf('メールアドレス');
  for (let r = 6; r >= 1; r--) for (let c = t.lastCol; c > mid; c--) { t.cells.set(r + ',' + (c + 1), t.cell(r, c)); if (t.fmt.has(r + ',' + c)) t.fmt.set(r + ',' + (c + 1), t.fmt.get(r + ',' + c)); }
  t.lastCol += 1;
  t.cells.set('1,' + (mid + 1), '運営列'); t.cells.set('2,' + (mid + 1), '運営A');
  t.cells.set('3,' + (mid + 1), '運営B'); t.fmt.set('3,' + (mid + 1), '0.00');
  t.cells.set('6,1', '下のほうのメモ'); t.lastRow = 6; // 受付番号の無い行が下にある
  const b = submit(env, 'Urow2', 'new', tentData({ shop: '二番目' }), { ...NOFILES, ...tentFiles(env, 'Urow2') });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(t.cell(3, env.colOf('受付番号')), b.receiptNo, '受付番号の列で最後に埋まっている行の次（3行目）に書く');
  assert.equal(t.cell(3, env.colOf('店舗名（屋号）')), '二番目');
  assert.equal(t.cell(3, mid + 1), '運営B', '運営の列の値は触らない');
  assert.equal(t.fmt.get('3,' + (mid + 1)), '0.00', '運営の列の書式は触らない');
  assert.equal(t.cell(2, mid + 1), '運営A');
  assert.equal(t.cell(6, 1), '下のほうのメモ');
  assert.equal(t.cell(3, env.colOf('メールアドレス')), 'test@example.com');
  // update でも運営の列に触らない
  t.fmt.set('2,' + (mid + 1), '#,##0');
  assert.equal(submit(env, 'Urow1', 'update', tentData({ shop: '更新' }), { ...NOFILES, ...tentFiles(env, 'Urow1') }).ok, true);
  assert.equal(t.cell(2, mid + 1), '運営A'); assert.equal(t.fmt.get('2,' + (mid + 1)), '#,##0');
  assert.equal(t.cell(2, env.colOf('店舗名（屋号）')), '更新');
});

test('update：外したファイルを動かすのは本人のものだけ／シートにある他人のファイルURLを残しても断らず、触らない', () => {
  const env = makeEnv();
  const sub = 'Uown';
  const f1 = { ...NOFILES, ...tentFiles(env, sub) };
  const r = submit(env, sub, 'new', tentData(), f1);
  assert.equal(r.ok, true);
  const folderId = env.props.get('folder:' + r.receiptNo);
  // 運営が「他人のファイル」と「持ち主の無いファイル」のURLをシートのファイル列に足した（応募フォルダ内に置いてある）
  const mk = (desc, name) => env.ctx.Drive.Files.create({ name, mimeType: 'application/pdf', parents: [folderId], description: desc }, null, { supportsAllDrives: true }).id;
  const foreign = mk('owner:Usomeone', '他人.pdf'), nobody = mk('', '持ち主なし.pdf');
  const t = env.sheet(); const col = env.colOf('PL保険証の写し');
  t.cells.set('2,' + col, t.cell(2, col) + '\nhttps://drive.google.com/file/d/' + foreign + '/view\nhttps://drive.google.com/file/d/' + nobody + '/view');
  const own = f1.file_pl[0];
  // 画面は entry で全部返してくるので、3つとも送り返す → 断られず、他人のものは動かず、URLも残る
  const u = submit(env, sub, 'update', tentData(), { ...f1, file_pl: [own, foreign, nobody] });
  assert.equal(u.ok, true, JSON.stringify(u));
  for (const id of [foreign, nobody]) { assert.deepEqual(env.drive.get(id).parents, [folderId]); }
  assert.equal(env.drive.get(foreign).name, '他人.pdf'); assert.equal(env.drive.get(nobody).name, '持ち主なし.pdf');
  assert.ok(t.cell(2, col).includes(foreign) && t.cell(2, col).includes(nobody));
  // 外した場合：本人のものは 差し替え前、他人のものは触らない（URLも消える）
  const added = env.upload(sub, 'file_pl', { mime: 'application/pdf' }).fileId;
  const u2 = submit(env, sub, 'update', tentData(), { ...f1, file_pl: [added] });
  assert.equal(u2.ok, true, JSON.stringify(u2));
  const repl = [...env.drive.values()].find((x) => x.name === '差し替え前' && x.parents.includes(folderId));
  assert.deepEqual(env.drive.get(own).parents, [repl.id], '本人のものは差し替え前へ');
  assert.deepEqual(env.drive.get(foreign).parents, [folderId], '他人のものは動かさない'); assert.deepEqual(env.drive.get(nobody).parents, [folderId]);
  // 送ってきたIDが「シートに元から無い」他人のファイルなら、従来どおり断る
  const stranger = env.ctx.Drive.Files.create({ name: 's.pdf', mimeType: 'application/pdf', parents: [folderId], description: 'owner:Usomeone' }, null, { supportsAllDrives: true }).id;
  assert.equal(submit(env, sub, 'update', tentData(), { ...f1, file_pl: [added, stranger] }).error, 'invalid');
});

test('cleanupTemp はロックが取れなければその日は何もしない', () => {
  const env = makeEnv();
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const f = env.ctx.Drive.Files.create({ name: 'o', mimeType: 'image/jpeg', parents: [env.temp()], description: 'owner:U' }, null, { supportsAllDrives: true });
  env.drive.get(f.id).createdTime = old;
  env.hooks.locked = true;
  assert.equal(env.ctx.cleanupTemp(), 0);
  assert.equal(env.drive.get(f.id).trashed, false);
  env.hooks.locked = false;
  assert.equal(env.ctx.cleanupTemp(), 1);
  assert.equal(env.hooks.locked, false, 'ロックは返す');
});

test('持ち主確認はロックの外で先に済ませる／ロックの中では動かす直前にゴミ箱だけ再確認する', () => {
  const env = makeEnv();
  const sub = 'Ulockorder';
  const f = { ...NOFILES, ...tentFiles(env, sub) };
  env.hooks.events.length = 0;
  assert.equal(submit(env, sub, 'new', tentData(), f).ok, true);
  const ev = env.hooks.events;
  const lockAt = ev.indexOf('lock');
  const n = Object.values(f).flat().length;
  assert.ok(ev.slice(0, lockAt).filter((e) => e === 'get').length >= n, 'ロックの前に全ファイルの get を済ませる: ' + ev.join(','));
  // 確認のあと動かす前にファイルがゴミ箱へ入れられたら、ロックの中の再確認で断る（何も書かない）
  const sub2 = 'Ulockorder2';
  const f2 = { ...NOFILES, ...tentFiles(env, sub2) };
  const target = f2.file_pl[0];
  env.hooks.onLock = () => { env.drive.get(target).trashed = true; env.hooks.onLock = null; };
  const r = submit(env, sub2, 'new', tentData(), f2);
  assert.equal(r.error, 'invalid'); assert.deepEqual(ids(r), ['file_pl']);
  assert.ok(!env.props.has('applied:' + sub2));
  assert.equal(env.sheet().lastRow, 2, '2件目は書かれていない');
  assert.deepEqual(env.drive.get(f2.file_menu_photo[0]).parents, [env.temp()], '他のファイルも動かさない');
});


test('index.html（画面の直し）：null を append しない・全角の正規化・accept・IDトークン期限切れ・タイムアウト後の出し直しなど', () => {
  const script = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];
  // 7: DOM の append は el と add の2か所だけ（null を直接 append しない）
  assert.equal((script.match(/\.append\(/g) || []).length, 2);
  assert.ok(/function add\(parent\)[\s\S]*?kid == null \|\| kid === false\) return;/.test(script));
  // 10: toHalf を取り出して実際に動かす
  const fn = script.match(/function toHalf\(s\) \{[\s\S]*?\n\}/)[0];
  const toHalf = vm.runInNewContext('(' + fn.replace('function toHalf', 'function') + ')');
  assert.equal(toHalf('０７７－０００－００００'), '077-000-0000');
  assert.equal(toHalf('０７７ー０００ー００００'), '077-000-0000');
  assert.equal(toHalf('５２５−０００１'), '525-0001');
  assert.equal(toHalf('２．５'), '2.5'); assert.equal(toHalf('5．2'), '5.2');
  // 11・19
  assert.ok(script.includes("accept: 'image/*,application/pdf'"));
  assert.match(HTML, /input\[type=file\]\{[^}]*font-size:16px/);
  // 9: タイムアウト後に status が成功で返ったら出し直す（タイムアウトで return しない）
  const boot = script.match(/async function boot\(\) \{[\s\S]*?\n\}/)[0];
  assert.ok(!/const st = await api\('status'\);\s*if \(S\.timedOut\) return;/.test(boot));
  assert.ok(/const fr = await L\.getFriendship\(\);\s*if \(!fr/.test(boot));
  // 13: status が ok:false のときはサーバーの文言を出さず、指示書の文言と段階名
  assert.ok(boot.includes("'読み込みに失敗しました。開き直してください'"));
  // 12: IDトークンの期限（残り5分）・退避・ログインし直し・復元
  assert.ok(script.includes('getDecodedIDToken') && script.includes('exp - Date.now() / 1000 < 300'));
  assert.ok(script.includes('L.login({ redirectUri: location.href })'));
  assert.ok(/sessionStorage\.setItem\(DRAFT_KEY/.test(script) && /sessionStorage\.removeItem\(DRAFT_KEY\)/.test(script));
  assert.ok(/async function onSubmit\(\) \{\s*if \(sending\) return;\s*if \(!ensureFresh\(\)\) return;/.test(script));
  assert.ok(/async function uploadItem\(key, item\) \{[\s\S]*?if \(!ensureFresh\(\)\) return;/.test(script));
  assert.ok(/res\.error === 'unauthorized' && action !== 'status' && !reloginRecently\(\)\) \{\s*relogin\(\);/.test(script));
  assert.ok(script.includes('restoreDraft();'));
  // mock でも確かめられる
  assert.ok(script.includes("params.get('tokenLeft')") && script.includes("params.get('expired') === '1'"));
  // 14
  assert.ok(script.includes('アップロードに失敗しました。もう一度お試しいただくか、削除してください。'));
  assert.ok(script.includes('のファイルの送信が終わっていません。'));
  // 15
  assert.ok(script.includes('S.queue.then(run, run).catch('));
  // 16: 送信中は全部 disabled に（失敗したら戻す）
  assert.ok(script.includes('allset.disabled = true;') && script.includes('allset.disabled = S.readonly;'));
  // 17
  assert.ok(script.includes('すでにご応募いただいています。このページを開き直すと、内容の確認・変更ができます。'));
  // 18
  assert.ok(/setTimeout\(function \(\) \{ ctl\.abort\(\); \}, 8000\)/.test(script));
  // 8: 形態を戻したら値・ファイルを戻す
  assert.ok(script.includes('function stashField(f)') && script.includes('function restoreField(f)') && script.includes("S.stash[sk]"));
  // 新しい文字は指示どおり（サーバーが本文のuserIdを受け取る道がない）
  assert.ok(!/userId\s*:/.test(script.replace(/getProfile[\s\S]*?Umock[\s\S]*?\}\)/, '')));
});


test('nextRow_：受付番号の列の最後＋1から、書く予定の列が全部空の最初の行まで下へ進める（運営のメモ行を上書きしない）', () => {
  const env = makeEnv();
  const t = env.sheet();
  assert.equal(submit(env, 'Unr1', 'new', tentData(), { ...NOFILES, ...tentFiles(env, 'Unr1') }).ok, true);
  // 3・4行目にフォームの列（会社名）へ運営のメモ、5行目は運営の列だけ（フォームの列は全部空）
  t.cells.set('3,' + env.colOf('会社名（団体名）'), '運営メモ3'); t.cells.set('4,' + env.colOf('電話番号'), '運営メモ4');
  const opsCol = t.lastCol + 1; t.cells.set('1,' + opsCol, '運営列'); t.cells.set('5,' + opsCol, '運営だけ'); t.lastCol = opsCol; t.lastRow = 5;
  const r = submit(env, 'Unr2', 'new', tentData({ shop: '二番目' }), { ...NOFILES, ...tentFiles(env, 'Unr2') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(t.cell(3, env.colOf('会社名（団体名）')), '運営メモ3'); assert.equal(t.cell(4, env.colOf('電話番号')), '運営メモ4');
  assert.equal(t.cell(5, env.colOf('受付番号')), r.receiptNo, 'メモ行を飛ばして5行目へ');
  assert.equal(t.cell(5, opsCol), '運営だけ', '運営の列は触らない');
  assert.equal(t.cell(2, env.colOf('受付番号')) !== '', true);
});

test('update：確認のあと本人の行のファイル列が変わっていたら、書く前に busy を返す', () => {
  const env = makeEnv();
  const sub = 'Ubusy';
  const f1 = { ...NOFILES, ...tentFiles(env, sub) };
  assert.equal(submit(env, sub, 'new', tentData(), f1).ok, true);
  const t = env.sheet(); const col = env.colOf('PL保険証の写し');
  const before = t.cell(2, env.colOf('店舗名（屋号）'));
  const f2 = { ...NOFILES, ...tentFiles(env, sub) };
  env.hooks.onLock = () => { t.cells.set('2,' + col, t.cell(2, col) + '\nhttps://drive.google.com/file/d/OPSADDEDFILE0001/view'); env.hooks.onLock = null; };
  const r = submit(env, sub, 'update', tentData({ shop: '書かれてはいけない' }), f2);
  assert.equal(r.error, 'busy');
  assert.equal(t.cell(2, env.colOf('店舗名（屋号）')), before, '何も書かない');
  for (const id of Object.values(f2).flat()) assert.deepEqual(env.drive.get(id).parents, [env.temp()], 'ファイルも動かさない');
  // 画面の送り直し（もう一度 submit）は通る
  const again = submit(env, sub, 'update', tentData({ shop: '送り直し' }), { ...f2, file_pl: [...f1.file_pl, 'OPSADDEDFILE0001'] });
  assert.equal(again.ok, true, JSON.stringify(again));
});

test('巻き戻しのあとにも flush する（失敗は握る）／元が数値・日付ならそのまま、書式も元に戻す', () => {
  const env = makeEnv();
  const sub = 'Urestore';
  assert.equal(submit(env, sub, 'new', tentData(), { ...NOFILES, ...tentFiles(env, sub) }).ok, true);
  const t = env.sheet();
  const cStaff = env.colOf('当日のスタッフ人数'), cNote = env.colOf('ご質問等ございましたらご記入ください。');
  const when = new Date('2026-12-01T00:00:00Z');
  t.cells.set('2,' + cStaff, 3); t.fmt.set('2,' + cStaff, '0.00');
  t.cells.set('2,' + cNote, when); t.fmt.set('2,' + cNote, 'yyyy/mm/dd');
  env.hooks.flushError = true; env.hooks.flushCount = 0;
  const r = submit(env, sub, 'update', tentData({ staff: '9', inquiry: '更新' }), { ...NOFILES, ...tentFiles(env, sub) });
  assert.equal(r.error, 'saveFailed', JSON.stringify(r));
  assert.ok(env.hooks.flushCount >= 2, '巻き戻しのあとにも flush を呼ぶ: ' + env.hooks.flushCount);
  assert.strictEqual(t.cell(2, cStaff), 3, '数値のまま戻る'); assert.equal(t.fmt.get('2,' + cStaff), '0.00');
  assert.strictEqual(t.cell(2, cNote), when, '日付のまま戻る'); assert.equal(t.fmt.get('2,' + cNote), 'yyyy/mm/dd');
});

test('index.html（再点検）：2分以内の再ログインはしない・下書きに sub・status の文言の出し分け', () => {
  const script = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];
  assert.ok(script.includes("RELOGIN_AT_KEY = 'ss27_relogin_at'") && script.includes('< 120000'));
  assert.ok(/function relogin\(\) \{\s*saveDraft\(\);\s*try \{ sessionStorage\.setItem\(RELOGIN_AT_KEY/.test(script));
  assert.ok(/if \(reloginRecently\(\)\) return true;[\s\S]*?relogin\(\); return false;/.test(script), 'ensureFresh');
  assert.ok(script.includes("action !== 'status' && !reloginRecently()"), 'api の unauthorized');
  assert.ok(script.includes('sub: currentSub()') && script.includes("(d.sub || '') !== currentSub()"));
  assert.ok(script.includes("st.error !== 'unauthorized' && st.message ? st.message : '読み込みに失敗しました。開き直してください'"));
  assert.ok(/showMsg\(msg, '段階：status'\)/.test(script));
});

/* ---------- 実行 ---------- */
let pass = 0, fail = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log('  ok   ' + t.name); }
  catch (e) { fail++; console.log('  FAIL ' + t.name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
}
console.log(`\n${pass} passed, ${fail} failed (${tests.length} tests)`);
process.exit(fail ? 1 : 0);
