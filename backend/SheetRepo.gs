/**
 * SheetRepo.gs
 * Pattanabhumi Biology Learning Management System - Step 2 Data Foundation
 *
 * Responsibilities:
 * - Provide editor-only setup and verification entry points:
 *     1. setupEnvironmentFromEditor_()
 *     2. runStep2VerificationSuiteFromEditor_()
 * - Verify that Google Sheets, private Google Drive folder, and Google Calendar
 *   resources exist, are accessible, and are not shared publicly.
 * - Initialize all 16 normalized worksheet tabs idempotently (safe to run repeatedly
 *   without erasing existing rows).
 * - Provide header-driven CRUD operations, optimistic concurrency versioning (version),
 *   short LockService critical sections, and bounded cursor pagination.
 *
 * Security Note:
 * - Every function in this file ends with an underscore (_) so it cannot be called
 *   from browser clients via google.script.run.
 */

var PB_REQUEST_SPREADSHEET_CACHE_ = null;

/**
 * Acquires the script lock for a short critical section and executes callbackFn.
 *
 * @param {Function} callbackFn Synchronous function to run inside the lock.
 * @param {number=} opt_timeoutMs Lock wait timeout in milliseconds.
 * @return {*} Result of callbackFn.
 */
var PB_ACTIVE_LOCK_DEPTH_ = 0;

function withScriptLock_(callbackFn, opt_timeoutMs) {
  if (PB_ACTIVE_LOCK_DEPTH_ > 0) {
    PB_ACTIVE_LOCK_DEPTH_ += 1;
    try {
      return callbackFn();
    } finally {
      PB_ACTIVE_LOCK_DEPTH_ -= 1;
    }
  }

  var lock = LockService.getScriptLock();
  var timeout =
    opt_timeoutMs ||
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.LOCK_TIMEOUT_MS) ||
    10000;
  var acquired = false;
  try {
    acquired = lock.tryLock(timeout);
  } catch (err) {
    acquired = false;
  }

  if (!acquired) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_LOCK_TIMEOUT,
      'The server is currently busy completing another update. Please try again in a few seconds.'
    );
  }

  PB_ACTIVE_LOCK_DEPTH_ = 1;
  try {
    return callbackFn();
  } finally {
    PB_ACTIVE_LOCK_DEPTH_ = 0;
    try {
      lock.releaseLock();
    } catch (releaseErr) {
      console.warn('Warning releasing script lock:', releaseErr);
    }
  }
}
/**
 * Opens the configured Google Spreadsheet by ID from ScriptProperties (or an override ID).
 *
 * @param {string=} opt_spreadsheetIdOverride Optional Spreadsheet ID override for diagnostics.
 * @return {Spreadsheet} Google Apps Script Spreadsheet instance.
 */
var PB_ISOLATED_SYNTHETIC_SANDBOX_SPREADSHEET_STEP15_ = null;

function openConfiguredSpreadsheet_(opt_spreadsheetIdOverride) {
  if (PB_ISOLATED_SYNTHETIC_SANDBOX_SPREADSHEET_STEP15_) {
    return PB_ISOLATED_SYNTHETIC_SANDBOX_SPREADSHEET_STEP15_;
  }
  if (!opt_spreadsheetIdOverride && PB_REQUEST_SPREADSHEET_CACHE_) {
    return PB_REQUEST_SPREADSHEET_CACHE_;
  }

  var rawId =
    opt_spreadsheetIdOverride !== undefined
      ? opt_spreadsheetIdOverride
      : getRequiredScriptProperty_('SPREADSHEET_ID');
  var spreadsheetId = validateResourceIdFormat_('SPREADSHEET_ID', rawId);

  try {
    var ss = SpreadsheetApp.openById(spreadsheetId);
    if (!ss) {
      throw new Error('SpreadsheetApp.openById returned null.');
    }
    if (!opt_spreadsheetIdOverride) {
      PB_REQUEST_SPREADSHEET_CACHE_ = ss;
    }
    return ss;
  } catch (err) {
    var errMsg =
      'Unable to open Google Sheet with SPREADSHEET_ID "' +
      spreadsheetId +
      '". Verify the ID is correct and owned by or shared with this Google account. Details: ' +
      String(err && err.message ? err.message : err);
    throw createAppError_(
      PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE,
      errMsg,
      { SPREADSHEET_ID: 'Spreadsheet not found or inaccessible.' }
    );
  }
}

/**
 * Verifies that the configured private Google Drive folder is accessible and NOT shared publicly.
 * If the folder is accidentally set to ANYONE or ANYONE_WITH_LINK, restricts it to PRIVATE.
 *
 * @param {string=} opt_folderIdOverride Optional Drive Folder ID override for testing.
 * @return {{ folderId: string, folderName: string, accessLevel: string }}
 */
