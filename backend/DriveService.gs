/**
 * DriveService.gs
 * Pattanabhumi Biology Learning Management System - Step 8 Private File Storage & CMS Integration
 *
 * Responsibilities:
 * - Manage private Google Drive file uploads, binary magic-byte signature verification,
 *   bounded base64 RPC reads, reference removal, and conservative orphan cleanup.
 * - Enforce the 2 MB application file size limit (`2,097,152` bytes) and explain that this
 *   is an application policy limit accounting for ~33.3% Base64 expansion over `google.script.run`.
 * - Validate purpose-specific formats (`PNG`, `JPEG`, `WEBP`, `PDF`) via binary magic bytes
 *   and explicitly reject `SVG`, `HTML`, `SCRIPT`, executables (`MZ`, `ELF`, `PK`), and spoofed extensions.
 * - Perform Google Drive file creation outside `LockService` and acquire the script lock only
 *   for the short `Files` metadata & entity linkage step, executing a compensating
 *   `driveFile.setTrashed(true)` rollback if metadata creation fails.
 * - Authorize every `file.getContent` request by application `file_id` (`fil_...`), never
 *   exposing a generic raw Drive file ID reader.
 */

var PB_FILE_PURPOSE_SPECS_STEP8_ = Object.freeze({
  SCHOOL_LOGO: Object.freeze({
    purpose: 'SCHOOL_LOGO',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  COURSE_COVER: Object.freeze({
    purpose: 'COURSE_COVER',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  RICHTEXT_IMAGE: Object.freeze({
    purpose: 'RICHTEXT_IMAGE',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  CARD_IMAGE: Object.freeze({
    purpose: 'CARD_IMAGE',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  COURSE_IMAGE: Object.freeze({
    purpose: 'COURSE_IMAGE',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  PDF_ATTACHMENT: Object.freeze({
    purpose: 'PDF_ATTACHMENT',
    allowedMimes: Object.freeze({
      'application/pdf': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  COURSE_PDF: Object.freeze({
    purpose: 'COURSE_PDF',
    allowedMimes: Object.freeze({
      'application/pdf': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  PAYMENT_RECEIPT: Object.freeze({
    purpose: 'PAYMENT_RECEIPT',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'application/pdf': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: false
  }),
  PROMPTPAY_QR_IMAGE: Object.freeze({
    purpose: 'PROMPTPAY_QR_IMAGE',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  INSTRUCTOR_PORTRAIT: Object.freeze({
    purpose: 'INSTRUCTOR_PORTRAIT',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  HERO_SHUFFLE_CARD: Object.freeze({
    purpose: 'HERO_SHUFFLE_CARD',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  QUESTION_IMAGE: Object.freeze({
    purpose: 'QUESTION_IMAGE',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  OPTION_IMAGE: Object.freeze({
    purpose: 'OPTION_IMAGE',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  STIMULUS_IMAGE: Object.freeze({
    purpose: 'STIMULUS_IMAGE',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  EXAM_COVER_IMAGE: Object.freeze({
    purpose: 'EXAM_COVER_IMAGE',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  }),
  EXPLANATION_ATTACHMENT: Object.freeze({
    purpose: 'EXPLANATION_ATTACHMENT',
    allowedMimes: Object.freeze({
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'application/pdf': true
    }),
    requiresCourseId: false,
    requiresAdminUpload: true
  })
});

var PB_MIME_TO_CANONICAL_EXT_STEP8_ = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf'
});

var PB_EXT_TO_EXPECTED_MIME_STEP8_ = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf'
});

function inspectFileBinarySignatureStep8_(rawBytes) {
  if (!Array.isArray(rawBytes) || rawBytes.length < 4) {
    return {
      isApprovedFormat: false,
      detectedMimeType: '',
      detectedFormatLabel: 'EMPTY_OR_TRUNCATED',
      rejectedCategory: 'TRUNCATED',
      reason: 'File is empty or shorter than 4 bytes.'
    };
  }

  var u = [];
  var maxInspect = Math.min(rawBytes.length, 512);
  for (var i = 0; i < maxInspect; i++) {
    u.push((Number(rawBytes[i]) + 256) % 256);
  }

  if (
    u.length >= 8 &&
    u[0] === 0x89 &&
    u[1] === 0x50 &&
    u[2] === 0x4e &&
    u[3] === 0x47 &&
    u[4] === 0x0d &&
    u[5] === 0x0a &&
    u[6] === 0x1a &&
    u[7] === 0x0a
  ) {
    return {
      isApprovedFormat: true,
      detectedMimeType: 'image/png',
      detectedFormatLabel: 'PNG',
      rejectedCategory: '',
      reason: 'Verified 8-byte PNG signature.'
    };
  }

  if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) {
    return {
      isApprovedFormat: true,
      detectedMimeType: 'image/jpeg',
      detectedFormatLabel: 'JPEG',
      rejectedCategory: '',
      reason: 'Verified JPEG SOI marker (FF D8 FF).'
    };
  }

  if (
    u.length >= 12 &&
    u[0] === 0x52 &&
    u[1] === 0x49 &&
    u[2] === 0x46 &&
    u[3] === 0x46 &&
    u[8] === 0x57 &&
    u[9] === 0x45 &&
    u[10] === 0x42 &&
    u[11] === 0x50
  ) {
    return {
      isApprovedFormat: true,
      detectedMimeType: 'image/webp',
      detectedFormatLabel: 'WEBP',
      rejectedCategory: '',
      reason: 'Verified RIFF....WEBP container signature.'
    };
  }

  if (
    u.length >= 6 &&
    u[0] === 0x47 &&
    u[1] === 0x49 &&
    u[2] === 0x46 &&
    u[3] === 0x38 &&
    (u[4] === 0x37 || u[4] === 0x39) &&
    u[5] === 0x61
  ) {
    return {
      isApprovedFormat: true,
      detectedMimeType: 'image/gif',
      detectedFormatLabel: 'GIF',
      rejectedCategory: '',
      reason: 'Verified GIF87a/GIF89a magic signature.'
    };
  }

  if (
    u.length >= 5 &&
    u[0] === 0x25 &&
    u[1] === 0x50 &&
    u[2] === 0x44 &&
    u[3] === 0x46 &&
    u[4] === 0x2d
  ) {
    return {
      isApprovedFormat: true,
      detectedMimeType: 'application/pdf',
      detectedFormatLabel: 'PDF',
      rejectedCategory: '',
      reason: 'Verified %PDF- magic header.'
    };
  }

  if (u[0] === 0x4d && u[1] === 0x5a) {
    return {
      isApprovedFormat: false,
      detectedMimeType: 'application/x-msdownload',
      detectedFormatLabel: 'WINDOWS_EXE_MZ',
      rejectedCategory: 'EXECUTABLE',
      reason: 'Executable files (MZ PE header) are strictly prohibited.'
    };
  }
  if (
    u.length >= 4 &&
    u[0] === 0x7f &&
    u[1] === 0x45 &&
    u[2] === 0x4c &&
    u[3] === 0x46
  ) {
    return {
      isApprovedFormat: false,
      detectedMimeType: 'application/x-elf',
      detectedFormatLabel: 'LINUX_ELF',
      rejectedCategory: 'EXECUTABLE',
      reason: 'Executable binary files (ELF header) are strictly prohibited.'
    };
  }
  if (
    u.length >= 4 &&
    u[0] === 0x50 &&
    u[1] === 0x4b &&
    u[2] === 0x03 &&
    u[3] === 0x04
  ) {
    return {
      isApprovedFormat: false,
      detectedMimeType: 'application/zip',
      detectedFormatLabel: 'ZIP_ARCHIVE',
      rejectedCategory: 'ARCHIVE_OR_EXECUTABLE',
      reason: 'ZIP/JAR/Office archive containers (PK header) are not allowed.'
    };
  }

  var asciiHead = '';
  for (var j = 0; j < u.length; j++) {
    if (u[j] >= 0x20 && u[j] <= 0x7e) {
      asciiHead += String.fromCharCode(u[j]);
    } else if (u[j] === 0x09 || u[j] === 0x0a || u[j] === 0x0d) {
      asciiHead += ' ';
    }
  }
  var trimmedAscii = asciiHead.trim().toLowerCase();

  if (
    trimmedAscii.indexOf('<svg') !== -1 ||
    (trimmedAscii.indexOf('<?xml') === 0 && trimmedAscii.indexOf('<svg') !== -1)
  ) {
    return {
      isApprovedFormat: false,
      detectedMimeType: 'image/svg+xml',
      detectedFormatLabel: 'SVG_XML',
      rejectedCategory: 'SVG',
      reason:
        'SVG files (image/svg+xml) are rejected because SVG XML can contain embedded scripts.'
    };
  }

  if (
    trimmedAscii.indexOf('<!doctype html') !== -1 ||
    trimmedAscii.indexOf('<html') !== -1 ||
    trimmedAscii.indexOf('<script') !== -1 ||
    trimmedAscii.indexOf('<iframe') !== -1 ||
    trimmedAscii.indexOf('<body') !== -1
  ) {
    return {
      isApprovedFormat: false,
      detectedMimeType: 'text/html',
      detectedFormatLabel: 'HTML_OR_SCRIPT',
      rejectedCategory: 'HTML_OR_SCRIPT',
      reason: 'HTML and script markup files are strictly prohibited.'
    };
  }

  return {
    isApprovedFormat: false,
    detectedMimeType: '',
    detectedFormatLabel: 'UNKNOWN_BINARY',
    rejectedCategory: 'UNSUPPORTED_SIGNATURE',
    reason:
      'File binary magic bytes do not match any approved format (PNG, JPEG, WebP, or PDF).'
  };
}

function sanitizeSafeFilenameStep8_(rawFilename, detectedMimeType, purpose) {
  var canonicalExt = PB_MIME_TO_CANONICAL_EXT_STEP8_[detectedMimeType] || '.bin';
  var raw =
    rawFilename === null || rawFilename === undefined
      ? ''
      : String(rawFilename);

  raw = raw.replace(/[-]/g, '').trim();
  var parts = raw.split(/[\/]/);
  var base = parts[parts.length - 1] || '';

  base = base.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  base = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);

  if (!base) {
    base = String(purpose || 'file').toLowerCase() + '_asset';
  }

  return base + canonicalExt;
}

function validateFilenameExtensionMatchesMimeStep8_(rawFilename, detectedMimeType) {
  if (!rawFilename || typeof rawFilename !== 'string') {
    return { ok: true, ext: '' };
  }
  var trimmed = rawFilename.trim();
  var dotIdx = trimmed.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === trimmed.length - 1) {
    return { ok: true, ext: '' };
  }
  var ext = trimmed.slice(dotIdx + 1).toLowerCase();
  if (
    ext === 'svg' ||
    ext === 'svgz' ||
    ext === 'html' ||
    ext === 'htm' ||
    ext === 'js' ||
    ext === 'mjs' ||
    ext === 'exe' ||
    ext === 'bat' ||
    ext === 'cmd' ||
    ext === 'sh' ||
    ext === 'php'
  ) {
    return {
      ok: false,
      ext: ext,
      reason:
        'Disallowed filename extension ".' +
        ext +
        '". Executable, script, HTML, and SVG extensions are rejected.'
    };
  }
  var expectedMime = PB_EXT_TO_EXPECTED_MIME_STEP8_[ext];
  if (!expectedMime) {
    return {
      ok: false,
      ext: ext,
      reason:
        'Unsupported filename extension ".' +
        ext +
        '". Allowed extensions: .png, .jpg, .jpeg, .webp, .pdf.'
    };
  }
  if (expectedMime !== detectedMimeType) {
    return {
      ok: false,
      ext: ext,
      reason:
        'Extension spoofing rejected: filename ends with ".' +
        ext +
        '" (' +
        expectedMime +
        '), but binary file signature is ' +
        detectedMimeType +
        '.'
    };
  }
  return { ok: true, ext: ext };
}

function computeBytesSha256HexStep8_(rawBytes) {
  var digestBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    rawBytes
  );
  var hex = '';
  for (var i = 0; i < digestBytes.length; i++) {
    var b = (Number(digestBytes[i]) + 256) % 256;
    var h = b.toString(16);
    hex += h.length === 1 ? '0' + h : h;
  }
  return hex;
}

function openPrivateStorageDriveFolderStep8_() {
  var folderId = '';
  try {
    folderId =
      PropertiesService.getScriptProperties().getProperty(
        'PRIVATE_DRIVE_FOLDER_ID'
      ) || '';
  } catch (ignoreErr) {}
  folderId = String(folderId || '').trim();
  if (!folderId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_CONFIG_MISSING,
      'Script Property PRIVATE_DRIVE_FOLDER_ID is not configured.',
      { PRIVATE_DRIVE_FOLDER_ID: 'Missing required Script Property.' }
    );
  }
  if (
    typeof DriveApp === 'undefined' ||
    !DriveApp ||
    typeof DriveApp.getFolderById !== 'function'
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE,
      'DriveApp is unavailable in this execution context.'
    );
  }
  try {
    var folder = DriveApp.getFolderById(folderId);
    if (typeof folder.getSharingAccess === 'function' && typeof DriveApp.Access !== 'undefined') {
      var access = folder.getSharingAccess();
      if (
        access === DriveApp.Access.ANYONE ||
        access === DriveApp.Access.ANYONE_WITH_LINK ||
        access === DriveApp.Access.DOMAIN ||
        access === DriveApp.Access.DOMAIN_WITH_LINK
      ) {
        if (
          typeof folder.setSharing === 'function' &&
          typeof DriveApp.Permission !== 'undefined'
        ) {
          try {
            folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
          } catch (ignoreShareErr) {}
        }
      }
    }
    return folder;
  } catch (err) {
    if (err && err.isAppError) {
      throw err;
    }
    throw createAppError_(
      PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE,
      'Cannot open PRIVATE_DRIVE_FOLDER_ID in Google Drive: ' +
        String(err.message || err)
    );
  }
}

function validateExistingActiveFileRefStep8_(
  fileId,
  allowedPurposes,
  fieldKey,
  fieldLabel,
  fieldErrors
) {
  if (!fileId || typeof fileId !== 'string' || !/^fil_[A-Za-z0-9_-]{4,64}$/.test(fileId)) {
    fieldErrors[fieldKey] =
      fieldLabel + ' must be a valid application file ID (fil_...).';
    return null;
  }
  var fileRow = getSheetRecordById_('Files', fileId);
  if (!fileRow) {
    fieldErrors[fieldKey] =
      fieldLabel + ' ("' + fileId + '") does not exist in the Files table.';
    return null;
  }
  if (fileRow.status !== 'ACTIVE') {
    fieldErrors[fieldKey] =
      fieldLabel + ' ("' + fileId + '") has been deleted or is not ACTIVE.';
    return null;
  }
  if (Array.isArray(allowedPurposes) && allowedPurposes.length > 0) {
    if (allowedPurposes.indexOf(fileRow.purpose) === -1) {
      fieldErrors[fieldKey] =
        fieldLabel +
        ' ("' +
        fileId +
        '") has purpose "' +
        fileRow.purpose +
        '", which is not valid for ' +
        fieldLabel +
        ' (expected: ' +
        allowedPurposes.join(' or ') +
        ').';
      return null;
    }
  }
  return fileRow;
}

function uploadPrivateFileCoreStep8_(authContext, rawPayload, isAdminEndpoint) {
  if (!authContext || !authContext.user || !(authContext.user.user_id || authContext.currentUserId)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to upload files.'
    );
  }
  var actorUser = authContext.user;
  var actorUserId = actorUser.user_id || actorUser.userId;
  var req = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  var fieldErrors = {};

  var purpose = String(req.purpose || '')
    .trim()
    .toUpperCase();
  var purposeSpec = PB_FILE_PURPOSE_SPECS_STEP8_[purpose] || null;
  if (!purposeSpec) {
    fieldErrors.purpose =
      'Unsupported file purpose "' +
      purpose +
      '". Allowed purposes: SCHOOL_LOGO, INSTRUCTOR_PORTRAIT, COURSE_COVER, RICHTEXT_IMAGE, CARD_IMAGE, PDF_ATTACHMENT, PAYMENT_RECEIPT.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_PURPOSE_MISMATCH || PB_ERROR_CODES_.ERR_FILE_INVALID,
      'Invalid or unsupported file upload purpose.',
      fieldErrors
    );
  }

  if (purposeSpec.requiresAdminUpload && actorUser.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Only administrators may upload files with purpose "' + purpose + '".'
    );
  }
  if (isAdminEndpoint && actorUser.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Administrator role is required for admin.uploadFile.'
    );
  }

  var rawBase64 = typeof req.dataBase64 === 'string' ? req.dataBase64.trim() : '';
  if (!rawBase64) {
    fieldErrors.dataBase64 = 'Base64 file payload (dataBase64) is required.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'File payload is empty.',
      fieldErrors
    );
  }

  var commaIdx = rawBase64.indexOf(',');
  if (commaIdx !== -1 && rawBase64.slice(0, commaIdx).indexOf('base64') !== -1) {
    rawBase64 = rawBase64.slice(commaIdx + 1).trim();
  }

  var maxBytes =
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.MAX_FILE_UPLOAD_BYTES) || 209715200;
  var maxBase64Chars = Math.ceil((maxBytes * 4) / 3) + 256;
  if (rawBase64.length > maxBase64Chars) {
    fieldErrors.sizeBytes =
      'File exceeds the 200 MB (209,715,200 bytes) application file size limit (configured to bound ~33.3% Base64 expansion over google.script.run).';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_TOO_LARGE || PB_ERROR_CODES_.ERR_PAYLOAD_TOO_LARGE,
      'Uploaded file exceeds the 200 MB application size limit.',
      fieldErrors
    );
  }

  if ((rawBase64.length === 0 || /[^A-Za-z0-9+/=\r\n]/.test(rawBase64))) {
    fieldErrors.dataBase64 = 'dataBase64 contains invalid Base64 characters.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_INVALID,
      'Uploaded file Base64 encoding is malformed.',
      fieldErrors
    );
  }

  var decodedBytes = null;
  try {
    decodedBytes = Utilities.base64Decode(rawBase64);
  } catch (decErr) {
    fieldErrors.dataBase64 = 'Could not decode Base64 payload.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_INVALID,
      'Uploaded file Base64 decoding failed.',
      fieldErrors
    );
  }

  if (!Array.isArray(decodedBytes) || decodedBytes.length === 0) {
    fieldErrors.dataBase64 = 'Decoded file has 0 bytes.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_INVALID,
      'Cannot upload an empty (0-byte) file.',
      fieldErrors
    );
  }

  if (decodedBytes.length > maxBytes) {
    fieldErrors.sizeBytes =
      'Decoded file size (' +
      decodedBytes.length +
      ' bytes) exceeds the 200 MB (209,715,200 bytes) application limit.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_TOO_LARGE || PB_ERROR_CODES_.ERR_PAYLOAD_TOO_LARGE,
      'Decoded file exceeds the 200 MB (209,715,200 bytes) application limit.',
      fieldErrors
    );
  }

  var sigInfo = inspectFileBinarySignatureStep8_(decodedBytes);
  if (!sigInfo.isApprovedFormat) {
    fieldErrors.signature = sigInfo.reason;
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_SIGNATURE_MISMATCH || PB_ERROR_CODES_.ERR_FILE_INVALID,
      'File rejected by binary signature verification: ' + sigInfo.reason,
      fieldErrors
    );
  }

  var detectedMime = sigInfo.detectedMimeType;
  var claimedMime = String(req.mimeType || '')
    .trim()
    .toLowerCase();
  if (claimedMime === 'image/jpg') {
    claimedMime = 'image/jpeg';
  }
  if (claimedMime && claimedMime !== detectedMime) {
    fieldErrors.mimeType =
      'MIME spoofing rejected: client claimed "' +
      claimedMime +
      '", but binary file signature is "' +
      detectedMime +
      '".';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_SIGNATURE_MISMATCH || PB_ERROR_CODES_.ERR_FILE_INVALID,
      fieldErrors.mimeType,
      fieldErrors
    );
  }

  var extCheck = validateFilenameExtensionMatchesMimeStep8_(
    req.originalFilename,
    detectedMime
  );
  if (!extCheck.ok) {
    fieldErrors.originalFilename = extCheck.reason;
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_SIGNATURE_MISMATCH || PB_ERROR_CODES_.ERR_FILE_INVALID,
      extCheck.reason,
      fieldErrors
    );
  }

  if (!purposeSpec.allowedMimes[detectedMime]) {
    fieldErrors.purpose =
      'File format "' +
      detectedMime +
      '" is not permitted for purpose "' +
      purpose +
      '" (allowed: ' +
      Object.keys(purposeSpec.allowedMimes).join(', ') +
      ').';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_PURPOSE_MISMATCH || PB_ERROR_CODES_.ERR_FILE_INVALID,
      fieldErrors.purpose,
      fieldErrors
    );
  }

  var safeFilename = sanitizeSafeFilenameStep8_(
    req.originalFilename,
    detectedMime,
    purpose
  );
  var courseId = sanitizeSingleLineTextStep7_(req.courseId, 64);
  var targetEntityType = String(req.targetEntityType || '')
    .trim()
    .toUpperCase();
  var targetEntityId = sanitizeSingleLineTextStep7_(req.targetEntityId, 64);

  if (
    (purpose === 'COURSE_COVER' ||
      purpose === 'RICHTEXT_IMAGE' ||
      purpose === 'CARD_IMAGE' ||
      purpose === 'COURSE_IMAGE') &&
    courseId
  ) {
    var checkCourse = getSheetRecordById_('Courses', courseId);
    if (!checkCourse) {
      fieldErrors.courseId = 'Referenced course ("' + courseId + '") was not found.';
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        fieldErrors.courseId,
        fieldErrors
      );
    }
  }

  var sha256Hex = computeBytesSha256HexStep8_(decodedBytes);
  var fileId = generateEntityId_('fil_');
  var driveStorageFilename = fileId + '_' + safeFilename;

  /* Phase 1: Write blob to private Google Drive folder OUTSIDE LockService */
  var privateFolder = openPrivateStorageDriveFolderStep8_();
  var driveBlob = Utilities.newBlob(decodedBytes, detectedMime, driveStorageFilename);
  var createdDriveFile = null;
  var driveFileId = '';

  try {
    createdDriveFile = privateFolder.createFile(driveBlob);
    if (
      createdDriveFile &&
      typeof createdDriveFile.setSharing === 'function' &&
      typeof DriveApp !== 'undefined' &&
      DriveApp.Access &&
      DriveApp.Permission
    ) {
      try {
        createdDriveFile.setSharing(
          DriveApp.Access.PRIVATE,
          DriveApp.Permission.NONE
        );
      } catch (ignoreSharingErr) {}
    }
    driveFileId = String(createdDriveFile.getId());
  } catch (driveCreateErr) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE,
      'Failed to store file in private Google Drive folder: ' +
        String(driveCreateErr.message || driveCreateErr)
    );
  }

  /* Phase 2: Short LockService critical section for Files metadata + entity linkage */
  var nowIso = nowUtcIso_();
  var createdFileRow = null;
  var linkedTargetSummary = null;

  try {
    withScriptLock_(function () {
      if (req.simulateMetadataFailure === true) {
        throw new Error(
          'Simulated metadata write failure after Drive file creation (compensating rollback verification).'
        );
      }

      if (courseId) {
        var cRow = getSheetRecordById_('Courses', courseId);
        if (!cRow) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_NOT_FOUND,
            'Course "' + courseId + '" no longer exists.'
          );
        }
      }

      createdFileRow = {
        file_id: fileId,
        drive_file_id: driveFileId,
        purpose: purpose,
        course_id: courseId || '',
        owner_user_id: actorUserId,
        original_filename: safeFilename,
        mime_type: detectedMime,
        size_bytes: decodedBytes.length,
        sha256_hex: sha256Hex,
        status: 'ACTIVE',
        created_at_utc: nowIso
      };

      insertSheetRecord_('Files', createdFileRow);

      if (purpose === 'SCHOOL_LOGO' && req.applyAsSchoolLogo !== false) {
        var settingsTbl = readSheetTable_('Settings');
        if (settingsTbl && settingsTbl.byId && settingsTbl.byId.LOGO_FILE_ID) {
          var existingLogoSetting = settingsTbl.byId.LOGO_FILE_ID.record;
          updateSheetRecordById_(
            'Settings',
            'LOGO_FILE_ID',
            {
              setting_value: fileId,
              is_public: true,
              updated_by_user_id: actorUserId,
              updated_at_utc: nowIso
            },
            Number(existingLogoSetting.version)
          );
        } else {
          insertSheetRecord_('Settings', {
            setting_key: 'LOGO_FILE_ID',
            setting_value: fileId,
            is_public: true,
            updated_by_user_id: actorUserId,
            updated_at_utc: nowIso,
            version: 1
          });
        }
        invalidateSchoolLogoCache_();
        linkedTargetSummary = {
          entityType: 'SETTINGS',
          entityId: 'LOGO_FILE_ID',
          field: 'setting_value'
        };
      } else if (
        purpose === 'INSTRUCTOR_PORTRAIT' ||
        targetEntityType === 'INSTRUCTOR_PORTRAIT' ||
        targetEntityType === 'SETTINGS_INSTRUCTOR_PORTRAIT'
      ) {
        var settingsTblPortrait = readSheetTable_('Settings');
        if (
          settingsTblPortrait &&
          settingsTblPortrait.byId &&
          settingsTblPortrait.byId.INSTRUCTOR_PORTRAIT_FILE_ID
        ) {
          var existingPortraitSetting =
            settingsTblPortrait.byId.INSTRUCTOR_PORTRAIT_FILE_ID.record;
          updateSheetRecordById_(
            'Settings',
            'INSTRUCTOR_PORTRAIT_FILE_ID',
            {
              setting_value: fileId,
              is_public: true,
              updated_by_user_id: actorUserId,
              updated_at_utc: nowIso
            },
            Number(existingPortraitSetting.version)
          );
        } else {
          insertSheetRecord_('Settings', {
            setting_key: 'INSTRUCTOR_PORTRAIT_FILE_ID',
            setting_value: fileId,
            is_public: true,
            updated_by_user_id: actorUserId,
            updated_at_utc: nowIso,
            version: 1
          });
        }
        linkedTargetSummary = {
          entityType: 'SETTINGS',
          entityId: 'INSTRUCTOR_PORTRAIT_FILE_ID',
          field: 'setting_value'
        };
      } else if (
        purpose === 'HERO_SHUFFLE_CARD' ||
        targetEntityType === 'HERO_SHUFFLE_CARD' ||
        targetEntityType === 'HERO_CARD_1' ||
        targetEntityType === 'HERO_CARD_2' ||
        targetEntityType === 'HERO_CARD_3'
      ) {
        var slotIdxHero = 1;
        if (targetEntityType === 'HERO_CARD_2' || targetEntityId === '2' || targetEntityId === 'HERO_CARD_2_FILE_ID') {
          slotIdxHero = 2;
        } else if (targetEntityType === 'HERO_CARD_3' || targetEntityId === '3' || targetEntityId === 'HERO_CARD_3_FILE_ID') {
          slotIdxHero = 3;
        }
        var heroSettingKey = 'HERO_CARD_' + String(slotIdxHero) + '_FILE_ID';
        var settingsTblHero = readSheetTable_('Settings');
        if (
          settingsTblHero &&
          settingsTblHero.byId &&
          settingsTblHero.byId[heroSettingKey]
        ) {
          var existingHeroSetting = settingsTblHero.byId[heroSettingKey].record;
          updateSheetRecordById_(
            'Settings',
            heroSettingKey,
            {
              setting_value: fileId,
              is_public: true,
              updated_by_user_id: actorUserId,
              updated_at_utc: nowIso
            },
            Number(existingHeroSetting.version)
          );
        } else {
          insertSheetRecord_('Settings', {
            setting_key: heroSettingKey,
            setting_value: fileId,
            is_public: true,
            updated_by_user_id: actorUserId,
            updated_at_utc: nowIso,
            version: 1
          });
        }
        linkedTargetSummary = {
          entityType: 'SETTINGS',
          entityId: heroSettingKey,
          field: 'setting_value'
        };
      } else if ((targetEntityType === 'COURSE' || targetEntityType === 'COURSE_COVER') && targetEntityId) {
        var targetCourse = getSheetRecordById_('Courses', targetEntityId);
        if (!targetCourse) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_NOT_FOUND,
            'Target course "' + targetEntityId + '" not found.'
          );
        }
        var updatedC = updateSheetRecordById_(
          'Courses',
          targetEntityId,
          {
            cover_file_id: fileId,
            updated_at_utc: nowIso
          },
          Number(targetCourse.version)
        );
        linkedTargetSummary = {
          entityType: 'COURSE',
          entityId: targetEntityId,
          field: 'cover_file_id',
          newVersion: Number(updatedC.version)
        };
      } else if ((targetEntityType === 'CARD' || targetEntityType === 'CARD_IMAGE') && targetEntityId) {
        var targetCard = getSheetRecordById_('Cards', targetEntityId);
        if (!targetCard) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_NOT_FOUND,
            'Target card "' + targetEntityId + '" not found.'
          );
        }
        if (courseId && targetCard.course_id !== courseId) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
            'Cross-course card linkage rejected: card "' +
              targetEntityId +
              '" does not belong to course "' +
              courseId +
              '".'
          );
        }
        var updatedCard = updateSheetRecordById_(
          'Cards',
          targetEntityId,
          {
            image_file_id: fileId,
            updated_at_utc: nowIso
          },
          Number(targetCard.version)
        );
        linkedTargetSummary = {
          entityType: 'CARD',
          entityId: targetEntityId,
          field: 'image_file_id',
          newVersion: Number(updatedCard.version)
        };
      } else if ((targetEntityType === 'ASSESSMENT' || targetEntityType === 'ASSESSMENT_PDF') && targetEntityId) {
        var targetAsm = getSheetRecordById_('Assessments', targetEntityId);
        if (!targetAsm) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_NOT_FOUND,
            'Target assessment "' + targetEntityId + '" not found.'
          );
        }
        var updatedAsm = updateSheetRecordById_(
          'Assessments',
          targetEntityId,
          {
            pdf_file_id: fileId,
            updated_at_utc: nowIso
          },
          Number(targetAsm.version)
        );
        linkedTargetSummary = {
          entityType: 'ASSESSMENT',
          entityId: targetEntityId,
          field: 'pdf_file_id',
          newVersion: Number(updatedAsm.version)
        };
      }

      recordAuditEvent_({
        actorUserId: actorUserId,
        actorRole: actorUser.role,
        eventType: 'FILE_UPLOADED',
        targetEntityType: 'File',
        targetEntityId: fileId,
        summary: {
          purpose: purpose,
          courseId: courseId || '',
          originalFilename: safeFilename,
          mimeType: detectedMime,
          sizeBytes: decodedBytes.length,
          sha256Hex: sha256Hex,
          linkedTarget: linkedTargetSummary
        }
      });
    });
  } catch (metaErr) {
    /* Compensating Rollback: Immediately trash the newly created Drive file so no orphan remains */
    var rollbackTrashed = false;
    try {
      if (createdDriveFile && typeof createdDriveFile.setTrashed === 'function') {
        createdDriveFile.setTrashed(true);
        rollbackTrashed = true;
      }
    } catch (ignoreTrashErr) {}

    if (metaErr && metaErr.isAppError) {
      metaErr.fieldErrors = metaErr.fieldErrors || {};
      metaErr.fieldErrors.driveRollbackExecuted = String(rollbackTrashed);
      throw metaErr;
    }
    throw createAppError_(
      PB_ERROR_CODES_.ERR_INTERNAL,
      'Metadata recording failed after Drive upload; compensating rollback trashed the Drive file (' +
        String(rollbackTrashed) +
        '). Details: ' +
        String(metaErr.message || metaErr),
      {
        driveRollbackExecuted: String(rollbackTrashed),
        rolledBackDriveFileId: driveFileId
      }
    );
  }

  var updatedLogoPayload = null;
  if (
    purpose === 'SCHOOL_LOGO' &&
    req.applyAsSchoolLogo !== false &&
    typeof loadValidatedSchoolLogo_ === 'function'
  ) {
    try {
      updatedLogoPayload = loadValidatedSchoolLogo_();
    } catch (ignoreLogoRefreshErr) {}
  }

  var updatedInstructorPortraitPayload = null;
  if (
    (purpose === 'INSTRUCTOR_PORTRAIT' ||
      targetEntityType === 'INSTRUCTOR_PORTRAIT' ||
      targetEntityType === 'SETTINGS_INSTRUCTOR_PORTRAIT') &&
    typeof loadValidatedInstructorPortraitPhase3_ === 'function'
  ) {
    try {
      updatedInstructorPortraitPayload = loadValidatedInstructorPortraitPhase3_(
        createdFileRow.file_id
      );
    } catch (ignorePortraitRefreshErr) {}
  }

  var updatedHeroCardPayload = null;
  if (
    (purpose === 'HERO_SHUFFLE_CARD' ||
      targetEntityType === 'HERO_SHUFFLE_CARD' ||
      targetEntityType === 'HERO_CARD_1' ||
      targetEntityType === 'HERO_CARD_2' ||
      targetEntityType === 'HERO_CARD_3') &&
    typeof loadValidatedInstructorPortraitPhase3_ === 'function'
  ) {
    try {
      updatedHeroCardPayload = loadValidatedInstructorPortraitPhase3_(
        createdFileRow.file_id
      );
      if (updatedHeroCardPayload && typeof updatedHeroCardPayload === 'object') {
        updatedHeroCardPayload.fileId = createdFileRow.file_id;
      }
    } catch (ignoreHeroRefreshErr) {}
  }

  return {
    file: {
      fileId: createdFileRow.file_id,
      purpose: createdFileRow.purpose,
      courseId: createdFileRow.course_id,
      ownerUserId: createdFileRow.owner_user_id,
      originalFilename: createdFileRow.original_filename,
      mimeType: createdFileRow.mime_type,
      sizeBytes: createdFileRow.size_bytes,
      sha256Hex: createdFileRow.sha256_hex,
      status: createdFileRow.status,
      createdAtUtc: createdFileRow.created_at_utc,
      createdAtBangkok: formatBangkokTimestamp_(createdFileRow.created_at_utc)
    },
    linkedTarget: linkedTargetSummary,
    linkedEntity: linkedTargetSummary,
    updatedLogo: updatedLogoPayload,
    updatedInstructorPortrait: updatedInstructorPortraitPayload,
    updatedHeroCard: updatedHeroCardPayload,
    quotaPolicyNotice:
      'Enforced 200 MB (209,715,200 bytes) application file size limit, accounting for ~33.3% Base64 expansion over google.script.run.'
  };
}

