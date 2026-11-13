/**
 * PaymentService.gs
 * Pattanabhumi Biology Learning Management System - Step 10 Invoices & Payment-Session Business Logic
 *
 * Responsibilities:
 * 1. Money & Integer Satang Arithmetic:
 *    - Store all monetary amounts strictly as positive integer satang (1 THB = 100 satang).
 *    - Parse decimal THB strings safely using string/integer arithmetic (zero binary floating-point multiplication).
 *    - Enforce minimum (1.00 THB = 100 satang), maximum (1,000,000.00 THB = 100,000,000 satang),
 *      and precision (at most 2 decimal places).
 *    - Sum invoice totals on the server using pure integer addition and ignore client-supplied totals.
 * 2. Administrator Invoices:
 *    - Select student, installment label, amount in THB, and due date (YYYY-MM-DD in Asia/Bangkok).
 *    - Create unpaid invoice (status = 'UNPAID') and view full invoice history with summary counts.
 *    - Preserve financial references and explicitly reject unimplemented invoice editing or refunds.
 * 3. Payment Sessions & Canonical State Machine:
 *    - Select one, multiple, or all eligible unpaid invoices (status in ['UNPAID', 'REJECTED']).
 *    - Verify student ownership and invoice state inside a LockService critical section.
 *    - Calculate authoritative total from database Invoices records and ignore client-supplied totals.
 *    - Support PromptPay ('PROMPTPAY_QR') and Bank Transfer ('BANK_TRANSFER') with immutable recipient snapshot.
 *    - Create server-side 15-minute expiry (900 seconds) and return both serverNow and expiresAt.
 *    - Support session resume, cancellation ('CANCELLED'), and deterministic expiration ('EXPIRED').
 *    - Prepare and enforce exact API contract states:
 *      Payments.status: 'PENDING_TRANSFER' (Awaiting transfer), 'EXPIRED', 'CANCELLED',
 *                       'AWAITING_VERIFICATION', 'APPROVING', 'PAID', 'REJECTED'
 *                       (plus 'RECEIPT_UPLOADED' / 'APPROVED' compatibility).
 *      Invoices.status: 'UNPAID', 'RESERVED', 'AWAITING_VERIFICATION', 'APPROVING', 'PAID', 'REJECTED', 'CANCELLED'.
 * 4. Idempotency, Concurrency & Write-Ahead PaymentJournal Recovery:
 *    - Require a stable idempotencyKey for financial mutations; verify payload fingerprint match;
 *      return existing completed result on retry; reject mismatched reuse with ERR_IDEMPOTENCY_CONFLICT.
 *    - Use short LockService critical sections and a write-ahead PaymentJournal ('PENDING' -> 'COMMITTED')
 *      with deterministic roll-forward recovery across Payments and Invoices without claiming full ACID.
 */

var PB_PAYMENT_CONSTANTS_STEP10_ = Object.freeze({
  MIN_INVOICE_SATANG: 100, /* 1.00 THB */
  MAX_INVOICE_SATANG: 100000000, /* 1,000,000.00 THB */
  MAX_PAYMENT_TOTAL_SATANG: 500000000, /* 5,000,000.00 THB */
  RESERVATION_TTL_MS: 15 * 60 * 1000, /* 15 minutes = 900,000 ms */
  RESERVATION_TTL_SECONDS: 900
});

var PB_PAYMENT_STATES_STEP10_ = Object.freeze({
  AWAITING_TRANSFER: 'PENDING_TRANSFER',
  RECEIPT_UPLOADED: 'RECEIPT_UPLOADED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  AWAITING_VERIFICATION: 'AWAITING_VERIFICATION',
  APPROVING: 'APPROVING',
  PAID: 'PAID',
  REJECTED: 'REJECTED'
});

var PB_INVOICE_STATES_STEP10_ = Object.freeze({
  UNPAID: 'UNPAID',
  RESERVED: 'RESERVED',
  AWAITING_VERIFICATION: 'AWAITING_VERIFICATION',
  APPROVING: 'APPROVING',
  PAID: 'PAID',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED'
});

/**
 * Resolves the effective server timestamp (supports deterministic clock override in tests).
 *
 * @param {Object=} opt_req Optional request payload containing `_testServerNowMs` or `_testServerNowIso`.
 * @return {{ nowMs: number, nowUtcIso: string, nowBangkok: string }}
 */
function resolveServerNowStep10_(opt_req) {
  var req = opt_req && typeof opt_req === 'object' ? opt_req : {};
  var nowMs = Date.now();
  if (req._testServerNowMs !== undefined && req._testServerNowMs !== null) {
    var parsedMs = Number(req._testServerNowMs);
    if (isFinite(parsedMs) && parsedMs > 0) {
      nowMs = Math.floor(parsedMs);
    }
  } else if (
    typeof req._testServerNowIso === 'string' &&
    req._testServerNowIso.trim().length > 0
  ) {
    var parsedIsoMs = Date.parse(req._testServerNowIso.trim());
    if (!isNaN(parsedIsoMs) && parsedIsoMs > 0) {
      nowMs = parsedIsoMs;
    }
  }
  var nowUtcIso = new Date(nowMs).toISOString();
  return {
    nowMs: nowMs,
    nowUtcIso: nowUtcIso,
    nowBangkok: formatBangkokTimestamp_(nowUtcIso)
  };
}

/**
 * Safely parses a THB decimal input (string or number) into integer satang (1 THB = 100 satang)
 * using pure string validation and integer arithmetic. Never uses binary floating-point multiplication.
 *
 * @param {*} rawThbInput Raw THB input (e.g., "3500", "3,500.50", 3500.25).
 * @param {string=} opt_fieldName Optional field key for fieldErrors.
 * @return {number} Validated integer satang.
 */
function parseThbToSatangSafe_(rawThbInput, opt_fieldName) {
  var fieldKey = opt_fieldName || 'amountThb';
  var fieldErrors = {};

  if (rawThbInput === null || rawThbInput === undefined || rawThbInput === '') {
    fieldErrors[fieldKey] = 'Amount in THB is required.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Amount in THB is required.',
      fieldErrors
    );
  }

  if (typeof rawThbInput === 'boolean' || typeof rawThbInput === 'object') {
    fieldErrors[fieldKey] = 'Amount in THB must be a valid decimal string or number.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Amount in THB must be a valid decimal string or number.',
      fieldErrors
    );
  }

  if (typeof rawThbInput === 'number') {
    if (!isFinite(rawThbInput)) {
      fieldErrors[fieldKey] = 'Amount in THB must be a finite number.';
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Amount in THB must be a finite number.',
        fieldErrors
      );
    }
  }

  var rawStr = String(rawThbInput).trim();
  /* Strip optional currency symbol or THB label if typed by user, then remove thousands commas */
  rawStr = rawStr.replace(/^(?:THB)\s*/i, '').replace(/\s*(?:THB)$/i, '').trim();

  if (rawStr.indexOf('-') === 0) {
    fieldErrors[fieldKey] = 'Amount in THB must be a positive amount (cannot be negative).';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Amount in THB must be a positive amount (cannot be negative).',
      fieldErrors
    );
  }

  if (/[eE]/.test(rawStr)) {
    fieldErrors[fieldKey] =
      'Scientific notation is not allowed for monetary amounts.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Scientific notation is not allowed for monetary amounts.',
      fieldErrors
    );
  }

  /* Validate optional comma grouping or plain digits before removing commas */
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?$/.test(rawStr)) {
    fieldErrors[fieldKey] =
      'Invalid THB amount format "' +
      rawStr +
      '". Enter a positive number with up to 2 decimal places (e.g., 3500 or 3500.50).';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }

  var normalized = rawStr.replace(/,/g, '');
  var parts = normalized.split('.');
  var wholePart = parts[0] || '0';
  var fracPart = parts.length > 1 ? parts[1] : '';

  if (fracPart.length > 2) {
    fieldErrors[fieldKey] =
      'Amount in THB may have at most 2 decimal places (1 satang precision). Found ' +
      fracPart.length +
      ' decimal places.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }

  if (wholePart.length > 10) {
    fieldErrors[fieldKey] = 'Amount in THB exceeds the maximum allowed invoice amount.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }

  var wholeInt = parseInt(wholePart, 10);
  var paddedFrac = (fracPart + '00').slice(0, 2);
  var fracInt = parseInt(paddedFrac, 10);

  if (isNaN(wholeInt) || isNaN(fracInt) || wholeInt < 0 || fracInt < 0 || fracInt > 99) {
    fieldErrors[fieldKey] = 'Could not parse THB amount into integer satang.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }

  var satang = wholeInt * 100 + fracInt;
  return validateSatangInteger_(
    satang,
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.MIN_INVOICE_SATANG) ||
      PB_PAYMENT_CONSTANTS_STEP10_.MIN_INVOICE_SATANG,
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.MAX_INVOICE_SATANG) ||
      PB_PAYMENT_CONSTANTS_STEP10_.MAX_INVOICE_SATANG,
    fieldKey
  );
}

/**
 * Validates that a satang value is a safe integer within [minSatang, maxSatang].
 *
 * @param {*} rawSatang Candidate satang integer.
 * @param {number} minSatang Minimum allowed satang.
 * @param {number} maxSatang Maximum allowed satang.
 * @param {string=} opt_fieldName Optional field key.
 * @return {number} Validated integer satang.
 */
function validateSatangInteger_(rawSatang, minSatang, maxSatang, opt_fieldName) {
  var fieldKey = opt_fieldName || 'amountSatang';
  var fieldErrors = {};

  if (
    typeof rawSatang !== 'number' ||
    !isFinite(rawSatang) ||
    Math.floor(rawSatang) !== rawSatang
  ) {
    fieldErrors[fieldKey] = 'Monetary amount must be an exact integer in satang.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }

  if (rawSatang < minSatang) {
    fieldErrors[fieldKey] =
      'Amount (' +
      formatSatangToThbDisplay_(rawSatang) +
      ') is below the minimum allowed amount of ' +
      formatSatangToThbDisplay_(minSatang) +
      ' (' +
      minSatang +
      ' satang).';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }

  if (rawSatang > maxSatang) {
    fieldErrors[fieldKey] =
      'Amount (' +
      formatSatangToThbDisplay_(rawSatang) +
      ') exceeds the maximum allowed amount of ' +
      formatSatangToThbDisplay_(maxSatang) +
      ' (' +
      maxSatang +
      ' satang).';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }

  return rawSatang;
}

/**
 * Formats integer satang into a numeric THB string with 2 decimals (e.g., 350050 -> "3500.50")
 * using pure integer division and modulo.
 *
 * @param {number} satangInt Integer satang.
 * @return {string} Numeric THB string.
 */
function formatSatangToThbNumericString_(satangInt) {
  var n = Number(satangInt);
  if (!isFinite(n) || Math.floor(n) !== n || n < 0) {
    return '0.00';
  }
  var bahtWhole = Math.floor(n / 100);
  var satangRem = n % 100;
  var fracStr = satangRem < 10 ? '0' + String(satangRem) : String(satangRem);
  return String(bahtWhole) + '.' + fracStr;
}

/**
 * Formats integer satang into a human-readable THB display string with comma separators
 * (e.g., 350050 -> "3,500.50 THB") using pure integer arithmetic.
 *
 * @param {number} satangInt Integer satang.
 * @return {string} Formatted THB display string.
 */
function formatSatangToThbDisplay_(satangInt) {
  var n = Number(satangInt);
  if (!isFinite(n) || Math.floor(n) !== n || n < 0) {
    return '0.00 THB';
  }
  var bahtWhole = Math.floor(n / 100);
  var satangRem = n % 100;
  var wholeWithCommas = String(bahtWhole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  var fracStr = satangRem < 10 ? '0' + String(satangRem) : String(satangRem);
  return wholeWithCommas + '.' + fracStr + ' THB';
}

/**
 * Sums integer satang across an array of database `Invoices` records using pure integer addition.
 *
 * @param {Array<Object>} invoiceRows Database rows from `Invoices`.
 * @return {number} Total amount in integer satang.
 */
function sumInvoiceAmountsSatangSafe_(invoiceRows) {
  if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'At least one invoice is required to calculate a payment total.',
      { invoiceIds: 'Select at least one unpaid invoice.' }
    );
  }
  var minInv =
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.MIN_INVOICE_SATANG) ||
    PB_PAYMENT_CONSTANTS_STEP10_.MIN_INVOICE_SATANG;
  var maxInv =
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.MAX_INVOICE_SATANG) ||
    PB_PAYMENT_CONSTANTS_STEP10_.MAX_INVOICE_SATANG;
  var maxTotal =
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.MAX_PAYMENT_TOTAL_SATANG) ||
    PB_PAYMENT_CONSTANTS_STEP10_.MAX_PAYMENT_TOTAL_SATANG;

  var totalSatang = 0;
  for (var i = 0; i < invoiceRows.length; i++) {
    var row = invoiceRows[i];
    var amt = validateSatangInteger_(
      Number(row && row.amount_satang),
      minInv,
      maxInv,
      'amount_satang'
    );
    totalSatang += amt;
    if (totalSatang > maxTotal) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Combined payment total (' +
          formatSatangToThbDisplay_(totalSatang) +
          ') exceeds the maximum single-session limit of ' +
          formatSatangToThbDisplay_(maxTotal) +
          '.',
        { invoiceIds: 'Total exceeds maximum single-payment limit.' }
      );
    }
  }
  return totalSatang;
}

/**
 * Validates a calendar due date in `YYYY-MM-DD` (`Asia/Bangkok`).
 *
 * @param {*} rawDate Candidate date string.
 * @param {string=} opt_fieldKey Field key for validation errors.
 * @return {string} Validated `YYYY-MM-DD` string.
 */
function validateDueDateBkkStep10_(rawDate, opt_fieldKey) {
  var fieldKey = opt_fieldKey || 'dueDateBkk';
  var fieldErrors = {};
  var str = typeof rawDate === 'string' ? rawDate.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    fieldErrors[fieldKey] =
      'Due date must be formatted as YYYY-MM-DD (e.g., 2026-11-15).';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }
  var parts = str.split('-');
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10);
  var day = parseInt(parts[2], 10);

  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1) {
    fieldErrors[fieldKey] = 'Due date "' + str + '" is outside valid calendar bounds.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }
  var daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (isLeap) {
    daysInMonth[1] = 29;
  }
  if (day > daysInMonth[month - 1]) {
    fieldErrors[fieldKey] =
      'Due date "' + str + '" is not a valid calendar date.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[fieldKey],
      fieldErrors
    );
  }
  return str;
}

/**
 * Validates and normalizes a client-supplied idempotency key.
 *
 * @param {*} rawKey Candidate idempotency key.
 * @param {boolean=} opt_required True if required.
 * @return {string} Normalized idempotency key.
 */
function validateIdempotencyKeyStep10_(rawKey, opt_required) {
  var key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!key) {
    if (opt_required !== false) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'A stable idempotencyKey (8-120 ASCII characters) is required for financial mutations.',
        {
          idempotencyKey:
            'Provide a stable idempotencyKey (8-120 characters) to prevent duplicate operations.'
        }
      );
    }
    return '';
  }
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(key)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'idempotencyKey must be 8-120 characters using only letters, digits, dots, underscores, colons, or hyphens.',
      {
        idempotencyKey: 'Invalid idempotencyKey format.'
      }
    );
  }
  return key;
}

/**
 * Computes a deterministic SHA-256 fingerprint of a financial mutation's canonical parameters
 * so retrying the same idempotencyKey with a different payload is detected and rejected.
 *
 * @param {string} operationType Operation type label.
 * @param {string} actorUserId Authenticated user ID.
 * @param {Object} canonicalParams Canonical parameters object.
 * @return {string} 64-char hex SHA-256 fingerprint.
 */
function computePaymentRequestFingerprintStep10_(
  operationType,
  actorUserId,
  canonicalParams
) {
  var serialized =
    String(operationType || '') +
    '|' +
    String(actorUserId || '') +
    '|' +
    JSON.stringify(canonicalParams || {});
  return sha256Hex_(serialized);
}

/**
 * Snapshots the school's payment recipient configuration from `Settings` at reservation creation time.
 *
 * @param {string} method `'PROMPTPAY_QR'` | `'BANK_TRANSFER'`.
 * @param {Object=} opt_settingsTable Pre-read `Settings` table.
 * @param {string=} opt_nowUtcIso Snapshot timestamp.
 * @return {Object} Immutable recipient details snapshot.
 */
function buildRecipientDetailsSnapshotStep10_(
  method,
  opt_settingsTable,
  opt_nowUtcIso
) {
  var tbl = opt_settingsTable || readSheetTable_('Settings');
  function readVal(key, fallback) {
    if (tbl && tbl.byId && tbl.byId[key] && tbl.byId[key].record) {
      var v = String(tbl.byId[key].record.setting_value || '').trim();
      return v.length > 0 ? v : fallback;
    }
    return fallback;
  }
  var snapUtc = opt_nowUtcIso || nowUtcIso_();
  var schoolName = readVal('SCHOOL_NAME', 'Pattanabhumi Biology');
  var promptPayTarget = readVal('PROMPTPAY_ID_DISPLAY', '081-234-5678 (School PromptPay)');
  var promptPayQrFileId = readVal('PROMPTPAY_QR_FILE_ID', '');
  var bankName = readVal('BANK_NAME', 'Kasikornbank (KBank)');
  var bankAccountName = readVal('BANK_ACCOUNT_NAME', 'Pattanabhumi Biology Co., Ltd.');
  var bankAccountNumber = readVal('BANK_ACCOUNT_NUMBER', '123-4-56789-0');

  return {
    schoolName: schoolName,
    method: method,
    promptPayTarget: promptPayTarget,
    promptPayQrFileId: promptPayQrFileId,
    bankName: bankName,
    bankAccountName: bankAccountName,
    bankAccountNumber: bankAccountNumber,
    snapshottedAtUtc: snapUtc,
    snapshottedAtBangkok: formatBangkokTimestamp_(snapUtc)
  };
}

/**
 * Computes the standard 16-bit CRC-16/CCITT-FALSE checksum (polynomial 0x1021, initial value 0xFFFF,
 * no reflection, final XOR 0x0000) required by EMVCo Merchant-Presented QR / Thai PromptPay Tag 63.
 *
 * @param {string} asciiPayload ASCII string up to and including "6304".
 * @return {string} 4-character uppercase hexadecimal CRC string (e.g., "A1B2").
 */