function verifyAndSecurePrivateDriveFolder_(opt_folderIdOverride) {
  var rawId =
    opt_folderIdOverride !== undefined
      ? opt_folderIdOverride
      : getRequiredScriptProperty_('PRIVATE_DRIVE_FOLDER_ID');
  var folderId = validateResourceIdFormat_('PRIVATE_DRIVE_FOLDER_ID', rawId);

  var folder = null;
  try {
    folder = DriveApp.getFolderById(folderId);
    if (!folder) {
      throw new Error('DriveApp.getFolderById returned null.');
    }
  } catch (err) {
    var folderErrMsg =
      'Unable to access Google Drive folder with PRIVATE_DRIVE_FOLDER_ID "' +
      folderId +
      '". Verify the Folder ID is correct and owned by this Google account. Details: ' +
      String(err && err.message ? err.message : err);
    throw createAppError_(
      PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE,
      folderErrMsg,
      { PRIVATE_DRIVE_FOLDER_ID: 'Drive folder not found or inaccessible.' }
    );
  }

  var access = folder.getSharingAccess();
  if (
    access === DriveApp.Access.ANYONE ||
    access === DriveApp.Access.ANYONE_WITH_LINK ||
    access === DriveApp.Access.DOMAIN ||
    access === DriveApp.Access.DOMAIN_WITH_LINK
  ) {
    try {
      folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      access = folder.getSharingAccess();
    } catch (ignoreFolderShareErr) {}
  }

  return {
    folderId: folder.getId(),
    folderName: folder.getName(),
    accessLevel: String(access)
  };
}

/**
 * Verifies that the Spreadsheet file itself is not publicly shared in Google Drive.
 *
 * @param {string} spreadsheetId Validated Spreadsheet ID.
 * @return {string} Sharing access level string after verification.
 */
function ensureSpreadsheetIsPrivateInDrive_(spreadsheetId) {
  try {
    var file = DriveApp.getFileById(spreadsheetId);
    var access = file.getSharingAccess();
    if (
      access === DriveApp.Access.ANYONE ||
      access === DriveApp.Access.ANYONE_WITH_LINK ||
      access === DriveApp.Access.DOMAIN ||
      access === DriveApp.Access.DOMAIN_WITH_LINK
    ) {
      file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      access = file.getSharingAccess();
    }
    return String(access);
  } catch (err) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE,
      'Unable to verify Drive sharing permissions on Spreadsheet "' +
        spreadsheetId +
        '": ' +
        String(err && err.message ? err.message : err)
    );
  }
}

/**
 * Verifies that the configured Google Calendar is accessible and checks its timezone.
 *
 * @param {string=} opt_calendarIdOverride Optional Calendar ID override for testing.
 * @return {{ calendarId: string, calendarName: string, timeZone: string }}
 */
function verifyConfiguredCalendar_(opt_calendarIdOverride) {
  var rawId =
    opt_calendarIdOverride !== undefined
      ? opt_calendarIdOverride
      : getRequiredScriptProperty_('CALENDAR_ID');
  var calendarId = validateResourceIdFormat_('CALENDAR_ID', rawId);

  var cal = null;
  try {
    cal = CalendarApp.getCalendarById(calendarId);
  } catch (err) {
    cal = null;
  }

  if (!cal) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE,
      'Unable to access Google Calendar with CALENDAR_ID "' +
        calendarId +
        '". Make sure you copied the Calendar ID (such as xxx@group.calendar.google.com), not the iCal URL, and that the calendar belongs to or is shared with this account.',
      { CALENDAR_ID: 'Calendar not found or inaccessible.' }
    );
  }

  return {
    calendarId: cal.getId(),
    calendarName: cal.getName(),
    timeZone: cal.getTimeZone()
  };
}

/**
 * Ensures APP_MASTER_SECRET exists in ScriptProperties. If missing, generates a
 * 256-bit (64-hex-character) high-entropy secret using two-stage HMAC-SHA256 extraction
 * and saves it to ScriptProperties. Never overwrites an existing valid APP_MASTER_SECRET.
 *
 * @return {{ createdNewSecret: boolean, secretLengthHex: number }}
 */
function ensureMasterSecretProvisioned_() {
  var props = PropertiesService.getScriptProperties();
  var current = props.getProperty('APP_MASTER_SECRET');
  if (typeof current === 'string' && /^[0-9a-f]{64}$/i.test(current.trim())) {
    return {
      createdNewSecret: false,
      secretLengthHex: 64
    };
  }

  var entropyKey =
    Utilities.getUuid() +
    '|' +
    Utilities.getUuid() +
    '|' +
    new Date().toISOString() +
    '|' +
    Math.random();
  var entropyMsgA =
    'PB_ROOT_KEY_BLOCK_A|' +
    Utilities.getUuid() +
    '|' +
    new Date().getTime() +
    '|' +
    Math.random();
  var entropyMsgB =
    'PB_ROOT_KEY_BLOCK_B|' +
    Utilities.getUuid() +
    '|' +
    new Date().getTime() +
    '|' +
    Math.random();

  var partA = bytesToHex_(
    Utilities.computeHmacSha256Signature(entropyMsgA, entropyKey)
  );
  var partB = bytesToHex_(
    Utilities.computeHmacSha256Signature(entropyMsgB, partA)
  );
  var masterSecretHex = (partA.slice(0, 32) + partB.slice(0, 32)).toLowerCase();

  props.setProperty('APP_MASTER_SECRET', masterSecretHex);
  if (!props.getProperty('CSPRNG_COUNTER')) {
    props.setProperty('CSPRNG_COUNTER', '1');
  }

  return {
    createdNewSecret: true,
    secretLengthHex: masterSecretHex.length
  };
}