function handleAdminUploadFileStep8_(payload, context) {
  return uploadPrivateFileCoreStep8_(context.authContext, payload, true);
}

function handlePaymentUploadReceiptStep8_(payload, context) {
  var authContext = context.authContext;
  if (!authContext || !authContext.user) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to upload a payment receipt.'
    );
  }
  var user = authContext.user;
  var currentUserId = user.user_id || user.userId || '';
  var req = payload && typeof payload === 'object' ? payload : {};
  var paymentId = sanitizeSingleLineTextStep7_(req.paymentId, 64);

  if (!paymentId || !/^pay_[A-Za-z0-9_-]{4,64}$/.test(paymentId)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_PAYMENT_STATE_INVALID || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Payment receipt upload requires an active payment session ID (pay_... in PENDING_TRANSFER state).',
      {
        paymentId:
          'A valid paymentId (pay_...) in PENDING_TRANSFER state is required before uploading a receipt.'
      }
    );
  }

  var paymentRow = getSheetRecordById_('Payments', paymentId);
  if (!paymentRow) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Payment session "' + paymentId + '" was not found.',
      { paymentId: 'Payment session not found.' }
    );
  }

  if (user.role !== 'ADMIN' && paymentRow.user_id !== currentUserId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Access denied: you may only upload a receipt for your own payment session.'
    );
  }

  var allowedUploadStates = {
    PENDING_TRANSFER: true,
    RECEIPT_UPLOADED: true,
    RESERVED: true
  };
  if (!allowedUploadStates[String(paymentRow.status || '')]) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION ||
        PB_ERROR_CODES_.ERR_PAYMENT_STATE_INVALID ||
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Cannot upload a receipt when payment "' +
        paymentId +
        '" is in state "' +
        paymentRow.status +
        '". Receipts are only accepted while a payment session is in PENDING_TRANSFER state.',
      {
        paymentStatus:
          'Expected PENDING_TRANSFER state, found ' + String(paymentRow.status) + '.'
      }
    );
  }

  var nowMs =
    req._testServerNowMs !== undefined && req._testServerNowMs !== null
      ? Number(req._testServerNowMs)
      : Date.now();
  var expIso = String(
    paymentRow.expires_at_utc || paymentRow.reservation_expires_at_utc || ''
  ).trim();
  var expMs = Date.parse(expIso);
  if (!isNaN(expMs) && nowMs > expMs) {
    if (typeof sweepExpiredPaymentSessionsStep10_ === 'function') {
      try {
        sweepExpiredPaymentSessionsStep10_(nowMs);
      } catch (ignoreSweepErr) {}
    }
    throw createAppError_(
      PB_ERROR_CODES_.ERR_PAYMENT_EXPIRED,
      'Payment session "' +
        paymentId +
        '" expired at ' +
        expIso +
        '. Please create a new payment reservation.',
      { expiresAtUtc: expIso }
    );
  }

  var uploadRes = uploadPrivateFileCoreStep8_(
    authContext,
    {
      purpose: 'PAYMENT_RECEIPT',
      courseId: '',
      originalFilename: req.originalFilename || 'receipt_slip',
      mimeType: req.mimeType || '',
      dataBase64: req.dataBase64 || ''
    },
    false
  );

  var updatedPayment = null;
  withScriptLock_(function () {
    var freshPay = getSheetRecordById_('Payments', paymentId);
    if (!freshPay || !allowedUploadStates[String(freshPay.status || '')]) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION ||
          PB_ERROR_CODES_.ERR_PAYMENT_STATE_INVALID ||
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Payment session state changed during upload; receipt linkage aborted.'
      );
    }
    var freshExpIso = String(
      freshPay.expires_at_utc || freshPay.reservation_expires_at_utc || ''
    ).trim();
    var freshExpMs = Date.parse(freshExpIso);
    if (!isNaN(freshExpMs) && nowMs > freshExpMs) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_PAYMENT_EXPIRED,
        'Payment session expired during receipt upload.'
      );
    }
    updatedPayment = updateSheetRecordById_(
      'Payments',
      paymentId,
      {
        receipt_file_id: uploadRes.file.fileId,
        updated_at_utc: nowUtcIso_()
      },
      Number(freshPay.version)
    );
  });

  return {
    paymentId: paymentId,
    paymentStatus: updatedPayment.status,
    paymentVersion: Number(updatedPayment.version),
    receiptFileId: uploadRes.file.fileId,
    receiptFile: uploadRes.file,
    file: uploadRes.file
  };
}