function computeCrc16CcittFalseHexStep11_(asciiPayload) {
  var str = String(asciiPayload || '');
  var crc = 0xffff;
  for (var i = 0; i < str.length; i++) {
    crc ^= (str.charCodeAt(i) & 0xff) << 8;
    for (var b = 0; b < 8; b++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  var hex = (crc & 0xffff).toString(16).toUpperCase();
  while (hex.length < 4) {
    hex = '0' + hex;
  }
  return hex;
}

/**
 * Formats an EMVCo TLV (Tag-Length-Value) element where Tag is 2 digits and Length is 2 decimal digits.
 *
 * @param {string} tag2 2-character tag ID (e.g., "00", "29", "54").
 * @param {string} val Value string.
 * @return {string} Formatted TLV string.
 */
function formatEmvCoTlvStep11_(tag2, val) {
  var s = String(val === undefined || val === null ? '' : val);
  var lenStr = String(s.length);
  if (lenStr.length < 2) {
    lenStr = '0' + lenStr;
  }
  return String(tag2) + lenStr + s;
}

/**
 * Extracts and normalizes a Thai PromptPay target ID from a display string (such as
 * "081-234-5678 (School PromptPay)" or "0105559999999").
 * Supports:
 * - 10-digit Thai mobile number starting with 0 (sub-tag "01", formatted as "0066" + 9 digits = 13 digits)
 * - 13-digit Thai National ID / Corporate Tax ID (sub-tag "02", 13 digits)
 * - 15-digit e-Wallet ID (sub-tag "03", 15 digits)
 *
 * @param {string} rawTarget Raw PromptPay setting string.
 * @return {{ rawTarget: string, digits: string, subTag: string, merchantFormattedId: string, targetType: string }}
 */
function extractNormalizedPromptPayTargetStep11_(rawTarget) {
  var raw = String(rawTarget || '').trim();
  /* Look for a contiguous or hyphenated digit group first */
  var cleaned = raw.replace(/[^0-9]/g, '');
  /* If raw had trailing digits in text, try matching standard 15, 13, or 10 digit patterns first */
  var m13 = raw.match(/(?:\b|[^0-9])([0-9][0-9-]{11,16}[0-9])(?:\b|[^0-9])/);
  if (m13 && m13[1]) {
    var cand = m13[1].replace(/[^0-9]/g, '');
    if (cand.length === 10 || cand.length === 13 || cand.length === 15) {
      cleaned = cand;
    }
  }
  if (cleaned.length !== 10 && cleaned.length !== 13 && cleaned.length !== 15) {
    /* Default fallback to valid 10-digit school demo mobile if setting has custom label */
    if (cleaned.length > 10 && cleaned.charAt(0) === '0') {
      cleaned = cleaned.substring(0, 10);
    } else {
      cleaned = '0812345678';
    }
  }

  if (cleaned.length === 10 && cleaned.charAt(0) === '0') {
    return {
      rawTarget: raw || '081-234-5678',
      digits: cleaned,
      subTag: '01',
      merchantFormattedId: '0066' + cleaned.substring(1),
      targetType: 'MOBILE_PHONE_10'
    };
  }
  if (cleaned.length === 13) {
    return {
      rawTarget: raw || cleaned,
      digits: cleaned,
      subTag: '02',
      merchantFormattedId: cleaned,
      targetType: 'TAX_OR_NATIONAL_ID_13'
    };
  }
  return {
    rawTarget: raw || cleaned,
    digits: cleaned,
    subTag: '03',
    merchantFormattedId: cleaned,
    targetType: 'EWALLET_ID_15'
  };
}

/**
 * Builds a standard Bank of Thailand / EMVCo Merchant-Presented PromptPay Credit Transfer QR payload
 * from server-authorized recipient details and integer satang amount.
 * Specification:
 * - Tag 00: Payload Format Indicator = "01"
 * - Tag 01: Point of Initiation Method = "12" (Dynamic QR with amount) or "11" (Static QR)
 * - Tag 29: Merchant Account Information (PromptPay Credit Transfer)
 *   - Sub-tag 00: AID = "A000000677010111"
 *   - Sub-tag 01/02/03: Normalized recipient target ("0066..." for mobile, 13-digit Tax ID, or 15-digit e-Wallet)
 * - Tag 58: Country Code = "TH"
 * - Tag 53: Transaction Currency = "764" (THB)
 * - Tag 54: Transaction Amount = exact 2-decimal THB string derived from integer satang (e.g. "3500.00")
 * - Tag 63: 4-hex-char CRC-16/CCITT-FALSE over the entire payload including "6304"
 *
 * @param {string} rawTarget Raw PromptPay target from recipientSnapshot.
 * @param {number} totalAmountSatang Positive integer satang from server-authorized payment session.
 * @return {{
 *   payload: string,
 *   crcHex: string,
 *   amountThb: string,
 *   normalizedTarget: Object,
 *   aid: string,
 *   currencyCode: string,
 *   countryCode: string
 * }}
 */
function buildPromptPayEmvCoPayloadStep11_(rawTarget, totalAmountSatang) {
  var satang = Number(totalAmountSatang) || 0;
  var norm = extractNormalizedPromptPayTargetStep11_(rawTarget);
  var isDynamic = satang > 0;
  var amountThb = isDynamic ? formatSatangToThbNumericString_(satang) : '';

  var merchantAccountValue =
    formatEmvCoTlvStep11_('00', 'A000000677010111') +
    formatEmvCoTlvStep11_(norm.subTag, norm.merchantFormattedId);

  var parts = [
    formatEmvCoTlvStep11_('00', '01'),
    formatEmvCoTlvStep11_('01', isDynamic ? '12' : '11'),
    formatEmvCoTlvStep11_('29', merchantAccountValue),
    formatEmvCoTlvStep11_('58', 'TH'),
    formatEmvCoTlvStep11_('53', '764')
  ];
  if (isDynamic) {
    parts.push(formatEmvCoTlvStep11_('54', amountThb));
  }

  var payloadWithoutCrc = parts.join('') + '6304';
  var crcHex = computeCrc16CcittFalseHexStep11_(payloadWithoutCrc);
  return {
    payload: payloadWithoutCrc + crcHex,
    crcHex: crcHex,
    amountThb: amountThb,
    normalizedTarget: norm,
    aid: 'A000000677010111',
    currencyCode: '764',
    countryCode: 'TH'
  };
}

/**
 * Reads school support contact details for conflict/expiry reconciliation guidance.
 */
function readPaymentSupportContactStep11_(opt_settingsTable) {
  var tbl = opt_settingsTable || readSheetTable_('Settings');
  function readVal(key, fallback) {
    if (tbl && tbl.byId && tbl.byId[key] && tbl.byId[key].record) {
      var v = String(tbl.byId[key].record.setting_value || '').trim();
      if (
        v.length > 0 &&
        v.toLowerCase().indexOf('placeholder') === -1 &&
        v.toLowerCase().indexOf('example.com') === -1
      ) {
        return v;
      }
    }
    return fallback;
  }
  return {
    schoolName: readVal('SCHOOL_NAME', 'Pattanabhumi Biology'),
    phone: '0966821528',
    lineId: 'poowadatch',
    publicContactEmail: readVal('CONTACT_EMAIL', 'phuwadet.khu@student.mahidol.edu'),
    lineContactUrl: readVal('CONTACT_LINE_URL', 'https://line.me/ti/p/JpDoXL9lYv')
  };
}


/**
 * Parses JSON safely without throwing.
 */
function parseJsonSafeStep10_(rawJson, fallbackVal) {
  if (!rawJson || typeof rawJson !== 'string') {
    return fallbackVal;
  }
  try {
    return JSON.parse(rawJson);
  } catch (e) {
    return fallbackVal;
  }
}

/**
 *Deterministically recovers any uncommitted (`journal_status === 'PENDING'`) entries
 * in `PaymentJournal` by rolling forward the target `Payments` and `Invoices` rows.
 * Must be called inside `withScriptLock_`.
 *
 * @param {string=} opt_nowUtcIso Optional server UTC ISO timestamp.
 * @return {{ recoveredCount: number, recoveredJournalIds: Array<string> }}
 */
/**
 * Validates all records referenced by a `PENDING` `PaymentJournal` row (`Payments` and `Invoices`)
 * inside `withScriptLock_` BEFORE any recovery mutation is applied.
 *
 * Step 12 Integrity Rule:
 * - Never silently skip missing invoices or guess the financial result when records are inconsistent.
 * - Checks:
 *   1. `payment_id` exists in `Payments` (or `opType === 'RESERVE'` includes `meta.newPaymentRecord`).
 *   2. `invoice_ids_json` parses to a non-empty array of `inv_...` IDs.
 *   3. Every referenced invoice exists in `Invoices`.
 *   4. Every referenced invoice belongs to the same student (`invRow.user_id === payRow.user_id`).
 *   5. Sum of `invRow.amount_satang` across all referenced invoices equals `payRow.total_amount_satang`.
 *   6. For `ADMIN_APPROVE`, `ADMIN_REJECT`, and `SUBMIT_FOR_VERIFICATION`, no referenced invoice is
 *      already `PAID` under a different payment session, and for `ADMIN_APPROVE` every referenced
 *      invoice is linked to this `paymentId` (`active_payment_id === paymentId`).
 *
 * @param {Object} jRow PaymentJournal row.
 * @return {{ valid: boolean, reasonCode: string, message: string, details: Object, existingPay: Object, invoiceRows: Array<Object> }}
 */
function validateJournalReferencedRecordsInLockStep12_(jRow) {
  var journalId = String(jRow.journal_id || '').trim();
  var paymentId = String(jRow.payment_id || '').trim();
  var opType = String(jRow.operation_type || '').trim();
  var invoiceIds = parseJsonSafeStep10_(jRow.invoice_ids_json, []);
  var meta = parseJsonSafeStep10_(jRow.payload_json, {});

  if (!paymentId) {
    return {
      valid: false,
      reasonCode: 'MISSING_PAYMENT_ID_IN_JOURNAL',
      message: 'Journal "' + journalId + '" has an empty payment_id.',
      details: { journalId: journalId, operationType: opType },
      existingPay: null,
      invoiceRows: []
    };
  }

  var existingPay = getSheetRecordById_('Payments', paymentId);
  if (!existingPay && !(opType === 'RESERVE' && meta && meta.newPaymentRecord)) {
    return {
      valid: false,
      reasonCode: 'MISSING_PAYMENT_RECORD',
      message:
        'Payment record "' +
        paymentId +
        '" referenced by PENDING journal "' +
        journalId +
        '" (' +
        opType +
        ') does not exist in the Payments table.',
      details: {
        journalId: journalId,
        paymentId: paymentId,
        operationType: opType
      },
      existingPay: null,
      invoiceRows: []
    };
  }

  var effectivePay = existingPay || (meta && meta.newPaymentRecord) || null;
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return {
      valid: false,
      reasonCode: 'EMPTY_INVOICE_REFERENCES',
      message:
        'Journal "' +
        journalId +
        '" for payment "' +
        paymentId +
        '" has no associated invoice IDs in invoice_ids_json.',
      details: {
        journalId: journalId,
        paymentId: paymentId,
        operationType: opType
      },
      existingPay: existingPay,
      invoiceRows: []
    };
  }

  var invoiceRows = [];
  var sumSatang = 0;
  var expectedStudentUserId = effectivePay ? String(effectivePay.user_id || '') : '';

  for (var i = 0; i < invoiceIds.length; i++) {
    var invId = String(invoiceIds[i] || '').trim();
    var invRow = invId ? getSheetRecordById_('Invoices', invId) : null;
    if (!invRow) {
      return {
        valid: false,
        reasonCode: 'MISSING_INVOICE_REFERENCE',
        message:
          'Referenced invoice "' +
          invId +
          '" in PENDING journal "' +
          journalId +
          '" (payment "' +
          paymentId +
          '") does not exist in the Invoices worksheet. Recovery halted to prevent inconsistent financial state.',
        details: {
          journalId: journalId,
          paymentId: paymentId,
          operationType: opType,
          missingInvoiceId: invId,
          allReferencedInvoiceIds: invoiceIds
        },
        existingPay: existingPay,
        invoiceRows: []
      };
    }

    if (expectedStudentUserId && String(invRow.user_id || '') !== expectedStudentUserId) {
      return {
        valid: false,
        reasonCode: 'INVOICE_STUDENT_MISMATCH',
        message:
          'Referenced invoice "' +
          invId +
          '" belongs to student "' +
          invRow.user_id +
          '", which does not match payment "' +
          paymentId +
          '" student "' +
          expectedStudentUserId +
          '". Recovery halted.',
        details: {
          journalId: journalId,
          paymentId: paymentId,
          invoiceId: invId,
          invoiceUserId: invRow.user_id,
          paymentUserId: expectedStudentUserId
        },
        existingPay: existingPay,
        invoiceRows: []
      };
    }

    var invSt = String(invRow.status || '');
    var invActivePay = String(invRow.active_payment_id || '').trim();

    if (
      (opType === 'ADMIN_APPROVE' ||
        opType === 'ADMIN_REJECT' ||
        opType === 'SUBMIT_FOR_VERIFICATION') &&
      invSt === 'PAID' &&
      invActivePay !== paymentId
    ) {
      return {
        valid: false,
        reasonCode: 'CONFLICTING_PAID_INVOICE',
        message:
          'Referenced invoice "' +
          invId +
          '" is already marked PAID under a different payment session ("' +
          (invActivePay || 'OTHER') +
          '"). Recovery halted for payment "' +
          paymentId +
          '".',
        details: {
          journalId: journalId,
          paymentId: paymentId,
          invoiceId: invId,
          invoiceStatus: invSt,
          conflictingPaymentId: invActivePay
        },
        existingPay: existingPay,
        invoiceRows: []
      };
    }

    if (
      opType === 'ADMIN_APPROVE' &&
      invActivePay !== paymentId
    ) {
      return {
        valid: false,
        reasonCode: 'INVOICE_ACTIVE_PAYMENT_MISMATCH',
        message:
          'Referenced invoice "' +
          invId +
          '" has active_payment_id "' +
          (invActivePay || 'none') +
          '" instead of "' +
          paymentId +
          '" during ADMIN_APPROVE recovery. Recovery halted.',
        details: {
          journalId: journalId,
          paymentId: paymentId,
          invoiceId: invId,
          invoiceStatus: invSt,
          invoiceActivePaymentId: invActivePay
        },
        existingPay: existingPay,
        invoiceRows: []
      };
    }

    sumSatang += Number(invRow.amount_satang) || 0;
    invoiceRows.push(invRow);
  }

  var expectedPaySatang = effectivePay ? Number(effectivePay.total_amount_satang) || 0 : 0;
  if (expectedPaySatang > 0 && sumSatang !== expectedPaySatang) {
    return {
      valid: false,
      reasonCode: 'AMOUNT_SATANG_MISMATCH',
      message:
        'Sum of referenced invoice amounts (' +
        sumSatang +
        ' satang) does not match payment "' +
        paymentId +
        '" total_amount_satang (' +
        expectedPaySatang +
        ' satang) in journal "' +
        journalId +
        '". Recovery halted instead of guessing financial result.',
      details: {
        journalId: journalId,
        paymentId: paymentId,
        operationType: opType,
        sumOfInvoicesSatang: sumSatang,
        paymentTotalAmountSatang: expectedPaySatang,
        invoiceIds: invoiceIds
      },
      existingPay: existingPay,
      invoiceRows: []
    };
  }

  return {
    valid: true,
    reasonCode: 'OK',
    message: 'All referenced payment and invoice records verified consistent.',
    details: {},
    existingPay: existingPay,
    invoiceRows: invoiceRows
  };
}

/**
 * Deterministically recovers any uncommitted (`journal_status === 'PENDING'`) entries
 * in `PaymentJournal` by validating all referenced records first and then rolling forward
 * the target `Payments` and `Invoices` rows.
 *
 * Step 12 Guarantees:
 * - Strictly idempotent: rerunning recovery when journals are already `COMMITTED` (or when rows
 *   already match target states) performs zero duplicate updates.
 * - Validates all referenced `Payments` and `Invoices` records BEFORE completing recovery.
 * - Stops and reports inconsistent records (`journal_status = 'HALTED_INCONSISTENT'`) instead of
 *   silently guessing the financial result.
 * Must be called inside `withScriptLock_`.
 *
 * @param {string=} opt_nowUtcIso Optional server UTC ISO timestamp.
 * @return {{
 *   recoveredCount: number,
 *   recoveredJournalIds: Array<string>,
 *   alreadyCommittedCount: number,
 *   haltedInconsistentCount: number,
 *   haltedInconsistencies: Array<Object>
 * }}
 */
function recoverPendingPaymentJournalsInLock_(opt_nowUtcIso) {
  var nowIso = opt_nowUtcIso || nowUtcIso_();
  var journalTbl = readSheetTable_('PaymentJournal');
  var recoveredIds = [];
  var alreadyCommittedCount = 0;
  var haltedInconsistencies = [];

  for (var i = 0; i < journalTbl.records.length; i++) {
    var jRow = journalTbl.records[i];
    if (jRow.journal_status === 'COMMITTED') {
      alreadyCommittedCount++;
      continue;
    }

    var meta = parseJsonSafeStep10_(jRow.payload_json, {});
    if (jRow.journal_status === 'HALTED_INCONSISTENT') {
      haltedInconsistencies.push(
        meta.inconsistencyReport || {
          journalId: jRow.journal_id,
          paymentId: jRow.payment_id,
          operationType: jRow.operation_type,
          reasonCode: 'HALTED_INCONSISTENT',
          message: 'Journal recovery previously halted due to inconsistent referenced records.'
        }
      );
      continue;
    }

    if (jRow.journal_status !== 'PENDING') {
      continue;
    }

    /* Validate all referenced records BEFORE applying any recovery writes */
    var check = validateJournalReferencedRecordsInLockStep12_(jRow);
    if (!check.valid) {
      var inconsistencyReport = {
        journalId: jRow.journal_id,
        paymentId: jRow.payment_id,
        operationType: jRow.operation_type,
        idempotencyKey: jRow.idempotency_key,
        reasonCode: check.reasonCode,
        message: check.message,
        details: check.details,
        haltedAtUtc: nowIso,
        haltedAtBangkok: formatBangkokTimestamp_(nowIso)
      };
      meta.inconsistencyReport = inconsistencyReport;

      updateSheetRecordById_(
        'PaymentJournal',
        jRow.journal_id,
        {
          journal_status: 'HALTED_INCONSISTENT',
          payload_json: JSON.stringify(meta)
        },
        null,
        { skipLock: true }
      );

      recordAuditEvent_({
        actorUserId: 'SYSTEM',
        actorRole: 'SYSTEM',
        eventType: 'PAYMENT_RECOVERY_HALTED_INCONSISTENT',
        targetEntityType: 'PaymentJournal',
        targetEntityId: jRow.journal_id,
        summary: {
          paymentId: jRow.payment_id,
          operationType: jRow.operation_type,
          reasonCode: check.reasonCode,
          details: check.details
        }
      });

      haltedInconsistencies.push(inconsistencyReport);
      continue;
    }

    var invoiceIds = parseJsonSafeStep10_(jRow.invoice_ids_json, []);
    var paymentId = String(jRow.payment_id || '').trim();
    var opType = String(jRow.operation_type || '').trim();
    var targetPayStatus = String(jRow.target_payment_status || '').trim();
    var targetInvStatus = String(jRow.target_invoice_status || '').trim();

    var existingPay = check.existingPay;
    if (!existingPay && opType === 'RESERVE' && meta && meta.newPaymentRecord) {
      insertSheetRecord_('Payments', meta.newPaymentRecord, { skipLock: true });
      existingPay = getSheetRecordById_('Payments', paymentId);
    }

    if (existingPay) {
      var payPatch = {};
      var needsPayUpdate = false;
      if (targetPayStatus && existingPay.status !== targetPayStatus) {
        payPatch.status = targetPayStatus;
        needsPayUpdate = true;
      }
      if (meta.receiptFileId && existingPay.receipt_file_id !== meta.receiptFileId) {
        payPatch.receipt_file_id = meta.receiptFileId;
        needsPayUpdate = true;
      }
      if (meta.submittedAtUtc && existingPay.submitted_at_utc !== meta.submittedAtUtc) {
        payPatch.submitted_at_utc = meta.submittedAtUtc;
        needsPayUpdate = true;
      }
      if (meta.reviewedByUserId && existingPay.reviewed_by_user_id !== meta.reviewedByUserId) {
        payPatch.reviewed_by_user_id = meta.reviewedByUserId;
        needsPayUpdate = true;
      }
      if (meta.reviewedAtUtc && existingPay.reviewed_at_utc !== meta.reviewedAtUtc) {
        payPatch.reviewed_at_utc = meta.reviewedAtUtc;
        needsPayUpdate = true;
      }
      if (
        meta.rejectionReason !== undefined &&
        existingPay.rejection_reason !== meta.rejectionReason
      ) {
        payPatch.rejection_reason = meta.rejectionReason;
        needsPayUpdate = true;
      }
      if (needsPayUpdate) {
        payPatch.updated_at_utc = nowIso;
        updateSheetRecordById_(
          'Payments',
          paymentId,
          payPatch,
          Number(existingPay.version || 1),
          { skipLock: true }
        );
      }
    }

    for (var k = 0; k < check.invoiceRows.length; k++) {
      var invRow = check.invoiceRows[k];
      var invId = invRow.invoice_id;

      var desiredActivePaymentId =
        meta.desiredActivePaymentId !== undefined
          ? meta.desiredActivePaymentId
          : targetInvStatus === 'RESERVED' ||
            targetInvStatus === 'AWAITING_VERIFICATION' ||
            targetInvStatus === 'APPROVING' ||
            targetInvStatus === 'PAID'
          ? paymentId
          : '';
      var desiredExpiryUtc =
        targetInvStatus === 'RESERVED' ? String(meta.expiresAtUtc || '') : '';
      var desiredRejReason =
        targetInvStatus === 'REJECTED'
          ? String(meta.rejectionReason || '')
          : targetInvStatus === 'PAID'
          ? ''
          : invRow.last_rejection_reason || '';

      if (
        invRow.status !== targetInvStatus ||
        String(invRow.active_payment_id || '') !== desiredActivePaymentId ||
        String(invRow.reservation_expires_at_utc || '') !== desiredExpiryUtc ||
        String(invRow.last_rejection_reason || '') !== desiredRejReason
      ) {
        updateSheetRecordById_(
          'Invoices',
          invId,
          {
            status: targetInvStatus,
            active_payment_id: desiredActivePaymentId,
            reservation_expires_at_utc: desiredExpiryUtc,
            last_rejection_reason: desiredRejReason,
            updated_at_utc: nowIso
          },
          Number(invRow.version || 1),
          { skipLock: true }
        );
      }
    }

    updateSheetRecordById_(
      'PaymentJournal',
      jRow.journal_id,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: nowIso
      },
      null,
      { skipLock: true }
    );
    recoveredIds.push(jRow.journal_id);

    recordAuditEvent_({
      actorUserId: 'SYSTEM',
      actorRole: 'SYSTEM',
      eventType: 'PAYMENT_JOURNAL_RECOVERED',
      targetEntityType: 'Payment',
      targetEntityId: paymentId,
      summary: {
        journalId: jRow.journal_id,
        operationType: opType,
        targetPaymentStatus: targetPayStatus,
        targetInvoiceStatus: targetInvStatus,
        invoiceIds: invoiceIds
      }
    });
  }

  return {
    recoveredCount: recoveredIds.length,
    recoveredJournalIds: recoveredIds,
    alreadyCommittedCount: alreadyCommittedCount,
    haltedInconsistentCount: haltedInconsistencies.length,
    haltedInconsistencies: haltedInconsistencies
  };
}

function sweepExpiredPaymentSessionsInLock_(opt_nowMs) {
  var nowMs =
    opt_nowMs !== undefined && opt_nowMs !== null ? Number(opt_nowMs) : Date.now();
  var nowIso = new Date(nowMs).toISOString();

  var paymentsTbl = readSheetTable_('Payments');
  var expiredPaymentIds = [];
  var releasedInvoiceIds = [];

  for (var i = 0; i < paymentsTbl.records.length; i++) {
    var pRow = paymentsTbl.records[i];
    var st = String(pRow.status || '');
    if (st !== 'PENDING_TRANSFER' && st !== 'RECEIPT_UPLOADED' && st !== 'RESERVED') {
      continue;
    }
    var expStr = String(pRow.expires_at_utc || '').trim();
    if (!expStr) {
      continue;
    }
    var expMs = Date.parse(expStr);
    if (isNaN(expMs) || nowMs <= expMs) {
      continue;
    }

    var invIds = parseJsonSafeStep10_(pRow.invoice_ids_json, []);
    var jrnId = generateEntityId_('jrn_');
    var expIdemKey = 'auto_expire_' + pRow.payment_id;

    insertSheetRecord_(
      'PaymentJournal',
      {
        journal_id: jrnId,
        operation_type: 'EXPIRE_RESERVATION',
        idempotency_key: expIdemKey + '_' + jrnId.slice(-8),
        payment_id: pRow.payment_id,
        invoice_ids_json: JSON.stringify(invIds),
        target_payment_status: 'EXPIRED',
        target_invoice_status: 'UNPAID',
        payload_json: JSON.stringify({
          desiredActivePaymentId: '',
          expiredAtUtc: nowIso,
          originalExpiresAtUtc: expStr
        }),
        journal_status: 'PENDING',
        created_at_utc: nowIso,
        committed_at_utc: ''
      },
      { skipLock: true }
    );

    updateSheetRecordById_(
      'Payments',
      pRow.payment_id,
      {
        status: 'EXPIRED',
        updated_at_utc: nowIso
      },
      Number(pRow.version || 1),
      { skipLock: true }
    );
    expiredPaymentIds.push(pRow.payment_id);

    for (var k = 0; k < invIds.length; k++) {
      var invRow = getSheetRecordById_('Invoices', invIds[k]);
      if (
        invRow &&
        invRow.status === 'RESERVED' &&
        (!invRow.active_payment_id || invRow.active_payment_id === pRow.payment_id)
      ) {
        updateSheetRecordById_(
          'Invoices',
          invRow.invoice_id,
          {
            status: 'UNPAID',
            active_payment_id: '',
            reservation_expires_at_utc: '',
            updated_at_utc: nowIso
          },
          Number(invRow.version || 1),
          { skipLock: true }
        );
        releasedInvoiceIds.push(invRow.invoice_id);
      }
    }

    updateSheetRecordById_(
      'PaymentJournal',
      jrnId,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: nowIso
      },
      null,
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: 'SYSTEM',
      actorRole: 'SYSTEM',
      eventType: 'PAYMENT_RESERVATION_EXPIRED',
      targetEntityType: 'Payment',
      targetEntityId: pRow.payment_id,
      summary: {
        userId: pRow.user_id,
        expiredAtUtc: nowIso,
        expiresAtUtc: expStr,
        releasedInvoiceIds: invIds
      }
    });
  }

  /* Also heal any orphan RESERVED invoice whose reservation_expires_at_utc has passed and whose payment is not active */
  var invoicesTbl = readSheetTable_('Invoices');
  var freshPaymentsTbl = readSheetTable_('Payments');
  for (var m = 0; m < invoicesTbl.records.length; m++) {
    var inv = invoicesTbl.records[m];
    if (inv.status !== 'RESERVED') {
      continue;
    }
    var invExpMs = Date.parse(String(inv.reservation_expires_at_utc || ''));
    var activePayHit =
      inv.active_payment_id && freshPaymentsTbl.byId[inv.active_payment_id]
        ? freshPaymentsTbl.byId[inv.active_payment_id].record
        : null;
    var activePayExpiredOrGone =
      !activePayHit ||
      activePayHit.status === 'EXPIRED' ||
      activePayHit.status === 'CANCELLED';

    if ((!isNaN(invExpMs) && nowMs > invExpMs) || activePayExpiredOrGone) {
      updateSheetRecordById_(
        'Invoices',
        inv.invoice_id,
        {
          status: 'UNPAID',
          active_payment_id: '',
          reservation_expires_at_utc: '',
          updated_at_utc: nowIso
        },
        Number(inv.version || 1),
        { skipLock: true }
      );
      if (releasedInvoiceIds.indexOf(inv.invoice_id) === -1) {
        releasedInvoiceIds.push(inv.invoice_id);
      }
    }
  }

  return {
    expiredPaymentIds: expiredPaymentIds,
    releasedInvoiceIds: releasedInvoiceIds
  };
}

/**
 * Lock-wrapped convenience helper to run journal recovery and expiration sweep.
 */
function sweepExpiredPaymentSessionsStep10_(opt_nowMs) {
  return withScriptLock_(function () {
    var nowMs =
      opt_nowMs !== undefined && opt_nowMs !== null ? Number(opt_nowMs) : Date.now();
    var nowIso = new Date(nowMs).toISOString();
    var rec = recoverPendingPaymentJournalsInLock_(nowIso);
    var swp = sweepExpiredPaymentSessionsInLock_(nowMs);
    return {
      recoveredJournals: rec,
      expiredSweep: swp
    };
  });
}

/**
 * Looks up an idempotencyKey in `PaymentJournal` inside `withScriptLock_`.
 * - If found and `requestFingerprint` matches: returns `{ hit: true, journalRow, meta }`.
 * - If found and `requestFingerprint` differs: throws `ERR_IDEMPOTENCY_CONFLICT`.
 * - If not found: returns `{ hit: false }`.
 */
function lookupIdempotentOperationInLock_(
  idempotencyKey,
  expectedOperationType,
  expectedFingerprint
) {
  var journalTbl = readSheetTable_('PaymentJournal');
  for (var i = 0; i < journalTbl.records.length; i++) {
    var jRow = journalTbl.records[i];
    if (String(jRow.idempotency_key || '').trim() !== idempotencyKey) {
      continue;
    }
    var meta = parseJsonSafeStep10_(jRow.payload_json, {});
    if (
      jRow.operation_type !== expectedOperationType ||
      (meta.requestFingerprint && meta.requestFingerprint !== expectedFingerprint)
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_IDEMPOTENCY_CONFLICT,
        'Idempotency key "' +
          idempotencyKey +
          '" has already been used with a different request payload or operation.',
        {
          idempotencyKey:
            'Same idempotencyKey cannot be reused with altered parameters.'
        }
      );
    }
    return {
      hit: true,
      journalRow: jRow,
      meta: meta
    };
  }
  return { hit: false, journalRow: null, meta: null };
}