/**
 * Ensures a single worksheet tab exists with the exact header row defined in PB_SHEET_SCHEMAS_.
 * Safe to run repeatedly:
 * - Creates the tab if missing.
 * - Populates row 1 headers if the sheet is blank.
 * - Appends any newly added schema columns to the right of existing headers without
 *   modifying or deleting existing data rows.
 * - Freezes header row 1.
 *
 * @param {Spreadsheet} spreadsheet Open Spreadsheet instance.
 * @param {string} sheetName Name of worksheet in PB_SHEET_SCHEMAS_.
 * @return {{ sheetName: string, createdSheet: boolean, initializedHeaders: boolean, existingDataRows: number }}
 */
function ensureSingleSheetSchema_(spreadsheet, sheetName) {
  invalidateInRequestTableCache_(sheetName);
  var schema = PB_SHEET_SCHEMAS_[sheetName];
  if (!schema) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Missing schema definition for sheet: ' + String(sheetName)
    );
  }

  var sheet = spreadsheet.getSheetByName(sheetName);
  var createdSheet = false;
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    createdSheet = true;
  }

  var expectedHeaders = schema.headers;
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var initializedHeaders = false;

  if (lastRow === 0 || lastCol === 0) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    sheet.setFrozenRows(1);
    initializedHeaders = true;
    return {
      sheetName: sheetName,
      createdSheet: createdSheet,
      initializedHeaders: initializedHeaders,
      existingDataRows: 0
    };
  }

  var currentHeaders = sheet
    .getRange(1, 1, 1, lastCol)
    .getValues()[0]
    .map(function (h) {
      return String(h || '').trim();
    });

  for (var i = 0; i < expectedHeaders.length; i++) {
    var expectedCol = expectedHeaders[i];
    if (i < currentHeaders.length) {
      if (currentHeaders[i] === '') {
        sheet.getRange(1, i + 1).setValue(expectedCol);
        currentHeaders[i] = expectedCol;
        initializedHeaders = true;
      } else if (currentHeaders[i] !== expectedCol) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Header mismatch in sheet "' +
            sheetName +
            '" at column ' +
            (i + 1) +
            ': expected "' +
            expectedCol +
            '" but found "' +
            currentHeaders[i] +
            '". Existing data was preserved and not overwritten.'
        );
      }
    } else {
      sheet.getRange(1, i + 1).setValue(expectedCol);
      currentHeaders.push(expectedCol);
      initializedHeaders = true;
    }
  }

  sheet.setFrozenRows(1);

  return {
    sheetName: sheetName,
    createdSheet: createdSheet,
    initializedHeaders: initializedHeaders,
    existingDataRows: Math.max(0, lastRow - 1)
  };
}

/**
 * Ensures all 16 worksheet tabs and their headers exist without deleting existing data.
 *
 * @param {Spreadsheet} spreadsheet Open Spreadsheet instance.
 * @return {Array<Object>} Per-sheet initialization report.
 */
function ensureAllDatabaseSheets_(spreadsheet) {
  var results = [];
  for (var i = 0; i < PB_SHEET_NAMES_.length; i++) {
    var sheetName = PB_SHEET_NAMES_[i];
    var status = ensureSingleSheetSchema_(spreadsheet, sheetName);
    results.push(status);
  }
  return results;
}

/**
 * Converts a spreadsheet cell value into a normalized JS type based on schema column metadata.
 *
 * @param {Object} schema Sheet schema from PB_SHEET_SCHEMAS_.
 * @param {string} colName Column header name.
 * @param {*} rawCell Cell value from getValues().
 * @return {*} Normalized JS value.
 */
function deserializeCellValue_(schema, colName, rawCell) {
  if (schema.booleanFields.indexOf(colName) !== -1) {
    return rawCell === true || rawCell === 'TRUE' || rawCell === 'true';
  }
  if (schema.integerFields.indexOf(colName) !== -1) {
    if (rawCell === '' || rawCell === null || rawCell === undefined) {
      return 0;
    }
    var n = Number(rawCell);
    return isFinite(n) ? Math.floor(n) : 0;
  }
  if (rawCell instanceof Date) {
    return rawCell.toISOString();
  }
  if (rawCell === null || rawCell === undefined) {
    return '';
  }
  var strCell = String(rawCell);
  if (strCell.length >= 2 && strCell.charAt(0) === "'" && /^[ \t\r\n]*[=+\-@\t\r]/.test(strCell.slice(1))) {
    return strCell.slice(1);
  }
  return strCell;
}