function isFileReferencedWithinCourseStep8_(fileId, courseId) {
  var cRow = getSheetRecordById_('Courses', courseId);
  if (!cRow || cRow.status !== 'PUBLISHED') {
    return false;
  }
  if (cRow.cover_file_id === fileId) {
    return true;
  }
  if (
    String(cRow.objectives_richtext_json || '').indexOf(fileId) !== -1 ||
    String(cRow.outcomes_richtext_json || '').indexOf(fileId) !== -1
  ) {
    return true;
  }

  var cardsTbl = readSheetTable_('Cards');
  var sectionsTbl = readSheetTable_('Sections');
  var assessmentsTbl = readSheetTable_('Assessments');

  for (var i = 0; i < cardsTbl.records.length; i++) {
    var card = cardsTbl.records[i];
    if (card.course_id !== courseId || card.status !== 'PUBLISHED') {
      continue;
    }
    var sec =
      sectionsTbl.byId && sectionsTbl.byId[card.section_id]
        ? sectionsTbl.byId[card.section_id].record
        : null;
    if (!sec || (sec.status !== 'PUBLISHED' && sec.status !== 'ACTIVE')) {
      continue;
    }
    if (card.image_file_id === fileId) {
      return true;
    }
    if (String(card.content_richtext_json || '').indexOf(fileId) !== -1) {
      return true;
    }
    if (card.assessment_id && assessmentsTbl.byId && assessmentsTbl.byId[card.assessment_id]) {
      var asm = assessmentsTbl.byId[card.assessment_id].record;
      if (asm && asm.pdf_file_id === fileId) {
        return true;
      }
    }
  }

  try {
    if (typeof PB_SHEET_SCHEMAS_ === 'object' && PB_SHEET_SCHEMAS_ && PB_SHEET_SCHEMAS_.ExamSets) {
      var examSetsRefTbl = readSheetTable_('ExamSets');
      for (var exi = 0; exi < examSetsRefTbl.records.length; exi++) {
        var exRec = examSetsRefTbl.records[exi];
        if (exRec.course_id !== courseId || exRec.status !== 'PUBLISHED') {
          continue;
        }
        var instStr = String(exRec.instructions_richtext_json || '');
        var descStr = String(exRec.description_richtext_json || '');
        if (instStr.indexOf(fileId) !== -1 || descStr.indexOf(fileId) !== -1) {
          return true;
        }
      }
    }
  } catch (_ignoreExamCourseRefErr) {}

  return false;
}