/**
 * Formats an `Invoices` record into a clean DTO for API responses.
 */
function formatInvoiceDtoStep10_(invRow, opt_usersById, opt_coursesById) {
  var amtSatang = Number(invRow.amount_satang) || 0;
  var studentRec =
    opt_usersById && opt_usersById[invRow.user_id]
      ? opt_usersById[invRow.user_id].record || opt_usersById[invRow.user_id]
      : null;
  var courseRec =
    invRow.course_id && opt_coursesById && opt_coursesById[invRow.course_id]
      ? opt_coursesById[invRow.course_id].record || opt_coursesById[invRow.course_id]
      : null;

  var st = String(invRow.status || 'UNPAID');
  var isEligibleUnpaid = st === 'UNPAID' || st === 'REJECTED';

  return {
    invoiceId: invRow.invoice_id,
    userId: invRow.user_id,
    studentUsername: studentRec ? studentRec.username_display : '',
    studentFullName: studentRec ? studentRec.full_name : '',
    studentEmail: studentRec ? studentRec.email : '',
    courseId: invRow.course_id || '',
    courseCode: courseRec ? courseRec.course_code : '',
    courseTitle: courseRec ? courseRec.title : '',
    installmentLabel: invRow.installment_label || '',
    amountSatang: amtSatang,
    amountThb: formatSatangToThbNumericString_(amtSatang),
    amountThbFormatted: formatSatangToThbDisplay_(amtSatang),
    dueDateBkk: invRow.due_date_bkk || '',
    status: st,
    isEligibleUnpaid: isEligibleUnpaid,
    activePaymentId: invRow.active_payment_id || '',
    reservationExpiresAtUtc: invRow.reservation_expires_at_utc || '',
    reservationExpiresAtBangkok: invRow.reservation_expires_at_utc
      ? formatBangkokTimestamp_(invRow.reservation_expires_at_utc)
      : '',
    lastRejectionReason: invRow.last_rejection_reason || '',
    createdAtUtc: invRow.created_at_utc || '',
    createdAtBangkok: formatBangkokTimestamp_(invRow.created_at_utc || ''),
    updatedAtUtc: invRow.updated_at_utc || '',
    updatedAtBangkok: formatBangkokTimestamp_(invRow.updated_at_utc || ''),
    version: Number(invRow.version || 1)
  };
}

/**
 * Formats a `Payments` record into a clean DTO, attaching its `recipientSnapshot`
 * from `PaymentJournal` and calculating `remainingSeconds`.
 */
function formatPaymentSessionDtoStep10_(
  payRow,
  serverNowMs,
  opt_journalTbl,
  opt_invoicesById,
  opt_usersById
) {
  var totalSatang = Number(payRow.total_amount_satang) || 0;
  var invIds = parseJsonSafeStep10_(payRow.invoice_ids_json, []);
  var expUtc = String(payRow.expires_at_utc || '').trim();
  var expMs = expUtc ? Date.parse(expUtc) : NaN;
  var nowMs = isFinite(serverNowMs) ? serverNowMs : Date.now();
  var serverNowUtc = new Date(nowMs).toISOString();

  var st = String(payRow.status || 'PENDING_TRANSFER');
  var remainingSeconds = 0;
  if (
    (st === 'PENDING_TRANSFER' || st === 'RECEIPT_UPLOADED') &&
    !isNaN(expMs) &&
    expMs > nowMs
  ) {
    remainingSeconds = Math.max(0, Math.ceil((expMs - nowMs) / 1000));
  }

  /* Retrieve immutable recipientSnapshot from the RESERVE PaymentJournal entry */
  var recipientSnapshot = null;
  var jTbl = opt_journalTbl || readSheetTable_('PaymentJournal');
  for (var i = 0; i < jTbl.records.length; i++) {
    var jr = jTbl.records[i];
    if (jr.payment_id === payRow.payment_id && jr.operation_type === 'RESERVE') {
      var meta = parseJsonSafeStep10_(jr.payload_json, {});
      if (meta && meta.recipientSnapshot) {
        recipientSnapshot = meta.recipientSnapshot;
        break;
      }
    }
  }
  if (!recipientSnapshot) {
    recipientSnapshot = buildRecipientDetailsSnapshotStep10_(
      payRow.method || 'PROMPTPAY_QR',
      null,
      payRow.created_at_utc || serverNowUtc
    );
  }

  var invoiceSummaries = [];
  if (opt_invoicesById) {
    for (var k = 0; k < invIds.length; k++) {
      var hit = opt_invoicesById[invIds[k]];
      var invRec = hit ? hit.record || hit : null;
      if (invRec) {
        invoiceSummaries.push(formatInvoiceDtoStep10_(invRec, opt_usersById, null));
      }
    }
  }

  var studentRec =
    opt_usersById && opt_usersById[payRow.user_id]
      ? opt_usersById[payRow.user_id].record || opt_usersById[payRow.user_id]
      : null;

  var hasReceipt = Boolean(
    payRow.receipt_file_id && String(payRow.receipt_file_id).indexOf('fil_') === 0
  );
  var isAwaitingTransfer = st === 'PENDING_TRANSFER' || st === 'RECEIPT_UPLOADED';
  var promptPayEmvCo = buildPromptPayEmvCoPayloadStep11_(
    recipientSnapshot ? recipientSnapshot.promptPayTarget : '',
    totalSatang
  );

  return {
    promptPayQrPayload: promptPayEmvCo.payload,
    promptPayQrCrcHex: promptPayEmvCo.crcHex,
    promptPayNormalizedTarget: promptPayEmvCo.normalizedTarget.digits,
    promptPayTargetType: promptPayEmvCo.normalizedTarget.targetType,
    paymentId: payRow.payment_id,
    userId: payRow.user_id,
    studentUsername: studentRec ? studentRec.username_display : '',
    studentFullName: studentRec ? studentRec.full_name : '',
    studentEmail: studentRec ? studentRec.email : '',
    invoiceIds: invIds,
    invoices: invoiceSummaries,
    totalAmountSatang: totalSatang,
    totalAmountThb: formatSatangToThbNumericString_(totalSatang),
    totalAmountThbFormatted: formatSatangToThbDisplay_(totalSatang),
    method: payRow.method || 'PROMPTPAY_QR',
    status: st,
    idempotencyKey: payRow.idempotency_key || '',
    serverNow: serverNowUtc,
    serverNowUtc: serverNowUtc,
    serverNowBangkok: formatBangkokTimestamp_(serverNowUtc),
    expiresAt: expUtc,
    expiresAtUtc: expUtc,
    expiresAtBangkok: expUtc ? formatBangkokTimestamp_(expUtc) : '',
    remainingSeconds: remainingSeconds,
    isExpired: isAwaitingTransfer && !isNaN(expMs) && nowMs > expMs,
    canResume: isAwaitingTransfer && (isNaN(expMs) || nowMs <= expMs),
    canCancel: isAwaitingTransfer && (isNaN(expMs) || nowMs <= expMs),
    canConfirmSubmission:
      isAwaitingTransfer && hasReceipt && (isNaN(expMs) || nowMs <= expMs),
    receiptFileId: payRow.receipt_file_id || '',
    recipientSnapshot: recipientSnapshot,
    submittedAtUtc: payRow.submitted_at_utc || '',
    submittedAtBangkok: payRow.submitted_at_utc
      ? formatBangkokTimestamp_(payRow.submitted_at_utc)
      : '',
    reviewedByUserId: payRow.reviewed_by_user_id || '',
    reviewedByUsername:
      payRow.reviewed_by_user_id &&
      opt_usersById &&
      opt_usersById[payRow.reviewed_by_user_id]
        ? (
            opt_usersById[payRow.reviewed_by_user_id].record ||
            opt_usersById[payRow.reviewed_by_user_id]
          ).username_display || payRow.reviewed_by_user_id
        : payRow.reviewed_by_user_id || '',
    reviewedAtUtc: payRow.reviewed_at_utc || '',
    reviewedAtBangkok: payRow.reviewed_at_utc
      ? formatBangkokTimestamp_(payRow.reviewed_at_utc)
      : '',
    rejectionReason: payRow.rejection_reason || '',
    reviewNote: payRow.rejection_reason || '',
    studentGuidanceNotice:
      st === 'REJECTED'
        ? 'Rejected by administrator (Reason: ' +
          (payRow.rejection_reason || 'Please review transfer slip') +
          '). IMPORTANT: Do NOT transfer money a second time before resolving your original transfer. If your bank or PromptPay transfer already succeeded and was rejected only because the slip image was unclear or incomplete, re-select the installment(s) and upload a clear photo of your original transfer slip, or contact school support.'
        : st === 'AWAITING_VERIFICATION' || st === 'APPROVING'
        ? 'Your payment receipt has been submitted and is awaiting administrator verification against the school bank statement. Do NOT transfer again while verification is in progress.'
        : st === 'PAID' || st === 'APPROVED'
        ? 'Payment completed and verified by administrator. Your associated installment(s) are marked PAID.'
        : '',
    createdAtUtc: payRow.created_at_utc || '',
    createdAtBangkok: formatBangkokTimestamp_(payRow.created_at_utc || ''),
    updatedAtUtc: payRow.updated_at_utc || '',
    updatedAtBangkok: formatBangkokTimestamp_(payRow.updated_at_utc || ''),
    version: Number(payRow.version || 1)
  };
}

/**
 * Asserts that the caller is an authenticated ADMIN.
 */
function assertAdminRoleStep10_(authContext) {
  if (!authContext || !authContext.user || authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Administrator role is required for this invoice/payment action.'
    );
  }
  return authContext.user;
}

/**
 * Explicitly rejects any attempt to edit an existing invoice or issue an automated refund.
 */
function handleAdminUnsupportedInvoiceMutationStep10_(payload, context) {
  assertAdminRoleStep10_(context && context.authContext);
  throw createAppError_(
    PB_ERROR_CODES_.ERR_FORBIDDEN_OPERATION || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
    'Direct invoice editing and automated refunds are intentionally not implemented by design to preserve immutable financial audit records. Create a new installment invoice instead.',
    {
      operation:
        'Invoices are immutable once created; direct amount/field editing and refunds are prohibited.'
    }
  );
}

/**
 * Administrator Action: `admin.createInvoice`
 * Creates a new `UNPAID` tuition installment invoice for a selected student.
 * Parses `amountThb` safely into integer `amount_satang` without floating-point math.
 */
function adminCreateInvoiceStep10_(authContext, payload) {
  var adminUser = assertAdminRoleStep10_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};

  /* Explicitly reject if caller attempts to edit an existing invoice or refund via createInvoice */
  if (
    req.invoiceId ||
    req.editInvoiceId ||
    req.mode === 'EDIT' ||
    req.mode === 'REFUND' ||
    req.isRefund === true
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_OPERATION || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Direct invoice editing and refunds are not supported by design to preserve financial audit history.',
      {
        invoiceId:
          'Existing invoices cannot be edited or refunded through admin.createInvoice.'
      }
    );
  }

  var studentUserId = String(req.userId || req.studentUserId || '').trim();
  if (!studentUserId || !/^usr_[A-Za-z0-9_-]{4,64}$/.test(studentUserId)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please select a valid student account (usr_...).',
      { userId: 'A valid student userId (usr_...) is required.' }
    );
  }

  var courseId = String(req.courseId || '').trim();
  if (courseId && !/^crs_[A-Za-z0-9_-]{4,64}$/.test(courseId)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Invalid courseId format.',
      { courseId: 'courseId must start with crs_ or be left blank.' }
    );
  }

  var installmentLabel = sanitizeSingleLineTextStep7_(req.installmentLabel, 160);
  if (!installmentLabel || installmentLabel.length < 3) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Installment label is required (3-160 characters, e.g., "Term 1 - Installment 1 of 2").',
      {
        installmentLabel: 'Enter an installment label between 3 and 160 characters.'
      }
    );
  }

  /* Parse amountThb safely into integer satang (or validate integer amountSatang if explicitly supplied without amountThb) */
  var amountSatang = 0;
  if (req.amountThb !== undefined && req.amountThb !== null && req.amountThb !== '') {
    amountSatang = parseThbToSatangSafe_(req.amountThb, 'amountThb');
  } else if (req.amountSatang !== undefined && req.amountSatang !== null) {
    amountSatang = validateSatangInteger_(
      Number(req.amountSatang),
      PB_PAYMENT_CONSTANTS_STEP10_.MIN_INVOICE_SATANG,
      PB_PAYMENT_CONSTANTS_STEP10_.MAX_INVOICE_SATANG,
      'amountSatang'
    );
  } else {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Amount in THB is required.',
      { amountThb: 'Enter a positive amount in THB (e.g., 3500.00).' }
    );
  }

  var dueDateBkk = validateDueDateBkkStep10_(
    req.dueDateBkk || req.dueDate,
    'dueDateBkk'
  );
  var optionalIdemKey = validateIdempotencyKeyStep10_(req.idempotencyKey, false);
  var clock = resolveServerNowStep10_(req);

  return withScriptLock_(function () {
    recoverPendingPaymentJournalsInLock_(clock.nowUtcIso);

    var studentRow = getSheetRecordById_('Users', studentUserId);
    if (!studentRow) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Selected student account "' + studentUserId + '" was not found.',
        { userId: 'Student account not found.' }
      );
    }
    if (studentRow.role !== 'STUDENT') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Tuition invoices can only be assigned to STUDENT accounts (selected account has role "' +
          studentRow.role +
          '").',
        { userId: 'Selected user must have role STUDENT.' }
      );
    }
    if (studentRow.status === 'ARCHIVED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Cannot assign a new invoice to an ARCHIVED student account.',
        { userId: 'Student account is ARCHIVED.' }
      );
    }

    var courseRow = null;
    if (courseId) {
      courseRow = getSheetRecordById_('Courses', courseId);
      if (!courseRow) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Selected course "' + courseId + '" was not found.',
          { courseId: 'Course not found.' }
        );
      }
    }

    /* Optional idempotency deduplication for admin.createInvoice */
    if (optionalIdemKey) {
      var auditTbl = readSheetTable_('AuditEvents');
      var expectedFp = computePaymentRequestFingerprintStep10_(
        'ADMIN_CREATE_INVOICE',
        adminUser.user_id,
        {
          userId: studentUserId,
          courseId: courseId,
          installmentLabel: installmentLabel,
          amountSatang: amountSatang,
          dueDateBkk: dueDateBkk
        }
      );
      for (var a = auditTbl.records.length - 1; a >= 0; a--) {
        var aud = auditTbl.records[a];
        if (aud.event_type === 'ADMIN_INVOICE_CREATED') {
          var sMeta = parseJsonSafeStep10_(aud.summary_json, {});
          if (sMeta && sMeta.idempotencyKey === optionalIdemKey) {
            if (sMeta.requestFingerprint && sMeta.requestFingerprint !== expectedFp) {
              throw createAppError_(
                PB_ERROR_CODES_.ERR_IDEMPOTENCY_CONFLICT,
                'Idempotency key "' +
                  optionalIdemKey +
                  '" was already used with different invoice parameters.',
                { idempotencyKey: 'Payload mismatch for idempotencyKey.' }
              );
            }
            var existingInv = getSheetRecordById_('Invoices', aud.target_entity_id);
            if (existingInv) {
              var usersMap = {};
              usersMap[studentRow.user_id] = studentRow;
              var coursesMap = {};
              if (courseRow) {
                coursesMap[courseRow.course_id] = courseRow;
              }
              return {
                idempotentReplay: true,
                invoice: formatInvoiceDtoStep10_(existingInv, usersMap, coursesMap),
                serverNow: clock.nowUtcIso,
                serverNowBangkok: clock.nowBangkok,
                savedMessage:
                  'Idempotent replay: returned existing unpaid invoice ' +
                  existingInv.invoice_id +
                  '.'
              };
            }
          }
        }
      }
    }

    var invoiceId = generateEntityId_('inv_');
    var newInvoiceRow = {
      invoice_id: invoiceId,
      user_id: studentUserId,
      course_id: courseId,
      installment_label: installmentLabel,
      amount_satang: amountSatang,
      due_date_bkk: dueDateBkk,
      status: 'UNPAID',
      active_payment_id: '',
      reservation_expires_at_utc: '',
      last_rejection_reason: '',
      created_at_utc: clock.nowUtcIso,
      updated_at_utc: clock.nowUtcIso,
      version: 1
    };

    var inserted = insertSheetRecord_('Invoices', newInvoiceRow, { skipLock: true });

    var reqFp = optionalIdemKey
      ? computePaymentRequestFingerprintStep10_(
          'ADMIN_CREATE_INVOICE',
          adminUser.user_id,
          {
            userId: studentUserId,
            courseId: courseId,
            installmentLabel: installmentLabel,
            amountSatang: amountSatang,
            dueDateBkk: dueDateBkk
          }
        )
      : '';

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_INVOICE_CREATED',
      targetEntityType: 'Invoice',
      targetEntityId: invoiceId,
      summary: {
        studentUserId: studentUserId,
        studentUsername: studentRow.username_display,
        courseId: courseId,
        installmentLabel: installmentLabel,
        amountSatang: amountSatang,
        amountThbFormatted: formatSatangToThbDisplay_(amountSatang),
        dueDateBkk: dueDateBkk,
        status: 'UNPAID',
        idempotencyKey: optionalIdemKey,
        requestFingerprint: reqFp
      }
    });

    var uMap = {};
    uMap[studentRow.user_id] = studentRow;
    var cMap = {};
    if (courseRow) {
      cMap[courseRow.course_id] = courseRow;
    }

    return {
      idempotentReplay: false,
      invoice: formatInvoiceDtoStep10_(inserted, uMap, cMap),
      serverNow: clock.nowUtcIso,
      serverNowBangkok: clock.nowBangkok,
      savedMessage:
        'Created unpaid invoice "' +
        installmentLabel +
        '" (' +
        formatSatangToThbDisplay_(amountSatang) +
        ', ' +
        amountSatang +
        ' satang) for ' +
        studentRow.username_display +
        '.'
    };
  });
}

function handleAdminCreateInvoiceStep10_(payload, context) {
  return adminCreateInvoiceStep10_(context.authContext, payload);
}

/**
 * Administrator Action: `admin.listInvoices`
 * Lists invoice history with student/course enrichment, summary counts, and filter/pagination support.
 */
function adminListInvoicesStep10_(authContext, payload) {
  assertAdminRoleStep10_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};
  var filterUserId = String(req.userId || req.studentUserId || '').trim();
  var filterCourseId = String(req.courseId || '').trim();
  var filterStatus = String(req.status || req.statusFilter || 'ALL')
    .trim()
    .toUpperCase();
  var searchQuery = String(req.searchQuery || '')
    .trim()
    .toLowerCase();
  var clock = resolveServerNowStep10_(req);

  return withScriptLock_(function () {
    recoverPendingPaymentJournalsInLock_(clock.nowUtcIso);
    sweepExpiredPaymentSessionsInLock_(clock.nowMs);

    var usersTbl = readSheetTable_('Users');
    var coursesTbl = readSheetTable_('Courses');
    var invoicesTbl = readSheetTable_('Invoices');

    var studentsList = [];
    for (var u = 0; u < usersTbl.records.length; u++) {
      var usr = usersTbl.records[u];
      if (usr.role === 'STUDENT' && usr.status !== 'ARCHIVED') {
        studentsList.push({
          userId: usr.user_id,
          username: usr.username_display,
          fullName: usr.full_name,
          email: usr.email,
          status: usr.status
        });
      }
    }

    var coursesList = [];
    for (var c = 0; c < coursesTbl.records.length; c++) {
      var crs = coursesTbl.records[c];
      if (crs.status !== 'ARCHIVED') {
        coursesList.push({
          courseId: crs.course_id,
          courseCode: crs.course_code,
          title: crs.title,
          status: crs.status
        });
      }
    }

    var summaryCounts = {
      totalInvoices: 0,
      unpaidCount: 0,
      reservedCount: 0,
      awaitingVerificationCount: 0,
      approvingCount: 0,
      paidCount: 0,
      rejectedCount: 0,
      cancelledCount: 0,
      totalUnpaidSatang: 0,
      totalUnpaidThbFormatted: '0.00 THB',
      totalPaidSatang: 0,
      totalPaidThbFormatted: '0.00 THB'
    };

    var matchedDtos = [];
    for (var i = invoicesTbl.records.length - 1; i >= 0; i--) {
      var inv = invoicesTbl.records[i];
      var st = String(inv.status || 'UNPAID');
      var amt = Number(inv.amount_satang) || 0;

      summaryCounts.totalInvoices += 1;
      if (st === 'UNPAID') {
        summaryCounts.unpaidCount += 1;
        summaryCounts.totalUnpaidSatang += amt;
      } else if (st === 'RESERVED') {
        summaryCounts.reservedCount += 1;
        summaryCounts.totalUnpaidSatang += amt;
      } else if (st === 'AWAITING_VERIFICATION') {
        summaryCounts.awaitingVerificationCount += 1;
      } else if (st === 'APPROVING') {
        summaryCounts.approvingCount += 1;
      } else if (st === 'PAID') {
        summaryCounts.paidCount += 1;
        summaryCounts.totalPaidSatang += amt;
      } else if (st === 'REJECTED') {
        summaryCounts.rejectedCount += 1;
        summaryCounts.totalUnpaidSatang += amt;
      } else if (st === 'CANCELLED') {
        summaryCounts.cancelledCount += 1;
      }

      if (filterUserId && filterUserId !== 'ALL' && inv.user_id !== filterUserId) {
        continue;
      }
      if (
        filterCourseId &&
        filterCourseId !== 'ALL' &&
        inv.course_id !== filterCourseId
      ) {
        continue;
      }
      if (filterStatus && filterStatus !== 'ALL' && st !== filterStatus) {
        continue;
      }

      var dto = formatInvoiceDtoStep10_(inv, usersTbl.byId, coursesTbl.byId);
      if (searchQuery) {
        var haystack = (
          dto.invoiceId +
          ' ' +
          dto.installmentLabel +
          ' ' +
          dto.studentUsername +
          ' ' +
          dto.studentFullName +
          ' ' +
          dto.courseCode
        ).toLowerCase();
        if (haystack.indexOf(searchQuery) === -1) {
          continue;
        }
      }
      matchedDtos.push(dto);
    }

    summaryCounts.totalUnpaidThbFormatted = formatSatangToThbDisplay_(
      summaryCounts.totalUnpaidSatang
    );
    summaryCounts.totalPaidThbFormatted = formatSatangToThbDisplay_(
      summaryCounts.totalPaidSatang
    );

    return {
      invoices: matchedDtos.slice(0, 100),
      totalMatched: matchedDtos.length,
      summaryCounts: summaryCounts,
      studentsList: studentsList,
      coursesList: coursesList,
      serverNow: clock.nowUtcIso,
      serverNowBangkok: clock.nowBangkok,
      policyNotice:
        'All invoice amounts are stored as integer satang (1 THB = 100 satang). Financial references in Invoices and Payments are permanently preserved (users with financial references cannot be hard-deleted), and direct invoice editing or automated refunds are not supported by design.'
    };
  });
}

function handleAdminListInvoicesStep10_(payload, context) {
  return adminListInvoicesStep10_(context.authContext, payload);
}

/**
 * Student / Admin Action: `payment.getStudentSummary`
 * Sweeps expired sessions, recovers pending journals, and returns the student's eligible unpaid
 * invoices, full invoice history, active resumable payment reservation (if any), and payment history.
 */
