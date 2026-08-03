/**
 * C-SAT panelist counselling outcomes -> Supabase, every 15 minutes.
 *
 * Reads the tab by its gid (so renaming the tab cannot break this) and upserts
 * into public.csat_counselling_outcomes, keyed on (lead_id, submitted_at). A
 * panelist can submit more than once for the same student, so nothing is
 * overwritten and nothing is deleted — re-running is safe.
 *
 * SETUP, once:
 *   1. Extensions > Apps Script on the responses sheet, paste this file.
 *   2. Project Settings > Script properties, add:
 *        SUPABASE_URL          https://ymadoyyvuylyquutcrqi.supabase.co
 *        SUPABASE_SERVICE_KEY  <service_role key from Supabase > API settings>
 *      Put the key ONLY here. Never in this file, never in a commit.
 *   3. Run installTrigger() once. Authorise when prompted.
 *   4. Run syncNow() once to backfill, then check the Executions log.
 */

var SHEET_GID = 1975480529;   // the tab you linked
var TABLE = 'csat_counselling_outcomes';
var CHUNK = 200;              // rows per request

/** Create the 15-minute trigger. Safe to re-run: it clears its own duplicates. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNow') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(15).create();
  Logger.log('Trigger installed: syncNow every 15 minutes.');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNow') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Trigger removed.');
}

/** Find the tab by gid, not by name. */
function sheetByGid_(gid) {
  var sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) return sheets[i];
  }
  throw new Error('No tab with gid ' + gid + ' in this spreadsheet.');
}

/** Header text -> column key. Matched loosely so small header edits do not break it. */
function mapHeaders_(header) {
  var idx = {};
  for (var c = 0; c < header.length; c++) {
    var h = String(header[c] || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!h) continue;
    if (idx.submitted_at === undefined && h.indexOf('timestamp') === 0) idx.submitted_at = c;
    else if (idx.panelist_email === undefined && h.indexOf('email address') === 0) idx.panelist_email = c;
    else if (idx.lead_id === undefined && h === 'student id') idx.lead_id = c;
    else if (idx.student_name === undefined && h === 'student name') idx.student_name = c;
    else if (idx.guardian_available === undefined && h.indexOf('parents') === 0) idx.guardian_available = c;
    else if (idx.status === undefined && h.indexOf('student counselling status') === 0) idx.status = c;
    else if (idx.reschedule_reason === undefined && h.indexOf('reason for resched') === 0) idx.reschedule_reason = c;
    else if (idx.verify_10 === undefined && h.indexOf('verify 10') === 0) idx.verify_10 = c;
    else if (idx.verify_12 === undefined && h.indexOf('verify 12') === 0) idx.verify_12 = c;
    else if (idx.campus_1 === undefined && h.indexOf('preferred campus 1') === 0) idx.campus_1 = c;
    else if (idx.campus_2 === undefined && h.indexOf('preferred campus 2') === 0) idx.campus_2 = c;
    else if (idx.communication_skills === undefined && h.indexOf('communication skills') === 0) idx.communication_skills = c;
    else if (idx.motivation === undefined && h.indexOf('motivation') === 0) idx.motivation = c;
    else if (idx.likelihood_seat === undefined && h.indexOf('likelihood') === 0) idx.likelihood_seat = c;
    else if (idx.scholarship_reco === undefined && h.indexOf('scholarship recommendation') === 0) idx.scholarship_reco = c;
    else if (idx.remarks === undefined && h.indexOf('detailed remarks') === 0) idx.remarks = c;
    else if (idx.program === undefined && h.indexOf('please choose program') === 0) idx.program = c;
  }
  ['submitted_at', 'lead_id', 'status'].forEach(function (k) {
    if (idx[k] === undefined) throw new Error('Required column not found in the sheet: ' + k);
  });
  return idx;
}

function txt_(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  return s === '' ? null : s;
}

/** 1-5 rating; anything that is not a small integer becomes null rather than junk. */
function score_(v) {
  var s = txt_(v);
  if (s === null) return null;
  var n = Number(s);
  return (isFinite(n) && n >= 0 && n <= 5 && n === Math.floor(n)) ? n : null;
}

function iso_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();
  var s = txt_(v);
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function syncNow() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL');
  var key = props.getProperty('SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Script properties first.');

  var sh = sheetByGid_(SHEET_GID);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) { Logger.log('Nothing to sync.'); return; }

  var idx = mapHeaders_(values[0]);
  var rows = [], skipped = 0;

  for (var r = 1; r < values.length; r++) {
    var v = values[r];
    var lead = txt_(v[idx.lead_id]);
    var at = iso_(v[idx.submitted_at]);
    // no lead id or no timestamp means the row cannot be keyed; count it, do not guess
    if (!lead || !at) { if (v.join('').trim() !== '') skipped++; continue; }
    rows.push({
      lead_id: lead,
      submitted_at: at,
      panelist_email: txt_(v[idx.panelist_email]),
      student_name: txt_(v[idx.student_name]),
      guardian_available: txt_(v[idx.guardian_available]),
      status: txt_(v[idx.status]),
      reschedule_reason: txt_(v[idx.reschedule_reason]),
      verify_10: txt_(v[idx.verify_10]),
      verify_12: txt_(v[idx.verify_12]),
      campus_1: txt_(v[idx.campus_1]),
      campus_2: txt_(v[idx.campus_2]),
      communication_skills: score_(v[idx.communication_skills]),
      motivation: score_(v[idx.motivation]),
      likelihood_seat: score_(v[idx.likelihood_seat]),
      scholarship_reco: score_(v[idx.scholarship_reco]),
      remarks: txt_(v[idx.remarks]),
      program: txt_(v[idx.program]),
      source_gid: SHEET_GID,
      sheet_row: r + 1,
      synced_at: new Date().toISOString()
    });
  }

  // De-dupe on the primary key inside the batch: Postgres rejects an upsert that
  // touches the same key twice in one statement.
  var seen = {}, unique = [];
  for (var i = 0; i < rows.length; i++) {
    var k = rows[i].lead_id + '|' + rows[i].submitted_at;
    if (seen[k]) continue;
    seen[k] = true;
    unique.push(rows[i]);
  }

  var endpoint = url.replace(/\/$/, '') + '/rest/v1/' + TABLE +
                 '?on_conflict=lead_id,submitted_at';
  var sent = 0;
  for (var s = 0; s < unique.length; s += CHUNK) {
    var batch = unique.slice(s, s + CHUNK);
    var res = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(batch),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error('Supabase ' + code + ': ' + res.getContentText().slice(0, 400));
    }
    sent += batch.length;
  }

  Logger.log('Synced ' + sent + ' rows from gid ' + SHEET_GID +
             ' (' + skipped + ' rows skipped: no student id or no timestamp).');
}