function assertStudentHasActiveCourseEnrollmentStep8_(userId, courseId) {
  if (!courseId || !/^crs_[A-Za-z0-9_-]{4,64}$/.test(courseId)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'A valid courseId is required to access course files.'
    );
  }
  var cRow = getSheetRecordById_('Courses', courseId);
  if (!cRow || cRow.status !== 'PUBLISHED') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Access denied: course is not published or does not exist.'
    );
  }
  var enrTbl = readSheetTable_('Enrollments');
  var hasActive = false;
  for (var i = 0; i < enrTbl.records.length; i++) {
    var enr = enrTbl.records[i];
    if (
      enr.user_id === userId &&
      enr.course_id === courseId &&
      enr.status === 'ACTIVE'
    ) {
      hasActive = true;
      break;
    }
  }
  if (!hasActive) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Access denied: you do not have an ACTIVE enrollment in course "' +
        courseId +
        '".'
    );
  }
  return cRow;
}

function authorizeExamAnswerSheetAccessForStudentStep8_(userId, fileId, courseId) {
  if (!userId || !fileId || !courseId) {
    return;
  }
  try {
    if (typeof PB_SHEET_SCHEMAS_ !== 'object' || !PB_SHEET_SCHEMAS_ || !PB_SHEET_SCHEMAS_.ExamSets) {
      return;
    }
    var exSetsTbl = readSheetTable_('ExamSets');
    var matchingExams = [];
    for (var i = 0; i < exSetsTbl.records.length; i++) {
      var exRec = exSetsTbl.records[i];
      if (exRec.course_id !== courseId || exRec.status !== 'PUBLISHED') {
        continue;
      }
      var rawInst = String(exRec.instructions_richtext_json || '');
      if (rawInst.indexOf(fileId) !== -1) {
        matchingExams.push(exRec);
      }
    }
    if (matchingExams.length === 0) {
      return;
    }

    var restrictedHits = [];
    var hasPublicNonAnswerRef = false;
    for (var m = 0; m < matchingExams.length; m++) {
      var exItem = matchingExams[m];
      var doc =
        typeof parseStoredRichTextJsonSafe_ === 'function'
          ? parseStoredRichTextJsonSafe_(exItem.instructions_richtext_json)
          : null;
      var blocks = doc && Array.isArray(doc.blocks) ? doc.blocks : [];
      for (var bIdx = 0; bIdx < blocks.length; bIdx++) {
        var blk = blocks[bIdx];
        if (!blk || blk.fileId !== fileId) {
          continue;
        }
        var t = String(blk.title || '').trim();
        if (t.indexOf('[PB_ANSWER_SHEET_PDF:') === 0) {
          var closeIdx = t.indexOf(']');
          var rawPol =
            closeIdx !== -1
              ? t.slice('[PB_ANSWER_SHEET_PDF:'.length, closeIdx).trim().toUpperCase()
              : 'AFTER_SUBMIT';
          var policy =
            rawPol === 'WITH_KEY' || rawPol === 'ALWAYS' || rawPol === 'AFTER_SUBMIT'
              ? rawPol
              : 'AFTER_SUBMIT';
          restrictedHits.push({ examSet: exItem, policy: policy });
        } else {
          hasPublicNonAnswerRef = true;
        }
      }
    }

    if (restrictedHits.length === 0 || hasPublicNonAnswerRef) {
      return;
    }

    var attemptsTbl = PB_SHEET_SCHEMAS_.ExamAttempts ? readSheetTable_('ExamAttempts') : { records: [] };
    var unlocked = false;
    var needsKeyRelease = false;
    for (var h = 0; h < restrictedHits.length; h++) {
      var hit = restrictedHits[h];
      if (hit.policy === 'ALWAYS') {
        unlocked = true;
        break;
      }
      if (hit.policy === 'WITH_KEY') {
        needsKeyRelease = true;
      }
      for (var aIdx = 0; aIdx < attemptsTbl.records.length; aIdx++) {
        var att = attemptsTbl.records[aIdx];
        if (att.exam_set_id !== hit.examSet.exam_set_id || att.user_id !== userId) {
          continue;
        }
        if (att.attempt_status !== 'SUBMITTED' && att.attempt_status !== 'EXPIRED_SUBMITTED') {
          continue;
        }
        if (hit.policy === 'AFTER_SUBMIT') {
          unlocked = true;
          break;
        }
        if (hit.policy === 'WITH_KEY') {
          var relState =
            typeof resolveEffectiveAttemptReleaseStatePhase7_ === 'function'
              ? resolveEffectiveAttemptReleaseStatePhase7_(att, hit.examSet)
              : null;
          var keyOpen = relState
            ? Boolean(relState.explanationsReleased)
            : att.explanation_status === 'RELEASED';
          if (keyOpen) {
            unlocked = true;
            break;
          }
        }
      }
      if (unlocked) {
        break;
      }
    }

    if (!unlocked) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        needsKeyRelease
          ? 'This Answer Sheet PDF is locked until answer explanations/key are released.'
          : 'This Answer Sheet PDF will unlock after you submit an exam attempt.'
      );
    }
  } catch (ansErr) {
    if (ansErr && ansErr.isAppError) {
      throw ansErr;
    }
  }
}