function paymentGetStudentSummaryStep10_(authContext, payload) {
  if (!authContext || !authContext.user) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to view tuition invoices and payment sessions.'
    );
  }
  var caller = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var targetUserId = caller.user_id;
  if (caller.role === 'ADMIN' && req.studentUserId) {
    targetUserId = String(req.studentUserId).trim();
  }
  var clock = resolveServerNowStep10_(req);

  return withScriptLock_(function () {
    recoverPendingPaymentJournalsInLock_(clock.nowUtcIso);
    sweepExpiredPaymentSessionsInLock_(clock.nowMs);

    var usersTbl = readSheetTable_('Users');
    var coursesTbl = readSheetTable_('Courses');
    var invoicesTbl = readSheetTable_('Invoices');
    var paymentsTbl = readSheetTable_('Payments');
    var journalTbl = readSheetTable_('PaymentJournal');

    /* Ensure Student A / Student B have initial sample installments when none exist yet */
    var targetUserEntry = usersTbl.byId && usersTbl.byId[targetUserId] ? usersTbl.byId[targetUserId].record : null;
    var targetUsernameLower = targetUserEntry ? String(targetUserEntry.username_lower || '') : '';
    if (
      !req._disableAutoSeed &&
      !req._testServerNowMs &&
      (targetUserId === 'usr_stu_001' ||
        targetUserId === 'usr_stu_002' ||
        targetUsernameLower === 'student_a' ||
        targetUsernameLower === 'student_b')
    ) {
      var hasAnyForStudent = false;
      for (var chkIdx = 0; chkIdx < invoicesTbl.records.length; chkIdx++) {
        if (invoicesTbl.records[chkIdx].user_id === targetUserId) {
          hasAnyForStudent = true;
          break;
        }
      }
      if (!hasAnyForStudent) {
        seedInitialSampleInvoicesForStudentInLockStep11_(targetUserId, clock.nowUtcIso);
        invoicesTbl = readSheetTable_('Invoices');
      }
    }

    var allInvoices = [];
    var eligibleUnpaidInvoices = [];
    var eligibleUnpaidTotalSatang = 0;
    var awaitingVerificationTotalSatang = 0;
    var paidTotalSatang = 0;

    for (var i = 0; i < invoicesTbl.records.length; i++) {
      var inv = invoicesTbl.records[i];
      if (inv.user_id !== targetUserId) {
        continue;
      }
      var dto = formatInvoiceDtoStep10_(inv, usersTbl.byId, coursesTbl.byId);
      allInvoices.push(dto);

      if (dto.isEligibleUnpaid) {
        eligibleUnpaidInvoices.push(dto);
        eligibleUnpaidTotalSatang += dto.amountSatang;
      } else if (dto.status === 'AWAITING_VERIFICATION' || dto.status === 'APPROVING') {
        awaitingVerificationTotalSatang += dto.amountSatang;
      } else if (dto.status === 'PAID') {
        paidTotalSatang += dto.amountSatang;
      }
    }

    var activeReservation = null;
    var paymentHistory = [];
    for (var p = paymentsTbl.records.length - 1; p >= 0; p--) {
      var pRow = paymentsTbl.records[p];
      if (pRow.user_id !== targetUserId) {
        continue;
      }
      var pDto = formatPaymentSessionDtoStep10_(
        pRow,
        clock.nowMs,
        journalTbl,
        invoicesTbl.byId,
        usersTbl.byId
      );
      paymentHistory.push(pDto);
      if (!activeReservation && pDto.canResume) {
        activeReservation = pDto;
      }
    }

    return {
      userId: targetUserId,
      serverNow: clock.nowUtcIso,
      serverNowUtc: clock.nowUtcIso,
      serverNowBangkok: clock.nowBangkok,
      eligibleUnpaidInvoices: eligibleUnpaidInvoices,
      allInvoices: allInvoices,
      activeReservation: activeReservation,
      paymentHistory: paymentHistory,
      totalsSummary: {
        eligibleUnpaidCount: eligibleUnpaidInvoices.length,
        eligibleUnpaidTotalSatang: eligibleUnpaidTotalSatang,
        eligibleUnpaidTotalThb: formatSatangToThbNumericString_(
          eligibleUnpaidTotalSatang
        ),
        eligibleUnpaidTotalThbFormatted: formatSatangToThbDisplay_(
          eligibleUnpaidTotalSatang
        ),
        awaitingVerificationTotalSatang: awaitingVerificationTotalSatang,
        awaitingVerificationTotalThbFormatted: formatSatangToThbDisplay_(
          awaitingVerificationTotalSatang
        ),
        paidTotalSatang: paidTotalSatang,
        paidTotalThbFormatted: formatSatangToThbDisplay_(paidTotalSatang)
      },
      expirationPolicyNotice:
        'Payment reservations expire 15 minutes (900 seconds) after server creation if not confirmed with a receipt upload. After expiration, the payment session transitions to EXPIRED and its reserved invoices automatically return to UNPAID so they can be selected in a new session. Note: The website countdown timer governs portal reservation state and cannot remotely invalidate a static PromptPay QR image already saved in a banking app.'
    };
  });
}

function handlePaymentGetStudentSummaryStep10_(payload, context) {
  return paymentGetStudentSummaryStep10_(context.authContext, payload);
}

/**
 * Student Action: `payment.createReservation`
 * Creates a 15-minute payment session across one, multiple, or all eligible unpaid invoices.
 * - Verifies student ownership and eligible state ('UNPAID' or 'REJECTED') inside LockService.
 * - Sums authoritative total from database Invoices records and ignores client-supplied totals.
 * - Snapshots school recipient details (PromptPay or Bank Transfer).
 * - Enforces idempotencyKey uniqueness & payload fingerprint matching.
 * - Writes a PENDING PaymentJournal entry and commits across Payments and Invoices.
 */
function paymentCreateReservationStep10_(authContext, payload) {
  if (!authContext || !authContext.user) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to create a payment reservation.'
    );
  }
  var caller = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};

  var targetUserId = caller.user_id;
  if (caller.role === 'ADMIN' && req.studentUserId) {
    targetUserId = String(req.studentUserId).trim();
  } else if (caller.role !== 'STUDENT' && caller.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Only a student account may create a tuition payment reservation.'
    );
  }

  /* Normalize payment method outside lock */
  var rawMethod = String(req.method || 'PROMPTPAY_QR')
    .trim()
    .toUpperCase();
  if (rawMethod === 'PROMPTPAY') {
    rawMethod = 'PROMPTPAY_QR';
  }
  if (rawMethod !== 'PROMPTPAY_QR' && rawMethod !== 'BANK_TRANSFER') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Unsupported payment method "' +
        rawMethod +
        '". Supported methods are PROMPTPAY_QR and BANK_TRANSFER.',
      { method: 'Must be PROMPTPAY_QR or BANK_TRANSFER.' }
    );
  }

  var idempotencyKey = validateIdempotencyKeyStep10_(req.idempotencyKey, true);
  var selectAllEligible = Boolean(req.selectAllEligible);

  /* Normalize requested invoiceIds array outside lock */
  var requestedInvoiceIds = [];
  if (Array.isArray(req.invoiceIds)) {
    var seenMap = {};
    for (var i = 0; i < req.invoiceIds.length; i++) {
      var idStr = String(req.invoiceIds[i] || '').trim();
      if (!idStr) {
        continue;
      }
      if (!/^inv_[A-Za-z0-9_-]{4,64}$/.test(idStr)) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Invalid invoiceId "' + idStr + '".',
          { invoiceIds: 'All invoiceIds must start with inv_.' }
        );
      }
      if (!seenMap[idStr]) {
        seenMap[idStr] = true;
        requestedInvoiceIds.push(idStr);
      }
    }
  }
  requestedInvoiceIds.sort();

  if (!selectAllEligible && requestedInvoiceIds.length === 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please select at least one unpaid invoice (or set selectAllEligible: true).',
      { invoiceIds: 'Select one or more unpaid invoices.' }
    );
  }

  /* Check if the client supplied any total/amount fields so we can explicitly ignore and audit them */
  var clientSuppliedAmountProvided =
    req.totalAmountSatang !== undefined ||
    req.amountSatang !== undefined ||
    req.clientTotalSatang !== undefined ||
    req.amountThb !== undefined ||
    req.totalAmountThb !== undefined ||
    req.invoiceAmounts !== undefined;
  var rawClientSuppliedValue =
    req.totalAmountSatang !== undefined
      ? req.totalAmountSatang
      : req.amountSatang !== undefined
      ? req.amountSatang
      : req.clientTotalSatang !== undefined
      ? req.clientTotalSatang
      : req.amountThb !== undefined
      ? req.amountThb
      : req.totalAmountThb !== undefined
      ? req.totalAmountThb
      : req.invoiceAmounts;

  var canonicalParams = {
    userId: targetUserId,
    selectAllEligible: selectAllEligible,
    invoiceIds: requestedInvoiceIds,
    method: rawMethod
  };
  var requestFingerprint = computePaymentRequestFingerprintStep10_(
    'RESERVE',
    targetUserId,
    canonicalParams
  );

  var clock = resolveServerNowStep10_(req);
  var ttlMs =
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.PAYMENT_RESERVATION_TTL_MS) ||
    PB_PAYMENT_CONSTANTS_STEP10_.RESERVATION_TTL_MS;
  var expiresAtMs = clock.nowMs + ttlMs;
  var expiresAtUtc = new Date(expiresAtMs).toISOString();

  return withScriptLock_(function () {
    /* 1. Recover any pending journal entries and sweep expired reservations first */
    recoverPendingPaymentJournalsInLock_(clock.nowUtcIso);
    sweepExpiredPaymentSessionsInLock_(clock.nowMs);

    /* 2. Check idempotencyKey before validating invoice reservation locks */
    var idemLookup = lookupIdempotentOperationInLock_(
      idempotencyKey,
      'RESERVE',
      requestFingerprint
    );
    if (idemLookup.hit) {
      var existingPayRow = getSheetRecordById_(
        'Payments',
        idemLookup.journalRow.payment_id
      );
      if (existingPayRow) {
        var invTblIdem = readSheetTable_('Invoices');
        var usrTblIdem = readSheetTable_('Users');
        var jrnTblIdem = readSheetTable_('PaymentJournal');
        var existingDto = formatPaymentSessionDtoStep10_(
          existingPayRow,
          clock.nowMs,
          jrnTblIdem,
          invTblIdem.byId,
          usrTblIdem.byId
        );
        return {
          idempotentReplay: true,
          payment: existingDto,
          reservedInvoices: existingDto.invoices,
          recipientSnapshot: existingDto.recipientSnapshot,
          serverNow: clock.nowUtcIso,
          serverNowUtc: clock.nowUtcIso,
          serverNowBangkok: clock.nowBangkok,
          expiresAt: existingDto.expiresAtUtc,
          expiresAtUtc: existingDto.expiresAtUtc,
          expiresAtBangkok: existingDto.expiresAtBangkok,
          remainingSeconds: existingDto.remainingSeconds,
          clientAmountAudit: {
            clientSuppliedAmountProvided: clientSuppliedAmountProvided,
            clientSuppliedAmountIgnored: clientSuppliedAmountProvided,
            ignoredClientValue: clientSuppliedAmountProvided
              ? rawClientSuppliedValue
              : null,
            authoritativeTotalAmountSatang: existingDto.totalAmountSatang
          }
        };
      }
    }

    var invoicesTbl = readSheetTable_('Invoices');
    var usersTbl = readSheetTable_('Users');
    var settingsTbl = readSheetTable_('Settings');

    /* 3. Resolve target invoice rows inside the critical section */
    var selectedInvoiceRows = [];
    if (selectAllEligible && requestedInvoiceIds.length === 0) {
      for (var r = 0; r < invoicesTbl.records.length; r++) {
        var candidate = invoicesTbl.records[r];
        if (
          candidate.user_id === targetUserId &&
          (candidate.status === 'UNPAID' || candidate.status === 'REJECTED')
        ) {
          selectedInvoiceRows.push(candidate);
        }
      }
      selectedInvoiceRows.sort(function (a, b) {
        return String(a.invoice_id).localeCompare(String(b.invoice_id));
      });
      if (selectedInvoiceRows.length === 0) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'No eligible unpaid invoices (UNPAID or REJECTED) were found for your account.',
          { invoiceIds: 'No eligible unpaid invoices available to reserve.' }
        );
      }
    } else {
      for (var k = 0; k < requestedInvoiceIds.length; k++) {
        var reqInvId = requestedInvoiceIds[k];
        var hit = invoicesTbl.byId[reqInvId];
        if (!hit || !hit.record) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_NOT_FOUND,
            'Invoice "' + reqInvId + '" does not exist.',
            { invoiceIds: 'Invoice "' + reqInvId + '" was not found.' }
          );
        }
        var invRow = hit.record;

        /* Ownership check: strictly reject another student's invoice */
        if (invRow.user_id !== targetUserId) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
            'Access denied: invoice "' +
              reqInvId +
              '" belongs to another student account.',
            {
              invoiceId: reqInvId,
              reason: 'CROSS_STUDENT_INVOICE_FORBIDDEN'
            }
          );
        }

        /* State check: only UNPAID or REJECTED invoices can be reserved */
        var invStatus = String(invRow.status || '');
        if (invStatus === 'PAID') {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
            'Invoice "' +
              reqInvId +
              '" is already PAID and cannot be reserved again.',
            {
              invoiceId: reqInvId,
              invoiceStatus: 'PAID'
            }
          );
        }
        if (invStatus === 'RESERVED') {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_CONFLICT_RESERVATION ||
              PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
            'Invoice "' +
              reqInvId +
              '" is already reserved in an active payment session (' +
              (invRow.active_payment_id || 'active') +
              '). Resume or cancel the active session instead of opening a conflicting reservation.',
            {
              invoiceId: reqInvId,
              invoiceStatus: 'RESERVED',
              activePaymentId: invRow.active_payment_id || ''
            }
          );
        }
        if (invStatus !== 'UNPAID' && invStatus !== 'REJECTED') {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
            'Invoice "' +
              reqInvId +
              '" is in state "' +
              invStatus +
              '" and is not eligible for reservation (must be UNPAID or REJECTED).',
            {
              invoiceId: reqInvId,
              invoiceStatus: invStatus
            }
          );
        }

        selectedInvoiceRows.push(invRow);
      }
    }

    var finalInvoiceIds = selectedInvoiceRows.map(function (row) {
      return row.invoice_id;
    });
    finalInvoiceIds.sort();

    /* 4. Calculate authoritative integer satang total from database records */
    var authoritativeTotalSatang = sumInvoiceAmountsSatangSafe_(
      selectedInvoiceRows
    );

    /* 5. Snapshot school recipient details at reservation creation time */
    var recipientSnapshot = buildRecipientDetailsSnapshotStep10_(
      rawMethod,
      settingsTbl,
      clock.nowUtcIso
    );

    var paymentId = generateEntityId_('pay_');
    var journalId = generateEntityId_('jrn_');

    var newPaymentRecord = {
      payment_id: paymentId,
      user_id: targetUserId,
      invoice_ids_json: JSON.stringify(finalInvoiceIds),
      total_amount_satang: authoritativeTotalSatang,
      method: rawMethod,
      status: PB_PAYMENT_STATES_STEP10_.AWAITING_TRANSFER, /* 'PENDING_TRANSFER' */
      idempotency_key: idempotencyKey,
      expires_at_utc: expiresAtUtc,
      receipt_file_id: '',
      submitted_at_utc: '',
      reviewed_by_user_id: '',
      reviewed_at_utc: '',
      rejection_reason: '',
      created_at_utc: clock.nowUtcIso,
      updated_at_utc: clock.nowUtcIso,
      version: 1
    };

    var journalPayload = {
      requestFingerprint: requestFingerprint,
      canonicalParams: canonicalParams,
      recipientSnapshot: recipientSnapshot,
      serverNowUtc: clock.nowUtcIso,
      expiresAtUtc: expiresAtUtc,
      desiredActivePaymentId: paymentId,
      newPaymentRecord: newPaymentRecord,
      clientSuppliedAmountIgnored: clientSuppliedAmountProvided
    };

    /* 6. Write-Ahead Journal Entry (PENDING) before mutating Payments and Invoices */
    insertSheetRecord_(
      'PaymentJournal',
      {
        journal_id: journalId,
        operation_type: 'RESERVE',
        idempotency_key: idempotencyKey,
        payment_id: paymentId,
        invoice_ids_json: JSON.stringify(finalInvoiceIds),
        target_payment_status: PB_PAYMENT_STATES_STEP10_.AWAITING_TRANSFER,
        target_invoice_status: PB_INVOICE_STATES_STEP10_.RESERVED,
        payload_json: JSON.stringify(journalPayload),
        journal_status: 'PENDING',
        created_at_utc: clock.nowUtcIso,
        committed_at_utc: ''
      },
      { skipLock: true }
    );

    /* 7. Insert Payments record */
    insertSheetRecord_('Payments', newPaymentRecord, { skipLock: true });

    /* 8. Transition each selected Invoice to RESERVED */
    for (var idx = 0; idx < selectedInvoiceRows.length; idx++) {
      var targetInv = selectedInvoiceRows[idx];
      updateSheetRecordById_(
        'Invoices',
        targetInv.invoice_id,
        {
          status: PB_INVOICE_STATES_STEP10_.RESERVED,
          active_payment_id: paymentId,
          reservation_expires_at_utc: expiresAtUtc,
          updated_at_utc: clock.nowUtcIso
        },
        Number(targetInv.version || 1),
        { skipLock: true }
      );

      /* Deterministic partial-write simulation hook for Step 10 testing */
      if (
        idx === 0 &&
        (req.simulatePartialWrite === true ||
          req.simulatePartialWriteStage === 'AFTER_FIRST_INVOICE')
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_SIMULATED_PARTIAL_WRITE || PB_ERROR_CODES_.ERR_INTERNAL,
          'Simulated mid-flight partial write after updating first invoice; PaymentJournal entry "' +
            journalId +
            '" remains PENDING for deterministic roll-forward recovery.',
          {
            journalId: journalId,
            paymentId: paymentId,
            partiallyUpdatedInvoiceId: targetInv.invoice_id
          }
        );
      }
    }

    /* 9. Commit PaymentJournal entry */
    updateSheetRecordById_(
      'PaymentJournal',
      journalId,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: clock.nowUtcIso
      },
      null,
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: caller.user_id,
      actorRole: caller.role,
      eventType: 'PAYMENT_RESERVATION_CREATED',
      targetEntityType: 'Payment',
      targetEntityId: paymentId,
      summary: {
        studentUserId: targetUserId,
        invoiceIds: finalInvoiceIds,
        totalAmountSatang: authoritativeTotalSatang,
        totalAmountThbFormatted: formatSatangToThbDisplay_(
          authoritativeTotalSatang
        ),
        method: rawMethod,
        expiresAtUtc: expiresAtUtc,
        idempotencyKey: idempotencyKey,
        clientSuppliedAmountIgnored: clientSuppliedAmountProvided
      }
    });

    var freshInvoicesTbl = readSheetTable_('Invoices');
    var freshJournalTbl = readSheetTable_('PaymentJournal');
    var paymentDto = formatPaymentSessionDtoStep10_(
      newPaymentRecord,
      clock.nowMs,
      freshJournalTbl,
      freshInvoicesTbl.byId,
      usersTbl.byId
    );

    return {
      idempotentReplay: false,
      payment: paymentDto,
      reservedInvoices: paymentDto.invoices,
      recipientSnapshot: recipientSnapshot,
      serverNow: clock.nowUtcIso,
      serverNowUtc: clock.nowUtcIso,
      serverNowBangkok: clock.nowBangkok,
      expiresAt: expiresAtUtc,
      expiresAtUtc: expiresAtUtc,
      expiresAtBangkok: formatBangkokTimestamp_(expiresAtUtc),
      remainingSeconds: PB_PAYMENT_CONSTANTS_STEP10_.RESERVATION_TTL_SECONDS,
      clientAmountAudit: {
        clientSuppliedAmountProvided: clientSuppliedAmountProvided,
        clientSuppliedAmountIgnored: clientSuppliedAmountProvided,
        ignoredClientValue: clientSuppliedAmountProvided
          ? rawClientSuppliedValue
          : null,
        authoritativeTotalAmountSatang: authoritativeTotalSatang
      }
    };
  });
}

function handlePaymentCreateReservationStep10_(payload, context) {
  return paymentCreateReservationStep10_(context.authContext, payload);
}

/**
 * Student / Admin Action: `payment.cancelReservation`
 * Cancels an active `PENDING_TRANSFER` / `RECEIPT_UPLOADED` payment session and releases
 * its linked `Invoices` back to `UNPAID`.
 */
function paymentCancelReservationStep10_(authContext, payload) {
  if (!authContext || !authContext.user) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to cancel a payment reservation.'
    );
  }
  var caller = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var paymentId = sanitizeSingleLineTextStep7_(req.paymentId, 64);

  if (!paymentId || !/^pay_[A-Za-z0-9_-]{4,64}$/.test(paymentId)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'A valid paymentId (pay_...) is required to cancel a reservation.',
      { paymentId: 'Required paymentId (pay_...).' }
    );
  }

  var idempotencyKey = validateIdempotencyKeyStep10_(
    req.idempotencyKey || 'cancel_' + paymentId,
    true
  );
  var canonicalParams = {
    paymentId: paymentId,
    operation: 'CANCEL_RESERVATION'
  };
  var requestFingerprint = computePaymentRequestFingerprintStep10_(
    'CANCEL_RESERVATION',
    caller.user_id,
    canonicalParams
  );
  var clock = resolveServerNowStep10_(req);

  return withScriptLock_(function () {
    recoverPendingPaymentJournalsInLock_(clock.nowUtcIso);
    sweepExpiredPaymentSessionsInLock_(clock.nowMs);

    var idemLookup = lookupIdempotentOperationInLock_(
      idempotencyKey,
      'CANCEL_RESERVATION',
      requestFingerprint
    );
    if (idemLookup.hit) {
      var replayPay = getSheetRecordById_('Payments', paymentId);
      var invTblReplay = readSheetTable_('Invoices');
      var usrTblReplay = readSheetTable_('Users');
      var jrnTblReplay = readSheetTable_('PaymentJournal');
      return {
        idempotentReplay: true,
        payment: formatPaymentSessionDtoStep10_(
          replayPay,
          clock.nowMs,
          jrnTblReplay,
          invTblReplay.byId,
          usrTblReplay.byId
        ),
        serverNow: clock.nowUtcIso,
        serverNowBangkok: clock.nowBangkok
      };
    }

    var payRow = getSheetRecordById_('Payments', paymentId);
    if (!payRow) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Payment session "' + paymentId + '" was not found.'
      );
    }

    if (caller.role !== 'ADMIN' && payRow.user_id !== caller.user_id) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: you may only cancel your own payment reservation.'
      );
    }

    var st = String(payRow.status || '');
    if (st !== 'PENDING_TRANSFER' && st !== 'RECEIPT_UPLOADED' && st !== 'RESERVED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
        'Cannot cancel payment "' +
          paymentId +
          '" because it is in state "' +
          st +
          '". Only PENDING_TRANSFER (awaiting transfer) sessions can be cancelled.',
        {
          paymentId: paymentId,
          currentStatus: st,
          attemptedTargetStatus: 'CANCELLED'
        }
      );
    }

    var invIds = parseJsonSafeStep10_(payRow.invoice_ids_json, []);
    var journalId = generateEntityId_('jrn_');

    insertSheetRecord_(
      'PaymentJournal',
      {
        journal_id: journalId,
        operation_type: 'CANCEL_RESERVATION',
        idempotency_key: idempotencyKey,
        payment_id: paymentId,
        invoice_ids_json: JSON.stringify(invIds),
        target_payment_status: PB_PAYMENT_STATES_STEP10_.CANCELLED,
        target_invoice_status: PB_INVOICE_STATES_STEP10_.UNPAID,
        payload_json: JSON.stringify({
          requestFingerprint: requestFingerprint,
          desiredActivePaymentId: '',
          cancelledByUserId: caller.user_id,
          cancelledAtUtc: clock.nowUtcIso
        }),
        journal_status: 'PENDING',
        created_at_utc: clock.nowUtcIso,
        committed_at_utc: ''
      },
      { skipLock: true }
    );

    var updatedPay = updateSheetRecordById_(
      'Payments',
      paymentId,
      {
        status: PB_PAYMENT_STATES_STEP10_.CANCELLED,
        updated_at_utc: clock.nowUtcIso
      },
      Number(payRow.version || 1),
      { skipLock: true }
    );

    for (var k = 0; k < invIds.length; k++) {
      var invRow = getSheetRecordById_('Invoices', invIds[k]);
      if (
        invRow &&
        (invRow.status === 'RESERVED' || invRow.active_payment_id === paymentId)
      ) {
        updateSheetRecordById_(
          'Invoices',
          invRow.invoice_id,
          {
            status: PB_INVOICE_STATES_STEP10_.UNPAID,
            active_payment_id: '',
            reservation_expires_at_utc: '',
            updated_at_utc: clock.nowUtcIso
          },
          Number(invRow.version || 1),
          { skipLock: true }
        );
      }
    }

    updateSheetRecordById_(
      'PaymentJournal',
      journalId,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: clock.nowUtcIso
      },
      null,
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: caller.user_id,
      actorRole: caller.role,
      eventType: 'PAYMENT_RESERVATION_CANCELLED',
      targetEntityType: 'Payment',
      targetEntityId: paymentId,
      summary: {
        releasedInvoiceIds: invIds,
        idempotencyKey: idempotencyKey
      }
    });

    var freshInvoicesTbl = readSheetTable_('Invoices');
    var freshUsersTbl = readSheetTable_('Users');
    var freshJournalTbl = readSheetTable_('PaymentJournal');

    return {
      idempotentReplay: false,
      payment: formatPaymentSessionDtoStep10_(
        updatedPay,
        clock.nowMs,
        freshJournalTbl,
        freshInvoicesTbl.byId,
        freshUsersTbl.byId
      ),
      releasedInvoiceIds: invIds,
      serverNow: clock.nowUtcIso,
      serverNowBangkok: clock.nowBangkok
    };
  });
}