/**
 * Converts a validated record object into a 1D row array matching schema.headers order.
 *
 * @param {Object} schema Sheet schema from PB_SHEET_SCHEMAS_.
 * @param {Object} validatedRecord Validated record object.
 * @return {Array<*>} Row values array.
 */
function serializeRecordToRow_(schema, validatedRecord) {
  var row = [];
  for (var i = 0; i < schema.headers.length; i++) {
    var col = schema.headers[i];
    var val = validatedRecord[col];
    if (schema.booleanFields.indexOf(col) !== -1) {
      row.push(Boolean(val));
    } else if (schema.integerFields.indexOf(col) !== -1) {
      row.push(Number(val));
    } else {
      var strVal = val === undefined || val === null ? '' : String(val);
      row.push(
        typeof neutralizeSpreadsheetFormulaCellStep15_ === 'function'
          ? neutralizeSpreadsheetFormulaCellStep15_(strVal)
          : strVal
      );
    }
  }
  return row;
}

/**
 * Reads all rows from a worksheet and builds an indexed structure for fast in-memory lookup.
 *
 * @param {string} sheetName Target worksheet name.
 * @param {Spreadsheet=} opt_spreadsheet Optional open Spreadsheet instance.
 * @return {{ sheet: Sheet, schema: Object, records: Array<Object>, byId: Object<string, { rowNumber: number, record: Object }> }}
 */
var PB_IN_REQUEST_TABLE_CACHE_ = null;

function invalidateInRequestTableCache_(opt_sheetName) {
  if (!PB_IN_REQUEST_TABLE_CACHE_) return;
  if (opt_sheetName) {
    delete PB_IN_REQUEST_TABLE_CACHE_[opt_sheetName];
  } else {
    PB_IN_REQUEST_TABLE_CACHE_ = {};
  }
}

function readSheetTable_(sheetName, opt_spreadsheet) {
  if (!PB_SHEET_SCHEMAS_[sheetName] && typeof ensureExamIntegrityPhaseASchemasRegistered_ === 'function') {
    try { ensureExamIntegrityPhaseASchemasRegistered_(); } catch (e) {}
  }
  var schema = PB_SHEET_SCHEMAS_[sheetName];
  if (!schema) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Unknown worksheet: ' + String(sheetName)
    );
  }
  if (!opt_spreadsheet && PB_IN_REQUEST_TABLE_CACHE_ && PB_IN_REQUEST_TABLE_CACHE_[sheetName]) {
    var cachedTbl = PB_IN_REQUEST_TABLE_CACHE_[sheetName];
    return {
      sheet: cachedTbl.sheet,
      schema: cachedTbl.schema,
      records: cachedTbl.records.slice(),
      byId: cachedTbl.byId
    };
  }

  var ss = opt_spreadsheet || openConfiguredSpreadsheet_();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    try {
      ensureSingleSheetSchema_(ss, sheetName);
      sheet = ss.getSheetByName(sheetName);
    } catch (ignoreAutoCreateErr) {}
  }
  if (!sheet) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Worksheet "' +
        sheetName +
        '" does not exist yet. Run setupEnvironmentFromEditor_ in the Apps Script editor.'
    );
  }

  var lastRow = sheet.getLastRow();
  var colCount = schema.headers.length;
  var records = [];
  var byId = {};

  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, colCount).setValues([schema.headers]);
    sheet.setFrozenRows(1);
    return {
      sheet: sheet,
      schema: schema,
      records: records,
      byId: byId
    };
  }

  var values = sheet.getRange(1, 1, lastRow, colCount).getValues();
  var firstCell = String((values[0] && values[0][0]) || '').trim();
  var hasHeaderInRow1 = firstCell === schema.primaryKey;

  if (!hasHeaderInRow1 && firstCell.length > 0) {
    /* Self-heal if a data row was written to row 1 before headers were initialized */
    if (typeof sheet.insertRowBefore === 'function') {
      try {
        sheet.insertRowBefore(1);
        sheet.getRange(1, 1, 1, colCount).setValues([schema.headers]);
        sheet.setFrozenRows(1);
        lastRow = sheet.getLastRow();
        values = sheet.getRange(1, 1, lastRow, colCount).getValues();
        hasHeaderInRow1 = true;
      } catch (ignoreInsertRowErr) {}
    }
  }

  if (hasHeaderInRow1 && lastRow <= 1) {
    return {
      sheet: sheet,
      schema: schema,
      records: records,
      byId: byId
    };
  }

  var startRowIndex = hasHeaderInRow1 ? 1 : 0;
  for (var r = startRowIndex; r < values.length; r++) {
    var rowArray = values[r];
    var pkRaw = rowArray[0];
    if (pkRaw === '' || pkRaw === null || pkRaw === undefined) {
      continue;
    }

    var recordObj = {};
    for (var c = 0; c < colCount; c++) {
      var colName = schema.headers[c];
      recordObj[colName] = deserializeCellValue_(schema, colName, rowArray[c]);
    }

    var pk = String(recordObj[schema.primaryKey]);
    var rowNumber = r + 1;
    records.push(recordObj);
    byId[pk] = {
      rowNumber: rowNumber,
      record: recordObj
    };
  }

  return {
    sheet: sheet,
    schema: schema,
    records: records,
    byId: byId
  };
}