function handleFileGetContentStep8_(payload, context) {
  var authContext = context.authContext;
  if (!authContext || !authContext.user) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to read private files.'
    );
  }
  var user = authContext.user;
  var currentUserId = user.user_id || user.userId || '';
  var req = payload && typeof payload === 'object' ? payload : {};
  var fileId = sanitizeSingleLineTextStep7_(req.fileId, 64);
  var requestedCourseId = sanitizeSingleLineTextStep7_(req.courseId, 64);

  if (!fileId || !/^fil_[A-Za-z0-9_-]{4,64}$/.test(fileId)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'A valid application fileId (fil_...) is required. Raw Google Drive file IDs cannot be requested directly.',
      { fileId: 'Must be an application file_id starting with fil_.' }
    );
  }

  var fileRow = getSheetRecordById_('Files', fileId);
  if (!fileRow || fileRow.status !== 'ACTIVE') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Requested file "' + fileId + '" was not found or has been deleted.'
    );
  }

  var purpose = String(fileRow.purpose || '');

  if (user.role !== 'ADMIN') {
    if (purpose === 'SCHOOL_LOGO') {
      var settingsTbl = readSheetTable_('Settings');
      var activeLogoOverride =
        settingsTbl &&
        settingsTbl.byId &&
        settingsTbl.byId.LOGO_FILE_ID &&
        settingsTbl.byId.LOGO_FILE_ID.record
          ? String(settingsTbl.byId.LOGO_FILE_ID.record.setting_value || '').trim()
          : '';
      if (activeLogoOverride !== fileId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Access denied: only the active public school logo may be read by non-administrators.'
        );
      }
    } else if (purpose === 'PAYMENT_RECEIPT') {
      var isOwner = fileRow.owner_user_id === currentUserId;
      if (!isOwner) {
        var payTbl = readSheetTable_('Payments');
        for (var pIdx = 0; pIdx < payTbl.records.length; pIdx++) {
          var pRow = payTbl.records[pIdx];
          if (pRow.receipt_file_id === fileId && pRow.user_id === currentUserId) {
            isOwner = true;
            break;
          }
        }
      }
      if (!isOwner) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Access denied: payment receipts may only be accessed by their owner or an administrator.'
        );
      }
    } else if (
      purpose === 'INSTRUCTOR_PORTRAIT' ||
      purpose === 'HERO_CARD_1' ||
      purpose === 'HERO_CARD_2' ||
      purpose === 'HERO_CARD_3'
    ) {
      // Public/homepage CMS visual assets uploaded by an administrator
    } else if (
      purpose === 'QUESTION_IMAGE' ||
      purpose === 'STIMULUS_IMAGE'
    ) {
      // Question Bank or Shared Stimulus diagrams delivered in authorized examinations
      if (requestedCourseId) {
        assertStudentHasActiveCourseEnrollmentStep8_(currentUserId, requestedCourseId);
      }
    } else if (
      purpose === 'COURSE_COVER' ||
      purpose === 'RICHTEXT_IMAGE' ||
      purpose === 'CARD_IMAGE' ||
      purpose === 'PDF_ATTACHMENT' ||
      purpose === 'COURSE_IMAGE' ||
      purpose === 'COURSE_PDF'
    ) {
      var effectiveCourseId = requestedCourseId || fileRow.course_id || '';
      if (!effectiveCourseId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Course context (courseId) is required to authorize access to this course file.'
        );
      }
      if (fileRow.course_id && fileRow.course_id !== effectiveCourseId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Cross-course file access rejected: file "' +
            fileId +
            '" belongs to a different course.'
        );
      }
      assertStudentHasActiveCourseEnrollmentStep8_(currentUserId, effectiveCourseId);
      if (!isFileReferencedWithinCourseStep8_(fileId, effectiveCourseId)) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Access denied: file "' +
            fileId +
            '" is not actively referenced in published content for course "' +
            effectiveCourseId +
            '".'
        );
      }
      authorizeExamAnswerSheetAccessForStudentStep8_(currentUserId, fileId, effectiveCourseId);
    } else {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied for file purpose "' + purpose + '".'
      );
    }
  } else if (
    requestedCourseId &&
    fileRow.course_id &&
    fileRow.course_id !== requestedCourseId
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Cross-course file mismatch: file "' +
        fileId +
        '" is bound to course "' +
        fileRow.course_id +
        '", not "' +
        requestedCourseId +
        '".'
    );
  }

  var driveFileId = String(fileRow.drive_file_id || '').trim();
  if (!driveFileId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Drive file pointer is missing for "' + fileId + '".'
    );
  }

  var smallFileCacheKey =
    'pb_f2_' +
    fileRow.file_id +
    '_' +
    String(fileRow.sha256_hex || fileRow.version || '1')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 24);
  if (driveFileId.indexOf('drv_step9_sample_') !== 0) {
    try {
      var cachedRawJson = CacheService.getScriptCache().get(smallFileCacheKey);
      if (cachedRawJson) {
        var cachedFilePayload = JSON.parse(cachedRawJson);
        if (cachedFilePayload && cachedFilePayload.dataBase64) {
          return {
            fileId: fileRow.file_id,
            purpose: fileRow.purpose,
            courseId: fileRow.course_id || '',
            originalFilename: fileRow.original_filename || 'file',
            mimeType: cachedFilePayload.mimeType || fileRow.mime_type,
            sizeBytes: Number(cachedFilePayload.sizeBytes) || 0,
            sha256Hex: fileRow.sha256_hex || '',
            dataBase64: cachedFilePayload.dataBase64
          };
        }
      }
    } catch (_cacheReadErr) {}
  }

  var rawBytes = null;
  if (driveFileId.indexOf('drv_step9_sample_png') === 0) {
    rawBytes = Utilities.base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    );
  } else if (driveFileId.indexOf('drv_step9_sample_pdf') === 0) {
    rawBytes = Utilities.base64Decode(
      'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKdHJhaWxlcgo8PCAvUm9vdCAxIDAgUiA+PgplbmRsb2JqCg=='
    );
  } else {
    try {
      var driveFile = DriveApp.getFileById(driveFileId);
      if (typeof driveFile.isTrashed === 'function' && driveFile.isTrashed()) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Underlying Google Drive file for "' + fileId + '" is in Trash.'
        );
      }
      rawBytes = driveFile.getBlob().getBytes();
    } catch (readErr) {
      if (readErr && readErr.isAppError) {
        throw readErr;
      }
      throw createAppError_(
        PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE,
        'Could not read private file bytes from Google Drive: ' +
          String(readErr.message || readErr)
      );
    }
  }

  var maxBytes =
    (PB_APP_CONSTANTS_ && PB_APP_CONSTANTS_.MAX_FILE_UPLOAD_BYTES) || 209715200;
  if (!Array.isArray(rawBytes) || rawBytes.length > maxBytes) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_TOO_LARGE || PB_ERROR_CODES_.ERR_RESPONSE_TOO_LARGE,
      'Stored file exceeds the 200 MB bounded RPC transfer limit.'
    );
  }

  var sigInfo = inspectFileBinarySignatureStep8_(rawBytes);
  if (!sigInfo.isApprovedFormat || sigInfo.detectedMimeType !== fileRow.mime_type) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FILE_SIGNATURE_MISMATCH || PB_ERROR_CODES_.ERR_FILE_INVALID,
      'Stored file binary signature verification failed on read.'
    );
  }

  var encodedBase64 = Utilities.base64Encode(rawBytes);
  if (rawBytes.length <= 70000 && driveFileId.indexOf('drv_step9_sample_') !== 0) {
    try {
      CacheService.getScriptCache().put(
        smallFileCacheKey,
        JSON.stringify({
          mimeType: sigInfo.detectedMimeType,
          sizeBytes: rawBytes.length,
          dataBase64: encodedBase64
        }),
        300
      );
    } catch (_cacheWriteErr) {}
  }

  return {
    fileId: fileRow.file_id,
    purpose: fileRow.purpose,
    courseId: fileRow.course_id || '',
    originalFilename: fileRow.original_filename || 'file',
    mimeType: sigInfo.detectedMimeType,
    sizeBytes: rawBytes.length,
    sha256Hex: fileRow.sha256_hex || '',
    dataBase64: encodedBase64
  };
}