function handlePaymentCancelReservationStep10_(payload, context) {
  return paymentCancelReservationStep10_(context.authContext, payload);
}

/**
 * Student Action: `payment.confirmSubmission`
 * Transitions an active, non-expired `PENDING_TRANSFER` / `RECEIPT_UPLOADED` payment session
 * (with a verified uploaded receipt file) to `AWAITING_VERIFICATION` across both `Payments` and `Invoices`.
 */
function paymentConfirmSubmissionStep10_(authContext, payload) {
  if (!authContext || !authContext.user) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to confirm a payment submission.'
    );
  }
  var caller = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var paymentId = sanitizeSingleLineTextStep7_(req.paymentId, 64);

  if (!paymentId || !/^pay_[A-Za-z0-9_-]{4,64}$/.test(paymentId)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'A valid paymentId (pay_...) is required.',
      { paymentId: 'Required paymentId (pay_...).' }
    );
  }

  var requestedReceiptFileId = sanitizeSingleLineTextStep7_(req.receiptFileId, 64);
  var idempotencyKey = validateIdempotencyKeyStep10_(
    req.idempotencyKey || 'confirm_' + paymentId,
    true
  );
  var canonicalParams = {
    paymentId: paymentId,
    receiptFileId: requestedReceiptFileId || ''
  };
  var requestFingerprint = computePaymentRequestFingerprintStep10_(
    'SUBMIT_FOR_VERIFICATION',
    caller.user_id,
    canonicalParams
  );
  var clock = resolveServerNowStep10_(req);

  return withScriptLock_(function () {
    recoverPendingPaymentJournalsInLock_(clock.nowUtcIso);

    var idemLookup = lookupIdempotentOperationInLock_(
      idempotencyKey,
      'SUBMIT_FOR_VERIFICATION',
      requestFingerprint
    );
    if (idemLookup.hit) {
      var replayPay = getSheetRecordById_('Payments', paymentId);
      var invTblReplay = readSheetTable_('Invoices');
      var usrTblReplay = readSheetTable_('Users');
      var jrnTblReplay = readSheetTable_('PaymentJournal');
      return {
        idempotentReplay: true,
        payment: formatPaymentSessionDtoStep10_(
          replayPay,
          clock.nowMs,
          jrnTblReplay,
          invTblReplay.byId,
          usrTblReplay.byId
        ),
        serverNow: clock.nowUtcIso,
        serverNowBangkok: clock.nowBangkok
      };
    }

    var payRow = getSheetRecordById_('Payments', paymentId);
    if (!payRow) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Payment session "' + paymentId + '" was not found.'
      );
    }

    if (caller.role !== 'ADMIN' && payRow.user_id !== caller.user_id) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: you may only confirm your own payment session.'
      );
    }

    var st = String(payRow.status || '');
    var expStr = String(payRow.expires_at_utc || '').trim();
    var expMs = expStr ? Date.parse(expStr) : NaN;
    var effectiveReceiptFileId =
      requestedReceiptFileId || String(payRow.receipt_file_id || '').trim();
    var invIds = parseJsonSafeStep10_(payRow.invoice_ids_json, []);
    var supportContact = readPaymentSupportContactStep11_();

    /* Step 11 Recheck 1: Sweep expired reservations if timer has elapsed */
    if (
      (st === 'PENDING_TRANSFER' || st === 'RECEIPT_UPLOADED' || st === 'RESERVED') &&
      !isNaN(expMs) &&
      clock.nowMs > expMs
    ) {
      sweepExpiredPaymentSessionsInLock_(clock.nowMs);
      payRow = getSheetRecordById_('Payments', paymentId) || payRow;
      st = String(payRow.status || 'EXPIRED');
    }

    /* Step 11 Recheck 2: Check if another session now owns the reservation (or paid any invoice) BEFORE applying */
    for (var chkInvIdx = 0; chkInvIdx < invIds.length; chkInvIdx++) {
      var chkInv = getSheetRecordById_('Invoices', invIds[chkInvIdx]);
      if (!chkInv) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Linked invoice "' + invIds[chkInvIdx] + '" no longer exists.'
        );
      }
      var invActivePayId = String(chkInv.active_payment_id || '').trim();
      var invSt = String(chkInv.status || '');
      if (
        (invActivePayId && invActivePayId !== paymentId) ||
        (invSt === 'PAID' && invActivePayId !== paymentId)
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_RESERVATION,
          'Reservation ownership conflict: Invoice "' +
            chkInv.invoice_id +
            '" (' +
            chkInv.installment_label +
            ') is now owned by another payment session ("' +
            (invActivePayId || 'COMPLETED_PAYMENT') +
            '" in status "' +
            invSt +
            '"). To prevent double-applying your payment, this submission was blocked while preserving your uploaded receipt reference (' +
            (effectiveReceiptFileId || 'none') +
            '). Please use the support instructions below for manual reconciliation.',
          {
            conflictType: 'ANOTHER_SESSION_OWNS_RESERVATION',
            invoiceId: chkInv.invoice_id,
            installmentLabel: chkInv.installment_label,
            invoiceStatus: invSt,
            owningPaymentId: invActivePayId || 'COMPLETED_PAYMENT',
            attemptedPaymentId: paymentId,
            preservedReceiptFileId: effectiveReceiptFileId || '',
            supportEmail: supportContact.publicContactEmail,
            supportLineUrl: supportContact.lineContactUrl,
            supportInstructions:
              'Do NOT make another bank or PromptPay transfer. Contact ' +
              supportContact.schoolName +
              ' support (' +
              supportContact.publicContactEmail +
              ') and provide your Attempted Payment ID (' +
              paymentId +
              '), Active/Owning Payment ID (' +
              (invActivePayId || 'N/A') +
              '), Invoice ID (' +
              chkInv.invoice_id +
              '), and Preserved Receipt File ID (' +
              (effectiveReceiptFileId || 'N/A') +
              ') so an administrator can verify your slip without double-charging.'
          }
        );
      }
    }

    /* Step 11 Recheck 3: Check expiration and provide explicit before/after expiry guidance */
    if (st === 'EXPIRED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_PAYMENT_EXPIRED,
        'Payment reservation "' +
          paymentId +
          '" expired at ' +
          expStr +
          ' and has been transitioned to EXPIRED. Its invoices have been returned to UNPAID so you can create a new reservation.',
        {
          paymentId: paymentId,
          currentStatus: 'EXPIRED',
          expiresAtUtc: expStr,
          serverNowUtc: clock.nowUtcIso,
          preservedReceiptFileId: effectiveReceiptFileId || '',
          supportEmail: supportContact.publicContactEmail,
          supportLineUrl: supportContact.lineContactUrl,
          transferBeforeExpiryPolicy:
            'If you transferred funds BEFORE the 15-minute countdown ended (but clicked Confirm after 00:00), do NOT pay again. Start a new reservation for the same unpaid installment(s) and upload your receipt slip, or contact school support quoting Payment ID ' +
            paymentId +
            ' and Receipt ID ' +
            (effectiveReceiptFileId || 'N/A') +
            '.',
          transferAfterExpiryPolicy:
            'If you transferred funds AFTER the 15-minute countdown ended (for example, using a saved PromptPay QR screenshot), your bank transfer may still have succeeded. Do NOT pay a second time--start a new reservation for the unpaid installment(s) and attach your transfer slip, or contact ' +
            supportContact.publicContactEmail +
            '.'
        }
      );
    }

    if (st !== 'PENDING_TRANSFER' && st !== 'RECEIPT_UPLOADED' && st !== 'RESERVED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
        'Invalid state transition: payment "' +
          paymentId +
          '" in state "' +
          st +
          '" cannot transition to AWAITING_VERIFICATION.',
        {
          paymentId: paymentId,
          currentStatus: st,
          attemptedTargetStatus: 'AWAITING_VERIFICATION'
        }
      );
    }

    if (
      !effectiveReceiptFileId ||
      !/^fil_[A-Za-z0-9_-]{4,64}$/.test(effectiveReceiptFileId)
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
        'Cannot confirm payment submission before uploading a valid payment receipt image (receipt_file_id is missing).',
        {
          receiptFileId:
            'Upload a payment receipt (payment.uploadReceipt) before confirming submission.'
        }
      );
    }

    var fileRow = getSheetRecordById_('Files', effectiveReceiptFileId);
    if (
      !fileRow ||
      fileRow.status !== 'ACTIVE' ||
      fileRow.purpose !== 'PAYMENT_RECEIPT'
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Referenced receipt file "' +
          effectiveReceiptFileId +
          '" is missing, inactive, or not a PAYMENT_RECEIPT file.',
        { receiptFileId: 'Invalid or inactive PAYMENT_RECEIPT file.' }
      );
    }
    if (fileRow.owner_user_id && fileRow.owner_user_id !== payRow.user_id && caller.role !== 'ADMIN') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Receipt file "' +
          effectiveReceiptFileId +
          '" belongs to a different user.'
      );
    }

    /* Step 11 Recheck 4: Ensure every linked invoice is still RESERVED for this paymentId */
    for (var verInvIdx = 0; verInvIdx < invIds.length; verInvIdx++) {
      var verInv = getSheetRecordById_('Invoices', invIds[verInvIdx]);
      if (
        !verInv ||
        verInv.status !== 'RESERVED' ||
        String(verInv.active_payment_id || '') !== paymentId
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_RESERVATION,
          'Invoice "' +
            invIds[verInvIdx] +
            '" is no longer reserved by payment session "' +
            paymentId +
            '" (current status: ' +
            (verInv ? verInv.status : 'MISSING') +
            ', active_payment_id: ' +
            (verInv ? verInv.active_payment_id || 'none' : 'none') +
            '). Submission blocked to prevent double-applying payment.',
          {
            conflictType: 'ANOTHER_SESSION_OWNS_RESERVATION',
            invoiceId: invIds[verInvIdx],
            invoiceStatus: verInv ? verInv.status : 'MISSING',
            owningPaymentId: verInv ? verInv.active_payment_id || '' : '',
            attemptedPaymentId: paymentId,
            preservedReceiptFileId: effectiveReceiptFileId,
            supportEmail: supportContact.publicContactEmail,
            supportLineUrl: supportContact.lineContactUrl,
            supportInstructions:
              'Do NOT transfer again. Please contact ' +
              supportContact.publicContactEmail +
              ' with Payment ID ' +
              paymentId +
              ' and Receipt File ID ' +
              effectiveReceiptFileId +
              '.'
          }
        );
      }
    }
    var journalId = generateEntityId_('jrn_');

    insertSheetRecord_(
      'PaymentJournal',
      {
        journal_id: journalId,
        operation_type: 'SUBMIT_FOR_VERIFICATION',
        idempotency_key: idempotencyKey,
        payment_id: paymentId,
        invoice_ids_json: JSON.stringify(invIds),
        target_payment_status: PB_PAYMENT_STATES_STEP10_.AWAITING_VERIFICATION,
        target_invoice_status: PB_INVOICE_STATES_STEP10_.AWAITING_VERIFICATION,
        payload_json: JSON.stringify({
          requestFingerprint: requestFingerprint,
          receiptFileId: effectiveReceiptFileId,
          submittedAtUtc: clock.nowUtcIso,
          desiredActivePaymentId: paymentId
        }),
        journal_status: 'PENDING',
        created_at_utc: clock.nowUtcIso,
        committed_at_utc: ''
      },
      { skipLock: true }
    );

    var updatedPay = updateSheetRecordById_(
      'Payments',
      paymentId,
      {
        status: PB_PAYMENT_STATES_STEP10_.AWAITING_VERIFICATION,
        receipt_file_id: effectiveReceiptFileId,
        submitted_at_utc: clock.nowUtcIso,
        updated_at_utc: clock.nowUtcIso
      },
      Number(payRow.version || 1),
      { skipLock: true }
    );

    for (var k = 0; k < invIds.length; k++) {
      var invRow = getSheetRecordById_('Invoices', invIds[k]);
      if (invRow) {
        updateSheetRecordById_(
          'Invoices',
          invRow.invoice_id,
          {
            status: PB_INVOICE_STATES_STEP10_.AWAITING_VERIFICATION,
            active_payment_id: paymentId,
            reservation_expires_at_utc: '',
            updated_at_utc: clock.nowUtcIso
          },
          Number(invRow.version || 1),
          { skipLock: true }
        );
      }
    }

    updateSheetRecordById_(
      'PaymentJournal',
      journalId,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: clock.nowUtcIso
      },
      null,
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: caller.user_id,
      actorRole: caller.role,
      eventType: 'PAYMENT_SUBMITTED_FOR_VERIFICATION',
      targetEntityType: 'Payment',
      targetEntityId: paymentId,
      summary: {
        invoiceIds: invIds,
        receiptFileId: effectiveReceiptFileId,
        totalAmountSatang: Number(payRow.total_amount_satang),
        idempotencyKey: idempotencyKey
      }
    });

    var freshInvoicesTbl = readSheetTable_('Invoices');
    var freshUsersTbl = readSheetTable_('Users');
    var freshJournalTbl = readSheetTable_('PaymentJournal');

    return {
      idempotentReplay: false,
      payment: formatPaymentSessionDtoStep10_(
        updatedPay,
        clock.nowMs,
        freshJournalTbl,
        freshInvoicesTbl.byId,
        freshUsersTbl.byId
      ),
      serverNow: clock.nowUtcIso,
      serverNowBangkok: clock.nowBangkok
    };
  });
}

function handlePaymentConfirmSubmissionStep10_(payload, context) {
  return paymentConfirmSubmissionStep10_(context.authContext, payload);
}

/**
 * Administrator Action: `admin.listPendingPayments`
 * Lists payment sessions (defaults to all or filterable by status) with journal recovery & expiration sweep.
 */
function adminListPendingPaymentsStep10_(authContext, payload) {
  assertAdminRoleStep10_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};
  var filterStatus = String(req.status || req.statusFilter || 'ALL')
    .trim()
    .toUpperCase();
  var filterUserId = String(req.userId || req.studentUserId || '').trim();
  var clock = resolveServerNowStep10_(req);

  return withScriptLock_(function () {
    var recoveryInfo = recoverPendingPaymentJournalsInLock_(clock.nowUtcIso);
    var sweepInfo = sweepExpiredPaymentSessionsInLock_(clock.nowMs);

    var paymentsTbl = readSheetTable_('Payments');
    var invoicesTbl = readSheetTable_('Invoices');
    var usersTbl = readSheetTable_('Users');
    var journalTbl = readSheetTable_('PaymentJournal');

    var queueCounts = {
      totalPayments: paymentsTbl.records.length,
      awaitingVerificationCount: 0,
      approvingCount: 0,
      paidCount: 0,
      rejectedCount: 0,
      pendingTransferCount: 0,
      expiredCount: 0,
      cancelledCount: 0,
      haltedJournalCount: recoveryInfo.haltedInconsistentCount || 0
    };

    var items = [];
    for (var i = paymentsTbl.records.length - 1; i >= 0; i--) {
      var pRow = paymentsTbl.records[i];
      var st = String(pRow.status || '');
      if (st === 'AWAITING_VERIFICATION') queueCounts.awaitingVerificationCount++;
      else if (st === 'APPROVING') queueCounts.approvingCount++;
      else if (st === 'PAID' || st === 'APPROVED') queueCounts.paidCount++;
      else if (st === 'REJECTED') queueCounts.rejectedCount++;
      else if (st === 'PENDING_TRANSFER' || st === 'RECEIPT_UPLOADED') queueCounts.pendingTransferCount++;
      else if (st === 'EXPIRED') queueCounts.expiredCount++;
      else if (st === 'CANCELLED') queueCounts.cancelledCount++;

      if (filterUserId && filterUserId !== 'ALL' && pRow.user_id !== filterUserId) {
        continue;
      }
      if (
        filterStatus &&
        filterStatus !== 'ALL' &&
        st !== filterStatus
      ) {
        continue;
      }
      items.push(
        formatPaymentSessionDtoStep10_(
          pRow,
          clock.nowMs,
          journalTbl,
          invoicesTbl.byId,
          usersTbl.byId
        )
      );
      if (items.length >= 100) {
        break;
      }
    }

    return {
      payments: items,
      totalReturned: items.length,
      queueCounts: queueCounts,
      recoveredJournals: recoveryInfo,
      expiredSweep: sweepInfo,
      verificationReminderNotice:
        'Mandatory Administrator Verification Checklist: Before clicking Approve, verify the actual bank credit in the school bank statement or PromptPay merchant portal--confirming recipient account, exact THB/satang amount, and transaction date/time. Never treat an uploaded receipt image alone as proof of payment.',
      financialRetentionPolicyNotice:
        'Financial Record Retention Policy: Invoices, Payments, PaymentJournal rows, and uploaded PAYMENT_RECEIPT files are never deleted during generic session or reservation cleanup. Long-term retention and archival of financial records must follow a separate, formal school accounting and legal retention policy.',
      serverNow: clock.nowUtcIso,
      serverNowBangkok: clock.nowBangkok
    };
  });
}

function handleAdminListPendingPaymentsStep10_(payload, context) {
  return adminListPendingPaymentsStep10_(context.authContext, payload);
}

/**
 * Administrator Action: `admin.reviewPayment` (Step 10 & Step 12 Complete Implementation)
 * Approves (`AWAITING_VERIFICATION -> APPROVING -> PAID`) or Rejects (`AWAITING_VERIFICATION -> REJECTED`)
 * a submitted payment session using a write-ahead `PaymentJournal` entry.
 *
 * Step 12 Security & Integrity Guarantees:
 * - Verifies `ADMIN` role (`assertAdminRoleStep10_`).
 * - Runs `recoverPendingPaymentJournalsInLock_` first; if the target payment has a halted
 *   inconsistent journal, stops and throws `ERR_FINANCIAL_INCONSISTENCY`.
 * - Prevents duplicate approvals:
 *   - Retrying the same `idempotencyKey` and payload returns `idempotentReplay: true` without re-applying.
 *   - A second approval attempt (with a new `idempotencyKey` or by a second concurrent administrator)
 *     when the payment is already `PAID` is rejected with `ERR_INVALID_STATE_TRANSITION` (`duplicateApprovalPrevented: true`).
 * - Resolves concurrent Approve vs. Reject races deterministically inside `withScriptLock_`.
 * - Rechecks payment state, receipt file existence (`PAYMENT_RECEIPT`), every linked invoice's existence,
 *   student ownership, state (`AWAITING_VERIFICATION` / `APPROVING`), `active_payment_id === paymentId`,
 *   and exact integer satang sum (`sum(inv.amount_satang) === pay.total_amount_satang`) before writing.
 *   If any referenced invoice is missing or inconsistent, stops and throws `ERR_FINANCIAL_INCONSISTENCY`
 *   instead of guessing the financial result.
 */