/**
 * Fetches a single record by its primary key or returns null if not found.
 *
 * @param {string} sheetName Target worksheet name.
 * @param {string} primaryKeyValue Primary key value.
 * @param {Spreadsheet=} opt_spreadsheet Optional open Spreadsheet instance.
 * @return {Object|null} Record object or null.
 */
function getSheetRecordById_(sheetName, primaryKeyValue, opt_spreadsheet) {
  if (typeof primaryKeyValue !== 'string' || primaryKeyValue.trim().length === 0) {
    return null;
  }
  var table = readSheetTable_(sheetName, opt_spreadsheet);
  var hit = table.byId[primaryKeyValue.trim()];
  return hit ? hit.record : null;
}

/**
 * Queries a worksheet with optional filter predicate, comparator, and bounded cursor pagination.
 *
 * @param {string} sheetName Target worksheet name.
 * @param {Object=} opt_options Query options.
 * @return {{ items: Array<Object>, nextCursor: (string|null), totalMatched: number }}
 */
function querySheetRecords_(sheetName, opt_options) {
  var opts = opt_options && typeof opt_options === 'object' ? opt_options : {};
  var pageOpts = normalizePaginationOptions_({
    limit: opts.limit,
    cursor: opts.cursor
  });

  var table = readSheetTable_(sheetName, opts.spreadsheet);
  var pkCol = table.schema.primaryKey;
  var matched = [];

  for (var i = 0; i < table.records.length; i++) {
    var rec = table.records[i];
    if (typeof opts.filterFn === 'function' && !opts.filterFn(rec)) {
      continue;
    }
    matched.push(rec);
  }

  if (typeof opts.sortFn === 'function') {
    matched.sort(opts.sortFn);
  }

  var startIndex = 0;
  if (pageOpts.cursor) {
    for (var j = 0; j < matched.length; j++) {
      if (String(matched[j][pkCol]) === pageOpts.cursor) {
        startIndex = j + 1;
        break;
      }
    }
  }

  var slice = matched.slice(startIndex, startIndex + pageOpts.limit);
  var nextCursor = null;
  if (startIndex + pageOpts.limit < matched.length && slice.length > 0) {
    nextCursor = String(slice[slice.length - 1][pkCol]);
  }

  return {
    items: slice,
    nextCursor: nextCursor,
    totalMatched: matched.length
  };
}

/**
 * Inserts a new record into a worksheet inside a short LockService critical section.
 *
 * @param {string} sheetName Target worksheet name.
 * @param {Object} draftRecord Record fields to insert.
 * @param {Object=} opt_options Optional { spreadsheet, skipLock }.
 * @return {Object} The validated, inserted record.
 */
function insertSheetRecord_(sheetName, draftRecord, opt_options) {
  var opts = opt_options && typeof opt_options === 'object' ? opt_options : {};
  var schema = PB_SHEET_SCHEMAS_[sheetName];
  if (!schema) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Unknown worksheet: ' + String(sheetName)
    );
  }

  var executeInsert = function () {
    var table = readSheetTable_(sheetName, opts.spreadsheet);
    var candidate = {};
    var keys = Object.keys(draftRecord || {});
    for (var i = 0; i < keys.length; i++) {
      candidate[keys[i]] = draftRecord[keys[i]];
    }

    var nowIso = nowUtcIso_();
    var pkCol = schema.primaryKey;
    if (!candidate[pkCol] || String(candidate[pkCol]).trim().length === 0) {
      candidate[pkCol] = generateEntityId_(schema.idPrefix);
    } else {
      candidate[pkCol] = String(candidate[pkCol]).trim();
    }

    if (Object.prototype.hasOwnProperty.call(table.byId, candidate[pkCol])) {
      var dupErr = {};
      dupErr[pkCol] = 'Duplicate primary key "' + candidate[pkCol] + '".';
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'A record with ' +
          pkCol +
          ' "' +
          candidate[pkCol] +
          '" already exists in "' +
          sheetName +
          '".',
        dupErr
      );
    }

    if (
      schema.headers.indexOf('created_at_utc') !== -1 &&
      !candidate.created_at_utc
    ) {
      candidate.created_at_utc = nowIso;
    }
    if (
      schema.headers.indexOf('updated_at_utc') !== -1 &&
      !candidate.updated_at_utc
    ) {
      candidate.updated_at_utc = nowIso;
    }
    if (schema.hasVersion) {
      candidate.version = 1;
    }

    var validated = validateRecordAgainstSchema_(sheetName, candidate);
    var rowArray = serializeRecordToRow_(schema, validated);
    table.sheet.appendRow(rowArray);

    return validated;
  };

  if (opts.skipLock === true) {
    return executeInsert();
  }
  return withScriptLock_(executeInsert);
}