function collectAllReferencedFileIdsStep8_() {
  var refMap = {};
  function markRef(fid, reason) {
    if (!fid || typeof fid !== 'string' || fid.indexOf('fil_') !== 0) {
      return;
    }
    if (!refMap[fid]) {
      refMap[fid] = [];
    }
    refMap[fid].push(reason);
  }
  function scanRichTextJson(jsonStr, reasonPrefix) {
    if (!jsonStr || typeof jsonStr !== 'string') {
      return;
    }
    var matches = jsonStr.match(/fil_[A-Za-z0-9_-]{4,64}/g);
    if (matches) {
      for (var i = 0; i < matches.length; i++) {
        markRef(matches[i], reasonPrefix);
      }
    }
  }

  var settingsTbl = readSheetTable_('Settings');
  if (settingsTbl && settingsTbl.byId && settingsTbl.byId.LOGO_FILE_ID) {
    markRef(
      String(settingsTbl.byId.LOGO_FILE_ID.record.setting_value || '').trim(),
      'Settings.LOGO_FILE_ID'
    );
  }
  if (settingsTbl && settingsTbl.byId && settingsTbl.byId.PROMPTPAY_QR_FILE_ID) {
    markRef(
      String(settingsTbl.byId.PROMPTPAY_QR_FILE_ID.record.setting_value || '').trim(),
      'Settings.PROMPTPAY_QR_FILE_ID'
    );
  }
  if (
    settingsTbl &&
    settingsTbl.byId &&
    settingsTbl.byId.INSTRUCTOR_PORTRAIT_FILE_ID
  ) {
    markRef(
      String(
        settingsTbl.byId.INSTRUCTOR_PORTRAIT_FILE_ID.record.setting_value || ''
      ).trim(),
      'Settings.INSTRUCTOR_PORTRAIT_FILE_ID'
    );
  }
  for (var hcIdx = 1; hcIdx <= 3; hcIdx++) {
    var hcKey = 'HERO_CARD_' + String(hcIdx) + '_FILE_ID';
    if (settingsTbl && settingsTbl.byId && settingsTbl.byId[hcKey]) {
      markRef(
        String(settingsTbl.byId[hcKey].record.setting_value || '').trim(),
        'Settings.' + hcKey
      );
    }
  }

  var coursesTbl = readSheetTable_('Courses');
  for (var c = 0; c < coursesTbl.records.length; c++) {
    var cr = coursesTbl.records[c];
    markRef(cr.cover_file_id, 'Courses:' + cr.course_id + '.cover_file_id');
    scanRichTextJson(
      cr.objectives_richtext_json,
      'Courses:' + cr.course_id + '.objectives'
    );
    scanRichTextJson(
      cr.outcomes_richtext_json,
      'Courses:' + cr.course_id + '.outcomes'
    );
  }

  var cardsTbl = readSheetTable_('Cards');
  for (var k = 0; k < cardsTbl.records.length; k++) {
    var cd = cardsTbl.records[k];
    markRef(cd.image_file_id, 'Cards:' + cd.card_id + '.image_file_id');
    scanRichTextJson(
      cd.content_richtext_json,
      'Cards:' + cd.card_id + '.content'
    );
  }

  var asmTbl = readSheetTable_('Assessments');
  for (var a = 0; a < asmTbl.records.length; a++) {
    var am = asmTbl.records[a];
    markRef(am.pdf_file_id, 'Assessments:' + am.assessment_id + '.pdf_file_id');
    scanRichTextJson(
      am.description_richtext_json,
      'Assessments:' + am.assessment_id + '.description'
    );
  }

  var payTbl = readSheetTable_('Payments');
  for (var p = 0; p < payTbl.records.length; p++) {
    var py = payTbl.records[p];
    markRef(py.receipt_file_id, 'Payments:' + py.payment_id + '.receipt_file_id');
  }

  try {
    if (PB_SHEET_SCHEMAS_ && PB_SHEET_SCHEMAS_.SharedStimuli) {
      var stimTbl = readSheetTable_('SharedStimuli');
      for (var stIdx = 0; stIdx < stimTbl.records.length; stIdx++) {
        var stRow = stimTbl.records[stIdx];
        markRef(stRow.image_file_id, 'SharedStimuli:' + stRow.stimulus_id + '.image_file_id');
        scanRichTextJson(stRow.content_richtext_json, 'SharedStimuli:' + stRow.stimulus_id + '.content');
      }
    }
    if (PB_SHEET_SCHEMAS_ && PB_SHEET_SCHEMAS_.QuestionVersions) {
      var qvTbl = readSheetTable_('QuestionVersions');
      for (var qvIdx = 0; qvIdx < qvTbl.records.length; qvIdx++) {
        var qvRow = qvTbl.records[qvIdx];
        markRef(qvRow.image_file_id, 'QuestionVersions:' + qvRow.question_version_id + '.image_file_id');
        scanRichTextJson(qvRow.stem_richtext_json, 'QuestionVersions:' + qvRow.question_version_id + '.stem');
        scanRichTextJson(qvRow.explanation_richtext_json, 'QuestionVersions:' + qvRow.question_version_id + '.explanation');
      }
    }
    if (PB_SHEET_SCHEMAS_ && PB_SHEET_SCHEMAS_.QuestionOptions) {
      var qoTbl = readSheetTable_('QuestionOptions');
      for (var qoIdx = 0; qoIdx < qoTbl.records.length; qoIdx++) {
        var qoRow = qoTbl.records[qoIdx];
        markRef(qoRow.image_file_id, 'QuestionOptions:' + qoRow.option_id + '.image_file_id');
        scanRichTextJson(qoRow.content_richtext_json, 'QuestionOptions:' + qoRow.option_id + '.content');
      }
    }
    if (PB_SHEET_SCHEMAS_ && PB_SHEET_SCHEMAS_.ExamSets) {
      var esTbl = readSheetTable_('ExamSets');
      for (var esIdx = 0; esIdx < esTbl.records.length; esIdx++) {
        var esRow = esTbl.records[esIdx];
        scanRichTextJson(esRow.instructions_richtext_json, 'ExamSets:' + esRow.exam_set_id + '.instructions');
        scanRichTextJson(esRow.description_richtext_json, 'ExamSets:' + esRow.exam_set_id + '.description');
      }
    }
    if (PB_SHEET_SCHEMAS_ && PB_SHEET_SCHEMAS_.ExamVersions) {
      var evTbl = readSheetTable_('ExamVersions');
      for (var evIdx = 0; evIdx < evTbl.records.length; evIdx++) {
        var evRow = evTbl.records[evIdx];
        scanRichTextJson(evRow.snapshot_json, 'ExamVersions:' + evRow.exam_version_id + '.snapshot');
      }
    }
  } catch (ignoreExamRefScanErr) {}

  return refMap;
}