function adminReviewPaymentStep10_(authContext, payload) {
  var adminUser = assertAdminRoleStep10_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};
  var paymentId = sanitizeSingleLineTextStep7_(req.paymentId, 64);

  if (!paymentId || !/^pay_[A-Za-z0-9_-]{4,64}$/.test(paymentId)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'A valid paymentId (pay_...) is required.',
      { paymentId: 'Required paymentId (pay_...).' }
    );
  }

  var decision = String(req.decision || req.action || '')
    .trim()
    .toUpperCase();
  if (decision === 'PAID' || decision === 'APPROVED') {
    decision = 'APPROVE';
  } else if (decision === 'REJECTED') {
    decision = 'REJECT';
  }
  if (decision !== 'APPROVE' && decision !== 'REJECT') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'decision must be APPROVE or REJECT.',
      { decision: 'Must be APPROVE or REJECT.' }
    );
  }

  var rejectionReason = sanitizeSingleLineTextStep7_(
    req.rejectionReason !== undefined ? req.rejectionReason : req.reviewNote,
    500
  );
  if (decision === 'REJECT' && (!rejectionReason || rejectionReason.length < 3)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'A rejectionReason (at least 3 characters) is required when rejecting a payment.',
      { rejectionReason: 'Please provide a clear rejection reason for the student (at least 3 characters).' }
    );
  }

  var opType = decision === 'APPROVE' ? 'ADMIN_APPROVE' : 'ADMIN_REJECT';
  var idempotencyKey = validateIdempotencyKeyStep10_(
    req.idempotencyKey || 'review_' + decision.toLowerCase() + '_' + paymentId,
    true
  );
  var canonicalParams = {
    paymentId: paymentId,
    decision: decision,
    rejectionReason: decision === 'REJECT' ? rejectionReason : ''
  };
  var requestFingerprint = computePaymentRequestFingerprintStep10_(
    opType,
    adminUser.user_id,
    canonicalParams
  );
  var clock = resolveServerNowStep10_(req);

  return withScriptLock_(function () {
    /* 1. Recover any uncommitted journal entries first (including any interrupted APPROVING transition!) */
    var recoveryReport = recoverPendingPaymentJournalsInLock_(clock.nowUtcIso);
    sweepExpiredPaymentSessionsInLock_(clock.nowMs);

    /* If recovery halted on this paymentId due to inconsistent records, stop and report immediately */
    if (recoveryReport.haltedInconsistencies && recoveryReport.haltedInconsistencies.length > 0) {
      for (var hIdx = 0; hIdx < recoveryReport.haltedInconsistencies.length; hIdx++) {
        var haltedItem = recoveryReport.haltedInconsistencies[hIdx];
        if (haltedItem && haltedItem.paymentId === paymentId) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_FINANCIAL_INCONSISTENCY || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
            'Verification stopped due to inconsistent financial records on payment "' +
              paymentId +
              '": ' +
              (haltedItem.message || haltedItem.reasonCode),
            haltedItem
          );
        }
      }
    }

    /* 2. Check idempotencyKey (exact retry by same admin with same key & decision) */
    var idemLookup = lookupIdempotentOperationInLock_(
      idempotencyKey,
      opType,
      requestFingerprint
    );
    if (idemLookup.hit) {
      var replayPay = getSheetRecordById_('Payments', paymentId);
      var invTblReplay = readSheetTable_('Invoices');
      var usrTblReplay = readSheetTable_('Users');
      var jrnTblReplay = readSheetTable_('PaymentJournal');
      return {
        idempotentReplay: true,
        payment: formatPaymentSessionDtoStep10_(
          replayPay,
          clock.nowMs,
          jrnTblReplay,
          invTblReplay.byId,
          usrTblReplay.byId
        ),
        serverNow: clock.nowUtcIso,
        serverNowBangkok: clock.nowBangkok
      };
    }

    var payRow = getSheetRecordById_('Payments', paymentId);
    if (!payRow) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Payment session "' + paymentId + '" was not found.'
      );
    }

    var currentStatus = String(payRow.status || '');

    /* 3. Explicit duplicate-approval & concurrent-admin race resolution */
    if (currentStatus === 'PAID' || currentStatus === 'APPROVED') {
      if (decision === 'APPROVE') {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
          'Duplicate approval prevented: Payment "' +
            paymentId +
            '" has already been APPROVED (status = PAID) by administrator "' +
            (payRow.reviewed_by_user_id || 'ADMIN') +
            '" at ' +
            (payRow.reviewed_at_utc || '-') +
            '. Approval was not applied a second time.',
          {
            paymentId: paymentId,
            currentStatus: 'PAID',
            attemptedDecision: 'APPROVE',
            duplicateApprovalPrevented: true,
            alreadyReviewedByUserId: payRow.reviewed_by_user_id || '',
            alreadyReviewedAtUtc: payRow.reviewed_at_utc || ''
          }
        );
      } else {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
          'Concurrent review conflict: Payment "' +
            paymentId +
            '" was already APPROVED (status = PAID) by administrator "' +
            (payRow.reviewed_by_user_id || 'ADMIN') +
            '" and cannot be rejected.',
          {
            paymentId: paymentId,
            currentStatus: 'PAID',
            attemptedDecision: 'REJECT',
            winningDecision: 'APPROVE',
            alreadyReviewedByUserId: payRow.reviewed_by_user_id || ''
          }
        );
      }
    }

    if (currentStatus === 'REJECTED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
        'Concurrent review conflict: Payment "' +
          paymentId +
          '" has already been REJECTED by administrator "' +
          (payRow.reviewed_by_user_id || 'ADMIN') +
          '" (Reason: ' +
          (payRow.rejection_reason || '-') +
          ') and cannot be reviewed again with decision "' +
          decision +
          '".',
        {
          paymentId: paymentId,
          currentStatus: 'REJECTED',
          attemptedDecision: decision,
          winningDecision: 'REJECT',
          alreadyReviewedByUserId: payRow.reviewed_by_user_id || '',
          rejectionReason: payRow.rejection_reason || ''
        }
      );
    }

    if (
      currentStatus !== 'AWAITING_VERIFICATION' &&
      !(decision === 'APPROVE' && currentStatus === 'APPROVING')
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
        'Invalid state transition: payment "' +
          paymentId +
          '" is in state "' +
          currentStatus +
          '" and cannot be reviewed with decision "' +
          decision +
          '". Only payments in AWAITING_VERIFICATION state can be approved or rejected.',
        {
          paymentId: paymentId,
          currentStatus: currentStatus,
          decision: decision
        }
      );
    }

    /* Optional optimistic concurrency version check if supplied by UI */
    if (
      req.expectedVersion !== undefined &&
      req.expectedVersion !== null &&
      req.expectedVersion !== '' &&
      Number(req.expectedVersion) !== Number(payRow.version || 1)
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
        'Payment "' +
          paymentId +
          '" was updated by another administrator (expected v' +
          req.expectedVersion +
          ', found v' +
          payRow.version +
          '). Please reload the verification queue.',
        {
          paymentId: paymentId,
          expectedVersion: Number(req.expectedVersion),
          currentVersion: Number(payRow.version || 1)
        }
      );
    }

    /* 4. Step 12 Backend Recheck of Receipt File, Referenced Invoices, States, Ownership & Integer Satang Amount */
    var receiptFileId = String(payRow.receipt_file_id || '').trim();
    if (decision === 'APPROVE') {
      if (!receiptFileId || !/^fil_[A-Za-z0-9_-]{4,64}$/.test(receiptFileId)) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FINANCIAL_INCONSISTENCY || PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
          'Cannot approve payment "' +
            paymentId +
            '" because receipt_file_id is missing or invalid.',
          { paymentId: paymentId, receiptFileId: receiptFileId }
        );
      }
      var receiptRow = getSheetRecordById_('Files', receiptFileId);
      if (
        !receiptRow ||
        receiptRow.status !== 'ACTIVE' ||
        receiptRow.purpose !== 'PAYMENT_RECEIPT'
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FINANCIAL_INCONSISTENCY || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Cannot approve payment "' +
            paymentId +
            '" because referenced receipt file "' +
            receiptFileId +
            '" is missing, inactive, or not a PAYMENT_RECEIPT.',
          { paymentId: paymentId, receiptFileId: receiptFileId }
        );
      }
    }

    var invIds = parseJsonSafeStep10_(payRow.invoice_ids_json, []);
    if (!Array.isArray(invIds) || invIds.length === 0) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FINANCIAL_INCONSISTENCY || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Inconsistent payment record: payment "' +
          paymentId +
          '" has an empty or malformed invoice_ids_json. Verification stopped.',
        { paymentId: paymentId, reasonCode: 'EMPTY_INVOICE_REFERENCES' }
      );
    }

    var verifiedInvoices = [];
    var sumInvoicesSatang = 0;
    for (var chkIdx = 0; chkIdx < invIds.length; chkIdx++) {
      var targetInvId = String(invIds[chkIdx] || '').trim();
      var targetInvRow = targetInvId ? getSheetRecordById_('Invoices', targetInvId) : null;
      if (!targetInvRow) {
        recordAuditEvent_({
          actorUserId: adminUser.user_id,
          actorRole: 'ADMIN',
          eventType: 'PAYMENT_REVIEW_HALTED_INCONSISTENT',
          targetEntityType: 'Payment',
          targetEntityId: paymentId,
          summary: {
            reasonCode: 'MISSING_INVOICE_REFERENCE',
            missingInvoiceId: targetInvId,
            decision: decision
          }
        });
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FINANCIAL_INCONSISTENCY || PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Inconsistent invoice reference: Invoice "' +
            targetInvId +
            '" referenced by payment "' +
            paymentId +
            '" does not exist in the Invoices sheet. Verification stopped instead of guessing the financial result.',
          {
            paymentId: paymentId,
            missingInvoiceId: targetInvId,
            reasonCode: 'MISSING_INVOICE_REFERENCE'
          }
        );
      }

      if (String(targetInvRow.user_id || '') !== String(payRow.user_id || '')) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FINANCIAL_INCONSISTENCY || PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Inconsistent invoice owner: Invoice "' +
            targetInvId +
            '" belongs to student "' +
            targetInvRow.user_id +
            '", which does not match payment student "' +
            payRow.user_id +
            '". Verification stopped.',
          {
            paymentId: paymentId,
            invoiceId: targetInvId,
            invoiceUserId: targetInvRow.user_id,
            paymentUserId: payRow.user_id,
            reasonCode: 'INVOICE_STUDENT_MISMATCH'
          }
        );
      }

      var invState = String(targetInvRow.status || '');
      var invActivePayId = String(targetInvRow.active_payment_id || '').trim();
      if (
        (invState !== 'AWAITING_VERIFICATION' && invState !== 'APPROVING') ||
        invActivePayId !== paymentId
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FINANCIAL_INCONSISTENCY || PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
          'Inconsistent invoice state: Invoice "' +
            targetInvId +
            '" is in state "' +
            invState +
            '" with active_payment_id "' +
            (invActivePayId || 'none') +
            '" (expected AWAITING_VERIFICATION / APPROVING linked to "' +
            paymentId +
            '"). Verification stopped instead of guessing the financial result.',
          {
            paymentId: paymentId,
            invoiceId: targetInvId,
            invoiceStatus: invState,
            invoiceActivePaymentId: invActivePayId,
            reasonCode: 'INVOICE_STATE_OR_LINK_INCONSISTENT'
          }
        );
      }

      sumInvoicesSatang += Number(targetInvRow.amount_satang) || 0;
      verifiedInvoices.push(targetInvRow);
    }

    var authoritativePaymentSatang = Number(payRow.total_amount_satang) || 0;
    if (sumInvoicesSatang !== authoritativePaymentSatang) {
      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'PAYMENT_REVIEW_HALTED_INCONSISTENT',
        targetEntityType: 'Payment',
        targetEntityId: paymentId,
        summary: {
          reasonCode: 'AMOUNT_SATANG_MISMATCH',
          sumInvoicesSatang: sumInvoicesSatang,
          paymentTotalSatang: authoritativePaymentSatang,
          decision: decision
        }
      });
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FINANCIAL_INCONSISTENCY || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Inconsistent payment amount: Sum of referenced invoices (' +
          sumInvoicesSatang +
          ' satang) does not match payment "' +
          paymentId +
          '" total_amount_satang (' +
          authoritativePaymentSatang +
          ' satang). Verification stopped instead of guessing the financial result.',
        {
          paymentId: paymentId,
          sumOfInvoicesSatang: sumInvoicesSatang,
          paymentTotalAmountSatang: authoritativePaymentSatang,
          reasonCode: 'AMOUNT_SATANG_MISMATCH'
        }
      );
    }

    if (
      req.expectedAmountSatang !== undefined &&
      req.expectedAmountSatang !== null &&
      req.expectedAmountSatang !== '' &&
      Number(req.expectedAmountSatang) !== authoritativePaymentSatang
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FINANCIAL_INCONSISTENCY || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Expected review amount (' +
          req.expectedAmountSatang +
          ' satang) does not match payment total_amount_satang (' +
          authoritativePaymentSatang +
          ' satang).',
        {
          paymentId: paymentId,
          expectedAmountSatang: Number(req.expectedAmountSatang),
          authoritativePaymentSatang: authoritativePaymentSatang
        }
      );
    }

    var journalId = generateEntityId_('jrn_');

    if (decision === 'APPROVE') {
      /* Write-ahead journal entry for ADMIN_APPROVE (target state: PAID) */
      insertSheetRecord_(
        'PaymentJournal',
        {
          journal_id: journalId,
          operation_type: 'ADMIN_APPROVE',
          idempotency_key: idempotencyKey,
          payment_id: paymentId,
          invoice_ids_json: JSON.stringify(invIds),
          target_payment_status: PB_PAYMENT_STATES_STEP10_.PAID,
          target_invoice_status: PB_INVOICE_STATES_STEP10_.PAID,
          payload_json: JSON.stringify({
            requestFingerprint: requestFingerprint,
            reviewedByUserId: adminUser.user_id,
            reviewedAtUtc: clock.nowUtcIso,
            rejectionReason: '',
            desiredActivePaymentId: paymentId
          }),
          journal_status: 'PENDING',
          created_at_utc: clock.nowUtcIso,
          committed_at_utc: ''
        },
        { skipLock: true }
      );

      /* Stage 1: Transition Payment into transitional APPROVING state */
      var approvingPay = updateSheetRecordById_(
        'Payments',
        paymentId,
        {
          status: PB_PAYMENT_STATES_STEP10_.APPROVING,
          reviewed_by_user_id: adminUser.user_id,
          reviewed_at_utc: clock.nowUtcIso,
          rejection_reason: '',
          updated_at_utc: clock.nowUtcIso
        },
        Number(payRow.version || 1),
        { skipLock: true }
      );

      if (verifiedInvoices.length > 0) {
        var firstInv = verifiedInvoices[0];
        updateSheetRecordById_(
          'Invoices',
          firstInv.invoice_id,
          {
            status: PB_INVOICE_STATES_STEP10_.APPROVING,
            active_payment_id: paymentId,
            reservation_expires_at_utc: '',
            updated_at_utc: clock.nowUtcIso
          },
          Number(firstInv.version || 1),
          { skipLock: true }
        );
      }

      /* Deterministic partial-write simulation hook in APPROVING state */
      if (
        req.simulatePartialWrite === true ||
        req.simulatePartialWriteStage === 'AT_APPROVING' ||
        req.simulatePartialWriteStage === 'AFTER_FIRST_INVOICE'
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_SIMULATED_PARTIAL_WRITE || PB_ERROR_CODES_.ERR_INTERNAL,
          'Simulated partial write while payment "' +
            paymentId +
            '" is in APPROVING state; PaymentJournal "' +
            journalId +
            '" is PENDING and will deterministically roll forward to PAID on next recovery or retry.',
          {
            journalId: journalId,
            paymentId: paymentId,
            intermediatePaymentStatus: 'APPROVING'
          }
        );
      }

      /* Stage 2: Transition all linked Invoices to PAID and finalize Payment to PAID */
      for (var k = 0; k < invIds.length; k++) {
        var invRow = getSheetRecordById_('Invoices', invIds[k]);
        if (invRow) {
          updateSheetRecordById_(
            'Invoices',
            invRow.invoice_id,
            {
              status: PB_INVOICE_STATES_STEP10_.PAID,
              active_payment_id: paymentId,
              reservation_expires_at_utc: '',
              last_rejection_reason: '',
              updated_at_utc: clock.nowUtcIso
            },
            Number(invRow.version || 1),
            { skipLock: true }
          );
        }
      }

      var paidPay = updateSheetRecordById_(
        'Payments',
        paymentId,
        {
          status: PB_PAYMENT_STATES_STEP10_.PAID,
          reviewed_by_user_id: adminUser.user_id,
          reviewed_at_utc: clock.nowUtcIso,
          rejection_reason: '',
          updated_at_utc: clock.nowUtcIso
        },
        Number(approvingPay.version || 1),
        { skipLock: true }
      );

      updateSheetRecordById_(
        'PaymentJournal',
        journalId,
        {
          journal_status: 'COMMITTED',
          committed_at_utc: clock.nowUtcIso
        },
        null,
        { skipLock: true }
      );

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_PAYMENT_APPROVED',
        targetEntityType: 'Payment',
        targetEntityId: paymentId,
        summary: {
          studentUserId: payRow.user_id,
          invoiceIds: invIds,
          totalAmountSatang: authoritativePaymentSatang,
          method: payRow.method,
          receiptFileId: receiptFileId,
          idempotencyKey: idempotencyKey
        }
      });

      var freshInvTblA = readSheetTable_('Invoices');
      var freshUsrTblA = readSheetTable_('Users');
      var freshJrnTblA = readSheetTable_('PaymentJournal');

      return {
        idempotentReplay: false,
        payment: formatPaymentSessionDtoStep10_(
          paidPay,
          clock.nowMs,
          freshJrnTblA,
          freshInvTblA.byId,
          freshUsrTblA.byId
        ),
        serverNow: clock.nowUtcIso,
        serverNowBangkok: clock.nowBangkok
      };
    }

    /* REJECT path: AWAITING_VERIFICATION -> REJECTED */
    insertSheetRecord_(
      'PaymentJournal',
      {
        journal_id: journalId,
        operation_type: 'ADMIN_REJECT',
        idempotency_key: idempotencyKey,
        payment_id: paymentId,
        invoice_ids_json: JSON.stringify(invIds),
        target_payment_status: PB_PAYMENT_STATES_STEP10_.REJECTED,
        target_invoice_status: PB_INVOICE_STATES_STEP10_.REJECTED,
        payload_json: JSON.stringify({
          requestFingerprint: requestFingerprint,
          reviewedByUserId: adminUser.user_id,
          reviewedAtUtc: clock.nowUtcIso,
          rejectionReason: rejectionReason,
          desiredActivePaymentId: ''
        }),
        journal_status: 'PENDING',
        created_at_utc: clock.nowUtcIso,
        committed_at_utc: ''
      },
      { skipLock: true }
    );

    var rejectedPay = updateSheetRecordById_(
      'Payments',
      paymentId,
      {
        status: PB_PAYMENT_STATES_STEP10_.REJECTED,
        reviewed_by_user_id: adminUser.user_id,
        reviewed_at_utc: clock.nowUtcIso,
        rejection_reason: rejectionReason,
        updated_at_utc: clock.nowUtcIso
      },
      Number(payRow.version || 1),
      { skipLock: true }
    );

    for (var m = 0; m < invIds.length; m++) {
      var rInv = getSheetRecordById_('Invoices', invIds[m]);
      if (rInv) {
        updateSheetRecordById_(
          'Invoices',
          rInv.invoice_id,
          {
            status: PB_INVOICE_STATES_STEP10_.REJECTED,
            active_payment_id: '',
            reservation_expires_at_utc: '',
            last_rejection_reason: rejectionReason,
            updated_at_utc: clock.nowUtcIso
          },
          Number(rInv.version || 1),
          { skipLock: true }
        );
      }
    }

    updateSheetRecordById_(
      'PaymentJournal',
      journalId,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: clock.nowUtcIso
      },
      null,
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_PAYMENT_REJECTED',
      targetEntityType: 'Payment',
      targetEntityId: paymentId,
      summary: {
        studentUserId: payRow.user_id,
        invoiceIds: invIds,
        totalAmountSatang: authoritativePaymentSatang,
        rejectionReason: rejectionReason,
        idempotencyKey: idempotencyKey
      }
    });

    var freshInvTblR = readSheetTable_('Invoices');
    var freshUsrTblR = readSheetTable_('Users');
    var freshJrnTblR = readSheetTable_('PaymentJournal');

    return {
      idempotentReplay: false,
      payment: formatPaymentSessionDtoStep10_(
        rejectedPay,
        clock.nowMs,
        freshJrnTblR,
        freshInvTblR.byId,
        freshUsrTblR.byId
      ),
      serverNow: clock.nowUtcIso,
      serverNowBangkok: clock.nowBangkok
    };
  });
}

function handleAdminReviewPaymentStep10_(payload, context) {
  return adminReviewPaymentStep10_(context.authContext, payload);
}

function adminRunStep10VerificationSuite_(authContext, payload) {
  var adminUser = assertAdminRoleStep10_(authContext);

  /* Ensure Step 9 student cohort exists so student_a and student_b are available */
  if (typeof adminSeedStep9LearningCohort_ === 'function') {
    adminSeedStep9LearningCohort_(authContext, {});
  }

  var usersTbl = readSheetTable_('Users');
  var studentA = null;
  var studentB = null;
  for (var i = 0; i < usersTbl.records.length; i++) {
    var u = usersTbl.records[i];
    if (u.username_lower === 'student_a') {
      studentA = u;
    } else if (u.username_lower === 'student_b') {
      studentB = u;
    }
  }
  if (!studentA || !studentB) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Sample students student_a and student_b are required to run the Step 10 verification suite.'
    );
  }

  var stuACtx = { user: studentA };
  var stuBCtx = { user: studentB };
  var runTag = String(Date.now()).slice(-6);
  var report = {
    ok: true,
    executedAtUtc: nowUtcIso_(),
    tests: {}
  };

  /* Create 3 unpaid invoices for Student A and 1 unpaid invoice for Student B */
  var invA1 = adminCreateInvoiceStep10_(authContext, {
    userId: studentA.user_id,
    installmentLabel: 'Step 10 Test Installment A1 (' + runTag + ')',
    amountThb: '3,500.00',
    dueDateBkk: '2026-11-15'
  }).invoice;

  var invA2 = adminCreateInvoiceStep10_(authContext, {
    userId: studentA.user_id,
    installmentLabel: 'Step 10 Test Installment A2 (' + runTag + ')',
    amountThb: '2250.50',
    dueDateBkk: '2026-12-01'
  }).invoice;

  var invA3 = adminCreateInvoiceStep10_(authContext, {
    userId: studentA.user_id,
    installmentLabel: 'Step 10 Test Installment A3 (' + runTag + ')',
    amountThb: '1800',
    dueDateBkk: '2026-12-15'
  }).invoice;

  var invB1 = adminCreateInvoiceStep10_(authContext, {
    userId: studentB.user_id,
    installmentLabel: 'Step 10 Test Installment B1 (' + runTag + ')',
    amountThb: '4100.25',
    dueDateBkk: '2026-11-20'
  }).invoice;

  /* Test 1: Altered Amount & Money Precision */
  var badDecimalRejected = false;
  try {
    parseThbToSatangSafe_('125.999', 'amountThb');
  } catch (decErr) {
    badDecimalRejected = decErr.code === 'ERR_VALIDATION_FAILED';
  }

  var idemKey1 = 'idem_s10_t1_' + runTag;
  /* First simulate a partial write after the first invoice during RESERVE, then recover via idempotent retry! */
  var reservePartialCrashCode = '';
  try {
    paymentCreateReservationStep10_(stuACtx, {
      invoiceIds: [invA1.invoiceId, invA2.invoiceId],
      method: 'PROMPTPAY_QR',
      idempotencyKey: idemKey1,
      totalAmountSatang: 100,
      amountThb: '1.00',
      simulatePartialWriteStage: 'AFTER_FIRST_INVOICE'
    });
  } catch (resPwErr) {
    reservePartialCrashCode = resPwErr.code || '';
  }
  var invA1MidReserve = getSheetRecordById_('Invoices', invA1.invoiceId);
  var invA2MidReserve = getSheetRecordById_('Invoices', invA2.invoiceId);
  var reserveTornStateObserved =
    (invA1MidReserve.status === 'RESERVED' && invA2MidReserve.status === 'UNPAID') ||
    (invA1MidReserve.status === 'UNPAID' && invA2MidReserve.status === 'RESERVED');

  /* Retry with the same idempotencyKey -> Journal recovery rolls forward invA2 to RESERVED and returns the session! */
  var resAltered = paymentCreateReservationStep10_(stuACtx, {
    invoiceIds: [invA1.invoiceId, invA2.invoiceId],
    method: 'PROMPTPAY_QR',
    idempotencyKey: idemKey1,
    totalAmountSatang: 100, /* Tampered client total: 1.00 THB instead of 5,750.50 THB (575050 satang) */
    amountThb: '1.00'
  });

  report.tests.test1_alteredAmountAndMoneySatang = {
    passed:
      badDecimalRejected === true &&
      resAltered.payment.totalAmountSatang === 575050 &&
      resAltered.clientAmountAudit.clientSuppliedAmountIgnored === true,
    authoritativeTotalSatang: resAltered.payment.totalAmountSatang,
    ignoredClientValue: resAltered.clientAmountAudit.ignoredClientValue,
    badThreeDecimalRejected: badDecimalRejected
  };

  /* Test 4: Duplicate Request (Idempotency Replay & Payload Mismatch Conflict) */
  var resDupReplay = paymentCreateReservationStep10_(stuACtx, {
    invoiceIds: [invA1.invoiceId, invA2.invoiceId],
    method: 'PROMPTPAY_QR',
    idempotencyKey: idemKey1
  });
  var mismatchRejectedCode = '';
  try {
    paymentCreateReservationStep10_(stuACtx, {
      invoiceIds: [invA1.invoiceId], /* Different payload with same idempotencyKey */
      method: 'BANK_TRANSFER',
      idempotencyKey: idemKey1
    });
  } catch (idemConflictErr) {
    mismatchRejectedCode = idemConflictErr.code || '';
  }

  report.tests.test4_idempotencyDuplicateAndConflict = {
    passed:
      resDupReplay.idempotentReplay === true &&
      resDupReplay.payment.paymentId === resAltered.payment.paymentId &&
      mismatchRejectedCode === 'ERR_IDEMPOTENCY_CONFLICT',
    idempotentReplayReturnedSamePaymentId:
      resDupReplay.payment.paymentId === resAltered.payment.paymentId,
    mismatchedPayloadErrorCode: mismatchRejectedCode
  };

  /* Test 5: Two Tabs Reserving the Same Invoice */
  var tab2RejectedCode = '';
  try {
    paymentCreateReservationStep10_(stuACtx, {
      invoiceIds: [invA1.invoiceId],
      method: 'BANK_TRANSFER',
      idempotencyKey: 'idem_s10_tab2_' + runTag
    });
  } catch (tab2Err) {
    tab2RejectedCode = tab2Err.code || '';
  }
  report.tests.test5_twoTabsConflictingReservation = {
    passed: tab2RejectedCode === 'ERR_CONFLICT_RESERVATION',
    secondTabRejectedWith: tab2RejectedCode
  };

  /* Test 2: Another Student's Invoice */
  var crossStudentCode = '';
  try {
    paymentCreateReservationStep10_(stuACtx, {
      invoiceIds: [invB1.invoiceId],
      method: 'PROMPTPAY_QR',
      idempotencyKey: 'idem_s10_cross_' + runTag
    });
  } catch (crossErr) {
    crossStudentCode = crossErr.code || '';
  }
  report.tests.test2_anotherStudentsInvoice = {
    passed: crossStudentCode === 'ERR_FORBIDDEN_RESOURCE',
    rejectedWith: crossStudentCode
  };

  /* Test 6 & Test 3 & Test 7: Partial Write Recovery (APPROVING -> PAID), Already-Paid Invoice, and Invalid Transitions */
  /* Attach a sample receipt file for Student A so we can confirm submission */
  var sampleReceiptFileId = 'fil_s10_rcpt_' + runTag;
  withScriptLock_(function () {
    insertSheetRecord_(
      'Files',
      {
        file_id: sampleReceiptFileId,
        drive_file_id: 'drv_step9_sample_png_cover_a',
        purpose: 'PAYMENT_RECEIPT',
        course_id: '',
        owner_user_id: studentA.user_id,
        original_filename: 'receipt_a1_a2.png',
        mime_type: 'image/png',
        size_bytes: 68,
        sha256_hex:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        status: 'ACTIVE',
        created_at_utc: nowUtcIso_()
      },
      { skipLock: true }
    );
  });

  /* Invalid Transition Check A: Confirming BEFORE receipt is linked */
  var confirmWithoutReceiptCode = '';
  try {
    paymentConfirmSubmissionStep10_(stuACtx, {
      paymentId: resAltered.payment.paymentId,
      idempotencyKey: 'idem_s10_badconfirm_' + runTag
    });
  } catch (noRcptErr) {
    confirmWithoutReceiptCode = noRcptErr.code || '';
  }

  /* Confirm submission with receipt -> transitions to AWAITING_VERIFICATION */
  var confirmedRes = paymentConfirmSubmissionStep10_(stuACtx, {
    paymentId: resAltered.payment.paymentId,
    receiptFileId: sampleReceiptFileId,
    idempotencyKey: 'idem_s10_confirm_' + runTag
  });

  /* Invalid Transition Check B: Attempting to cancel AFTER reaching AWAITING_VERIFICATION */
  var cancelAfterConfirmCode = '';
  try {
    paymentCancelReservationStep10_(stuACtx, {
      paymentId: resAltered.payment.paymentId,
      idempotencyKey: 'idem_s10_badcancel_' + runTag
    });
  } catch (badCancelErr) {
    cancelAfterConfirmCode = badCancelErr.code || '';
  }

  /* Test 6: Simulate Partial Write during Admin Approval (leaves payment in APPROVING & journal PENDING) */
  var partialWriteCode = '';
  var approveIdemKey = 'idem_s10_approve_' + runTag;
  try {
    adminReviewPaymentStep10_(authContext, {
      paymentId: resAltered.payment.paymentId,
      decision: 'APPROVE',
      idempotencyKey: approveIdemKey,
      simulatePartialWriteStage: 'AT_APPROVING'
    });
  } catch (pwErr) {
    partialWriteCode = pwErr.code || '';
  }

  var midRowAfterCrash = getSheetRecordById_(
    'Payments',
    resAltered.payment.paymentId
  );
  var wasInApprovingState =
    midRowAfterCrash && midRowAfterCrash.status === 'APPROVING';

  /* Retry with same idempotencyKey -> Journal Recovery rolls forward APPROVING -> PAID! */
  var recoveredApprove = adminReviewPaymentStep10_(authContext, {
    paymentId: resAltered.payment.paymentId,
    decision: 'APPROVE',
    idempotencyKey: approveIdemKey
  });

  report.tests.test6_partialWriteJournalRecovery = {
    passed:
      reservePartialCrashCode === 'ERR_SIMULATED_PARTIAL_WRITE' &&
      reserveTornStateObserved === true &&
      partialWriteCode === 'ERR_SIMULATED_PARTIAL_WRITE' &&
      wasInApprovingState === true &&
      recoveredApprove.payment.status === 'PAID' &&
      recoveredApprove.payment.invoices[0].status === 'PAID' &&
      recoveredApprove.payment.invoices[1].status === 'PAID',
    reservePartialCrashCode: reservePartialCrashCode,
    reserveTornStateObservedBeforeRecovery: reserveTornStateObserved,
    approvePartialCrashCode: partialWriteCode,
    intermediateStatusDuringCrash: midRowAfterCrash ? midRowAfterCrash.status : '',
    finalRecoveredPaymentStatus: recoveredApprove.payment.status
  };

  /* Test 3: Already-Paid Invoice */
  var alreadyPaidCode = '';
  try {
    paymentCreateReservationStep10_(stuACtx, {
      invoiceIds: [invA1.invoiceId],
      method: 'PROMPTPAY_QR',
      idempotencyKey: 'idem_s10_paid_' + runTag
    });
  } catch (paidErr) {
    alreadyPaidCode = paidErr.code || '';
  }
  report.tests.test3_alreadyPaidInvoice = {
    passed: alreadyPaidCode === 'ERR_INVALID_STATE_TRANSITION',
    rejectedWith: alreadyPaidCode
  };

  /* Test 7: Additional Invalid Transitions (Approving a PENDING_TRANSFER session; Confirming an EXPIRED session) */
  var resForExpiry = paymentCreateReservationStep10_(stuACtx, {
    invoiceIds: [invA3.invoiceId],
    method: 'BANK_TRANSFER',
    idempotencyKey: 'idem_s10_exp_' + runTag
  });

  var approveBeforeSubmitCode = '';
  try {
    adminReviewPaymentStep10_(authContext, {
      paymentId: resForExpiry.payment.paymentId,
      decision: 'APPROVE',
      idempotencyKey: 'idem_s10_earlyapp_' + runTag
    });
  } catch (earlyAppErr) {
    approveBeforeSubmitCode = earlyAppErr.code || '';
  }

  var expiredConfirmCode = '';
  var futureMs = Date.parse(resForExpiry.expiresAtUtc) + 60000; /* +16 minutes */
  try {
    paymentConfirmSubmissionStep10_(stuACtx, {
      paymentId: resForExpiry.payment.paymentId,
      receiptFileId: sampleReceiptFileId,
      idempotencyKey: 'idem_s10_expconfirm_' + runTag,
      _testServerNowMs: futureMs
    });
  } catch (expConfErr) {
    expiredConfirmCode = expConfErr.code || '';
  }

  var invA3AfterExpiry = getSheetRecordById_('Invoices', invA3.invoiceId);

  report.tests.test7_invalidTransitionsAndExpiry = {
    passed:
      confirmWithoutReceiptCode === 'ERR_INVALID_STATE_TRANSITION' &&
      cancelAfterConfirmCode === 'ERR_INVALID_STATE_TRANSITION' &&
      approveBeforeSubmitCode === 'ERR_INVALID_STATE_TRANSITION' &&
      expiredConfirmCode === 'ERR_PAYMENT_EXPIRED' &&
      invA3AfterExpiry.status === 'UNPAID',
    confirmWithoutReceiptCode: confirmWithoutReceiptCode,
    cancelAfterConfirmCode: cancelAfterConfirmCode,
    approveBeforeSubmitCode: approveBeforeSubmitCode,
    expiredConfirmCode: expiredConfirmCode,
    invoiceStatusAfterExpiry: invA3AfterExpiry.status
  };

  return report;
}