/**
 * Updates an existing record by primary key with optimistic concurrency version enforcement.
 *
 * @param {string} sheetName Target worksheet name.
 * @param {string} primaryKeyValue Target primary key.
 * @param {Object} patchFields Fields to update.
 * @param {number=} opt_expectedVersion Required when schema.hasVersion is true.
 * @param {Object=} opt_options Optional { spreadsheet, skipLock }.
 * @return {Object} Updated, validated record.
 */
function updateSheetRecordById_(
  sheetName,
  primaryKeyValue,
  patchFields,
  opt_expectedVersion,
  opt_options
) {
  var opts = opt_options && typeof opt_options === 'object' ? opt_options : {};
  var schema = PB_SHEET_SCHEMAS_[sheetName];
  if (!schema) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Unknown worksheet: ' + String(sheetName)
    );
  }

  var executeUpdate = function () {
    var table = readSheetTable_(sheetName, opts.spreadsheet);
    var hit = table.byId[String(primaryKeyValue || '').trim()];
    if (!hit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Record "' +
          String(primaryKeyValue) +
          '" not found in worksheet "' +
          sheetName +
          '".'
      );
    }

    var current = hit.record;
    if (schema.hasVersion) {
      var expectedVer = Number(opt_expectedVersion);
      if (
        opt_expectedVersion === undefined ||
        opt_expectedVersion === null ||
        !isFinite(expectedVer) ||
        expectedVer !== Number(current.version)
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Optimistic concurrency conflict on "' +
            sheetName +
            '" (' +
            primaryKeyValue +
            '): expected version ' +
            String(opt_expectedVersion) +
            ' but current stored version is ' +
            String(current.version) +
            '. Reload before saving.'
        );
      }
    }

    var merged = {};
    for (var i = 0; i < schema.headers.length; i++) {
      var col = schema.headers[i];
      merged[col] = current[col];
    }

    var patchKeys = Object.keys(patchFields || {});
    for (var p = 0; p < patchKeys.length; p++) {
      var k = patchKeys[p];
      if (k === schema.primaryKey || k === 'created_at_utc' || k === 'version') {
        continue;
      }
      if (schema.headers.indexOf(k) !== -1) {
        merged[k] = patchFields[k];
      }
    }

    if (schema.headers.indexOf('updated_at_utc') !== -1) {
      merged.updated_at_utc = nowUtcIso_();
    }
    if (schema.hasVersion) {
      merged.version = Number(current.version) + 1;
    }

    var validated = validateRecordAgainstSchema_(sheetName, merged);
    var rowArray = serializeRecordToRow_(schema, validated);
    table.sheet
      .getRange(hit.rowNumber, 1, 1, schema.headers.length)
      .setValues([rowArray]);

    return validated;
  };

  if (opts.skipLock === true) {
    return executeUpdate();
  }
  return withScriptLock_(executeUpdate);
}

/**
 * Seeds default school settings into the Settings tab if they do not already exist.
 *
 * @param {Spreadsheet} spreadsheet Open Spreadsheet instance.
 * @param {string} calendarId Validated Google Calendar ID.
 * @return {{ insertedCount: number, preservedCount: number }}
 */

/**
 * Deletes a single row by primary key from a worksheet (used ONLY when zero financial
 * references exist).
 */
function deleteSheetRecordById_(
  sheetName,
  primaryKeyValue,
  opt_expectedVersion,
  opt_options
) {
  var opts = opt_options && typeof opt_options === 'object' ? opt_options : {};
  var schema = PB_SHEET_SCHEMAS_[sheetName];
  if (!schema) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Unknown worksheet: ' + String(sheetName)
    );
  }

  var executeDelete = function () {
    var table = readSheetTable_(sheetName, opts.spreadsheet);
    var pk = String(primaryKeyValue || '').trim();
    var hit = table.byId[pk];
    if (!hit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Record "' + pk + '" not found in worksheet "' + sheetName + '".'
      );
    }

    var current = hit.record;
    if (schema.hasVersion && opt_expectedVersion !== undefined && opt_expectedVersion !== null) {
      var expectedVer = Number(opt_expectedVersion);
      if (!isFinite(expectedVer) || expectedVer !== Number(current.version)) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Optimistic concurrency conflict on "' +
            sheetName +
            '" (' +
            pk +
            '): expected version ' +
            String(opt_expectedVersion) +
            ' but stored version is ' +
            String(current.version) +
            '. Another administrator modified this record; please reload before retrying.'
        );
      }
    }

    if (typeof table.sheet.deleteRow === 'function') {
      table.sheet.deleteRow(hit.rowNumber);
    } else {
      var emptyRow = [];
      for (var c = 0; c < schema.headers.length; c++) {
        emptyRow.push('');
      }
      table.sheet
        .getRange(hit.rowNumber, 1, 1, schema.headers.length)
        .setValues([emptyRow]);
    }

    return {
      deleted: true,
      primaryKey: pk,
      deletedRecord: current
    };
  };

  if (opts.skipLock === true) {
    return executeDelete();
  }
  return withScriptLock_(executeDelete);
}
function seedDefaultSettingsIfMissing_(spreadsheet, calendarId) {
  var table = readSheetTable_('Settings', spreadsheet);
  var insertedCount = 0;
  var preservedCount = 0;
  var nowIso = nowUtcIso_();

  var seeds = PB_DEFAULT_SETTINGS_SEED_.slice();
  seeds.push({
    setting_key: 'CALENDAR_ID',
    setting_value: calendarId
  });

  for (var i = 0; i < seeds.length; i++) {
    var item = seeds[i];
    if (Object.prototype.hasOwnProperty.call(table.byId, item.setting_key)) {
      preservedCount++;
      continue;
    }

    insertSheetRecord_(
      'Settings',
      {
        setting_key: item.setting_key,
        setting_value: item.setting_value,
        updated_by_user_id: 'SYSTEM',
        updated_at_utc: nowIso
      },
      { spreadsheet: spreadsheet, skipLock: true }
    );
    insertedCount++;
  }

  return {
    insertedCount: insertedCount,
    preservedCount: preservedCount
  };
}