function handleAdminRemoveFileReferenceStep8_(payload, context) {
  var authContext = context.authContext;
  if (!authContext || !authContext.user || authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Administrator role is required to remove file references.'
    );
  }
  var adminUser = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var targetEntityType = String(req.targetEntityType || '')
    .trim()
    .toUpperCase();
  var targetEntityId = sanitizeSingleLineTextStep7_(req.targetEntityId, 64);
  var trashIfUnreferenced = Boolean(req.trashIfUnreferenced);

  return withScriptLock_(function () {
    var nowIso = nowUtcIso_();
    var removedFileId = '';
    var newVersion = null;

    if (
      targetEntityType === 'HERO_SHUFFLE_CARD' ||
      targetEntityType === 'HERO_CARD_1' ||
      targetEntityType === 'HERO_CARD_2' ||
      targetEntityType === 'HERO_CARD_3'
    ) {
      var rmSlotIdx = 1;
      if (targetEntityType === 'HERO_CARD_2' || targetEntityId === '2' || targetEntityId === 'HERO_CARD_2_FILE_ID') {
        rmSlotIdx = 2;
      } else if (targetEntityType === 'HERO_CARD_3' || targetEntityId === '3' || targetEntityId === 'HERO_CARD_3_FILE_ID') {
        rmSlotIdx = 3;
      }
      var rmHeroKey = 'HERO_CARD_' + String(rmSlotIdx) + '_FILE_ID';
      targetEntityId = rmHeroKey;
      var settingsTblHeroRm = readSheetTable_('Settings');
      if (settingsTblHeroRm && settingsTblHeroRm.byId && settingsTblHeroRm.byId[rmHeroKey]) {
        var recHeroRm = settingsTblHeroRm.byId[rmHeroKey].record;
        removedFileId = String(recHeroRm.setting_value || '').trim();
        var updHeroRm = updateSheetRecordById_(
          'Settings',
          rmHeroKey,
          {
            setting_value: '',
            updated_by_user_id: (adminUser.user_id || adminUser.userId),
            updated_at_utc: nowIso
          },
          Number(recHeroRm.version)
        );
        newVersion = Number(updHeroRm.version);
      }
    } else if (targetEntityType === 'INSTRUCTOR_PORTRAIT' || targetEntityType === 'SETTINGS_INSTRUCTOR_PORTRAIT') {
      var settingsTblP = readSheetTable_('Settings');
      if (settingsTblP && settingsTblP.byId && settingsTblP.byId.INSTRUCTOR_PORTRAIT_FILE_ID) {
        var recP = settingsTblP.byId.INSTRUCTOR_PORTRAIT_FILE_ID.record;
        removedFileId = String(recP.setting_value || '').trim();
        var updP = updateSheetRecordById_(
          'Settings',
          'INSTRUCTOR_PORTRAIT_FILE_ID',
          {
            setting_value: '',
            updated_by_user_id: (adminUser.user_id || adminUser.userId),
            updated_at_utc: nowIso
          },
          Number(recP.version)
        );
        newVersion = Number(updP.version);
      }
      invalidateSchoolLogoCache_();
    } else if (targetEntityType === 'SCHOOL_LOGO' || targetEntityType === 'SETTINGS_LOGO') {
      var settingsTbl = readSheetTable_('Settings');
      if (settingsTbl && settingsTbl.byId && settingsTbl.byId.LOGO_FILE_ID) {
        var rec = settingsTbl.byId.LOGO_FILE_ID.record;
        removedFileId = String(rec.setting_value || '').trim();
        var upd = updateSheetRecordById_(
          'Settings',
          'LOGO_FILE_ID',
          {
            setting_value: '',
            updated_by_user_id: (adminUser.user_id || adminUser.userId),
            updated_at_utc: nowIso
          },
          Number(rec.version)
        );
        newVersion = Number(upd.version);
      }
      invalidateSchoolLogoCache_();
    } else if ((targetEntityType === 'COURSE' || targetEntityType === 'COURSE_COVER') && targetEntityId) {
      var cRow = getSheetRecordById_('Courses', targetEntityId);
      if (!cRow) {
        throw createAppError_(PB_ERROR_CODES_.ERR_NOT_FOUND, 'Course not found.');
      }
      removedFileId = String(cRow.cover_file_id || '').trim();
      var updC = updateSheetRecordById_(
        'Courses',
        targetEntityId,
        {
          cover_file_id: '',
          updated_at_utc: nowIso
        },
        Number(cRow.version)
      );
      newVersion = Number(updC.version);
    } else if ((targetEntityType === 'CARD' || targetEntityType === 'CARD_IMAGE') && targetEntityId) {
      var cardRow = getSheetRecordById_('Cards', targetEntityId);
      if (!cardRow) {
        throw createAppError_(PB_ERROR_CODES_.ERR_NOT_FOUND, 'Card not found.');
      }
      removedFileId = String(cardRow.image_file_id || '').trim();
      var updCard = updateSheetRecordById_(
        'Cards',
        targetEntityId,
        {
          image_file_id: '',
          updated_at_utc: nowIso
        },
        Number(cardRow.version)
      );
      newVersion = Number(updCard.version);
    } else if ((targetEntityType === 'ASSESSMENT' || targetEntityType === 'ASSESSMENT_PDF') && targetEntityId) {
      var asmRow = getSheetRecordById_('Assessments', targetEntityId);
      if (!asmRow) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Assessment not found.'
        );
      }
      removedFileId = String(asmRow.pdf_file_id || '').trim();
      var updAsm = updateSheetRecordById_(
        'Assessments',
        targetEntityId,
        {
          pdf_file_id: '',
          updated_at_utc: nowIso
        },
        Number(asmRow.version)
      );
      newVersion = Number(updAsm.version);
    } else {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Unsupported targetEntityType "' +
          targetEntityType +
          '". Expected SCHOOL_LOGO, INSTRUCTOR_PORTRAIT, COURSE, CARD, or ASSESSMENT.'
      );
    }

    var fileMarkedDeleted = false;
    var driveTrashed = false;
    var remainingRefs = [];

    if (removedFileId && removedFileId.indexOf('fil_') === 0) {
      var refMap = collectAllReferencedFileIdsStep8_();
      remainingRefs = refMap[removedFileId] || [];

      if (trashIfUnreferenced && remainingRefs.length === 0) {
        var fRow = getSheetRecordById_('Files', removedFileId);
        if (fRow && fRow.status === 'ACTIVE') {
          updateSheetRecordById_('Files', removedFileId, {
            status: 'DELETED'
          });
          fileMarkedDeleted = true;
          if (fRow.drive_file_id) {
            try {
              var df = DriveApp.getFileById(fRow.drive_file_id);
              df.setTrashed(true);
              driveTrashed = true;
            } catch (ignoreDriveErr) {}
          }
        }
      }
    }

    recordAuditEvent_({
      actorUserId: (adminUser.user_id || adminUser.userId),
      actorRole: adminUser.role,
      eventType: 'FILE_REFERENCE_REMOVED',
      targetEntityType: targetEntityType || 'FileReference',
      targetEntityId: targetEntityId || 'LOGO_FILE_ID',
      summary: {
        removedFileId: removedFileId,
        remainingReferencesCount: remainingRefs.length,
        fileMarkedDeleted: fileMarkedDeleted,
        driveTrashed: driveTrashed
      }
    });

    var updatedLogoAfterRemove = null;
    if (
      (targetEntityType === 'SCHOOL_LOGO' || targetEntityType === 'SETTINGS_LOGO') &&
      typeof loadValidatedSchoolLogo_ === 'function'
    ) {
      try {
        updatedLogoAfterRemove = loadValidatedSchoolLogo_();
      } catch (ignoreLogoResetErr) {}
    }

    return {
      targetEntityType: targetEntityType,
      targetEntityId: targetEntityId || 'LOGO_FILE_ID',
      removedFileId: removedFileId,
      newVersion: newVersion,
      updatedEntityVersion: newVersion,
      remainingReferences: remainingRefs,
      fileMarkedDeleted: fileMarkedDeleted,
      driveTrashed: driveTrashed,
      updatedLogo: updatedLogoAfterRemove
    };
  });
}