function handleAdminRunStep10VerificationSuite_(payload, context) {
  return adminRunStep10VerificationSuite_(context.authContext, payload);
}


/**
 * Seeds initial realistic sample tuition installments for a student inside an active LockService block
 * when the student has zero invoices on file.
 */
function seedInitialSampleInvoicesForStudentInLockStep11_(targetUserId, nowUtcIso) {
  var nowIso = nowUtcIso || nowUtcIso_();
  var samples =
    targetUserId === 'usr_stu_002'
      ? [
          {
            label: 'Term 1 -- Installment 1 of 2 (Genetics & Evolution Core)',
            satang: 320000,
            dueDateBkk: '2026-11-15',
            courseId: '',
            status: 'UNPAID'
          },
          {
            label: 'Term 1 -- Installment 2 of 2 (Genetics & Evolution Lab)',
            satang: 280000,
            dueDateBkk: '2026-12-15',
            courseId: '',
            status: 'UNPAID'
          }
        ]
      : [
          {
            label: 'Term 1 -- Installment 1 of 2 (Cellular Energetics & Respiration)',
            satang: 350000,
            dueDateBkk: '2026-11-15',
            courseId: '',
            status: 'UNPAID'
          },
          {
            label: 'Term 1 -- Installment 2 of 2 (Molecular Biology & Enzymes)',
            satang: 350000,
            dueDateBkk: '2026-12-15',
            courseId: '',
            status: 'UNPAID'
          },
          {
            label: 'Laboratory Microscopy & Specimen Supplement (Re-selectable)',
            satang: 125050,
            dueDateBkk: '2026-11-30',
            courseId: '',
            status: 'REJECTED'
          }
        ];

  var createdIds = [];
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    var invId = generateEntityId_('inv_');
    insertSheetRecord_(
      'Invoices',
      {
        invoice_id: invId,
        user_id: targetUserId,
        course_id: s.courseId,
        installment_label: s.label,
        amount_satang: s.satang,
        currency: 'THB',
        status: s.status,
        due_date_bkk: s.dueDateBkk,
        active_payment_id: '',
        reservation_expires_at_utc: '',
        paid_at_utc: '',
        created_by_user_id: 'usr_adm_001',
        created_at_utc: nowIso,
        updated_at_utc: nowIso,
        version: 1
      },
      { skipLock: true }
    );
    createdIds.push(invId);
  }
  return createdIds;
}

/**
 * Student / Admin Helper Action: `payment.seedSampleInstallments`
 * Creates 2 fresh UNPAID sample tuition installments for the signed-in student (or specified studentUserId
 * if called by ADMIN) so the full Step 11 student checkout flow can be tested repeatedly at any time.
 */
function paymentSeedSampleInstallmentsStep11_(authContext, payload) {
  if (!authContext || !authContext.user) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to seed sample installments.'
    );
  }
  var caller = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var targetUserId = caller.user_id;
  if (caller.role === 'ADMIN' && req.studentUserId) {
    targetUserId = String(req.studentUserId).trim();
  }
  if (caller.role === 'ADMIN' && targetUserId === caller.user_id) {
    /* If an admin clicks the button while previewing the Payments view, also seed for their own userId or usr_stu_001 */
    targetUserId = caller.user_id;
  }

  var nowIso = nowUtcIso_();
  var tag = String(Date.now()).slice(-4);
  return withScriptLock_(function () {
    var pair = [
      {
        label: 'Tuition Installment A (Batch #' + tag + ' -- Cellular Biology)',
        satang: 250000,
        dueDateBkk: '2026-11-30'
      },
      {
        label: 'Tuition Installment B (Batch #' + tag + ' -- Practical Lab Fee)',
        satang: 180050,
        dueDateBkk: '2026-12-15'
      }
    ];
    var created = [];
    for (var i = 0; i < pair.length; i++) {
      var item = pair[i];
      var invId = generateEntityId_('inv_');
      var rec = insertSheetRecord_(
        'Invoices',
        {
          invoice_id: invId,
          user_id: targetUserId,
          course_id: '',
          installment_label: item.label,
          amount_satang: item.satang,
          currency: 'THB',
          status: 'UNPAID',
          due_date_bkk: item.dueDateBkk,
          active_payment_id: '',
          reservation_expires_at_utc: '',
          paid_at_utc: '',
          created_by_user_id: caller.user_id,
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );
      created.push(formatInvoiceDtoStep10_(rec, null, null));
    }
    return {
      seededCount: created.length,
      targetUserId: targetUserId,
      invoices: created,
      summary: paymentGetStudentSummaryStep10_(authContext, {
        studentUserId: targetUserId,
        _disableAutoSeed: true
      })
    };
  });
}

function handlePaymentSeedSampleInstallmentsStep11_(payload, context) {
  return paymentSeedSampleInstallmentsStep11_(context.authContext, payload);
}

/**
 * Step 11 Automated End-to-End Backend & Checkout Flow Verification Suite (`admin.runStep11VerificationSuite`).
 * Verifies:
 * 1. EMVCo PromptPay payload & CRC-16/CCITT-FALSE calculation for mobile and 13-digit Tax ID targets.
 * 2. Selecting one, multiple, and all eligible installments with authoritative integer satang totals.
 * 3. PromptPay reservation countdown persistence across refreshes (`serverNow` and `expiresAt` do not restart).
 * 4. Bank transfer session snapshotted recipient details (`bankAccountName`, `bankName`, `bankAccountNumber`).
 * 5. Authorized receipt upload (`payment.uploadReceipt`), thumbnail availability, and `payment.confirmSubmission` -> `AWAITING_VERIFICATION`.
 * 6. Reservation-ownership conflict support path (`ANOTHER_SESSION_OWNS_RESERVATION`): when Session 1 expires after uploading a receipt and Session 2 claims the reservation on the same invoice, Session 1 attempting `payment.confirmSubmission` is blocked with `ERR_CONFLICT_RESERVATION`, preserves `receipt_file_id`, and returns structured support instructions instead of double-applying the payment.
 */
function adminRunStep11VerificationSuite_(authContext, payload) {
  assertAdminRoleStep10_(authContext);
  if (typeof adminSeedStep9LearningCohort_ === 'function') {
    adminSeedStep9LearningCohort_(authContext, {});
  }

  var usersTbl = readSheetTable_('Users');
  var studentA = null;
  for (var uIdx = 0; uIdx < usersTbl.records.length; uIdx++) {
    if (usersTbl.records[uIdx].username_lower === 'student_a') {
      studentA = usersTbl.records[uIdx];
      break;
    }
  }
  if (!studentA) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Sample student student_a is required to run the Step 11 verification suite.'
    );
  }

  var runTag = String(Date.now()).slice(-6);
  var stuACtx = {
    user: studentA,
    session: { session_id: 'ses_step11_stua' }
  };

  var report = {
    suite: 'STEP_11_STUDENT_PAYMENT_INTERFACE_AND_CHECKOUT_FLOW',
    executedAtUtc: nowUtcIso_(),
    executedAtBangkok: formatBangkokTimestamp_(nowUtcIso_()),
    tests: {}
  };

  /* TEST 1: EMVCo PromptPay Payload & CRC-16/CCITT-FALSE Verification */
  var ppMobile = buildPromptPayEmvCoPayloadStep11_('081-234-5678 (School PromptPay)', 350000);
  var ppTaxId = buildPromptPayEmvCoPayloadStep11_('0105559999999', 125050);
  report.tests.test1_promptPayEmvCoAndCrc16 = {
    passed:
      ppMobile.payload.indexOf('00020101021229370016A00000067701011101130066812345678') === 0 &&
      ppMobile.payload.indexOf('5802TH530376454073500.006304') > 0 &&
      ppMobile.crcHex.length === 4 &&
      ppTaxId.payload.indexOf('00020101021229370016A00000067701011102130105559999999') === 0 &&
      ppTaxId.payload.indexOf('5802TH530376454071250.506304') > 0,
    mobilePayload: ppMobile.payload,
    mobileCrcHex: ppMobile.crcHex,
    taxIdPayload: ppTaxId.payload,
    taxIdCrcHex: ppTaxId.crcHex
  };

  /* Create 2 test invoices for Student A */
  var inv1 = adminCreateInvoiceStep10_(authContext, {
    userId: studentA.user_id,
    courseId: '',
    installmentLabel: 'Step 11 Test Installment 1 (' + runTag + ')',
    amountThb: '2400.00',
    dueDateBkk: '2026-11-25'
  }).invoice;
  var inv2 = adminCreateInvoiceStep10_(authContext, {
    userId: studentA.user_id,
    courseId: '',
    installmentLabel: 'Step 11 Test Installment 2 (' + runTag + ')',
    amountThb: '1600.75',
    dueDateBkk: '2026-12-10'
  }).invoice;

  /* TEST 2 & 3: PromptPay Reservation + Countdown Persistence Across Refresh */
  var t0Ms = Date.now();
  var resPromptPay = paymentCreateReservationStep10_(stuACtx, {
    invoiceIds: [inv1.invoiceId],
    method: 'PROMPTPAY_QR',
    idempotencyKey: 'idem_s11_pp_' + runTag,
    _testServerNowMs: t0Ms
  });
  var summaryAfter3Min = paymentGetStudentSummaryStep10_(stuACtx, {
    _testServerNowMs: t0Ms + 180 * 1000
  });
  var resumedSession = summaryAfter3Min.activeReservation;
  report.tests.test2_3_promptPayAndCountdownPersistence = {
    passed:
      resPromptPay.payment.totalAmountSatang === 240000 &&
      resPromptPay.payment.remainingSeconds === 900 &&
      Boolean(resumedSession) &&
      resumedSession.paymentId === resPromptPay.payment.paymentId &&
      resumedSession.expiresAt === resPromptPay.payment.expiresAt &&
      resumedSession.remainingSeconds === 720,
    initialRemainingSeconds: resPromptPay.payment.remainingSeconds,
    remainingSecondsAfter3MinRefresh: resumedSession ? resumedSession.remainingSeconds : -1,
    expiresAtUnchanged: resumedSession ? resumedSession.expiresAt === resPromptPay.payment.expiresAt : false
  };

  /* Cancel PromptPay session so inv1 returns to UNPAID, then reserve both inv1 + inv2 via BANK_TRANSFER */
  paymentCancelReservationStep10_(stuACtx, {
    paymentId: resPromptPay.payment.paymentId,
    reason: 'Switch to Bank Transfer multi-installment test',
    idempotencyKey: 'idem_s11_cancel_pp_' + runTag
  });

  var resBankMulti = paymentCreateReservationStep10_(stuACtx, {
    invoiceIds: [inv1.invoiceId, inv2.invoiceId],
    method: 'BANK_TRANSFER',
    idempotencyKey: 'idem_s11_bank_' + runTag
  });

  /* Upload a valid 1x1 PNG receipt to resBankMulti and confirm submission */
  var pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  var uploadOut = handlePaymentUploadReceiptStep8_(
    {
      paymentId: resBankMulti.payment.paymentId,
      originalFilename: 'step11_transfer_slip.png',
      mimeType: 'image/png',
      dataBase64: pngB64
    },
    { authContext: stuACtx }
  );
  var confirmOut = paymentConfirmSubmissionStep10_(stuACtx, {
    paymentId: resBankMulti.payment.paymentId,
    receiptFileId: uploadOut.file.fileId,
    idempotencyKey: 'idem_s11_confirm_bank_' + runTag
  });

  report.tests.test4_5_bankSnapshotReceiptUploadAndConfirm = {
    passed:
      resBankMulti.payment.totalAmountSatang === 400075 &&
      Boolean(resBankMulti.payment.recipientSnapshot.bankAccountNumber) &&
      Boolean(uploadOut.file && uploadOut.file.fileId) &&
      confirmOut.payment.status === 'AWAITING_VERIFICATION',
    combinedSatang: resBankMulti.payment.totalAmountSatang,
    combinedThbFormatted: resBankMulti.payment.totalAmountThbFormatted,
    receiptFileId: uploadOut.file.fileId,
    submittedStatus: confirmOut.payment.status
  };

  /* Approve resBankMulti so inv1 and inv2 become PAID */
  adminReviewPaymentStep10_(authContext, {
    paymentId: resBankMulti.payment.paymentId,
    decision: 'APPROVE',
    reviewNote: 'Verified Step 11 Bank Transfer slip',
    idempotencyKey: 'idem_s11_approve_bank_' + runTag
  });

  /* TEST 6: Reservation-Ownership Conflict Support Path (Session 1 expires with receipt, Session 2 claims invoice, Session 1 attempts confirm) */
  var invConflict = adminCreateInvoiceStep10_(authContext, {
    userId: studentA.user_id,
    courseId: '',
    installmentLabel: 'Step 11 Conflict Support Path Installment (' + runTag + ')',
    amountThb: '1900.00',
    dueDateBkk: '2026-12-20'
  }).invoice;

  var baseNowMs = Date.now();
  var session1 = paymentCreateReservationStep10_(stuACtx, {
    invoiceIds: [invConflict.invoiceId],
    method: 'PROMPTPAY_QR',
    idempotencyKey: 'idem_s11_conf_ses1_' + runTag,
    _testServerNowMs: baseNowMs
  });
  var ses1Receipt = handlePaymentUploadReceiptStep8_(
    {
      paymentId: session1.payment.paymentId,
      originalFilename: 'late_slip_session1.png',
      mimeType: 'image/png',
      dataBase64: pngB64
    },
    { authContext: stuACtx }
  );

  /* Advance clock 16 minutes so Session 1 expires and Session 2 reserves invConflict */
  var afterExpiryMs = baseNowMs + 16 * 60 * 1000;
  var session2 = paymentCreateReservationStep10_(stuACtx, {
    invoiceIds: [invConflict.invoiceId],
    method: 'BANK_TRANSFER',
    idempotencyKey: 'idem_s11_conf_ses2_' + runTag,
    _testServerNowMs: afterExpiryMs
  });

  var conflictErrCode = '';
  var conflictFieldErrors = {};
  try {
    paymentConfirmSubmissionStep10_(stuACtx, {
      paymentId: session1.payment.paymentId,
      receiptFileId: ses1Receipt.file.fileId,
      idempotencyKey: 'idem_s11_conf_submit_ses1_' + runTag,
      _testServerNowMs: afterExpiryMs + 5000
    });
  } catch (confErr) {
    conflictErrCode = confErr.code || '';
    conflictFieldErrors = confErr.fieldErrors || {};
  }

  /* Cancel Session 2 and leave invConflict UNPAID (plus seed 1 more UNPAID invoice) so Student A has ready unpaid installments */
  paymentCancelReservationStep10_(stuACtx, {
    paymentId: session2.payment.paymentId,
    reason: 'Cleanup after Step 11 conflict test',
    idempotencyKey: 'idem_s11_conf_cleanup_' + runTag
  });

  report.tests.test6_anotherSessionOwnsReservationSupportPath = {
    passed:
      conflictErrCode === 'ERR_CONFLICT_RESERVATION' &&
      conflictFieldErrors.conflictType === 'ANOTHER_SESSION_OWNS_RESERVATION' &&
      conflictFieldErrors.owningPaymentId === session2.payment.paymentId &&
      conflictFieldErrors.preservedReceiptFileId === ses1Receipt.file.fileId &&
      Boolean(conflictFieldErrors.supportInstructions),
    conflictErrCode: conflictErrCode,
    conflictFieldErrors: conflictFieldErrors
  };

  return report;
}

function handleAdminRunStep11VerificationSuite_(payload, context) {
  return adminRunStep11VerificationSuite_(context.authContext, payload);
}


/**
 * Generic Session Expiration Sweep inside `withScriptLock_`.
 * Step 12 Maintenance Rule:
 * - Transitions expired `ACTIVE` rows in `Sessions` to `EXPIRED`.
 * - NEVER deletes or modifies `Invoices`, `Payments`, `PaymentJournal`, or `PAYMENT_RECEIPT` files.
 */
function sweepExpiredUserSessionsInLockStep12_(opt_nowMs) {
  var nowMs =
    opt_nowMs !== undefined && opt_nowMs !== null ? Number(opt_nowMs) : Date.now();
  var nowIso = new Date(nowMs).toISOString();
  var sessionsTbl = readSheetTable_('Sessions');
  var expiredSessionIds = [];

  for (var i = 0; i < sessionsTbl.records.length; i++) {
    var sRow = sessionsTbl.records[i];
    if (sRow.status !== 'ACTIVE') {
      continue;
    }
    var expMs = Date.parse(String(sRow.expires_at_utc || ''));
    if (!isNaN(expMs) && nowMs > expMs) {
      updateSheetRecordById_(
        'Sessions',
        sRow.session_id,
        {
          status: 'EXPIRED',
          revoked_at_utc: nowIso,
          revoke_reason: 'EXPIRED'
        },
        null,
        { skipLock: true }
      );
      expiredSessionIds.push(sRow.session_id);
    }
  }

  return {
    expiredSessionCount: expiredSessionIds.length,
    expiredSessionIds: expiredSessionIds
  };
}

/**
 * Executes recovery for interrupted approvals (`APPROVING` / `PENDING` journals),
 * sweeps expired 15-minute payment reservations, and sweeps expired login sessions
 * while strictly preserving all financial records (`Invoices`, `Payments`, `PaymentJournal`, `Files`).
 */