/**
 * EDITOR-ONLY SETUP ENTRY POINT
 * Run this function manually from the Google Apps Script editor toolbar after setting
 * SPREADSHEET_ID, PRIVATE_DRIVE_FOLDER_ID, and CALENDAR_ID in Script Properties.
 *
 * @param {Object=} opt_overrides Optional config overrides used by automated verification tests.
 * @return {Object} Detailed setup report.
 */
function setupEnvironmentFromEditor_(opt_overrides) {
  var overrides =
    opt_overrides && typeof opt_overrides === 'object' ? opt_overrides : {};

  return withScriptLock_(function () {
    var propsMap = getAllScriptPropertiesMap_();
    var rawSheetId =
      overrides.SPREADSHEET_ID !== undefined
        ? overrides.SPREADSHEET_ID
        : propsMap.SPREADSHEET_ID;
    var rawFolderId =
      overrides.PRIVATE_DRIVE_FOLDER_ID !== undefined
        ? overrides.PRIVATE_DRIVE_FOLDER_ID
        : propsMap.PRIVATE_DRIVE_FOLDER_ID;
    var rawCalId =
      overrides.CALENDAR_ID !== undefined
        ? overrides.CALENDAR_ID
        : propsMap.CALENDAR_ID;

    var spreadsheetId = validateResourceIdFormat_('SPREADSHEET_ID', rawSheetId);
    var folderId = validateResourceIdFormat_(
      'PRIVATE_DRIVE_FOLDER_ID',
      rawFolderId
    );
    var calendarId = validateResourceIdFormat_('CALENDAR_ID', rawCalId);

    var spreadsheet = openConfiguredSpreadsheet_(spreadsheetId);
    var sheetSharingAccess = ensureSpreadsheetIsPrivateInDrive_(spreadsheetId);
    var folderStatus = verifyAndSecurePrivateDriveFolder_(folderId);
    var calendarStatus = verifyConfiguredCalendar_(calendarId);

    var secretStatus = ensureMasterSecretProvisioned_();
    var defaultLogoPropStatus = ensureDefaultLogoPropertyProvisioned_();
    var sheetStatuses = ensureAllDatabaseSheets_(spreadsheet);
    var settingsSeedReport = seedDefaultSettingsIfMissing_(
      spreadsheet,
      calendarId
    );

    var auditRecord = recordAuditEvent_(
      {
        actorUserId: 'SYSTEM',
        actorRole: 'SYSTEM',
        eventType: 'SYSTEM_SETUP_COMPLETED',
        targetEntityType: 'Spreadsheet',
        targetEntityId: spreadsheetId,
        summary: {
          sheetsVerifiedCount: sheetStatuses.length,
          settingsInsertedCount: settingsSeedReport.insertedCount,
          settingsPreservedCount: settingsSeedReport.preservedCount,
          createdNewMasterSecret: secretStatus.createdNewSecret,
          calendarTimeZone: calendarStatus.timeZone
        }
      },
      spreadsheet
    );

    var report = {
      ok: true,
      completedAtUtc: nowUtcIso_(),
      completedAtBangkok: formatBangkokTimestamp_(new Date()),
      spreadsheetName: spreadsheet.getName(),
      spreadsheetSharingAccess: sheetSharingAccess,
      driveFolderName: folderStatus.folderName,
      driveFolderAccess: folderStatus.accessLevel,
      calendarName: calendarStatus.calendarName,
      calendarTimeZone: calendarStatus.timeZone,
      masterSecretStatus: secretStatus,
      defaultLogoPropertyStatus: defaultLogoPropStatus,
      sheetsReport: sheetStatuses,
      settingsSeedReport: settingsSeedReport,
      auditId: auditRecord.audit_id
    };

    console.log(
      'Pattanabhumi Biology Step 2 Setup Completed Successfully:\n' +
        JSON.stringify(report, null, 2)
    );
    return report;
  });
}

/**
 * EDITOR-ONLY VERIFICATION SUITE FOR STEP 2
 *
 * @return {Object} Verification test results summary.
 */