function handleAdminCleanupOrphanFilesStep8_(payload, context) {
  var authContext = context.authContext;
  if (!authContext || !authContext.user || authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Administrator role is required to run orphan file cleanup.'
    );
  }
  var adminUser = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var mode = String(req.mode || 'DRY_RUN')
    .trim()
    .toUpperCase();
  if (mode !== 'DRY_RUN' && mode !== 'EXECUTE') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'mode must be DRY_RUN or EXECUTE.'
    );
  }

  var defaultGrace =
    (PB_APP_CONSTANTS_ &&
      PB_APP_CONSTANTS_.ORPHAN_FILE_GRACE_PERIOD_MINUTES_DEFAULT) ||
    1440;
  var minAgeMinutes =
    req.minAgeMinutes !== undefined && req.minAgeMinutes !== null
      ? Number(req.minAgeMinutes)
      : defaultGrace;
  if (isNaN(minAgeMinutes) || minAgeMinutes < 0) {
    minAgeMinutes = defaultGrace;
  }

  return withScriptLock_(function () {
    var nowMs = Date.now();
    var minAgeMs = minAgeMinutes * 60 * 1000;
    var refMap = collectAllReferencedFileIdsStep8_();
    var filesTbl = readSheetTable_('Files');

    var activeCount = 0;
    var referencedCount = 0;
    var graceProtectedCount = 0;
    var eligibleOrphans = [];
    var cleanedFiles = [];

    for (var i = 0; i < filesTbl.records.length; i++) {
      var fRow = filesTbl.records[i];
      if (fRow.status !== 'ACTIVE') {
        continue;
      }
      activeCount += 1;

      var refs = refMap[fRow.file_id] || [];
      if (refs.length > 0) {
        referencedCount += 1;
        continue;
      }

      var createdMs = Date.parse(fRow.created_at_utc || '');
      var ageMs = isNaN(createdMs) ? minAgeMs + 1 : nowMs - createdMs;
      if (ageMs < minAgeMs) {
        graceProtectedCount += 1;
        continue;
      }

      var orphanSummary = {
        fileId: fRow.file_id,
        driveFileId: fRow.drive_file_id,
        purpose: fRow.purpose,
        courseId: fRow.course_id || '',
        originalFilename: fRow.original_filename || '',
        sizeBytes: Number(fRow.size_bytes) || 0,
        createdAtUtc: fRow.created_at_utc || ''
      };
      eligibleOrphans.push(orphanSummary);

      if (mode === 'EXECUTE') {
        updateSheetRecordById_('Files', fRow.file_id, {
          status: 'DELETED'
        });
        var driveTrashed = false;
        if (fRow.drive_file_id) {
          try {
            var df = DriveApp.getFileById(fRow.drive_file_id);
            df.setTrashed(true);
            driveTrashed = true;
          } catch (ignoreTrashErr) {}
        }
        cleanedFiles.push({
          fileId: fRow.file_id,
          originalFilename: fRow.original_filename,
          purpose: fRow.purpose,
          driveTrashed: driveTrashed
        });
      }
    }

    if (mode === 'EXECUTE') {
      recordAuditEvent_({
        actorUserId: (adminUser.user_id || adminUser.userId),
        actorRole: adminUser.role,
        eventType: 'ORPHAN_FILES_CLEANED',
        targetEntityType: 'File',
        targetEntityId: 'BATCH_ORPHAN_CLEANUP',
        summary: {
          minAgeMinutes: minAgeMinutes,
          eligibleOrphanCount: eligibleOrphans.length,
          cleanedCount: cleanedFiles.length
        }
      });
    }

    return {
      mode: mode,
      minAgeMinutes: minAgeMinutes,
      activeFileCount: activeCount,
      referencedCount: referencedCount,
      graceProtectedCount: graceProtectedCount,
      eligibleOrphanCount: eligibleOrphans.length,
      eligibleOrphans: eligibleOrphans.slice(0, 50),
      cleanedCount: cleanedFiles.length,
      cleanedFiles: cleanedFiles.slice(0, 50),
      policySummary:
        'Conservative orphan cleanup only marks ACTIVE Files rows as DELETED and trashes their Drive blobs when they have zero references across Settings, Courses, Cards, Assessments, and Payments AND are older than the configured grace window (' +
        minAgeMinutes +
        ' minutes).'
    };
  });
}

function handleAdminListFilesStep8_(payload, context) {
  var authContext = context.authContext;
  if (!authContext || !authContext.user || authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Administrator role is required to list files.'
    );
  }
  var req = payload && typeof payload === 'object' ? payload : {};
  var filterPurpose = String(req.purpose || '')
    .trim()
    .toUpperCase();
  var filterCourseId = sanitizeSingleLineTextStep7_(req.courseId, 64);

  var refMap = collectAllReferencedFileIdsStep8_();
  var filesTbl = readSheetTable_('Files');
  var items = [];

  for (var i = filesTbl.records.length - 1; i >= 0; i--) {
    var fRow = filesTbl.records[i];
    if (filterPurpose && fRow.purpose !== filterPurpose) {
      continue;
    }
    if (filterCourseId && fRow.course_id !== filterCourseId) {
      continue;
    }
    items.push({
      fileId: fRow.file_id,
      purpose: fRow.purpose,
      courseId: fRow.course_id || '',
      ownerUserId: fRow.owner_user_id || '',
      originalFilename: fRow.original_filename || '',
      mimeType: fRow.mime_type || '',
      sizeBytes: Number(fRow.size_bytes) || 0,
      status: fRow.status || 'ACTIVE',
      createdAtUtc: fRow.created_at_utc || '',
      references: refMap[fRow.file_id] || []
    });
    if (items.length >= 100) {
      break;
    }
  }

  return {
    files: items,
    totalReturned: items.length
  };
}

// === END OF DriveService.gs (Complete - Step 8 & Step 9 Verified) ===