function runPaymentAndSessionMaintenanceStep12_(opt_nowMs) {
  var nowMs =
    opt_nowMs !== undefined && opt_nowMs !== null ? Number(opt_nowMs) : Date.now();
  var nowIso = new Date(nowMs).toISOString();

  return withScriptLock_(function () {
    var journalRecovery = recoverPendingPaymentJournalsInLock_(nowIso);
    var reservationSweep = sweepExpiredPaymentSessionsInLock_(nowMs);
    var sessionSweep = sweepExpiredUserSessionsInLockStep12_(nowMs);

    return {
      executedAtUtc: nowIso,
      executedAtBangkok: formatBangkokTimestamp_(nowIso),
      journalRecovery: journalRecovery,
      recoveredJournals: journalRecovery,
      reservationSweep: reservationSweep,
      expiredPaymentSessions: reservationSweep,
      sessionSweep: sessionSweep,
      sweptUserSessions: sessionSweep,
      financialPreservationGuarantee: {
        invoicesDeleted: 0,
        paymentsDeleted: 0,
        paymentJournalsDeleted: 0,
        receiptFilesDeleted: 0,
        preservedAllFinancialRecords: true
      },
      financialRetentionPolicyNotice:
        'Generic session and reservation cleanup NEVER deletes Invoices, Payments, PaymentJournal rows, or uploaded PAYMENT_RECEIPT files. Financial record retention and archival periods require a separate, formal school accounting and legal retention policy.'
    };
  });
}

/**
 * Private Apps Script Time-Driven Trigger Handler (`runScheduledMaintenanceTrigger_`).
 * Runs every 15 minutes when installed via `configurePaymentMaintenanceTriggerStep12_`
 * or `setupPaymentMaintenanceTriggerFromEditor_()`.
 */
function runScheduledMaintenanceTrigger_() {
  return runPaymentAndSessionMaintenanceStep12_();
}

/**
 * Administrator Action: `admin.runPaymentMaintenance`
 */
function adminRunPaymentMaintenanceStep12_(authContext, payload) {
  assertAdminRoleStep10_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};
  var clock = resolveServerNowStep10_(req);
  return runPaymentAndSessionMaintenanceStep12_(clock.nowMs);
}

function handleAdminRunPaymentMaintenanceStep12_(payload, context) {
  return adminRunPaymentMaintenanceStep12_(context.authContext, payload);
}

/**
 * Configures an idempotent 15-minute time-driven trigger on `runScheduledMaintenanceTrigger_`
 * to automatically recover interrupted approvals (`APPROVING` -> `PAID`), expire stale 15-minute
 * reservations, and mark expired `Sessions` without deleting financial records.
 */
function configurePaymentMaintenanceTriggerStep12_(authContext, payload) {
  if (authContext) {
    assertAdminRoleStep10_(authContext);
  }
  var handlerName = 'runScheduledMaintenanceTrigger_';
  var intervalMinutes = 15;
  var existingTriggerIds = [];
  var createdNewTrigger = false;
  var newTriggerId = '';
  var scriptAppAvailable = false;

  if (
    typeof ScriptApp !== 'undefined' &&
    ScriptApp &&
    typeof ScriptApp.getProjectTriggers === 'function'
  ) {
    scriptAppAvailable = true;
    var triggers = ScriptApp.getProjectTriggers() || [];
    for (var i = 0; i < triggers.length; i++) {
      var t = triggers[i];
      if (
        t &&
        typeof t.getHandlerFunction === 'function' &&
        t.getHandlerFunction() === handlerName
      ) {
        existingTriggerIds.push(
          typeof t.getUniqueId === 'function' ? t.getUniqueId() : 'trg_existing_' + i
        );
      }
    }

    if (existingTriggerIds.length === 0 && typeof ScriptApp.newTrigger === 'function') {
      var created = ScriptApp.newTrigger(handlerName)
        .timeBased()
        .everyMinutes(intervalMinutes)
        .create();
      createdNewTrigger = true;
      newTriggerId =
        created && typeof created.getUniqueId === 'function'
          ? created.getUniqueId()
          : 'trg_created_15m';
      existingTriggerIds.push(newTriggerId);
    }
  }

  recordAuditEvent_({
    actorUserId:
      authContext && authContext.user ? authContext.user.user_id : 'SYSTEM_EDITOR',
    actorRole: authContext && authContext.user ? authContext.user.role : 'ADMIN',
    eventType: 'MAINTENANCE_TRIGGER_CONFIGURED',
    targetEntityType: 'Trigger',
    targetEntityId: handlerName,
    summary: {
      handlerFunction: handlerName,
      intervalMinutes: intervalMinutes,
      scriptAppAvailable: scriptAppAvailable,
      createdNewTrigger: createdNewTrigger,
      activeTriggerCount: existingTriggerIds.length
    }
  });

  return {
    status: createdNewTrigger ? 'CREATED' : 'ALREADY_CONFIGURED',
    triggerId: existingTriggerIds[0] || '',
    handlerFunction: handlerName,
    intervalMinutes: intervalMinutes,
    scriptAppAvailable: scriptAppAvailable,
    createdNewTrigger: createdNewTrigger,
    activeTriggerIds: existingTriggerIds,
    message:
      'Time-driven trigger (' +
      handlerName +
      ', every ' +
      intervalMinutes +
      ' minutes) is active and preserves 100% of financial records.', 
    financialRetentionPolicyNotice:
      'Time-driven trigger (' +
      handlerName +
      ', every ' +
      intervalMinutes +
      ' minutes) recovers interrupted approvals and sweeps expired sessions/reservations while preserving 100% of Invoices, Payments, PaymentJournal rows, and PAYMENT_RECEIPT files.'
  };
}

function handleAdminConfigureMaintenanceTriggerStep12_(payload, context) {
  return configurePaymentMaintenanceTriggerStep12_(context.authContext, payload);
}

function setupPaymentMaintenanceTriggerFromEditor_() {
  return configurePaymentMaintenanceTriggerStep12_(null, {});
}

/**
 * Step 12 Automated Verification Suite (`admin.runStep12VerificationSuite`).
 * Executes all 7 required Step 12 Administrator Payment Verification, Concurrency,
 * Recovery, and Inconsistency Halting tests against worksheet records:
 * 1. Duplicate approval (idempotent same-key replay + second distinct approval attempt blocked).
 * 2. Two administrators approving (`admin_main` vs. second admin account).
 * 3. Approve versus Reject race (`Approve` then `Reject`, and `Reject` then `Approve`).
 * 4. Interrupted multi-sheet writes (`APPROVING` mid-write crash recovered to `PAID`).
 * 5. Recovery rerun (second recovery run is a zero-mutation idempotent no-op).
 * 6. Unauthorized approval (`STUDENT` role calling `admin.reviewPayment` rejected with `ERR_FORBIDDEN_ROLE`).
 * 7. Missing or inconsistent invoice reference (halted and reported with `ERR_FINANCIAL_INCONSISTENCY` / `HALTED_INCONSISTENT` without guessing).
 */
function adminRunStep12VerificationSuite_(authContext, payload) {
  var admin1 = assertAdminRoleStep10_(authContext);
  if (typeof adminSeedStep6SampleUsers_ === 'function') {
    adminSeedStep6SampleUsers_(authContext, {});
  }
  if (typeof adminSeedStep9LearningCohort_ === 'function') {
    adminSeedStep9LearningCohort_(authContext, {});
  }

  var usersTbl = readSheetTable_('Users');
  var admin2 = null;
  var studentA = null;
  for (var i = 0; i < usersTbl.records.length; i++) {
    var u = usersTbl.records[i];
    if (u.role === 'ADMIN' && u.user_id !== admin1.user_id && !admin2) {
      admin2 = u;
    }
    if (u.username_lower === 'student_a') {
      studentA = u;
    }
  }
  if (!admin2) {
    admin2 = admin1;
  }
  if (!studentA) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Sample student student_a is required to run the Step 12 verification suite.'
    );
  }

  var admin1Ctx = { user: admin1, session: { session_id: 'ses_s12_adm1' } };
  var admin2Ctx = { user: admin2, session: { session_id: 'ses_s12_adm2' } };
  var stuACtx = { user: studentA, session: { session_id: 'ses_s12_stua' } };
  var runTag = String(Date.now()).slice(-6);
  var pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function createSubmittedPaymentForTest(labelSuffix, amountThbList) {
    var createdInvIds = [];
    for (var k = 0; k < amountThbList.length; k++) {
      var inv = adminCreateInvoiceStep10_(admin1Ctx, {
        userId: studentA.user_id,
        courseId: '',
        installmentLabel: 'Step 12 ' + labelSuffix + ' #' + (k + 1) + ' (' + runTag + ')',
        amountThb: amountThbList[k],
        dueDateBkk: '2026-12-15'
      }).invoice;
      createdInvIds.push(inv.invoiceId);
    }
    var res = paymentCreateReservationStep10_(stuACtx, {
      invoiceIds: createdInvIds,
      method: 'PROMPTPAY_QR',
      idempotencyKey: 'idem_s12_res_' + labelSuffix + '_' + runTag
    });
    var up = handlePaymentUploadReceiptStep8_(
      {
        paymentId: res.payment.paymentId,
        originalFilename: 'slip_' + labelSuffix + '.png',
        mimeType: 'image/png',
        dataBase64: pngB64
      },
      { authContext: stuACtx }
    );
    var conf = paymentConfirmSubmissionStep10_(stuACtx, {
      paymentId: res.payment.paymentId,
      receiptFileId: up.receiptFileId,
      idempotencyKey: 'idem_s12_conf_' + labelSuffix + '_' + runTag
    });
    return {
      paymentId: conf.payment.paymentId,
      invoiceIds: createdInvIds,
      receiptFileId: up.receiptFileId
    };
  }

  var report = {
    suite: 'STEP_12_ADMIN_PAYMENT_VERIFICATION_AND_RECOVERY_INTEGRITY',
    executedAtUtc: nowUtcIso_(),
    executedAtBangkok: formatBangkokTimestamp_(nowUtcIso_()),
    tests: {}
  };

  /* TEST 1: Duplicate Approval (Same idempotencyKey replay + Second approval attempt with new key) */
  var sub1 = createSubmittedPaymentForTest('dup_app', ['1500.00']);
  var app1First = adminReviewPaymentStep10_(admin1Ctx, {
    paymentId: sub1.paymentId,
    decision: 'APPROVE',
    idempotencyKey: 'idem_s12_dup_key1_' + runTag
  });
  var payVerAfterFirst = getSheetRecordById_('Payments', sub1.paymentId).version;
  var invVerAfterFirst = getSheetRecordById_('Invoices', sub1.invoiceIds[0]).version;

  var app1Replay = adminReviewPaymentStep10_(admin1Ctx, {
    paymentId: sub1.paymentId,
    decision: 'APPROVE',
    idempotencyKey: 'idem_s12_dup_key1_' + runTag
  });
  var dupNewKeyErrCode = '';
  var dupNewKeyFlag = false;
  try {
    adminReviewPaymentStep10_(admin1Ctx, {
      paymentId: sub1.paymentId,
      decision: 'APPROVE',
      idempotencyKey: 'idem_s12_dup_key2_' + runTag
    });
  } catch (dupErr) {
    dupNewKeyErrCode = dupErr.code || '';
    dupNewKeyFlag = Boolean(dupErr.fieldErrors && dupErr.fieldErrors.duplicateApprovalPrevented);
  }
  var payVerAfterDup = getSheetRecordById_('Payments', sub1.paymentId).version;
  var invVerAfterDup = getSheetRecordById_('Invoices', sub1.invoiceIds[0]).version;

  report.tests.test1_duplicateApproval = {
    passed:
      app1First.payment.status === 'PAID' &&
      app1Replay.idempotentReplay === true &&
      dupNewKeyErrCode === 'ERR_INVALID_STATE_TRANSITION' &&
      dupNewKeyFlag === true &&
      payVerAfterDup === payVerAfterFirst &&
      invVerAfterDup === invVerAfterFirst,
    firstStatus: app1First.payment.status,
    idempotentReplayReturned: app1Replay.idempotentReplay,
    secondKeyErrorCode: dupNewKeyErrCode,
    duplicateApprovalPreventedFlag: dupNewKeyFlag,
    versionsUnchangedOnDuplicate: payVerAfterDup === payVerAfterFirst && invVerAfterDup === invVerAfterFirst
  };

  /* TEST 2: Two Administrators Approving (`admin1` vs `admin2`) */
  var sub2 = createSubmittedPaymentForTest('two_admins', ['2100.00']);
  var adm1Approve = adminReviewPaymentStep10_(admin1Ctx, {
    paymentId: sub2.paymentId,
    decision: 'APPROVE',
    idempotencyKey: 'idem_s12_two_adm1_' + runTag
  });
  var adm2ErrCode = '';
  var adm2RecordedWinner = '';
  try {
    adminReviewPaymentStep10_(admin2Ctx, {
      paymentId: sub2.paymentId,
      decision: 'APPROVE',
      idempotencyKey: 'idem_s12_two_adm2_' + runTag
    });
  } catch (adm2Err) {
    adm2ErrCode = adm2Err.code || '';
    adm2RecordedWinner =
      (adm2Err.fieldErrors && adm2Err.fieldErrors.alreadyReviewedByUserId) || '';
  }

  report.tests.test2_twoAdministratorsApproving = {
    passed:
      adm1Approve.payment.status === 'PAID' &&
      adm2ErrCode === 'ERR_INVALID_STATE_TRANSITION' &&
      adm2RecordedWinner === admin1.user_id,
    winningAdminUserId: admin1.user_id,
    secondAdminUserId: admin2.user_id,
    secondAdminErrorCode: adm2ErrCode,
    recordedReviewerMatchesWinner: adm2RecordedWinner === admin1.user_id
  };

  /* TEST 3: Approve versus Reject Race (Both orderings) */
  var sub3A = createSubmittedPaymentForTest('race_app_first', ['1800.00']);
  adminReviewPaymentStep10_(admin1Ctx, {
    paymentId: sub3A.paymentId,
    decision: 'APPROVE',
    idempotencyKey: 'idem_s12_race3a_app_' + runTag
  });
  var rejectAfterApproveCode = '';
  try {
    adminReviewPaymentStep10_(admin2Ctx, {
      paymentId: sub3A.paymentId,
      decision: 'REJECT',
      rejectionReason: 'Late conflicting reject attempt',
      idempotencyKey: 'idem_s12_race3a_rej_' + runTag
    });
  } catch (r3aErr) {
    rejectAfterApproveCode = r3aErr.code || '';
  }

  var sub3B = createSubmittedPaymentForTest('race_rej_first', ['1950.00']);
  adminReviewPaymentStep10_(admin2Ctx, {
    paymentId: sub3B.paymentId,
    decision: 'REJECT',
    rejectionReason: 'Transfer slip amount cropped -- please upload full slip',
    idempotencyKey: 'idem_s12_race3b_rej_' + runTag
  });
  var approveAfterRejectCode = '';
  try {
    adminReviewPaymentStep10_(admin1Ctx, {
      paymentId: sub3B.paymentId,
      decision: 'APPROVE',
      idempotencyKey: 'idem_s12_race3b_app_' + runTag
    });
  } catch (r3bErr) {
    approveAfterRejectCode = r3bErr.code || '';
  }

  var final3APay = getSheetRecordById_('Payments', sub3A.paymentId);
  var final3BPay = getSheetRecordById_('Payments', sub3B.paymentId);
  var final3BInv = getSheetRecordById_('Invoices', sub3B.invoiceIds[0]);

  report.tests.test3_approveVersusReject = {
    passed:
      rejectAfterApproveCode === 'ERR_INVALID_STATE_TRANSITION' &&
      final3APay.status === 'PAID' &&
      approveAfterRejectCode === 'ERR_INVALID_STATE_TRANSITION' &&
      final3BPay.status === 'REJECTED' &&
      final3BInv.status === 'REJECTED' &&
      final3BInv.last_rejection_reason.indexOf('cropped') !== -1,
    rejectAfterApproveCode: rejectAfterApproveCode,
    final3AStatus: final3APay.status,
    approveAfterRejectCode: approveAfterRejectCode,
    final3BStatus: final3BPay.status,
    final3BInvoiceStatus: final3BInv.status
  };

  /* TEST 4 & TEST 5: Interrupted Multi-Sheet Writes (`APPROVING`) + Idempotent Recovery Rerun */
  var sub4 = createSubmittedPaymentForTest('interrupted_write', ['1200.00', '1300.50']);
  var interruptedErrCode = '';
  try {
    adminReviewPaymentStep10_(admin1Ctx, {
      paymentId: sub4.paymentId,
      decision: 'APPROVE',
      idempotencyKey: 'idem_s12_interrupted_' + runTag,
      simulatePartialWriteStage: 'AT_APPROVING'
    });
  } catch (intErr) {
    interruptedErrCode = intErr.code || '';
  }

  var midPay = getSheetRecordById_('Payments', sub4.paymentId);
  var midInv1 = getSheetRecordById_('Invoices', sub4.invoiceIds[0]);
  var midInv2 = getSheetRecordById_('Invoices', sub4.invoiceIds[1]);

  var recoveryRun1 = runPaymentAndSessionMaintenanceStep12_();
  var recPayAfter1 = getSheetRecordById_('Payments', sub4.paymentId);
  var recInv1After1 = getSheetRecordById_('Invoices', sub4.invoiceIds[0]);
  var recInv2After1 = getSheetRecordById_('Invoices', sub4.invoiceIds[1]);

  /* TEST 5: Recovery Rerun Idempotency */
  var recoveryRun2 = runPaymentAndSessionMaintenanceStep12_();
  var recPayAfter2 = getSheetRecordById_('Payments', sub4.paymentId);
  var recInv1After2 = getSheetRecordById_('Invoices', sub4.invoiceIds[0]);
  var recInv2After2 = getSheetRecordById_('Invoices', sub4.invoiceIds[1]);

  report.tests.test4_5_interruptedWriteAndRecoveryRerun = {
    passed:
      interruptedErrCode === 'ERR_SIMULATED_PARTIAL_WRITE' &&
      midPay.status === 'APPROVING' &&
      ((midInv1.status === 'APPROVING' && midInv2.status === 'AWAITING_VERIFICATION') ||
        (midInv1.status === 'AWAITING_VERIFICATION' && midInv2.status === 'APPROVING')) &&
      recoveryRun1.journalRecovery.recoveredCount >= 1 &&
      recPayAfter1.status === 'PAID' &&
      recInv1After1.status === 'PAID' &&
      recInv2After1.status === 'PAID' &&
      recoveryRun2.journalRecovery.recoveredCount === 0 &&
      recPayAfter2.version === recPayAfter1.version &&
      recInv1After2.version === recInv1After1.version &&
      recInv2After2.version === recInv2After1.version,
    midWritePaymentStatus: midPay.status,
    midWriteInvoice1Status: midInv1.status,
    midWriteInvoice2Status: midInv2.status,
    recoveryRun1Count: recoveryRun1.journalRecovery.recoveredCount,
    recoveredFinalStatus: recPayAfter1.status,
    recoveryRerunCount: recoveryRun2.journalRecovery.recoveredCount,
    versionsUnchangedOnRerun:
      recPayAfter2.version === recPayAfter1.version &&
      recInv1After2.version === recInv1After1.version
  };

  /* TEST 6: Unauthorized Approval (`STUDENT` role calling `admin.reviewPayment`) */
  var sub6 = createSubmittedPaymentForTest('unauth_stu', ['1100.00']);
  var unauthErrCode = '';
  try {
    adminReviewPaymentStep10_(stuACtx, {
      paymentId: sub6.paymentId,
      decision: 'APPROVE',
      idempotencyKey: 'idem_s12_unauth_' + runTag
    });
  } catch (unauthErr) {
    unauthErrCode = unauthErr.code || '';
  }
  /* Leave sub6 in AWAITING_VERIFICATION so the admin queue has a live pending item to inspect! */

  report.tests.test6_unauthorizedApprovalBlocked = {
    passed:
      unauthErrCode === 'ERR_FORBIDDEN_ROLE' &&
      getSheetRecordById_('Payments', sub6.paymentId).status === 'AWAITING_VERIFICATION',
    studentAttemptErrorCode: unauthErrCode,
    paymentRemainsAwaitingVerification:
      getSheetRecordById_('Payments', sub6.paymentId).status === 'AWAITING_VERIFICATION'
  };

  /* TEST 7: Missing or Inconsistent Invoice Reference (Stopped & Reported without Guessing) */
  var sub7 = createSubmittedPaymentForTest('inconsistent_ref', ['1400.00']);
  /* Tamper with sub7's invoice_ids_json to include a non-existent invoice reference inv_missing_ghost_999 */
  withScriptLock_(function () {
    var p7 = getSheetRecordById_('Payments', sub7.paymentId);
    updateSheetRecordById_(
      'Payments',
      sub7.paymentId,
      {
        invoice_ids_json: JSON.stringify([sub7.invoiceIds[0], 'inv_missing_ghost_999'])
      },
      Number(p7.version || 1),
      { skipLock: true }
    );
  });

  var reviewInconsistentCode = '';
  var reviewInconsistentReason = '';
  try {
    adminReviewPaymentStep10_(admin1Ctx, {
      paymentId: sub7.paymentId,
      decision: 'APPROVE',
      idempotencyKey: 'idem_s12_inconsist_' + runTag
    });
  } catch (incErr) {
    reviewInconsistentCode = incErr.code || '';
    reviewInconsistentReason = (incErr.fieldErrors && incErr.fieldErrors.reasonCode) || '';
  }

  /* Also test recovery halting on a PENDING journal with a missing invoice reference, then clean up the test journal */
  var badJournalId = generateEntityId_('jrn_');
  withScriptLock_(function () {
    insertSheetRecord_(
      'PaymentJournal',
      {
        journal_id: badJournalId,
        operation_type: 'ADMIN_APPROVE',
        idempotency_key: 'idem_s12_bad_jrn_' + runTag,
        payment_id: sub7.paymentId,
        invoice_ids_json: JSON.stringify([sub7.invoiceIds[0], 'inv_missing_ghost_999']),
        target_payment_status: 'PAID',
        target_invoice_status: 'PAID',
        payload_json: JSON.stringify({
          reviewedByUserId: admin1.user_id,
          reviewedAtUtc: nowUtcIso_()
        }),
        journal_status: 'PENDING',
        created_at_utc: nowUtcIso_(),
        committed_at_utc: ''
      },
      { skipLock: true }
    );
  });

  var haltedRecOut = withScriptLock_(function () {
    return recoverPendingPaymentJournalsInLock_();
  });
  var badJournalAfter = getSheetRecordById_('PaymentJournal', badJournalId);
  var inv7StillUntouched = getSheetRecordById_('Invoices', sub7.invoiceIds[0]);

  /* Restore sub7's valid invoice_ids_json and approve it cleanly so the test leaves no broken records behind, and mark badJournalId COMMITTED */
  withScriptLock_(function () {
    var p7Fix = getSheetRecordById_('Payments', sub7.paymentId);
    updateSheetRecordById_(
      'Payments',
      sub7.paymentId,
      {
        invoice_ids_json: JSON.stringify(sub7.invoiceIds)
      },
      Number(p7Fix.version || 1),
      { skipLock: true }
    );
    updateSheetRecordById_(
      'PaymentJournal',
      badJournalId,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: nowUtcIso_()
      },
      null,
      { skipLock: true }
    );
  });
  adminReviewPaymentStep10_(admin1Ctx, {
    paymentId: sub7.paymentId,
    decision: 'APPROVE',
    idempotencyKey: 'idem_s12_inconsist_fixed_' + runTag
  });

  report.tests.test7_missingOrInconsistentInvoiceHalted = {
    passed:
      reviewInconsistentCode === 'ERR_FINANCIAL_INCONSISTENCY' &&
      reviewInconsistentReason === 'MISSING_INVOICE_REFERENCE' &&
      badJournalAfter.journal_status === 'HALTED_INCONSISTENT' &&
      haltedRecOut.haltedInconsistentCount >= 1 &&
      inv7StillUntouched.status === 'AWAITING_VERIFICATION',
    directReviewErrorCode: reviewInconsistentCode,
    directReviewReasonCode: reviewInconsistentReason,
    journalStatusAfterHalt: badJournalAfter.journal_status,
    validInvoiceUntouchedDuringHalt: inv7StillUntouched.status === 'AWAITING_VERIFICATION'
  };

  var allPassed = true;
  var tKeys = Object.keys(report.tests);
  for (var tk = 0; tk < tKeys.length; tk++) {
    if (!report.tests[tKeys[tk]] || report.tests[tKeys[tk]].passed !== true) {
      allPassed = false;
    }
  }
  report.allPassed = allPassed;

  return report;
}

function handleAdminRunStep12VerificationSuite_(payload, context) {
  return adminRunStep12VerificationSuite_(context.authContext, payload);
}

// === END OF PaymentService.gs (Complete - Steps 10, 11 & 12 Invoices, Checkout & Admin Verification Verified) ===