function runStep2VerificationSuiteFromEditor_() {
  var results = [];

  var setupRun1 = setupEnvironmentFromEditor_();
  var setupRun2 = setupEnvironmentFromEditor_();
  results.push({
    test: 'REPEATED_SETUP_IDEMPOTENCY',
    passed:
      setupRun1.ok === true &&
      setupRun2.ok === true &&
      setupRun2.settingsSeedReport.insertedCount === 0 &&
      setupRun2.settingsSeedReport.preservedCount >=
        PB_DEFAULT_SETTINGS_SEED_.length
  });

  var missingIdCaught = false;
  try {
    setupEnvironmentFromEditor_({ SPREADSHEET_ID: '' });
  } catch (err) {
    missingIdCaught = err && err.pbCode === PB_ERROR_CODES_.ERR_CONFIG_MISSING;
  }
  results.push({
    test: 'MISSING_ID_REJECTION',
    passed: missingIdCaught
  });

  var badFolderCaught = false;
  try {
    verifyAndSecurePrivateDriveFolder_('nonexistent_folder_id_999999999');
  } catch (err) {
    badFolderCaught =
      err && err.pbCode === PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE;
  }
  results.push({
    test: 'INACCESSIBLE_DRIVE_FOLDER_REJECTION',
    passed: badFolderCaught
  });

  var badCalendarCaught = false;
  try {
    verifyConfiguredCalendar_('nonexistent_calendar_id_999999@group.calendar.google.com');
  } catch (err) {
    badCalendarCaught =
      err && err.pbCode === PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE;
  }
  results.push({
    test: 'INACCESSIBLE_CALENDAR_REJECTION',
    passed: badCalendarCaught
  });

  var plaintextPwdCaught = false;
  try {
    validateRecordAgainstSchema_('Users', {
      user_id: 'usr_test1',
      username_lower: 'admin',
      username_display: 'admin',
      email: 'admin@example.com',
      full_name: 'Admin User',
      role: 'ADMIN',
      status: 'ACTIVE',
      password_hash: 'PlaintextPassword123!',
      created_at_utc: nowUtcIso_(),
      updated_at_utc: nowUtcIso_(),
      version: 1
    });
  } catch (err) {
    plaintextPwdCaught =
      err &&
      err.pbCode === PB_ERROR_CODES_.ERR_VALIDATION_FAILED &&
      Boolean(err.fieldErrors && err.fieldErrors.password_hash);
  }

  var invalidSatangCaught = false;
  try {
    validateRecordAgainstSchema_('Invoices', {
      invoice_id: 'inv_test1',
      user_id: 'usr_test1',
      installment_label: 'Installment 1',
      amount_satang: -500,
      due_date_bkk: '2026-11-01',
      status: 'UNPAID',
      created_at_utc: nowUtcIso_(),
      updated_at_utc: nowUtcIso_(),
      version: 1
    });
  } catch (err) {
    invalidSatangCaught =
      err &&
      err.pbCode === PB_ERROR_CODES_.ERR_VALIDATION_FAILED &&
      Boolean(err.fieldErrors && err.fieldErrors.amount_satang);
  }

  results.push({
    test: 'INVALID_RECORD_DATA_REJECTION',
    passed: plaintextPwdCaught && invalidSatangCaught
  });

  var allPassed = results.every(function (r) {
    return r.passed === true;
  });

  var summary = {
    allPassed: allPassed,
    executedAtBangkok: formatBangkokTimestamp_(new Date()),
    results: results
  };

  console.log(
    'Step 2 Verification Suite Results:\n' + JSON.stringify(summary, null, 2)
  );
  return summary;
}

/**
 * Ensures `DEFAULT_LOGO_DRIVE_FILE_ID` is present in ScriptProperties.
 * If missing, sets it to `12EKzWLkKL9XEdZVrJBzGNERdAd7BFi--` without overwriting
 * any existing value configured by the owner.
 *
 * @return {{ configuredFileId: string, seededDefault: boolean }}
 */
function ensureDefaultLogoPropertyProvisioned_() {
  var props = PropertiesService.getScriptProperties();
  var key =
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.DEFAULT_LOGO_PROPERTY_KEY) ||
    'DEFAULT_LOGO_DRIVE_FILE_ID';
  var fallbackId =
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.DEFAULT_LOGO_DRIVE_FILE_ID) ||
    '12EKzWLkKL9XEdZVrJBzGNERdAd7BFi--';
  var current = props.getProperty(key);
  if (typeof current === 'string' && current.trim().length > 0) {
    return {
      configuredFileId: current.trim(),
      seededDefault: false
    };
  }
  props.setProperty(key, fallbackId);
  return {
    configuredFileId: fallbackId,
    seededDefault: true
  };
}

/**
 * Compatibility alias for `getSheetRecordById_`.
 */
function findSheetRecordById_(sheetName, primaryKeyValue, opt_spreadsheet) {
  return getSheetRecordById_(sheetName, primaryKeyValue, opt_spreadsheet);
}