/**
 * CourseService.gs
 * Pattanabhumi Biology Learning Management System - Step 7 Course Content & Assessment Library
 *
 * Responsibilities:
 * - Manage separate normalized entities across `Courses`, `Sections`, `Cards`, and `Assessments`.
 * - Automatically provision the 3 required default sections for every course:
 *     1. `Course assessment` (`section_type: 'ASSESSMENT'`, `sort_order: 10`)
 *     2. `Reading material` (`section_type: 'READING'`, `sort_order: 20`)
 *     3. `Class recordings` (`section_type: 'RECORDING'`, `sort_order: 30`)
 * - Enforce optimistic concurrency (`expectedVersion`) on courses, sections, cards, and assessments.
 * - Validate all parent-child relationships (`section.course_id === course.course_id`,
 *   `card.course_id === course.course_id`, `card.section_id === section.section_id`) and
 *   strictly block cross-course reassignment if a browser request tampers with IDs.
 * - Enforce reference-integrity rules when removing or archiving sections, cards, and assessments
 *   (including graceful handling of archived assessments still referenced by courses).
 * - Enforce backend student enrollment verification on `student.getCourseDetail`.
 *
 * Security Note:
 * - Every function in this file ends with an underscore (_) so it cannot be called
 *   directly from browser clients via google.script.run.
 */

var PB_DEFAULT_COURSE_SECTIONS_SPEC_ = Object.freeze([
  Object.freeze({
    sectionType: 'ASSESSMENT',
    defaultTitle: 'Course assessment',
    sortOrder: 10
  }),
  Object.freeze({
    sectionType: 'READING',
    defaultTitle: 'Reading material',
    sortOrder: 20
  }),
  Object.freeze({
    sectionType: 'RECORDING',
    defaultTitle: 'Class recordings',
    sortOrder: 30
  })
]);

/**
 * Asserts that `authContext` belongs to an active `ADMIN` user for Step 7 course/assessment actions.
 *
 * @param {Object} authContext Session guard context.
 * @return {Object} Authenticated administrator user row.
 */
function assertStep7AdminRole_(authContext) {
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required for this administrator action.'
    );
  }
  if (authContext.user.status !== 'ACTIVE') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_ACCOUNT_SUSPENDED,
      'Administrator account is not active.'
    );
  }
  if (authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Administrator role is required to manage courses, sections, cards, and assessments.'
    );
  }
  return authContext.user;
}
/**
 * Validates an optional Drive file reference ID (e.g., `cover_file_id` or `image_file_id`).
 *
 * @param {string} rawFileId Candidate file ID string.
 * @param {string} fieldKey Field key for `fieldErrors`.
 * @param {string} fieldLabel Human-readable label.
 * @param {Object} fieldErrors Mutable map of field errors.
 * @return {string} Trimmed file ID or empty string.
 */
function validateOptionalDriveFileRefStep7_(
  rawFileId,
  fieldKey,
  fieldLabel,
  fieldErrors,
  opt_allowedPurposes
) {
  if (
    rawFileId === null ||
    rawFileId === undefined ||
    String(rawFileId).trim() === ''
  ) {
    return '';
  }
  var trimmed = String(rawFileId).trim();
  if (/^(blob:|data:|https?:)/i.test(trimmed)) {
    fieldErrors[fieldKey] =
      fieldLabel +
      ' cannot be a temporary blob:, data:, or web URL. Upload the file first and reference its application file_id (fil_...).';
    return '';
  }
  if (trimmed.length > 100 || !/^[A-Za-z0-9_-]{6,100}$/.test(trimmed)) {
    fieldErrors[fieldKey] =
      fieldLabel +
      ' must be a valid application file reference ID (fil_...) up to 100 characters.';
    return '';
  }
  if (
    trimmed.indexOf('fil_') === 0 &&
    typeof validateExistingActiveFileRefStep8_ === 'function' &&
    Array.isArray(opt_allowedPurposes) &&
    opt_allowedPurposes.length > 0
  ) {
    try {
      validateExistingActiveFileRefStep8_(
        trimmed,
        opt_allowedPurposes,
        fieldKey,
        fieldLabel,
        fieldErrors
      );
    } catch (fileCheckErr) {
      fieldErrors[fieldKey] = String(
        fileCheckErr.message || 'Invalid or inactive file reference.'
      );
    }
  }
  return trimmed;
}

function lookupFileMetaSummaryStep8_(fileId, opt_filesById) {
  if (!fileId || typeof fileId !== 'string' || fileId.indexOf('fil_') !== 0) {
    return null;
  }
  try {
    var fRow = opt_filesById
      ? (opt_filesById[fileId] ? opt_filesById[fileId].record : null)
      : getSheetRecordById_('Files', fileId);
    if (!fRow || fRow.status !== 'ACTIVE') {
      return null;
    }
    return {
      fileId: fRow.file_id,
      purpose: fRow.purpose || '',
      courseId: fRow.course_id || '',
      originalFilename: fRow.original_filename || '',
      mimeType: fRow.mime_type || '',
      sizeBytes: Number(fRow.size_bytes) || 0,
      status: fRow.status || 'ACTIVE',
      createdAtUtc: fRow.created_at_utc || ''
    };
  } catch (ignoreErr) {
    return null;
  }
}
/**
 * Validates an optional `https://` URL for class recordings or external assessment links.
 *
 * @param {string} rawUrl Candidate URL string.
 * @param {string} fieldKey Field key for `fieldErrors`.
 * @param {string} fieldLabel Human-readable label.
 * @param {boolean} isRequired Whether a non-empty URL is required.
 * @param {Object} fieldErrors Mutable map of field errors.
 * @return {string} Validated `https://` URL or empty string.
 */
function validateHttpsResourceUrlStep7_(
  rawUrl,
  fieldKey,
  fieldLabel,
  isRequired,
  fieldErrors
) {
  var trimmed =
    rawUrl === null || rawUrl === undefined ? '' : String(rawUrl).trim();
  if (trimmed.indexOf('<') !== -1) {
    var mEmbedSrc = trimmed.match(/\bsrc\s*=\s*["'](https:\/\/[^"'\s]+)["']/i);
    if (mEmbedSrc && mEmbedSrc[1]) {
      trimmed = mEmbedSrc[1].trim();
    }
  }
  if (!trimmed) {
    if (isRequired) {
      fieldErrors[fieldKey] =
        fieldLabel + ' is required and must begin with https://.';
    }
    return '';
  }
  if (trimmed.length > 500) {
    fieldErrors[fieldKey] = fieldLabel + ' must not exceed 500 characters.';
    return '';
  }
  if (
    /[\s\u0000-\u001F\u007F]/.test(trimmed) ||
    !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(trimmed)
  ) {
    fieldErrors[fieldKey] =
      fieldLabel +
      ' must be a valid https:// URL (http://, javascript:, and data: URLs are not permitted).';
    return '';
  }
  return trimmed;
}
/**
 * Ensures that a course has all 3 default sections (`Course assessment`, `Reading material`,
 * and `Class recordings`) in the `Sections` worksheet.
 * Must be called inside `withScriptLock_` when creating or inspecting a course.
 *
 * @param {string} courseId Target `course_id`.
 * @param {string} nowIso Current UTC ISO timestamp.
 * @return {Array<Object>} Array of section rows belonging to `courseId` (sorted by `sort_order`).
 */
function ensureCourseDefaultSectionsInLock_(courseId, nowIso) {
  var sectionsTbl = readSheetTable_('Sections');
  var courseSections = [];
  var existingTypes = {};

  for (var i = 0; i < sectionsTbl.records.length; i++) {
    var sec = sectionsTbl.records[i];
    if (sec.course_id === courseId) {
      courseSections.push(sec);
      existingTypes[sec.section_type] = sec;
    }
  }

  var createdAny = false;
  for (var d = 0; d < PB_DEFAULT_COURSE_SECTIONS_SPEC_.length; d++) {
    var spec = PB_DEFAULT_COURSE_SECTIONS_SPEC_[d];
    if (!existingTypes[spec.sectionType]) {
      var insertedSec = insertSheetRecord_(
        'Sections',
        {
          section_id: generateEntityId_('sec_'),
          course_id: courseId,
          section_type: spec.sectionType,
          title: spec.defaultTitle,
          status: 'PUBLISHED',
          sort_order: spec.sortOrder,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
      courseSections.push(insertedSec);
      createdAny = true;
    }
  }

  if (createdAny) {
    sectionsTbl = readSheetTable_('Sections');
    courseSections = [];
    for (var j = 0; j < sectionsTbl.records.length; j++) {
      if (sectionsTbl.records[j].course_id === courseId) {
        courseSections.push(sectionsTbl.records[j]);
      }
    }
  }

  courseSections.sort(function (a, b) {
    var orderDiff = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    if (orderDiff !== 0) {
      return orderDiff;
    }
    return String(a.section_id || '').localeCompare(String(b.section_id || ''));
  });

  return courseSections;
}
/**
 * Formats an `Assessments` row into a client-safe DTO, including how many course cards
 * currently reference it.
 *
 * @param {Object} assessmentRow Raw row from `Assessments`.
 * @param {number} referencedCourseCardCount Number of non-deleted cards referencing this assessment.
 * @param {Array<string>} referencedCourseTitles Titles of courses referencing this assessment.
 * @return {Object} Client-safe assessment summary.
 */
function buildAssessmentDtoStep7_(
  assessmentRow,
  referencedCourseCardCount,
  referencedCourseTitles
) {
  var descDoc = parseStoredRichTextJsonSafe_(
    assessmentRow.description_richtext_json
  );
  return {
    assessmentId: assessmentRow.assessment_id,
    title: assessmentRow.title || '',
    descriptionRichText: descDoc,
    externalUrl: assessmentRow.external_url || '',
    pdfFileId: assessmentRow.pdf_file_id || '',
    pdfFileMeta: lookupFileMetaSummaryStep8_(assessmentRow.pdf_file_id),
    status: assessmentRow.status || 'ACTIVE',
    isArchived: assessmentRow.status === 'ARCHIVED',
    referencedCardCount: Number(referencedCourseCardCount || 0),
    referencedCourseTitles: Array.isArray(referencedCourseTitles)
      ? referencedCourseTitles
      : [],
    createdAtUtc: assessmentRow.created_at_utc || '',
    updatedAtUtc: assessmentRow.updated_at_utc || '',
    updatedAtBangkok: assessmentRow.updated_at_utc
      ? formatBangkokTimestamp_(assessmentRow.updated_at_utc)
      : '',
    version: Number(assessmentRow.version || 1)
  };
}
/**
 * Formats a `Cards` row into a client-safe DTO, joining linked `Assessments` metadata
 * and flagging if a linked assessment has been archived in the library.
 *
 * @param {Object} cardRow Raw row from `Cards`.
 * @param {Object} assessmentsById Lookup map from `readSheetTable_('Assessments').byId`.
 * @return {Object} Client-safe card DTO.
 */
function buildCardDtoStep7_(cardRow, assessmentsById, opt_filesById) {
  var contentDoc = parseStoredRichTextJsonSafe_(cardRow.content_richtext_json);
  var linkedAssessment = null;
  var assessmentArchivedWarning = false;

  if (
    cardRow.assessment_id &&
    assessmentsById &&
    assessmentsById[cardRow.assessment_id]
  ) {
    var aRec = assessmentsById[cardRow.assessment_id].record;
    var isArch = aRec.status === 'ARCHIVED';
    assessmentArchivedWarning = isArch;
    linkedAssessment = {
      assessmentId: aRec.assessment_id,
      title: aRec.title || '',
      descriptionRichText: parseStoredRichTextJsonSafe_(
        aRec.description_richtext_json
      ),
      externalUrl: aRec.external_url || '',
      pdfFileId: aRec.pdf_file_id || '',
      status: aRec.status || 'ACTIVE',
      isArchived: isArch,
      archiveStatusNote: isArch
        ? 'Archived in Assessment Library (existing course reference preserved).'
        : 'Active in Assessment Library'
    };
  } else if (cardRow.assessment_id) {
    assessmentArchivedWarning = true;
    linkedAssessment = {
      assessmentId: cardRow.assessment_id,
      title: cardRow.title || 'Unresolved Assessment Reference',
      descriptionRichText: plainTextToRichTextDoc_(''),
      externalUrl: '',
      pdfFileId: '',
      status: 'MISSING',
      isArchived: true,
      archiveStatusNote: 'Assessment record was not found in the library.'
    };
  }

  var extractedPdfs = [];
  var extractedLinks = [];
  if (contentDoc && Array.isArray(contentDoc.blocks)) {
    for (var bIdx = 0; bIdx < contentDoc.blocks.length; bIdx++) {
      var blk = contentDoc.blocks[bIdx];
      if (!blk || typeof blk !== 'object') {
        continue;
      }
      if (blk.type === 'pdf_attachment' && blk.fileId) {
        extractedPdfs.push({
          fileId: blk.fileId,
          title: blk.title || 'Course PDF Handout',
          meta: lookupFileMetaSummaryStep8_(blk.fileId, opt_filesById)
        });
      }
      var spansToScan = [];
      if (blk.type === 'paragraph' && Array.isArray(blk.spans)) {
        spansToScan = blk.spans;
      } else if (
        (blk.type === 'bullet_list' || blk.type === 'ordered_list') &&
        Array.isArray(blk.items)
      ) {
        for (var it = 0; it < blk.items.length; it++) {
          if (blk.items[it] && Array.isArray(blk.items[it].spans)) {
            spansToScan = spansToScan.concat(blk.items[it].spans);
          }
        }
      }
      for (var sp = 0; sp < spansToScan.length; sp++) {
        var spObj = spansToScan[sp];
        if (spObj && spObj.link && /^https:\/\//i.test(spObj.link)) {
          extractedLinks.push({
            url: spObj.link,
            label: spObj.text || spObj.link
          });
        }
      }
    }
  }
  if (
    cardRow.card_type === 'READING_CARD' &&
    cardRow.recording_url &&
    /^https:\/\//i.test(String(cardRow.recording_url).trim())
  ) {
    extractedLinks.unshift({
      url: String(cardRow.recording_url).trim(),
      label: 'External Study Resource Link'
    });
  }
  var cleanRecUrl = cardRow.recording_url ? String(cardRow.recording_url).trim() : '';
  var ytMeta =
    typeof extractAndNormalizeYouTubeUrlPhase4_ === 'function'
      ? extractAndNormalizeYouTubeUrlPhase4_(cleanRecUrl)
      : {
          isYouTubeVideo: false,
          youtubeVideoId: '',
          youtubeEmbedUrl: '',
          youtubeWatchUrl: '',
          normalizedUrl: cleanRecUrl
        };

  return {
    cardId: cardRow.card_id,
    courseId: cardRow.course_id,
    sectionId: cardRow.section_id,
    cardType: cardRow.card_type || 'READING_CARD',
    title: cardRow.title || '',
    subtitle: cardRow.subtitle || '',
    imageFileId: cardRow.image_file_id || '',
    imageFileMeta: lookupFileMetaSummaryStep8_(cardRow.image_file_id, opt_filesById),
    imageCaption: cardRow.image_caption || '',
    contentRichText: contentDoc,
    pdfAttachments: extractedPdfs,
    lessonDocuments: extractedPdfs,
    resourceLinks: extractedLinks,
    recordingUrl: cleanRecUrl,
    hasRecordingUrl: Boolean(cleanRecUrl && /^https:\/\//i.test(cleanRecUrl)),
    isYouTubeVideo: Boolean(ytMeta.isYouTubeVideo),
    youtubeVideoId: ytMeta.youtubeVideoId || '',
    youtubeEmbedUrl: ytMeta.youtubeEmbedUrl || '',
    youtubeWatchUrl: ytMeta.youtubeWatchUrl || '',
    recordingUploadedAtUtc: cardRow.recording_uploaded_at_utc || '',
    recordingUploadedAtBangkok: cardRow.recording_uploaded_at_utc
      ? formatBangkokTimestamp_(cardRow.recording_uploaded_at_utc)
      : '',
    assessmentId: cardRow.assessment_id || '',
    linkedAssessment: linkedAssessment,
    assessmentArchivedWarning: assessmentArchivedWarning,
    status: cardRow.status || 'PUBLISHED',
    sortOrder: Number(cardRow.sort_order || 10),
    createdAtUtc: cardRow.created_at_utc || '',
    updatedAtUtc: cardRow.updated_at_utc || '',
    updatedAtBangkok: cardRow.updated_at_utc
      ? formatBangkokTimestamp_(cardRow.updated_at_utc)
      : '',
    version: Number(cardRow.version || 1)
  };
}
/**
 * Formats a `Courses` row into a client-safe DTO.
 *
 * @param {Object} courseRow Raw row from `Courses`.
 * @param {number} sectionCount Number of sections in this course.
 * @param {number} cardCount Number of cards in this course.
 * @param {number} activeEnrollmentCount Number of active student enrollments.
 * @return {Object} Client-safe course DTO.
 */
function buildCourseDtoStep7_(
  courseRow,
  sectionCount,
  cardCount,
  activeEnrollmentCount
) {
  return {
    courseId: courseRow.course_id,
    courseCode: courseRow.course_code || '',
    title: courseRow.title || '',
    subtitle: courseRow.subtitle || '',
    coverFileId: courseRow.cover_file_id || '',
    coverFileMeta: lookupFileMetaSummaryStep8_(courseRow.cover_file_id),
    coverUploadFeatureStatus:
      'Drive file reference stored; direct cover image upload will be connected in the Private File Storage step.',
    status: courseRow.status || 'DRAFT',
    sortOrder: Number(courseRow.sort_order || 10),
    objectivesRichText: parseStoredRichTextJsonSafe_(
      courseRow.objectives_richtext_json
    ),
    outcomesRichText: parseStoredRichTextJsonSafe_(
      courseRow.outcomes_richtext_json
    ),
    assessmentUpdatedAtUtc: courseRow.assessment_updated_at_utc || '',
    assessmentUpdatedAtBangkok: courseRow.assessment_updated_at_utc
      ? formatBangkokTimestamp_(courseRow.assessment_updated_at_utc)
      : '',
    readingUpdatedAtUtc: courseRow.reading_updated_at_utc || '',
    readingUpdatedAtBangkok: courseRow.reading_updated_at_utc
      ? formatBangkokTimestamp_(courseRow.reading_updated_at_utc)
      : '',
    calendarTag: courseRow.calendar_tag || '',
    createdAtUtc: courseRow.created_at_utc || '',
    updatedAtUtc: courseRow.updated_at_utc || '',
    updatedAtBangkok: courseRow.updated_at_utc
      ? formatBangkokTimestamp_(courseRow.updated_at_utc)
      : '',
    version: Number(courseRow.version || 1),
    sectionCount: Number(sectionCount || 0),
    cardCount: Number(cardCount || 0),
    activeEnrollmentCount: Number(activeEnrollmentCount || 0)
  };
}
/**
 * Lists all courses (with section, card, and enrollment counts) and all assessment library
 * items for the Admin Dashboard (`admin.listCourses`).
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload Optional filter payload (`statusFilter`, `searchQuery`).
 * @return {Object} Course list and assessment library snapshot.
 */
function adminListCoursesStep7_(authContext, payload) {
  assertStep7AdminRole_(authContext);
  var req = payload || {};
  var statusFilter = String(req.statusFilter || 'ALL')
    .trim()
    .toUpperCase();
  var searchQuery = String(req.searchQuery || '')
    .trim()
    .toLowerCase();

  var coursesTbl = readSheetTable_('Courses');
  var sectionsTbl = readSheetTable_('Sections');
  var cardsTbl = readSheetTable_('Cards');
  var enrollmentsTbl = readSheetTable_('Enrollments');
  var assessmentsTbl = readSheetTable_('Assessments');

  var sectionCountByCourse = {};
  for (var s = 0; s < sectionsTbl.records.length; s++) {
    var sec = sectionsTbl.records[s];
    if (sec.status !== 'ARCHIVED') {
      sectionCountByCourse[sec.course_id] =
        (sectionCountByCourse[sec.course_id] || 0) + 1;
    }
  }

  var cardCountByCourse = {};
  var cardRefCountByAssessment = {};
  var courseIdsByAssessment = {};
  for (var c = 0; c < cardsTbl.records.length; c++) {
    var crd = cardsTbl.records[c];
    if (crd.status !== 'ARCHIVED') {
      cardCountByCourse[crd.course_id] =
        (cardCountByCourse[crd.course_id] || 0) + 1;
    }
    if (crd.assessment_id) {
      cardRefCountByAssessment[crd.assessment_id] =
        (cardRefCountByAssessment[crd.assessment_id] || 0) + 1;
      if (!courseIdsByAssessment[crd.assessment_id]) {
        courseIdsByAssessment[crd.assessment_id] = {};
      }
      courseIdsByAssessment[crd.assessment_id][crd.course_id] = true;
    }
  }

  var enrollmentCountByCourse = {};
  for (var e = 0; e < enrollmentsTbl.records.length; e++) {
    var enr = enrollmentsTbl.records[e];
    if (enr.status === 'ACTIVE') {
      enrollmentCountByCourse[enr.course_id] =
        (enrollmentCountByCourse[enr.course_id] || 0) + 1;
    }
  }

  var sortedCourses = coursesTbl.records.slice().sort(function (a, b) {
    var orderDiff = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    if (orderDiff !== 0) {
      return orderDiff;
    }
    return String(a.course_code || '').localeCompare(
      String(b.course_code || '')
    );
  });

  var courseDtos = [];
  for (var i = 0; i < sortedCourses.length; i++) {
    var row = sortedCourses[i];
    if (statusFilter !== 'ALL' && row.status !== statusFilter) {
      continue;
    }
    if (searchQuery) {
      var hay =
        String(row.course_code || '').toLowerCase() +
        ' ' +
        String(row.title || '').toLowerCase() +
        ' ' +
        String(row.subtitle || '').toLowerCase();
      if (hay.indexOf(searchQuery) === -1) {
        continue;
      }
    }
    courseDtos.push(
      buildCourseDtoStep7_(
        row,
        sectionCountByCourse[row.course_id] || 0,
        cardCountByCourse[row.course_id] || 0,
        enrollmentCountByCourse[row.course_id] || 0
      )
    );
  }

  var assessmentDtos = [];
  for (var a = 0; a < assessmentsTbl.records.length; a++) {
    var aRow = assessmentsTbl.records[a];
    var refCourseMap = courseIdsByAssessment[aRow.assessment_id] || {};
    var refCourseIds = Object.keys(refCourseMap);
    var refTitles = [];
    for (var rIdx = 0; rIdx < refCourseIds.length; rIdx++) {
      var cHit = coursesTbl.byId[refCourseIds[rIdx]];
      if (cHit && cHit.record) {
        refTitles.push(cHit.record.title || cHit.record.course_code);
      }
    }
    assessmentDtos.push(
      buildAssessmentDtoStep7_(
        aRow,
        cardRefCountByAssessment[aRow.assessment_id] || 0,
        refTitles
      )
    );
  }

  return {
    courses: courseDtos,
    totalCoursesCount: coursesTbl.records.length,
    assessments: assessmentDtos,
    richTextSchemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
    gradingPolicyNotice:
      'Assessment Library manages reusable assessment descriptors and optional external https:// links. Automatic grading is not implemented.',
    fileAttachmentNotice:
      'Direct image and PDF binary uploads into course covers, reading cards, and assessments will be connected in the Private Google Drive File Storage step.'
  };
}
/**
 * Retrieves full course editor detail (`admin.getCourseEditorDetail`), including:
 * - Course record (with `objectivesRichText`, `outcomesRichText`, and `version`)
 * - All sections belonging to the course (automatically ensuring the 3 default sections exist)
 * - All cards grouped by section (with joined assessment library details and archive warnings)
 * - Active student enrollments for this course
 * - Available assessment library items for linking into sections
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload `{ courseId: string }`.
 * @return {Object} Complete course editor bundle.
 */
function adminGetCourseEditorDetailStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var courseId = String(req.courseId || '').trim();
  if (!courseId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'courseId is required to load the course editor.',
      { courseId: 'Please select a course to inspect.' }
    );
  }

  return withScriptLock_(function () {
    var coursesTbl = readSheetTable_('Courses');
    var cHit = coursesTbl.byId[courseId];
    if (!cHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Course ID "' + courseId + '" was not found in the Courses sheet.'
      );
    }
    var courseRow = cHit.record;
    var nowIso = nowUtcIso_();

    var courseSections = ensureCourseDefaultSectionsInLock_(courseId, nowIso);
    var cardsTbl = readSheetTable_('Cards');
    var assessmentsTbl = readSheetTable_('Assessments');
    var enrollmentsTbl = readSheetTable_('Enrollments');
    var usersTbl = readSheetTable_('Users');

    var cardsBySectionId = {};
    var totalCourseCards = 0;
    for (var i = 0; i < cardsTbl.records.length; i++) {
      var crd = cardsTbl.records[i];
      if (crd.course_id === courseId) {
        if (!cardsBySectionId[crd.section_id]) {
          cardsBySectionId[crd.section_id] = [];
        }
        cardsBySectionId[crd.section_id].push(crd);
        if (crd.status !== 'ARCHIVED') {
          totalCourseCards++;
        }
      }
    }

    var sectionDtos = [];
    for (var sIdx = 0; sIdx < courseSections.length; sIdx++) {
      var sec = courseSections[sIdx];
      var secCards = (cardsBySectionId[sec.section_id] || [])
        .slice()
        .sort(function (a, b) {
          var diff =
            (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
          if (diff !== 0) {
            return diff;
          }
          return String(a.card_id || '').localeCompare(String(b.card_id || ''));
        });

      var cardDtos = [];
      for (var cIdx = 0; cIdx < secCards.length; cIdx++) {
        cardDtos.push(buildCardDtoStep7_(secCards[cIdx], assessmentsTbl.byId));
      }

      var isDefaultSectionType =
        sec.section_type === 'ASSESSMENT' ||
        sec.section_type === 'READING' ||
        sec.section_type === 'RECORDING';

      sectionDtos.push({
        sectionId: sec.section_id,
        courseId: sec.course_id,
        sectionType: sec.section_type || 'CUSTOM',
        isDefaultSection: isDefaultSectionType,
        title: sec.title || '',
        status: sec.status || 'PUBLISHED',
        sortOrder: Number(sec.sort_order || 10),
        updatedAtUtc: sec.updated_at_utc || '',
        updatedAtBangkok: sec.updated_at_utc
          ? formatBangkokTimestamp_(sec.updated_at_utc)
          : '',
        version: Number(sec.version || 1),
        cards: cardDtos,
        cardCount: cardDtos.length,
        canHardDelete: !isDefaultSectionType && cardDtos.length === 0
      });
    }

    var enrolledStudents = [];
    for (var eIdx = 0; eIdx < enrollmentsTbl.records.length; eIdx++) {
      var enr = enrollmentsTbl.records[eIdx];
      if (enr.course_id === courseId && enr.status === 'ACTIVE') {
        var uHit = usersTbl.byId[enr.user_id];
        if (uHit && uHit.record) {
          enrolledStudents.push({
            enrollmentId: enr.enrollment_id,
            userId: uHit.record.user_id,
            username:
              uHit.record.username_display || uHit.record.username_lower,
            fullName: uHit.record.full_name || '',
            email: uHit.record.email || '',
            userStatus: uHit.record.status || 'ACTIVE',
            assignedAtUtc: enr.assigned_at_utc || '',
            assignedAtBangkok: enr.assigned_at_utc
              ? formatBangkokTimestamp_(enr.assigned_at_utc)
              : ''
          });
        }
      }
    }

    var assessmentDtos = [];
    for (var aIdx = 0; aIdx < assessmentsTbl.records.length; aIdx++) {
      assessmentDtos.push(
        buildAssessmentDtoStep7_(assessmentsTbl.records[aIdx], 0, [])
      );
    }

    return {
      course: buildCourseDtoStep7_(
        courseRow,
        sectionDtos.length,
        totalCourseCards,
        enrolledStudents.length
      ),
      sections: sectionDtos,
      publishedScores:
        typeof listStudentPublishedScoresPhase4_ === 'function'
          ? listStudentPublishedScoresPhase4_(adminUser.user_id, courseRow.course_id, true).publishedScores
          : [],
      nativeExamCatalog:
        typeof handleStudentListExamsPhase3_ === 'function' && openConfiguredSpreadsheet_().getSheetByName('ExamSets') ? handleStudentListExamsPhase3_({ courseId: courseRow.course_id, adminPreview: true }, { authContext: authContext }) : { exams: [], legacyExternalAssessments: [] },
      enrolledStudents: enrolledStudents,
      assessmentsLibrary: assessmentDtos
    };
  });
}
/**
 * Creates a new course (automatically initializing the 3 default sections) or updates an
 * existing course with optimistic concurrency (`expectedVersion`) checking (`admin.saveCourse`).
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload Course save payload.
 * @return {Object} Saved course detail bundle.
 */
function adminSaveCourseStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var fieldErrors = {};

  var courseId = req.courseId ? String(req.courseId).trim() : '';
  var isCreate = !courseId;

  var title = sanitizeSingleLineTextStep7_(req.title, 160);
  if (!title || title.length < 3) {
    fieldErrors.title = 'Course title is required (3 to 160 characters).';
  }

  var courseCode = sanitizeSingleLineTextStep7_(
    req.courseCode,
    40
  ).toUpperCase();
  if (!courseCode || !/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(courseCode)) {
    fieldErrors.courseCode =
      'Course code is required (3-40 uppercase letters, digits, hyphens, or underscores, e.g. BIO-101-CELL).';
  }

  var subtitle = sanitizeSingleLineTextStep7_(req.subtitle, 240);
  var calendarTag = sanitizeSingleLineTextStep7_(req.calendarTag, 60);
  var coverFileId = validateOptionalDriveFileRefStep7_(
    req.coverFileId,
    'coverFileId',
    'Course cover Drive file ID',
    fieldErrors,
    ['COURSE_COVER', 'COURSE_IMAGE']
  );

  var status = String(req.status || (isCreate ? 'DRAFT' : 'PUBLISHED'))
    .trim()
    .toUpperCase();
  if (status !== 'DRAFT' && status !== 'PUBLISHED' && status !== 'ARCHIVED') {
    fieldErrors.status = 'Course status must be DRAFT, PUBLISHED, or ARCHIVED.';
  }

  var sortOrder = Number(
    req.sortOrder !== undefined && req.sortOrder !== '' ? req.sortOrder : 10
  );
  if (isNaN(sortOrder) || sortOrder < 0 || sortOrder > 99999) {
    fieldErrors.sortOrder = 'Sort order must be a number between 0 and 99999.';
  } else {
    sortOrder = Math.floor(sortOrder);
  }

  var objectivesValidated = null;
  var outcomesValidated = null;
  try {
    if (req.objectivesRichText !== undefined) {
      objectivesValidated = validateAndNormalizeRichTextInput_(
        req.objectivesRichText,
        'objectivesRichText',
        'Course objectives',
        false
      );
    }
  } catch (objErr) {
    if (objErr && objErr.fieldErrors) {
      Object.assign(fieldErrors, objErr.fieldErrors);
    } else {
      fieldErrors.objectivesRichText = String(objErr.message || objErr);
    }
  }

  try {
    if (req.outcomesRichText !== undefined) {
      outcomesValidated = validateAndNormalizeRichTextInput_(
        req.outcomesRichText,
        'outcomesRichText',
        'Course learning outcomes',
        false
      );
    }
  } catch (outErr) {
    if (outErr && outErr.fieldErrors) {
      Object.assign(fieldErrors, outErr.fieldErrors);
    } else {
      fieldErrors.outcomesRichText = String(outErr.message || outErr);
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please correct the highlighted course fields before saving.',
      fieldErrors
    );
  }

  var savedCourseId = '';
  withScriptLock_(function () {
    var coursesTbl = readSheetTable_('Courses');
    var nowIso = nowUtcIso_();

    for (var i = 0; i < coursesTbl.records.length; i++) {
      var existing = coursesTbl.records[i];
      if (
        String(existing.course_code || '').toUpperCase() === courseCode &&
        existing.course_id !== courseId
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Another course already uses course code "' + courseCode + '".',
          { courseCode: 'Course code "' + courseCode + '" is already in use.' }
        );
      }
    }

    if (isCreate) {
      savedCourseId = generateEntityId_('crs_');
      var defaultObjectivesJson = objectivesValidated
        ? objectivesValidated.json
        : plainTextToRichTextJson_('');
      var defaultOutcomesJson = outcomesValidated
        ? outcomesValidated.json
        : plainTextToRichTextJson_('');

      insertSheetRecord_(
        'Courses',
        {
          course_id: savedCourseId,
          course_code: courseCode,
          title: title,
          subtitle: subtitle,
          cover_file_id: coverFileId,
          status: status,
          sort_order: sortOrder,
          objectives_richtext_json: defaultObjectivesJson,
          outcomes_richtext_json: defaultOutcomesJson,
          assessment_updated_at_utc: nowIso,
          reading_updated_at_utc: nowIso,
          calendar_tag: calendarTag || '[' + courseCode + ']',
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
      ensureCourseDefaultSectionsInLock_(savedCourseId, nowIso);

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_COURSE_CREATED',
        targetEntityType: 'Course',
        targetEntityId: savedCourseId,
        summary: {
          courseCode: courseCode,
          title: title,
          status: status,
          defaultSectionsCreated: 3
        }
      });
    } else {
      var cHit = coursesTbl.byId[courseId];
      if (!cHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Course ID "' + courseId + '" was not found.'
        );
      }
      var expectedVersion = Number(req.expectedVersion);
      var actualVersion = Number(cHit.record.version || 1);
      if (!expectedVersion || expectedVersion !== actualVersion) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Stale course edit detected: expected version ' +
            expectedVersion +
            ', but the server record is at version ' +
            actualVersion +
            '. Please reload the course before saving.',
          {
            version:
              'Another administrator updated this course (server version ' +
              actualVersion +
              '). Reload to view the latest changes.'
          }
        );
      }

      var patch = {
        course_code: courseCode,
        title: title,
        subtitle: subtitle,
        cover_file_id: coverFileId,
        status: status,
        sort_order: sortOrder,
        calendar_tag:
          calendarTag || cHit.record.calendar_tag || '[' + courseCode + ']',
        updated_at_utc: nowIso
      };

      if (objectivesValidated) {
        patch.objectives_richtext_json = objectivesValidated.json;
        patch.assessment_updated_at_utc = nowIso;
      }
      if (outcomesValidated) {
        patch.outcomes_richtext_json = outcomesValidated.json;
        patch.assessment_updated_at_utc = nowIso;
      }

      updateSheetRecordById_('Courses', courseId, patch, expectedVersion, {
        skipLock: true
      });
      ensureCourseDefaultSectionsInLock_(courseId, nowIso);
      savedCourseId = courseId;

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_COURSE_UPDATED',
        targetEntityType: 'Course',
        targetEntityId: savedCourseId,
        summary: {
          courseCode: courseCode,
          title: title,
          status: status,
          previousVersion: expectedVersion,
          newVersion: expectedVersion + 1
        }
      });
    }
  });

  var detail = adminGetCourseEditorDetailStep7_(authContext, {
    courseId: savedCourseId
  });
  detail.savedMessage = isCreate
    ? 'Created course "' +
      title +
      '" (' +
      courseCode +
      ') and initialized its 3 default sections (Course assessment, Reading material, Class recordings).'
    : 'Saved course "' + title + '" (' + courseCode + ').';
  return detail;
}
/**
 * Adds a new section to a course or renames/updates an existing section (`admin.saveSection`).
 * Strictly verifies `existingSection.course_id === payload.courseId` so an attacker or
 * modified browser request cannot reassign a section across courses.
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload Section save payload.
 * @return {Object} Updated course editor detail bundle.
 */
/**
 * Permanently deletes a course and its dependent sections, cards, enrollments,
 * and assessment scores (`admin.deleteCourse`).
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload `{ courseId: string }`.
 * @return {Object} Deletion summary and updated course list.
 */
function adminDeleteCourseStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var courseId = String(req.courseId || '').trim();
  if (!courseId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'courseId is required to delete a course.',
      { courseId: 'Please select a valid course to delete.' }
    );
  }

  var deletedCourseCode = '';
  var deletedTitle = '';
  var removedSectionsCount = 0;
  var removedCardsCount = 0;
  var removedEnrollmentsCount = 0;
  var removedScoresCount = 0;

  withScriptLock_(function () {
    var coursesTbl = readSheetTable_('Courses');
    var cHit = coursesTbl.byId[courseId];
    if (!cHit || !cHit.record) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Course ID "' + courseId + '" was not found.'
      );
    }

    deletedCourseCode = String(cHit.record.course_code || '');
    deletedTitle = String(cHit.record.title || deletedCourseCode);

    /* Remove dependent Cards in reverse row order */
    var cardsTbl = readSheetTable_('Cards');
    var cardIdsToDelete = [];
    for (var cIdx = cardsTbl.records.length - 1; cIdx >= 0; cIdx--) {
      if (cardsTbl.records[cIdx].course_id === courseId) {
        cardIdsToDelete.push(cardsTbl.records[cIdx].card_id);
      }
    }
    for (var cd = 0; cd < cardIdsToDelete.length; cd++) {
      deleteSheetRecordById_('Cards', cardIdsToDelete[cd], null, { skipLock: true });
      removedCardsCount++;
    }

    /* Remove dependent Sections in reverse row order */
    var sectionsTbl = readSheetTable_('Sections');
    var sectionIdsToDelete = [];
    for (var sIdx = sectionsTbl.records.length - 1; sIdx >= 0; sIdx--) {
      if (sectionsTbl.records[sIdx].course_id === courseId) {
        sectionIdsToDelete.push(sectionsTbl.records[sIdx].section_id);
      }
    }
    for (var sd = 0; sd < sectionIdsToDelete.length; sd++) {
      deleteSheetRecordById_('Sections', sectionIdsToDelete[sd], null, { skipLock: true });
      removedSectionsCount++;
    }

    /* Remove dependent Enrollments in reverse row order */
    var enrollmentsTbl = readSheetTable_('Enrollments');
    var enrollmentIdsToDelete = [];
    for (var eIdx = enrollmentsTbl.records.length - 1; eIdx >= 0; eIdx--) {
      if (enrollmentsTbl.records[eIdx].course_id === courseId) {
        enrollmentIdsToDelete.push(enrollmentsTbl.records[eIdx].enrollment_id);
      }
    }
    for (var ed = 0; ed < enrollmentIdsToDelete.length; ed++) {
      deleteSheetRecordById_('Enrollments', enrollmentIdsToDelete[ed], null, { skipLock: true });
      removedEnrollmentsCount++;
    }

    /* Remove dependent AssessmentScores in reverse row order */
    try {
      var scoresTbl = readSheetTable_('AssessmentScores');
      var scoreIdsToDelete = [];
      for (var scIdx = scoresTbl.records.length - 1; scIdx >= 0; scIdx--) {
        if (scoresTbl.records[scIdx].course_id === courseId) {
          scoreIdsToDelete.push(scoresTbl.records[scIdx].score_id);
        }
      }
      for (var scd = 0; scd < scoreIdsToDelete.length; scd++) {
        deleteSheetRecordById_('AssessmentScores', scoreIdsToDelete[scd], null, { skipLock: true });
        removedScoresCount++;
      }
    } catch (ignoreScoresErr) {}

    /* Finally delete the Course record itself */
    deleteSheetRecordById_('Courses', courseId, null, { skipLock: true });

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_COURSE_DELETED',
      targetEntityType: 'Course',
      targetEntityId: courseId,
      summary: {
        courseCode: deletedCourseCode,
        title: deletedTitle,
        removedSectionsCount: removedSectionsCount,
        removedCardsCount: removedCardsCount,
        removedEnrollmentsCount: removedEnrollmentsCount,
        removedScoresCount: removedScoresCount
      }
    });
  });

  var catalog = adminListCoursesStep7_(authContext, {});
  catalog.deleted = true;
  catalog.deletedCourseId = courseId;
  catalog.deletedCourseCode = deletedCourseCode;
  catalog.deletedTitle = deletedTitle;
  catalog.savedMessage =
    'Deleted course "' +
    deletedTitle +
    '" (' +
    deletedCourseCode +
    ') along with ' +
    String(removedSectionsCount) +
    ' section(s), ' +
    String(removedCardsCount) +
    ' card(s), and ' +
    String(removedEnrollmentsCount) +
    ' enrollment(s).';
  return catalog;
}

function adminSaveSectionStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var fieldErrors = {};

  var courseId = String(req.courseId || '').trim();
  if (!courseId) {
    fieldErrors.courseId = 'Parent courseId is required.';
  }
  var sectionId = req.sectionId ? String(req.sectionId).trim() : '';
  var isCreate = !sectionId;

  var title = sanitizeSingleLineTextStep7_(req.title, 140);
  if (!title || title.length < 2) {
    fieldErrors.title = 'Section title is required (2 to 140 characters).';
  }

  var status = String(req.status || 'PUBLISHED')
    .trim()
    .toUpperCase();
  if (status !== 'DRAFT' && status !== 'PUBLISHED' && status !== 'ARCHIVED') {
    fieldErrors.status =
      'Section status must be DRAFT, PUBLISHED, or ARCHIVED.';
  }

  var sectionType = String(req.sectionType || 'CUSTOM')
    .trim()
    .toUpperCase();
  if (
    sectionType !== 'ASSESSMENT' &&
    sectionType !== 'READING' &&
    sectionType !== 'RECORDING' &&
    sectionType !== 'CUSTOM'
  ) {
    fieldErrors.sectionType =
      'Section type must be ASSESSMENT, READING, RECORDING, or CUSTOM.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please fix the highlighted section fields.',
      fieldErrors
    );
  }

  withScriptLock_(function () {
    var coursesTbl = readSheetTable_('Courses');
    var cHit = coursesTbl.byId[courseId];
    if (!cHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Parent course "' + courseId + '" was not found.'
      );
    }

    var sectionsTbl = readSheetTable_('Sections');
    var nowIso = nowUtcIso_();

    if (isCreate) {
      var maxSortOrder = 0;
      for (var i = 0; i < sectionsTbl.records.length; i++) {
        if (sectionsTbl.records[i].course_id === courseId) {
          var sOrder = Number(sectionsTbl.records[i].sort_order) || 0;
          if (sOrder > maxSortOrder) {
            maxSortOrder = sOrder;
          }
        }
      }
      var requestedOrder =
        req.sortOrder !== undefined && req.sortOrder !== ''
          ? Math.floor(Number(req.sortOrder))
          : maxSortOrder + 10;

      var newSecId = generateEntityId_('sec_');
      insertSheetRecord_(
        'Sections',
        {
          section_id: newSecId,
          course_id: courseId,
          section_type: sectionType,
          title: title,
          status: status,
          sort_order: isNaN(requestedOrder)
            ? maxSortOrder + 10
            : requestedOrder,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );

      updateSheetRecordById_(
        'Courses',
        courseId,
        { updated_at_utc: nowIso },
        Number(cHit.record.version || 1),
        { skipLock: true }
      );

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_SECTION_CREATED',
        targetEntityType: 'Section',
        targetEntityId: newSecId,
        summary: {
          courseId: courseId,
          title: title,
          sectionType: sectionType,
          status: status
        }
      });
    } else {
      var sHit = sectionsTbl.byId[sectionId];
      if (!sHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Section ID "' + sectionId + '" was not found.'
        );
      }

      if (sHit.record.course_id !== courseId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Cross-course reassignment rejected: Section "' +
            sectionId +
            '" belongs to course "' +
            sHit.record.course_id +
            '" and cannot be reassigned to course "' +
            courseId +
            '".',
          {
            courseId:
              'Section belongs to a different course and cannot be reassigned.'
          }
        );
      }

      var expectedVersion = Number(req.expectedVersion);
      var actualVersion = Number(sHit.record.version || 1);
      if (!expectedVersion || expectedVersion !== actualVersion) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Stale section edit detected: expected version ' +
            expectedVersion +
            ', but server version is ' +
            actualVersion +
            '. Please reload the course editor.',
          {
            version:
              'This section was updated by another administrator (version ' +
              actualVersion +
              ').'
          }
        );
      }

      var sortOrderPatch =
        req.sortOrder !== undefined && req.sortOrder !== ''
          ? Math.floor(Number(req.sortOrder))
          : Number(sHit.record.sort_order || 10);

      updateSheetRecordById_(
        'Sections',
        sectionId,
        {
          title: title,
          status: status,
          sort_order: isNaN(sortOrderPatch) ? 10 : sortOrderPatch,
          updated_at_utc: nowIso
        },
        expectedVersion,
        { skipLock: true }
      );

      var coursePatch = { updated_at_utc: nowIso };
      if (sHit.record.section_type === 'ASSESSMENT') {
        coursePatch.assessment_updated_at_utc = nowIso;
      } else if (sHit.record.section_type === 'READING') {
        coursePatch.reading_updated_at_utc = nowIso;
      }
      updateSheetRecordById_(
        'Courses',
        courseId,
        coursePatch,
        Number(cHit.record.version || 1),
        { skipLock: true }
      );

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_SECTION_UPDATED',
        targetEntityType: 'Section',
        targetEntityId: sectionId,
        summary: {
          courseId: courseId,
          title: title,
          status: status,
          newVersion: expectedVersion + 1
        }
      });
    }
  });

  var detail = adminGetCourseEditorDetailStep7_(authContext, {
    courseId: courseId
  });
  detail.savedMessage = isCreate
    ? 'Added section "' + title + '".'
    : 'Updated section "' + title + '".';
  return detail;
}
/**
 * Reorders sections within a course (`admin.reorderSections`).
 * Validates that every section ID in `orderedSectionIds` belongs to `payload.courseId`.
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload `{ courseId: string, orderedSectionIds: Array<string> }`.
 * @return {Object} Updated course editor detail bundle.
 */
function adminReorderSectionsStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var courseId = String(req.courseId || '').trim();
  var orderedSectionIds = Array.isArray(req.orderedSectionIds)
    ? req.orderedSectionIds
    : [];

  if (!courseId || orderedSectionIds.length === 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'courseId and a non-empty orderedSectionIds array are required to reorder sections.'
    );
  }

  withScriptLock_(function () {
    var coursesTbl = readSheetTable_('Courses');
    var cHit = coursesTbl.byId[courseId];
    if (!cHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Course "' + courseId + '" was not found.'
      );
    }

    var sectionsTbl = readSheetTable_('Sections');
    var nowIso = nowUtcIso_();

    for (var i = 0; i < orderedSectionIds.length; i++) {
      var secId = String(orderedSectionIds[i] || '').trim();
      var sHit = sectionsTbl.byId[secId];
      if (!sHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Section "' + secId + '" was not found.'
        );
      }
      if (sHit.record.course_id !== courseId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Cross-course section reorder rejected: Section "' +
            secId +
            '" does not belong to course "' +
            courseId +
            '".'
        );
      }
      updateSheetRecordById_(
        'Sections',
        secId,
        {
          sort_order: (i + 1) * 10,
          updated_at_utc: nowIso
        },
        Number(sHit.record.version || 1),
        { skipLock: true }
      );
    }

    updateSheetRecordById_(
      'Courses',
      courseId,
      { updated_at_utc: nowIso },
      Number(cHit.record.version || 1),
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_SECTIONS_REORDERED',
      targetEntityType: 'Course',
      targetEntityId: courseId,
      summary: {
        orderedSectionIds: orderedSectionIds
      }
    });
  });

  var detail = adminGetCourseEditorDetailStep7_(authContext, {
    courseId: courseId
  });
  detail.savedMessage = 'Updated section order.';
  return detail;
}
/**
 * Removes or archives a section according to reference rules (`admin.removeOrArchiveSection`):
 * - Core default section types (`ASSESSMENT`, `READING`, `RECORDING`) cannot be hard-deleted;
 *   if removal is requested on a default section or a section that contains cards, it is
 *   archived (`status = 'ARCHIVED'`) instead so card references are never orphaned.
 * - An empty `CUSTOM` section with 0 cards can be hard-deleted from the `Sections` worksheet
 *   (or archived if `mode === 'ARCHIVE'`).
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload `{ courseId: string, sectionId: string, expectedVersion: number, mode?: 'ARCHIVE'|'REMOVE'|'RESTORE' }`.
 * @return {Object} Updated course editor detail bundle.
 */
function adminRemoveOrArchiveSectionStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var courseId = String(req.courseId || '').trim();
  var sectionId = String(req.sectionId || '').trim();
  var requestedMode = String(req.mode || 'REMOVE')
    .trim()
    .toUpperCase();

  if (!courseId || !sectionId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Both courseId and sectionId are required.'
    );
  }

  var outcomeDescription = '';
  withScriptLock_(function () {
    var coursesTbl = readSheetTable_('Courses');
    var cHit = coursesTbl.byId[courseId];
    if (!cHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Course "' + courseId + '" was not found.'
      );
    }

    var sectionsTbl = readSheetTable_('Sections');
    var sHit = sectionsTbl.byId[sectionId];
    if (!sHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Section "' + sectionId + '" was not found.'
      );
    }
    if (sHit.record.course_id !== courseId) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Cross-course section operation rejected: Section "' +
          sectionId +
          '" does not belong to course "' +
          courseId +
          '".'
      );
    }

    var expectedVersion = Number(req.expectedVersion);
    var actualVersion = Number(sHit.record.version || 1);
    if (expectedVersion && expectedVersion !== actualVersion) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
        'Stale section version: expected ' +
          expectedVersion +
          ', found ' +
          actualVersion +
          '. Please reload.'
      );
    }

    var cardsTbl = readSheetTable_('Cards');
    var referencedCardsCount = 0;
    for (var i = 0; i < cardsTbl.records.length; i++) {
      if (cardsTbl.records[i].section_id === sectionId) {
        referencedCardsCount++;
      }
    }

    var isDefaultSectionType =
      sHit.record.section_type === 'ASSESSMENT' ||
      sHit.record.section_type === 'READING' ||
      sHit.record.section_type === 'RECORDING';

    var nowIso = nowUtcIso_();

    if (requestedMode === 'RESTORE') {
      updateSheetRecordById_(
        'Sections',
        sectionId,
        {
          status: 'PUBLISHED',
          updated_at_utc: nowIso
        },
        actualVersion,
        { skipLock: true }
      );
      outcomeDescription =
        'Restored section "' + sHit.record.title + '" to PUBLISHED status.';
    } else if (
      requestedMode === 'ARCHIVE' ||
      isDefaultSectionType ||
      referencedCardsCount > 0
    ) {
      updateSheetRecordById_(
        'Sections',
        sectionId,
        {
          status: 'ARCHIVED',
          updated_at_utc: nowIso
        },
        actualVersion,
        { skipLock: true }
      );
      if (isDefaultSectionType) {
        outcomeDescription =
          'Archived default section "' +
          sHit.record.title +
          '" (core default sections are archived rather than hard-deleted).';
      } else if (referencedCardsCount > 0) {
        outcomeDescription =
          'Archived section "' +
          sHit.record.title +
          '" because it contains ' +
          referencedCardsCount +
          ' card(s) (reference integrity preserved).';
      } else {
        outcomeDescription = 'Archived section "' + sHit.record.title + '".';
      }
    } else {
      deleteSheetRecordById_('Sections', sectionId, actualVersion, {
        skipLock: true
      });
      outcomeDescription =
        'Removed empty custom section "' +
        sHit.record.title +
        '" (0 cards referenced).';
    }

    updateSheetRecordById_(
      'Courses',
      courseId,
      { updated_at_utc: nowIso },
      Number(cHit.record.version || 1),
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_SECTION_REMOVE_OR_ARCHIVE',
      targetEntityType: 'Section',
      targetEntityId: sectionId,
      summary: {
        courseId: courseId,
        sectionTitle: sHit.record.title,
        sectionType: sHit.record.section_type,
        referencedCardsCount: referencedCardsCount,
        outcomeDescription: outcomeDescription
      }
    });
  });

  var detail = adminGetCourseEditorDetailStep7_(authContext, {
    courseId: courseId
  });
  detail.savedMessage = outcomeDescription;
  return detail;
}
/**
 * Creates or updates a course card (`READING_CARD`, `RECORDING_CARD`, or `ASSESSMENT_LINK_CARD`)
 * inside a specific course section (`admin.saveCard`).
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload Card save payload.
 * @return {Object} Updated course editor detail bundle.
 */
function adminSaveCardStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var fieldErrors = {};

  var courseId = String(req.courseId || '').trim();
  var sectionId = String(req.sectionId || '').trim();
  var cardId = req.cardId ? String(req.cardId).trim() : '';
  var isCreate = !cardId;

  if (!courseId) {
    fieldErrors.courseId = 'Parent courseId is required.';
  }
  if (!sectionId) {
    fieldErrors.sectionId = 'Parent sectionId is required.';
  }

  var cardType = String(req.cardType || 'READING_CARD')
    .trim()
    .toUpperCase();
  if (
    cardType !== 'READING_CARD' &&
    cardType !== 'RECORDING_CARD' &&
    cardType !== 'ASSESSMENT_LINK_CARD'
  ) {
    fieldErrors.cardType =
      'Card type must be READING_CARD, RECORDING_CARD, or ASSESSMENT_LINK_CARD.';
  }

  var title = sanitizeSingleLineTextStep7_(req.title, 160);
  if (!title || title.length < 2) {
    fieldErrors.title = 'Card title is required (2 to 160 characters).';
  }
  var subtitle = sanitizeSingleLineTextStep7_(req.subtitle, 240);
  var imageCaption = sanitizeSingleLineTextStep7_(req.imageCaption, 240);
  var imageFileId = validateOptionalDriveFileRefStep7_(
    req.imageFileId,
    'imageFileId',
    'Card image Drive file ID',
    fieldErrors,
    ['CARD_IMAGE', 'RICHTEXT_IMAGE', 'COURSE_IMAGE']
  );

  var recordingUrl = validateHttpsResourceUrlStep7_(
    req.recordingUrl,
    'recordingUrl',
    'Recording or resource URL',
    false,
    fieldErrors
  );

  var recordingUploadedAtUtc = '';
  if (
    req.recordingUploadedAtUtc !== undefined &&
    String(req.recordingUploadedAtUtc).trim() !== ''
  ) {
    var rawUploadDate = String(req.recordingUploadedAtUtc).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawUploadDate)) {
      recordingUploadedAtUtc = rawUploadDate + 'T00:00:00.000Z';
    } else {
      var parsedMs = Date.parse(rawUploadDate);
      if (isNaN(parsedMs)) {
        fieldErrors.recordingUploadedAtUtc =
          'Upload date must be a valid YYYY-MM-DD date or ISO-8601 UTC timestamp.';
      } else {
        recordingUploadedAtUtc = new Date(parsedMs).toISOString();
      }
    }
  } else if (cardType === 'RECORDING_CARD' && isCreate) {
    recordingUploadedAtUtc = nowUtcIso_();
  }

  var assessmentId = req.assessmentId ? String(req.assessmentId).trim() : '';
  if (cardType === 'ASSESSMENT_LINK_CARD' && !assessmentId) {
    fieldErrors.assessmentId =
      'Please select an assessment from the Assessment Library for an Assessment Link Card.';
  }

  var status = String(req.status || 'PUBLISHED')
    .trim()
    .toUpperCase();
  if (status !== 'DRAFT' && status !== 'PUBLISHED' && status !== 'ARCHIVED') {
    fieldErrors.status = 'Card status must be DRAFT, PUBLISHED, or ARCHIVED.';
  }

  var sortOrder =
    req.sortOrder !== undefined && req.sortOrder !== ''
      ? Math.floor(Number(req.sortOrder))
      : 10;
  if (isNaN(sortOrder) || sortOrder < 0 || sortOrder > 99999) {
    fieldErrors.sortOrder = 'Card sort order must be between 0 and 99999.';
  }

  var contentValidated = null;
  try {
    contentValidated = validateAndNormalizeRichTextInput_(
      req.contentRichText,
      'contentRichText',
      'Card rich-text content',
      cardType === 'READING_CARD'
    );
  } catch (rtErr) {
    if (rtErr && rtErr.fieldErrors) {
      Object.assign(fieldErrors, rtErr.fieldErrors);
    } else {
      fieldErrors.contentRichText = String(rtErr.message || rtErr);
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please fix the highlighted card fields before saving.',
      fieldErrors
    );
  }

  withScriptLock_(function () {
    var coursesTbl = readSheetTable_('Courses');
    var cHit = coursesTbl.byId[courseId];
    if (!cHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Parent course "' + courseId + '" was not found.'
      );
    }

    var sectionsTbl = readSheetTable_('Sections');
    var sHit = sectionsTbl.byId[sectionId];
    if (!sHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Target section "' + sectionId + '" was not found.'
      );
    }

    if (sHit.record.course_id !== courseId) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Parent-child mismatch: Section "' +
          sectionId +
          '" belongs to course "' +
          sHit.record.course_id +
          '", not course "' +
          courseId +
          '".',
        {
          sectionId: 'Target section does not belong to the specified course.'
        }
      );
    }

    if (assessmentId) {
      var assessmentsTbl = readSheetTable_('Assessments');
      var aHit = assessmentsTbl.byId[assessmentId];
      if (!aHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Selected assessment "' +
            assessmentId +
            '" does not exist in the Assessment Library.',
          { assessmentId: 'Selected assessment was not found in the library.' }
        );
      }
      if (aHit.record.status === 'ARCHIVED' && isCreate) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Archived assessments cannot be newly linked to a course section. Restore the assessment in the Assessment Library first, or select an active assessment.',
          {
            assessmentId:
              'This assessment is archived. Restore it first or choose an ACTIVE assessment.'
          }
        );
      }
    }

    var cardsTbl = readSheetTable_('Cards');
    var nowIso = nowUtcIso_();

    if (isCreate) {
      var maxOrder = 0;
      for (var i = 0; i < cardsTbl.records.length; i++) {
        if (cardsTbl.records[i].section_id === sectionId) {
          var ord = Number(cardsTbl.records[i].sort_order) || 0;
          if (ord > maxOrder) {
            maxOrder = ord;
          }
        }
      }
      var finalSortOrder =
        req.sortOrder !== undefined && req.sortOrder !== ''
          ? sortOrder
          : maxOrder + 10;

      var newCardId = generateEntityId_('crd_');
      insertSheetRecord_(
        'Cards',
        {
          card_id: newCardId,
          course_id: courseId,
          section_id: sectionId,
          card_type: cardType,
          title: title,
          subtitle: subtitle,
          image_file_id: imageFileId,
          image_caption: imageCaption,
          content_richtext_json: contentValidated.json,
          recording_url: recordingUrl,
          recording_uploaded_at_utc: recordingUploadedAtUtc,
          assessment_id: assessmentId,
          status: status,
          sort_order: finalSortOrder,
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_CARD_CREATED',
        targetEntityType: 'Card',
        targetEntityId: newCardId,
        summary: {
          courseId: courseId,
          sectionId: sectionId,
          cardType: cardType,
          title: title,
          status: status
        }
      });
    } else {
      var cardHit = cardsTbl.byId[cardId];
      if (!cardHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Card ID "' + cardId + '" was not found.'
        );
      }

      if (cardHit.record.course_id !== courseId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Cross-course card reassignment rejected: Card "' +
            cardId +
            '" belongs to course "' +
            cardHit.record.course_id +
            '" and cannot be moved or reassigned to course "' +
            courseId +
            '".',
          {
            courseId: 'Cards cannot be reassigned to a different course.'
          }
        );
      }

      var expectedVersion = Number(req.expectedVersion);
      var actualVersion = Number(cardHit.record.version || 1);
      if (!expectedVersion || expectedVersion !== actualVersion) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Stale card edit detected: expected version ' +
            expectedVersion +
            ', but server version is ' +
            actualVersion +
            '. Please reload the course editor.',
          {
            version:
              'Another administrator updated this card (server version ' +
              actualVersion +
              '). Reload to view the latest changes.'
          }
        );
      }

      updateSheetRecordById_(
        'Cards',
        cardId,
        {
          section_id: sectionId,
          card_type: cardType,
          title: title,
          subtitle: subtitle,
          image_file_id: imageFileId,
          image_caption: imageCaption,
          content_richtext_json: contentValidated.json,
          recording_url: recordingUrl,
          recording_uploaded_at_utc:
            recordingUploadedAtUtc ||
            cardHit.record.recording_uploaded_at_utc ||
            '',
          assessment_id: assessmentId,
          status: status,
          sort_order: sortOrder,
          updated_at_utc: nowIso
        },
        expectedVersion,
        { skipLock: true }
      );

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_CARD_UPDATED',
        targetEntityType: 'Card',
        targetEntityId: cardId,
        summary: {
          courseId: courseId,
          sectionId: sectionId,
          cardType: cardType,
          title: title,
          status: status,
          newVersion: expectedVersion + 1
        }
      });
    }

    updateSheetRecordById_(
      'Sections',
      sectionId,
      { updated_at_utc: nowIso },
      Number(sHit.record.version || 1),
      { skipLock: true }
    );

    var coursePatch = { updated_at_utc: nowIso };
    if (
      sHit.record.section_type === 'ASSESSMENT' ||
      cardType === 'ASSESSMENT_LINK_CARD'
    ) {
      coursePatch.assessment_updated_at_utc = nowIso;
    }
    if (sHit.record.section_type === 'READING' || cardType === 'READING_CARD') {
      coursePatch.reading_updated_at_utc = nowIso;
    }
    updateSheetRecordById_(
      'Courses',
      courseId,
      coursePatch,
      Number(cHit.record.version || 1),
      { skipLock: true }
    );
  });

  var detail = adminGetCourseEditorDetailStep7_(authContext, {
    courseId: courseId
  });
  detail.savedMessage = isCreate
    ? 'Created card "' + title + '".'
    : 'Saved changes to card "' + title + '".';
  return detail;
}
/**
 * Reorders cards within a section (`admin.reorderCards`), verifying every card belongs
 * to `(payload.courseId, payload.sectionId)`.
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload `{ courseId: string, sectionId: string, orderedCardIds: Array<string> }`.
 * @return {Object} Updated course editor detail bundle.
 */
function adminReorderCardsStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var courseId = String(req.courseId || '').trim();
  var sectionId = String(req.sectionId || '').trim();
  var orderedCardIds = Array.isArray(req.orderedCardIds)
    ? req.orderedCardIds
    : [];

  if (!courseId || !sectionId || orderedCardIds.length === 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'courseId, sectionId, and a non-empty orderedCardIds array are required.'
    );
  }

  withScriptLock_(function () {
    var coursesTbl = readSheetTable_('Courses');
    var cHit = coursesTbl.byId[courseId];
    if (!cHit) {
      throw createAppError_(PB_ERROR_CODES_.ERR_NOT_FOUND, 'Course not found.');
    }

    var sectionsTbl = readSheetTable_('Sections');
    var sHit = sectionsTbl.byId[sectionId];
    if (!sHit || sHit.record.course_id !== courseId) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Section does not belong to the specified course.'
      );
    }

    var cardsTbl = readSheetTable_('Cards');
    var nowIso = nowUtcIso_();

    for (var i = 0; i < orderedCardIds.length; i++) {
      var cId = String(orderedCardIds[i] || '').trim();
      var cardHit = cardsTbl.byId[cId];
      if (!cardHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Card "' + cId + '" was not found.'
        );
      }
      if (
        cardHit.record.course_id !== courseId ||
        cardHit.record.section_id !== sectionId
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Cross-course or cross-section card reorder rejected for card "' +
            cId +
            '".'
        );
      }
      updateSheetRecordById_(
        'Cards',
        cId,
        {
          sort_order: (i + 1) * 10,
          updated_at_utc: nowIso
        },
        Number(cardHit.record.version || 1),
        { skipLock: true }
      );
    }

    updateSheetRecordById_(
      'Sections',
      sectionId,
      { updated_at_utc: nowIso },
      Number(sHit.record.version || 1),
      { skipLock: true }
    );
    updateSheetRecordById_(
      'Courses',
      courseId,
      { updated_at_utc: nowIso },
      Number(cHit.record.version || 1),
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_CARDS_REORDERED',
      targetEntityType: 'Section',
      targetEntityId: sectionId,
      summary: {
        courseId: courseId,
        sectionId: sectionId,
        orderedCardIds: orderedCardIds
      }
    });
  });

  var detail = adminGetCourseEditorDetailStep7_(authContext, {
    courseId: courseId
  });
  detail.savedMessage = 'Updated card order.';
  return detail;
}
/**
 * Removes or archives a card within a section (`admin.removeOrArchiveCard`).
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload `{ courseId: string, cardId: string, expectedVersion?: number, mode?: 'ARCHIVE'|'DELETE'|'RESTORE' }`.
 * @return {Object} Updated course editor detail bundle.
 */
function adminRemoveOrArchiveCardStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var courseId = String(req.courseId || '').trim();
  var cardId = String(req.cardId || '').trim();
  var mode = String(req.mode || 'ARCHIVE')
    .trim()
    .toUpperCase();

  if (!courseId || !cardId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'courseId and cardId are required.'
    );
  }

  var msg = '';
  withScriptLock_(function () {
    var coursesTbl = readSheetTable_('Courses');
    var cHit = coursesTbl.byId[courseId];
    if (!cHit) {
      throw createAppError_(PB_ERROR_CODES_.ERR_NOT_FOUND, 'Course not found.');
    }

    var cardsTbl = readSheetTable_('Cards');
    var cardHit = cardsTbl.byId[cardId];
    if (!cardHit) {
      throw createAppError_(PB_ERROR_CODES_.ERR_NOT_FOUND, 'Card not found.');
    }
    if (cardHit.record.course_id !== courseId) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Cross-course card operation rejected: Card "' +
          cardId +
          '" does not belong to course "' +
          courseId +
          '".'
      );
    }

    var expectedVersion = Number(req.expectedVersion);
    var actualVersion = Number(cardHit.record.version || 1);
    if (expectedVersion && expectedVersion !== actualVersion) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
        'Stale card version: expected ' +
          expectedVersion +
          ', found ' +
          actualVersion +
          '.'
      );
    }

    var nowIso = nowUtcIso_();
    var sectionId = cardHit.record.section_id;

    if (mode === 'DELETE') {
      deleteSheetRecordById_('Cards', cardId, actualVersion, {
        skipLock: true
      });
      msg = 'Removed card "' + cardHit.record.title + '".';
    } else if (mode === 'RESTORE') {
      updateSheetRecordById_(
        'Cards',
        cardId,
        {
          status: 'PUBLISHED',
          updated_at_utc: nowIso
        },
        actualVersion,
        { skipLock: true }
      );
      msg = 'Restored card "' + cardHit.record.title + '" to PUBLISHED.';
    } else {
      updateSheetRecordById_(
        'Cards',
        cardId,
        {
          status: 'ARCHIVED',
          updated_at_utc: nowIso
        },
        actualVersion,
        { skipLock: true }
      );
      msg = 'Archived card "' + cardHit.record.title + '".';
    }

    var sectionsTbl = readSheetTable_('Sections');
    var sHit = sectionsTbl.byId[sectionId];
    if (sHit) {
      updateSheetRecordById_(
        'Sections',
        sectionId,
        { updated_at_utc: nowIso },
        Number(sHit.record.version || 1),
        { skipLock: true }
      );
    }
    updateSheetRecordById_(
      'Courses',
      courseId,
      { updated_at_utc: nowIso },
      Number(cHit.record.version || 1),
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_CARD_REMOVE_OR_ARCHIVE',
      targetEntityType: 'Card',
      targetEntityId: cardId,
      summary: {
        courseId: courseId,
        sectionId: sectionId,
        cardTitle: cardHit.record.title,
        mode: mode
      }
    });
  });

  var detail = adminGetCourseEditorDetailStep7_(authContext, {
    courseId: courseId
  });
  detail.savedMessage = msg;
  return detail;
}
/**
 * Lists all assessments in the Assessment Library (`admin.listAssessments`),
 * including reference counts across courses.
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload Optional filter payload.
 * @return {Object} Assessment library list.
 */
function adminListAssessmentsStep7_(authContext, payload) {
  var listResult = adminListCoursesStep7_(authContext, payload);
  return {
    assessments: listResult.assessments,
    courses: listResult.courses,
    gradingPolicyNotice: listResult.gradingPolicyNotice
  };
}
/**
 * Creates, edits, archives, or restores an assessment in the `Assessments` worksheet
 * (`admin.saveAssessment`).
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload Assessment save payload.
 * @return {Object} Updated assessment record and full assessment library list.
 */
function adminSaveAssessmentStep7_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload || {};
  var fieldErrors = {};

  var assessmentId = req.assessmentId ? String(req.assessmentId).trim() : '';
  var isCreate = !assessmentId;

  var title = sanitizeSingleLineTextStep7_(req.title, 160);
  if (!title || title.length < 3) {
    fieldErrors.title = 'Assessment title is required (3 to 160 characters).';
  }

  var externalUrl = validateHttpsResourceUrlStep7_(
    req.externalUrl,
    'externalUrl',
    'External assessment URL',
    false,
    fieldErrors
  );

  var pdfFileId = validateOptionalDriveFileRefStep7_(
    req.pdfFileId,
    'pdfFileId',
    'Assessment PDF Drive file ID',
    fieldErrors,
    ['PDF_ATTACHMENT', 'COURSE_PDF']
  );

  var status = String(req.status || 'ACTIVE')
    .trim()
    .toUpperCase();
  if (status !== 'ACTIVE' && status !== 'ARCHIVED') {
    fieldErrors.status = 'Assessment status must be ACTIVE or ARCHIVED.';
  }

  var descValidated = null;
  try {
    descValidated = validateAndNormalizeRichTextInput_(
      req.descriptionRichText,
      'descriptionRichText',
      'Assessment description',
      false
    );
  } catch (descErr) {
    if (descErr && descErr.fieldErrors) {
      Object.assign(fieldErrors, descErr.fieldErrors);
    } else {
      fieldErrors.descriptionRichText = String(descErr.message || descErr);
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please fix the highlighted assessment fields.',
      fieldErrors
    );
  }

  var savedAssessmentId = '';
  var referencedByCourseCount = 0;

  withScriptLock_(function () {
    var assessmentsTbl = readSheetTable_('Assessments');
    var cardsTbl = readSheetTable_('Cards');
    var nowIso = nowUtcIso_();

    if (isCreate) {
      savedAssessmentId = generateEntityId_('asm_');
      insertSheetRecord_(
        'Assessments',
        {
          assessment_id: savedAssessmentId,
          title: title,
          description_richtext_json: descValidated.json,
          external_url: externalUrl,
          pdf_file_id: pdfFileId,
          status: status,
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_ASSESSMENT_CREATED',
        targetEntityType: 'Assessment',
        targetEntityId: savedAssessmentId,
        summary: {
          title: title,
          externalUrl: externalUrl,
          status: status
        }
      });
    } else {
      var aHit = assessmentsTbl.byId[assessmentId];
      if (!aHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Assessment ID "' + assessmentId + '" was not found.'
        );
      }

      var expectedVersion = Number(req.expectedVersion);
      var actualVersion = Number(aHit.record.version || 1);
      if (!expectedVersion || expectedVersion !== actualVersion) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Stale assessment edit detected: expected version ' +
            expectedVersion +
            ', but server version is ' +
            actualVersion +
            '. Please reload the Assessment Library.',
          {
            version:
              'Another administrator updated this assessment (server version ' +
              actualVersion +
              ').'
          }
        );
      }

      for (var c = 0; c < cardsTbl.records.length; c++) {
        if (cardsTbl.records[c].assessment_id === assessmentId) {
          referencedByCourseCount++;
        }
      }

      updateSheetRecordById_(
        'Assessments',
        assessmentId,
        {
          title: title,
          description_richtext_json: descValidated.json,
          external_url: externalUrl,
          pdf_file_id: pdfFileId,
          status: status,
          updated_at_utc: nowIso
        },
        expectedVersion,
        { skipLock: true }
      );
      savedAssessmentId = assessmentId;

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_ASSESSMENT_UPDATED',
        targetEntityType: 'Assessment',
        targetEntityId: savedAssessmentId,
        summary: {
          title: title,
          status: status,
          referencedByCourseCount: referencedByCourseCount,
          newVersion: expectedVersion + 1
        }
      });
    }
  });

  var librarySnapshot = adminListCoursesStep7_(authContext, {});
  var savedDto = null;
  for (var i = 0; i < librarySnapshot.assessments.length; i++) {
    if (librarySnapshot.assessments[i].assessmentId === savedAssessmentId) {
      savedDto = librarySnapshot.assessments[i];
      break;
    }
  }

  var archiveNotice = '';
  if (status === 'ARCHIVED' && referencedByCourseCount > 0) {
    archiveNotice =
      ' Note: This assessment is still referenced by ' +
      referencedByCourseCount +
      ' course card(s); those courses preserve the reference and display an "Archived in Library" indicator.';
  }

  return {
    savedAssessment: savedDto,
    assessments: librarySnapshot.assessments,
    courses: librarySnapshot.courses,
    savedMessage:
      (isCreate
        ? 'Created assessment "' + title + '".'
        : 'Saved assessment "' + title + '" (' + status + ').') + archiveNotice
  };
}
/**
 * Seeds or verifies one complete English sample course and one sample assessment
 * through the real Step 7 backend (`admin.seedStep7SampleCourseAndAssessment`),
 * and ensures active sample students are enrolled.
 *
 * @param {Object} authContext Verified session context.
 * @param {Object} payload Optional payload.
 * @return {Object} Seeded sample course detail and assessment library snapshot.
 */
function adminSeedStep7SampleCourseAndAssessment_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var targetCourseId = '';
  var targetAssessmentId = '';

  withScriptLock_(function () {
    var nowIso = nowUtcIso_();
    var assessmentsTbl = readSheetTable_('Assessments');
    var sampleAssessmentTitle =
      'Unit 1 Formative Checkpoint: ATP Synthesis & Enzyme Inhibition';

    for (var a = 0; a < assessmentsTbl.records.length; a++) {
      if (assessmentsTbl.records[a].title === sampleAssessmentTitle) {
        targetAssessmentId = assessmentsTbl.records[a].assessment_id;
        break;
      }
    }

    var assessmentDescDoc = {
      schemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
      blocks: [
        {
          type: 'paragraph',
          spans: [
            { text: 'Complete the ', size: 'base' },
            {
              text: '20-question formative checkpoint',
              bold: true,
              size: 'base'
            },
            {
              text: ' covering substrate-level phosphorylation, chemiosmotic coupling across the inner mitochondrial membrane, and competitive vs. allosteric enzyme inhibition.',
              size: 'base'
            }
          ]
        },
        {
          type: 'bullet_list',
          items: [
            {
              type: 'list_item',
              spans: [
                { text: 'Time allocation: ', bold: true },
                { text: '35 minutes (open diagram reference permitted).' }
              ]
            },
            {
              type: 'list_item',
              spans: [
                { text: 'Submission notice: ', bold: true },
                {
                  text: 'This portal links to the external assessment worksheet; scores are reviewed directly with your biology tutor in class (no automated grading engine).'
                }
              ]
            }
          ]
        }
      ]
    };

    if (!targetAssessmentId) {
      targetAssessmentId = generateEntityId_('asm_');
      insertSheetRecord_(
        'Assessments',
        {
          assessment_id: targetAssessmentId,
          title: sampleAssessmentTitle,
          description_richtext_json: JSON.stringify(assessmentDescDoc),
          external_url:
            'https://docs.google.com/forms/d/e/1FAIpQLScPattanabhumiBioUnit1Sample/viewform',
          pdf_file_id: '',
          status: 'ACTIVE',
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
    } else {
      var aHit = assessmentsTbl.byId[targetAssessmentId];
      updateSheetRecordById_(
        'Assessments',
        targetAssessmentId,
        {
          description_richtext_json: JSON.stringify(assessmentDescDoc),
          external_url:
            'https://docs.google.com/forms/d/e/1FAIpQLScPattanabhumiBioUnit1Sample/viewform',
          status: 'ACTIVE',
          updated_at_utc: nowIso
        },
        Number(aHit.record.version || 1),
        { skipLock: true }
      );
    }

    var coursesTbl = readSheetTable_('Courses');
    var sampleCourseCode = 'BIO-101-CELL';
    for (var c = 0; c < coursesTbl.records.length; c++) {
      if (
        String(coursesTbl.records[c].course_code || '').toUpperCase() ===
        sampleCourseCode
      ) {
        targetCourseId = coursesTbl.records[c].course_id;
        break;
      }
    }

    var objectivesDoc = {
      schemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
      blocks: [
        {
          type: 'paragraph',
          spans: [
            {
              text: 'Course Objectives - Cellular Energetics & Membrane Physiology',
              bold: true,
              underline: true,
              size: 'lg'
            }
          ]
        },
        {
          type: 'ordered_list',
          items: [
            {
              type: 'list_item',
              spans: [
                { text: 'Analyze how ', size: 'base' },
                { text: 'biological membranes', bold: true },
                {
                  text: ' maintain selective permeability through amphipathic phospholipid bilayers and transport proteins.'
                }
              ]
            },
            {
              type: 'list_item',
              spans: [
                { text: 'Quantify ', size: 'base' },
                { text: 'enzyme-catalyzed reaction rates', italic: true },
                {
                  text: ' and distinguish competitive, non-competitive, and feedback inhibition mechanisms.'
                }
              ]
            },
            {
              type: 'list_item',
              spans: [
                {
                  text: 'Trace electron flow from glycolysis and the citric acid cycle through oxidative phosphorylation.'
                }
              ]
            }
          ]
        }
      ]
    };

    var outcomesDoc = {
      schemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
      blocks: [
        {
          type: 'paragraph',
          spans: [
            {
              text: 'Expected Student Learning Outcomes',
              bold: true,
              size: 'lg'
            }
          ]
        },
        {
          type: 'bullet_list',
          items: [
            {
              type: 'list_item',
              spans: [
                { text: 'Interpret ', size: 'base' },
                {
                  text: 'Michaelis-Menten and Lineweaver-Burk plots',
                  bold: true
                },
                { text: ' under varying inhibitor concentrations.' }
              ]
            },
            {
              type: 'list_item',
              spans: [
                {
                  text: 'Predict net water movement across plant and animal cells in '
                },
                { text: 'hypertonic, isotonic, and hypotonic', italic: true },
                { text: ' extracellular environments.' }
              ]
            }
          ]
        }
      ]
    };

    if (!targetCourseId) {
      targetCourseId = generateEntityId_('crs_');
      insertSheetRecord_(
        'Courses',
        {
          course_id: targetCourseId,
          course_code: sampleCourseCode,
          title: 'Cellular Energetics, Enzyme Kinetics & Membrane Transport',
          subtitle:
            'Upper-Secondary Intensive Biology Module (Fluid Mosaic Model, Catalysis & ATP Synthesis)',
          cover_file_id: '',
          status: 'PUBLISHED',
          sort_order: 10,
          objectives_richtext_json: JSON.stringify(objectivesDoc),
          outcomes_richtext_json: JSON.stringify(outcomesDoc),
          assessment_updated_at_utc: nowIso,
          reading_updated_at_utc: nowIso,
          calendar_tag: '[BIO-101-CELL]',
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
    } else {
      var existingCourseHit = coursesTbl.byId[targetCourseId];
      updateSheetRecordById_(
        'Courses',
        targetCourseId,
        {
          title: 'Cellular Energetics, Enzyme Kinetics & Membrane Transport',
          subtitle:
            'Upper-Secondary Intensive Biology Module (Fluid Mosaic Model, Catalysis & ATP Synthesis)',
          status: 'PUBLISHED',
          objectives_richtext_json: JSON.stringify(objectivesDoc),
          outcomes_richtext_json: JSON.stringify(outcomesDoc),
          assessment_updated_at_utc: nowIso,
          reading_updated_at_utc: nowIso,
          calendar_tag: '[BIO-101-CELL]',
          updated_at_utc: nowIso
        },
        Number(existingCourseHit.record.version || 1),
        { skipLock: true }
      );
    }

    var sections = ensureCourseDefaultSectionsInLock_(targetCourseId, nowIso);
    var sectionByType = {};
    for (var s = 0; s < sections.length; s++) {
      sectionByType[sections[s].section_type] = sections[s];
    }

    var cardsTbl = readSheetTable_('Cards');
    var existingCourseCards = [];
    for (var k = 0; k < cardsTbl.records.length; k++) {
      if (cardsTbl.records[k].course_id === targetCourseId) {
        existingCourseCards.push(cardsTbl.records[k]);
      }
    }

    if (existingCourseCards.length === 0) {
      if (sectionByType.ASSESSMENT) {
        insertSheetRecord_(
          'Cards',
          {
            card_id: generateEntityId_('crd_'),
            course_id: targetCourseId,
            section_id: sectionByType.ASSESSMENT.section_id,
            card_type: 'ASSESSMENT_LINK_CARD',
            title: sampleAssessmentTitle,
            subtitle:
              'Required after completing Reading Module 1.1 and Lecture Recording 1',
            image_file_id: '',
            image_caption: '',
            content_richtext_json: JSON.stringify({
              schemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
              blocks: [
                {
                  type: 'paragraph',
                  spans: [
                    { text: 'Instructions: ', bold: true },
                    {
                      text: 'Review the Course Objectives and Learning Outcomes above, then open the linked checkpoint form. Bring your worked enzyme kinetics graph to the next tutorial session.'
                    }
                  ]
                }
              ]
            }),
            recording_url: '',
            recording_uploaded_at_utc: '',
            assessment_id: targetAssessmentId,
            status: 'PUBLISHED',
            sort_order: 10,
            created_at_utc: nowIso,
            updated_at_utc: nowIso
          },
          { skipLock: true }
        );
      }

      if (sectionByType.READING) {
        insertSheetRecord_(
          'Cards',
          {
            card_id: generateEntityId_('crd_'),
            course_id: targetCourseId,
            section_id: sectionByType.READING.section_id,
            card_type: 'READING_CARD',
            title:
              'Module 1.1: Active vs. Passive Transport & Electrochemical Gradients',
            subtitle: 'Essential pre-class reading note (approx. 15 minutes)',
            image_file_id: '',
            image_caption:
              'Figure 1.1: Sodium-potassium pump (Na+/K+-ATPase) cycle across the plasma membrane.',
            content_richtext_json: JSON.stringify({
              schemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
              blocks: [
                {
                  type: 'paragraph',
                  spans: [
                    {
                      text: '1. Selective Permeability of Phospholipid Bilayers',
                      bold: true,
                      size: 'lg'
                    }
                  ]
                },
                {
                  type: 'paragraph',
                  spans: [
                    { text: 'Small nonpolar molecules such as ' },
                    { text: 'O2 and CO2', bold: true },
                    {
                      text: ' diffuse rapidly across the hydrophobic core, whereas ions and polar solutes require '
                    },
                    {
                      text: 'transmembrane channel or carrier proteins',
                      underline: true
                    },
                    {
                      text: '. For additional molecular models, consult the '
                    },
                    {
                      text: 'NCBI Bookshelf Molecular Biology Reference',
                      bold: true,
                      link: 'https://www.ncbi.nlm.nih.gov/books/'
                    },
                    { text: '.' }
                  ]
                },
                {
                  type: 'bullet_list',
                  items: [
                    {
                      type: 'list_item',
                      spans: [
                        { text: 'Simple Diffusion: ', bold: true },
                        {
                          text: 'Down the concentration gradient; requires no metabolic ATP input.'
                        }
                      ]
                    },
                    {
                      type: 'list_item',
                      spans: [
                        { text: 'Facilitated Diffusion: ', bold: true },
                        {
                          text: 'Mediated by aquaporins, ion channels, or carrier proteins down an electrochemical gradient.'
                        }
                      ]
                    },
                    {
                      type: 'list_item',
                      spans: [
                        { text: 'Primary Active Transport: ', bold: true },
                        {
                          text: 'Directly hydrolyzes ATP (for example, the Na+/K+-ATPase pump extruding 3 Na+ ions for every 2 K+ ions imported).'
                        }
                      ]
                    }
                  ]
                }
              ]
            }),
            recording_url: '',
            recording_uploaded_at_utc: '',
            assessment_id: '',
            status: 'PUBLISHED',
            sort_order: 10,
            created_at_utc: nowIso,
            updated_at_utc: nowIso
          },
          { skipLock: true }
        );
      }

      if (sectionByType.RECORDING) {
        insertSheetRecord_(
          'Cards',
          {
            card_id: generateEntityId_('crd_'),
            course_id: targetCourseId,
            section_id: sectionByType.RECORDING.section_id,
            card_type: 'RECORDING_CARD',
            title:
              'Lecture 01 Recording: Enzyme Active Sites, Induced Fit & Allosteric Regulation',
            subtitle:
              'Recorded Saturday Live Session (65 mins) - Instructor: Ajarn Pattanabhumi',
            image_file_id: '',
            image_caption:
              'Thumbnail: Free energy (Delta G) profile of uncatalyzed vs. enzyme-catalyzed reactions.',
            content_richtext_json: JSON.stringify({
              schemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
              blocks: [
                {
                  type: 'paragraph',
                  spans: [
                    { text: 'Session Coverage:', bold: true, size: 'base' }
                  ]
                },
                {
                  type: 'ordered_list',
                  items: [
                    {
                      type: 'list_item',
                      spans: [
                        { text: '00:00 - 18:30: ', bold: true },
                        {
                          text: 'Transition-state stabilization and lowering activation energy (Ea).'
                        }
                      ]
                    },
                    {
                      type: 'list_item',
                      spans: [
                        { text: '18:30 - 42:00: ', bold: true },
                        {
                          text: 'Deriving Vmax and Km from experimental initial-velocity data.'
                        }
                      ]
                    },
                    {
                      type: 'list_item',
                      spans: [
                        { text: '42:00 - 65:00: ', bold: true },
                        {
                          text: 'Worked Olympiad & A-Level past-paper problems on feedback inhibition.'
                        }
                      ]
                    }
                  ]
                }
              ]
            }),
            recording_url:
              'https://drive.google.com/file/d/12EKzWLkKL9XEdZVrJBzGNERdAd7BFi--/view',
            recording_uploaded_at_utc: nowIso,
            assessment_id: '',
            status: 'PUBLISHED',
            sort_order: 10,
            created_at_utc: nowIso,
            updated_at_utc: nowIso
          },
          { skipLock: true }
        );
      }
    }

    var usersTbl = readSheetTable_('Users');
    var enrollmentsTbl = readSheetTable_('Enrollments');
    for (var u = 0; u < usersTbl.records.length; u++) {
      var usr = usersTbl.records[u];
      if (usr.role === 'STUDENT' && usr.status === 'ACTIVE') {
        var hasEnr = false;
        for (var e = 0; e < enrollmentsTbl.records.length; e++) {
          var enr = enrollmentsTbl.records[e];
          if (enr.user_id === usr.user_id && enr.course_id === targetCourseId) {
            hasEnr = true;
            if (enr.status !== 'ACTIVE') {
              updateSheetRecordById_(
                'Enrollments',
                enr.enrollment_id,
                {
                  status: 'ACTIVE',
                  assigned_by_user_id: adminUser.user_id,
                  updated_at_utc: nowIso
                },
                Number(enr.version || 1),
                { skipLock: true }
              );
            }
            break;
          }
        }
        if (!hasEnr) {
          insertSheetRecord_(
            'Enrollments',
            {
              enrollment_id: generateEntityId_('enr_'),
              user_id: usr.user_id,
              course_id: targetCourseId,
              status: 'ACTIVE',
              assigned_at_utc: nowIso,
              assigned_by_user_id: adminUser.user_id,
              updated_at_utc: nowIso
            },
            { skipLock: true }
          );
        }
      }
    }

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_STEP7_SAMPLE_COURSE_SEEDED',
      targetEntityType: 'Course',
      targetEntityId: targetCourseId,
      summary: {
        courseCode: sampleCourseCode,
        assessmentId: targetAssessmentId
      }
    });
  });

  var detail = adminGetCourseEditorDetailStep7_(authContext, {
    courseId: targetCourseId
  });
  detail.savedMessage =
    'Seeded & verified English sample course "Cellular Energetics, Enzyme Kinetics & Membrane Transport" (BIO-101-CELL) with its 3 default sections, rich-text cards, sample assessment, and active student enrollments.';
  return detail;
}
/**
 * Student endpoint (`student.getCourseDetail`) to load a single enrolled course's
 * full content (Course assessment objectives/outcomes/linked assessments, Reading material
 * cards, Class recordings cards, and any custom published sections).
 *
 * @param {Object} payload `{ courseId: string }`.
 * @param {Object} context RPC dispatch context containing `authContext`.
 * @return {Object} Student-safe course content bundle.
 */
function handleStudentGetCourseDetailStep7_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to view course materials.'
    );
  }

  var usr = authContext.user;
  var req = payload || {};
  var courseId = String(req.courseId || '').trim();
  if (!courseId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'courseId is required to open a course.',
      { courseId: 'Missing courseId.' }
    );
  }

  var coursesTbl = readSheetTable_('Courses');
  var cHit = coursesTbl.byId[courseId];
  if (!cHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Requested course was not found.'
    );
  }
  var courseRow = cHit.record;

  var isAdminPreview = usr.role === 'ADMIN';
  var matchingEnrollment = null;

  if (!isAdminPreview) {
    var enrollmentsTbl = readSheetTable_('Enrollments');
    for (var e = 0; e < enrollmentsTbl.records.length; e++) {
      var enr = enrollmentsTbl.records[e];
      if (
        enr.user_id === usr.user_id &&
        enr.course_id === courseId &&
        enr.status === 'ACTIVE'
      ) {
        matchingEnrollment = enr;
        break;
      }
    }

    if (!matchingEnrollment) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: You do not have an active enrollment for this course. If your enrollment was recently updated or removed by an administrator, return to My Profile to refresh your assigned courses.'
      );
    }

    if (courseRow.status !== 'PUBLISHED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'This course is currently in ' +
          courseRow.status +
          ' status and is not open for student viewing.'
      );
    }
  }

  var sectionsTbl = readSheetTable_('Sections');
  var cardsTbl = readSheetTable_('Cards');
  var assessmentsTbl = readSheetTable_('Assessments');

  var courseSections = [];
  for (var s = 0; s < sectionsTbl.records.length; s++) {
    var sec = sectionsTbl.records[s];
    if (sec.course_id === courseId && sec.status === 'PUBLISHED') {
      courseSections.push(sec);
    }
  }
  courseSections.sort(function (a, b) {
    var diff = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    if (diff !== 0) {
      return diff;
    }
    return String(a.section_id || '').localeCompare(String(b.section_id || ''));
  });

  var publishedCardsBySection = {};
  for (var c = 0; c < cardsTbl.records.length; c++) {
    var crd = cardsTbl.records[c];
    if (crd.course_id === courseId && crd.status === 'PUBLISHED') {
      if (!publishedCardsBySection[crd.section_id]) {
        publishedCardsBySection[crd.section_id] = [];
      }
      publishedCardsBySection[crd.section_id].push(crd);
    }
  }

  var filesTbl = readSheetTable_('Files');
  var courseScoreBundle =
    typeof listStudentPublishedScoresPhase4_ === 'function'
      ? listStudentPublishedScoresPhase4_(usr.user_id, courseId, isAdminPreview)
      : { publishedScores: [], totalPublishedCount: 0, scoreByAssessmentId: {} };

  var sectionDtos = [];
  for (var sIdx = 0; sIdx < courseSections.length; sIdx++) {
    var secRow = courseSections[sIdx];
    var secCards = (publishedCardsBySection[secRow.section_id] || [])
      .slice()
      .sort(function (a, b) {
        var diff = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
        if (diff !== 0) {
          return diff;
        }
        return String(a.card_id || '').localeCompare(String(b.card_id || ''));
      });

    var cardDtos = [];
    for (var cIdx = 0; cIdx < secCards.length; cIdx++) {
      var cDto = buildCardDtoStep7_(secCards[cIdx], assessmentsTbl.byId, filesTbl.byId);
      if (
        cDto.assessmentId &&
        courseScoreBundle.scoreByAssessmentId &&
        courseScoreBundle.scoreByAssessmentId[cDto.assessmentId]
      ) {
        cDto.studentPublishedScore =
          courseScoreBundle.scoreByAssessmentId[cDto.assessmentId];
      } else {
        cDto.studentPublishedScore = null;
      }
      cardDtos.push(cDto);
    }

    sectionDtos.push({
      sectionId: secRow.section_id,
      courseId: secRow.course_id,
      sectionType: secRow.section_type || 'CUSTOM',
      title: secRow.title || '',
      sortOrder: Number(secRow.sort_order || 10),
      updatedAtUtc: secRow.updated_at_utc || '',
      updatedAtBangkok: secRow.updated_at_utc
        ? formatBangkokTimestamp_(secRow.updated_at_utc)
        : '',
      cardCount: cardDtos.length,
      cards: cardDtos
    });
  }

  return {
    course: {
      courseId: courseRow.course_id,
      courseCode: courseRow.course_code || '',
      title: courseRow.title || '',
      subtitle: courseRow.subtitle || '',
      coverFileId: courseRow.cover_file_id || '',
      coverFileMeta: lookupFileMetaSummaryStep8_(courseRow.cover_file_id, filesTbl.byId),
      status: courseRow.status || 'PUBLISHED',
      objectivesRichText: parseStoredRichTextJsonSafe_(
        courseRow.objectives_richtext_json
      ),
      outcomesRichText: parseStoredRichTextJsonSafe_(
        courseRow.outcomes_richtext_json
      ),
      assessmentUpdatedAtUtc: courseRow.assessment_updated_at_utc || '',
      assessmentUpdatedAtBangkok: courseRow.assessment_updated_at_utc
        ? formatBangkokTimestamp_(courseRow.assessment_updated_at_utc)
        : '',
      readingUpdatedAtUtc: courseRow.reading_updated_at_utc || '',
      readingUpdatedAtBangkok: courseRow.reading_updated_at_utc
        ? formatBangkokTimestamp_(courseRow.reading_updated_at_utc)
        : '',
      updatedAtUtc: courseRow.updated_at_utc || '',
      updatedAtBangkok: courseRow.updated_at_utc
        ? formatBangkokTimestamp_(courseRow.updated_at_utc)
        : ''
    },
    sections: sectionDtos,
    publishedScores: courseScoreBundle.publishedScores || [],
    nativeExamCatalog:
      typeof handleStudentListExamsPhase3_ === 'function' && openConfiguredSpreadsheet_().getSheetByName('ExamSets') ? handleStudentListExamsPhase3_({ courseId: courseRow.course_id, adminPreview: isAdminPreview }, context, { coursesTbl: coursesTbl, enrollmentsTbl: enrollmentsTbl, cardsTbl: cardsTbl, assessmentsTbl: assessmentsTbl }) : { exams: [], legacyExternalAssessments: [] },
    enrollment: matchingEnrollment
      ? {
          enrollmentId: matchingEnrollment.enrollment_id,
          assignedAtUtc: matchingEnrollment.assigned_at_utc || '',
          assignedAtBangkok: matchingEnrollment.assigned_at_utc
            ? formatBangkokTimestamp_(matchingEnrollment.assigned_at_utc)
            : ''
        }
      : {
          enrollmentId: 'ADMIN_PREVIEW',
          assignedAtUtc: '',
          assignedAtBangkok: 'Administrator Preview Mode'
        },
    accessControlNotice:
      'Enrollment and course publication status are verified on the server on every request. If an administrator revokes an enrollment or archives a course, subsequent requests immediately return ERR_FORBIDDEN_RESOURCE.'
  };
}
/**
 * Seeds and verifies the complete Step 9 Student Learning Experience test matrix:
 * - Student A (`student_a` / Napat Srisai) enrolled in Course A (`BIO-101-CELL`, PUBLISHED)
 * - Student B (`student_b` / Dao Charoen) enrolled in Course B (`BIO-102-GENETICS`, PUBLISHED)
 * - Student C (`student_c` / Kiettisak Wong) with 0 assigned courses (empty state)
 * - Draft Course (`BIO-103-ECOLOGY-DRAFT`, DRAFT)
 * - Archived Course (`BIO-099-ARCHIVE`, ARCHIVED)
 *
 * Each published course includes:
 * - Course cover file (`fil_...`)
 * - Course assessment section (objectives, outcomes, linked Assessment Library entry, safe external URL, PDF handout)
 * - Reading material section (card title, optional image + caption, rich content, PDF attachment, external resource link)
 * - Class recordings section (1 recording card with a valid `https://` video URL, and 1 recording card where the link has NOT been added yet)
 * - Custom section (`CUSTOM`) defined by the administrator
 */
function adminSeedStep9LearningCohort_(authContext, payload) {
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};
  var samplePassword =
    typeof req.samplePassword === 'string' && req.samplePassword.length >= 8
      ? req.samplePassword
      : 'Step9Bio!2026';

  var passwordHash = hashPassword_(samplePassword);
  var nowIso = nowUtcIso_();
  var currentPrivacyVer = getCurrentPrivacyNoticeVersion_();

  var summary = {};

  withScriptLock_(function () {
    /* 1. Ensure sample private Files rows exist for covers, reading figures, and PDF handouts */
    var filesTbl = readSheetTable_('Files');
    function ensureSampleFileRow(fileId, driveFileId, purpose, courseId, filename, mimeType, sizeBytes) {
      if (filesTbl.byId[fileId]) {
        updateSheetRecordById_(
          'Files',
          fileId,
          {
            drive_file_id: driveFileId,
            purpose: purpose,
            course_id: courseId,
            original_filename: filename,
            mime_type: mimeType,
            status: 'ACTIVE'
          },
          null,
          { skipLock: true }
        );
      } else {
        insertSheetRecord_(
          'Files',
          {
            file_id: fileId,
            drive_file_id: driveFileId,
            purpose: purpose,
            course_id: courseId,
            owner_user_id: adminUser.user_id,
            original_filename: filename,
            mime_type: mimeType,
            size_bytes: sizeBytes,
            sha256_hex:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            status: 'ACTIVE',
            created_at_utc: nowIso
          },
          { skipLock: true }
        );
      }
    }

    /* 2. Ensure Courses A (PUBLISHED), B (PUBLISHED), Draft, and Archived */
    var coursesTbl = readSheetTable_('Courses');
    function upsertCourseByCode(spec) {
      var found = null;
      for (var i = 0; i < coursesTbl.records.length; i++) {
        if (
          String(coursesTbl.records[i].course_code || '').toUpperCase() ===
          spec.courseCode
        ) {
          found = coursesTbl.records[i];
          break;
        }
      }
      if (found) {
        return updateSheetRecordById_(
          'Courses',
          found.course_id,
          {
            title: spec.title,
            subtitle: spec.subtitle,
            cover_file_id: spec.coverFileId || '',
            status: spec.status,
            sort_order: spec.sortOrder,
            objectives_richtext_json: spec.objectivesJson,
            outcomes_richtext_json: spec.outcomesJson,
            assessment_updated_at_utc: nowIso,
            reading_updated_at_utc: nowIso,
            calendar_tag: spec.calendarTag,
            updated_at_utc: nowIso
          },
          Number(found.version || 1),
          { skipLock: true }
        );
      }
      var inserted = insertSheetRecord_(
        'Courses',
        {
          course_id: spec.fixedId || generateEntityId_('crs_'),
          course_code: spec.courseCode,
          title: spec.title,
          subtitle: spec.subtitle,
          cover_file_id: spec.coverFileId || '',
          status: spec.status,
          sort_order: spec.sortOrder,
          objectives_richtext_json: spec.objectivesJson,
          outcomes_richtext_json: spec.outcomesJson,
          assessment_updated_at_utc: nowIso,
          reading_updated_at_utc: nowIso,
          calendar_tag: spec.calendarTag,
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );
      coursesTbl = readSheetTable_('Courses');
      return inserted;
    }

    var courseA = upsertCourseByCode({
      fixedId: 'crs_step9_course_a_cell_0001',
      courseCode: 'BIO-101-CELL',
      title: 'Course A: Cellular Energetics, Enzyme Kinetics & Membrane Transport',
      subtitle: 'Upper-Secondary Core Biology Module A (ATP, Enzymes & Osmosis)',
      coverFileId: 'fil_step9_cover_course_a_0001',
      status: 'PUBLISHED',
      sortOrder: 10,
      calendarTag: '[BIO-101-CELL]',
      objectivesJson: JSON.stringify({
        schemaVersion: 'pb-richtext-v1',
        blocks: [
          {
            type: 'paragraph',
            spans: [
              {
                text: 'Course A Objectives: ',
                bold: true,
                size: 'lg'
              },
              {
                text: 'Master free-energy coupling (ATP hydrolysis), competitive vs. allosteric enzyme inhibition, and active membrane transport across fluid-mosaic bilayers.'
              }
            ]
          },
          {
            type: 'bullet_list',
            items: [
              {
                type: 'list_item',
                spans: [
                  {
                    text: 'Compare passive diffusion, facilitated transport, and primary active transport (Na+/K+-ATPase).'
                  }
                ]
              },
              {
                type: 'list_item',
                spans: [
                  {
                    text: 'Interpret Michaelis-Menten (Km and Vmax) curves under competitive and non-competitive inhibition.'
                  }
                ]
              }
            ]
          }
        ]
      }),
      outcomesJson: JSON.stringify({
        schemaVersion: 'pb-richtext-v1',
        blocks: [
          {
            type: 'ordered_list',
            items: [
              {
                type: 'list_item',
                spans: [
                  {
                    text: 'Calculate water potential and predict tonicity shifts in plant and mammalian red blood cells.'
                  }
                ]
              },
              {
                type: 'list_item',
                spans: [
                  {
                    text: 'Evaluate oxidative phosphorylation and chemiosmotic proton gradients in mitochondria.'
                  }
                ]
              }
            ]
          }
        ]
      })
    });

    var courseB = upsertCourseByCode({
      fixedId: 'crs_step9_course_b_gene_0002',
      courseCode: 'BIO-102-GENETICS',
      title: 'Course B: Molecular Genetics, Gene Expression & Mendelian Inheritance',
      subtitle: 'Upper-Secondary Core Biology Module B (DNA Replication, Operons & Pedigrees)',
      coverFileId: 'fil_step9_cover_course_b_0002',
      status: 'PUBLISHED',
      sortOrder: 20,
      calendarTag: '[BIO-102-GENETICS]',
      objectivesJson: JSON.stringify({
        schemaVersion: 'pb-richtext-v1',
        blocks: [
          {
            type: 'paragraph',
            spans: [
              {
                text: 'Course B Objectives: ',
                bold: true,
                size: 'lg'
              },
              {
                text: 'Analyze semi-conservative DNA replication, prokaryotic vs. eukaryotic transcriptional regulation, and multi-allele pedigree inheritance.'
              }
            ]
          }
        ]
      }),
      outcomesJson: JSON.stringify({
        schemaVersion: 'pb-richtext-v1',
        blocks: [
          {
            type: 'ordered_list',
            items: [
              {
                type: 'list_item',
                spans: [
                  {
                    text: 'Predict dihybrid cross ratios, sex-linked inheritance probabilities, and chi-square goodness-of-fit outcomes.'
                  }
                ]
              },
              {
                type: 'list_item',
                spans: [
                  {
                    text: 'Trace mRNA splicing, tRNA anticodon pairing, and ribosome translocation.'
                  }
                ]
              }
            ]
          }
        ]
      })
    });

    var courseDraft = upsertCourseByCode({
      fixedId: 'crs_step9_course_draft_0003',
      courseCode: 'BIO-103-ECOLOGY-DRAFT',
      title: 'Draft Course: Ecosystem Dynamics & Conservation Biology (Unpublished Draft)',
      subtitle: 'Upcoming Term Draft Course (Must Never Be Accessible to Students)',
      coverFileId: '',
      status: 'DRAFT',
      sortOrder: 30,
      calendarTag: '[BIO-103-DRAFT]',
      objectivesJson: plainTextToRichTextJson_('Draft ecology objectives.'),
      outcomesJson: plainTextToRichTextJson_('Draft ecology outcomes.')
    });

    var courseArchived = upsertCourseByCode({
      fixedId: 'crs_step9_course_arch_0004',
      courseCode: 'BIO-099-ARCHIVE',
      title: 'Archived Course: Legacy Foundation Biology 2025 (Archived)',
      subtitle: 'Historical Archived Course (Must Never Be Accessible to Students)',
      coverFileId: '',
      status: 'ARCHIVED',
      sortOrder: 40,
      calendarTag: '[BIO-099-ARCHIVE]',
      objectivesJson: plainTextToRichTextJson_('Archived objectives.'),
      outcomesJson: plainTextToRichTextJson_('Archived outcomes.')
    });

    /* Register sample files bound to Course A and Course B */
    ensureSampleFileRow(
      'fil_step9_cover_course_a_0001',
      'drv_step9_sample_png_cover_a',
      'COURSE_COVER',
      courseA.course_id,
      'course_a_cellular_cover.png',
      'image/png',
      68
    );
    ensureSampleFileRow(
      'fil_step9_fig_course_a_0001',
      'drv_step9_sample_png_fig_a',
      'CARD_IMAGE',
      courseA.course_id,
      'atp_synthase_diagram.png',
      'image/png',
      68
    );
    ensureSampleFileRow(
      'fil_step9_pdf_course_a_0001',
      'drv_step9_sample_pdf_handout_a',
      'PDF_ATTACHMENT',
      courseA.course_id,
      'course_a_enzyme_kinetics_handout.pdf',
      'application/pdf',
      221
    );
    ensureSampleFileRow(
      'fil_step9_cover_course_b_0002',
      'drv_step9_sample_png_cover_b',
      'COURSE_COVER',
      courseB.course_id,
      'course_b_genetics_cover.png',
      'image/png',
      68
    );
    ensureSampleFileRow(
      'fil_step9_fig_course_b_0002',
      'drv_step9_sample_png_fig_b',
      'CARD_IMAGE',
      courseB.course_id,
      'replication_fork_diagram.png',
      'image/png',
      68
    );
    ensureSampleFileRow(
      'fil_step9_pdf_course_b_0002',
      'drv_step9_sample_pdf_handout_b',
      'PDF_ATTACHMENT',
      courseB.course_id,
      'course_b_pedigree_practice_set.pdf',
      'application/pdf',
      221
    );

    /* 3. Ensure Assessment Library entries for Course A and Course B */
    var asmTbl = readSheetTable_('Assessments');
    function upsertAssessment(fixedId, title, extUrl, pdfFileId, descText) {
      if (asmTbl.byId[fixedId]) {
        return updateSheetRecordById_(
          'Assessments',
          fixedId,
          {
            title: title,
            external_url: extUrl,
            pdf_file_id: pdfFileId,
            status: 'ACTIVE',
            description_richtext_json: plainTextToRichTextJson_(descText),
            updated_at_utc: nowIso
          },
          Number(asmTbl.byId[fixedId].record.version || 1),
          { skipLock: true }
        );
      }
      var created = insertSheetRecord_(
        'Assessments',
        {
          assessment_id: fixedId,
          title: title,
          description_richtext_json: plainTextToRichTextJson_(descText),
          external_url: extUrl,
          pdf_file_id: pdfFileId,
          status: 'ACTIVE',
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );
      asmTbl = readSheetTable_('Assessments');
      return created;
    }

    var asmA = upsertAssessment(
      'asm_step9_course_a_checkpoint_01',
      'Course A Checkpoint: Enzyme Kinetics & Membrane Water Potential',
      'https://docs.google.com/forms/d/e/1FAIpQLSeSampleCellBiologyAssessmentA/viewform',
      'fil_step9_pdf_course_a_0001',
      'Complete 15 structured problem-solving questions on Michaelis-Menten kinetics and osmosis before Friday class.'
    );
    var asmB = upsertAssessment(
      'asm_step9_course_b_checkpoint_02',
      'Course B Checkpoint: Mendelian Pedigrees & Lac Operon Regulation',
      'https://docs.google.com/forms/d/e/1FAIpQLSeSampleGeneticsAssessmentB/viewform',
      'fil_step9_pdf_course_b_0002',
      'Complete the pedigree probability analysis and operon transcription worksheet.'
    );

    /* 4. Populate Sections (3 default + 1 custom section) and Cards for Course A & Course B */
    function populateCourseSectionsAndCards(courseRow, asmRow, figFileId, pdfFileId, prefixLabel) {
      var secs = ensureCourseDefaultSectionsInLock_(courseRow.course_id, nowIso);
      var secByType = {};
      for (var i = 0; i < secs.length; i++) {
        secByType[secs[i].section_type] = secs[i];
      }
      if (!secByType.CUSTOM) {
        var customSec = insertSheetRecord_(
          'Sections',
          {
            section_id: generateEntityId_('sec_'),
            course_id: courseRow.course_id,
            section_type: 'CUSTOM',
            title: prefixLabel + ' Past Exam Worked Solutions & Lab Guide',
            status: 'PUBLISHED',
            sort_order: 40,
            updated_at_utc: nowIso,
            version: 1
          },
          { skipLock: true }
        );
        secByType.CUSTOM = customSec;
      }

      /* Clear old cards for this course and insert fresh deterministic cards */
      var cardsTblNow = readSheetTable_('Cards');
      for (var cIdx = 0; cIdx < cardsTblNow.records.length; cIdx++) {
        var existingCard = cardsTblNow.records[cIdx];
        if (existingCard.course_id === courseRow.course_id) {
          deleteSheetRecordById_(
            'Cards',
            existingCard.card_id,
            Number(existingCard.version || 1),
            { skipLock: true }
          );
        }
      }

      /* Card 1: Assessment section card */
      insertSheetRecord_(
        'Cards',
        {
          card_id: generateEntityId_('crd_'),
          course_id: courseRow.course_id,
          section_id: secByType.ASSESSMENT.section_id,
          card_type: 'ASSESSMENT_LINK_CARD',
          title: asmRow.title,
          subtitle: 'Required Topic Checkpoint & Printable PDF Worksheet',
          image_file_id: '',
          image_caption: '',
          content_richtext_json: JSON.stringify({
            schemaVersion: 'pb-richtext-v1',
            blocks: [
              {
                type: 'paragraph',
                spans: [
                  { text: 'Instructions: ', bold: true },
                  {
                    text: 'Review the Course Objectives and Learning Outcomes above, download the PDF worksheet, and submit your responses using the external assessment link.'
                  }
                ]
              }
            ]
          }),
          recording_url: '',
          recording_uploaded_at_utc: '',
          assessment_id: asmRow.assessment_id,
          status: 'PUBLISHED',
          sort_order: 10,
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );

      /* Card 2: Reading material card with image, caption, rich text, PDF attachment, and resource link */
      insertSheetRecord_(
        'Cards',
        {
          card_id: generateEntityId_('crd_'),
          course_id: courseRow.course_id,
          section_id: secByType.READING.section_id,
          card_type: 'READING_CARD',
          title: prefixLabel + ' Module 1: Core Mechanisms & Annotated Diagrams',
          subtitle: 'Comprehensive reading note with figure, PDF handout, and external reference link',
          image_file_id: figFileId,
          image_caption:
            'Figure 1.1: High-resolution annotated mechanism diagram for ' +
            courseRow.course_code,
          content_richtext_json: JSON.stringify({
            schemaVersion: 'pb-richtext-v1',
            blocks: [
              {
                type: 'paragraph',
                spans: [
                  { text: 'Key Concept Summary: ', bold: true, size: 'lg' },
                  {
                    text: 'Study the annotated diagram above and review the step-by-step biochemical pathway below. Use the ',
                    size: 'base'
                  },
                  {
                    text: 'NCBI Bookshelf Molecular Cell Biology Reference',
                    bold: true,
                    underline: true,
                    link: 'https://www.ncbi.nlm.nih.gov/books/NBK21475/'
                  },
                  {
                    text: ' for additional comparative reading.'
                  }
                ]
              },
              {
                type: 'pdf_attachment',
                fileId: pdfFileId,
                title: prefixLabel + ' Printable Summary & Practice Problems (PDF)'
              }
            ]
          }),
          recording_url: 'https://www.ncbi.nlm.nih.gov/books/NBK21475/',
          recording_uploaded_at_utc: '',
          assessment_id: '',
          status: 'PUBLISHED',
          sort_order: 10,
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );

      /* Card 3: Class Recording Card WITH valid YouTube https:// video link & Lesson Documents */
      insertSheetRecord_(
        'Cards',
        {
          card_id: generateEntityId_('crd_'),
          course_id: courseRow.course_id,
          section_id: secByType.RECORDING.section_id,
          card_type: 'RECORDING_CARD',
          title: prefixLabel + ' Lecture 1: Complete Concept Walkthrough (On-Demand Video)',
          subtitle: 'Recorded live in Bangkok (90 mins, HD lecture capture)',
          image_file_id: '',
          image_caption: 'Lecture 1 Whiteboard & Slide Deck Timestamps (00:00 - 01:30:00)',
          content_richtext_json: JSON.stringify({
            schemaVersion: 'pb-richtext-v1',
            blocks: [
              {
                type: 'paragraph',
                spans: [
                  {
                    text: 'Watch the 16:9 recorded lesson above and download the annotated lecture slides and worked problem set under Lesson documents directly below the video player.',
                    size: 'base'
                  }
                ]
              },
              {
                type: 'pdf_attachment',
                fileId: pdfFileId,
                title: prefixLabel + ' Lecture 1 Annotated Slides & Worked Problems (PDF)'
              }
            ]
          }),
          recording_url:
            'https://www.youtube.com/watch?v=M7lc1UVf-VE',
          recording_uploaded_at_utc: '2026-10-20T09:00:00.000Z',
          assessment_id: '',
          status: 'PUBLISHED',
          sort_order: 10,
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );

      /* Card 4: Class Recording Card WITHOUT video link yet (tests clear unavailable message in modal) */
      insertSheetRecord_(
        'Cards',
        {
          card_id: generateEntityId_('crd_'),
          course_id: courseRow.course_id,
          section_id: secByType.RECORDING.section_id,
          card_type: 'RECORDING_CARD',
          title: prefixLabel + ' Lecture 2: Advanced Exam Problem-Solving Session (Link Pending)',
          subtitle: 'Scheduled upload after Saturday evening review session',
          image_file_id: '',
          image_caption: 'Video encoding in progress; instructor will attach the link once ready.',
          content_richtext_json: plainTextToRichTextJson_(
            'This session card has been published so students can preview the topic outline before the video link is attached.'
          ),
          recording_url: '',
          recording_uploaded_at_utc: '2026-10-24T11:00:00.000Z',
          assessment_id: '',
          status: 'PUBLISHED',
          sort_order: 20,
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );

      /* Card 5: Card in Custom Section */
      insertSheetRecord_(
        'Cards',
        {
          card_id: generateEntityId_('crd_'),
          course_id: courseRow.course_id,
          section_id: secByType.CUSTOM.section_id,
          card_type: 'READING_CARD',
          title: prefixLabel + ' Past Entrance Exam Worked Solutions & Lab Checklist',
          subtitle: 'Administrator-defined custom section card',
          image_file_id: '',
          image_caption: '',
          content_richtext_json: plainTextToRichTextJson_(
            'Worked step-by-step solutions for past Thai upper-secondary biology competition questions.'
          ),
          recording_url: 'https://www.BBO-uk.org/',
          recording_uploaded_at_utc: '',
          assessment_id: '',
          status: 'PUBLISHED',
          sort_order: 10,
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );
    }

    populateCourseSectionsAndCards(
      courseA,
      asmA,
      'fil_step9_fig_course_a_0001',
      'fil_step9_pdf_course_a_0001',
      '[Course A]'
    );
    populateCourseSectionsAndCards(
      courseB,
      asmB,
      'fil_step9_fig_course_b_0002',
      'fil_step9_pdf_course_b_0002',
      '[Course B]'
    );

    /* 5. Ensure Student A, Student B, and Student C exist and have acknowledged current Privacy Notice */
    var usersTbl = readSheetTable_('Users');
    function upsertStudentAccount(username, fullName, email, marketingOptIn) {
      var unameLower = username.toLowerCase();
      var existing = null;
      for (var i = 0; i < usersTbl.records.length; i++) {
        if (String(usersTbl.records[i].username_lower || '') === unameLower) {
          existing = usersTbl.records[i];
          break;
        }
      }
      var userRow = null;
      if (existing) {
        userRow = updateSheetRecordById_(
          'Users',
          existing.user_id,
          {
            username_display: username,
            email: email,
            full_name: fullName,
            role: 'STUDENT',
            status: 'ACTIVE',
            password_hash: passwordHash,
            password_updated_at_utc: nowIso,
            last_login_at_utc: nowIso,
            privacy_ack_version: currentPrivacyVer,
            marketing_opt_in: marketingOptIn,
            updated_at_utc: nowIso
          },
          Number(existing.version || 1),
          { skipLock: true }
        );
      } else {
        userRow = insertSheetRecord_(
          'Users',
          {
            user_id: generateEntityId_('usr_'),
            username_lower: unameLower,
            username_display: username,
            email: email,
            full_name: fullName,
            role: 'STUDENT',
            status: 'ACTIVE',
            password_hash: passwordHash,
            password_updated_at_utc: nowIso,
            last_login_at_utc: nowIso,
            privacy_ack_version: currentPrivacyVer,
            marketing_opt_in: marketingOptIn,
            is_minor_flag: false,
            created_at_utc: nowIso,
            updated_at_utc: nowIso,
            version: 1
          },
          { skipLock: true }
        );
        usersTbl = readSheetTable_('Users');
      }

      insertSheetRecord_(
        'PrivacyChoices',
        {
          choice_id: generateEntityId_('prv_'),
          user_id: userRow.user_id,
          notice_version: currentPrivacyVer,
          acknowledged_notice: true,
          marketing_opt_in: Boolean(marketingOptIn),
          action_source: 'FIRST_LOGIN_GATE',
          recorded_at_utc: nowIso
        },
        { skipLock: true }
      );
      return userRow;
    }

    var studentA = upsertStudentAccount(
      'student_a',
      'Napat Srisai (Student A)',
      'student_a@student.pattanabhumi.example.org',
      false
    );
    var studentB = upsertStudentAccount(
      'student_b',
      'Dao Charoen (Student B)',
      'student_b@student.pattanabhumi.example.org',
      true
    );
    var studentC = upsertStudentAccount(
      'student_c',
      'Kiettisak Wong (Student C - No Courses)',
      'student_c@student.pattanabhumi.example.org',
      false
    );

    /* 6. Synchronize exact Enrollments:
          - Student A -> Course A (ACTIVE)
          - Student B -> Course B (ACTIVE)
          - Student C -> 0 courses
    */
    function setExactStudentEnrollmentsInLock(userId, activeCourseIds) {
      var enrTbl = readSheetTable_('Enrollments');
      var targetMap = {};
      for (var t = 0; t < activeCourseIds.length; t++) {
        targetMap[activeCourseIds[t]] = true;
      }
      var existingByCourse = {};
      for (var i = 0; i < enrTbl.records.length; i++) {
        var r = enrTbl.records[i];
        if (r.user_id === userId) {
          existingByCourse[r.course_id] = r;
          var shouldBeActive = Boolean(targetMap[r.course_id]);
          var desiredStatus = shouldBeActive ? 'ACTIVE' : 'REVOKED';
          if (r.status !== desiredStatus) {
            updateSheetRecordById_(
              'Enrollments',
              r.enrollment_id,
              {
                status: desiredStatus,
                updated_at_utc: nowIso
              },
              Number(r.version || 1),
              { skipLock: true }
            );
          }
        }
      }
      for (var c = 0; c < activeCourseIds.length; c++) {
        var cid = activeCourseIds[c];
        if (!existingByCourse[cid]) {
          insertSheetRecord_(
            'Enrollments',
            {
              enrollment_id: generateEntityId_('enr_'),
              user_id: userId,
              course_id: cid,
              status: 'ACTIVE',
              assigned_by_user_id: adminUser.user_id,
              assigned_at_utc: nowIso,
              updated_at_utc: nowIso,
              version: 1
            },
            { skipLock: true }
          );
        }
      }
    }

    setExactStudentEnrollmentsInLock(studentA.user_id, [courseA.course_id]);
    setExactStudentEnrollmentsInLock(studentB.user_id, [courseB.course_id]);
    setExactStudentEnrollmentsInLock(studentC.user_id, []);

    /* 7. Seed Phase 4 Published and Draft AssessmentScores for Student A and Student B */
    var scoresTbl = readSheetTable_('AssessmentScores');
    function upsertSampleScore(fixedScoreId, courseId, assessmentId, studentUserId, pts, maxPts, feedback, statusVal, pubUtc) {
      if (scoresTbl.byId[fixedScoreId]) {
        return updateSheetRecordById_(
          'AssessmentScores',
          fixedScoreId,
          {
            course_id: courseId,
            assessment_id: assessmentId,
            student_user_id: studentUserId,
            score_points: pts,
            max_points: maxPts,
            feedback_text: feedback,
            status: statusVal,
            published_at_utc: pubUtc,
            updated_by_user_id: adminUser.user_id,
            updated_at_utc: nowIso
          },
          Number(scoresTbl.byId[fixedScoreId].record.version || 1),
          { skipLock: true }
        );
      }
      var createdScore = insertSheetRecord_(
        'AssessmentScores',
        {
          score_id: fixedScoreId,
          course_id: courseId,
          assessment_id: assessmentId,
          student_user_id: studentUserId,
          score_points: pts,
          max_points: maxPts,
          feedback_text: feedback,
          status: statusVal,
          published_at_utc: pubUtc,
          updated_by_user_id: adminUser.user_id,
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );
      scoresTbl = readSheetTable_('AssessmentScores');
      return createdScore;
    }

    upsertSampleScore(
      'scr_step9_pub_student_a_01',
      courseA.course_id,
      asmA.assessment_id,
      studentA.user_id,
      '46.5',
      '50',
      'Excellent Michaelis-Menten curve analysis and tonicity calculations. Review allosteric feedback inhibition before Unit 2.',
      'PUBLISHED',
      '2026-10-25T10:30:00.000Z'
    );
    upsertSampleScore(
      'scr_step9_draft_student_a_02',
      courseA.course_id,
      asmA.assessment_id,
      studentA.user_id,
      '19',
      '20',
      'Draft Lab Practical 2 score undergoing instructor moderation (must remain hidden from student until PUBLISHED).',
      'DRAFT',
      ''
    );
    upsertSampleScore(
      'scr_step9_pub_student_b_01',
      courseB.course_id,
      asmB.assessment_id,
      studentB.user_id,
      '38',
      '40',
      'Strong dihybrid pedigree probability derivations and chi-square interpretation.',
      'PUBLISHED',
      '2026-10-25T11:00:00.000Z'
    );

    summary = {
      samplePasswordForTesting: samplePassword,
      students: {
        studentA: {
          userId: studentA.user_id,
          username: studentA.username_display,
          email: studentA.email,
          enrolledCourseIds: [courseA.course_id],
          enrolledCourseCode: courseA.course_code
        },
        studentB: {
          userId: studentB.user_id,
          username: studentB.username_display,
          email: studentB.email,
          enrolledCourseIds: [courseB.course_id],
          enrolledCourseCode: courseB.course_code
        },
        studentC: {
          userId: studentC.user_id,
          username: studentC.username_display,
          email: studentC.email,
          enrolledCourseIds: [],
          note: 'Zero courses assigned (verifies My Profile empty state)'
        }
      },
      courses: {
        courseA: {
          courseId: courseA.course_id,
          courseCode: courseA.course_code,
          title: courseA.title,
          status: courseA.status,
          coverFileId: 'fil_step9_cover_course_a_0001',
          readingImageFileId: 'fil_step9_fig_course_a_0001',
          pdfFileId: 'fil_step9_pdf_course_a_0001'
        },
        courseB: {
          courseId: courseB.course_id,
          courseCode: courseB.course_code,
          title: courseB.title,
          status: courseB.status,
          coverFileId: 'fil_step9_cover_course_b_0002',
          readingImageFileId: 'fil_step9_fig_course_b_0002',
          pdfFileId: 'fil_step9_pdf_course_b_0002'
        },
        draftCourse: {
          courseId: courseDraft.course_id,
          courseCode: courseDraft.course_code,
          title: courseDraft.title,
          status: courseDraft.status
        },
        archivedCourse: {
          courseId: courseArchived.course_id,
          courseCode: courseArchived.course_code,
          title: courseArchived.title,
          status: courseArchived.status
        }
      },
      savedMessage:
        'Step 9 Student Learning Cohort Ready: Student A -> Course A (BIO-101-CELL), Student B -> Course B (BIO-102-GENETICS), Student C -> No Courses, plus Draft (BIO-103-ECOLOGY-DRAFT) and Archived (BIO-099-ARCHIVE) courses.'
    };
  });

  return summary;
}

function handleAdminSeedStep9LearningCohort_(payload, context) {
  return adminSeedStep9LearningCohort_(context.authContext, payload);
}

/**
 * Phase 4 YouTube URL & Video Normalization Helper (`extractAndNormalizeYouTubeUrlPhase4_`).
 * Recognizes standard `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/embed/`,
 * `youtube-nocookie.com/embed/`, and `youtube.com/shorts/` URLs with an 11-character video ID.
 *
 * @param {string} rawUrl Raw recording URL.
 * @return {{ isYouTubeVideo: boolean, youtubeVideoId: string, youtubeEmbedUrl: string, youtubeWatchUrl: string, normalizedUrl: string }}
 */
function extractAndNormalizeYouTubeUrlPhase4_(rawUrl) {
  var emptyResult = {
    isYouTubeVideo: false,
    youtubeVideoId: '',
    youtubeEmbedUrl: '',
    youtubeWatchUrl: '',
    normalizedUrl: ''
  };
  if (rawUrl === null || rawUrl === undefined) {
    return emptyResult;
  }
  var trimmed = String(rawUrl).trim();
  if (trimmed.indexOf('<') !== -1) {
    var mIframeSrc = trimmed.match(/\bsrc\s*=\s*["'](https:\/\/[^"'\s]+)["']/i);
    if (mIframeSrc && mIframeSrc[1]) {
      trimmed = mIframeSrc[1].trim();
    }
  }
  if (!trimmed || trimmed.length > 500 || /[\s\u0000-\u001F\u007F]/.test(trimmed)) {
    return emptyResult;
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(trimmed)) {
    return emptyResult;
  }

  var videoId = '';
  var mWatch = trimmed.match(
    /^https:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#\s]*&)?v=([A-Za-z0-9_-]{11})(?:[&#][^\s]*)?$/i
  );
  var mShort = trimmed.match(
    /^https:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[?#][^\s]*)?$/i
  );
  var mEmbed = trimmed.match(
    /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})(?:[?#][^\s]*)?$/i
  );
  var mShorts = trimmed.match(
    /^https:\/\/(?:www\.|m\.)?youtube\.com\/(?:shorts|live)\/([A-Za-z0-9_-]{11})(?:[?#][^\s]*)?$/i
  );

  if (mWatch && mWatch[1]) {
    videoId = mWatch[1];
  } else if (mShort && mShort[1]) {
    videoId = mShort[1];
  } else if (mEmbed && mEmbed[1]) {
    videoId = mEmbed[1];
  } else if (mShorts && mShorts[1]) {
    videoId = mShorts[1];
  }

  if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return {
      isYouTubeVideo: true,
      youtubeVideoId: videoId,
      youtubeEmbedUrl: 'https://www.youtube-nocookie.com/embed/' + videoId + '?rel=0',
      youtubeWatchUrl: 'https://www.youtube.com/watch?v=' + videoId,
      normalizedUrl: 'https://www.youtube.com/watch?v=' + videoId
    };
  }

  return {
    isYouTubeVideo: false,
    youtubeVideoId: '',
    youtubeEmbedUrl: '',
    youtubeWatchUrl: '',
    normalizedUrl: trimmed
  };
}

/**
 * Formats a numeric score and max points into a percentage label (e.g., `93.0%`).
 *
 * @param {string|number} scorePoints Earned score points.
 * @param {string|number} maxPoints Maximum possible points (> 0).
 * @return {{ percentageFormatted: string, percentageValue: number }}
 */
function computeScorePercentagePhase4_(scorePoints, maxPoints) {
  var s = Number(scorePoints);
  var m = Number(maxPoints);
  if (!isFinite(s) || !isFinite(m) || m <= 0 || s < 0) {
    return {
      percentageFormatted: '-',
      percentageValue: 0
    };
  }
  var pct = (s / m) * 100;
  return {
    percentageFormatted: pct.toFixed(1) + '%',
    percentageValue: Number(pct.toFixed(1))
  };
}

/**
 * Formats a raw `AssessmentScores` row into a client-safe DTO.
 *
 * @param {Object} scoreRow Raw row from `AssessmentScores`.
 * @param {Object} coursesById Lookup map from `readSheetTable_('Courses').byId`.
 * @param {Object} assessmentsById Lookup map from `readSheetTable_('Assessments').byId`.
 * @param {Object=} opt_usersById Optional lookup map from `readSheetTable_('Users').byId`.
 * @param {boolean=} opt_includeAdminFields True when building admin-facing DTOs.
 * @return {Object} Client-safe assessment score DTO.
 */
function buildAssessmentScoreDtoPhase4_(
  scoreRow,
  coursesById,
  assessmentsById,
  opt_usersById,
  opt_includeAdminFields
) {
  var cHit = coursesById && coursesById[scoreRow.course_id];
  var cRec = cHit ? cHit.record : null;
  var aHit = assessmentsById && assessmentsById[scoreRow.assessment_id];
  var aRec = aHit ? aHit.record : null;
  var pctMeta = computeScorePercentagePhase4_(
    scoreRow.score_points,
    scoreRow.max_points
  );
  var scoreStr = String(
    scoreRow.score_points !== undefined && scoreRow.score_points !== null
      ? scoreRow.score_points
      : '0'
  );
  var maxStr = String(
    scoreRow.max_points !== undefined && scoreRow.max_points !== null
      ? scoreRow.max_points
      : '0'
  );

  var dto = {
    scoreId: scoreRow.score_id,
    courseId: scoreRow.course_id,
    courseCode: cRec ? cRec.course_code || '' : '',
    courseTitle: cRec ? cRec.title || '' : '',
    assessmentId: scoreRow.assessment_id,
    assessmentTitle: aRec ? aRec.title || 'Assessment' : 'Assessment',
    studentUserId: scoreRow.student_user_id,
    scorePoints: scoreStr,
    maxPoints: maxStr,
    scoreDisplay: scoreStr + ' / ' + maxStr,
    percentageFormatted: pctMeta.percentageFormatted,
    percentageValue: pctMeta.percentageValue,
    feedbackText: scoreRow.feedback_text || '',
    status: scoreRow.status || 'DRAFT',
    publishedAtUtc: scoreRow.published_at_utc || '',
    publishedAtBangkok: scoreRow.published_at_utc
      ? formatBangkokTimestamp_(scoreRow.published_at_utc)
      : '',
    updatedAtUtc: scoreRow.updated_at_utc || '',
    updatedAtBangkok: scoreRow.updated_at_utc
      ? formatBangkokTimestamp_(scoreRow.updated_at_utc)
      : '',
    version: Number(scoreRow.version || 1)
  };

  if (opt_includeAdminFields) {
    var uHit = opt_usersById && opt_usersById[scoreRow.student_user_id];
    var uRec = uHit ? uHit.record : null;
    dto.studentUsername = uRec ? uRec.username_display || uRec.username_lower || '' : '';
    dto.studentFullName = uRec ? uRec.full_name || '' : '';
    dto.updatedByUserId = scoreRow.updated_by_user_id || '';
    dto.createdAtUtc = scoreRow.created_at_utc || '';
  }

  return dto;
}

/**
 * Returns only `PUBLISHED` assessment scores belonging to `studentUserId` for courses
 * where the student currently holds an `ACTIVE` enrollment AND the course is `PUBLISHED`.
 * Draft scores, archived scores, and scores belonging to other students are strictly withheld.
 *
 * @param {string} studentUserId Verified student user_id from `authContext`.
 * @param {string=} opt_courseId Optional course filter.
 * @param {boolean=} opt_isAdminPreview True when an ADMIN previews a course's published scores.
 * @return {{ publishedScores: Array<Object>, totalPublishedCount: number, publishedCountByCourse: Object<string, number>, scoreByAssessmentId: Object<string, Object> }}
 */
function listStudentPublishedScoresPhase4_(
  studentUserId,
  opt_courseId,
  opt_isAdminPreview
) {
  var coursesTbl = readSheetTable_('Courses');
  var assessmentsTbl = readSheetTable_('Assessments');
  var enrollmentsTbl = readSheetTable_('Enrollments');
  var scoresTbl = readSheetTable_('AssessmentScores');

  var filterCourseId = opt_courseId ? String(opt_courseId).trim() : '';
  var activePublishedCourses = {};

  if (opt_isAdminPreview) {
    for (var cIdx = 0; cIdx < coursesTbl.records.length; cIdx++) {
      var cRow = coursesTbl.records[cIdx];
      activePublishedCourses[cRow.course_id] = true;
    }
  } else {
    for (var eIdx = 0; eIdx < enrollmentsTbl.records.length; eIdx++) {
      var enr = enrollmentsTbl.records[eIdx];
      if (enr.user_id === studentUserId && enr.status === 'ACTIVE') {
        var cHit = coursesTbl.byId[enr.course_id];
        if (cHit && cHit.record && cHit.record.status === 'PUBLISHED') {
          activePublishedCourses[enr.course_id] = true;
        }
      }
    }
  }

  var matchedRows = [];
  var publishedCountByCourse = {};
  for (var sIdx = 0; sIdx < scoresTbl.records.length; sIdx++) {
    var sRow = scoresTbl.records[sIdx];
    if (sRow.status !== 'PUBLISHED') {
      continue;
    }
    if (!opt_isAdminPreview && sRow.student_user_id !== studentUserId) {
      continue;
    }
    if (!activePublishedCourses[sRow.course_id]) {
      continue;
    }
    publishedCountByCourse[sRow.course_id] =
      (publishedCountByCourse[sRow.course_id] || 0) + 1;
    if (filterCourseId && sRow.course_id !== filterCourseId) {
      continue;
    }
    matchedRows.push(sRow);
  }

  matchedRows.sort(function (a, b) {
    var tA = String(a.published_at_utc || a.updated_at_utc || '');
    var tB = String(b.published_at_utc || b.updated_at_utc || '');
    if (tA !== tB) {
      return tB.localeCompare(tA);
    }
    return String(a.score_id || '').localeCompare(String(b.score_id || ''));
  });

  var dtos = [];
  var scoreByAssessmentId = {};
  for (var dIdx = 0; dIdx < matchedRows.length; dIdx++) {
    var dto = buildAssessmentScoreDtoPhase4_(
      matchedRows[dIdx],
      coursesTbl.byId,
      assessmentsTbl.byId,
      null,
      false
    );
    dtos.push(dto);
    if (!scoreByAssessmentId[dto.assessmentId]) {
      scoreByAssessmentId[dto.assessmentId] = dto;
    }
  }

  return {
    publishedScores: dtos,
    totalPublishedCount: dtos.length,
    publishedCountByCourse: publishedCountByCourse,
    scoreByAssessmentId: scoreByAssessmentId
  };
}

/**
 * Student RPC handler (`student.listPublishedScores`).
 * Strictly derives student identity from `context.authContext.user.user_id` and ignores any
 * client-supplied `userId` or `studentUserId` field.
 *
 * @param {Object} payload `{ courseId?: string }`.
 * @param {Object} context RPC dispatch context.
 * @return {Object} Authorized published scores bundle.
 */
function handleStudentListPublishedScoresPhase4_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to view published assessment scores.'
    );
  }
  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var courseId = req.courseId ? String(req.courseId).trim() : '';

  if (courseId && usr.role !== 'ADMIN') {
    var coursesTbl = readSheetTable_('Courses');
    var cHit = coursesTbl.byId[courseId];
    if (!cHit || !cHit.record) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Requested course was not found.'
      );
    }
    var enrollmentsTbl = readSheetTable_('Enrollments');
    var hasActiveEnr = false;
    for (var e = 0; e < enrollmentsTbl.records.length; e++) {
      var enr = enrollmentsTbl.records[e];
      if (
        enr.user_id === usr.user_id &&
        enr.course_id === courseId &&
        enr.status === 'ACTIVE'
      ) {
        hasActiveEnr = true;
        break;
      }
    }
    if (!hasActiveEnr || cHit.record.status !== 'PUBLISHED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: You do not have an active enrollment in this published course.'
      );
    }
  }

  var bundle = listStudentPublishedScoresPhase4_(
    usr.user_id,
    courseId,
    usr.role === 'ADMIN' && Boolean(req.adminPreview)
  );
  return {
    studentUserId: usr.user_id,
    courseId: courseId || 'ALL_ENROLLED_COURSES',
    publishedScores: bundle.publishedScores,
    totalPublishedCount: bundle.totalPublishedCount,
    timezone: 'Asia/Bangkok (UTC+07:00)',
    securityNotice:
      'Only PUBLISHED scores for your authenticated student account in actively enrolled PUBLISHED courses are returned.'
  };
}

/**
 * Admin RPC handler (`admin.saveAssessmentScore`) to create, update, publish, or archive
 * a student's assessment score in `AssessmentScores`.
 *
 * @param {Object} payload Score save payload.
 * @param {Object} context RPC dispatch context.
 * @return {Object} Saved score DTO and updated course score list.
 */
function handleAdminSaveAssessmentScorePhase4_(payload, context) {
  var authContext = context && context.authContext;
  var adminUser = assertStep7AdminRole_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};
  var fieldErrors = {};

  var scoreId = req.scoreId ? String(req.scoreId).trim() : '';
  var courseId = String(req.courseId || '').trim();
  var assessmentId = String(req.assessmentId || '').trim();
  var studentUserId = String(req.studentUserId || '').trim();

  if (!courseId) {
    fieldErrors.courseId = 'Course is required.';
  }
  if (!assessmentId) {
    fieldErrors.assessmentId = 'Assessment is required.';
  }
  if (!studentUserId) {
    fieldErrors.studentUserId = 'Student account is required.';
  }

  var rawScorePoints =
    req.scorePoints !== undefined && req.scorePoints !== null
      ? String(req.scorePoints).trim()
      : '';
  var rawMaxPoints =
    req.maxPoints !== undefined && req.maxPoints !== null
      ? String(req.maxPoints).trim()
      : '';

  var numScore = Number(rawScorePoints);
  var numMax = Number(rawMaxPoints);

  if (
    rawScorePoints === '' ||
    !/^\d+(?:\.\d{1,2})?$/.test(rawScorePoints) ||
    !isFinite(numScore) ||
    numScore < 0 ||
    numScore > 10000
  ) {
    fieldErrors.scorePoints =
      'Earned score points must be a non-negative number up to 2 decimal places (0 to 10000).';
  }
  if (
    rawMaxPoints === '' ||
    !/^\d+(?:\.\d{1,2})?$/.test(rawMaxPoints) ||
    !isFinite(numMax) ||
    numMax <= 0 ||
    numMax > 10000
  ) {
    fieldErrors.maxPoints =
      'Maximum points must be a positive number up to 2 decimal places (greater than 0, max 10000).';
  }
  if (
    !fieldErrors.scorePoints &&
    !fieldErrors.maxPoints &&
    numScore > numMax
  ) {
    fieldErrors.scorePoints =
      'Earned score points (' +
      rawScorePoints +
      ') cannot exceed maximum points (' +
      rawMaxPoints +
      ').';
  }

  var status = String(req.status || 'DRAFT')
    .trim()
    .toUpperCase();
  if (status !== 'DRAFT' && status !== 'PUBLISHED' && status !== 'ARCHIVED') {
    fieldErrors.status = 'Score status must be DRAFT, PUBLISHED, or ARCHIVED.';
  }

  var feedbackText = sanitizeSingleLineTextStep7_(req.feedbackText, 1000);

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please fix the highlighted assessment score fields.',
      fieldErrors
    );
  }

  var savedRow = null;
  var coursesTbl = null;
  var assessmentsTbl = null;
  var usersTbl = null;

  withScriptLock_(function () {
    coursesTbl = readSheetTable_('Courses');
    assessmentsTbl = readSheetTable_('Assessments');
    usersTbl = readSheetTable_('Users');
    var scoresTbl = readSheetTable_('AssessmentScores');

    var cHit = coursesTbl.byId[courseId];
    if (!cHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Course "' + courseId + '" was not found.'
      );
    }
    var aHit = assessmentsTbl.byId[assessmentId];
    if (!aHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Assessment "' + assessmentId + '" was not found.'
      );
    }
    var uHit = usersTbl.byId[studentUserId];
    if (!uHit || uHit.record.role !== 'STUDENT') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Student user "' + studentUserId + '" was not found.'
      );
    }

    var nowIso = nowUtcIso_();
    var targetHit = scoreId ? scoresTbl.byId[scoreId] : null;

    if (!targetHit && !scoreId) {
      for (var i = 0; i < scoresTbl.records.length; i++) {
        var r = scoresTbl.records[i];
        if (
          r.course_id === courseId &&
          r.assessment_id === assessmentId &&
          r.student_user_id === studentUserId
        ) {
          targetHit = scoresTbl.byId[r.score_id];
          scoreId = r.score_id;
          break;
        }
      }
    }

    if (!targetHit) {
      var newScoreId = scoreId || generateEntityId_('scr_');
      savedRow = insertSheetRecord_(
        'AssessmentScores',
        {
          score_id: newScoreId,
          course_id: courseId,
          assessment_id: assessmentId,
          student_user_id: studentUserId,
          score_points: rawScorePoints,
          max_points: rawMaxPoints,
          feedback_text: feedbackText,
          status: status,
          published_at_utc: status === 'PUBLISHED' ? nowIso : '',
          updated_by_user_id: adminUser.user_id,
          created_at_utc: nowIso,
          updated_at_utc: nowIso,
          version: 1
        },
        { skipLock: true }
      );
    } else {
      var actualVersion = Number(targetHit.record.version || 1);
      var expectedVersion = req.expectedVersion
        ? Number(req.expectedVersion)
        : actualVersion;
      if (expectedVersion !== actualVersion) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Stale score edit detected: expected version ' +
            expectedVersion +
            ', found ' +
            actualVersion +
            '.'
        );
      }
      var nextPublishedAt =
        status === 'PUBLISHED'
          ? targetHit.record.published_at_utc || nowIso
          : '';
      savedRow = updateSheetRecordById_(
        'AssessmentScores',
        targetHit.record.score_id,
        {
          course_id: courseId,
          assessment_id: assessmentId,
          student_user_id: studentUserId,
          score_points: rawScorePoints,
          max_points: rawMaxPoints,
          feedback_text: feedbackText,
          status: status,
          published_at_utc: nextPublishedAt,
          updated_by_user_id: adminUser.user_id,
          updated_at_utc: nowIso
        },
        expectedVersion,
        { skipLock: true }
      );
    }

    updateSheetRecordById_(
      'Courses',
      courseId,
      {
        assessment_updated_at_utc: nowIso,
        updated_at_utc: nowIso
      },
      Number(cHit.record.version || 1),
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_ASSESSMENT_SCORE_SAVED',
      targetEntityType: 'AssessmentScore',
      targetEntityId: savedRow.score_id,
      summary: {
        courseId: courseId,
        assessmentId: assessmentId,
        studentUserId: studentUserId,
        scorePoints: rawScorePoints,
        maxPoints: rawMaxPoints,
        status: status
      }
    });
  });

  var dto = buildAssessmentScoreDtoPhase4_(
    savedRow,
    coursesTbl.byId,
    assessmentsTbl.byId,
    usersTbl.byId,
    true
  );

  return {
    savedScore: dto,
    savedMessage:
      'Saved assessment score (' +
      dto.scoreDisplay +
      ', ' +
      dto.percentageFormatted +
      ', status: ' +
      dto.status +
      ').'
  };
}

/**
 * Admin RPC handler (`admin.listAssessmentScores`) to view and filter assessment scores.
 *
 * @param {Object} payload Optional filters (`courseId`, `assessmentId`, `studentUserId`, `status`).
 * @param {Object} context RPC dispatch context.
 * @return {Object} Admin assessment score list.
 */
function handleAdminListAssessmentScoresPhase4_(payload, context) {
  var authContext = context && context.authContext;
  assertStep7AdminRole_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};
  var filterCourseId = req.courseId ? String(req.courseId).trim() : '';
  var filterAssessmentId = req.assessmentId ? String(req.assessmentId).trim() : '';
  var filterStudentId = req.studentUserId ? String(req.studentUserId).trim() : '';
  var filterStatus = req.status ? String(req.status).trim().toUpperCase() : '';

  var coursesTbl = readSheetTable_('Courses');
  var assessmentsTbl = readSheetTable_('Assessments');
  var usersTbl = readSheetTable_('Users');
  var scoresTbl = readSheetTable_('AssessmentScores');

  var dtos = [];
  for (var i = 0; i < scoresTbl.records.length; i++) {
    var r = scoresTbl.records[i];
    if (filterCourseId && r.course_id !== filterCourseId) continue;
    if (filterAssessmentId && r.assessment_id !== filterAssessmentId) continue;
    if (filterStudentId && r.student_user_id !== filterStudentId) continue;
    if (filterStatus && filterStatus !== 'ALL' && r.status !== filterStatus) continue;
    dtos.push(
      buildAssessmentScoreDtoPhase4_(
        r,
        coursesTbl.byId,
        assessmentsTbl.byId,
        usersTbl.byId,
        true
      )
    );
  }

  return {
    scores: dtos,
    totalCount: dtos.length
  };
}

/* ==========================================================================
 * NATIVE ONLINE EXAMINATION SYSTEM -- PHASE 2: QUESTION BANK, SHARED STIMULI,
 * 6 QUESTION TYPES, IMMUTABLE QUESTION VERSIONS & STUDENT DTO SEPARATION
 * ========================================================================== */

var PB_EXAM_QUESTION_TYPES_PHASE2_ = Object.freeze({
  SINGLE_CHOICE: true,
  COMPLEX_MULTIPLE_CHOICE: true,
  MULTIPLE_SELECT: true,
  TRUE_FALSE: true,
  NUMERIC_RESPONSE: true,
  SHORT_ANSWER: true,
  WRITTEN_RESPONSE: true
});

var PB_EXAM_DIFFICULTIES_PHASE2_ = Object.freeze({
  EASY: true,
  MEDIUM: true,
  HARD: true,
  OLYMPIAD: true
});

var PB_EXAM_ITEM_STATUSES_PHASE2_ = Object.freeze({
  DRAFT: true,
  PUBLISHED: true,
  ARCHIVED: true
});

/**
 * Ensures the 4 Phase 2 normalized worksheets (SharedStimuli, QuestionBank,
 * QuestionVersions, QuestionOptions) and extended file purposes are registered
 * in PB_SHEET_NAMES_ and PB_SHEET_SCHEMAS_ idempotently.
 */
function ensureExamPhase2SchemasRegistered_() {
  var extraPurposes = [
    'INSTRUCTOR_PORTRAIT',
    'HERO_SHUFFLE_CARD',
    'QUESTION_IMAGE',
    'OPTION_IMAGE',
    'STIMULUS_IMAGE',
    'EXAM_COVER_IMAGE',
    'EXPLANATION_ATTACHMENT'
  ];

  if (
    typeof PB_SHEET_SCHEMAS_ === 'object' &&
    PB_SHEET_SCHEMAS_ &&
    PB_SHEET_SCHEMAS_.Files &&
    PB_SHEET_SCHEMAS_.Files.enums &&
    Array.isArray(PB_SHEET_SCHEMAS_.Files.enums.purpose)
  ) {
    var curPurposes = PB_SHEET_SCHEMAS_.Files.enums.purpose.slice();
    var purposeChanged = false;
    for (var pi = 0; pi < extraPurposes.length; pi++) {
      if (curPurposes.indexOf(extraPurposes[pi]) === -1) {
        curPurposes.push(extraPurposes[pi]);
        purposeChanged = true;
      }
    }
    if (purposeChanged) {
      var nextFilesEnum = Object.freeze({
        purpose: Object.freeze(curPurposes),
        mime_type: PB_SHEET_SCHEMAS_.Files.enums.mime_type,
        status: PB_SHEET_SCHEMAS_.Files.enums.status
      });
      var copySchemasF = {};
      var fKeys = Object.keys(PB_SHEET_SCHEMAS_);
      for (var fk = 0; fk < fKeys.length; fk++) {
        copySchemasF[fKeys[fk]] = PB_SHEET_SCHEMAS_[fKeys[fk]];
      }
      copySchemasF.Files = Object.freeze({
        sheetName: PB_SHEET_SCHEMAS_.Files.sheetName,
        primaryKey: PB_SHEET_SCHEMAS_.Files.primaryKey,
        idPrefix: PB_SHEET_SCHEMAS_.Files.idPrefix,
        hasVersion: PB_SHEET_SCHEMAS_.Files.hasVersion,
        headers: PB_SHEET_SCHEMAS_.Files.headers,
        requiredFields: PB_SHEET_SCHEMAS_.Files.requiredFields,
        enums: nextFilesEnum,
        booleanFields: PB_SHEET_SCHEMAS_.Files.booleanFields,
        integerFields: PB_SHEET_SCHEMAS_.Files.integerFields,
        positiveSatangFields: PB_SHEET_SCHEMAS_.Files.positiveSatangFields
      });
      PB_SHEET_SCHEMAS_ = Object.freeze(copySchemasF);
    }
  }

  var phase2SheetNames = [
    'SharedStimuli',
    'QuestionBank',
    'QuestionVersions',
    'QuestionOptions'
  ];

  if (typeof PB_SHEET_NAMES_ === 'object' && Array.isArray(PB_SHEET_NAMES_)) {
    var nextSheetNames = PB_SHEET_NAMES_.slice();
    var namesChanged = false;
    for (var sn = 0; sn < phase2SheetNames.length; sn++) {
      if (nextSheetNames.indexOf(phase2SheetNames[sn]) === -1) {
        nextSheetNames.push(phase2SheetNames[sn]);
        namesChanged = true;
      }
    }
    if (namesChanged) {
      PB_SHEET_NAMES_ = Object.freeze(nextSheetNames);
    }
  }

  if (
    typeof PB_SHEET_SCHEMAS_ === 'object' &&
    PB_SHEET_SCHEMAS_ &&
    (!PB_SHEET_SCHEMAS_.SharedStimuli ||
      !PB_SHEET_SCHEMAS_.QuestionBank ||
      !PB_SHEET_SCHEMAS_.QuestionVersions ||
      !PB_SHEET_SCHEMAS_.QuestionOptions)
  ) {
    var nextSchemas = {};
    var sKeys = Object.keys(PB_SHEET_SCHEMAS_);
    for (var si = 0; si < sKeys.length; si++) {
      nextSchemas[sKeys[si]] = PB_SHEET_SCHEMAS_[sKeys[si]];
    }

    nextSchemas.SharedStimuli = Object.freeze({
      sheetName: 'SharedStimuli',
      primaryKey: 'stimulus_id',
      idPrefix: 'stim_',
      hasVersion: true,
      headers: Object.freeze([
        'stimulus_id',
        'stimulus_code',
        'title',
        'content_richtext_json',
        'image_file_id',
        'image_alt_text',
        'image_caption',
        'accessible_design_flag',
        'topic_tags_json',
        'status',
        'created_by_user_id',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'stimulus_id',
        'stimulus_code',
        'title',
        'accessible_design_flag',
        'status',
        'created_at_utc',
        'updated_at_utc'
      ]),
      enums: Object.freeze({
        accessible_design_flag: Object.freeze([
          'STANDARD_ALT',
          'VISUAL_INTERPRETATION_REQUIRED'
        ]),
        status: Object.freeze(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
      }),
      booleanFields: Object.freeze([]),
      integerFields: Object.freeze(['version']),
      positiveSatangFields: Object.freeze([])
    });

    nextSchemas.QuestionBank = Object.freeze({
      sheetName: 'QuestionBank',
      primaryKey: 'question_id',
      idPrefix: 'qbn_',
      hasVersion: true,
      headers: Object.freeze([
        'question_id',
        'question_code',
        'title',
        'question_type',
        'topic_tags_json',
        'difficulty',
        'active_version_id',
        'latest_version_no',
        'status',
        'used_in_attempts_count',
        'created_by_user_id',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'question_id',
        'question_code',
        'title',
        'question_type',
        'difficulty',
        'active_version_id',
        'latest_version_no',
        'status',
        'created_at_utc',
        'updated_at_utc'
      ]),
      enums: Object.freeze({
        question_type: Object.freeze([
          'SINGLE_CHOICE',
          'COMPLEX_MULTIPLE_CHOICE',
          'MULTIPLE_SELECT',
          'TRUE_FALSE',
          'NUMERIC_RESPONSE',
          'SHORT_ANSWER',
          'WRITTEN_RESPONSE'
        ]),
        difficulty: Object.freeze(['EASY', 'MEDIUM', 'HARD', 'OLYMPIAD']),
        status: Object.freeze(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
      }),
      booleanFields: Object.freeze([]),
      integerFields: Object.freeze([
        'latest_version_no',
        'used_in_attempts_count',
        'version'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    nextSchemas.QuestionVersions = Object.freeze({
      sheetName: 'QuestionVersions',
      primaryKey: 'question_version_id',
      idPrefix: 'qvr_',
      hasVersion: false,
      headers: Object.freeze([
        'question_version_id',
        'question_id',
        'version_no',
        'question_type',
        'title',
        'stem_richtext_json',
        'stimulus_id',
        'image_file_id',
        'image_alt_text',
        'image_caption',
        'accessible_design_flag',
        'default_points_bp',
        'negative_points_bp',
        'lock_option_order',
        'selection_instruction',
        'unit_label',
        'max_length_chars',
        'grading_mode',
        'grading_spec_private_json',
        'explanation_richtext_json',
        'reference_text',
        'admin_notes_private',
        'is_immutable',
        'created_by_user_id',
        'created_at_utc'
      ]),
      requiredFields: Object.freeze([
        'question_version_id',
        'question_id',
        'version_no',
        'question_type',
        'title',
        'stem_richtext_json',
        'accessible_design_flag',
        'default_points_bp',
        'grading_mode',
        'grading_spec_private_json',
        'created_at_utc'
      ]),
      enums: Object.freeze({
        question_type: Object.freeze([
          'SINGLE_CHOICE',
          'COMPLEX_MULTIPLE_CHOICE',
          'MULTIPLE_SELECT',
          'TRUE_FALSE',
          'NUMERIC_RESPONSE',
          'SHORT_ANSWER',
          'WRITTEN_RESPONSE'
        ]),
        accessible_design_flag: Object.freeze([
          'STANDARD_ALT',
          'VISUAL_INTERPRETATION_REQUIRED'
        ]),
        grading_mode: Object.freeze([
          'AUTO',
          'MANUAL',
          'AUTO_WITH_MANUAL_REVIEW'
        ])
      }),
      booleanFields: Object.freeze(['lock_option_order', 'is_immutable']),
      integerFields: Object.freeze([
        'version_no',
        'default_points_bp',
        'negative_points_bp',
        'max_length_chars'
      ]),
      positiveSatangFields: Object.freeze(['default_points_bp'])
    });

    nextSchemas.QuestionOptions = Object.freeze({
      sheetName: 'QuestionOptions',
      primaryKey: 'option_id',
      idPrefix: 'qop_',
      hasVersion: false,
      headers: Object.freeze([
        'option_id',
        'question_version_id',
        'question_id',
        'option_key',
        'content_richtext_json',
        'image_file_id',
        'image_alt_text',
        'sort_order',
        'pin_position',
        'is_correct_private',
        'created_at_utc'
      ]),
      requiredFields: Object.freeze([
        'option_id',
        'question_version_id',
        'question_id',
        'option_key',
        'content_richtext_json',
        'sort_order',
        'pin_position',
        'created_at_utc'
      ]),
      enums: Object.freeze({
        pin_position: Object.freeze(['NONE', 'LAST', 'FIXED'])
      }),
      booleanFields: Object.freeze(['is_correct_private']),
      integerFields: Object.freeze(['sort_order']),
      positiveSatangFields: Object.freeze([])
    });

    PB_SHEET_SCHEMAS_ = Object.freeze(nextSchemas);
  }
}

function ensureExamPhase2SheetsExist_() {
  ensureExamPhase2SchemasRegistered_();
  var ss = openConfiguredSpreadsheet_();
  var sheetNames = ['SharedStimuli', 'QuestionBank', 'QuestionVersions', 'QuestionOptions'];
  for (var i = 0; i < sheetNames.length; i++) {
    var sName = sheetNames[i];
    if (!ss.getSheetByName(sName) && PB_SHEET_SCHEMAS_[sName]) {
      ensureSingleSheetSchema_(ss, sName);
    }
  }
}

function formatPointsBpDisplayPhase2_(pointsBp) {
  var bp = Number(pointsBp) || 0;
  var pts = bp / 100;
  if (bp % 100 === 0) {
    return String(pts) + (pts === 1 ? ' pt' : ' pts');
  }
  return pts.toFixed(2).replace(/\.?0+$/, '') + ' pts';
}

function parsePointsToBpPhase2_(rawPoints, fieldKey, fieldLabel, allowZero, fieldErrors) {
  if (rawPoints === null || rawPoints === undefined || String(rawPoints).trim() === '') {
    fieldErrors[fieldKey] = fieldLabel + ' is required.';
    return 0;
  }
  var str = String(rawPoints).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(str)) {
    fieldErrors[fieldKey] =
      fieldLabel + ' must be a non-negative number with up to 2 decimal places.';
    return 0;
  }
  var num = Number(str);
  var bp = Math.round(num * 100);
  if (!allowZero && bp <= 0) {
    fieldErrors[fieldKey] = fieldLabel + ' must be greater than 0.';
    return 0;
  }
  if (bp > 100000) {
    fieldErrors[fieldKey] = fieldLabel + ' cannot exceed 1,000.00 points.';
    return 0;
  }
  return bp;
}

function normalizeTopicTagsPhase2_(rawTags) {
  var arr = [];
  if (Array.isArray(rawTags)) {
    arr = rawTags;
  } else if (typeof rawTags === 'string' && rawTags.trim()) {
    var trimmed = rawTags.trim();
    if (trimmed.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) arr = parsed;
      } catch (e) {
        arr = trimmed.split(',');
      }
    } else {
      arr = trimmed.split(',');
    }
  }
  var out = [];
  var seen = {};
  for (var i = 0; i < arr.length && out.length < 12; i++) {
    var tag = sanitizeSingleLineTextStep7_(arr[i], 48);
    if (!tag) continue;
    var lower = tag.toLowerCase();
    if (!seen[lower]) {
      seen[lower] = true;
      out.push(tag);
    }
  }
  return out;
}

/**
 * Validates that an image has a non-empty, non-spoiler alt text description,
 * or flags the item with VISUAL_INTERPRETATION_REQUIRED if an equivalent text
 * description would inherently reveal the answer.
 */
function validateNonSpoilerImageAltTextPhase2_(
  imageFileId,
  rawAltText,
  rawAccessibleFlag,
  spoilerStrings,
  fieldKeyPrefix,
  fieldLabel,
  fieldErrors
) {
  var flag = String(rawAccessibleFlag || 'STANDARD_ALT').trim().toUpperCase();
  if (flag !== 'STANDARD_ALT' && flag !== 'VISUAL_INTERPRETATION_REQUIRED') {
    flag = 'STANDARD_ALT';
  }
  var alt = sanitizeSingleLineTextStep7_(rawAltText, 300);
  if (!imageFileId) {
    return { altText: alt, accessibleDesignFlag: flag };
  }
  if (!alt || alt.length < 4) {
    fieldErrors[fieldKeyPrefix + 'AltText'] =
      fieldLabel +
      ' requires descriptive alternative text (4 to 300 characters) that does not reveal the answer.';
    return { altText: alt, accessibleDesignFlag: flag };
  }
  if (Array.isArray(spoilerStrings) && flag === 'STANDARD_ALT') {
    var lowerAlt = alt.toLowerCase();
    for (var i = 0; i < spoilerStrings.length; i++) {
      var sp = String(spoilerStrings[i] || '').trim().toLowerCase();
      if (sp.length >= 4 && lowerAlt.indexOf(sp) !== -1) {
        fieldErrors[fieldKeyPrefix + 'AltText'] =
          fieldLabel +
          ' alternative text appears to contain the answer key ("' +
          spoilerStrings[i] +
          '"). Rewrite the alt text so it describes the visual structure without revealing the answer, or set accessibleDesignFlag to VISUAL_INTERPRETATION_REQUIRED.';
        break;
      }
    }
  }
  return { altText: alt, accessibleDesignFlag: flag };
}

/**
 * Detects whether an option text depends on order (such as "All of the above",
 * "None of the above", "Both A and B") so option shuffling is automatically
 * pinned/disabled for that option.
 */
function isOrderDependentOptionTextPhase2_(plainText) {
  var s = String(plainText || '').trim().toLowerCase();
  if (!s) return false;
  return (
    /\b(all|none)\s+of\s+the\s+above\b/i.test(s) ||
    /\bboth\s+[a-d]\s+and\s+[a-d]\b/i.test(s)
  );
}

/**
 * Projects a SharedStimuli row into a student-safe DTO.
 */
function projectSharedStimulusDtoPhase2_(stimRow) {
  if (!stimRow) return null;
  var tags = [];
  try {
    tags = JSON.parse(stimRow.topic_tags_json || '[]');
  } catch (e) {
    tags = [];
  }
  var contentDoc = parseStoredRichTextJsonSafe_(stimRow.content_richtext_json);
  return {
    stimulusId: stimRow.stimulus_id,
    stimulusCode: stimRow.stimulus_code,
    title: stimRow.title,
    contentRichText: contentDoc,
    plainTextSummary: extractPlainTextFromRichTextDocPhase2_(contentDoc),
    imageFileId: stimRow.image_file_id || '',
    imageAltText: stimRow.image_alt_text || '',
    imageCaption: stimRow.image_caption || '',
    accessibleDesignFlag: stimRow.accessible_design_flag || 'STANDARD_ALT',
    topicTags: Array.isArray(tags) ? tags : [],
    status: stimRow.status || 'PUBLISHED',
    version: Number(stimRow.version || 1),
    updatedAtUtc: stimRow.updated_at_utc || '',
    updatedAtBangkok: formatBangkokTimestamp_(stimRow.updated_at_utc || '')
  };
}

function extractPlainTextFromRichTextDocPhase2_(doc) {
  if (!doc || !Array.isArray(doc.blocks)) return '';
  var parts = [];
  for (var i = 0; i < doc.blocks.length; i++) {
    var b = doc.blocks[i];
    if (!b) continue;
    if (b.type === 'paragraph' && Array.isArray(b.spans)) {
      var sTxt = '';
      for (var s = 0; s < b.spans.length; s++) {
        sTxt += b.spans[s] && b.spans[s].text ? b.spans[s].text : '';
      }
      if (sTxt.trim()) parts.push(sTxt.trim());
    } else if ((b.type === 'bullet_list' || b.type === 'ordered_list') && Array.isArray(b.items)) {
      for (var m = 0; m < b.items.length; m++) {
        var itSpans = b.items[m] && Array.isArray(b.items[m].spans) ? b.items[m].spans : [];
        var itTxt = '';
        for (var k = 0; k < itSpans.length; k++) {
          itTxt += itSpans[k] && itSpans[k].text ? itSpans[k].text : '';
        }
        if (itTxt.trim()) parts.push(itTxt.trim());
      }
    } else if (b.type === 'table') {
      if (b.caption) parts.push('[Table: ' + b.caption + ']');
    }
  }
  return parts.join(' ').trim();
}

/**
 * Projects a QuestionBank + QuestionVersions + QuestionOptions + SharedStimuli
 * bundle into a student-facing DTO that strictly omits private grading keys,
 * explanations, rubrics, and admin notes unless opt_includeAdminPrivateData is true.
 */
function parseQuestionImageFileIdsListPhase2_(rawVal) {
  var list = [];
  if (Array.isArray(rawVal)) {
    list = rawVal;
  } else if (typeof rawVal === 'string' && rawVal.trim().length > 0) {
    var trimmed = rawVal.trim();
    if (trimmed.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) list = parsed;
      } catch (e) {
        list = trimmed.split(',');
      }
    } else {
      list = trimmed.split(',');
    }
  }
  var out = [];
  var seen = {};
  for (var i = 0; i < list.length && out.length < 8; i++) {
    var item = String(list[i] || '').trim();
    if (item && !seen[item]) {
      seen[item] = true;
      out.push(item);
    }
  }
  return out;
}

function projectQuestionVersionDtoPhase2_(
  qBankRow,
  qVerRow,
  optionRows,
  stimulusRow,
  opt_includeAdminPrivateData
) {
  var includePrivate = opt_includeAdminPrivateData === true;
  var stemDoc = parseStoredRichTextJsonSafe_(qVerRow.stem_richtext_json);
  var tags = [];
  try {
    tags = JSON.parse(qBankRow.topic_tags_json || '[]');
  } catch (e) {
    tags = [];
  }

  var sortedOptions = (Array.isArray(optionRows) ? optionRows.slice() : []).sort(function (a, b) {
    return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
  });

  var projectedOptions = [];
  for (var i = 0; i < sortedOptions.length; i++) {
    var op = sortedOptions[i];
    var opDoc = parseStoredRichTextJsonSafe_(op.content_richtext_json);
    var opDto = {
      optionId: op.option_id,
      optionKey: op.option_key,
      contentRichText: opDoc,
      plainText: extractPlainTextFromRichTextDocPhase2_(opDoc),
      imageFileId: op.image_file_id || '',
      imageAltText: op.image_alt_text || '',
      sortOrder: Number(op.sort_order) || (i + 1) * 10,
      pinPosition: op.pin_position || 'NONE'
    };
    if (includePrivate) {
      opDto.isCorrect = Boolean(op.is_correct_private);
    }
    projectedOptions.push(opDto);
  }

  var dto = {
    questionId: qBankRow.question_id,
    questionCode: qBankRow.question_code,
    questionVersionId: qVerRow.question_version_id,
    versionNo: Number(qVerRow.version_no) || 1,
    latestVersionNo: Number(qBankRow.latest_version_no) || 1,
    title: qVerRow.title || qBankRow.title,
    questionType: qVerRow.question_type,
    difficulty: qBankRow.difficulty || 'MEDIUM',
    topicTags: Array.isArray(tags) ? tags : [],
    status: qBankRow.status || 'DRAFT',
    usedInAttemptsCount: Number(qBankRow.used_in_attempts_count) || 0,
    stemRichText: stemDoc,
    stemPlainText: extractPlainTextFromRichTextDocPhase2_(stemDoc),
    stimulusId: qVerRow.stimulus_id || '',
    stimulus: stimulusRow
      ? (stimulusRow.stimulusId ? stimulusRow : projectSharedStimulusDtoPhase2_(stimulusRow))
      : null,
    imageFileIds: parseQuestionImageFileIdsListPhase2_(qVerRow.image_file_id),
    imageFileId: parseQuestionImageFileIdsListPhase2_(qVerRow.image_file_id)[0] || '',
    imageAltText: qVerRow.image_alt_text || '',
    imageCaption: qVerRow.image_caption || '',
    accessibleDesignFlag: qVerRow.accessible_design_flag || 'STANDARD_ALT',
    defaultPointsBp: Number(qVerRow.default_points_bp) || 100,
    defaultPointsDisplay: formatPointsBpDisplayPhase2_(qVerRow.default_points_bp || 100),
    negativePointsBp: Number(qVerRow.negative_points_bp) || 0,
    negativePointsDisplay: formatPointsBpDisplayPhase2_(qVerRow.negative_points_bp || 0),
    lockOptionOrder: Boolean(qVerRow.lock_option_order),
    selectionInstruction: qVerRow.selection_instruction || '',
    unitLabel: qVerRow.unit_label || '',
    maxLengthChars: Number(qVerRow.max_length_chars) || 0,
    gradingMode: qVerRow.grading_mode || 'AUTO',
    options: projectedOptions,
    createdAtUtc: qVerRow.created_at_utc || '',
    updatedAtUtc: qBankRow.updated_at_utc || qVerRow.created_at_utc || '',
    updatedAtBangkok: formatBangkokTimestamp_(qBankRow.updated_at_utc || qVerRow.created_at_utc || ''),
    version: Number(qBankRow.version) || 1
  };

  if (includePrivate) {
    var parsedGradingSpec = {};
    try {
      parsedGradingSpec = JSON.parse(qVerRow.grading_spec_private_json || '{}');
    } catch (e) {
      parsedGradingSpec = {};
    }
    var expDoc = parseStoredRichTextJsonSafe_(qVerRow.explanation_richtext_json);
    dto.privateGradingData = {
      gradingSpec: parsedGradingSpec,
      explanationRichText: expDoc,
      explanationPlainText: extractPlainTextFromRichTextDocPhase2_(expDoc),
      referenceText: qVerRow.reference_text || '',
      adminNotes: qVerRow.admin_notes_private || ''
    };
  }

  return dto;
}

/**
 * Lists all SharedStimuli records for the Administrator Question Bank.
 */
function handleAdminListStimuliPhase2_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase2SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var filterStatus = String(req.status || 'ALL').trim().toUpperCase();
  var searchQ = sanitizeSingleLineTextStep7_(req.search, 120).toLowerCase();

  var stimTbl = readSheetTable_('SharedStimuli');
  var items = [];
  for (var i = stimTbl.records.length - 1; i >= 0; i--) {
    var row = stimTbl.records[i];
    if (filterStatus !== 'ALL' && row.status !== filterStatus) continue;
    var dto = projectSharedStimulusDtoPhase2_(row);
    if (searchQ) {
      var hay = (
        dto.stimulusCode +
        ' ' +
        dto.title +
        ' ' +
        dto.plainTextSummary +
        ' ' +
        dto.topicTags.join(' ')
      ).toLowerCase();
      if (hay.indexOf(searchQ) === -1) continue;
    }
    items.push(dto);
  }

  return {
    stimuli: items,
    totalCount: items.length
  };
}

/**
 * Creates or updates a SharedStimuli record (admin.stimuli.save).
 */
function handleAdminSaveStimulusPhase2_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase2SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var fieldErrors = {};

  var stimulusId = sanitizeSingleLineTextStep7_(req.stimulusId, 64);
  var isCreate = !stimulusId;
  var stimulusCode = sanitizeSingleLineTextStep7_(req.stimulusCode, 48).toUpperCase();
  if (!stimulusCode || !/^[A-Z0-9][A-Z0-9_-]{2,47}$/.test(stimulusCode)) {
    fieldErrors.stimulusCode =
      'Stimulus code is required (3-48 uppercase letters, digits, hyphens, or underscores, e.g. STIM-BIO-OSMOSIS-01).';
  }

  var title = sanitizeSingleLineTextStep7_(req.title, 180);
  if (!title || title.length < 3) {
    fieldErrors.title = 'Stimulus title is required (3 to 180 characters).';
  }

  var status = String(req.status || 'PUBLISHED').trim().toUpperCase();
  if (!PB_EXAM_ITEM_STATUSES_PHASE2_[status]) {
    fieldErrors.status = 'Status must be DRAFT, PUBLISHED, or ARCHIVED.';
  }

  var contentValidated = null;
  try {
    contentValidated = validateAndNormalizeRichTextInput_(
      req.contentRichText,
      'contentRichText',
      'Shared stimulus passage / table content',
      true
    );
  } catch (rtErr) {
    if (rtErr && rtErr.fieldErrors) {
      Object.assign(fieldErrors, rtErr.fieldErrors);
    } else {
      fieldErrors.contentRichText = String(rtErr.message || rtErr);
    }
  }

  var imageFileId = validateOptionalDriveFileRefStep7_(
    req.imageFileId,
    'imageFileId',
    'Stimulus diagram file ID',
    fieldErrors,
    ['STIMULUS_IMAGE', 'QUESTION_IMAGE', 'RICHTEXT_IMAGE', 'CARD_IMAGE', 'COURSE_IMAGE']
  );

  var altValidated = validateNonSpoilerImageAltTextPhase2_(
    imageFileId,
    req.imageAltText,
    req.accessibleDesignFlag,
    [],
    'image',
    'Stimulus diagram',
    fieldErrors
  );
  var imageCaption = sanitizeSingleLineTextStep7_(req.imageCaption, 240);
  var topicTags = normalizeTopicTagsPhase2_(req.topicTags);

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please fix the highlighted shared stimulus fields.',
      fieldErrors
    );
  }

  var savedRow = null;
  withScriptLock_(function () {
    var stimTbl = readSheetTable_('SharedStimuli');
    var nowIso = nowUtcIso_();

    for (var i = 0; i < stimTbl.records.length; i++) {
      var r = stimTbl.records[i];
      if (
        String(r.stimulus_code || '').toUpperCase() === stimulusCode &&
        r.stimulus_id !== stimulusId
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Stimulus code "' + stimulusCode + '" is already in use by another shared stimulus.',
          { stimulusCode: 'Stimulus code must be unique.' }
        );
      }
    }

    if (isCreate) {
      var newId = generateEntityId_('stim_');
      savedRow = insertSheetRecord_(
        'SharedStimuli',
        {
          stimulus_id: newId,
          stimulus_code: stimulusCode,
          title: title,
          content_richtext_json: contentValidated.json,
          image_file_id: imageFileId,
          image_alt_text: altValidated.altText,
          image_caption: imageCaption,
          accessible_design_flag: altValidated.accessibleDesignFlag,
          topic_tags_json: JSON.stringify(topicTags),
          status: status,
          created_by_user_id: adminUser.user_id,
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_SHARED_STIMULUS_CREATED',
        targetEntityType: 'SharedStimulus',
        targetEntityId: newId,
        summary: { stimulusCode: stimulusCode, title: title, status: status }
      });
    } else {
      var existingHit = stimTbl.byId[stimulusId];
      if (!existingHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Shared stimulus "' + stimulusId + '" was not found.'
        );
      }
      var expectedVersion =
        req.expectedVersion !== undefined && req.expectedVersion !== null && req.expectedVersion !== ''
          ? Number(req.expectedVersion)
          : Number(existingHit.record.version);
      savedRow = updateSheetRecordById_(
        'SharedStimuli',
        stimulusId,
        {
          stimulus_code: stimulusCode,
          title: title,
          content_richtext_json: contentValidated.json,
          image_file_id: imageFileId,
          image_alt_text: altValidated.altText,
          image_caption: imageCaption,
          accessible_design_flag: altValidated.accessibleDesignFlag,
          topic_tags_json: JSON.stringify(topicTags),
          status: status,
          updated_at_utc: nowIso
        },
        expectedVersion,
        { skipLock: true }
      );
      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_SHARED_STIMULUS_UPDATED',
        targetEntityType: 'SharedStimulus',
        targetEntityId: stimulusId,
        summary: { stimulusCode: stimulusCode, title: title, status: status, version: savedRow.version }
      });
    }
  });

  var updatedList = handleAdminListStimuliPhase2_({}, context);
  return {
    stimulus: projectSharedStimulusDtoPhase2_(savedRow),
    stimuli: updatedList.stimuli
  };
}

/**
 * Validates and constructs the private grading specification and normalized options
 * for all 6 question types in Phase 2.
 */
function validateAndBuildQuestionGradingSpecPhase2_(
  questionType,
  req,
  defaultPointsBp,
  fieldErrors
) {
  var rawOptions = Array.isArray(req.options) ? req.options : [];
  var normalizedOptions = [];
  var spoilerStrings = [];
  var lockOptionOrder = Boolean(req.lockOptionOrder);
  var selectionInstruction = sanitizeSingleLineTextStep7_(req.selectionInstruction, 240);
  var unitLabel = sanitizeSingleLineTextStep7_(req.unitLabel, 64);
  var maxLengthChars = 0;
  var gradingMode = 'AUTO';
  var gradingSpec = {
    questionType: questionType
  };

  if (
    questionType === 'SINGLE_CHOICE' ||
    questionType === 'COMPLEX_MULTIPLE_CHOICE' ||
    questionType === 'MULTIPLE_SELECT' ||
    questionType === 'TRUE_FALSE'
  ) {
    var minOpts =
      questionType === 'TRUE_FALSE'
        ? 2
        : questionType === 'COMPLEX_MULTIPLE_CHOICE' || questionType === 'MULTIPLE_SELECT'
        ? 3
        : 2;
    var maxOpts =
      questionType === 'TRUE_FALSE'
        ? 2
        : questionType === 'COMPLEX_MULTIPLE_CHOICE'
        ? 5
        : 10;

    if (questionType === 'TRUE_FALSE' && rawOptions.length === 0) {
      var tfCorrect = String(req.trueFalseCorrect || 'TRUE').trim().toUpperCase();
      rawOptions = [
        { optionKey: 'TRUE', contentRichText: 'True', isCorrect: tfCorrect === 'TRUE', pinPosition: 'FIXED' },
        { optionKey: 'FALSE', contentRichText: 'False', isCorrect: tfCorrect === 'FALSE', pinPosition: 'FIXED' }
      ];
    }

    if (rawOptions.length < minOpts || rawOptions.length > maxOpts) {
      fieldErrors.options =
        questionType +
        ' requires between ' +
        minOpts +
        ' and ' +
        maxOpts +
        ' answer options.';
    }

    var correctOptionIds = [];
    var hasOrderDependentOption = false;

    for (var i = 0; i < rawOptions.length && i < maxOpts; i++) {
      var ro = rawOptions[i] && typeof rawOptions[i] === 'object' ? rawOptions[i] : {};
      var optId =
        ro.optionId && /^qop_[A-Za-z0-9_-]{4,64}$/.test(String(ro.optionId).trim())
          ? String(ro.optionId).trim()
          : generateEntityId_('qop_');
      var optKey =
        questionType === 'TRUE_FALSE'
          ? i === 0
            ? 'TRUE'
            : 'FALSE'
          : questionType === 'COMPLEX_MULTIPLE_CHOICE'
          ? 'S' + (i + 1)
          : String.fromCharCode(65 + i);

      var optContentValidated = null;
      try {
        optContentValidated = validateAndNormalizeRichTextInput_(
          ro.contentRichText !== undefined ? ro.contentRichText : ro.text,
          'option_' + i,
          'Option ' + optKey,
          !ro.imageFileId
        );
      } catch (optErr) {
        fieldErrors.options = 'Option ' + optKey + ': text or image is required.';
        optContentValidated = {
          json: plainTextToRichTextJson_(''),
          plainTextSummary: ''
        };
      }

      var optImageId = validateOptionalDriveFileRefStep7_(
        ro.imageFileId,
        'optionImage_' + i,
        'Option ' + optKey + ' image',
        fieldErrors,
        ['OPTION_IMAGE', 'QUESTION_IMAGE', 'RICHTEXT_IMAGE', 'CARD_IMAGE', 'COURSE_IMAGE']
      );
      var optAltCheck = validateNonSpoilerImageAltTextPhase2_(
        optImageId,
        ro.imageAltText,
        'STANDARD_ALT',
        [],
        'option_' + i + '_image',
        'Option ' + optKey + ' image',
        fieldErrors
      );

      var pinPos = String(ro.pinPosition || 'NONE').trim().toUpperCase();
      if (pinPos !== 'NONE' && pinPos !== 'LAST' && pinPos !== 'FIXED') {
        pinPos = 'NONE';
      }
      if (isOrderDependentOptionTextPhase2_(optContentValidated.plainTextSummary)) {
        hasOrderDependentOption = true;
        if (pinPos === 'NONE') {
          pinPos = i === rawOptions.length - 1 ? 'LAST' : 'FIXED';
        }
      }
      if (questionType === 'TRUE_FALSE' || questionType === 'COMPLEX_MULTIPLE_CHOICE') {
        pinPos = 'FIXED';
        lockOptionOrder = true;
      }

      var isCorrect = Boolean(ro.isCorrect);
      if (isCorrect) {
        correctOptionIds.push(optId);
        if (optContentValidated.plainTextSummary) {
          spoilerStrings.push(optContentValidated.plainTextSummary);
        }
      }
      if (!gradingSpec.statementTruthMap) {
        gradingSpec.statementTruthMap = {};
      }
      gradingSpec.statementTruthMap[optId] = isCorrect;

      normalizedOptions.push({
        option_id: optId,
        option_key: optKey,
        content_richtext_json: optContentValidated.json,
        image_file_id: optImageId,
        image_alt_text: optAltCheck.altText,
        sort_order: (i + 1) * 10,
        pin_position: pinPos,
        is_correct_private: isCorrect
      });
    }

    if (hasOrderDependentOption && rawOptions.some(function (o, idx) {
      return idx < rawOptions.length - 1 && isOrderDependentOptionTextPhase2_(o.text || o.contentRichText);
    })) {
      lockOptionOrder = true;
    }

    if (questionType === 'SINGLE_CHOICE' || questionType === 'TRUE_FALSE') {
      if (correctOptionIds.length !== 1) {
        fieldErrors.correctOptions =
          questionType + ' requires exactly 1 correct option (found ' + correctOptionIds.length + ').';
      }
      if (!selectionInstruction) {
        selectionInstruction = 'Select the single best answer.';
      }
      gradingSpec.correctOptionIds = correctOptionIds;
      gradingSpec.scoringRule = 'EXACT_MATCH';
    } else if (questionType === 'COMPLEX_MULTIPLE_CHOICE') {
      if (!selectionInstruction) {
        selectionInstruction =
          'Complex Multiple Choice: Evaluate each sub-statement and select "Yes" or "No" (3/3 correct = 100%, 2/3 correct = 50%, 0–1/3 correct = 0%).';
      }
      gradingSpec.correctOptionIds = correctOptionIds;
      gradingSpec.scoringRule = 'TCAS_COMPLEX_3_TIER';
    } else if (questionType === 'MULTIPLE_SELECT') {
      if (correctOptionIds.length < 1) {
        fieldErrors.correctOptions =
          'MULTIPLE_SELECT requires at least 1 correct option.';
      }
      var multiRule = String(req.multiSelectScoringRule || 'EXACT_MATCH')
        .trim()
        .toUpperCase();
      if (multiRule !== 'EXACT_MATCH' && multiRule !== 'PARTIAL_WITHOUT_OVERSELECT') {
        fieldErrors.multiSelectScoringRule =
          'Multiple-select scoring rule must be EXACT_MATCH (all-or-nothing) or PARTIAL_WITHOUT_OVERSELECT.';
      }
      if (!selectionInstruction) {
        selectionInstruction =
          multiRule === 'PARTIAL_WITHOUT_OVERSELECT'
            ? 'Select all correct options. Partial credit is awarded per correct selection when no incorrect option is selected.'
            : 'Select all correct options (all-or-nothing exact match).';
      }
      gradingSpec.correctOptionIds = correctOptionIds;
      gradingSpec.scoringRule = multiRule;
    }
  } else if (questionType === 'NUMERIC_RESPONSE') {
    var numSpec = req.numericSpec && typeof req.numericSpec === 'object' ? req.numericSpec : req;
    var matchMode = String(numSpec.matchMode || 'EXACT_WITH_TOLERANCE').trim().toUpperCase();
    if (matchMode === 'RANGE') matchMode = 'ACCEPTABLE_RANGE';
    if (matchMode !== 'EXACT_WITH_TOLERANCE' && matchMode !== 'ACCEPTABLE_RANGE') {
      fieldErrors.numericMatchMode =
        'Numeric matchMode must be EXACT_WITH_TOLERANCE or ACCEPTABLE_RANGE.';
    }

    var strictNumRegex = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
    var roundingDecimals = null;
    if (
      numSpec.roundingDecimals !== undefined &&
      numSpec.roundingDecimals !== null &&
      String(numSpec.roundingDecimals).trim() !== ''
    ) {
      var rd = Number(numSpec.roundingDecimals);
      if (!Number.isInteger(rd) || rd < 0 || rd > 6) {
        fieldErrors.roundingDecimals =
          'Rounding decimal places must be an integer between 0 and 6 (or blank for unrounded comparison).';
      } else {
        roundingDecimals = rd;
      }
    }

    if (matchMode === 'EXACT_WITH_TOLERANCE') {
      var rawTarget = String(numSpec.targetValue !== undefined ? numSpec.targetValue : '').trim();
      if (!rawTarget || !strictNumRegex.test(rawTarget) || !isFinite(Number(rawTarget))) {
        fieldErrors.targetValue =
          'Numeric target value must be a valid finite number (expressions and eval are prohibited).';
      }
      var tolType = String(numSpec.toleranceType || 'NONE').trim().toUpperCase();
      if (tolType === 'PERCENTAGE') tolType = 'RELATIVE_PERCENT';
      if (tolType !== 'NONE' && tolType !== 'ABSOLUTE' && tolType !== 'RELATIVE_PERCENT') {
        fieldErrors.toleranceType =
          'Tolerance type must be NONE, ABSOLUTE, or RELATIVE_PERCENT.';
      }
      var tolVal = 0;
      if (tolType !== 'NONE') {
        var rawTol = String(numSpec.toleranceValue !== undefined ? numSpec.toleranceValue : '0').trim();
        if (!strictNumRegex.test(rawTol) || Number(rawTol) < 0) {
          fieldErrors.toleranceValue = 'Tolerance value must be a non-negative number.';
        } else {
          tolVal = Number(rawTol);
        }
      }
      gradingSpec.matchMode = 'EXACT_WITH_TOLERANCE';
      gradingSpec.targetValue = Number(rawTarget);
      gradingSpec.toleranceType = tolType;
      gradingSpec.toleranceValue = tolVal;
      gradingSpec.roundingDecimals = roundingDecimals;
      gradingSpec.roundingRule = 'HALF_AWAY_FROM_ZERO';
      spoilerStrings.push(rawTarget);
    } else {
      var rawMin = String(numSpec.rangeMin !== undefined ? numSpec.rangeMin : '').trim();
      var rawMax = String(numSpec.rangeMax !== undefined ? numSpec.rangeMax : '').trim();
      if (!rawMin || !strictNumRegex.test(rawMin) || !rawMax || !strictNumRegex.test(rawMax)) {
        fieldErrors.numericRange = 'Both rangeMin and rangeMax must be valid finite numbers.';
      } else if (Number(rawMin) > Number(rawMax)) {
        fieldErrors.numericRange = 'rangeMin cannot be greater than rangeMax.';
      }
      gradingSpec.matchMode = 'ACCEPTABLE_RANGE';
      gradingSpec.rangeMin = Number(rawMin);
      gradingSpec.rangeMax = Number(rawMax);
      gradingSpec.inclusiveBounds = true;
      gradingSpec.roundingDecimals = roundingDecimals;
      gradingSpec.roundingRule = 'HALF_AWAY_FROM_ZERO';
    }

    if (!selectionInstruction) {
      selectionInstruction =
        'Enter a numeric value' +
        (unitLabel ? ' in ' + unitLabel : '') +
        (roundingDecimals !== null
          ? ' (rounded to ' + roundingDecimals + ' decimal place(s))'
          : '') +
        '.';
    }
  } else if (questionType === 'SHORT_ANSWER') {
    var saMode = String(req.gradingMode || 'MANUAL').trim().toUpperCase();
    if (saMode === 'NORMALIZED_AUTO_MATCH') saMode = 'AUTO_WITH_MANUAL_REVIEW';
    if (saMode !== 'MANUAL' && saMode !== 'AUTO' && saMode !== 'AUTO_WITH_MANUAL_REVIEW') {
      saMode = 'MANUAL';
    }
    gradingMode = saMode;
    maxLengthChars = Math.min(Math.max(Number(req.maxLengthChars) || 300, 20), 1000);

    var rawAccepted = req.acceptedAnswers;
    var acceptedList = [];
    if (Array.isArray(rawAccepted)) {
      acceptedList = rawAccepted;
    } else if (typeof rawAccepted === 'string' && rawAccepted.trim()) {
      acceptedList = rawAccepted.split(/\r?\n|\|/);
    }
    var cleanAccepted = [];
    for (var aIdx = 0; aIdx < acceptedList.length && cleanAccepted.length < 20; aIdx++) {
      var ansStr = sanitizeSingleLineTextStep7_(acceptedList[aIdx], 240);
      if (ansStr) {
        cleanAccepted.push(ansStr);
        spoilerStrings.push(ansStr);
      }
    }
    if ((saMode === 'AUTO' || saMode === 'AUTO_WITH_MANUAL_REVIEW') && cleanAccepted.length === 0) {
      fieldErrors.acceptedAnswers =
        'At least one approved exact/normalized answer is required when Short Answer automatic matching is enabled.';
    }
    gradingSpec.acceptedAnswers = cleanAccepted;
    gradingSpec.caseSensitive = Boolean(req.caseSensitive);
    gradingSpec.collapseWhitespace = req.collapseWhitespace !== false;
    gradingSpec.trimPunctuation = req.trimPunctuation !== false;
    gradingSpec.matchingDisclosure =
      'Deterministic string normalization only (no semantic AI or fuzzy matching).';
    gradingSpec.rubricNotes = sanitizeSingleLineTextStep7_(req.rubricNotes, 1000);
    if (!selectionInstruction) {
      selectionInstruction =
        'Enter a concise biological term or short phrase (maximum ' +
        maxLengthChars +
        ' characters).';
    }
  } else if (questionType === 'WRITTEN_RESPONSE') {
    gradingMode = 'MANUAL';
    maxLengthChars = Math.min(Math.max(Number(req.maxLengthChars) || 2500, 100), 10000);
    var rawCriteria = Array.isArray(req.rubricCriteria) ? req.rubricCriteria : [];
    var cleanCriteria = [];
    var criteriaSumBp = 0;
    for (var cIdx = 0; cIdx < rawCriteria.length && cleanCriteria.length < 10; cIdx++) {
      var rc = rawCriteria[cIdx] && typeof rawCriteria[cIdx] === 'object' ? rawCriteria[cIdx] : {};
      var cTitle = sanitizeSingleLineTextStep7_(rc.title, 140);
      if (!cTitle) continue;
      var cBp = Math.max(0, Math.round((Number(rc.maxPoints !== undefined ? rc.maxPoints : (rc.maxPointsBp / 100)) || 0) * 100));
      criteriaSumBp += cBp;
      cleanCriteria.push({
        criterionId: rc.criterionId || ('crit_' + (cIdx + 1)),
        title: cTitle,
        maxPointsBp: cBp,
        description: sanitizeSingleLineTextStep7_(rc.description, 400)
      });
    }
    if (cleanCriteria.length === 0) {
      cleanCriteria.push({
        criterionId: 'crit_1',
        title: 'Biological Accuracy, Reasoning & Terminology',
        maxPointsBp: defaultPointsBp,
        description: 'Demonstrates accurate conceptual understanding, mechanism sequence, and precise biological terminology.'
      });
      criteriaSumBp = defaultPointsBp;
    }
    gradingSpec.rubricCriteria = cleanCriteria;
    gradingSpec.rubricTotalBp = criteriaSumBp;
    gradingSpec.sampleModelAnswer = sanitizeSingleLineTextStep7_(req.sampleModelAnswer, 2000);
    if (!selectionInstruction) {
      selectionInstruction =
        'Write a clear, structured biological explanation (maximum ' +
        maxLengthChars +
        ' characters). Graded manually by your instructor using the question rubric.';
    }
  }

  return {
    normalizedOptions: normalizedOptions,
    lockOptionOrder: lockOptionOrder,
    selectionInstruction: selectionInstruction,
    unitLabel: unitLabel,
    maxLengthChars: maxLengthChars,
    gradingMode: gradingMode,
    gradingSpec: gradingSpec,
    spoilerStrings: spoilerStrings
  };
}

/**
 * Lists QuestionBank items with search, topic, questionType, difficulty,
 * status filters, and bounded pagination (admin.questions.list).
 */
function handleAdminListQuestionsPhase2_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase2SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var searchQ = sanitizeSingleLineTextStep7_(req.search, 120).toLowerCase();
  var filterTopic = sanitizeSingleLineTextStep7_(req.topic, 60).toLowerCase();
  var filterType = String(req.questionType || 'ALL').trim().toUpperCase();
  var filterDiff = String(req.difficulty || 'ALL').trim().toUpperCase();
  var filterStatus = String(req.status || 'ALL').trim().toUpperCase();
  var page = Math.max(1, parseInt(req.page, 10) || 1);
  var limit = Math.min(Math.max(parseInt(req.limit, 10) || 20, 1), 100);
  var includePrivate = req.includePrivate !== false;

  var qbTbl = readSheetTable_('QuestionBank');
  var qvTbl = readSheetTable_('QuestionVersions');
  var qoTbl = readSheetTable_('QuestionOptions');
  var stimTbl = readSheetTable_('SharedStimuli');

  var optionsByVerId = {};
  for (var oi = 0; oi < qoTbl.records.length; oi++) {
    var opRow = qoTbl.records[oi];
    var vId = opRow.question_version_id;
    if (!optionsByVerId[vId]) optionsByVerId[vId] = [];
    optionsByVerId[vId].push(opRow);
  }

  var stimuliList = [];
  var projectedStimuliById = {};
  for (var si = stimTbl.records.length - 1; si >= 0; si--) {
    var stDto = projectSharedStimulusDtoPhase2_(stimTbl.records[si]);
    stimuliList.push(stDto);
    projectedStimuliById[stDto.stimulusId] = stDto;
  }

  var allTopicsMap = {};
  var matchedCandidates = [];
  var countsByType = {
    SINGLE_CHOICE: 0,
    COMPLEX_MULTIPLE_CHOICE: 0,
    MULTIPLE_SELECT: 0,
    TRUE_FALSE: 0,
    NUMERIC_RESPONSE: 0,
    SHORT_ANSWER: 0,
    WRITTEN_RESPONSE: 0
  };
  var countsByStatus = {
    DRAFT: 0,
    PUBLISHED: 0,
    ARCHIVED: 0
  };

  for (var i = qbTbl.records.length - 1; i >= 0; i--) {
    var qb = qbTbl.records[i];
    var activeVerHit = qvTbl.byId[qb.active_version_id];
    if (!activeVerHit) continue;
    var qv = activeVerHit.record;

    if (countsByType[qb.question_type] !== undefined) {
      countsByType[qb.question_type] += 1;
    }
    if (countsByStatus[qb.status] !== undefined) {
      countsByStatus[qb.status] += 1;
    }

    var qTags = [];
    try {
      qTags = JSON.parse(qb.topic_tags_json || '[]');
    } catch (e) {
      qTags = [];
    }
    for (var ti = 0; ti < qTags.length; ti++) {
      if (qTags[ti]) allTopicsMap[qTags[ti]] = true;
    }

    if (filterType !== 'ALL' && qb.question_type !== filterType) continue;
    if (filterDiff !== 'ALL' && qb.difficulty !== filterDiff) continue;
    if (filterStatus !== 'ALL' && qb.status !== filterStatus) continue;
    if (filterTopic && filterTopic !== 'all') {
      var hasTopic = false;
      for (var tk = 0; tk < qTags.length; tk++) {
        if (String(qTags[tk]).toLowerCase() === filterTopic) {
          hasTopic = true;
          break;
        }
      }
      if (!hasTopic) continue;
    }

    if (searchQ) {
      var rawHay = (
        String(qb.question_code || '') +
        ' ' +
        String(qv.title || qb.title || '') +
        ' ' +
        String(qv.stem_richtext_json || '') +
        ' ' +
        qTags.join(' ')
      ).toLowerCase();
      if (rawHay.indexOf(searchQ) === -1) continue;
    }

    matchedCandidates.push({ qb: qb, qv: qv });
  }

  var totalFiltered = matchedCandidates.length;
  var totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
  if (page > totalPages) page = totalPages;
  var startIdx = (page - 1) * limit;
  var pageSlice = matchedCandidates.slice(startIdx, startIdx + limit);
  var pageItems = [];
  for (var pi = 0; pi < pageSlice.length; pi++) {
    var cand = pageSlice[pi];
    var stimDto =
      cand.qv.stimulus_id && projectedStimuliById[cand.qv.stimulus_id]
        ? projectedStimuliById[cand.qv.stimulus_id]
        : null;
    pageItems.push(
      projectQuestionVersionDtoPhase2_(
        cand.qb,
        cand.qv,
        optionsByVerId[cand.qv.question_version_id] || [],
        stimDto,
        includePrivate
      )
    );
  }

  return {
    questions: pageItems,
    pagination: {
      page: page,
      limit: limit,
      totalFiltered: totalFiltered,
      totalPages: totalPages,
      hasPrevPage: page > 1,
      hasNextPage: page < totalPages
    },
    summary: {
      totalQuestionsInBank: qbTbl.records.length,
      countsByType: countsByType,
      countsByStatus: countsByStatus,
      availableTopics: Object.keys(allTopicsMap).sort()
    },
    stimuli: stimuliList
  };
}

/**
 * Creates a new QuestionBank item (version 1) or edits an existing QuestionBank item
 * by creating a new immutable QuestionVersion (version N+1) while preserving all
 * historical versions (admin.questions.save).
 */
function handleAdminSaveQuestionPhase2_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase2SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var fieldErrors = {};

  var questionId = sanitizeSingleLineTextStep7_(req.questionId, 64);
  var isCreate = !questionId;

  var questionCode = sanitizeSingleLineTextStep7_(req.questionCode, 48).toUpperCase();
  if (!questionCode || !/^[A-Z0-9][A-Z0-9_.-]{2,47}$/.test(questionCode)) {
    fieldErrors.questionCode =
      'Question code is required (3-48 uppercase letters, digits, dots, hyphens, or underscores, e.g. BIO-CELL-ATP-01).';
  }

  var title = sanitizeSingleLineTextStep7_(req.title, 180);
  if (!title || title.length < 3) {
    fieldErrors.title = 'Question title is required (3 to 180 characters).';
  }

  var questionType = String(req.questionType || 'SINGLE_CHOICE').trim().toUpperCase();
  if (!PB_EXAM_QUESTION_TYPES_PHASE2_[questionType]) {
    fieldErrors.questionType =
      'Question type must be SINGLE_CHOICE, COMPLEX_MULTIPLE_CHOICE, MULTIPLE_SELECT, TRUE_FALSE, NUMERIC_RESPONSE, SHORT_ANSWER, or WRITTEN_RESPONSE.';
  }

  var difficulty = String(req.difficulty || 'MEDIUM').trim().toUpperCase();
  if (!PB_EXAM_DIFFICULTIES_PHASE2_[difficulty]) {
    fieldErrors.difficulty = 'Difficulty must be EASY, MEDIUM, HARD, or OLYMPIAD.';
  }

  var status = String(req.status || 'PUBLISHED').trim().toUpperCase();
  if (!PB_EXAM_ITEM_STATUSES_PHASE2_[status]) {
    fieldErrors.status = 'Status must be DRAFT, PUBLISHED, or ARCHIVED.';
  }

  var defaultPointsBp = parsePointsToBpPhase2_(
    req.defaultPoints !== undefined ? req.defaultPoints : 1,
    'defaultPoints',
    'Question points',
    false,
    fieldErrors
  );
  var negativePointsBp = parsePointsToBpPhase2_(
    req.negativePoints !== undefined && req.negativePoints !== '' ? req.negativePoints : 0,
    'negativePoints',
    'Negative marking penalty points',
    true,
    fieldErrors
  );

  var stemValidated = null;
  try {
    stemValidated = validateAndNormalizeRichTextInput_(
      req.stemRichText,
      'stemRichText',
      'Question stem',
      true
    );
  } catch (stemErr) {
    if (stemErr && stemErr.fieldErrors) {
      Object.assign(fieldErrors, stemErr.fieldErrors);
    } else {
      fieldErrors.stemRichText = String(stemErr.message || stemErr);
    }
  }

  var explanationValidated = null;
  try {
    explanationValidated = validateAndNormalizeRichTextInput_(
      req.explanationRichText,
      'explanationRichText',
      'Question explanation',
      false
    );
  } catch (expErr) {
    if (expErr && expErr.fieldErrors) {
      Object.assign(fieldErrors, expErr.fieldErrors);
    } else {
      fieldErrors.explanationRichText = String(expErr.message || expErr);
    }
  }

  var specBundle = validateAndBuildQuestionGradingSpecPhase2_(
    questionType,
    req,
    defaultPointsBp || 100,
    fieldErrors
  );

  var candidateImageIds = parseQuestionImageFileIdsListPhase2_(
    Array.isArray(req.imageFileIds) && req.imageFileIds.length > 0
      ? req.imageFileIds
      : req.imageFileId
  );
  var validatedImageIds = [];
  for (var imgIdx = 0; imgIdx < candidateImageIds.length; imgIdx++) {
    var vFid = validateOptionalDriveFileRefStep7_(
      candidateImageIds[imgIdx],
      'imageFileId',
      'Question diagram file ID #' + (imgIdx + 1),
      fieldErrors,
      ['QUESTION_IMAGE', 'RICHTEXT_IMAGE', 'CARD_IMAGE', 'COURSE_IMAGE']
    );
    if (vFid) validatedImageIds.push(vFid);
  }
  var imageFileId = validatedImageIds.join(',');

  var altCheck = validateNonSpoilerImageAltTextPhase2_(
    validatedImageIds[0] || '',
    req.imageAltText,
    req.accessibleDesignFlag,
    specBundle.spoilerStrings,
    'image',
    'Question diagram',
    fieldErrors
  );
  var imageCaption = sanitizeSingleLineTextStep7_(req.imageCaption, 240);
  var stimulusId = sanitizeSingleLineTextStep7_(req.stimulusId, 64);
  var referenceText = sanitizeSingleLineTextStep7_(req.referenceText, 300);
  var adminNotes = sanitizeSingleLineTextStep7_(req.adminNotes, 1000);
  var topicTags = normalizeTopicTagsPhase2_(req.topicTags);

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please fix the highlighted question bank fields.',
      fieldErrors
    );
  }

  var savedDto = null;
  withScriptLock_(function () {
    var qbTbl = readSheetTable_('QuestionBank');
    var stimTbl = readSheetTable_('SharedStimuli');
    var nowIso = nowUtcIso_();

    var stimRow = null;
    if (stimulusId) {
      if (!stimTbl.byId[stimulusId]) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Referenced shared stimulus "' + stimulusId + '" was not found.',
          { stimulusId: 'Selected shared stimulus does not exist.' }
        );
      }
      stimRow = stimTbl.byId[stimulusId].record;
    }

    for (var i = 0; i < qbTbl.records.length; i++) {
      var r = qbTbl.records[i];
      if (
        String(r.question_code || '').toUpperCase() === questionCode &&
        r.question_id !== questionId
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Question code "' + questionCode + '" is already used by another question in the bank.',
          { questionCode: 'Question code must be unique.' }
        );
      }
    }

    var targetQuestionId = questionId;
    var nextVersionNo = 1;
    var newVersionId = generateEntityId_('qvr_');
    var savedBankRow = null;

    if (isCreate) {
      targetQuestionId = generateEntityId_('qbn_');
      nextVersionNo = 1;
      savedBankRow = insertSheetRecord_(
        'QuestionBank',
        {
          question_id: targetQuestionId,
          question_code: questionCode,
          title: title,
          question_type: questionType,
          topic_tags_json: JSON.stringify(topicTags),
          difficulty: difficulty,
          active_version_id: newVersionId,
          latest_version_no: 1,
          status: status,
          used_in_attempts_count: 0,
          created_by_user_id: adminUser.user_id,
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
    } else {
      var qbHit = qbTbl.byId[questionId];
      if (!qbHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Question "' + questionId + '" was not found in QuestionBank.'
        );
      }
      var expectedVersion =
        req.expectedVersion !== undefined && req.expectedVersion !== null && req.expectedVersion !== ''
          ? Number(req.expectedVersion)
          : Number(qbHit.record.version);
      nextVersionNo = (Number(qbHit.record.latest_version_no) || 1) + 1;
      savedBankRow = updateSheetRecordById_(
        'QuestionBank',
        questionId,
        {
          question_code: questionCode,
          title: title,
          question_type: questionType,
          topic_tags_json: JSON.stringify(topicTags),
          difficulty: difficulty,
          active_version_id: newVersionId,
          latest_version_no: nextVersionNo,
          status: status,
          updated_at_utc: nowIso
        },
        expectedVersion,
        { skipLock: true }
      );
    }

    var insertedOptions = [];
    for (var opIdx = 0; opIdx < specBundle.normalizedOptions.length; opIdx++) {
      var opSpec = specBundle.normalizedOptions[opIdx];
      var opRowId =
        isCreate && opSpec.option_id
          ? opSpec.option_id
          : generateEntityId_('qop_');
      if (opRowId !== opSpec.option_id && Array.isArray(specBundle.gradingSpec.correctOptionIds)) {
        var cPos = specBundle.gradingSpec.correctOptionIds.indexOf(opSpec.option_id);
        if (cPos !== -1) {
          specBundle.gradingSpec.correctOptionIds[cPos] = opRowId;
        }
      }
      var createdOp = insertSheetRecord_(
        'QuestionOptions',
        {
          option_id: opRowId,
          question_version_id: newVersionId,
          question_id: targetQuestionId,
          option_key: opSpec.option_key,
          content_richtext_json: opSpec.content_richtext_json,
          image_file_id: opSpec.image_file_id,
          image_alt_text: opSpec.image_alt_text,
          sort_order: opSpec.sort_order,
          pin_position: opSpec.pin_position,
          is_correct_private: opSpec.is_correct_private,
          created_at_utc: nowIso
        },
        { skipLock: true }
      );
      insertedOptions.push(createdOp);
    }

    var savedVerRow = insertSheetRecord_(
      'QuestionVersions',
      {
        question_version_id: newVersionId,
        question_id: targetQuestionId,
        version_no: nextVersionNo,
        question_type: questionType,
        title: title,
        stem_richtext_json: stemValidated.json,
        stimulus_id: stimulusId || '',
        image_file_id: imageFileId || '',
        image_alt_text: altCheck.altText || '',
        image_caption: imageCaption || '',
        accessible_design_flag: altCheck.accessibleDesignFlag,
        default_points_bp: defaultPointsBp,
        negative_points_bp: negativePointsBp,
        lock_option_order: specBundle.lockOptionOrder,
        selection_instruction: specBundle.selectionInstruction,
        unit_label: specBundle.unitLabel,
        max_length_chars: specBundle.maxLengthChars,
        grading_mode: specBundle.gradingMode,
        grading_spec_private_json: JSON.stringify(specBundle.gradingSpec),
        explanation_richtext_json: explanationValidated.json,
        reference_text: referenceText,
        admin_notes_private: adminNotes,
        is_immutable: true,
        created_by_user_id: adminUser.user_id,
        created_at_utc: nowIso
      },
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: isCreate ? 'ADMIN_QUESTION_CREATED' : 'ADMIN_QUESTION_NEW_VERSION_CREATED',
      targetEntityType: 'QuestionBank',
      targetEntityId: targetQuestionId,
      summary: {
        questionCode: questionCode,
        questionVersionId: newVersionId,
        versionNo: nextVersionNo,
        questionType: questionType,
        difficulty: difficulty,
        status: status,
        pointsBp: defaultPointsBp
      }
    });

    savedDto = projectQuestionVersionDtoPhase2_(
      savedBankRow,
      savedVerRow,
      insertedOptions,
      stimRow,
      true
    );
  });

  var listBundle = handleAdminListQuestionsPhase2_({}, context);
  return {
    question: savedDto,
    bankSummary: listBundle.summary,
    questions: listBundle.questions,
    pagination: listBundle.pagination
  };
}

/**
 * Duplicates an existing QuestionBank item as a new DRAFT question (admin.questions.duplicate).
 */
function handleAdminDuplicateQuestionPhase2_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase2SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var sourceQuestionId = sanitizeSingleLineTextStep7_(req.questionId, 64);
  if (!sourceQuestionId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'questionId is required to duplicate a question.'
    );
  }

  var qbTbl = readSheetTable_('QuestionBank');
  var qvTbl = readSheetTable_('QuestionVersions');
  var qoTbl = readSheetTable_('QuestionOptions');
  var srcHit = qbTbl.byId[sourceQuestionId];
  if (!srcHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Source question "' + sourceQuestionId + '" was not found.'
    );
  }
  var srcQb = srcHit.record;
  var srcQvHit = qvTbl.byId[srcQb.active_version_id];
  if (!srcQvHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Active version for question "' + sourceQuestionId + '" was not found.'
    );
  }
  var srcQv = srcQvHit.record;
  var srcOptions = [];
  for (var i = 0; i < qoTbl.records.length; i++) {
    if (qoTbl.records[i].question_version_id === srcQv.question_version_id) {
      srcOptions.push(qoTbl.records[i]);
    }
  }
  srcOptions.sort(function (a, b) {
    return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
  });

  var suffix = String(Math.floor(100 + Math.random() * 900));
  var cloneCode = (String(srcQb.question_code || 'BIO-Q').slice(0, 38) + '-COPY-' + suffix).toUpperCase();
  var parsedSpec = {};
  try {
    parsedSpec = JSON.parse(srcQv.grading_spec_private_json || '{}');
  } catch (e) {
    parsedSpec = {};
  }

  var clonePayload = {
    questionCode: cloneCode,
    title: (srcQb.title + ' (Copy)').slice(0, 180),
    questionType: srcQv.question_type,
    difficulty: srcQb.difficulty,
    status: 'DRAFT',
    topicTags: srcQb.topic_tags_json,
    defaultPoints: (Number(srcQv.default_points_bp) || 100) / 100,
    negativePoints: (Number(srcQv.negative_points_bp) || 0) / 100,
    stemRichText: srcQv.stem_richtext_json,
    stimulusId: srcQv.stimulus_id,
    imageFileId: srcQv.image_file_id,
    imageAltText: srcQv.image_alt_text,
    imageCaption: srcQv.image_caption,
    accessibleDesignFlag: srcQv.accessible_design_flag,
    lockOptionOrder: Boolean(srcQv.lock_option_order),
    selectionInstruction: srcQv.selection_instruction,
    unitLabel: srcQv.unit_label,
    maxLengthChars: Number(srcQv.max_length_chars) || 0,
    gradingMode: srcQv.grading_mode,
    explanationRichText: srcQv.explanation_richtext_json,
    referenceText: srcQv.reference_text,
    adminNotes: srcQv.admin_notes_private,
    multiSelectScoringRule: parsedSpec.scoringRule || 'EXACT_MATCH',
    numericSpec: parsedSpec,
    acceptedAnswers: parsedSpec.acceptedAnswers || [],
    caseSensitive: Boolean(parsedSpec.caseSensitive),
    collapseWhitespace: parsedSpec.collapseWhitespace !== false,
    trimPunctuation: parsedSpec.trimPunctuation !== false,
    rubricNotes: parsedSpec.rubricNotes || '',
    rubricCriteria: parsedSpec.rubricCriteria || [],
    sampleModelAnswer: parsedSpec.sampleModelAnswer || '',
    options: srcOptions.map(function (o) {
      return {
        optionKey: o.option_key,
        contentRichText: o.content_richtext_json,
        imageFileId: o.image_file_id,
        imageAltText: o.image_alt_text,
        pinPosition: o.pin_position,
        isCorrect: Boolean(o.is_correct_private)
      };
    })
  };

  return handleAdminSaveQuestionPhase2_(clonePayload, context);
}

/**
 * Archives, restores, or safely blocks hard deletion of a QuestionBank item (admin.questions.archive).
 */
function handleAdminArchiveOrDeleteQuestionPhase2_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase2SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var questionId = sanitizeSingleLineTextStep7_(req.questionId, 64);
  var mode = String(req.mode || 'ARCHIVE').trim().toUpperCase();
  if (!questionId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'questionId is required.'
    );
  }

  withScriptLock_(function () {
    var qbTbl = readSheetTable_('QuestionBank');
    var qbHit = qbTbl.byId[questionId];
    if (!qbHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Question "' + questionId + '" was not found.'
      );
    }
    var qb = qbHit.record;
    var usedCount = Number(qb.used_in_attempts_count) || 0;

    if (mode === 'HARD_DELETE') {
      if (usedCount > 0) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_OPERATION || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Hard deletion blocked: question "' +
            qb.question_code +
            '" is referenced in ' +
            usedCount +
            ' active or submitted student attempt(s). Archive the question instead so historical attempts remain reproducible.',
          { questionId: 'Cannot hard-delete a question version used in attempts.' }
        );
      }
      updateSheetRecordById_(
        'QuestionBank',
        questionId,
        {
          status: 'ARCHIVED',
          updated_at_utc: nowUtcIso_()
        },
        Number(qb.version),
        { skipLock: true }
      );
      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_QUESTION_ARCHIVED',
        targetEntityType: 'QuestionBank',
        targetEntityId: questionId,
        summary: { questionCode: qb.question_code, mode: 'ARCHIVED_SAFE' }
      });
    } else {
      var targetStatus =
        mode === 'RESTORE_PUBLISHED'
          ? 'PUBLISHED'
          : mode === 'RESTORE_DRAFT'
          ? 'DRAFT'
          : 'ARCHIVED';
      updateSheetRecordById_(
        'QuestionBank',
        questionId,
        {
          status: targetStatus,
          updated_at_utc: nowUtcIso_()
        },
        Number(qb.version),
        { skipLock: true }
      );
      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_QUESTION_STATUS_CHANGED',
        targetEntityType: 'QuestionBank',
        targetEntityId: questionId,
        summary: { questionCode: qb.question_code, newStatus: targetStatus }
      });
    }
  });

  return handleAdminListQuestionsPhase2_({}, context);
}

/**
 * Generates an interactive Student Preview DTO for a QuestionBank item (admin.questions.preview).
 */
function handleAdminPreviewQuestionPhase2_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase2SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var questionId = sanitizeSingleLineTextStep7_(req.questionId, 64);
  var requestedVersionId = sanitizeSingleLineTextStep7_(req.questionVersionId, 64);
  var includeAnswerKey = Boolean(req.includeAnswerKey);

  var qbTbl = readSheetTable_('QuestionBank');
  var qvTbl = readSheetTable_('QuestionVersions');
  var qoTbl = readSheetTable_('QuestionOptions');
  var stimTbl = readSheetTable_('SharedStimuli');

  var qbHit = qbTbl.byId[questionId];
  if (!qbHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Question "' + questionId + '" was not found.'
    );
  }
  var qb = qbHit.record;
  var verId = requestedVersionId || qb.active_version_id;
  var qvHit = qvTbl.byId[verId];
  if (!qvHit || qvHit.record.question_id !== qb.question_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Question version "' + verId + '" was not found.'
    );
  }
  var qv = qvHit.record;

  var optRows = [];
  for (var i = 0; i < qoTbl.records.length; i++) {
    if (qoTbl.records[i].question_version_id === qv.question_version_id) {
      optRows.push(qoTbl.records[i]);
    }
  }

  var stimRow =
    qv.stimulus_id && stimTbl.byId[qv.stimulus_id]
      ? stimTbl.byId[qv.stimulus_id].record
      : null;

  var allVersions = [];
  for (var vi = 0; vi < qvTbl.records.length; vi++) {
    var vr = qvTbl.records[vi];
    if (vr.question_id === qb.question_id) {
      allVersions.push({
        questionVersionId: vr.question_version_id,
        versionNo: Number(vr.version_no) || 1,
        createdAtUtc: vr.created_at_utc,
        createdAtBangkok: formatBangkokTimestamp_(vr.created_at_utc),
        pointsBp: Number(vr.default_points_bp) || 100
      });
    }
  }
  allVersions.sort(function (a, b) {
    return b.versionNo - a.versionNo;
  });

  var studentSafeDto = projectQuestionVersionDtoPhase2_(
    qb,
    qv,
    optRows,
    stimRow,
    false
  );
  var adminInspectorDto = includeAnswerKey
    ? projectQuestionVersionDtoPhase2_(qb, qv, optRows, stimRow, true)
    : null;

  return {
    isPreviewOnly: true,
    countsAsRealAttempt: false,
    previewMode: includeAnswerKey ? 'ADMIN_KEY_INSPECTOR' : 'PURE_STUDENT_VIEW',
    studentQuestionView: studentSafeDto,
    adminGradingPreview: adminInspectorDto ? adminInspectorDto.privateGradingData : null,
    versionHistory: allVersions
  };
}

/**
 * Seeds a starter set of 1 shared biology experimental stimulus (with a table block)
 * and 6 biology questions covering all 6 question types (admin.questions.seedSampleBiologyBank).
 */
function handleAdminSeedSampleBiologyQuestionBankPhase2_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase2SheetsExist_();

  var stimRes = null;
  var stimTbl = readSheetTable_('SharedStimuli');
  var existingStim = null;
  for (var si = 0; si < stimTbl.records.length; si++) {
    if (stimTbl.records[si].stimulus_code === 'STIM-BIO-PHOTOSYN-01') {
      existingStim = stimTbl.records[si];
      break;
    }
  }

  if (!existingStim) {
    var stimDoc = {
      schemaVersion: 'pb-richtext-v1',
      blocks: [
        {
          type: 'paragraph',
          spans: [
            { text: 'Experiment 1: Hill Reaction & Photosynthetic O', bold: true },
            { text: '2', bold: true, sub: true },
            { text: ' Evolution in Isolated Spinacia oleracea Chloroplasts', bold: true }
          ]
        },
        {
          type: 'paragraph',
          spans: [
            { text: 'Isolated chloroplasts from ' },
            { text: 'Spinacia oleracea', italic: true },
            { text: ' were suspended in buffered isotonic medium (pH 7.4) with 0.2 mmol/L DCPIP as an artificial electron acceptor and illuminated at 25 ' },
            { text: 'o', sup: true },
            { text: 'C across four light intensities.' }
          ]
        },
        {
          type: 'table',
          caption: 'Table 1: Rate of O2 evolution and NADPH production across treatments',
          headers: ['Cuvette', 'Light Intensity (umol photons m-2 s-1)', 'DCMU Herbicide', 'O2 Evolution (umol mg-1 Chl h-1)'],
          rows: [
            ['1 (Dark Control)', '0', 'Absent', '0.0'],
            ['2 (Low Light)', '150', 'Absent', '42.5'],
            ['3 (Saturating Light)', '800', 'Absent', '128.0'],
            ['4 (Inhibitor + Light)', '800', '10 umol/L DCMU', '1.2']
          ]
        }
      ]
    };
    stimRes = handleAdminSaveStimulusPhase2_(
      {
        stimulusCode: 'STIM-BIO-PHOTOSYN-01',
        title: 'Hill Reaction & DCMU Inhibition in Isolated Chloroplasts',
        contentRichText: stimDoc,
        topicTags: ['Photosynthesis', 'Bioenergetics', 'Plant Physiology'],
        status: 'PUBLISHED'
      },
      context
    );
    existingStim = { stimulus_id: stimRes.stimulus.stimulusId };
  }

  var stimId = existingStim.stimulus_id;
  var sampleSpecs = [
    {
      questionCode: 'BIO-PHOTO-SC-01',
      title: 'Site of DCMU Electron Transport Inhibition in Thylakoid Membrane',
      questionType: 'SINGLE_CHOICE',
      difficulty: 'MEDIUM',
      status: 'PUBLISHED',
      topicTags: ['Photosynthesis', 'Bioenergetics'],
      defaultPoints: 2,
      stimulusId: stimId,
      stemRichText: {
        schemaVersion: 'pb-richtext-v1',
        blocks: [
          {
            type: 'paragraph',
            spans: [
              { text: 'Based on Table 1 in the shared stimulus, DCMU reduces O' },
              { text: '2', sub: true },
              { text: ' evolution in Cuvette 4 by competitively binding to which electron carrier binding site?' }
            ]
          }
        ]
      },
      options: [
        { text: 'The QB plastoquinone binding site on the D1 protein of Photosystem II', isCorrect: true },
        { text: 'The copper prosthetic group of plastocyanin in the thylakoid lumen', isCorrect: false },
        { text: 'The iron-sulfur cluster (Fe-S) of ferredoxin on the stromal side of PSI', isCorrect: false },
        { text: 'The CF0 proton channel of chloroplast ATP synthase', isCorrect: false }
      ],
      explanationRichText: 'DCMU (diuron) blocks electron transfer from QA to QB at the QB-binding pocket of the D1 polypeptide in Photosystem II, halting water photolysis and O2 evolution.',
      referenceText: 'Campbell Biology, 12th Ed., Ch. 10 (Photosynthesis)'
    },
    {
      questionCode: 'BIO-CELL-MS-02',
      title: 'Chemiosmotic Proton Gradient & Thylakoid Lumen Acidification',
      questionType: 'MULTIPLE_SELECT',
      difficulty: 'HARD',
      status: 'PUBLISHED',
      topicTags: ['Photosynthesis', 'Membrane Transport'],
      defaultPoints: 3,
      stimulusId: stimId,
      multiSelectScoringRule: 'EXACT_MATCH',
      stemRichText: 'Which of the following processes directly contribute to increasing the proton concentration ([H+]) inside the thylakoid lumen relative to the chloroplast stroma during linear electron flow? Select all that apply.',
      options: [
        { text: 'Oxidation (photolysis) of H2O by the oxygen-evolving complex of Photosystem II', isCorrect: true },
        { text: 'Translocation of protons across the thylakoid membrane by the plastoquinone / cytochrome b6f cycle', isCorrect: true },
        { text: 'Consumption of stromal H+ during the reduction of NADP+ to NADPH by ferredoxin-NADP+ reductase', isCorrect: true },
        { text: 'Fixation of CO2 by RuBisCO in the mitochondrial matrix', isCorrect: false }
      ],
      explanationRichText: 'All three thylakoid mechanisms (water splitting in the lumen, PQ/Cyt b6f proton pumping, and stromal H+ removal during NADP+ reduction) build the transmembrane proton-motive force.',
      referenceText: 'Taiz & Zeiger, Plant Physiology and Development'
    },
    {
      questionCode: 'BIO-ENZYME-TF-03',
      title: 'Cyclic Electron Flow & O2 Evolution Under DCMU Blockade',
      questionType: 'TRUE_FALSE',
      difficulty: 'EASY',
      status: 'PUBLISHED',
      topicTags: ['Photosynthesis', 'Bioenergetics'],
      defaultPoints: 1,
      stimulusId: stimId,
      trueFalseCorrect: 'TRUE',
      stemRichText: 'True or False: Even when Photosystem II is inhibited by DCMU (Cuvette 4), cyclic electron flow around Photosystem I can still generate a proton gradient for ATP synthesis without evolving O2.',
      explanationRichText: 'True. Cyclic photophosphorylation utilizes Photosystem I, ferredoxin, cytochrome b6f, and plastocyanin to pump H+ and synthesize ATP independently of PSII water splitting.',
      referenceText: 'Campbell Biology, 12th Ed., Ch. 10'
    },
    {
      questionCode: 'BIO-GENETICS-NUM-04',
      title: 'Net Increase in Photosynthetic Rate Between Low and Saturating Light',
      questionType: 'NUMERIC_RESPONSE',
      difficulty: 'MEDIUM',
      status: 'PUBLISHED',
      topicTags: ['Photosynthesis', 'Quantitative Biology'],
      defaultPoints: 2,
      stimulusId: stimId,
      unitLabel: 'umol mg-1 Chl h-1',
      numericSpec: {
        matchMode: 'EXACT_WITH_TOLERANCE',
        targetValue: 85.5,
        toleranceType: 'ABSOLUTE',
        toleranceValue: 0.1,
        roundingDecimals: 1
      },
      stemRichText: 'Using Table 1 in the shared stimulus, calculate the net increase in O2 evolution rate (in umol mg-1 Chl h-1) when light intensity increases from Cuvette 2 (150 umol photons m-2 s-1) to Cuvette 3 (800 umol photons m-2 s-1).',
      explanationRichText: 'Cuvette 3 rate (128.0) minus Cuvette 2 rate (42.5) = 85.5 umol mg-1 Chl h-1.',
      referenceText: 'Table 1 Experimental Dataset'
    },
    {
      questionCode: 'BIO-MOLEC-SA-05',
      title: 'Primary CO2-Fixing Enzyme of the Calvin-Benson Cycle',
      questionType: 'SHORT_ANSWER',
      difficulty: 'EASY',
      status: 'PUBLISHED',
      topicTags: ['Photosynthesis', 'Enzymes'],
      defaultPoints: 2,
      gradingMode: 'AUTO_WITH_MANUAL_REVIEW',
      acceptedAnswers: [
        'RuBisCO',
        'Ribulose-1,5-bisphosphate carboxylase/oxygenase',
        'Ribulose-1,5-bisphosphate carboxylase-oxygenase',
        'Ribulose bisphosphate carboxylase'
      ],
      caseSensitive: false,
      collapseWhitespace: true,
      trimPunctuation: true,
      stemRichText: 'Name the chloroplast stromal enzyme that catalyzes the carboxylation of ribulose-1,5-bisphosphate (RuBP) during the first step of the Calvin-Benson cycle.',
      explanationRichText: 'Ribulose-1,5-bisphosphate carboxylase/oxygenase (RuBisCO) catalyzes the attachment of CO2 to the 5-carbon acceptor RuBP.',
      referenceText: 'Campbell Biology, 12th Ed., Ch. 10'
    },
    {
      questionCode: 'BIO-PHYSIO-WR-06',
      title: 'Mechanistic Comparison of C3, C4, and CAM Carbon Concentrating Pathways',
      questionType: 'WRITTEN_RESPONSE',
      difficulty: 'OLYMPIAD',
      status: 'PUBLISHED',
      topicTags: ['Photosynthesis', 'Plant Anatomy', 'Evolution'],
      defaultPoints: 5,
      maxLengthChars: 2500,
      rubricCriteria: [
        {
          criterionId: 'crit_1',
          title: 'Spatial vs. Temporal Separation',
          maxPoints: 2,
          description: 'Contrasts C4 spatial separation (mesophyll PEP carboxylase vs. bundle-sheath RuBisCO) with CAM temporal separation (nocturnal stomatal opening & malate vacuolar storage).'
        },
        {
          criterionId: 'crit_2',
          title: 'Suppression of Photorespiration & Energetic Cost',
          maxPoints: 3,
          description: 'Explains why PEP carboxylase lacks oxygenase activity and compares the additional ATP cost per fixed CO2 molecule.'
        }
      ],
      sampleModelAnswer: 'C4 plants spatially separate initial carbon fixation via PEP carboxylase in mesophyll cells from the Calvin cycle in bundle-sheath cells, whereas CAM plants temporally separate nocturnal CO2 fixation into malic acid from daytime decarboxylation.',
      stemRichText: 'Compare and contrast the anatomical and biochemical adaptations of C4 and CAM plants that minimize photorespiration under hot, arid conditions, including the enzymes involved and energetic trade-offs.',
      explanationRichText: 'Full marks require contrasting mesophyll/bundle-sheath spatial compartmentation in C4 plants with night/day temporal compartmentation in CAM plants and discussing PEP carboxylase affinity and ATP regeneration cost.',
      referenceText: '21st TBO Theoretical Examination Syllabus'
    }
  ];

  var qbTblNow = readSheetTable_('QuestionBank');
  var existingCodes = {};
  for (var qi = 0; qi < qbTblNow.records.length; qi++) {
    existingCodes[String(qbTblNow.records[qi].question_code || '').toUpperCase()] = true;
  }

  var seededCount = 0;
  for (var k = 0; k < sampleSpecs.length; k++) {
    var sp = sampleSpecs[k];
    if (!existingCodes[sp.questionCode]) {
      handleAdminSaveQuestionPhase2_(sp, context);
      seededCount += 1;
    }
  }

  var updatedBundle = handleAdminListQuestionsPhase2_({}, context);
  return {
    seededCount: seededCount,
    stimulusId: stimId,
    bankSummary: updatedBundle.summary,
    questions: updatedBundle.questions,
    pagination: updatedBundle.pagination,
    stimuli: updatedBundle.stimuli
  };
}




// ============================================================================
// NATIVE ONLINE EXAMINATION SYSTEM -- PHASE 3: EXAMINATION BUILDER, SECTIONS,
// PUBLICATION VALIDATOR, ASSIGNMENTS/ACCOMMODATIONS & STUDENT CATALOG
// ============================================================================

var PB_EXAM_MODES_PHASE3_ = Object.freeze({
  PRACTICE: 'PRACTICE',
  MOCK_EXAM: 'MOCK_EXAM',
  ASSIGNED_ASSESSMENT: 'ASSIGNED_ASSESSMENT'
});

var PB_EXAM_STATUSES_PHASE3_ = Object.freeze({
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  CLOSED: 'CLOSED',
  ARCHIVED: 'ARCHIVED'
});

var PB_EXAM_ASSIGNMENT_SCOPES_PHASE3_ = Object.freeze({
  COURSE_ENROLLED: 'COURSE_ENROLLED',
  SELECTED_STUDENTS: 'SELECTED_STUDENTS'
});

var PB_EXAM_NAVIGATION_MODES_PHASE3_ = Object.freeze({
  FREE: 'FREE',
  LINEAR: 'LINEAR'
});

var PB_EXAM_AGGREGATION_RULES_PHASE3_ = Object.freeze({
  BEST_PUBLISHED: 'BEST_PUBLISHED',
  LATEST_PUBLISHED: 'LATEST_PUBLISHED',
  FIRST_PUBLISHED: 'FIRST_PUBLISHED'
});

var PB_EXAM_SCORE_RELEASE_POLICIES_PHASE3_ = Object.freeze({
  IMMEDIATE_AUTO: 'IMMEDIATE_AUTO',
  MANUAL_ADMIN: 'MANUAL_ADMIN',
  SCHEDULED: 'SCHEDULED',
  AFTER_CLOSE: 'AFTER_CLOSE'
});

var PB_EXAM_EXPLANATION_RELEASE_POLICIES_PHASE3_ = Object.freeze({
  WITH_SCORE: 'WITH_SCORE',
  MANUAL_ADMIN: 'MANUAL_ADMIN',
  SCHEDULED: 'SCHEDULED',
  AFTER_CLOSE: 'AFTER_CLOSE',
  NEVER: 'NEVER'
});

var PB_EXAM_SECTION_SELECTION_MODES_PHASE3_ = Object.freeze({
  FIXED_ITEMS: 'FIXED_ITEMS',
  QUESTION_POOL: 'QUESTION_POOL'
});

/**
 * Dynamically registers the Phase 3 normalized examination worksheets
 * ('ExamSets', 'ExamVersions', 'ExamSections', 'ExamItems', 'ExamAssignments', 'ExamAttempts')
 * in 'PB_SHEET_NAMES_' and 'PB_SHEET_SCHEMAS_'.
 */
function ensureExamPhase3SchemasRegistered_() {
  ensureExamPhase2SchemasRegistered_();
  if (typeof PB_SHEET_NAMES_ === 'object' && PB_SHEET_NAMES_ && !PB_SHEET_NAMES_.EXAM_SETS) {
    var nextNames = {};
    var nameKeys = Object.keys(PB_SHEET_NAMES_);
    for (var i = 0; i < nameKeys.length; i++) {
      nextNames[nameKeys[i]] = PB_SHEET_NAMES_[nameKeys[i]];
    }
    nextNames.EXAM_SETS = 'ExamSets';
    nextNames.EXAM_VERSIONS = 'ExamVersions';
    nextNames.EXAM_SECTIONS = 'ExamSections';
    nextNames.EXAM_ITEMS = 'ExamItems';
    nextNames.EXAM_ASSIGNMENTS = 'ExamAssignments';
    nextNames.EXAM_ATTEMPTS = 'ExamAttempts';
    PB_SHEET_NAMES_ = Object.freeze(nextNames);
  }

  if (typeof PB_SHEET_SCHEMAS_ === 'object' && PB_SHEET_SCHEMAS_ && !PB_SHEET_SCHEMAS_.ExamSets) {
    var nextSchemas = {};
    var schemaKeys = Object.keys(PB_SHEET_SCHEMAS_);
    for (var j = 0; j < schemaKeys.length; j++) {
      nextSchemas[schemaKeys[j]] = PB_SHEET_SCHEMAS_[schemaKeys[j]];
    }

    nextSchemas.ExamSets = Object.freeze({
      sheetName: 'ExamSets',
      primaryKey: 'exam_set_id',
      idPrefix: 'exs_',
      hasVersion: true,
      headers: Object.freeze([
        'exam_set_id',
        'assessment_id',
        'course_id',
        'exam_code',
        'title',
        'description_richtext_json',
        'instructions_richtext_json',
        'cover_image_file_id',
        'exam_mode',
        'active_exam_version_id',
        'draft_exam_version_id',
        'latest_version_no',
        'assignment_scope',
        'open_at_utc',
        'close_at_utc',
        'duration_minutes',
        'grace_seconds',
        'max_attempts',
        'retake_cooldown_minutes',
        'navigation_mode',
        'aggregation_rule',
        'score_release_policy',
        'score_release_at_utc',
        'explanation_release_policy',
        'explanation_release_at_utc',
        'pass_threshold_pct',
        'randomize_questions',
        'randomize_options',
        'allow_per_question_practice_feedback',
        'status',
        'created_by_user_id',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'exam_set_id',
        'exam_code',
        'title',
        'exam_mode',
        'assignment_scope',
        'navigation_mode',
        'aggregation_rule',
        'score_release_policy',
        'explanation_release_policy',
        'status',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      enums: Object.freeze({
        exam_mode: Object.freeze(['PRACTICE', 'MOCK_EXAM', 'ASSIGNED_ASSESSMENT']),
        assignment_scope: Object.freeze(['COURSE_ENROLLED', 'SELECTED_STUDENTS']),
        navigation_mode: Object.freeze(['FREE', 'LINEAR']),
        aggregation_rule: Object.freeze(['BEST_PUBLISHED', 'LATEST_PUBLISHED', 'FIRST_PUBLISHED']),
        score_release_policy: Object.freeze(['IMMEDIATE_AUTO', 'MANUAL_ADMIN', 'SCHEDULED', 'AFTER_CLOSE']),
        explanation_release_policy: Object.freeze(['WITH_SCORE', 'MANUAL_ADMIN', 'SCHEDULED', 'AFTER_CLOSE', 'NEVER']),
        status: Object.freeze(['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'])
      }),
      booleanFields: Object.freeze([
        'randomize_questions',
        'randomize_options',
        'allow_per_question_practice_feedback'
      ]),
      integerFields: Object.freeze([
        'latest_version_no',
        'duration_minutes',
        'grace_seconds',
        'max_attempts',
        'retake_cooldown_minutes',
        'pass_threshold_pct',
        'version'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    nextSchemas.ExamVersions = Object.freeze({
      sheetName: 'ExamVersions',
      primaryKey: 'exam_version_id',
      idPrefix: 'exv_',
      hasVersion: false,
      headers: Object.freeze([
        'exam_version_id',
        'exam_set_id',
        'version_no',
        'version_state',
        'exam_mode',
        'title',
        'instructions_richtext_json',
        'duration_minutes',
        'grace_seconds',
        'total_questions_count',
        'max_points_bp',
        'negative_marking_enabled',
        'unanswered_points_bp',
        'navigation_mode',
        'randomize_questions',
        'randomize_options',
        'allow_per_question_practice_feedback',
        'policy_snapshot_json',
        'published_by_user_id',
        'published_at_utc',
        'created_at_utc'
      ]),
      requiredFields: Object.freeze([
        'exam_version_id',
        'exam_set_id',
        'version_no',
        'version_state',
        'exam_mode',
        'title',
        'total_questions_count',
        'max_points_bp',
        'navigation_mode',
        'created_at_utc'
      ]),
      enums: Object.freeze({
        version_state: Object.freeze(['DRAFT', 'PUBLISHED']),
        exam_mode: Object.freeze(['PRACTICE', 'MOCK_EXAM', 'ASSIGNED_ASSESSMENT']),
        navigation_mode: Object.freeze(['FREE', 'LINEAR'])
      }),
      booleanFields: Object.freeze([
        'negative_marking_enabled',
        'randomize_questions',
        'randomize_options',
        'allow_per_question_practice_feedback'
      ]),
      integerFields: Object.freeze([
        'version_no',
        'duration_minutes',
        'grace_seconds',
        'total_questions_count',
        'max_points_bp',
        'unanswered_points_bp'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    nextSchemas.ExamSections = Object.freeze({
      sheetName: 'ExamSections',
      primaryKey: 'exam_section_id',
      idPrefix: 'exsct_',
      hasVersion: false,
      headers: Object.freeze([
        'exam_section_id',
        'exam_version_id',
        'exam_set_id',
        'title',
        'instructions_richtext_json',
        'sort_order',
        'selection_mode',
        'pool_draw_count',
        'pool_filter_json',
        'lock_section_order',
        'randomize_items_within_section',
        'section_questions_count',
        'section_max_points_bp',
        'created_at_utc'
      ]),
      requiredFields: Object.freeze([
        'exam_section_id',
        'exam_version_id',
        'exam_set_id',
        'title',
        'sort_order',
        'selection_mode',
        'section_questions_count',
        'section_max_points_bp',
        'created_at_utc'
      ]),
      enums: Object.freeze({
        selection_mode: Object.freeze(['FIXED_ITEMS', 'QUESTION_POOL'])
      }),
      booleanFields: Object.freeze([
        'lock_section_order',
        'randomize_items_within_section'
      ]),
      integerFields: Object.freeze([
        'sort_order',
        'pool_draw_count',
        'section_questions_count',
        'section_max_points_bp'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    nextSchemas.ExamItems = Object.freeze({
      sheetName: 'ExamItems',
      primaryKey: 'exam_item_id',
      idPrefix: 'exi_',
      hasVersion: false,
      headers: Object.freeze([
        'exam_item_id',
        'exam_version_id',
        'exam_section_id',
        'exam_set_id',
        'question_id',
        'question_version_id',
        'sort_order',
        'lock_item_position',
        'lock_option_order',
        'points_bp',
        'negative_points_bp',
        'is_pool_candidate',
        'pool_group_tag',
        'created_at_utc'
      ]),
      requiredFields: Object.freeze([
        'exam_item_id',
        'exam_version_id',
        'exam_section_id',
        'exam_set_id',
        'question_id',
        'question_version_id',
        'sort_order',
        'points_bp',
        'created_at_utc'
      ]),
      enums: Object.freeze({}),
      booleanFields: Object.freeze([
        'lock_item_position',
        'lock_option_order',
        'is_pool_candidate'
      ]),
      integerFields: Object.freeze([
        'sort_order',
        'points_bp',
        'negative_points_bp'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    nextSchemas.ExamAssignments = Object.freeze({
      sheetName: 'ExamAssignments',
      primaryKey: 'assignment_id',
      idPrefix: 'exa_',
      hasVersion: true,
      headers: Object.freeze([
        'assignment_id',
        'exam_set_id',
        'course_id',
        'target_type',
        'student_user_id',
        'assignment_status',
        'open_at_override_utc',
        'override_deadline_utc',
        'extra_time_minutes',
        'extra_attempts_granted',
        'accommodation_reason',
        'assigned_by_user_id',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'assignment_id',
        'exam_set_id',
        'target_type',
        'assignment_status',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      enums: Object.freeze({
        target_type: Object.freeze(['COURSE', 'STUDENT']),
        assignment_status: Object.freeze(['ASSIGNED', 'REVOKED'])
      }),
      booleanFields: Object.freeze([]),
      integerFields: Object.freeze([
        'extra_time_minutes',
        'extra_attempts_granted',
        'version'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    nextSchemas.ExamAttempts = Object.freeze({
      sheetName: 'ExamAttempts',
      primaryKey: 'attempt_id',
      idPrefix: 'att_',
      hasVersion: true,
      headers: Object.freeze([
        'attempt_id',
        'exam_set_id',
        'exam_version_id',
        'course_id',
        'student_user_id',
        'attempt_number',
        'idempotency_key',
        'attempt_status',
        'grading_status',
        'publication_status',
        'explanation_status',
        'started_at_utc',
        'effective_deadline_utc',
        'grace_deadline_utc',
        'submitted_at_utc',
        'last_saved_at_utc',
        'time_used_seconds',
        'active_lease_token',
        'latest_revision_no',
        'answered_count',
        'flagged_count',
        'auto_score_bp',
        'manual_score_bp',
        'total_score_bp',
        'max_score_bp',
        'percentage_bp',
        'passed_flag',
        'current_result_revision_id',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'attempt_id',
        'exam_set_id',
        'exam_version_id',
        'student_user_id',
        'attempt_number',
        'attempt_status',
        'grading_status',
        'publication_status',
        'explanation_status',
        'started_at_utc',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      enums: Object.freeze({
        attempt_status: Object.freeze(['IN_PROGRESS', 'SUBMITTING', 'SUBMITTED', 'EXPIRED_SUBMITTED', 'INVALIDATED']),
        grading_status: Object.freeze(['NOT_GRADED', 'GRADING_IN_PROGRESS', 'AUTO_GRADED_PENDING_MANUAL', 'GRADED', 'REGRADED']),
        publication_status: Object.freeze(['UNPUBLISHED', 'SCHEDULED', 'PUBLISHED', 'WITHHELD']),
        explanation_status: Object.freeze(['WITHHELD', 'RELEASED'])
      }),
      booleanFields: Object.freeze(['passed_flag']),
      integerFields: Object.freeze([
        'attempt_number',
        'time_used_seconds',
        'latest_revision_no',
        'answered_count',
        'flagged_count',
        'auto_score_bp',
        'manual_score_bp',
        'total_score_bp',
        'max_score_bp',
        'percentage_bp',
        'version'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    PB_SHEET_SCHEMAS_ = Object.freeze(nextSchemas);
  }
}

function ensureExamPhase3SheetsExist_() {
  ensureExamPhase3SchemasRegistered_();
  ensureExamPhase2SheetsExist_();
  var ss = openConfiguredSpreadsheet_();
  var sheetNames = [
    'ExamSets',
    'ExamVersions',
    'ExamSections',
    'ExamItems',
    'ExamAssignments',
    'ExamAttempts'
  ];
  for (var i = 0; i < sheetNames.length; i++) {
    var sName = sheetNames[i];
    if (!ss.getSheetByName(sName) && PB_SHEET_SCHEMAS_[sName]) {
      ensureSingleSheetSchema_(ss, sName);
    }
  }
}

function parseOptionalUtcTimestampPhase3_(rawVal, fieldKey, fieldLabel, fieldErrors) {
  if (rawVal === null || rawVal === undefined || String(rawVal).trim() === '') {
    return '';
  }
  var s = String(rawVal).trim();
  // Support both ISO-8601 and YYYY-MM-DDTHH:mm local Bangkok input (assumed +07:00 if no offset)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) {
    s = s + ':00+07:00';
  } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    var parts = s.trim().split(/\s+/);
    var tPart = parts[1].length === 5 ? parts[1] + ':00' : parts[1];
    s = parts[0] + 'T' + tPart + '+07:00';
  }
  var ms = Date.parse(s);
  if (isNaN(ms)) {
    if (fieldErrors && fieldKey) {
      fieldErrors[fieldKey] = fieldLabel + ' must be a valid date/time.';
    }
    return '';
  }
  return new Date(ms).toISOString();
}

function formatDurationMinutesLabelPhase3_(durationMinutes) {
  var mins = Number(durationMinutes) || 0;
  if (mins <= 0) {
    return 'Untimed';
  }
  if (mins % 60 === 0) {
    var hrs = mins / 60;
    return hrs + (hrs === 1 ? ' hour (' + mins + ' mins)' : ' hours (' + mins + ' mins)');
  }
  return mins + (mins === 1 ? ' minute' : ' minutes');
}

function formatExamModeBadgeLabelPhase3_(examMode) {
  if (examMode === 'PRACTICE') return 'Practice Quiz';
  if (examMode === 'MOCK_EXAM') return 'Timed Mock Examination';
  if (examMode === 'ASSIGNED_ASSESSMENT') return 'Assigned Assessment';
  return String(examMode || 'Examination');
}

/**
 * Projects a structured ExamVersion (with its sections and items) for Admin or Student Instructions.
 */
function buildExamVersionStructureBundlePhase3_(
  examSetRow,
  examVerRow,
  allSectionsRows,
  allItemsRows,
  qbById,
  qvById,
  qoRecords,
  stimById,
  includeAdminItemsDetail
) {
  if (!examVerRow) {
    return {
      examVersionId: '',
      versionNo: 0,
      versionState: 'DRAFT',
      totalQuestionsCount: 0,
      maxPointsBp: 0,
      maxPointsDisplay: '0 pts',
      sections: [],
      questionTypeBreakdown: {}
    };
  }

  var secList = [];
  for (var i = 0; i < allSectionsRows.length; i++) {
    if (allSectionsRows[i].exam_version_id === examVerRow.exam_version_id) {
      secList.push(allSectionsRows[i]);
    }
  }
  secList.sort(function (a, b) {
    var d = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    if (d !== 0) return d;
    return String(a.exam_section_id || '').localeCompare(String(b.exam_section_id || ''));
  });

  var itemsBySection = {};
  for (var m = 0; m < allItemsRows.length; m++) {
    var itRow = allItemsRows[m];
    if (itRow.exam_version_id === examVerRow.exam_version_id) {
      if (!itemsBySection[itRow.exam_section_id]) {
        itemsBySection[itRow.exam_section_id] = [];
      }
      itemsBySection[itRow.exam_section_id].push(itRow);
    }
  }

  var optionsByQvId = {};
  if (includeAdminItemsDetail && Array.isArray(qoRecords)) {
    for (var oi = 0; oi < qoRecords.length; oi++) {
      var op = qoRecords[oi];
      if (!optionsByQvId[op.question_version_id]) {
        optionsByQvId[op.question_version_id] = [];
      }
      optionsByQvId[op.question_version_id].push(op);
    }
  }

  var questionTypeCounts = {};
  var hasManualGradingItems = false;
  var sectionDtos = [];

  for (var sIdx = 0; sIdx < secList.length; sIdx++) {
    var sRow = secList[sIdx];
    var rawSecItems = (itemsBySection[sRow.exam_section_id] || []).slice().sort(function (a, b) {
      var d = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
      if (d !== 0) return d;
      return String(a.exam_item_id || '').localeCompare(String(b.exam_item_id || ''));
    });

    var itemDtos = [];
    for (var k = 0; k < rawSecItems.length; k++) {
      var itemRec = rawSecItems[k];
      var qbHit = qbById && qbById[itemRec.question_id];
      var qvHit = qvById && qvById[itemRec.question_version_id];
      var qbRec = qbHit ? qbHit.record : null;
      var qvRec = qvHit ? qvHit.record : null;
      var qType = qvRec ? qvRec.question_type : (qbRec ? qbRec.question_type : 'SINGLE_CHOICE');

      if (!itemRec.is_pool_candidate || sRow.selection_mode !== 'QUESTION_POOL' || k < Number(sRow.pool_draw_count || 0)) {
        questionTypeCounts[qType] = (questionTypeCounts[qType] || 0) + 1;
      }
      if (qvRec && qvRec.grading_mode === 'MANUAL') {
        hasManualGradingItems = true;
      }

      if (includeAdminItemsDetail) {
        var stimRec = qvRec && qvRec.stimulus_id && stimById && stimById[qvRec.stimulus_id]
          ? stimById[qvRec.stimulus_id].record
          : null;
        var qDto = qbRec && qvRec
          ? projectQuestionVersionDtoPhase2_(
              qbRec,
              qvRec,
              optionsByQvId[qvRec.question_version_id] || [],
              stimRec,
              false
            )
          : null;
        itemDtos.push({
          examItemId: itemRec.exam_item_id,
          questionId: itemRec.question_id,
          questionVersionId: itemRec.question_version_id,
          questionCode: qbRec ? qbRec.question_code : '',
          title: qvRec ? qvRec.title : (qbRec ? qbRec.title : ''),
          questionType: qType,
          difficulty: qbRec ? qbRec.difficulty : 'MEDIUM',
          gradingMode: qvRec ? qvRec.grading_mode : 'AUTO',
          sortOrder: Number(itemRec.sort_order) || (k + 1) * 10,
          lockItemPosition: Boolean(itemRec.lock_item_position),
          lockOptionOrder: Boolean(itemRec.lock_option_order),
          pointsBp: Number(itemRec.points_bp) || 100,
          pointsDisplay: formatPointsBpDisplayPhase2_(itemRec.points_bp || 100),
          negativePointsBp: Number(itemRec.negative_points_bp) || 0,
          negativePointsDisplay: formatPointsBpDisplayPhase2_(itemRec.negative_points_bp || 0),
          isPoolCandidate: Boolean(itemRec.is_pool_candidate),
          poolGroupTag: itemRec.pool_group_tag || '',
          questionPreview: qDto
        });
      }
    }

    var secInstDoc = parseStoredRichTextJsonSafe_(sRow.instructions_richtext_json);
    var secDto = {
      examSectionId: sRow.exam_section_id,
      title: sRow.title || 'Section ' + (sIdx + 1),
      instructionsRichText: secInstDoc,
      instructionsPlainText: extractPlainTextFromRichTextDocPhase2_(secInstDoc),
      sortOrder: Number(sRow.sort_order) || (sIdx + 1) * 10,
      selectionMode: sRow.selection_mode || 'FIXED_ITEMS',
      selectionModeLabel:
        sRow.selection_mode === 'QUESTION_POOL'
          ? 'Random Pool Draw (' +
            Number(sRow.pool_draw_count || 0) +
            ' drawn from ' +
            rawSecItems.length +
            ' candidates)'
          : 'Fixed Section Items (' + rawSecItems.length + (rawSecItems.length === 1 ? ' question)' : ' questions)'),
      poolDrawCount: Number(sRow.pool_draw_count) || 0,
      poolCandidateCount: rawSecItems.length,
      lockSectionOrder: Boolean(sRow.lock_section_order),
      randomizeItemsWithinSection: Boolean(sRow.randomize_items_within_section),
      sectionQuestionsCount: Number(sRow.section_questions_count) || 0,
      sectionMaxPointsBp: Number(sRow.section_max_points_bp) || 0,
      sectionMaxPointsDisplay: formatPointsBpDisplayPhase2_(sRow.section_max_points_bp || 0)
    };
    if (includeAdminItemsDetail) {
      secDto.items = itemDtos;
    }
    sectionDtos.push(secDto);
  }

  return {
    examVersionId: examVerRow.exam_version_id,
    versionNo: Number(examVerRow.version_no) || 1,
    versionState: examVerRow.version_state || 'DRAFT',
    totalQuestionsCount: Number(examVerRow.total_questions_count) || 0,
    maxPointsBp: Number(examVerRow.max_points_bp) || 0,
    maxPointsDisplay: formatPointsBpDisplayPhase2_(examVerRow.max_points_bp || 0),
    negativeMarkingEnabled: Boolean(examVerRow.negative_marking_enabled),
    navigationMode: examVerRow.navigation_mode || 'FREE',
    randomizeQuestions: Boolean(examVerRow.randomize_questions),
    randomizeOptions: Boolean(examVerRow.randomize_options),
    allowPerQuestionPracticeFeedback: Boolean(examVerRow.allow_per_question_practice_feedback),
    hasManualGradingItems: hasManualGradingItems,
    questionTypeBreakdown: questionTypeCounts,
    publishedAtUtc: examVerRow.published_at_utc || '',
    publishedAtBangkok: examVerRow.published_at_utc
      ? formatBangkokTimestamp_(examVerRow.published_at_utc)
      : '',
    sections: sectionDtos
  };
}

/**
 * Validates an ExamSet and its candidate ExamVersion for publication readiness.
 * Checks section non-emptiness, question existence & answer keys, pool supply >= draw_count,
 * uniform pool item points, option-pinning safety ("All of the above"), schedule windows,
 * mode rules (MOCK_EXAM must be timed; per-question feedback only in PRACTICE), and
 * emits a warning when retakes are enabled with immediate answer-key/explanation release.
 */
function evaluateExamPublicationReadinessPhase3_(
  examSetRow,
  examVerRow,
  allSectionsRows,
  allItemsRows,
  qbById,
  qvById,
  qoRecords,
  filesById
) {
  var blockingErrors = [];
  var warnings = [];

  if (!examSetRow) {
    blockingErrors.push({
      code: 'EXAM_NOT_FOUND',
      field: 'examSetId',
      message: 'Examination set record was not found.'
    });
    return { valid: false, blockingErrors: blockingErrors, warnings: warnings };
  }
  if (!examVerRow) {
    blockingErrors.push({
      code: 'EXAM_VERSION_MISSING',
      field: 'examVersionId',
      message: 'Examination version snapshot is missing. Save draft before publishing.'
    });
    return { valid: false, blockingErrors: blockingErrors, warnings: warnings };
  }

  var mode = examSetRow.exam_mode || 'PRACTICE';
  var durMins = Number(examSetRow.duration_minutes) || 0;
  if (mode === 'MOCK_EXAM' && durMins <= 0) {
    blockingErrors.push({
      code: 'MOCK_EXAM_REQUIRES_DURATION',
      field: 'durationMinutes',
      message: 'Mock Examinations must have a positive time limit (durationMinutes > 0).'
    });
  }
  if (Boolean(examSetRow.allow_per_question_practice_feedback) && mode !== 'PRACTICE') {
    blockingErrors.push({
      code: 'PER_QUESTION_FEEDBACK_ONLY_IN_PRACTICE',
      field: 'allowPerQuestionPracticeFeedback',
      message: 'Per-question immediate feedback is only permitted in PRACTICE mode, never in MOCK_EXAM or ASSIGNED_ASSESSMENT.'
    });
  }

  if (examSetRow.open_at_utc && examSetRow.close_at_utc) {
    var openMs = Date.parse(examSetRow.open_at_utc);
    var closeMs = Date.parse(examSetRow.close_at_utc);
    if (!isNaN(openMs) && !isNaN(closeMs) && openMs >= closeMs) {
      blockingErrors.push({
        code: 'INVALID_AVAILABILITY_WINDOW',
        field: 'closeAtUtc',
        message: 'Opening time (openAtUtc) must be strictly earlier than closing time (closeAtUtc).'
      });
    }
  }

  if (examSetRow.score_release_policy === 'SCHEDULED' && !examSetRow.score_release_at_utc) {
    blockingErrors.push({
      code: 'MISSING_SCHEDULED_SCORE_RELEASE_TIME',
      field: 'scoreReleaseAtUtc',
      message: 'scoreReleaseAtUtc is required when scoreReleasePolicy is SCHEDULED.'
    });
  }
  if (examSetRow.explanation_release_policy === 'SCHEDULED' && !examSetRow.explanation_release_at_utc) {
    blockingErrors.push({
      code: 'MISSING_SCHEDULED_EXPLANATION_RELEASE_TIME',
      field: 'explanationReleaseAtUtc',
      message: 'explanationReleaseAtUtc is required when explanationReleasePolicy is SCHEDULED.'
    });
  }

  if (examSetRow.cover_image_file_id && filesById && !filesById[examSetRow.cover_image_file_id]) {
    blockingErrors.push({
      code: 'BROKEN_COVER_IMAGE_FILE_REF',
      field: 'coverImageFileId',
      message: 'Exam cover image file reference "' + examSetRow.cover_image_file_id + '" does not exist in Files.'
    });
  }

  var secList = [];
  for (var i = 0; i < allSectionsRows.length; i++) {
    if (allSectionsRows[i].exam_version_id === examVerRow.exam_version_id) {
      secList.push(allSectionsRows[i]);
    }
  }
  secList.sort(function (a, b) {
    return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
  });

  if (secList.length === 0) {
    blockingErrors.push({
      code: 'EXAM_HAS_NO_SECTIONS',
      field: 'sections',
      message: 'An examination must have at least one section before publication.'
    });
  }

  var optionsByQvId = {};
  for (var oi = 0; oi < qoRecords.length; oi++) {
    var op = qoRecords[oi];
    if (!optionsByQvId[op.question_version_id]) {
      optionsByQvId[op.question_version_id] = [];
    }
    optionsByQvId[op.question_version_id].push(op);
  }

  var totalEffectiveQuestions = 0;
  var totalEffectivePointsBp = 0;
  var hasManualQuestions = false;
  var seenFixedQuestionIds = {};

  for (var sIdx = 0; sIdx < secList.length; sIdx++) {
    var sec = secList[sIdx];
    var secItems = [];
    for (var m = 0; m < allItemsRows.length; m++) {
      if (
        allItemsRows[m].exam_version_id === examVerRow.exam_version_id &&
        allItemsRows[m].exam_section_id === sec.exam_section_id
      ) {
        secItems.push(allItemsRows[m]);
      }
    }

    if (secItems.length === 0) {
      blockingErrors.push({
        code: 'EMPTY_EXAM_SECTION',
        field: 'sections[' + sIdx + ']',
        message: 'Section "' + sec.title + '" has 0 questions. Every section must include at least one question.'
      });
      continue;
    }

    var seenInThisSection = {};
    var poolPointValues = {};

    for (var k = 0; k < secItems.length; k++) {
      var it = secItems[k];
      if (seenInThisSection[it.question_id]) {
        blockingErrors.push({
          code: 'DUPLICATE_QUESTION_IN_SECTION',
          field: 'sections[' + sIdx + '].items[' + k + ']',
          message: 'Question "' + it.question_id + '" is listed more than once in section "' + sec.title + '".'
        });
      }
      seenInThisSection[it.question_id] = true;

      if (sec.selection_mode !== 'QUESTION_POOL') {
        if (seenFixedQuestionIds[it.question_id]) {
          warnings.push({
            code: 'DUPLICATE_QUESTION_ACROSS_SECTIONS',
            message: 'Question "' + it.question_id + '" appears in multiple sections of this exam.'
          });
        }
        seenFixedQuestionIds[it.question_id] = true;
      }

      var qbHit = qbById[it.question_id];
      var qvHit = qvById[it.question_version_id];
      if (!qbHit || !qvHit) {
        blockingErrors.push({
          code: 'MISSING_QUESTION_VERSION',
          field: 'sections[' + sIdx + '].items[' + k + ']',
          message: 'Referenced question "' + it.question_id + '" (version "' + it.question_version_id + '") does not exist.'
        });
        continue;
      }
      var qbRec = qbHit.record;
      var qvRec = qvHit.record;
      if (qbRec.status === 'ARCHIVED') {
        blockingErrors.push({
          code: 'ARCHIVED_QUESTION_IN_EXAM',
          field: 'sections[' + sIdx + '].items[' + k + ']',
          message: 'Question "' + qbRec.question_code + '" is ARCHIVED and cannot be published in a new exam version.'
        });
      }
      if (Number(it.points_bp) <= 0) {
        blockingErrors.push({
          code: 'INVALID_ITEM_POINTS',
          field: 'sections[' + sIdx + '].items[' + k + ']',
          message: 'Question "' + qbRec.question_code + '" must have points > 0.'
        });
      }
      poolPointValues[String(Number(it.points_bp) || 0)] = true;

      if (qvRec.image_file_id) {
        if (filesById && !filesById[qvRec.image_file_id]) {
          blockingErrors.push({
            code: 'BROKEN_QUESTION_IMAGE_REF',
            field: 'sections[' + sIdx + '].items[' + k + ']',
            message: 'Question "' + qbRec.question_code + '" references missing image file "' + qvRec.image_file_id + '".'
          });
        }
        if (!qvRec.image_alt_text || String(qvRec.image_alt_text).trim().length < 4) {
          blockingErrors.push({
            code: 'MISSING_QUESTION_IMAGE_ALT_TEXT',
            field: 'sections[' + sIdx + '].items[' + k + ']',
            message: 'Question "' + qbRec.question_code + '" has an attached image without valid non-spoiler alt text.'
          });
        }
      }

      if (qvRec.grading_mode === 'MANUAL') {
        hasManualQuestions = true;
      }

      // Check choice options and answer key completeness
      var qType = qvRec.question_type;
      var opts = optionsByQvId[qvRec.question_version_id] || [];
      if (qType === 'SINGLE_CHOICE' || qType === 'COMPLEX_MULTIPLE_CHOICE' || qType === 'MULTIPLE_SELECT' || qType === 'TRUE_FALSE') {
        var correctCount = 0;
        var hasUnpinnedOrderDep = false;
        for (var oc = 0; oc < opts.length; oc++) {
          if (opts[oc].is_correct_private) correctCount += 1;
          var optDoc = parseStoredRichTextJsonSafe_(opts[oc].content_richtext_json);
          var optPlain = extractPlainTextFromRichTextDocPhase2_(optDoc);
          if (isOrderDependentOptionTextPhase2_(optPlain)) {
            if (opts[oc].pin_position === 'NONE' && !qvRec.lock_option_order && !it.lock_option_order && examSetRow.randomize_options) {
              hasUnpinnedOrderDep = true;
            }
          }
        }
        if ((qType === 'SINGLE_CHOICE' || qType === 'TRUE_FALSE') && correctCount !== 1) {
          blockingErrors.push({
            code: 'INVALID_CHOICE_ANSWER_KEY',
            field: 'sections[' + sIdx + '].items[' + k + ']',
            message: 'Question "' + qbRec.question_code + '" (' + qType + ') must have exactly 1 correct option.'
          });
        } else if (qType === 'COMPLEX_MULTIPLE_CHOICE' && opts.length < 3) {
          blockingErrors.push({
            code: 'INVALID_COMPLEX_MC_STATEMENTS',
            field: 'sections[' + sIdx + '].items[' + k + ']',
            message: 'Question "' + qbRec.question_code + '" (COMPLEX_MULTIPLE_CHOICE) must have at least 3 sub-statements.'
          });
        } else if (qType === 'MULTIPLE_SELECT' && correctCount < 1) {
          blockingErrors.push({
            code: 'INVALID_MULTISELECT_ANSWER_KEY',
            field: 'sections[' + sIdx + '].items[' + k + ']',
            message: 'Question "' + qbRec.question_code + '" (MULTIPLE_SELECT) must have at least 1 correct option.'
          });
        }
        if (hasUnpinnedOrderDep) {
          warnings.push({
            code: 'ORDER_DEPENDENT_OPTION_AUTO_LOCKED',
            message: 'Question "' + qbRec.question_code + '" contains order-dependent option text (e.g. "All of the above") -- option shuffling will be pinned automatically.'
          });
        }
      } else if (qType === 'NUMERIC_RESPONSE') {
        var gSpec = {};
        try {
          gSpec = JSON.parse(qvRec.grading_spec_private_json || '{}');
        } catch (e) {
          gSpec = {};
        }
        if (gSpec.matchMode === 'ACCEPTABLE_RANGE') {
          if (!isFinite(Number(gSpec.rangeMin)) || !isFinite(Number(gSpec.rangeMax)) || Number(gSpec.rangeMin) > Number(gSpec.rangeMax)) {
            blockingErrors.push({
              code: 'INVALID_NUMERIC_RANGE_KEY',
              field: 'sections[' + sIdx + '].items[' + k + ']',
              message: 'Question "' + qbRec.question_code + '" has an invalid numeric range specification.'
            });
          }
        } else if (!isFinite(Number(gSpec.targetValue))) {
          blockingErrors.push({
            code: 'INVALID_NUMERIC_TARGET_KEY',
            field: 'sections[' + sIdx + '].items[' + k + ']',
            message: 'Question "' + qbRec.question_code + '" is missing a valid numeric target value.'
          });
        }
      }
    }

    if (sec.selection_mode === 'QUESTION_POOL') {
      var drawCnt = Number(sec.pool_draw_count) || 0;
      if (drawCnt < 1) {
        blockingErrors.push({
          code: 'INVALID_POOL_DRAW_COUNT',
          field: 'sections[' + sIdx + '].poolDrawCount',
          message: 'Question pool section "' + sec.title + '" must draw at least 1 question (poolDrawCount >= 1).'
        });
      } else if (secItems.length < drawCnt) {
        blockingErrors.push({
          code: 'INSUFFICIENT_QUESTION_POOL_SUPPLY',
          field: 'sections[' + sIdx + '].poolDrawCount',
          message:
            'Question pool section "' +
            sec.title +
            '" requires drawing ' +
            drawCnt +
            ' questions, but only ' +
            secItems.length +
            ' candidate question(s) are in the pool.'
        });
      }
      if (Object.keys(poolPointValues).length > 1) {
        blockingErrors.push({
          code: 'NON_UNIFORM_POOL_ITEM_POINTS',
          field: 'sections[' + sIdx + '].items',
          message:
            'All candidate questions in pool section "' +
            sec.title +
            '" must have identical point values so every student receives an exam with the same maximum score.'
        });
      }
      var perItemBp = secItems.length > 0 ? (Number(secItems[0].points_bp) || 100) : 0;
      totalEffectiveQuestions += drawCnt;
      totalEffectivePointsBp += drawCnt * perItemBp;
    } else {
      for (var fi = 0; fi < secItems.length; fi++) {
        totalEffectiveQuestions += 1;
        totalEffectivePointsBp += Number(secItems[fi].points_bp) || 0;
      }
    }
  }

  if (totalEffectiveQuestions <= 0 || totalEffectivePointsBp <= 0) {
    blockingErrors.push({
      code: 'ZERO_EXAM_QUESTIONS_OR_POINTS',
      field: 'sections',
      message: 'Examination must have at least 1 question and a positive maximum score.'
    });
  }

  // Retake + Immediate Answer Key Exposure Warning
  var maxAtt = Number(examSetRow.max_attempts);
  var allowsMultipleAttempts = maxAtt === 0 || maxAtt > 1;
  if (
    allowsMultipleAttempts &&
    examSetRow.score_release_policy === 'IMMEDIATE_AUTO' &&
    examSetRow.explanation_release_policy === 'WITH_SCORE'
  ) {
    warnings.push({
      code: 'RETAKE_ANSWER_KEY_EXPOSURE_WARNING',
      message:
        'Retakes are enabled (maxAttempts = ' +
        (maxAtt === 0 ? 'Unlimited' : maxAtt) +
        ') while scores and explanations are set to release immediately upon submission. Students will see the answer key and explanations after their first attempt before taking subsequent retakes.'
    });
  }

  if (hasManualQuestions && examSetRow.score_release_policy === 'IMMEDIATE_AUTO') {
    warnings.push({
      code: 'MANUAL_GRADING_HOLDS_IMMEDIATE_PUBLICATION',
      message:
        'This examination includes written or manual short-answer questions. Even with Immediate Auto score release configured, final attempt scores will remain in AUTO_GRADED_PENDING_MANUAL until an instructor completes manual grading.'
    });
  }

  return {
    valid: blockingErrors.length === 0,
    blockingErrors: blockingErrors,
    warnings: warnings,
    computedSummary: {
      totalQuestionsCount: totalEffectiveQuestions,
      maxPointsBp: totalEffectivePointsBp,
      maxPointsDisplay: formatPointsBpDisplayPhase2_(totalEffectivePointsBp),
      sectionCount: secList.length,
      hasManualQuestions: hasManualQuestions
    }
  };
}

/**
 * Synchronizes a published ExamSet with the legacy Assessments table so native exams
 * appear cleanly in course assessment overviews and unify with AssessmentScores.
 */
function syncExamSetToAssessmentsTablePhase3_(examSetRow, examVerRow, adminUserId) {
  if (!examSetRow || !examSetRow.course_id) {
    return examSetRow ? examSetRow.assessment_id || '' : '';
  }
  var asmTbl = readSheetTable_('Assessments');
  var nowIso = nowUtcIso_();
  var markerPrefix = '[PB_NATIVE_EXAM_ID:' + examSetRow.exam_set_id + '] ';
  var descPlain =
    markerPrefix +
    'Native Online Examination (' +
    formatExamModeBadgeLabelPhase3_(examSetRow.exam_mode) +
    ', ' +
    (examVerRow ? examVerRow.total_questions_count : 0) +
    ' questions, ' +
    formatPointsBpDisplayPhase2_(examVerRow ? examVerRow.max_points_bp : 0) +
    ', ' +
    formatDurationMinutesLabelPhase3_(examSetRow.duration_minutes) +
    '). Take directly inside the Pattanabhumi Biology portal.';
  var descJson = plainTextToRichTextJson_(descPlain);

  var targetAsmId = examSetRow.assessment_id || '';
  var existingHit = targetAsmId ? asmTbl.byId[targetAsmId] : null;

  if (!existingHit) {
    for (var i = 0; i < asmTbl.records.length; i++) {
      var r = asmTbl.records[i];
      if (String(r.description_richtext_json || '').indexOf(markerPrefix) !== -1) {
        existingHit = asmTbl.byId[r.assessment_id];
        targetAsmId = r.assessment_id;
        break;
      }
    }
  }

  if (!existingHit) {
    var createdAsm = insertSheetRecord_(
      'Assessments',
      {
        assessment_id: generateEntityId_('asm_'),
        title: examSetRow.title,
        description_richtext_json: descJson,
        external_url: '',
        pdf_file_id: '',
        status: examSetRow.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
        created_at_utc: nowIso,
        updated_at_utc: nowIso
      },
      { skipLock: true }
    );
    targetAsmId = createdAsm.assessment_id;
  } else {
    updateSheetRecordById_(
      'Assessments',
      targetAsmId,
      {
        title: examSetRow.title,
        description_richtext_json: descJson,
        status: examSetRow.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
        updated_at_utc: nowIso
      },
      Number(existingHit.record.version),
      { skipLock: true }
    );
  }

  return targetAsmId;
}

/**
 * Computes a student's assignment, accommodation, availability, attempt, grading,
 * and publication status for a given ExamSet using orthogonal state dimensions.
 */
function evaluateStudentExamCatalogEntryPhase3_(
  examSetRow,
  examVerRow,
  allSectionsRows,
  allItemsRows,
  studentUserId,
  isEnrolledInCourse,
  assignmentsForExam,
  attemptsForStudentAndExam,
  coursesById,
  qbById,
  qvById,
  isAdminPreview
) {
  var nowMs = Date.now();
  var courseHit = examSetRow.course_id && coursesById ? coursesById[examSetRow.course_id] : null;
  var courseRec = courseHit ? courseHit.record : null;

  // Check assignment & per-student accommodations
  var hasCourseAssignment = examSetRow.assignment_scope === 'COURSE_ENROLLED' && isEnrolledInCourse;
  var hasExplicitStudentAssignment = false;
  var isExplicitlyRevokedForStudent = false;
  var extraTimeMinutes = 0;
  var extraAttemptsGranted = 0;
  var openAtOverrideUtc = '';
  var overrideDeadlineUtc = '';

  for (var i = 0; i < assignmentsForExam.length; i++) {
    var asg = assignmentsForExam[i];
    if (asg.target_type === 'COURSE' && asg.course_id === examSetRow.course_id) {
      if (asg.assignment_status === 'ASSIGNED' && isEnrolledInCourse) {
        hasCourseAssignment = true;
      } else if (asg.assignment_status === 'REVOKED') {
        hasCourseAssignment = false;
      }
    } else if (asg.target_type === 'STUDENT' && asg.student_user_id === studentUserId) {
      if (asg.assignment_status === 'ASSIGNED') {
        hasExplicitStudentAssignment = true;
        extraTimeMinutes = Math.max(extraTimeMinutes, Number(asg.extra_time_minutes) || 0);
        extraAttemptsGranted = Math.max(extraAttemptsGranted, Number(asg.extra_attempts_granted) || 0);
        if (asg.open_at_override_utc) openAtOverrideUtc = asg.open_at_override_utc;
        if (asg.override_deadline_utc) overrideDeadlineUtc = asg.override_deadline_utc;
      } else if (asg.assignment_status === 'REVOKED') {
        isExplicitlyRevokedForStudent = true;
      }
    }
  }

  var isAuthorizedForStudent = Boolean(
    isAdminPreview ||
      (!isExplicitlyRevokedForStudent &&
        (hasExplicitStudentAssignment ||
          (examSetRow.assignment_scope === 'COURSE_ENROLLED' && hasCourseAssignment)))
  );
  if (!isAuthorizedForStudent) {
    return null;
  }

  var baseDurationMinutes = Number(examSetRow.duration_minutes) || 0;
  var effectiveDurationMinutes =
    baseDurationMinutes > 0 ? baseDurationMinutes + extraTimeMinutes : 0;

  var effectiveOpenAtUtc = openAtOverrideUtc || examSetRow.open_at_utc || '';
  var effectiveCloseAtUtc = overrideDeadlineUtc || examSetRow.close_at_utc || '';

  var baseMaxAttempts = Number(examSetRow.max_attempts);
  var isUnlimitedAttempts = baseMaxAttempts === 0 && examSetRow.exam_mode === 'PRACTICE';
  var effectiveMaxAttempts = isUnlimitedAttempts
    ? 0
    : Math.max(1, (baseMaxAttempts || 1) + extraAttemptsGranted);

  // Inspect student's attempts for this exam
  var validAttempts = [];
  var inProgressAttempt = null;
  var submittedAttempts = [];
  var copyInvalidatedAttemptsCount = 0;
  var latestCopyInvalidatedAttempt = null;

  for (var a = 0; a < attemptsForStudentAndExam.length; a++) {
    var att = attemptsForStudentAndExam[a];
    if (att.attempt_status === 'INVALIDATED') continue;
    if (att.attempt_status === 'INVALIDATED_COPY_POLICY') {
      var isOverturned =
        att.invalidation_overturned === true ||
        String(att.invalidation_overturned).toLowerCase() === 'true';
      if (!isOverturned) {
        copyInvalidatedAttemptsCount += 1;
        latestCopyInvalidatedAttempt = att;
      }
      continue;
    }
    validAttempts.push(att);
    if (att.attempt_status === 'IN_PROGRESS') {
      inProgressAttempt = att;
    } else if (
      att.attempt_status === 'SUBMITTED' ||
      att.attempt_status === 'EXPIRED_SUBMITTED'
    ) {
      submittedAttempts.push(att);
    }
  }

  validAttempts.sort(function (x, y) {
    return (Number(x.attempt_number) || 0) - (Number(y.attempt_number) || 0);
  });
  submittedAttempts.sort(function (x, y) {
    return (Number(x.attempt_number) || 0) - (Number(y.attempt_number) || 0);
  });

  var attemptsUsed =
    submittedAttempts.length + copyInvalidatedAttemptsCount + (inProgressAttempt ? 1 : 0);
  var remainingAttempts = isUnlimitedAttempts
    ? 999
    : Math.max(0, effectiveMaxAttempts - attemptsUsed);

  var latestSubmitted =
    submittedAttempts.length > 0
      ? submittedAttempts[submittedAttempts.length - 1]
      : null;

  // 1. Orthogonal Dimension: Availability State
  var availabilityState = 'AVAILABLE';
  var openMs = effectiveOpenAtUtc ? Date.parse(effectiveOpenAtUtc) : NaN;
  var closeMs = effectiveCloseAtUtc ? Date.parse(effectiveCloseAtUtc) : NaN;

  if (examSetRow.status === 'CLOSED' || examSetRow.status === 'ARCHIVED') {
    availabilityState = 'CLOSED';
  } else if (!isNaN(openMs) && nowMs < openMs) {
    availabilityState = 'UPCOMING';
  } else if (!isNaN(closeMs) && nowMs >= closeMs) {
    availabilityState = 'CLOSED';
  } else if (inProgressAttempt) {
    availabilityState = 'IN_PROGRESS_RESUMABLE';
  } else if (!isUnlimitedAttempts && remainingAttempts <= 0) {
    availabilityState = 'ATTEMPTS_EXHAUSTED';
  } else {
    availabilityState = 'AVAILABLE';
  }

  // 2. Orthogonal Dimension: Attempt Lifecycle Status
  var attemptStatusSummary = 'NOT_STARTED';
  if (inProgressAttempt) {
    attemptStatusSummary = 'IN_PROGRESS';
  } else if (latestSubmitted) {
    attemptStatusSummary = latestSubmitted.attempt_status;
  }

  // 3. Orthogonal Dimension: Grading Status
  var gradingStatusSummary = 'NOT_APPLICABLE';
  if (latestSubmitted) {
    gradingStatusSummary = latestSubmitted.grading_status || 'NOT_GRADED';
  }

  // 4. Orthogonal Dimension: Score Publication Status (evaluated at read time)
  var publicationStatusSummary = 'UNPUBLISHED';
  var explanationStatusSummary = 'WITHHELD';
  var publishedScoreSummary = null;

  if (latestSubmitted) {
    publicationStatusSummary = latestSubmitted.publication_status || 'UNPUBLISHED';
    explanationStatusSummary = latestSubmitted.explanation_status || 'WITHHELD';

    // Read-time scheduled check
    var isScoreReleasedNow = publicationStatusSummary === 'PUBLISHED';
    if (
      publicationStatusSummary === 'SCHEDULED' &&
      examSetRow.score_release_at_utc &&
      nowMs >= Date.parse(examSetRow.score_release_at_utc) &&
      gradingStatusSummary === 'GRADED'
    ) {
      isScoreReleasedNow = true;
      publicationStatusSummary = 'PUBLISHED';
    } else if (
      examSetRow.score_release_policy === 'AFTER_CLOSE' &&
      !isNaN(closeMs) &&
      nowMs >= closeMs &&
      gradingStatusSummary === 'GRADED' &&
      publicationStatusSummary !== 'WITHHELD'
    ) {
      isScoreReleasedNow = true;
      publicationStatusSummary = 'PUBLISHED';
    }

    if (isScoreReleasedNow) {
      // Aggregate across published attempts according to aggregation_rule
      var chosenAttempt = latestSubmitted;
      var rule = examSetRow.aggregation_rule || 'BEST_PUBLISHED';
      var publishedAttemptsList = [];
      for (var pa = 0; pa < submittedAttempts.length; pa++) {
        var cand = submittedAttempts[pa];
        if (cand.grading_status === 'GRADED' || cand.grading_status === 'REGRADED') {
          publishedAttemptsList.push(cand);
        }
      }
      if (publishedAttemptsList.length > 0) {
        if (rule === 'FIRST_PUBLISHED') {
          chosenAttempt = publishedAttemptsList[0];
        } else if (rule === 'LATEST_PUBLISHED') {
          chosenAttempt = publishedAttemptsList[publishedAttemptsList.length - 1];
        } else {
          // BEST_PUBLISHED
          chosenAttempt = publishedAttemptsList[0];
          for (var bi = 1; bi < publishedAttemptsList.length; bi++) {
            if (Number(publishedAttemptsList[bi].total_score_bp) >= Number(chosenAttempt.total_score_bp)) {
              chosenAttempt = publishedAttemptsList[bi];
            }
          }
        }
        var scBp = Number(chosenAttempt.total_score_bp) || 0;
        var mxBp = Number(chosenAttempt.max_score_bp) || Number(examVerRow ? examVerRow.max_points_bp : 100);
        var pctVal = mxBp > 0 ? Math.round((scBp / mxBp) * 1000) / 10 : 0;
        publishedScoreSummary = {
          attemptId: chosenAttempt.attempt_id,
          attemptNumber: Number(chosenAttempt.attempt_number) || 1,
          aggregationRule: rule,
          scoreBp: scBp,
          maxScoreBp: mxBp,
          scoreDisplay: formatPointsBpDisplayPhase2_(scBp) + ' / ' + formatPointsBpDisplayPhase2_(mxBp),
          percentageFormatted: pctVal.toFixed(1) + '%',
          percentageValue: pctVal,
          passedFlag: Boolean(chosenAttempt.passed_flag)
        };
      }
    }
  }

  var completionState = 'NOT_STARTED';
  if (inProgressAttempt) {
    completionState = 'IN_PROGRESS';
  } else if (submittedAttempts.length > 0) {
    completionState = 'COMPLETED';
  }

  var canStartNewAttempt =
    availabilityState === 'AVAILABLE' &&
    !inProgressAttempt &&
    (isUnlimitedAttempts || remainingAttempts > 0);
  var canResumeAttempt = availabilityState === 'IN_PROGRESS_RESUMABLE' && Boolean(inProgressAttempt);
  var canViewPublishedResult = Boolean(publishedScoreSummary);

  var primaryActionType = 'VIEW_INSTRUCTIONS';
  var primaryActionLabel = 'View Instructions & Start';
  if (canResumeAttempt) {
    primaryActionType = 'RESUME_ATTEMPT';
    primaryActionLabel = 'Resume Active Attempt';
  } else if (availabilityState === 'UPCOMING') {
    primaryActionType = 'VIEW_INSTRUCTIONS';
    primaryActionLabel = 'Preview Rules (Upcoming)';
  } else if (availabilityState === 'CLOSED' || availabilityState === 'ATTEMPTS_EXHAUSTED') {
    if (canViewPublishedResult) {
      primaryActionType = 'VIEW_RESULT';
      primaryActionLabel = 'View Published Result';
    } else {
      primaryActionType = 'VIEW_INSTRUCTIONS';
      primaryActionLabel = 'View Exam Summary';
    }
  } else if (submittedAttempts.length > 0 && canStartNewAttempt) {
    primaryActionType = 'VIEW_INSTRUCTIONS';
    primaryActionLabel = 'Retake Exam / View Summary';
  }

  var descDoc = parseStoredRichTextJsonSafe_(examSetRow.description_richtext_json);
  var instDoc = parseStoredRichTextJsonSafe_(examSetRow.instructions_richtext_json);
  var verStructure = buildExamVersionStructureBundlePhase3_(
    examSetRow,
    examVerRow,
    allSectionsRows,
    allItemsRows,
    qbById,
    qvById,
    [],
    null,
    false
  );

  return {
    assessmentKind: 'NATIVE_EXAM',
    assessmentKindLabel: 'Native Online Examination',
    examSetId: examSetRow.exam_set_id,
    assessmentId: examSetRow.assessment_id || '',
    courseId: examSetRow.course_id || '',
    courseCode: courseRec ? courseRec.course_code : '',
    courseTitle: courseRec ? courseRec.title : '',
    examCode: examSetRow.exam_code,
    title: examSetRow.title,
    descriptionRichText: descDoc,
    descriptionPlainText: extractPlainTextFromRichTextDocPhase2_(descDoc),
    instructionsRichText: instDoc,
    instructionsPlainText: extractPlainTextFromRichTextDocPhase2_(instDoc),
    coverImageFileId: examSetRow.cover_image_file_id || '',
    examMode: examSetRow.exam_mode,
    examModeLabel: formatExamModeBadgeLabelPhase3_(examSetRow.exam_mode),
    activeExamVersionId: examSetRow.active_exam_version_id || '',
    versionNo: verStructure.versionNo,
    questionCount: verStructure.totalQuestionsCount,
    sectionCount: verStructure.sections.length,
    maxPointsBp: verStructure.maxPointsBp,
    maxPointsDisplay: verStructure.maxPointsDisplay,
    negativeMarkingEnabled: verStructure.negativeMarkingEnabled,
    navigationMode: examSetRow.navigation_mode || 'FREE',
    durationMinutes: baseDurationMinutes,
    effectiveDurationMinutes: effectiveDurationMinutes,
    durationLabel: formatDurationMinutesLabelPhase3_(effectiveDurationMinutes),
    graceSeconds: Number(examSetRow.grace_seconds) || 15,
    hasTimeAccommodation: extraTimeMinutes > 0,
    extraTimeMinutes: extraTimeMinutes,
    openAtUtc: effectiveOpenAtUtc,
    openAtBangkok: effectiveOpenAtUtc ? formatBangkokTimestamp_(effectiveOpenAtUtc) : 'Immediately Available',
    closeAtUtc: effectiveCloseAtUtc,
    closeAtBangkok: effectiveCloseAtUtc ? formatBangkokTimestamp_(effectiveCloseAtUtc) : 'No Closing Deadline',
    allowedAttempts: isUnlimitedAttempts ? 'UNLIMITED' : effectiveMaxAttempts,
    allowedAttemptsDisplay: isUnlimitedAttempts ? 'Unlimited' : String(effectiveMaxAttempts),
    attemptsUsed: attemptsUsed,
    remainingAttempts: isUnlimitedAttempts ? 'UNLIMITED' : remainingAttempts,
    aggregationRule: examSetRow.aggregation_rule || 'BEST_PUBLISHED',
    scoreReleasePolicy: examSetRow.score_release_policy || 'MANUAL_ADMIN',
    explanationReleasePolicy: examSetRow.explanation_release_policy || 'WITH_SCORE',
    passThresholdPct: Number(examSetRow.pass_threshold_pct) || 60,
    // 5 Orthogonal State Dimensions
    examLifecycleStatus: examSetRow.status,
    availabilityState: availabilityState,
    completionState: completionState,
    attemptStatusSummary: attemptStatusSummary,
    gradingStatusSummary: gradingStatusSummary,
    publicationStatusSummary: publicationStatusSummary,
    explanationStatusSummary: explanationStatusSummary,
    // Action & Published Score Summary (Read-Time Filtered)
    canStartNewAttempt: canStartNewAttempt,
    canResumeAttempt: canResumeAttempt,
    activeAttemptId: inProgressAttempt ? inProgressAttempt.attempt_id : '',
    canViewPublishedResult: canViewPublishedResult,
    primaryActionType: primaryActionType,
    primaryActionLabel: primaryActionLabel,
    publishedScoreSummary: publishedScoreSummary,
    sectionsOverview: verStructure.sections,
    questionTypeBreakdown: verStructure.questionTypeBreakdown
  };
}

/**
 * Lists all ExamSets for the Administrator Exam Builder ('admin.exams.list').
 */
function handleAdminListExamsPhase3_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase3SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var filterCourseId = sanitizeSingleLineTextStep7_(req.courseId, 64);
  var filterMode = String(req.examMode || 'ALL').trim().toUpperCase();
  var filterStatus = String(req.status || 'ALL').trim().toUpperCase();
  var searchQ = sanitizeSingleLineTextStep7_(req.search, 120).toLowerCase();

  var exsTbl = readSheetTable_('ExamSets');
  var exvTbl = readSheetTable_('ExamVersions');
  var exsctTbl = readSheetTable_('ExamSections');
  var exiTbl = readSheetTable_('ExamItems');
  var exaTbl = readSheetTable_('ExamAssignments');
  var attTbl = readSheetTable_('ExamAttempts');
  var coursesTbl = readSheetTable_('Courses');
  var usersTbl = readSheetTable_('Users');
  var qbTbl = readSheetTable_('QuestionBank');
  var qvTbl = readSheetTable_('QuestionVersions');
  var qoTbl = readSheetTable_('QuestionOptions');
  var stimTbl = readSheetTable_('SharedStimuli');
  var filesTbl = readSheetTable_('Files');

  var assignmentsByExam = {};
  for (var ai = 0; ai < exaTbl.records.length; ai++) {
    var aRow = exaTbl.records[ai];
    if (!assignmentsByExam[aRow.exam_set_id]) {
      assignmentsByExam[aRow.exam_set_id] = [];
    }
    var stuHit = aRow.student_user_id ? usersTbl.byId[aRow.student_user_id] : null;
    var crsHit = aRow.course_id ? coursesTbl.byId[aRow.course_id] : null;
    assignmentsByExam[aRow.exam_set_id].push({
      assignmentId: aRow.assignment_id,
      examSetId: aRow.exam_set_id,
      courseId: aRow.course_id || '',
      courseCode: crsHit ? crsHit.record.course_code : '',
      targetType: aRow.target_type,
      studentUserId: aRow.student_user_id || '',
      studentUsername: stuHit ? stuHit.record.username_display || stuHit.record.username_lower : '',
      studentFullName: stuHit ? stuHit.record.full_name : '',
      assignmentStatus: aRow.assignment_status,
      openAtOverrideUtc: aRow.open_at_override_utc || '',
      overrideDeadlineUtc: aRow.override_deadline_utc || '',
      extraTimeMinutes: Number(aRow.extra_time_minutes) || 0,
      extraAttemptsGranted: Number(aRow.extra_attempts_granted) || 0,
      accommodationReason: aRow.accommodation_reason || '',
      updatedAtBangkok: formatBangkokTimestamp_(aRow.updated_at_utc),
      version: Number(aRow.version) || 1
    });
  }

  var attemptCountsByExam = {};
  for (var ati = 0; ati < attTbl.records.length; ati++) {
    var att = attTbl.records[ati];
    if (att.attempt_status !== 'INVALIDATED') {
      attemptCountsByExam[att.exam_set_id] = (attemptCountsByExam[att.exam_set_id] || 0) + 1;
    }
  }

  var countsByStatus = { DRAFT: 0, PUBLISHED: 0, CLOSED: 0, ARCHIVED: 0 };
  var examDtos = [];

  for (var i = exsTbl.records.length - 1; i >= 0; i--) {
    var exRow = exsTbl.records[i];
    if (countsByStatus[exRow.status] !== undefined) {
      countsByStatus[exRow.status] += 1;
    }
    if (filterCourseId && filterCourseId !== 'ALL' && exRow.course_id !== filterCourseId) continue;
    if (filterMode !== 'ALL' && exRow.exam_mode !== filterMode) continue;
    if (filterStatus !== 'ALL' && exRow.status !== filterStatus) continue;

    var targetVerId = exRow.draft_exam_version_id || exRow.active_exam_version_id;
    var verHit = targetVerId ? exvTbl.byId[targetVerId] : null;
    var verRow = verHit ? verHit.record : null;

    var activeVerHit = exRow.active_exam_version_id ? exvTbl.byId[exRow.active_exam_version_id] : null;
    var activeVerRow = activeVerHit ? activeVerHit.record : null;

    var verBundle = buildExamVersionStructureBundlePhase3_(
      exRow,
      verRow,
      exsctTbl.records,
      exiTbl.records,
      qbTbl.byId,
      qvTbl.byId,
      qoTbl.records,
      stimTbl.byId,
      true
    );

    var validationReport = evaluateExamPublicationReadinessPhase3_(
      exRow,
      verRow,
      exsctTbl.records,
      exiTbl.records,
      qbTbl.byId,
      qvTbl.byId,
      qoTbl.records,
      filesTbl.byId
    );

    var cHit = exRow.course_id ? coursesTbl.byId[exRow.course_id] : null;
    var cRec = cHit ? cHit.record : null;
    var descDoc = parseStoredRichTextJsonSafe_(exRow.description_richtext_json);
    var instDoc = parseStoredRichTextJsonSafe_(exRow.instructions_richtext_json);

    var dto = {
      examSetId: exRow.exam_set_id,
      assessmentId: exRow.assessment_id || '',
      courseId: exRow.course_id || '',
      courseCode: cRec ? cRec.course_code : '',
      courseTitle: cRec ? cRec.title : 'Unassigned / Multi-Course',
      examCode: exRow.exam_code,
      title: exRow.title,
      descriptionRichText: descDoc,
      descriptionPlainText: extractPlainTextFromRichTextDocPhase2_(descDoc),
      instructionsRichText: instDoc,
      instructionsPlainText: extractPlainTextFromRichTextDocPhase2_(instDoc),
      coverImageFileId: exRow.cover_image_file_id || '',
      examMode: exRow.exam_mode,
      examModeLabel: formatExamModeBadgeLabelPhase3_(exRow.exam_mode),
      activeExamVersionId: exRow.active_exam_version_id || '',
      activeVersionNo: activeVerRow ? Number(activeVerRow.version_no) || 1 : 0,
      draftExamVersionId: exRow.draft_exam_version_id || '',
      latestVersionNo: Number(exRow.latest_version_no) || 1,
      assignmentScope: exRow.assignment_scope || 'COURSE_ENROLLED',
      openAtUtc: exRow.open_at_utc || '',
      openAtBangkok: exRow.open_at_utc ? formatBangkokTimestamp_(exRow.open_at_utc) : '',
      closeAtUtc: exRow.close_at_utc || '',
      closeAtBangkok: exRow.close_at_utc ? formatBangkokTimestamp_(exRow.close_at_utc) : '',
      durationMinutes: Number(exRow.duration_minutes) || 0,
      durationLabel: formatDurationMinutesLabelPhase3_(exRow.duration_minutes),
      graceSeconds: Number(exRow.grace_seconds) || 15,
      maxAttempts: Number(exRow.max_attempts) || 0,
      retakeCooldownMinutes: Number(exRow.retake_cooldown_minutes) || 0,
      navigationMode: exRow.navigation_mode || 'FREE',
      aggregationRule: exRow.aggregation_rule || 'BEST_PUBLISHED',
      scoreReleasePolicy: exRow.score_release_policy || 'MANUAL_ADMIN',
      scoreReleaseAtUtc: exRow.score_release_at_utc || '',
      explanationReleasePolicy: exRow.explanation_release_policy || 'WITH_SCORE',
      explanationReleaseAtUtc: exRow.explanation_release_at_utc || '',
      passThresholdPct: Number(exRow.pass_threshold_pct) || 60,
      randomizeQuestions: Boolean(exRow.randomize_questions),
      randomizeOptions: Boolean(exRow.randomize_options),
      allowPerQuestionPracticeFeedback: Boolean(exRow.allow_per_question_practice_feedback),
      status: exRow.status,
      totalQuestionsCount: verBundle.totalQuestionsCount,
      maxPointsBp: verBundle.maxPointsBp,
      maxPointsDisplay: verBundle.maxPointsDisplay,
      sectionCount: verBundle.sections.length,
      sections: verBundle.sections,
      questionTypeBreakdown: verBundle.questionTypeBreakdown,
      assignments: assignmentsByExam[exRow.exam_set_id] || [],
      attemptsCount: attemptCountsByExam[exRow.exam_set_id] || 0,
      validationReport: validationReport,
      updatedAtUtc: exRow.updated_at_utc,
      updatedAtBangkok: formatBangkokTimestamp_(exRow.updated_at_utc),
      version: Number(exRow.version) || 1
    };

    if (searchQ) {
      var hay = (
        dto.examCode +
        ' ' +
        dto.title +
        ' ' +
        dto.courseCode +
        ' ' +
        dto.courseTitle +
        ' ' +
        dto.descriptionPlainText
      ).toLowerCase();
      if (hay.indexOf(searchQ) === -1) continue;
    }

    examDtos.push(dto);
  }

  return {
    exams: examDtos,
    summary: {
      totalExams: exsTbl.records.length,
      countsByStatus: countsByStatus
    }
  };
}

/**
 * Creates or updates an ExamSet and its working DRAFT ExamVersion, ExamSections, and ExamItems
 * ('admin.exams.saveDraft'). Preserves any previously PUBLISHED ExamVersion immutably.
 */
function handleAdminSaveExamDraftPhase3_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamIntegrityPhaseASheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var fieldErrors = {};

  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  var isCreate = !examSetId;

  var examCode = sanitizeSingleLineTextStep7_(req.examCode, 48).toUpperCase();
  if (!examCode || !/^[A-Z0-9][A-Z0-9_-]{2,47}$/.test(examCode)) {
    fieldErrors.examCode =
      'Exam code is required (3-48 uppercase letters, digits, hyphens, or underscores, e.g. BIO-MOCK-ALEVEL-01).';
  }

  var title = sanitizeSingleLineTextStep7_(req.title, 180);
  if (!title || title.length < 3) {
    fieldErrors.title = 'Examination title is required (3 to 180 characters).';
  }

  var courseId = sanitizeSingleLineTextStep7_(req.courseId, 64);
  if (courseId) {
    var coursesTbl = readSheetTable_('Courses');
    if (!coursesTbl.byId[courseId]) {
      fieldErrors.courseId = 'Selected course "' + courseId + '" was not found.';
    }
  }

  var examMode = String(req.examMode || 'PRACTICE').trim().toUpperCase();
  if (!PB_EXAM_MODES_PHASE3_[examMode]) {
    fieldErrors.examMode = 'examMode must be PRACTICE, MOCK_EXAM, or ASSIGNED_ASSESSMENT.';
  }

  var assignmentScope = String(req.assignmentScope || 'COURSE_ENROLLED').trim().toUpperCase();
  if (!PB_EXAM_ASSIGNMENT_SCOPES_PHASE3_[assignmentScope]) {
    fieldErrors.assignmentScope = 'assignmentScope must be COURSE_ENROLLED or SELECTED_STUDENTS.';
  }

  var navigationMode = String(req.navigationMode || 'FREE').trim().toUpperCase();
  if (!PB_EXAM_NAVIGATION_MODES_PHASE3_[navigationMode]) {
    navigationMode = 'FREE';
  }

  var aggregationRule = String(req.aggregationRule || 'BEST_PUBLISHED').trim().toUpperCase();
  if (!PB_EXAM_AGGREGATION_RULES_PHASE3_[aggregationRule]) {
    aggregationRule = 'BEST_PUBLISHED';
  }

  var scoreReleasePolicy = String(
    req.scoreReleasePolicy || (examMode === 'PRACTICE' ? 'IMMEDIATE_AUTO' : 'MANUAL_ADMIN')
  )
    .trim()
    .toUpperCase();
  if (!PB_EXAM_SCORE_RELEASE_POLICIES_PHASE3_[scoreReleasePolicy]) {
    fieldErrors.scoreReleasePolicy =
      'scoreReleasePolicy must be IMMEDIATE_AUTO, MANUAL_ADMIN, SCHEDULED, or AFTER_CLOSE.';
  }

  var explanationReleasePolicy = String(
    req.explanationReleasePolicy || (examMode === 'PRACTICE' ? 'WITH_SCORE' : 'MANUAL_ADMIN')
  )
    .trim()
    .toUpperCase();
  if (!PB_EXAM_EXPLANATION_RELEASE_POLICIES_PHASE3_[explanationReleasePolicy]) {
    fieldErrors.explanationReleasePolicy =
      'explanationReleasePolicy must be WITH_SCORE, MANUAL_ADMIN, SCHEDULED, AFTER_CLOSE, or NEVER.';
  }

  var durationMinutes = Math.max(0, Math.min(600, parseInt(req.durationMinutes, 10) || 0));
  if (examMode === 'MOCK_EXAM' && durationMinutes <= 0) {
    fieldErrors.durationMinutes = 'Mock Examinations require a positive time limit in minutes (e.g. 45 or 90).';
  }

  var graceSeconds =
    req.graceSeconds !== undefined && req.graceSeconds !== null && req.graceSeconds !== ''
      ? Math.max(0, Math.min(120, parseInt(req.graceSeconds, 10) || 0))
      : 15;

  var maxAttempts =
    req.maxAttempts !== undefined && req.maxAttempts !== null && req.maxAttempts !== ''
      ? Math.max(0, Math.min(100, parseInt(req.maxAttempts, 10) || 0))
      : examMode === 'PRACTICE'
      ? 0
      : 1;
  if (examMode !== 'PRACTICE' && maxAttempts < 1) {
    maxAttempts = 1;
  }

  var retakeCooldownMinutes = Math.max(0, Math.min(10080, parseInt(req.retakeCooldownMinutes, 10) || 0));
  var passThresholdPct =
    req.passThresholdPct !== undefined && req.passThresholdPct !== null && req.passThresholdPct !== ''
      ? Math.max(0, Math.min(100, parseInt(req.passThresholdPct, 10) || 60))
      : 60;

  var randomizeQuestions = Boolean(req.randomizeQuestions);
  var randomizeOptions = Boolean(req.randomizeOptions);
  var allowPerQuestionPracticeFeedback =
    examMode === 'PRACTICE' ? Boolean(req.allowPerQuestionPracticeFeedback) : false;

  var openAtUtc = parseOptionalUtcTimestampPhase3_(req.openAtUtc, 'openAtUtc', 'Opening time', fieldErrors);
  var closeAtUtc = parseOptionalUtcTimestampPhase3_(req.closeAtUtc, 'closeAtUtc', 'Closing time', fieldErrors);
  if (openAtUtc && closeAtUtc && Date.parse(openAtUtc) >= Date.parse(closeAtUtc)) {
    fieldErrors.closeAtUtc = 'Closing time must be strictly after opening time.';
  }

  var scoreReleaseAtUtc = parseOptionalUtcTimestampPhase3_(
    req.scoreReleaseAtUtc,
    'scoreReleaseAtUtc',
    'Scheduled score release time',
    fieldErrors
  );
  var explanationReleaseAtUtc = parseOptionalUtcTimestampPhase3_(
    req.explanationReleaseAtUtc,
    'explanationReleaseAtUtc',
    'Scheduled explanation release time',
    fieldErrors
  );

  var descValidated = null;
  try {
    descValidated = validateAndNormalizeRichTextInput_(
      req.descriptionRichText || 'Complete this biology examination directly inside the portal.',
      'descriptionRichText',
      'Examination description',
      false
    );
  } catch (e) {
    fieldErrors.descriptionRichText = String(e.message || e);
  }

  var instValidated = null;
  try {
    instValidated = validateAndNormalizeRichTextInput_(
      req.instructionsRichText ||
        'Read each question carefully. Your answers are saved automatically as you navigate between questions. Submit before the countdown timer expires.',
      'instructionsRichText',
      'Examination instructions',
      false
    );
  } catch (e) {
    fieldErrors.instructionsRichText = String(e.message || e);
  }

  var coverImageFileId = validateOptionalDriveFileRefStep7_(
    req.coverImageFileId,
    'coverImageFileId',
    'Examination cover image',
    fieldErrors,
    ['EXAM_COVER_IMAGE', 'COURSE_COVER', 'COURSE_IMAGE', 'RICHTEXT_IMAGE', 'CARD_IMAGE']
  );

  // Normalize sections & items
  var rawSections = Array.isArray(req.sections) ? req.sections : [];
  if (rawSections.length === 0) {
    fieldErrors.sections = 'At least one examination section is required.';
  }

  var qbTbl = readSheetTable_('QuestionBank');
  var qvTbl = readSheetTable_('QuestionVersions');
  var qoTbl = readSheetTable_('QuestionOptions');

  var optionsByQvId = {};
  for (var oi = 0; oi < qoTbl.records.length; oi++) {
    var op = qoTbl.records[oi];
    if (!optionsByQvId[op.question_version_id]) {
      optionsByQvId[op.question_version_id] = [];
    }
    optionsByQvId[op.question_version_id].push(op);
  }

  var normalizedSections = [];
  var totalQuestionsCount = 0;
  var totalMaxPointsBp = 0;
  var anyNegativeMarking = false;

  for (var sIdx = 0; sIdx < rawSections.length && sIdx < 20; sIdx++) {
    var rawSec = rawSections[sIdx] || {};
    var secTitle =
      sanitizeSingleLineTextStep7_(rawSec.title, 140) || 'Part ' + (sIdx + 1);
    var secSelectionMode = String(rawSec.selectionMode || 'FIXED_ITEMS').trim().toUpperCase();
    if (!PB_EXAM_SECTION_SELECTION_MODES_PHASE3_[secSelectionMode]) {
      secSelectionMode = 'FIXED_ITEMS';
    }
    var secInst = validateAndNormalizeRichTextInput_(
      rawSec.instructionsRichText || '',
      'sectionInstructions_' + sIdx,
      'Section instructions',
      false
    );
    var rawItems = Array.isArray(rawSec.items) ? rawSec.items : [];
    // Also support poolQuestionIds shorthand array if passed from simple builder UI
    if (rawItems.length === 0 && Array.isArray(rawSec.questionIds)) {
      for (var qk = 0; qk < rawSec.questionIds.length; qk++) {
        rawItems.push({ questionId: rawSec.questionIds[qk] });
      }
    }

    if (rawItems.length === 0) {
      fieldErrors['sections_' + sIdx] = 'Section "' + secTitle + '" must contain at least one question.';
      continue;
    }

    var normItems = [];
    var seenInSec = {};
    for (var k = 0; k < rawItems.length && k < 150; k++) {
      var rawIt = rawItems[k];
      var qId =
        typeof rawIt === 'string'
          ? sanitizeSingleLineTextStep7_(rawIt, 64)
          : sanitizeSingleLineTextStep7_(rawIt && rawIt.questionId, 64);
      if (!qId || seenInSec[qId]) continue;
      seenInSec[qId] = true;

      var qbHit = qbTbl.byId[qId];
      if (!qbHit) {
        fieldErrors['sections_' + sIdx + '_item_' + k] =
          'Referenced question "' + qId + '" does not exist in QuestionBank.';
        continue;
      }
      var qbRec = qbHit.record;
      var requestedQvId =
        rawIt && typeof rawIt === 'object' && rawIt.questionVersionId
          ? sanitizeSingleLineTextStep7_(rawIt.questionVersionId, 64)
          : qbRec.active_version_id;
      var qvHit = qvTbl.byId[requestedQvId] || qvTbl.byId[qbRec.active_version_id];
      if (!qvHit) {
        fieldErrors['sections_' + sIdx + '_item_' + k] =
          'Active version for question "' + qbRec.question_code + '" was not found.';
        continue;
      }
      var qvRec = qvHit.record;

      var itemPointsBp = Number(qvRec.default_points_bp) || 100;
      if (rawIt && typeof rawIt === 'object' && rawIt.points !== undefined && rawIt.points !== '') {
        itemPointsBp = parsePointsToBpPhase2_(
          rawIt.points,
          'itemPoints_' + sIdx + '_' + k,
          'Question points',
          false,
          fieldErrors
        );
      } else if (rawIt && typeof rawIt === 'object' && rawIt.pointsBp !== undefined) {
        itemPointsBp = Math.max(25, parseInt(rawIt.pointsBp, 10) || 100);
      }

      var itemNegBp = Number(qvRec.negative_points_bp) || 0;
      if (rawIt && typeof rawIt === 'object' && rawIt.negativePoints !== undefined && rawIt.negativePoints !== '') {
        itemNegBp = parsePointsToBpPhase2_(
          rawIt.negativePoints,
          'itemNegPoints_' + sIdx + '_' + k,
          'Negative points',
          true,
          fieldErrors
        );
      } else if (rawIt && typeof rawIt === 'object' && rawIt.negativePointsBp !== undefined) {
        itemNegBp = Math.max(0, parseInt(rawIt.negativePointsBp, 10) || 0);
      }
      if (itemNegBp > 0) anyNegativeMarking = true;

      // Auto-detect order-dependent options ("All of the above")
      var lockOptOrder = Boolean(
        (rawIt && rawIt.lockOptionOrder) || qvRec.lock_option_order
      );
      var qOpts = optionsByQvId[qvRec.question_version_id] || [];
      for (var oc = 0; oc < qOpts.length; oc++) {
        var oPlain = extractPlainTextFromRichTextDocPhase2_(
          parseStoredRichTextJsonSafe_(qOpts[oc].content_richtext_json)
        );
        if (isOrderDependentOptionTextPhase2_(oPlain) && qOpts[oc].pin_position === 'NONE') {
          lockOptOrder = true;
        }
      }

      normItems.push({
        question_id: qbRec.question_id,
        question_version_id: qvRec.question_version_id,
        sort_order: (k + 1) * 10,
        lock_item_position: Boolean(rawIt && rawIt.lockItemPosition),
        lock_option_order: lockOptOrder,
        points_bp: itemPointsBp,
        negative_points_bp: itemNegBp,
        is_pool_candidate: secSelectionMode === 'QUESTION_POOL',
        pool_group_tag: sanitizeSingleLineTextStep7_(rawIt && rawIt.poolGroupTag, 48)
      });
    }

    var poolDrawCount = 0;
    var secQuestionsCount = normItems.length;
    var secMaxPointsBp = 0;

    if (secSelectionMode === 'QUESTION_POOL') {
      poolDrawCount = Math.max(1, parseInt(rawSec.poolDrawCount, 10) || 1);
      if (poolDrawCount > normItems.length) {
        fieldErrors['sections_' + sIdx + '_poolDrawCount'] =
          'Section "' +
          secTitle +
          '" poolDrawCount (' +
          poolDrawCount +
          ') cannot exceed the number of candidate questions in the pool (' +
          normItems.length +
          ').';
      }
      var firstPts = normItems.length > 0 ? normItems[0].points_bp : 100;
      for (var pi = 1; pi < normItems.length; pi++) {
        if (normItems[pi].points_bp !== firstPts) {
          fieldErrors['sections_' + sIdx + '_poolPoints'] =
            'All candidate questions in pool section "' +
            secTitle +
            '" must have the same point value so every student draw has the same maximum score.';
          break;
        }
      }
      secQuestionsCount = poolDrawCount;
      secMaxPointsBp = poolDrawCount * firstPts;
    } else {
      for (var fi = 0; fi < normItems.length; fi++) {
        secMaxPointsBp += normItems[fi].points_bp;
      }
    }

    totalQuestionsCount += secQuestionsCount;
    totalMaxPointsBp += secMaxPointsBp;

    normalizedSections.push({
      title: secTitle,
      instructions_richtext_json: secInst.json,
      sort_order: (sIdx + 1) * 10,
      selection_mode: secSelectionMode,
      pool_draw_count: poolDrawCount,
      pool_filter_json: JSON.stringify(rawSec.poolFilter || {}),
      lock_section_order: Boolean(rawSec.lockSectionOrder),
      randomize_items_within_section:
        rawSec.randomizeItemsWithinSection !== undefined
          ? Boolean(rawSec.randomizeItemsWithinSection)
          : randomizeQuestions,
      section_questions_count: secQuestionsCount,
      section_max_points_bp: secMaxPointsBp,
      items: normItems
    });
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please fix the highlighted examination builder fields.',
      fieldErrors
    );
  }

  var savedExamSetId = '';
  withScriptLock_(function () {
    var exsTbl = readSheetTable_('ExamSets');
    var exvTbl = readSheetTable_('ExamVersions');
    var exsctTbl = readSheetTable_('ExamSections');
    var exiTbl = readSheetTable_('ExamItems');
    var nowIso = nowUtcIso_();

    for (var i = 0; i < exsTbl.records.length; i++) {
      var r = exsTbl.records[i];
      if (
        String(r.exam_code || '').toUpperCase() === examCode &&
        r.exam_set_id !== examSetId
      ) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Exam code "' + examCode + '" is already used by another examination set.',
          { examCode: 'Exam code must be unique.' }
        );
      }
    }

    var targetExamSetId = examSetId;
    var targetDraftVerId = '';
    var targetVerNo = 1;
    var policySnapshotJson = JSON.stringify({
      assignmentScope: assignmentScope,
      openAtUtc: openAtUtc,
      closeAtUtc: closeAtUtc,
      maxAttempts: maxAttempts,
      retakeCooldownMinutes: retakeCooldownMinutes,
      aggregationRule: aggregationRule,
      scoreReleasePolicy: scoreReleasePolicy,
      scoreReleaseAtUtc: scoreReleaseAtUtc,
      explanationReleasePolicy: explanationReleasePolicy,
      explanationReleaseAtUtc: explanationReleaseAtUtc,
      passThresholdPct: passThresholdPct
    });

    if (isCreate) {
      targetExamSetId = generateEntityId_('exs_');
      targetDraftVerId = generateEntityId_('exv_');
      targetVerNo = 1;

      insertSheetRecord_(
        'ExamSets',
        {
          exam_set_id: targetExamSetId,
          assessment_id: '',
          course_id: courseId || '',
          exam_code: examCode,
          title: title,
          description_richtext_json: descValidated.json,
          instructions_richtext_json: instValidated.json,
          cover_image_file_id: coverImageFileId || '',
          exam_mode: examMode,
          active_exam_version_id: '',
          draft_exam_version_id: targetDraftVerId,
          latest_version_no: 1,
          assignment_scope: assignmentScope,
          open_at_utc: openAtUtc,
          close_at_utc: closeAtUtc,
          duration_minutes: durationMinutes,
          grace_seconds: graceSeconds,
          max_attempts: maxAttempts,
          retake_cooldown_minutes: retakeCooldownMinutes,
          navigation_mode: navigationMode,
          aggregation_rule: aggregationRule,
          score_release_policy: scoreReleasePolicy,
          score_release_at_utc: scoreReleaseAtUtc,
          explanation_release_policy: explanationReleasePolicy,
          explanation_release_at_utc: explanationReleaseAtUtc,
          pass_threshold_pct: passThresholdPct,
          randomize_questions: randomizeQuestions,
          randomize_options: randomizeOptions,
          allow_per_question_practice_feedback: allowPerQuestionPracticeFeedback,
          copy_policy_enabled:
            req.copyPolicyEnabled !== undefined
              ? Boolean(req.copyPolicyEnabled)
              : examMode !== 'PRACTICE',
          copy_policy_version: sanitizeSingleLineTextStep7_(
            req.copyPolicyVersion || 'pb-exam-integrity-v1',
            40
          ),
          max_copy_warnings: Math.max(1, Math.min(20, parseInt(req.maxCopyWarnings, 10) || 5)),
          copy_suspension_seconds: Math.max(
            1,
            Math.min(60, parseInt(req.copySuspensionSeconds, 10) || 5)
          ),
          max_integrity_invalidations_before_lock: Math.max(
            1,
            Math.min(10, parseInt(req.maxIntegrityInvalidationsBeforeLock, 10) || 3)
          ),
          status: 'DRAFT',
          created_by_user_id: adminUser.user_id,
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
    } else {
      var exHit = exsTbl.byId[examSetId];
      if (!exHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Examination set "' + examSetId + '" was not found.'
        );
      }
      var curEx = exHit.record;
      var expectedVersion =
        req.expectedVersion !== undefined && req.expectedVersion !== null && req.expectedVersion !== ''
          ? Number(req.expectedVersion)
          : Number(curEx.version);

      // If current draft_exam_version_id exists and is not the published active_exam_version_id, reuse/replace its sections/items;
      // If draft_exam_version_id is empty or equals active_exam_version_id (i.e. editing a published exam), mint a new DRAFT version!
      if (
        curEx.draft_exam_version_id &&
        curEx.draft_exam_version_id !== curEx.active_exam_version_id &&
        exvTbl.byId[curEx.draft_exam_version_id]
      ) {
        targetDraftVerId = curEx.draft_exam_version_id;
        targetVerNo = Number(exvTbl.byId[targetDraftVerId].record.version_no) || Number(curEx.latest_version_no) || 1;
        // Clean old draft sections & items for this draft version only (never touches active_exam_version_id!)
        for (var di = exiTbl.records.length - 1; di >= 0; di--) {
          if (exiTbl.records[di].exam_version_id === targetDraftVerId) {
            deleteSheetRecordById_('ExamItems', exiTbl.records[di].exam_item_id, null, { skipLock: true });
          }
        }
        for (var ds = exsctTbl.records.length - 1; ds >= 0; ds--) {
          if (exsctTbl.records[ds].exam_version_id === targetDraftVerId) {
            deleteSheetRecordById_('ExamSections', exsctTbl.records[ds].exam_section_id, null, { skipLock: true });
          }
        }
        deleteSheetRecordById_('ExamVersions', targetDraftVerId, null, { skipLock: true });
      } else {
        targetDraftVerId = generateEntityId_('exv_');
        targetVerNo = (Number(curEx.latest_version_no) || 1) + 1;
      }

      updateSheetRecordById_(
        'ExamSets',
        examSetId,
        {
          course_id: courseId || '',
          exam_code: examCode,
          title: title,
          description_richtext_json: descValidated.json,
          instructions_richtext_json: instValidated.json,
          cover_image_file_id: coverImageFileId || '',
          exam_mode: examMode,
          draft_exam_version_id: targetDraftVerId,
          latest_version_no: targetVerNo,
          assignment_scope: assignmentScope,
          open_at_utc: openAtUtc,
          close_at_utc: closeAtUtc,
          duration_minutes: durationMinutes,
          grace_seconds: graceSeconds,
          max_attempts: maxAttempts,
          retake_cooldown_minutes: retakeCooldownMinutes,
          navigation_mode: navigationMode,
          aggregation_rule: aggregationRule,
          score_release_policy: scoreReleasePolicy,
          score_release_at_utc: scoreReleaseAtUtc,
          explanation_release_policy: explanationReleasePolicy,
          explanation_release_at_utc: explanationReleaseAtUtc,
          pass_threshold_pct: passThresholdPct,
          randomize_questions: randomizeQuestions,
          randomize_options: randomizeOptions,
          allow_per_question_practice_feedback: allowPerQuestionPracticeFeedback,
          copy_policy_enabled:
            req.copyPolicyEnabled !== undefined
              ? Boolean(req.copyPolicyEnabled)
              : curEx.copy_policy_version
              ? Boolean(curEx.copy_policy_enabled)
              : examMode !== 'PRACTICE',
          copy_policy_version: sanitizeSingleLineTextStep7_(
            req.copyPolicyVersion || curEx.copy_policy_version || 'pb-exam-integrity-v1',
            40
          ),
          max_copy_warnings:
            req.maxCopyWarnings !== undefined
              ? Math.max(1, Math.min(20, parseInt(req.maxCopyWarnings, 10) || 5))
              : Number(curEx.max_copy_warnings) || 5,
          copy_suspension_seconds:
            req.copySuspensionSeconds !== undefined
              ? Math.max(1, Math.min(60, parseInt(req.copySuspensionSeconds, 10) || 5))
              : Number(curEx.copy_suspension_seconds) || 5,
          max_integrity_invalidations_before_lock:
            req.maxIntegrityInvalidationsBeforeLock !== undefined
              ? Math.max(1, Math.min(10, parseInt(req.maxIntegrityInvalidationsBeforeLock, 10) || 3))
              : Number(curEx.max_integrity_invalidations_before_lock) || 3,
          updated_at_utc: nowIso
        },
        expectedVersion,
        { skipLock: true }
      );
    }

    insertSheetRecord_(
      'ExamVersions',
      {
        exam_version_id: targetDraftVerId,
        exam_set_id: targetExamSetId,
        version_no: targetVerNo,
        version_state: 'DRAFT',
        exam_mode: examMode,
        title: title,
        instructions_richtext_json: instValidated.json,
        duration_minutes: durationMinutes,
        grace_seconds: graceSeconds,
        total_questions_count: totalQuestionsCount,
        max_points_bp: totalMaxPointsBp,
        negative_marking_enabled: anyNegativeMarking,
        unanswered_points_bp: 0,
        navigation_mode: navigationMode,
        randomize_questions: randomizeQuestions,
        randomize_options: randomizeOptions,
        allow_per_question_practice_feedback: allowPerQuestionPracticeFeedback,
        policy_snapshot_json: policySnapshotJson,
        published_by_user_id: '',
        published_at_utc: '',
        created_at_utc: nowIso
      },
      { skipLock: true }
    );

    for (var sIdx = 0; sIdx < normalizedSections.length; sIdx++) {
      var secSpec = normalizedSections[sIdx];
      var newSecId = generateEntityId_('exsct_');
      insertSheetRecord_(
        'ExamSections',
        {
          exam_section_id: newSecId,
          exam_version_id: targetDraftVerId,
          exam_set_id: targetExamSetId,
          title: secSpec.title,
          instructions_richtext_json: secSpec.instructions_richtext_json,
          sort_order: secSpec.sort_order,
          selection_mode: secSpec.selection_mode,
          pool_draw_count: secSpec.pool_draw_count,
          pool_filter_json: secSpec.pool_filter_json,
          lock_section_order: secSpec.lock_section_order,
          randomize_items_within_section: secSpec.randomize_items_within_section,
          section_questions_count: secSpec.section_questions_count,
          section_max_points_bp: secSpec.section_max_points_bp,
          created_at_utc: nowIso
        },
        { skipLock: true }
      );

      for (var k = 0; k < secSpec.items.length; k++) {
        var itSpec = secSpec.items[k];
        insertSheetRecord_(
          'ExamItems',
          {
            exam_item_id: generateEntityId_('exi_'),
            exam_version_id: targetDraftVerId,
            exam_section_id: newSecId,
            exam_set_id: targetExamSetId,
            question_id: itSpec.question_id,
            question_version_id: itSpec.question_version_id,
            sort_order: itSpec.sort_order,
            lock_item_position: itSpec.lock_item_position,
            lock_option_order: itSpec.lock_option_order,
            points_bp: itSpec.points_bp,
            negative_points_bp: itSpec.negative_points_bp,
            is_pool_candidate: itSpec.is_pool_candidate,
            pool_group_tag: itSpec.pool_group_tag,
            created_at_utc: nowIso
          },
          { skipLock: true }
        );
      }
    }

    savedExamSetId = targetExamSetId;
    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: isCreate ? 'ADMIN_EXAM_SET_CREATED' : 'ADMIN_EXAM_DRAFT_SAVED',
      targetEntityType: 'ExamSet',
      targetEntityId: targetExamSetId,
      summary: {
        examCode: examCode,
        examVersionId: targetDraftVerId,
        versionNo: targetVerNo,
        examMode: examMode,
        totalQuestionsCount: totalQuestionsCount,
        maxPointsBp: totalMaxPointsBp
      }
    });
  });

  var listBundle = handleAdminListExamsPhase3_({}, context);
  var savedDto = null;
  for (var m = 0; m < listBundle.exams.length; m++) {
    if (listBundle.exams[m].examSetId === savedExamSetId) {
      savedDto = listBundle.exams[m];
      break;
    }
  }
  return {
    exam: savedDto,
    exams: listBundle.exams,
    summary: listBundle.summary
  };
}

/**
 * Validates an ExamSet for publication readiness ('admin.exams.validateForPublish').
 */
function handleAdminValidateExamForPublishPhase3_(payload, context) {
  assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase3SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  if (!examSetId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'examSetId is required.'
    );
  }

  var exsTbl = readSheetTable_('ExamSets');
  var exvTbl = readSheetTable_('ExamVersions');
  var exsctTbl = readSheetTable_('ExamSections');
  var exiTbl = readSheetTable_('ExamItems');
  var qbTbl = readSheetTable_('QuestionBank');
  var qvTbl = readSheetTable_('QuestionVersions');
  var qoTbl = readSheetTable_('QuestionOptions');
  var filesTbl = readSheetTable_('Files');

  var exHit = exsTbl.byId[examSetId];
  if (!exHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Examination set "' + examSetId + '" was not found.'
    );
  }
  var exRow = exHit.record;
  var targetVerId = exRow.draft_exam_version_id || exRow.active_exam_version_id;
  var verHit = targetVerId ? exvTbl.byId[targetVerId] : null;

  return evaluateExamPublicationReadinessPhase3_(
    exRow,
    verHit ? verHit.record : null,
    exsctTbl.records,
    exiTbl.records,
    qbTbl.byId,
    qvTbl.byId,
    qoTbl.records,
    filesTbl.byId
  );
}

/**
 * Publishes an ExamSet by freezing its candidate ExamVersion as PUBLISHED,
 * creating a default COURSE assignment when configured, and syncing to Assessments ('admin.exams.publish').
 */
function handleAdminPublishExamPhase3_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase3SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  if (!examSetId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'examSetId is required to publish an examination.'
    );
  }

  var readiness = null;
  withScriptLock_(function () {
    var exsTbl = readSheetTable_('ExamSets');
    var exvTbl = readSheetTable_('ExamVersions');
    var exsctTbl = readSheetTable_('ExamSections');
    var exiTbl = readSheetTable_('ExamItems');
    var exaTbl = readSheetTable_('ExamAssignments');
    var qbTbl = readSheetTable_('QuestionBank');
    var qvTbl = readSheetTable_('QuestionVersions');
    var qoTbl = readSheetTable_('QuestionOptions');
    var filesTbl = readSheetTable_('Files');

    var exHit = exsTbl.byId[examSetId];
    if (!exHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination set "' + examSetId + '" was not found.'
      );
    }
    var exRow = exHit.record;
    var targetVerId = exRow.draft_exam_version_id || exRow.active_exam_version_id;
    var verHit = targetVerId ? exvTbl.byId[targetVerId] : null;
    var verRow = verHit ? verHit.record : null;

    readiness = evaluateExamPublicationReadinessPhase3_(
      exRow,
      verRow,
      exsctTbl.records,
      exiTbl.records,
      qbTbl.byId,
      qvTbl.byId,
      qoTbl.records,
      filesTbl.byId
    );
    if (!readiness.valid) {
      var errMap = {};
      for (var bi = 0; bi < readiness.blockingErrors.length; bi++) {
        var bErr = readiness.blockingErrors[bi];
        errMap[bErr.field || 'error_' + bi] = bErr.message;
      }
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Examination failed publication validation (' +
          readiness.blockingErrors[0].message +
          ').',
        errMap
      );
    }

    var nowIso = nowUtcIso_();
    updateSheetRecordById_(
      'ExamVersions',
      verRow.exam_version_id,
      {
        version_state: 'PUBLISHED',
        total_questions_count: readiness.computedSummary.totalQuestionsCount,
        max_points_bp: readiness.computedSummary.maxPointsBp,
        published_by_user_id: adminUser.user_id,
        published_at_utc: nowIso
      },
      undefined,
      { skipLock: true }
    );

    // Sync to Assessments table so course assessment overviews & AssessmentScores unify cleanly
    var linkedAsmId = syncExamSetToAssessmentsTablePhase3_(exRow, verRow, adminUser.user_id);

    updateSheetRecordById_(
      'ExamSets',
      examSetId,
      {
        assessment_id: linkedAsmId || exRow.assessment_id || '',
        active_exam_version_id: verRow.exam_version_id,
        draft_exam_version_id: verRow.exam_version_id,
        status: 'PUBLISHED',
        updated_at_utc: nowIso
      },
      Number(exRow.version),
      { skipLock: true }
    );

    // Ensure a default COURSE assignment row exists if assignment_scope === 'COURSE_ENROLLED' and course_id is set
    if (exRow.assignment_scope === 'COURSE_ENROLLED' && exRow.course_id) {
      var hasCourseAsg = false;
      for (var ai = 0; ai < exaTbl.records.length; ai++) {
        var aRec = exaTbl.records[ai];
        if (
          aRec.exam_set_id === examSetId &&
          aRec.target_type === 'COURSE' &&
          aRec.course_id === exRow.course_id
        ) {
          hasCourseAsg = true;
          if (aRec.assignment_status !== 'ASSIGNED') {
            updateSheetRecordById_(
              'ExamAssignments',
              aRec.assignment_id,
              { assignment_status: 'ASSIGNED', updated_at_utc: nowIso },
              Number(aRec.version),
              { skipLock: true }
            );
          }
          break;
        }
      }
      if (!hasCourseAsg) {
        insertSheetRecord_(
          'ExamAssignments',
          {
            assignment_id: generateEntityId_('exa_'),
            exam_set_id: examSetId,
            course_id: exRow.course_id,
            target_type: 'COURSE',
            student_user_id: '',
            assignment_status: 'ASSIGNED',
            open_at_override_utc: '',
            override_deadline_utc: '',
            extra_time_minutes: 0,
            extra_attempts_granted: 0,
            accommodation_reason: 'Course-wide enrollment assignment on publish',
            assigned_by_user_id: adminUser.user_id,
            created_at_utc: nowIso,
            updated_at_utc: nowIso
          },
          { skipLock: true }
        );
      }
    }

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_EXAM_PUBLISHED',
      targetEntityType: 'ExamSet',
      targetEntityId: examSetId,
      summary: {
        examCode: exRow.exam_code,
        publishedExamVersionId: verRow.exam_version_id,
        versionNo: verRow.version_no,
        totalQuestionsCount: readiness.computedSummary.totalQuestionsCount,
        maxPointsBp: readiness.computedSummary.maxPointsBp,
        warningsCount: readiness.warnings.length
      }
    });
  });

  var listBundle = handleAdminListExamsPhase3_({}, context);
  var publishedExam = null;
  for (var i = 0; i < listBundle.exams.length; i++) {
    if (listBundle.exams[i].examSetId === examSetId) {
      publishedExam = listBundle.exams[i];
      break;
    }
  }

  return {
    exam: publishedExam,
    validationReport: readiness,
    exams: listBundle.exams,
    summary: listBundle.summary
  };
}

/**
 * Generates an Administrator Preview of an ExamSet ('admin.exams.preview')
 * without creating a student attempt or exposing an unauthenticated endpoint.
 */
function handleAdminPreviewExamPhase3_(payload, context) {
  assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase3SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  if (!examSetId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'examSetId is required.'
    );
  }

  var listBundle = handleAdminListExamsPhase3_({}, context);
  var targetExam = null;
  for (var i = 0; i < listBundle.exams.length; i++) {
    if (listBundle.exams[i].examSetId === examSetId) {
      targetExam = listBundle.exams[i];
      break;
    }
  }
  if (!targetExam) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Examination set "' + examSetId + '" was not found.'
    );
  }

  var instructionsBundle = handleStudentGetExamInstructionsPhase3_(
    { examSetId: examSetId, adminPreview: true },
    context
  );

  return {
    isPreviewOnly: true,
    countsAsRealAttempt: false,
    exam: targetExam,
    studentInstructionsPreview: instructionsBundle
  };
}

/**
 * Creates, updates, or revokes a course-wide or per-student ExamAssignment
 * and individual student accommodations ('admin.exams.assign').
 */
function handleAdminAssignExamPhase3_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamIntegrityPhaseASheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var fieldErrors = {};

  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  if (!examSetId) {
    fieldErrors.examSetId = 'examSetId is required.';
  }

  var targetType = String(req.targetType || 'STUDENT').trim().toUpperCase();
  if (targetType !== 'COURSE' && targetType !== 'STUDENT') {
    fieldErrors.targetType = 'targetType must be COURSE or STUDENT.';
  }

  var courseId = sanitizeSingleLineTextStep7_(req.courseId, 64);
  var studentUserId = sanitizeSingleLineTextStep7_(req.studentUserId, 64);
  if (targetType === 'COURSE' && !courseId) {
    fieldErrors.courseId = 'courseId is required when assigning to an entire course.';
  }
  if (targetType === 'STUDENT' && !studentUserId) {
    fieldErrors.studentUserId = 'studentUserId is required when assigning or granting accommodations to a student.';
  }

  var assignmentStatus = String(req.assignmentStatus || 'ASSIGNED').trim().toUpperCase();
  if (assignmentStatus !== 'ASSIGNED' && assignmentStatus !== 'REVOKED') {
    fieldErrors.assignmentStatus = 'assignmentStatus must be ASSIGNED or REVOKED.';
  }

  var extraTimeMinutes = Math.max(0, Math.min(300, parseInt(req.extraTimeMinutes, 10) || 0));
  var extraAttemptsGranted = Math.max(0, Math.min(50, parseInt(req.extraAttemptsGranted, 10) || 0));
  var openAtOverrideUtc = parseOptionalUtcTimestampPhase3_(
    req.openAtOverrideUtc,
    'openAtOverrideUtc',
    'Override open time',
    fieldErrors
  );
  var overrideDeadlineUtc = parseOptionalUtcTimestampPhase3_(
    req.overrideDeadlineUtc,
    'overrideDeadlineUtc',
    'Override deadline time',
    fieldErrors
  );
  var accommodationReason = sanitizeSingleLineTextStep7_(req.accommodationReason, 400);

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please fix the highlighted assignment / accommodation fields.',
      fieldErrors
    );
  }

  var savedAssignment = null;
  withScriptLock_(function () {
    var exsTbl = readSheetTable_('ExamSets');
    var exaTbl = readSheetTable_('ExamAssignments');
    var coursesTbl = readSheetTable_('Courses');
    var usersTbl = readSheetTable_('Users');

    var exHit = exsTbl.byId[examSetId];
    if (!exHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination set "' + examSetId + '" was not found.'
      );
    }
    var exRow = exHit.record;

    var effectiveCourseId = courseId || exRow.course_id || '';
    if (effectiveCourseId && !coursesTbl.byId[effectiveCourseId]) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Course "' + effectiveCourseId + '" was not found.'
      );
    }
    if (targetType === 'STUDENT' && !usersTbl.byId[studentUserId]) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Student user "' + studentUserId + '" was not found.'
      );
    }

    var existingHit = null;
    for (var i = 0; i < exaTbl.records.length; i++) {
      var r = exaTbl.records[i];
      if (r.exam_set_id !== examSetId || r.target_type !== targetType) continue;
      if (targetType === 'COURSE' && r.course_id === effectiveCourseId) {
        existingHit = exaTbl.byId[r.assignment_id];
        break;
      }
      if (targetType === 'STUDENT' && r.student_user_id === studentUserId) {
        existingHit = exaTbl.byId[r.assignment_id];
        break;
      }
    }

    var nowIso = nowUtcIso_();
    if (!existingHit) {
      savedAssignment = insertSheetRecord_(
        'ExamAssignments',
        {
          assignment_id: generateEntityId_('exa_'),
          exam_set_id: examSetId,
          course_id: effectiveCourseId,
          target_type: targetType,
          student_user_id: targetType === 'STUDENT' ? studentUserId : '',
          assignment_status: assignmentStatus,
          open_at_override_utc: openAtOverrideUtc,
          override_deadline_utc: overrideDeadlineUtc,
          extra_time_minutes: extraTimeMinutes,
          extra_attempts_granted: extraAttemptsGranted,
          copy_policy_accommodation_mode: String(
            req.copyPolicyAccommodationMode || 'STANDARD'
          )
            .trim()
            .toUpperCase(),
          custom_max_copy_warnings: Math.max(
            0,
            Math.min(50, parseInt(req.customMaxCopyWarnings, 10) || 0)
          ),
          accommodation_reason: accommodationReason,
          assigned_by_user_id: adminUser.user_id,
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
    } else {
      savedAssignment = updateSheetRecordById_(
        'ExamAssignments',
        existingHit.record.assignment_id,
        {
          course_id: effectiveCourseId,
          assignment_status: assignmentStatus,
          open_at_override_utc: openAtOverrideUtc,
          override_deadline_utc: overrideDeadlineUtc,
          extra_time_minutes: extraTimeMinutes,
          extra_attempts_granted: extraAttemptsGranted,
          copy_policy_accommodation_mode:
            req.copyPolicyAccommodationMode !== undefined
              ? String(req.copyPolicyAccommodationMode || 'STANDARD')
                  .trim()
                  .toUpperCase()
              : existingHit.record.copy_policy_accommodation_mode || 'STANDARD',
          custom_max_copy_warnings:
            req.customMaxCopyWarnings !== undefined
              ? Math.max(0, Math.min(50, parseInt(req.customMaxCopyWarnings, 10) || 0))
              : Number(existingHit.record.custom_max_copy_warnings) || 0,
          accommodation_reason: accommodationReason,
          assigned_by_user_id: adminUser.user_id,
          updated_at_utc: nowIso
        },
        Number(existingHit.record.version),
        { skipLock: true }
      );
    }

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_EXAM_ASSIGNMENT_UPDATED',
      targetEntityType: 'ExamAssignment',
      targetEntityId: savedAssignment.assignment_id,
      summary: {
        examSetId: examSetId,
        targetType: targetType,
        courseId: effectiveCourseId,
        studentUserId: studentUserId,
        assignmentStatus: assignmentStatus,
        extraTimeMinutes: extraTimeMinutes,
        extraAttemptsGranted: extraAttemptsGranted
      }
    });
  });

  var listBundle = handleAdminListExamsPhase3_({}, context);
  var updatedExam = null;
  for (var m = 0; m < listBundle.exams.length; m++) {
    if (listBundle.exams[m].examSetId === examSetId) {
      updatedExam = listBundle.exams[m];
      break;
    }
  }
  return {
    assignment: savedAssignment,
    exam: updatedExam,
    exams: listBundle.exams,
    summary: listBundle.summary
  };
}

/**
 * Seeds 3 complete sample Biology Examination Sets ('PRACTICE', 'MOCK_EXAM', and 'ASSIGNED_ASSESSMENT')
 * using the Phase 2 sample Biology Question Bank ('admin.exams.seedSampleExamSets').
 */
function handleAdminSeedSampleExamSetsPhase3_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase3SheetsExist_();

  // 1. Ensure Phase 2 sample biology questions exist
  var qSeedRes = handleAdminSeedSampleBiologyQuestionBankPhase2_({}, context);
  var qbTbl = readSheetTable_('QuestionBank');
  var qByCode = {};
  for (var i = 0; i < qbTbl.records.length; i++) {
    qByCode[String(qbTbl.records[i].question_code || '').toUpperCase()] = qbTbl.records[i];
  }

  // 2. Find a published course (or any course) to attach the sample exams to
  var coursesTbl = readSheetTable_('Courses');
  var targetCourseId = payload && payload.courseId ? String(payload.courseId).trim() : '';
  if (!targetCourseId || !coursesTbl.byId[targetCourseId]) {
    for (var c = 0; c < coursesTbl.records.length; c++) {
      if (coursesTbl.records[c].status === 'PUBLISHED') {
        targetCourseId = coursesTbl.records[c].course_id;
        break;
      }
    }
    if (!targetCourseId && coursesTbl.records.length > 0) {
      targetCourseId = coursesTbl.records[0].course_id;
    }
  }

  var qSc = qByCode['BIO-PHOTO-SC-01'] ? qByCode['BIO-PHOTO-SC-01'].question_id : '';
  var qMs = qByCode['BIO-CELL-MS-02'] ? qByCode['BIO-CELL-MS-02'].question_id : '';
  var qTf = qByCode['BIO-ENZYME-TF-03'] ? qByCode['BIO-ENZYME-TF-03'].question_id : '';
  var qNum = qByCode['BIO-GENETICS-NUM-04'] ? qByCode['BIO-GENETICS-NUM-04'].question_id : '';
  var qSa = qByCode['BIO-MOLEC-SA-05'] ? qByCode['BIO-MOLEC-SA-05'].question_id : '';
  var qWr = qByCode['BIO-PHYSIO-WR-06'] ? qByCode['BIO-PHYSIO-WR-06'].question_id : '';

  var exsTbl = readSheetTable_('ExamSets');
  var existingExamCodes = {};
  for (var ei = 0; ei < exsTbl.records.length; ei++) {
    existingExamCodes[String(exsTbl.records[ei].exam_code || '').toUpperCase()] = exsTbl.records[ei];
  }

  var specs = [
    {
      examCode: 'BIO-PRAC-PHOTO-01',
      title: 'Practice Quiz: Light Reactions & Hill Reaction Experiment',
      courseId: targetCourseId,
      examMode: 'PRACTICE',
      assignmentScope: 'COURSE_ENROLLED',
      durationMinutes: 0,
      maxAttempts: 0,
      navigationMode: 'FREE',
      aggregationRule: 'BEST_PUBLISHED',
      scoreReleasePolicy: 'IMMEDIATE_AUTO',
      explanationReleasePolicy: 'WITH_SCORE',
      passThresholdPct: 60,
      randomizeQuestions: false,
      randomizeOptions: true,
      allowPerQuestionPracticeFeedback: true,
      descriptionRichText:
        'Untimed self-paced biology practice quiz on chloroplast electron transport, DCMU inhibition, and Calvin cycle enzymes.',
      instructionsRichText:
        'Practice Mode: Take this untimed quiz as many times as you wish. Explanations and full solutions are released immediately upon submission.',
      sections: [
        {
          title: 'Part 1: Hill Reaction & Thylakoid Bioenergetics',
          selectionMode: 'FIXED_ITEMS',
          items: [
            { questionId: qSc, points: 2 },
            { questionId: qTf, points: 1 },
            { questionId: qSa, points: 2 }
          ]
        }
      ]
    },
    {
      examCode: 'BIO-MOCK-ALEVEL-01',
      title: 'A-Level Biology Timed Mock Examination: Bioenergetics & Quantitative Analysis',
      courseId: targetCourseId,
      examMode: 'MOCK_EXAM',
      assignmentScope: 'COURSE_ENROLLED',
      durationMinutes: 45,
      graceSeconds: 15,
      maxAttempts: 1,
      navigationMode: 'FREE',
      aggregationRule: 'BEST_PUBLISHED',
      scoreReleasePolicy: 'IMMEDIATE_AUTO',
      explanationReleasePolicy: 'WITH_SCORE',
      passThresholdPct: 65,
      randomizeQuestions: true,
      randomizeOptions: true,
      allowPerQuestionPracticeFeedback: false,
      descriptionRichText:
        'Simulated timed A-Level Biology mock paper featuring experimental table analysis, multiple-select chemiosmosis items, and quantitative rate calculation.',
      instructionsRichText:
        'Mock Examination Rules: You have 45 minutes from the moment you click Start. The server deadline is authoritative and continues running if you close your browser tab. No correctness feedback is shown during the attempt.',
      sections: [
        {
          title: 'Section A: Shared Experimental Stimulus Analysis',
          selectionMode: 'FIXED_ITEMS',
          items: [
            { questionId: qSc, points: 2 },
            { questionId: qMs, points: 3 },
            { questionId: qNum, points: 2 }
          ]
        },
        {
          title: 'Section B: Randomized Concept Pool (1 Drawn from 2 Candidates)',
          selectionMode: 'QUESTION_POOL',
          poolDrawCount: 1,
          items: [
            { questionId: qTf, points: 2 },
            { questionId: qSa, points: 2 }
          ]
        }
      ]
    },
    {
      examCode: 'BIO-ASGN-CH10-01',
      title: 'Assigned Chapter Assessment: C3, C4 & CAM Photosynthetic Adaptations',
      courseId: targetCourseId,
      examMode: 'ASSIGNED_ASSESSMENT',
      assignmentScope: 'COURSE_ENROLLED',
      durationMinutes: 30,
      graceSeconds: 15,
      maxAttempts: 2,
      navigationMode: 'FREE',
      aggregationRule: 'BEST_PUBLISHED',
      scoreReleasePolicy: 'MANUAL_ADMIN',
      explanationReleasePolicy: 'MANUAL_ADMIN',
      passThresholdPct: 70,
      randomizeQuestions: false,
      randomizeOptions: true,
      allowPerQuestionPracticeFeedback: false,
      descriptionRichText:
        'Official course chapter assessment combining objective items with a 5-point structured written response on C4 and CAM carbon-concentrating mechanisms.',
      instructionsRichText:
        'Assigned Assessment Rules: You have 30 minutes per attempt (maximum 2 attempts). Written responses are graded by your instructor against the chapter rubric before official scores are published.',
      sections: [
        {
          title: 'Part I: Objective & Short-Answer Section',
          selectionMode: 'FIXED_ITEMS',
          items: [
            { questionId: qSc, points: 2 },
            { questionId: qSa, points: 2 }
          ]
        },
        {
          title: 'Part II: Structured Written Response',
          selectionMode: 'FIXED_ITEMS',
          items: [
            { questionId: qWr, points: 5 }
          ]
        }
      ]
    }
  ];

  var seededExamCount = 0;
  for (var s = 0; s < specs.length; s++) {
    var spec = specs[s];
    if (!existingExamCodes[spec.examCode]) {
      var draftRes = handleAdminSaveExamDraftPhase3_(spec, context);
      if (draftRes && draftRes.exam && draftRes.exam.examSetId) {
        handleAdminPublishExamPhase3_({ examSetId: draftRes.exam.examSetId }, context);
        seededExamCount += 1;
      }
    }
  }

  var updatedList = handleAdminListExamsPhase3_({}, context);
  return {
    seededExamCount: seededExamCount,
    seededQuestionCount: qSeedRes.seededCount,
    exams: updatedList.exams,
    summary: updatedList.summary
  };
}

/**
 * Lists authorized native examination sets and legacy external assessment links for a student
 * within a course or across enrolled courses ('exams.list').
 */
function handleStudentListExamsPhase3_(payload, context, opt_preloadedTables) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to view course examinations.'
    );
  }
  ensureExamPhase3SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var pre = opt_preloadedTables && typeof opt_preloadedTables === 'object' ? opt_preloadedTables : {};
  var filterCourseId = sanitizeSingleLineTextStep7_(req.courseId, 64);
  var isAdminPreview = usr.role === 'ADMIN' && (Boolean(req.adminPreview) || usr.role === 'ADMIN');

  var filterAvailability = String(req.availabilityFilter || 'ALL').trim().toUpperCase();
  var filterCompletion = String(req.completionFilter || 'ALL').trim().toUpperCase();
  var filterMode = String(req.modeFilter || 'ALL').trim().toUpperCase();
  var searchQ = sanitizeSingleLineTextStep7_(req.search, 120).toLowerCase();

  var coursesTbl = pre.coursesTbl || readSheetTable_('Courses');
  var enrollmentsTbl = pre.enrollmentsTbl || readSheetTable_('Enrollments');
  var cardsTbl = pre.cardsTbl || readSheetTable_('Cards');
  var assessmentsTbl = pre.assessmentsTbl || readSheetTable_('Assessments');
  var exsTbl = readSheetTable_('ExamSets');

  var hasCandidateExams = false;
  for (var ce = 0; ce < exsTbl.records.length; ce++) {
    var candEx = exsTbl.records[ce];
    if ((candEx.status === 'PUBLISHED' || candEx.status === 'CLOSED') && (!filterCourseId || candEx.course_id === filterCourseId)) {
      hasCandidateExams = true;
      break;
    }
  }

  var emptyTable = { records: [], byId: {} };
  var exvTbl = hasCandidateExams ? readSheetTable_('ExamVersions') : emptyTable;
  var exsctTbl = hasCandidateExams ? readSheetTable_('ExamSections') : emptyTable;
  var exiTbl = hasCandidateExams ? readSheetTable_('ExamItems') : emptyTable;
  var exaTbl = hasCandidateExams ? readSheetTable_('ExamAssignments') : emptyTable;
  var attTbl = hasCandidateExams ? readSheetTable_('ExamAttempts') : emptyTable;
  var qbTbl = hasCandidateExams ? readSheetTable_('QuestionBank') : emptyTable;
  var qvTbl = hasCandidateExams ? readSheetTable_('QuestionVersions') : emptyTable;

  // Verify course enrollment if a specific courseId was requested by a STUDENT
  var activeEnrolledCourseIds = {};
  if (usr.role === 'ADMIN') {
    for (var ci = 0; ci < coursesTbl.records.length; ci++) {
      activeEnrolledCourseIds[coursesTbl.records[ci].course_id] = true;
    }
  } else {
    for (var ei = 0; ei < enrollmentsTbl.records.length; ei++) {
      var enr = enrollmentsTbl.records[ei];
      if (enr.user_id === usr.user_id && enr.status === 'ACTIVE') {
        var cHit = coursesTbl.byId[enr.course_id];
        if (cHit && cHit.record && cHit.record.status === 'PUBLISHED') {
          activeEnrolledCourseIds[enr.course_id] = true;
        }
      }
    }
  }

  if (filterCourseId && usr.role !== 'ADMIN' && !activeEnrolledCourseIds[filterCourseId]) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Access denied: You do not hold an active enrollment in this course.'
    );
  }

  var assignmentsByExam = {};
  for (var ai = 0; ai < exaTbl.records.length; ai++) {
    var aRow = exaTbl.records[ai];
    if (!assignmentsByExam[aRow.exam_set_id]) {
      assignmentsByExam[aRow.exam_set_id] = [];
    }
    assignmentsByExam[aRow.exam_set_id].push(aRow);
  }

  var studentAttemptsByExam = {};
  for (var ati = 0; ati < attTbl.records.length; ati++) {
    var att = attTbl.records[ati];
    if (att.student_user_id === usr.user_id) {
      if (!studentAttemptsByExam[att.exam_set_id]) {
        studentAttemptsByExam[att.exam_set_id] = [];
      }
      studentAttemptsByExam[att.exam_set_id].push(att);
    }
  }

  var catalogItems = [];
  var counts = {
    totalCatalogExams: 0,
    availableCount: 0,
    inProgressCount: 0,
    completedCount: 0,
    upcomingCount: 0,
    closedCount: 0
  };

  for (var i = exsTbl.records.length - 1; i >= 0; i--) {
    var exRow = exsTbl.records[i];
    if (exRow.status !== 'PUBLISHED' && exRow.status !== 'CLOSED') continue;
    if (filterCourseId && exRow.course_id !== filterCourseId) continue;

    var activeVerHit = exRow.active_exam_version_id ? exvTbl.byId[exRow.active_exam_version_id] : null;
    if (!activeVerHit) continue;

    var isEnrolled = Boolean(exRow.course_id && activeEnrolledCourseIds[exRow.course_id]);
    var entry = evaluateStudentExamCatalogEntryPhase3_(
      exRow,
      activeVerHit.record,
      exsctTbl.records,
      exiTbl.records,
      usr.user_id,
      isEnrolled,
      assignmentsByExam[exRow.exam_set_id] || [],
      studentAttemptsByExam[exRow.exam_set_id] || [],
      coursesTbl.byId,
      qbTbl.byId,
      qvTbl.byId,
      isAdminPreview
    );
    if (!entry) continue;

    counts.totalCatalogExams += 1;
    if (entry.availabilityState === 'AVAILABLE' || entry.availabilityState === 'IN_PROGRESS_RESUMABLE') {
      counts.availableCount += 1;
    } else if (entry.availabilityState === 'UPCOMING') {
      counts.upcomingCount += 1;
    } else if (entry.availabilityState === 'CLOSED' || entry.availabilityState === 'ATTEMPTS_EXHAUSTED') {
      counts.closedCount += 1;
    }
    if (entry.completionState === 'IN_PROGRESS') {
      counts.inProgressCount += 1;
    } else if (entry.completionState === 'COMPLETED') {
      counts.completedCount += 1;
    }

    if (filterMode !== 'ALL' && entry.examMode !== filterMode) continue;
    if (filterAvailability !== 'ALL') {
      if (filterAvailability === 'AVAILABLE') {
        if (entry.availabilityState !== 'AVAILABLE' && entry.availabilityState !== 'IN_PROGRESS_RESUMABLE') continue;
      } else if (entry.availabilityState !== filterAvailability) {
        continue;
      }
    }
    if (filterCompletion !== 'ALL' && entry.completionState !== filterCompletion) continue;
    if (searchQ) {
      var hay = (
        entry.title +
        ' ' +
        entry.examCode +
        ' ' +
        entry.descriptionPlainText +
        ' ' +
        entry.examModeLabel
      ).toLowerCase();
      if (hay.indexOf(searchQ) === -1) continue;
    }

    catalogItems.push(entry);
  }

  // Also collect legacy EXTERNAL_LINK assessments in this course so they are clearly distinguished
  var legacyExternalAssessments = [];
  var nativeAssessmentIds = {};
  for (var ni = 0; ni < exsTbl.records.length; ni++) {
    if (exsTbl.records[ni].assessment_id) {
      nativeAssessmentIds[exsTbl.records[ni].assessment_id] = true;
    }
  }
  for (var ci2 = 0; ci2 < cardsTbl.records.length; ci2++) {
    var crd = cardsTbl.records[ci2];
    if (crd.status !== 'PUBLISHED' || crd.card_type !== 'ASSESSMENT_LINK_CARD' || !crd.assessment_id) continue;
    if (filterCourseId && crd.course_id !== filterCourseId) continue;
    if (!activeEnrolledCourseIds[crd.course_id]) continue;
    if (nativeAssessmentIds[crd.assessment_id]) continue;
    var asmHit = assessmentsTbl.byId[crd.assessment_id];
    if (!asmHit || asmHit.record.status !== 'ACTIVE' || !asmHit.record.external_url) continue;
    legacyExternalAssessments.push({
      assessmentKind: 'EXTERNAL_LINK',
      assessmentKindLabel: 'External Assessment Link (Legacy)',
      assessmentId: asmHit.record.assessment_id,
      courseId: crd.course_id,
      title: crd.title || asmHit.record.title,
      externalUrl: asmHit.record.external_url,
      conversionNotice:
        'External assessment link opens in a new tab. External forms are not automatically converted into native in-portal examinations.'
    });
  }

  return {
    courseId: filterCourseId || 'ALL_ENROLLED_COURSES',
    exams: catalogItems,
    legacyExternalAssessments: legacyExternalAssessments,
    summary: counts,
    serverTimeUtc: nowUtcIso_(),
    serverTimeBangkok: formatBangkokTimestamp_(nowUtcIso_())
  };
}

/**
 * Returns the complete Pre-Exam Instructions, Rules, Section Breakdown, and Readiness state
 * for a selected ExamSet without starting an attempt ('exams.getInstructions').
 */
function handleStudentGetExamInstructionsPhase3_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to view examination instructions.'
    );
  }
  ensureExamPhase3SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  if (!examSetId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'examSetId is required.'
    );
  }
  var isAdminPreview = usr.role === 'ADMIN' && (Boolean(req.adminPreview) || usr.role === 'ADMIN');

  var exsTbl = readSheetTable_('ExamSets');
  var exvTbl = readSheetTable_('ExamVersions');
  var exsctTbl = readSheetTable_('ExamSections');
  var exiTbl = readSheetTable_('ExamItems');
  var exaTbl = readSheetTable_('ExamAssignments');
  var attTbl = readSheetTable_('ExamAttempts');
  var coursesTbl = readSheetTable_('Courses');
  var enrollmentsTbl = readSheetTable_('Enrollments');
  var qbTbl = readSheetTable_('QuestionBank');
  var qvTbl = readSheetTable_('QuestionVersions');

  var exHit = exsTbl.byId[examSetId];
  if (!exHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Examination set "' + examSetId + '" was not found.'
    );
  }
  var exRow = exHit.record;
  if (usr.role !== 'ADMIN' && exRow.status !== 'PUBLISHED' && exRow.status !== 'CLOSED') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'This examination is not currently published.'
    );
  }

  var targetVerId = exRow.active_exam_version_id || (isAdminPreview ? exRow.draft_exam_version_id : '');
  var verHit = targetVerId ? exvTbl.byId[targetVerId] : null;
  if (!verHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Published examination version was not found.'
    );
  }

  var isEnrolled = false;
  if (usr.role === 'ADMIN') {
    isEnrolled = true;
  } else if (exRow.course_id) {
    for (var ei = 0; ei < enrollmentsTbl.records.length; ei++) {
      var enr = enrollmentsTbl.records[ei];
      if (
        enr.user_id === usr.user_id &&
        enr.course_id === exRow.course_id &&
        enr.status === 'ACTIVE'
      ) {
        var cHit = coursesTbl.byId[exRow.course_id];
        if (cHit && cHit.record && cHit.record.status === 'PUBLISHED') {
          isEnrolled = true;
        }
        break;
      }
    }
  }

  var assignmentsForExam = [];
  for (var ai = 0; ai < exaTbl.records.length; ai++) {
    if (exaTbl.records[ai].exam_set_id === examSetId) {
      assignmentsForExam.push(exaTbl.records[ai]);
    }
  }

  var attemptsForStudent = [];
  for (var ati = 0; ati < attTbl.records.length; ati++) {
    var att = attTbl.records[ati];
    if (att.exam_set_id === examSetId && att.student_user_id === usr.user_id) {
      attemptsForStudent.push(att);
    }
  }

  var catalogEntry = evaluateStudentExamCatalogEntryPhase3_(
    exRow,
    verHit.record,
    exsctTbl.records,
    exiTbl.records,
    usr.user_id,
    isEnrolled,
    assignmentsForExam,
    attemptsForStudent,
    coursesTbl.byId,
    qbTbl.byId,
    qvTbl.byId,
    isAdminPreview
  );

  if (!catalogEntry) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Access denied: You are not assigned to this examination.'
    );
  }

  var rulesList = [
    catalogEntry.effectiveDurationMinutes > 0
      ? 'Time Limit: ' +
        catalogEntry.durationLabel +
        (catalogEntry.hasTimeAccommodation
          ? ' (includes +' + catalogEntry.extraTimeMinutes + ' min personal accommodation)'
          : '') +
        '. Once you click Start Attempt, the server clock is authoritative and continues running even if you refresh or close your browser.'
      : 'Untimed Examination: You may work through the questions at your own pace before submitting.',
    'Allowed Attempts: ' +
      catalogEntry.allowedAttemptsDisplay +
      ' (Used: ' +
      catalogEntry.attemptsUsed +
      '). Aggregation Rule: ' +
      catalogEntry.aggregationRule +
      '.',
    'Question Navigation: ' +
      (catalogEntry.navigationMode === 'LINEAR'
        ? 'Sequential (Linear) navigation.'
        : 'Free navigation across all questions and sections using Previous/Next buttons and the Answer-Sheet Navigator, plus Flag for Review.'),
    'Scoring Policy: Maximum score is ' +
      catalogEntry.maxPointsDisplay +
      ' (' +
      catalogEntry.questionCount +
      ' questions across ' +
      catalogEntry.sectionCount +
      ' section(s)). ' +
      (catalogEntry.negativeMarkingEnabled
        ? 'Negative marking applies to designated items if answered incorrectly; unanswered items score 0.'
        : 'No negative marking penalty is deducted for incorrect responses.'),
    'Autosave & Reconnection: Answers are automatically saved to the server in batches as you navigate, and can be resumed if your connection drops before your deadline.',
    'Score & Explanation Release: Score release policy is ' +
      catalogEntry.scoreReleasePolicy +
      ' and explanation release policy is ' +
      catalogEntry.explanationReleasePolicy +
      '.'
  ];

  var studentAsgRow = null;
  for (var sai = 0; sai < assignmentsForExam.length; sai++) {
    var candAsg = assignmentsForExam[sai];
    if (
      candAsg.target_type === 'STUDENT' &&
      candAsg.student_user_id === usr.user_id &&
      candAsg.assignment_status === 'ASSIGNED'
    ) {
      studentAsgRow = candAsg;
      break;
    }
  }
  var integrityPolicy = resolveAttemptIntegrityPolicySnapshotPhaseA_(
    exRow,
    verHit.record,
    studentAsgRow
  );
  catalogEntry.integrityPolicy = integrityPolicy;

  return {
    doesNotStartAttempt: true,
    exam: catalogEntry,
    integrityPolicy: integrityPolicy,
    rulesChecklist: rulesList,
    serverTimeUtc: nowUtcIso_(),
    serverTimeBangkok: formatBangkokTimestamp_(nowUtcIso_())
  };
}




// ============================================================================
// NATIVE ONLINE EXAMINATION SYSTEM -- PHASE 4: ATTEMPT ENGINE,
// SERVER-AUTHORITATIVE TIMER, PERSISTED RANDOMIZATION & QUOTA-SAFE AUTOSAVE
// ============================================================================

/**
 * Dynamically registers the Phase 4 normalized examination worksheets
 * ('AttemptItems', 'AttemptResponses', 'ExamOperationJournal') in
 * PB_SHEET_NAMES_ and PB_SHEET_SCHEMAS_.
 */
function ensureExamPhase4SchemasRegistered_() {
  ensureExamPhase3SchemasRegistered_();
  if (typeof PB_SHEET_NAMES_ === 'object' && PB_SHEET_NAMES_ && !PB_SHEET_NAMES_.ATTEMPT_ITEMS) {
    var nextNames = {};
    var nameKeys = Object.keys(PB_SHEET_NAMES_);
    for (var i = 0; i < nameKeys.length; i++) {
      nextNames[nameKeys[i]] = PB_SHEET_NAMES_[nameKeys[i]];
    }
    nextNames.ATTEMPT_ITEMS = 'AttemptItems';
    nextNames.ATTEMPT_RESPONSES = 'AttemptResponses';
    nextNames.EXAM_OPERATION_JOURNAL = 'ExamOperationJournal';
    PB_SHEET_NAMES_ = Object.freeze(nextNames);
  }

  if (typeof PB_SHEET_SCHEMAS_ === 'object' && PB_SHEET_SCHEMAS_ && !PB_SHEET_SCHEMAS_.AttemptItems) {
    var nextSchemas = {};
    var schemaKeys = Object.keys(PB_SHEET_SCHEMAS_);
    for (var j = 0; j < schemaKeys.length; j++) {
      nextSchemas[schemaKeys[j]] = PB_SHEET_SCHEMAS_[schemaKeys[j]];
    }

    nextSchemas.AttemptItems = Object.freeze({
      sheetName: 'AttemptItems',
      primaryKey: 'attempt_item_id',
      idPrefix: 'ati_',
      hasVersion: false,
      headers: Object.freeze([
        'attempt_item_id',
        'attempt_id',
        'exam_set_id',
        'exam_version_id',
        'exam_section_id',
        'display_number',
        'question_id',
        'question_version_id',
        'stimulus_id',
        'option_order_json',
        'points_bp',
        'negative_points_bp',
        'is_flagged',
        'flag_updated_at_utc',
        'created_at_utc'
      ]),
      requiredFields: Object.freeze([
        'attempt_item_id',
        'attempt_id',
        'exam_set_id',
        'exam_version_id',
        'exam_section_id',
        'display_number',
        'question_id',
        'question_version_id',
        'points_bp',
        'created_at_utc'
      ]),
      enums: Object.freeze({}),
      booleanFields: Object.freeze(['is_flagged']),
      integerFields: Object.freeze([
        'display_number',
        'points_bp',
        'negative_points_bp'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    nextSchemas.AttemptResponses = Object.freeze({
      sheetName: 'AttemptResponses',
      primaryKey: 'response_id',
      idPrefix: 'atr_',
      hasVersion: true,
      headers: Object.freeze([
        'response_id',
        'attempt_id',
        'attempt_item_id',
        'question_version_id',
        'student_user_id',
        'response_payload_json',
        'is_answered',
        'client_revision_no',
        'server_revision_no',
        'saved_at_utc',
        'grading_source',
        'awarded_points_bp',
        'max_points_bp',
        'correctness_state',
        'instructor_feedback',
        'graded_by_user_id',
        'graded_at_utc',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'response_id',
        'attempt_id',
        'attempt_item_id',
        'question_version_id',
        'student_user_id',
        'client_revision_no',
        'server_revision_no',
        'saved_at_utc',
        'grading_source',
        'correctness_state',
        'created_at_utc',
        'updated_at_utc',
        'version'
      ]),
      enums: Object.freeze({
        grading_source: Object.freeze(['UNGRADED', 'AUTO_ENGINE', 'MANUAL_INSTRUCTOR', 'REGRADE_ENGINE']),
        correctness_state: Object.freeze(['UNGRADED', 'CORRECT', 'PARTIAL', 'INCORRECT', 'UNANSWERED', 'MANUAL_REVIEW_PENDING'])
      }),
      booleanFields: Object.freeze(['is_answered']),
      integerFields: Object.freeze([
        'client_revision_no',
        'server_revision_no',
        'awarded_points_bp',
        'max_points_bp',
        'version'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    nextSchemas.ExamOperationJournal = Object.freeze({
      sheetName: 'ExamOperationJournal',
      primaryKey: 'journal_id',
      idPrefix: 'exj_',
      hasVersion: false,
      headers: Object.freeze([
        'journal_id',
        'operation_type',
        'idempotency_key',
        'attempt_id',
        'exam_set_id',
        'student_user_id',
        'target_status',
        'payload_json',
        'journal_status',
        'created_at_utc',
        'committed_at_utc'
      ]),
      requiredFields: Object.freeze([
        'journal_id',
        'operation_type',
        'idempotency_key',
        'attempt_id',
        'exam_set_id',
        'student_user_id',
        'target_status',
        'journal_status',
        'created_at_utc'
      ]),
      enums: Object.freeze({
        operation_type: Object.freeze([
          'START_ATTEMPT',
          'SUBMIT_ATTEMPT',
          'EXPIRE_FINALIZE',
          'GRADE_ATTEMPT',
          'PUBLISH_RESULT',
          'REGRADE_ATTEMPT',
          'INTEGRITY_COPY_EVENT',
          'INTEGRITY_ADMIN_REVIEW'
        ]),
        journal_status: Object.freeze([
          'PENDING',
          'COMMITTED',
          'ROLLED_BACK',
          'HALTED_INCONSISTENT'
        ])
      }),
      booleanFields: Object.freeze([]),
      integerFields: Object.freeze([]),
      positiveSatangFields: Object.freeze([])
    });

    PB_SHEET_SCHEMAS_ = Object.freeze(nextSchemas);
  }
}

function ensureExamPhase4SheetsExist_() {
  ensureExamPhase4SchemasRegistered_();
  ensureExamPhase3SheetsExist_();
  var ss = openConfiguredSpreadsheet_();
  var sheetNames = ['AttemptItems', 'AttemptResponses', 'ExamOperationJournal'];
  for (var i = 0; i < sheetNames.length; i++) {
    var sName = sheetNames[i];
    if (!ss.getSheetByName(sName) && PB_SHEET_SCHEMAS_[sName]) {
      ensureSingleSheetSchema_(ss, sName);
    }
  }
}

/**
 * Deterministic / pseudo-random Fisher-Yates shuffle helper that preserves locked positions.
 */
function shuffleArrayInPlacePhase4_(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Computes the persisted option_id ordering for a single question item at attempt start.
 * - If option shuffling is enabled and neither the exam item nor the question version locks options,
 *   shuffles normal options ('NONE') while keeping 'LAST' options (e.g., "All of the above") at the end
 *   and 'FIXED' options (e.g., True/False) in their exact positions.
 */
function buildPersistedOptionOrderForItemPhase4_(
  optionRows,
  randomizeOptionsEnabled,
  itemLockOptionOrder,
  questionLockOptionOrder
) {
  var sorted = (optionRows || []).slice().sort(function (a, b) {
    var d = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    if (d !== 0) return d;
    return String(a.option_id || '').localeCompare(String(b.option_id || ''));
  });

  if (sorted.length <= 1) {
    return sorted.map(function (o) { return o.option_id; });
  }

  var shouldShuffle = Boolean(
    randomizeOptionsEnabled && !itemLockOptionOrder && !questionLockOptionOrder
  );
  if (!shouldShuffle) {
    return sorted.map(function (o) { return o.option_id; });
  }

  // Check if any option has FIXED pin or unpinned order-dependent text
  for (var i = 0; i < sorted.length; i++) {
    var o = sorted[i];
    if (o.pin_position === 'FIXED') {
      return sorted.map(function (x) { return x.option_id; });
    }
    var plain = extractPlainTextFromRichTextDocPhase2_(
      parseStoredRichTextJsonSafe_(o.content_richtext_json)
    );
    if (isOrderDependentOptionTextPhase2_(plain) && o.pin_position === 'NONE') {
      // Automatically treat "All of the above" / "None of the above" as pinned LAST if at end, or lock all options
      if (i === sorted.length - 1) {
        o.pin_position = 'LAST';
      } else {
        return sorted.map(function (x) { return x.option_id; });
      }
    }
  }

  var movable = [];
  var pinnedLast = [];
  for (var k = 0; k < sorted.length; k++) {
    if (sorted[k].pin_position === 'LAST' || sorted[k].pin_position === 'ANCHOR_BOTTOM') {
      pinnedLast.push(sorted[k].option_id);
    } else {
      movable.push(sorted[k].option_id);
    }
  }
  shuffleArrayInPlacePhase4_(movable);
  return movable.concat(pinnedLast);
}

/**
 * Generates and persists the frozen AttemptItems rows for a newly created ExamAttempt.
 */
function generateAndPersistAttemptItemsInLockPhase4_(
  attemptRow,
  examSetRow,
  examVerRow,
  allSectionsRows,
  allItemsRows,
  qbById,
  qvById,
  qoRecords
) {
  var secList = [];
  for (var i = 0; i < allSectionsRows.length; i++) {
    if (allSectionsRows[i].exam_version_id === examVerRow.exam_version_id) {
      secList.push(allSectionsRows[i]);
    }
  }
  secList.sort(function (a, b) {
    var d = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    if (d !== 0) return d;
    return String(a.exam_section_id || '').localeCompare(String(b.exam_section_id || ''));
  });

  var optionsByQvId = {};
  for (var oi = 0; oi < qoRecords.length; oi++) {
    var op = qoRecords[oi];
    if (!optionsByQvId[op.question_version_id]) {
      optionsByQvId[op.question_version_id] = [];
    }
    optionsByQvId[op.question_version_id].push(op);
  }

  var nowIso = nowUtcIso_();
  var createdAttemptItems = [];
  var displayCounter = 1;
  var usedQuestionIds = {};

  for (var sIdx = 0; sIdx < secList.length; sIdx++) {
    var sec = secList[sIdx];
    var rawCandidates = [];
    for (var m = 0; m < allItemsRows.length; m++) {
      var it = allItemsRows[m];
      if (
        it.exam_version_id === examVerRow.exam_version_id &&
        it.exam_section_id === sec.exam_section_id
      ) {
        rawCandidates.push(it);
      }
    }
    rawCandidates.sort(function (a, b) {
      var d = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
      if (d !== 0) return d;
      return String(a.exam_item_id || '').localeCompare(String(b.exam_item_id || ''));
    });

    var chosenItems = [];
    if (sec.selection_mode === 'QUESTION_POOL') {
      var drawCount = Math.min(
        rawCandidates.length,
        Math.max(1, Number(sec.pool_draw_count) || 1)
      );
      var poolCopy = rawCandidates.slice();
      shuffleArrayInPlacePhase4_(poolCopy);
      chosenItems = poolCopy.slice(0, drawCount);
      if (!sec.randomize_items_within_section && !examVerRow.randomize_questions) {
        chosenItems.sort(function (a, b) {
          return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
        });
      }
    } else {
      var shouldRandomizeSec = Boolean(
        sec.randomize_items_within_section || examVerRow.randomize_questions
      );
      if (!shouldRandomizeSec) {
        chosenItems = rawCandidates.slice();
      } else {
        // Keep lock_item_position items at their exact index while shuffling unlocked items
        var unlocked = [];
        for (var u = 0; u < rawCandidates.length; u++) {
          if (!rawCandidates[u].lock_item_position) {
            unlocked.push(rawCandidates[u]);
          }
        }
        shuffleArrayInPlacePhase4_(unlocked);
        var uCursor = 0;
        for (var pos = 0; pos < rawCandidates.length; pos++) {
          if (rawCandidates[pos].lock_item_position) {
            chosenItems.push(rawCandidates[pos]);
          } else {
            chosenItems.push(unlocked[uCursor++]);
          }
        }
      }
    }

    for (var cIdx = 0; cIdx < chosenItems.length; cIdx++) {
      var exItem = chosenItems[cIdx];
      var qvHit = qvById[exItem.question_version_id];
      var qvRec = qvHit ? qvHit.record : null;
      var qOpts = optionsByQvId[exItem.question_version_id] || [];

      var optionOrderIds = buildPersistedOptionOrderForItemPhase4_(
        qOpts,
        Boolean(examVerRow.randomize_options),
        Boolean(exItem.lock_option_order),
        Boolean(qvRec && qvRec.lock_option_order)
      );

      var atiRow = insertSheetRecord_(
        'AttemptItems',
        {
          attempt_item_id: generateEntityId_('ati_'),
          attempt_id: attemptRow.attempt_id,
          exam_set_id: examSetRow.exam_set_id,
          exam_version_id: examVerRow.exam_version_id,
          exam_section_id: sec.exam_section_id,
          display_number: displayCounter++,
          question_id: exItem.question_id,
          question_version_id: exItem.question_version_id,
          stimulus_id: qvRec ? qvRec.stimulus_id || '' : '',
          option_order_json: JSON.stringify(optionOrderIds),
          points_bp: Number(exItem.points_bp) || 100,
          negative_points_bp: Number(exItem.negative_points_bp) || 0,
          is_flagged: false,
          flag_updated_at_utc: '',
          created_at_utc: nowIso
        },
        { skipLock: true }
      );
      createdAttemptItems.push(atiRow);
      usedQuestionIds[exItem.question_id] = true;
    }
  }

  // Increment used_in_attempts_count on QuestionBank rows so hard deletion is blocked
  var usedKeys = Object.keys(usedQuestionIds);
  for (var uk = 0; uk < usedKeys.length; uk++) {
    var qId = usedKeys[uk];
    var qbHit = qbById[qId];
    if (qbHit && qbHit.record) {
      updateSheetRecordById_(
        'QuestionBank',
        qId,
        {
          used_in_attempts_count: (Number(qbHit.record.used_in_attempts_count) || 0) + 1
        },
        Number(qbHit.record.version),
        { skipLock: true }
      );
    }
  }

  return createdAttemptItems;
}

/**
 * Checks whether an IN_PROGRESS attempt has passed its grace_deadline_utc (or effective_deadline_utc)
 * and, if so, transitions it to EXPIRED_SUBMITTED inside LockService.
 */
function checkAndFinalizeExpiredAttemptInLockPhase4_(attemptRow, opt_nowMs) {
  if (!attemptRow || attemptRow.attempt_status !== 'IN_PROGRESS') {
    return { expiredNow: false, attemptRow: attemptRow };
  }
  var nowMs = opt_nowMs || Date.now();
  var deadlineStr = attemptRow.grace_deadline_utc || attemptRow.effective_deadline_utc || '';
  if (!deadlineStr) {
    return { expiredNow: false, attemptRow: attemptRow };
  }
  var deadlineMs = Date.parse(deadlineStr);
  if (isNaN(deadlineMs) || nowMs <= deadlineMs) {
    return { expiredNow: false, attemptRow: attemptRow };
  }

  var nowIso = new Date(nowMs).toISOString();
  var startedMs = Date.parse(attemptRow.started_at_utc) || nowMs;
  var effDeadMs = Date.parse(attemptRow.effective_deadline_utc) || deadlineMs;
  var elapsedSec = Math.max(0, Math.round((Math.min(nowMs, effDeadMs) - startedMs) / 1000));

  var jrnId = generateEntityId_('exj_');
  insertSheetRecord_(
    'ExamOperationJournal',
    {
      journal_id: jrnId,
      operation_type: 'EXPIRE_FINALIZE',
      idempotency_key: 'auto_expire_' + attemptRow.attempt_id,
      attempt_id: attemptRow.attempt_id,
      exam_set_id: attemptRow.exam_set_id,
      student_user_id: attemptRow.student_user_id,
      target_status: 'EXPIRED_SUBMITTED',
      payload_json: JSON.stringify({
        effectiveDeadlineUtc: attemptRow.effective_deadline_utc,
        graceDeadlineUtc: attemptRow.grace_deadline_utc,
        finalizedAtUtc: nowIso
      }),
      journal_status: 'PENDING',
      created_at_utc: nowIso,
      committed_at_utc: ''
    },
    { skipLock: true }
  );

  var updatedAttempt = updateSheetRecordById_(
    'ExamAttempts',
    attemptRow.attempt_id,
    {
      attempt_status: 'EXPIRED_SUBMITTED',
      submitted_at_utc: attemptRow.effective_deadline_utc || nowIso,
      time_used_seconds: elapsedSec,
      updated_at_utc: nowIso
    },
    Number(attemptRow.version),
    { skipLock: true }
  );

  updateSheetRecordById_(
    'ExamOperationJournal',
    jrnId,
    {
      journal_status: 'COMMITTED',
      committed_at_utc: nowIso
    },
    undefined,
    { skipLock: true }
  );

  recordAuditEvent_({
    actorUserId: 'SYSTEM',
    actorRole: 'SYSTEM',
    eventType: 'EXAM_ATTEMPT_EXPIRED_AUTO_FINALIZED',
    targetEntityType: 'ExamAttempt',
    targetEntityId: attemptRow.attempt_id,
    summary: {
      examSetId: attemptRow.exam_set_id,
      studentUserId: attemptRow.student_user_id,
      effectiveDeadlineUtc: attemptRow.effective_deadline_utc,
      graceDeadlineUtc: attemptRow.grace_deadline_utc
    }
  });

  // If Phase 6 auto-grading helper is loaded, invoke it so expired attempts are also graded
  if (typeof gradeSubmittedExamAttemptInLockPhase6_ === 'function') {
    try {
      updatedAttempt = gradeSubmittedExamAttemptInLockPhase6_(updatedAttempt);
    } catch (ignoreGradeErr) {}
  }

  return { expiredNow: true, attemptRow: updatedAttempt };
}

/**
 * Builds the complete Student-Safe Attempt Workspace DTO from persisted AttemptItems
 * and AttemptResponses. Never leaks private answer keys, is_correct_private, or unreleased explanations.
 */
function buildStudentAttemptWorkspaceBundlePhase4_(
  attemptRow,
  examSetRow,
  examVerRow,
  attemptItemRows,
  attemptResponseRows,
  allSectionRows,
  qbById,
  qvById,
  qoRecords,
  stimById
) {
  var nowMs = Date.now();
  var nowIso = new Date(nowMs).toISOString();

  var effDeadlineStr = attemptRow.effective_deadline_utc || '';
  var effDeadlineMs = effDeadlineStr ? Date.parse(effDeadlineStr) : NaN;
  var remainingSecondsServer =
    !isNaN(effDeadlineMs)
      ? Math.max(0, Math.floor((effDeadlineMs - nowMs) / 1000))
      : null;

  var sectionsById = {};
  var orderedSections = [];
  for (var s = 0; s < allSectionRows.length; s++) {
    var sec = allSectionRows[s];
    if (sec.exam_version_id === attemptRow.exam_version_id) {
      var sDto = {
        examSectionId: sec.exam_section_id,
        title: sec.title,
        instructionsRichText: parseStoredRichTextJsonSafe_(sec.instructions_richtext_json),
        sortOrder: Number(sec.sort_order) || 10
      };
      sectionsById[sec.exam_section_id] = sDto;
      orderedSections.push(sDto);
    }
  }
  orderedSections.sort(function (a, b) {
    return a.sortOrder - b.sortOrder;
  });

  var optionsByQvId = {};
  for (var oi = 0; oi < qoRecords.length; oi++) {
    var op = qoRecords[oi];
    if (!optionsByQvId[op.question_version_id]) {
      optionsByQvId[op.question_version_id] = [];
    }
    optionsByQvId[op.question_version_id].push(op);
  }

  var responsesByAttemptItemId = {};
  for (var ri = 0; ri < attemptResponseRows.length; ri++) {
    var rRow = attemptResponseRows[ri];
    if (rRow.attempt_id === attemptRow.attempt_id) {
      var parsedResp = {};
      try {
        parsedResp = JSON.parse(rRow.response_payload_json || '{}');
      } catch (e) {
        parsedResp = {};
      }
      responsesByAttemptItemId[rRow.attempt_item_id] = {
        responseId: rRow.response_id,
        attemptItemId: rRow.attempt_item_id,
        responsePayload: parsedResp,
        isAnswered: Boolean(rRow.is_answered),
        clientRevisionNo: Number(rRow.client_revision_no) || 0,
        serverRevisionNo: Number(rRow.server_revision_no) || 0,
        savedAtUtc: rRow.saved_at_utc || '',
        savedAtBangkok: rRow.saved_at_utc ? formatBangkokTimestamp_(rRow.saved_at_utc) : ''
      };
    }
  }

  var sortedItems = (attemptItemRows || [])
    .filter(function (it) { return it.attempt_id === attemptRow.attempt_id; })
    .slice()
    .sort(function (a, b) {
      return (Number(a.display_number) || 0) - (Number(b.display_number) || 0);
    });

  var itemDtos = [];
  var answeredCount = 0;
  var flaggedCount = 0;

  for (var idx = 0; idx < sortedItems.length; idx++) {
    var ati = sortedItems[idx];
    var qbHit = qbById[ati.question_id];
    var qvHit = qvById[ati.question_version_id];
    var qbRec = qbHit ? qbHit.record : null;
    var qvRec = qvHit ? qvHit.record : null;
    var stimRec =
      ati.stimulus_id && stimById && stimById[ati.stimulus_id]
        ? stimById[ati.stimulus_id].record
        : null;

    var rawOpts = optionsByQvId[ati.question_version_id] || [];
    var optMap = {};
    for (var k = 0; k < rawOpts.length; k++) {
      optMap[rawOpts[k].option_id] = rawOpts[k];
    }

    var persistedOptIds = [];
    try {
      persistedOptIds = JSON.parse(ati.option_order_json || '[]');
    } catch (e) {
      persistedOptIds = [];
    }

    var orderedOptRows = [];
    var seenOpt = {};
    for (var po = 0; po < persistedOptIds.length; po++) {
      var oid = persistedOptIds[po];
      if (optMap[oid]) {
        orderedOptRows.push(optMap[oid]);
        seenOpt[oid] = true;
      }
    }
    for (var ro = 0; ro < rawOpts.length; ro++) {
      if (!seenOpt[rawOpts[ro].option_id]) {
        orderedOptRows.push(rawOpts[ro]);
      }
    }

    // Project student-safe question version DTO (opt_includeAdminPrivateData = false!)
    var studentSafeQ =
      qbRec && qvRec
        ? projectQuestionVersionDtoPhase2_(qbRec, qvRec, orderedOptRows, stimRec, false)
        : null;

    // Assign display option labels (A, B, C, D... or True/False) according to persisted order
    if (studentSafeQ && Array.isArray(studentSafeQ.options)) {
      var letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
      for (var m = 0; m < studentSafeQ.options.length; m++) {
        studentSafeQ.options[m].displayLabel =
          studentSafeQ.questionType === 'TRUE_FALSE'
            ? studentSafeQ.options[m].plainText || letters[m]
            : letters[m] || String(m + 1);
      }
    }

    var savedResp = responsesByAttemptItemId[ati.attempt_item_id] || null;
    var isAnswered = Boolean(savedResp && savedResp.isAnswered);
    var isFlagged = Boolean(ati.is_flagged);
    if (isAnswered) answeredCount += 1;
    if (isFlagged) flaggedCount += 1;

    var secMeta = sectionsById[ati.exam_section_id] || null;
    itemDtos.push({
      attemptItemId: ati.attempt_item_id,
      displayNumber: Number(ati.display_number) || idx + 1,
      examSectionId: ati.exam_section_id,
      sectionTitle: secMeta ? secMeta.title : 'Section',
      questionId: ati.question_id,
      questionVersionId: ati.question_version_id,
      pointsBp: Number(ati.points_bp) || 100,
      pointsDisplay: formatPointsBpDisplayPhase2_(ati.points_bp || 100),
      negativePointsBp: Number(ati.negative_points_bp) || 0,
      negativePointsDisplay: formatPointsBpDisplayPhase2_(ati.negative_points_bp || 0),
      isFlagged: isFlagged,
      flagUpdatedAtUtc: ati.flag_updated_at_utc || '',
      isAnsweredServerSaved: isAnswered,
      savedResponse: savedResp,
      question: studentSafeQ
    });
  }

  return {
    attempt: {
      attemptId: attemptRow.attempt_id,
      examSetId: attemptRow.exam_set_id,
      examVersionId: attemptRow.exam_version_id,
      courseId: attemptRow.course_id || '',
      studentUserId: attemptRow.student_user_id,
      attemptNumber: Number(attemptRow.attempt_number) || 1,
      attemptStatus: attemptRow.attempt_status,
      gradingStatus: attemptRow.grading_status,
      publicationStatus: attemptRow.publication_status,
      explanationStatus: attemptRow.explanation_status,
      startedAtUtc: attemptRow.started_at_utc,
      startedAtBangkok: formatBangkokTimestamp_(attemptRow.started_at_utc),
      effectiveDeadlineUtc: effDeadlineStr,
      effectiveDeadlineBangkok: effDeadlineStr ? formatBangkokTimestamp_(effDeadlineStr) : 'Untimed',
      graceDeadlineUtc: attemptRow.grace_deadline_utc || '',
      submittedAtUtc: attemptRow.submitted_at_utc || '',
      submittedAtBangkok: attemptRow.submitted_at_utc
        ? formatBangkokTimestamp_(attemptRow.submitted_at_utc)
        : '',
      lastSavedAtUtc: attemptRow.last_saved_at_utc || '',
      lastSavedAtBangkok: attemptRow.last_saved_at_utc
        ? formatBangkokTimestamp_(attemptRow.last_saved_at_utc)
        : '',
      latestRevisionNo: Number(attemptRow.latest_revision_no) || 0,
      leaseToken: attemptRow.active_lease_token || '',
      totalQuestionsCount: itemDtos.length,
      answeredCount: answeredCount,
      unansweredCount: Math.max(0, itemDtos.length - answeredCount),
      flaggedCount: flaggedCount,
      maxScoreBp: Number(attemptRow.max_score_bp) || Number(examVerRow.max_points_bp) || 0,
      maxScoreDisplay: formatPointsBpDisplayPhase2_(
        Number(attemptRow.max_score_bp) || Number(examVerRow.max_points_bp) || 0
      ),
      integrityState: buildAttemptIntegrityStateDtoPhaseB_(attemptRow, examSetRow, nowMs)
    },
    exam: {
      examSetId: examSetRow.exam_set_id,
      examCode: examSetRow.exam_code,
      title: examSetRow.title,
      examMode: examSetRow.exam_mode,
      examModeLabel: formatExamModeBadgeLabelPhase3_(examSetRow.exam_mode),
      navigationMode: examSetRow.navigation_mode || 'FREE',
      durationMinutes: Number(examSetRow.duration_minutes) || 0,
      graceSeconds: Number(examSetRow.grace_seconds) || 15,
      allowPerQuestionPracticeFeedback: Boolean(
        examSetRow.exam_mode === 'PRACTICE' && examSetRow.allow_per_question_practice_feedback
      )
    },
    sections: orderedSections,
    items: itemDtos,
    savedResponsesByItemId: responsesByAttemptItemId,
    serverNowUtc: nowIso,
    serverNowBangkok: formatBangkokTimestamp_(nowIso),
    remainingSecondsServer: remainingSecondsServer
  };
}

/**
 * Validates and normalizes a student's incoming response payload for a single AttemptItem.
 */
function validateAndNormalizeStudentResponsePayloadPhase4_(
  rawPayload,
  qvRec,
  validOptionIdsMap,
  attemptItemId
) {
  var p = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  var qType = qvRec ? qvRec.question_type : 'SINGLE_CHOICE';

  if (qType === 'SINGLE_CHOICE' || qType === 'TRUE_FALSE') {
    var selId = sanitizeSingleLineTextStep7_(p.selectedOptionId, 64);
    if (!selId) {
      return {
        isAnswered: false,
        normalizedPayload: { selectedOptionId: '' }
      };
    }
    if (!validOptionIdsMap[selId]) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Option "' + selId + '" does not belong to question item "' + attemptItemId + '".',
        { selectedOptionId: 'Invalid option ID for this question.' }
      );
    }
    return {
      isAnswered: true,
      normalizedPayload: { selectedOptionId: selId }
    };
  }

  if (qType === 'COMPLEX_MULTIPLE_CHOICE') {
    var rawDec = p.statementDecisions && typeof p.statementDecisions === 'object' ? p.statementDecisions : {};
    var decKeys = Object.keys(rawDec);
    var cleanDec = {};
    var decCount = 0;
    for (var di = 0; di < decKeys.length && decCount < 10; di++) {
      var stmtId = sanitizeSingleLineTextStep7_(decKeys[di], 64);
      if (!stmtId) continue;
      if (!validOptionIdsMap[stmtId]) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Statement "' + stmtId + '" does not belong to question item "' + attemptItemId + '".',
          { statementDecisions: 'Invalid statement ID in selection.' }
        );
      }
      var rawChoice = String(rawDec[decKeys[di]] || '').trim().toUpperCase();
      if (rawChoice === 'YES' || rawChoice === 'TRUE') {
        cleanDec[stmtId] = 'YES';
        decCount += 1;
      } else if (rawChoice === 'NO' || rawChoice === 'FALSE') {
        cleanDec[stmtId] = 'NO';
        decCount += 1;
      }
    }
    return {
      isAnswered: decCount > 0,
      normalizedPayload: { statementDecisions: cleanDec }
    };
  }

  if (qType === 'MULTIPLE_SELECT') {
    var rawArr = Array.isArray(p.selectedOptionIds) ? p.selectedOptionIds : [];
    var cleanIds = [];
    var seen = {};
    for (var i = 0; i < rawArr.length && cleanIds.length < 16; i++) {
      var oid = sanitizeSingleLineTextStep7_(rawArr[i], 64);
      if (!oid || seen[oid]) continue;
      if (!validOptionIdsMap[oid]) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Option "' + oid + '" does not belong to question item "' + attemptItemId + '".',
          { selectedOptionIds: 'Invalid option ID in selection.' }
        );
      }
      seen[oid] = true;
      cleanIds.push(oid);
    }
    cleanIds.sort();
    return {
      isAnswered: cleanIds.length > 0,
      normalizedPayload: { selectedOptionIds: cleanIds }
    };
  }

  if (qType === 'NUMERIC_RESPONSE') {
    var rawNumText =
      p.numericText !== undefined && p.numericText !== null
        ? String(p.numericText).trim()
        : p.value !== undefined && p.value !== null
        ? String(p.value).trim()
        : '';
    var cleanNum = sanitizeSingleLineTextStep7_(rawNumText, 64);
    if (cleanNum && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cleanNum)) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Numeric response must be a valid number without formulas or expressions.',
        { numericText: 'Enter digits and an optional decimal point only.' }
      );
    }
    return {
      isAnswered: cleanNum.length > 0,
      normalizedPayload: { numericText: cleanNum }
    };
  }

  // SHORT_ANSWER or WRITTEN_RESPONSE
  var maxLen = Math.max(50, Number(qvRec && qvRec.max_length_chars) || (qType === 'SHORT_ANSWER' ? 300 : 2500));
  var rawText =
    p.textResponse !== undefined && p.textResponse !== null
      ? String(p.textResponse)
      : '';
  // Normalize CRLF -> LF and strip null bytes
  var cleanText = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u0000/g, '');
  if (cleanText.length > maxLen) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Response exceeds the maximum allowed length of ' + maxLen + ' characters.',
      { textResponse: 'Maximum length is ' + maxLen + ' characters.' }
    );
  }
  if (/^[ \t\r\n]*[=@]/.test(cleanText) || /^[ \t\r\n]*[+-][A-Za-z=]/.test(cleanText)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Response text cannot begin with a spreadsheet formula expression (=, @, +FUNC, -FUNC).',
      { textResponse: 'Remove leading formula characters (= or @).' }
    );
  }
  return {
    isAnswered: cleanText.trim().length > 0,
    normalizedPayload: { textResponse: cleanText }
  };
}

/**
 * Starts a new authorized examination attempt or idempotently resumes an active IN_PROGRESS
 * attempt ('exams.startAttempt').
 */
function handleStudentStartExamAttemptPhase4_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to start an examination attempt.'
    );
  }
  ensureExamPhase4SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  var idempotencyKey =
    sanitizeSingleLineTextStep7_(req.idempotencyKey, 80) ||
    'start_' + usr.user_id + '_' + examSetId;

  if (!examSetId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'examSetId is required to start an attempt.',
      { examSetId: 'Missing examSetId.' }
    );
  }

  var workspaceBundle = null;
  var isIdempotentReplay = false;
  var resumedExistingAttempt = false;

  withScriptLock_(function () {
    var exsTbl = readSheetTable_('ExamSets');
    var exvTbl = readSheetTable_('ExamVersions');
    var exsctTbl = readSheetTable_('ExamSections');
    var exiTbl = readSheetTable_('ExamItems');
    var exaTbl = readSheetTable_('ExamAssignments');
    var attTbl = readSheetTable_('ExamAttempts');
    var atiTbl = readSheetTable_('AttemptItems');
    var atrTbl = readSheetTable_('AttemptResponses');
    var coursesTbl = readSheetTable_('Courses');
    var enrollmentsTbl = readSheetTable_('Enrollments');
    var qbTbl = readSheetTable_('QuestionBank');
    var qvTbl = readSheetTable_('QuestionVersions');
    var qoTbl = readSheetTable_('QuestionOptions');
    var stimTbl = readSheetTable_('SharedStimuli');

    var exHit = exsTbl.byId[examSetId];
    if (!exHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination set "' + examSetId + '" was not found.'
      );
    }
    var exRow = exHit.record;
    if (exRow.status !== 'PUBLISHED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'This examination is not currently open for attempts (status: ' + exRow.status + ').'
      );
    }

    var verHit = exRow.active_exam_version_id ? exvTbl.byId[exRow.active_exam_version_id] : null;
    if (!verHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Published examination version was not found.'
      );
    }
    var verRow = verHit.record;

    // 1. Sweep any already-expired IN_PROGRESS attempt for this student & exam first
    var nowMs = Date.now();
    var studentAttempts = [];
    for (var i = 0; i < attTbl.records.length; i++) {
      var att = attTbl.records[i];
      if (att.exam_set_id === examSetId && att.student_user_id === usr.user_id) {
        if (att.attempt_status === 'IN_PROGRESS') {
          var expCheck = checkAndFinalizeExpiredAttemptInLockPhase4_(att, nowMs);
          att = expCheck.attemptRow;
        }
        studentAttempts.push(att);
      }
    }

    // 2. Check if an active IN_PROGRESS attempt already exists (idempotent replay / double-click start / resume)
    var existingInProgress = null;
    for (var j = 0; j < studentAttempts.length; j++) {
      if (studentAttempts[j].attempt_status === 'IN_PROGRESS') {
        existingInProgress = studentAttempts[j];
        break;
      }
      if (studentAttempts[j].idempotency_key === idempotencyKey && studentAttempts[j].attempt_status !== 'INVALIDATED') {
        existingInProgress = studentAttempts[j];
        isIdempotentReplay = true;
        break;
      }
    }

    if (existingInProgress && existingInProgress.attempt_status === 'IN_PROGRESS') {
      if (existingInProgress.idempotency_key === idempotencyKey) {
        isIdempotentReplay = true;
      } else {
        resumedExistingAttempt = true;
      }
      // Rotate/renew lease token if requested or return active lease
      var renewedLease = existingInProgress.active_lease_token || ('lse_' + Utilities.getUuid().replace(/-/g, ''));
      if (req.acquireLease !== false) {
        renewedLease = 'lse_' + Utilities.getUuid().replace(/-/g, '');
        existingInProgress = updateSheetRecordById_(
          'ExamAttempts',
          existingInProgress.attempt_id,
          {
            active_lease_token: renewedLease,
            updated_at_utc: new Date(nowMs).toISOString()
          },
          Number(existingInProgress.version),
          { skipLock: true }
        );
      }

      workspaceBundle = buildStudentAttemptWorkspaceBundlePhase4_(
        existingInProgress,
        exRow,
        verRow,
        atiTbl.records,
        atrTbl.records,
        exsctTbl.records,
        qbTbl.byId,
        qvTbl.byId,
        qoTbl.records,
        stimTbl.byId
      );
      return;
    }

    // 3. Verify course enrollment, student assignment, schedule window, and remaining attempts
    var isEnrolled = false;
    if (usr.role === 'ADMIN') {
      isEnrolled = true;
    } else if (exRow.course_id) {
      for (var ei = 0; ei < enrollmentsTbl.records.length; ei++) {
        var enr = enrollmentsTbl.records[ei];
        if (
          enr.user_id === usr.user_id &&
          enr.course_id === exRow.course_id &&
          enr.status === 'ACTIVE'
        ) {
          var cHit = coursesTbl.byId[exRow.course_id];
          if (cHit && cHit.record && cHit.record.status === 'PUBLISHED') {
            isEnrolled = true;
          }
          break;
        }
      }
    }

    var assignmentsForExam = [];
    for (var ai = 0; ai < exaTbl.records.length; ai++) {
      if (exaTbl.records[ai].exam_set_id === examSetId) {
        assignmentsForExam.push(exaTbl.records[ai]);
      }
    }

    var catalogEval = evaluateStudentExamCatalogEntryPhase3_(
      exRow,
      verRow,
      exsctTbl.records,
      exiTbl.records,
      usr.user_id,
      isEnrolled,
      assignmentsForExam,
      studentAttempts,
      coursesTbl.byId,
      qbTbl.byId,
      qvTbl.byId,
      usr.role === 'ADMIN'
    );

    if (!catalogEval) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: You are not assigned to this examination.'
      );
    }
    if (catalogEval.availabilityState === 'UPCOMING') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'This examination is not open yet. It opens at ' + catalogEval.openAtBangkok + '.'
      );
    }
    if (catalogEval.availabilityState === 'CLOSED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'This examination is closed and no longer accepts new attempts.'
      );
    }
    if (catalogEval.availabilityState === 'ATTEMPTS_EXHAUSTED' || !catalogEval.canStartNewAttempt) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION || PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'You have used all allowed attempts (' +
          catalogEval.attemptsUsed +
          ' of ' +
          catalogEval.allowedAttemptsDisplay +
          ') for this examination.'
      );
    }

    // 4. Calculate authoritative server deadline (effective_deadline_utc & grace_deadline_utc)
    var nowIso = new Date(nowMs).toISOString();
    var effectiveDurationMins = Number(catalogEval.effectiveDurationMinutes) || 0;
    var effectiveCloseAtUtc = catalogEval.closeAtUtc || '';
    var graceSeconds = Number(exRow.grace_seconds) || 15;

    var effectiveDeadlineUtc = '';
    var graceDeadlineUtc = '';

    if (effectiveDurationMins > 0) {
      var durationDeadlineMs = nowMs + effectiveDurationMins * 60 * 1000;
      var finalDeadlineMs = durationDeadlineMs;
      if (effectiveCloseAtUtc) {
        var closeMs = Date.parse(effectiveCloseAtUtc);
        if (!isNaN(closeMs)) {
          finalDeadlineMs = Math.min(durationDeadlineMs, closeMs);
        }
      }
      effectiveDeadlineUtc = new Date(finalDeadlineMs).toISOString();
      graceDeadlineUtc = new Date(finalDeadlineMs + graceSeconds * 1000).toISOString();
    } else if (effectiveCloseAtUtc) {
      var closeOnlyMs = Date.parse(effectiveCloseAtUtc);
      if (!isNaN(closeOnlyMs)) {
        effectiveDeadlineUtc = new Date(closeOnlyMs).toISOString();
        graceDeadlineUtc = new Date(closeOnlyMs + graceSeconds * 1000).toISOString();
      }
    }

    var nextAttemptNumber = 1;
    for (var sa = 0; sa < studentAttempts.length; sa++) {
      if (studentAttempts[sa].attempt_status !== 'INVALIDATED') {
        var n = Number(studentAttempts[sa].attempt_number) || 1;
        if (n >= nextAttemptNumber) nextAttemptNumber = n + 1;
      }
    }

    ensureExamIntegrityPhaseASheetsExist_();
    var matchedStudentAssignmentRow = null;
    for (var sai = 0; sai < assignmentsForExam.length; sai++) {
      var candAsg = assignmentsForExam[sai];
      if (
        candAsg.target_type === 'STUDENT' &&
        candAsg.student_user_id === usr.user_id &&
        candAsg.assignment_status === 'ASSIGNED'
      ) {
        matchedStudentAssignmentRow = candAsg;
        break;
      }
    }
    var integritySnapshot = resolveAttemptIntegrityPolicySnapshotPhaseA_(
      exRow,
      verRow,
      matchedStudentAssignmentRow
    );
    if (
      integritySnapshot.copyPolicyEnabled &&
      (req.policyAcknowledged === false ||
        (req.requireIntegrityPolicyAck === true && req.policyAcknowledged !== true))
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_EXAM_POLICY_ACK_REQUIRED,
        'You must read and acknowledge the Copy-Restriction and Examination-Integrity Policy before starting this examination.',
        {
          policyAcknowledged:
            'Please acknowledge the Copy-Restriction Policy before starting.'
        }
      );
    }

    var newAttemptId = generateEntityId_('att_');
    var newLeaseToken = 'lse_' + Utilities.getUuid().replace(/-/g, '');
    var newJournalId = generateEntityId_('exj_');

    // Write PENDING journal entry before multi-sheet attempt creation
    insertSheetRecord_(
      'ExamOperationJournal',
      {
        journal_id: newJournalId,
        operation_type: 'START_ATTEMPT',
        idempotency_key: idempotencyKey,
        attempt_id: newAttemptId,
        exam_set_id: examSetId,
        student_user_id: usr.user_id,
        target_status: 'IN_PROGRESS',
        payload_json: JSON.stringify({
          examVersionId: verRow.exam_version_id,
          attemptNumber: nextAttemptNumber,
          effectiveDeadlineUtc: effectiveDeadlineUtc,
          graceDeadlineUtc: graceDeadlineUtc
        }),
        journal_status: 'PENDING',
        created_at_utc: nowIso,
        committed_at_utc: ''
      },
      { skipLock: true }
    );

    var createdAttemptRow = insertSheetRecord_(
      'ExamAttempts',
      {
        attempt_id: newAttemptId,
        exam_set_id: examSetId,
        exam_version_id: verRow.exam_version_id,
        course_id: exRow.course_id || '',
        student_user_id: usr.user_id,
        attempt_number: nextAttemptNumber,
        idempotency_key: idempotencyKey,
        attempt_status: 'IN_PROGRESS',
        grading_status: 'NOT_GRADED',
        publication_status: 'UNPUBLISHED',
        explanation_status: 'WITHHELD',
        started_at_utc: nowIso,
        effective_deadline_utc: effectiveDeadlineUtc,
        grace_deadline_utc: graceDeadlineUtc,
        submitted_at_utc: '',
        last_saved_at_utc: nowIso,
        time_used_seconds: 0,
        active_lease_token: newLeaseToken,
        latest_revision_no: 0,
        answered_count: 0,
        flagged_count: 0,
        auto_score_bp: 0,
        manual_score_bp: 0,
        total_score_bp: 0,
        max_score_bp: Number(verRow.max_points_bp) || 0,
        percentage_bp: 0,
        passed_flag: false,
        current_result_revision_id: '',
        copy_policy_enabled_snapshot: Boolean(integritySnapshot.copyPolicyEnabled),
        copy_policy_version_snapshot: integritySnapshot.policyVersion,
        max_copy_warnings_snapshot: Number(integritySnapshot.maxCopyWarnings) || 5,
        copy_suspension_seconds_snapshot: Number(integritySnapshot.suspensionSeconds) || 5,
        max_invalidations_lock_snapshot: Number(integritySnapshot.maxIntegrityInvalidationsBeforeLock) || 3,
        policy_acknowledged_at_utc: integritySnapshot.copyPolicyEnabled ? nowIso : '',
        copy_warning_count: 0,
        suspension_until_utc: '',
        invalidation_reason_code: '',
        invalidated_at_utc: '',
        invalidation_overturned: false,
        invalidation_overturned_at_utc: '',
        invalidation_overturned_by_user_id: '',
        invalidation_review_reason: '',
        created_at_utc: nowIso,
        updated_at_utc: nowIso
      },
      { skipLock: true }
    );

    if (integritySnapshot.copyPolicyEnabled) {
      insertSheetRecord_(
        'ExamPolicyAcknowledgments',
        {
          ack_id: generateEntityId_('epa_'),
          exam_set_id: examSetId,
          exam_version_id: verRow.exam_version_id,
          attempt_id: newAttemptId,
          student_user_id: usr.user_id,
          policy_version: integritySnapshot.policyVersion,
          max_copy_warnings_snapshot: Number(integritySnapshot.maxCopyWarnings) || 5,
          suspension_seconds_snapshot: Number(integritySnapshot.suspensionSeconds) || 5,
          max_invalidations_before_lock_snapshot:
            Number(integritySnapshot.maxIntegrityInvalidationsBeforeLock) || 3,
          acknowledged_at_utc: nowIso
        },
        { skipLock: true }
      );
    }

    // Refresh qbTbl right before generating items
    qbTbl = readSheetTable_('QuestionBank');
    var createdItems = generateAndPersistAttemptItemsInLockPhase4_(
      createdAttemptRow,
      exRow,
      verRow,
      exsctTbl.records,
      exiTbl.records,
      qbTbl.byId,
      qvTbl.byId,
      qoTbl.records
    );

    updateSheetRecordById_(
      'ExamOperationJournal',
      newJournalId,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: nowIso
      },
      undefined,
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: usr.user_id,
      actorRole: usr.role,
      eventType: 'STUDENT_EXAM_ATTEMPT_STARTED',
      targetEntityType: 'ExamAttempt',
      targetEntityId: newAttemptId,
      summary: {
        examSetId: examSetId,
        examCode: exRow.exam_code,
        examVersionId: verRow.exam_version_id,
        attemptNumber: nextAttemptNumber,
        itemCount: createdItems.length,
        effectiveDeadlineUtc: effectiveDeadlineUtc
      }
    });

    workspaceBundle = buildStudentAttemptWorkspaceBundlePhase4_(
      createdAttemptRow,
      exRow,
      verRow,
      createdItems,
      [],
      exsctTbl.records,
      qbTbl.byId,
      qvTbl.byId,
      qoTbl.records,
      stimTbl.byId
    );
  });

  workspaceBundle.idempotentReplay = isIdempotentReplay;
  workspaceBundle.resumedExistingAttempt = resumedExistingAttempt;
  return workspaceBundle;
}

/**
 * Restores an existing ExamAttempt ('exams.getAttempt') across refresh or reconnection,
 * verifying or rotating the editing lease and checking server-authoritative deadline expiry.
 */
function handleStudentGetExamAttemptPhase4_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to restore an examination attempt.'
    );
  }
  ensureExamPhase4SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  var incomingLeaseToken = sanitizeSingleLineTextStep7_(req.leaseToken, 80);
  var acquireLease = Boolean(req.acquireLease);

  var workspaceBundle = null;
  var expiredNow = false;

  withScriptLock_(function () {
    var attTbl = readSheetTable_('ExamAttempts');
    var exsTbl = readSheetTable_('ExamSets');
    var exvTbl = readSheetTable_('ExamVersions');
    var exsctTbl = readSheetTable_('ExamSections');
    var atiTbl = readSheetTable_('AttemptItems');
    var atrTbl = readSheetTable_('AttemptResponses');
    var qbTbl = readSheetTable_('QuestionBank');
    var qvTbl = readSheetTable_('QuestionVersions');
    var qoTbl = readSheetTable_('QuestionOptions');
    var stimTbl = readSheetTable_('SharedStimuli');

    var targetAttempt = null;
    if (attemptId) {
      var attHit = attTbl.byId[attemptId];
      if (attHit) targetAttempt = attHit.record;
    } else if (examSetId) {
      for (var i = attTbl.records.length - 1; i >= 0; i--) {
        var r = attTbl.records[i];
        if (
          r.exam_set_id === examSetId &&
          r.student_user_id === usr.user_id &&
          r.attempt_status === 'IN_PROGRESS'
        ) {
          targetAttempt = r;
          break;
        }
      }
    }

    if (!targetAttempt) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Active examination attempt was not found.'
      );
    }

    if (usr.role !== 'ADMIN' && targetAttempt.student_user_id !== usr.user_id) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: This examination attempt belongs to another student.'
      );
    }

    if (
      targetAttempt.attempt_status === 'INVALIDATED_COPY_POLICY' ||
      targetAttempt.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED'
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_EXAM_ATTEMPT_INVALIDATED,
        'Examination attempt invalidated: This attempt was invalidated after exceeding the permitted number of detected copy attempts. Your saved answers have been retained for administrator review.',
        {
          attemptId: targetAttempt.attempt_id,
          attemptStatus: targetAttempt.attempt_status,
          invalidationReasonCode:
            targetAttempt.invalidation_reason_code || 'COPY_POLICY_LIMIT_EXCEEDED',
          invalidatedAtUtc: targetAttempt.invalidated_at_utc || '',
          copyWarningCount: String(Number(targetAttempt.copy_warning_count) || 6)
        }
      );
    }

    // Check deadline expiration against server clock
    var expCheck = checkAndFinalizeExpiredAttemptInLockPhase4_(targetAttempt, Date.now());
    targetAttempt = expCheck.attemptRow;
    expiredNow = expCheck.expiredNow;

    if (targetAttempt.attempt_status === 'IN_PROGRESS') {
      if (acquireLease || !targetAttempt.active_lease_token) {
        var newLease = 'lse_' + Utilities.getUuid().replace(/-/g, '');
        targetAttempt = updateSheetRecordById_(
          'ExamAttempts',
          targetAttempt.attempt_id,
          {
            active_lease_token: newLease,
            updated_at_utc: nowUtcIso_()
          },
          Number(targetAttempt.version),
          { skipLock: true }
        );
      } else if (
        incomingLeaseToken &&
        targetAttempt.active_lease_token &&
        incomingLeaseToken !== targetAttempt.active_lease_token
      ) {
        throw createAppError_(
          'ERR_EXAM_LEASE_CONFLICT',
          'This attempt is currently open in a newer browser tab or window. Click "Resume in This Tab" to take over the editing session.',
          { leaseToken: 'Superseded by another active browser tab.' }
        );
      }
    }

    var exHit = exsTbl.byId[targetAttempt.exam_set_id];
    var verHit = exvTbl.byId[targetAttempt.exam_version_id];
    if (!exHit || !verHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Referenced examination version was not found.'
      );
    }

    workspaceBundle = buildStudentAttemptWorkspaceBundlePhase4_(
      targetAttempt,
      exHit.record,
      verHit.record,
      atiTbl.records,
      atrTbl.records,
      exsctTbl.records,
      qbTbl.byId,
      qvTbl.byId,
      qoTbl.records,
      stimTbl.byId
    );
  });

  workspaceBundle.expiredAndFinalized = expiredNow;
  return workspaceBundle;
}

/**
 * Saves a debounced batch of student question responses ('exams.saveResponses').
 * Enforces server-authoritative deadline ('<= grace_deadline_utc'), multi-tab editing lease,
 * monotonic per-item client_revision_no (never overwriting a newer revision with a stale one),
 * and question-type response validation.
 */
function handleStudentSaveExamResponsesPhase4_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to save examination responses.'
    );
  }
  ensureExamPhase4SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  var leaseToken = sanitizeSingleLineTextStep7_(req.leaseToken, 80);
  var forceTakeoverLease = Boolean(req.forceTakeoverLease);
  var batchClientRevNo = Math.max(1, parseInt(req.clientRevisionNo, 10) || 1);
  var rawResponses = Array.isArray(req.responses) ? req.responses : [];

  if (!attemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'attemptId is required to save responses.'
    );
  }

  var saveResult = null;
  withScriptLock_(function () {
    var attTbl = readSheetTable_('ExamAttempts');
    var atiTbl = readSheetTable_('AttemptItems');
    var atrTbl = readSheetTable_('AttemptResponses');
    var qvTbl = readSheetTable_('QuestionVersions');
    var qoTbl = readSheetTable_('QuestionOptions');

    var attHit = attTbl.byId[attemptId];
    if (!attHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination attempt "' + attemptId + '" was not found.'
      );
    }
    var att = attHit.record;

    if (att.student_user_id !== usr.user_id) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: You cannot modify another student\'s attempt.'
      );
    }

    if (
      att.attempt_status === 'INVALIDATED_COPY_POLICY' ||
      att.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED'
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_EXAM_ATTEMPT_INVALIDATED,
        'Examination attempt invalidated: This attempt was invalidated after exceeding the permitted number of detected copy attempts. Your saved answers have been retained for administrator review.',
        {
          attemptId: att.attempt_id,
          attemptStatus: att.attempt_status,
          invalidationReasonCode: att.invalidation_reason_code || 'COPY_POLICY_LIMIT_EXCEEDED'
        }
      );
    }

    if (att.attempt_status !== 'IN_PROGRESS') {
      throw createAppError_(
        'ERR_EXAM_ATTEMPT_NOT_EDITABLE',
        'This attempt is no longer editable (current status: ' + att.attempt_status + ').'
      );
    }

    var nowMs = Date.now();
    var expCheck = checkAndFinalizeExpiredAttemptInLockPhase4_(att, nowMs);
    if (expCheck.expiredNow) {
      throw createAppError_(
        'ERR_EXAM_DEADLINE_EXPIRED',
        'The examination deadline has expired on the server. Late answer changes after the grace window cannot be saved; your previously saved responses have been finalized.',
        {
          attemptStatus: 'EXPIRED_SUBMITTED',
          effectiveDeadlineUtc: att.effective_deadline_utc,
          graceDeadlineUtc: att.grace_deadline_utc
        }
      );
    }

    assertAttemptNotSuspendedByCopyPolicyPhaseB_(att, nowMs);

    var activeLease = att.active_lease_token || '';
    if (activeLease && leaseToken !== activeLease) {
      if (forceTakeoverLease) {
        activeLease = 'lse_' + Utilities.getUuid().replace(/-/g, '');
      } else {
        throw createAppError_(
          'ERR_EXAM_LEASE_CONFLICT',
          'Another browser tab or device has taken over this examination attempt. Refresh or click "Take Over in This Tab" to continue.',
          { leaseToken: 'Lease token mismatch.' }
        );
      }
    } else if (!activeLease) {
      activeLease = leaseToken || ('lse_' + Utilities.getUuid().replace(/-/g, ''));
    }

    // Index AttemptItems for this attempt
    var attemptItemsById = {};
    var totalAttemptItems = 0;
    var flaggedCount = 0;
    for (var i = 0; i < atiTbl.records.length; i++) {
      var it = atiTbl.records[i];
      if (it.attempt_id === attemptId) {
        attemptItemsById[it.attempt_item_id] = it;
        totalAttemptItems += 1;
        if (it.is_flagged) flaggedCount += 1;
      }
    }

    // Index valid options by question_version_id
    var validOptsByQvId = {};
    for (var oi = 0; oi < qoTbl.records.length; oi++) {
      var op = qoTbl.records[oi];
      if (!validOptsByQvId[op.question_version_id]) {
        validOptsByQvId[op.question_version_id] = {};
      }
      validOptsByQvId[op.question_version_id][op.option_id] = op;
    }

    // Index existing AttemptResponses for this attempt
    var existingRespByItemId = {};
    for (var ri = 0; ri < atrTbl.records.length; ri++) {
      var rRow = atrTbl.records[ri];
      if (rRow.attempt_id === attemptId) {
        existingRespByItemId[rRow.attempt_item_id] = rRow;
      }
    }

    var nowIso = new Date(nowMs).toISOString();
    var nextServerRevNo = (Number(att.latest_revision_no) || 0) + 1;
    var itemSaveStatuses = [];
    var skippedStaleRevisionItems = [];

    for (var k = 0; k < rawResponses.length && k < 200; k++) {
      var entry = rawResponses[k] || {};
      var atiId = sanitizeSingleLineTextStep7_(entry.attemptItemId, 64);
      if (!atiId) continue;

      var atiRec = attemptItemsById[atiId];
      if (!atiRec) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Attempt item "' + atiId + '" does not belong to attempt "' + attemptId + '".'
        );
      }

      var itemClientRev =
        entry.clientRevisionNo !== undefined && entry.clientRevisionNo !== null
          ? Math.max(1, parseInt(entry.clientRevisionNo, 10) || batchClientRevNo)
          : batchClientRevNo;

      var existingResp = existingRespByItemId[atiId] || null;
      if (existingResp && Number(existingResp.client_revision_no) > itemClientRev) {
        // Out-of-order stale network request: skip overwriting newer response!
        skippedStaleRevisionItems.push({
          attemptItemId: atiId,
          incomingClientRevisionNo: itemClientRev,
          storedClientRevisionNo: Number(existingResp.client_revision_no)
        });
        itemSaveStatuses.push({
          attemptItemId: atiId,
          status: 'SKIPPED_STALE_REVISION',
          isAnswered: Boolean(existingResp.is_answered),
          clientRevisionNo: Number(existingResp.client_revision_no),
          serverRevisionNo: Number(existingResp.server_revision_no),
          savedAtUtc: existingResp.saved_at_utc
        });
        continue;
      }

      var qvHit = qvTbl.byId[atiRec.question_version_id];
      var qvRec = qvHit ? qvHit.record : null;
      var validOptsMap = validOptsByQvId[atiRec.question_version_id] || {};

      var validatedResp = validateAndNormalizeStudentResponsePayloadPhase4_(
        entry.responsePayload,
        qvRec,
        validOptsMap,
        atiId
      );

      var serializedPayload = JSON.stringify(validatedResp.normalizedPayload);
      var savedRespRow = null;

      if (!existingResp) {
        savedRespRow = insertSheetRecord_(
          'AttemptResponses',
          {
            response_id: generateEntityId_('atr_'),
            attempt_id: attemptId,
            attempt_item_id: atiId,
            question_version_id: atiRec.question_version_id,
            student_user_id: usr.user_id,
            response_payload_json: serializedPayload,
            is_answered: validatedResp.isAnswered,
            client_revision_no: itemClientRev,
            server_revision_no: nextServerRevNo,
            saved_at_utc: nowIso,
            grading_source: 'UNGRADED',
            awarded_points_bp: 0,
            max_points_bp: Number(atiRec.points_bp) || 100,
            correctness_state: 'UNGRADED',
            instructor_feedback: '',
            graded_by_user_id: '',
            graded_at_utc: '',
            created_at_utc: nowIso,
            updated_at_utc: nowIso
          },
          { skipLock: true }
        );
      } else {
        savedRespRow = updateSheetRecordById_(
          'AttemptResponses',
          existingResp.response_id,
          {
            response_payload_json: serializedPayload,
            is_answered: validatedResp.isAnswered,
            client_revision_no: itemClientRev,
            server_revision_no: nextServerRevNo,
            saved_at_utc: nowIso,
            updated_at_utc: nowIso
          },
          Number(existingResp.version),
          { skipLock: true }
        );
      }

      existingRespByItemId[atiId] = savedRespRow;
      itemSaveStatuses.push({
        attemptItemId: atiId,
        status: 'SAVED',
        isAnswered: Boolean(savedRespRow.is_answered),
        clientRevisionNo: itemClientRev,
        serverRevisionNo: nextServerRevNo,
        savedAtUtc: nowIso,
        savedAtBangkok: formatBangkokTimestamp_(nowIso)
      });
    }

    var answeredCount = 0;
    var respKeys = Object.keys(existingRespByItemId);
    for (var rk = 0; rk < respKeys.length; rk++) {
      if (existingRespByItemId[respKeys[rk]].is_answered) {
        answeredCount += 1;
      }
    }

    var startedMs = Date.parse(att.started_at_utc) || nowMs;
    var elapsedSec = Math.max(0, Math.round((nowMs - startedMs) / 1000));

    updateSheetRecordById_(
      'ExamAttempts',
      attemptId,
      {
        active_lease_token: activeLease,
        last_saved_at_utc: nowIso,
        latest_revision_no: nextServerRevNo,
        answered_count: answeredCount,
        flagged_count: flaggedCount,
        time_used_seconds: elapsedSec,
        updated_at_utc: nowIso
      },
      Number(att.version),
      { skipLock: true }
    );

    var effDeadlineStr = att.effective_deadline_utc || '';
    var effDeadlineMs = effDeadlineStr ? Date.parse(effDeadlineStr) : NaN;
    var remainingSecondsServer =
      !isNaN(effDeadlineMs)
        ? Math.max(0, Math.floor((effDeadlineMs - nowMs) / 1000))
        : null;

    saveResult = {
      saved: true,
      attemptId: attemptId,
      leaseToken: activeLease,
      serverRevisionNo: nextServerRevNo,
      lastSavedAtUtc: nowIso,
      lastSavedAtBangkok: formatBangkokTimestamp_(nowIso),
      totalQuestionsCount: totalAttemptItems,
      answeredCount: answeredCount,
      unansweredCount: Math.max(0, totalAttemptItems - answeredCount),
      flaggedCount: flaggedCount,
      serverNowUtc: nowIso,
      remainingSecondsServer: remainingSecondsServer,
      itemSaveStatuses: itemSaveStatuses,
      skippedStaleRevisionItems: skippedStaleRevisionItems
    };
  });

  return saveResult;
}

/**
 * Updates flag-for-review state on one or more AttemptItems ('exams.saveFlags').
 */
function handleStudentSaveExamFlagsPhase4_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to update question flags.'
    );
  }
  ensureExamPhase4SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  var leaseToken = sanitizeSingleLineTextStep7_(req.leaseToken, 80);
  var rawFlags = Array.isArray(req.flags) ? req.flags : [];
  if (rawFlags.length === 0 && req.attemptItemId) {
    rawFlags.push({
      attemptItemId: req.attemptItemId,
      isFlagged: Boolean(req.isFlagged)
    });
  }

  if (!attemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'attemptId is required.'
    );
  }

  var flagResult = null;
  withScriptLock_(function () {
    var attTbl = readSheetTable_('ExamAttempts');
    var atiTbl = readSheetTable_('AttemptItems');

    var attHit = attTbl.byId[attemptId];
    if (!attHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination attempt "' + attemptId + '" was not found.'
      );
    }
    var att = attHit.record;
    if (att.student_user_id !== usr.user_id) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: You cannot modify another student\'s attempt.'
      );
    }
    if (
      att.attempt_status === 'INVALIDATED_COPY_POLICY' ||
      att.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED'
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_EXAM_ATTEMPT_INVALIDATED,
        'Examination attempt invalidated: This attempt was invalidated after exceeding the permitted number of detected copy attempts.',
        {
          attemptId: att.attempt_id,
          attemptStatus: att.attempt_status,
          invalidationReasonCode: att.invalidation_reason_code || 'COPY_POLICY_LIMIT_EXCEEDED'
        }
      );
    }

    if (att.attempt_status !== 'IN_PROGRESS') {
      throw createAppError_(
        'ERR_EXAM_ATTEMPT_NOT_EDITABLE',
        'This attempt is no longer editable (status: ' + att.attempt_status + ').'
      );
    }

    var nowMs = Date.now();
    var expCheck = checkAndFinalizeExpiredAttemptInLockPhase4_(att, nowMs);
    if (expCheck.expiredNow) {
      throw createAppError_(
        'ERR_EXAM_DEADLINE_EXPIRED',
        'The examination deadline has expired on the server.'
      );
    }

    assertAttemptNotSuspendedByCopyPolicyPhaseB_(att, nowMs);

    if (att.active_lease_token && leaseToken && leaseToken !== att.active_lease_token) {
      throw createAppError_(
        'ERR_EXAM_LEASE_CONFLICT',
        'Another browser tab holds the active editing lease for this attempt.'
      );
    }

    var nowIso = new Date(nowMs).toISOString();
    var updatedFlags = [];
    for (var i = 0; i < rawFlags.length; i++) {
      var fEntry = rawFlags[i] || {};
      var atiId = sanitizeSingleLineTextStep7_(fEntry.attemptItemId, 64);
      var hit = atiTbl.byId[atiId];
      if (!hit || hit.record.attempt_id !== attemptId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Attempt item "' + atiId + '" does not belong to attempt "' + attemptId + '".'
        );
      }
      var newFlagState = Boolean(fEntry.isFlagged);
      updateSheetRecordById_(
        'AttemptItems',
        atiId,
        {
          is_flagged: newFlagState,
          flag_updated_at_utc: nowIso
        },
        undefined,
        { skipLock: true }
      );
      hit.record.is_flagged = newFlagState;
      updatedFlags.push({
        attemptItemId: atiId,
        isFlagged: newFlagState,
        flagUpdatedAtUtc: nowIso
      });
    }

    var flaggedCount = 0;
    for (var j = 0; j < atiTbl.records.length; j++) {
      if (atiTbl.records[j].attempt_id === attemptId && atiTbl.records[j].is_flagged) {
        flaggedCount += 1;
      }
    }

    updateSheetRecordById_(
      'ExamAttempts',
      attemptId,
      {
        flagged_count: flaggedCount,
        last_saved_at_utc: nowIso,
        updated_at_utc: nowIso
      },
      Number(att.version),
      { skipLock: true }
    );

    flagResult = {
      saved: true,
      attemptId: attemptId,
      flaggedCount: flaggedCount,
      updatedFlags: updatedFlags,
      lastSavedAtUtc: nowIso,
      lastSavedAtBangkok: formatBangkokTimestamp_(nowIso)
    };
  });

  return flagResult;
}




// ============================================================================
// NATIVE ONLINE EXAMINATION SYSTEM -- PHASE 5: DETERMINISTIC ITEM EVALUATOR
// & PRACTICE-ONLY PER-QUESTION FEEDBACK CHECK ('exams.checkPracticeItem')
// ============================================================================

/**
 * Deterministic half-away-from-zero rounding helper for NUMERIC_RESPONSE evaluation.
 */
function roundHalfAwayFromZeroPhase5_(numVal, decimals) {
  if (!isFinite(numVal)) return NaN;
  var d = Math.max(0, Math.min(8, parseInt(decimals, 10) || 0));
  var factor = Math.pow(10, d);
  var scaled = numVal * factor;
  var roundedInt = scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
  return roundedInt / factor;
}

/**
 * Normalizes a short-answer string for deterministic matching (zero AI/fuzzy guessing).
 */
function normalizeShortAnswerStringPhase5_(rawStr, caseSensitive, collapseWhitespace, trimPunctuation) {
  var s = String(rawStr === null || rawStr === undefined ? '' : rawStr).trim();
  if (trimPunctuation !== false) {
    s = s.replace(/^[.,;:!?"'()\[\]{}]+|[.,;:!?"'()\[\]{}]+$/g, '').trim();
  }
  if (collapseWhitespace !== false) {
    s = s.replace(/\s+/g, ' ');
  }
  if (!caseSensitive) {
    s = s.toLowerCase();
  }
  return s;
}

/**
 * Evaluates a single AttemptItem response deterministically using scaled integer basis points (bp).
 * Used by Practice-mode per-question feedback (Phase 5) and full attempt grading/regrading (Phase 6 & 7).
 */
function evaluateSingleAttemptItemScorePhase5_(
  qvRec,
  rawPayload,
  itemPointsBp,
  itemNegativePointsBp
) {
  var maxBp = Math.max(0, Number(itemPointsBp) || Number(qvRec && qvRec.default_points_bp) || 100);
  var negBp = Math.max(0, Number(itemNegativePointsBp) || Number(qvRec && qvRec.negative_points_bp) || 0);
  var qType = qvRec ? qvRec.question_type : 'SINGLE_CHOICE';
  var gMode = qvRec ? qvRec.grading_mode || 'AUTO' : 'AUTO';
  var spec = {};
  try {
    spec = JSON.parse((qvRec && qvRec.grading_spec_private_json) || '{}');
  } catch (e) {
    spec = {};
  }

  var p = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};

  if (qType === 'SINGLE_CHOICE' || qType === 'TRUE_FALSE') {
    var selId = String(p.selectedOptionId || '').trim();
    if (!selId) {
      return {
        isAnswered: false,
        gradingSource: 'AUTO_ENGINE',
        correctnessState: 'UNANSWERED',
        awardedPointsBp: 0,
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }
    var correctIds = Array.isArray(spec.correctOptionIds) ? spec.correctOptionIds : [];
    var isHit = correctIds.indexOf(selId) !== -1;
    return {
      isAnswered: true,
      gradingSource: 'AUTO_ENGINE',
      correctnessState: isHit ? 'CORRECT' : 'INCORRECT',
      awardedPointsBp: isHit ? maxBp : (negBp > 0 ? -negBp : 0),
      maxPointsBp: maxBp,
      requiresManualReview: false
    };
  }

  if (qType === 'COMPLEX_MULTIPLE_CHOICE') {
    var rawDec = p.statementDecisions && typeof p.statementDecisions === 'object' ? p.statementDecisions : {};
    var truthMap = spec.statementTruthMap && typeof spec.statementTruthMap === 'object' ? spec.statementTruthMap : null;
    if (!truthMap) {
      truthMap = {};
      var fallbackCorrIds = Array.isArray(spec.correctOptionIds) ? spec.correctOptionIds : [];
      for (var fc = 0; fc < fallbackCorrIds.length; fc++) {
        truthMap[fallbackCorrIds[fc]] = true;
      }
    }
    var stmtIds = Object.keys(truthMap);
    var answeredStmts = 0;
    var matchedStmts = 0;
    for (var si = 0; si < stmtIds.length; si++) {
      var sid = stmtIds[si];
      var expectedDec = truthMap[sid] ? 'YES' : 'NO';
      var givenDec = String(rawDec[sid] || '').trim().toUpperCase();
      if (givenDec === 'YES' || givenDec === 'NO') {
        answeredStmts += 1;
        if (givenDec === expectedDec) {
          matchedStmts += 1;
        }
      }
    }
    if (answeredStmts === 0) {
      return {
        isAnswered: false,
        gradingSource: 'AUTO_ENGINE',
        correctnessState: 'UNANSWERED',
        awardedPointsBp: 0,
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }
    var totalStmts = stmtIds.length || 3;
    if (matchedStmts === totalStmts) {
      return {
        isAnswered: true,
        gradingSource: 'AUTO_ENGINE',
        correctnessState: 'CORRECT',
        awardedPointsBp: maxBp,
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }
    if (totalStmts >= 3 && matchedStmts === totalStmts - 1) {
      return {
        isAnswered: true,
        gradingSource: 'AUTO_ENGINE',
        correctnessState: 'PARTIAL',
        awardedPointsBp: Math.round(maxBp / 2),
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }
    return {
      isAnswered: true,
      gradingSource: 'AUTO_ENGINE',
      correctnessState: 'INCORRECT',
      awardedPointsBp: negBp > 0 ? -negBp : 0,
      maxPointsBp: maxBp,
      requiresManualReview: false
    };
  }

  if (qType === 'MULTIPLE_SELECT') {
    var selArr = Array.isArray(p.selectedOptionIds) ? p.selectedOptionIds : [];
    var cleanSel = [];
    var seen = {};
    for (var i = 0; i < selArr.length; i++) {
      var oid = String(selArr[i] || '').trim();
      if (oid && !seen[oid]) {
        seen[oid] = true;
        cleanSel.push(oid);
      }
    }
    if (cleanSel.length === 0) {
      return {
        isAnswered: false,
        gradingSource: 'AUTO_ENGINE',
        correctnessState: 'UNANSWERED',
        awardedPointsBp: 0,
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }

    var corrArr = Array.isArray(spec.correctOptionIds) ? spec.correctOptionIds : [];
    var corrMap = {};
    for (var c = 0; c < corrArr.length; c++) {
      corrMap[corrArr[c]] = true;
    }

    var chosenCorrect = 0;
    var chosenIncorrect = 0;
    for (var k = 0; k < cleanSel.length; k++) {
      if (corrMap[cleanSel[k]]) {
        chosenCorrect += 1;
      } else {
        chosenIncorrect += 1;
      }
    }

    var isExact = chosenIncorrect === 0 && chosenCorrect === corrArr.length && corrArr.length > 0;
    if (isExact) {
      return {
        isAnswered: true,
        gradingSource: 'AUTO_ENGINE',
        correctnessState: 'CORRECT',
        awardedPointsBp: maxBp,
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }

    var rule = String(spec.scoringRule || 'EXACT_MATCH').toUpperCase();
    if (rule === 'PARTIAL_WITHOUT_OVERSELECT' && chosenIncorrect === 0 && chosenCorrect > 0 && corrArr.length > 0) {
      var partialBp = Math.round((maxBp * chosenCorrect) / corrArr.length);
      return {
        isAnswered: true,
        gradingSource: 'AUTO_ENGINE',
        correctnessState: 'PARTIAL',
        awardedPointsBp: Math.min(maxBp, Math.max(0, partialBp)),
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }

    return {
      isAnswered: true,
      gradingSource: 'AUTO_ENGINE',
      correctnessState: 'INCORRECT',
      awardedPointsBp: negBp > 0 ? -negBp : 0,
      maxPointsBp: maxBp,
      requiresManualReview: false
    };
  }

  if (qType === 'NUMERIC_RESPONSE') {
    var rawNumStr = String(
      p.numericText !== undefined && p.numericText !== null ? p.numericText : ''
    ).trim();
    if (!rawNumStr) {
      return {
        isAnswered: false,
        gradingSource: 'AUTO_ENGINE',
        correctnessState: 'UNANSWERED',
        awardedPointsBp: 0,
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }
    var numVal = Number(rawNumStr);
    if (!isFinite(numVal)) {
      return {
        isAnswered: true,
        gradingSource: 'AUTO_ENGINE',
        correctnessState: 'INCORRECT',
        awardedPointsBp: negBp > 0 ? -negBp : 0,
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }

    if (spec.roundingDecimals !== undefined && spec.roundingDecimals !== null && spec.roundingDecimals !== '') {
      numVal = roundHalfAwayFromZeroPhase5_(numVal, Number(spec.roundingDecimals));
    }

    var isNumCorrect = false;
    if (spec.matchMode === 'ACCEPTABLE_RANGE') {
      var rMin = Number(spec.rangeMin);
      var rMax = Number(spec.rangeMax);
      isNumCorrect = numVal >= rMin - 1e-9 && numVal <= rMax + 1e-9;
    } else {
      var target = Number(spec.targetValue);
      var tolType = String(spec.toleranceType || 'NONE').toUpperCase();
      var tolVal = Number(spec.toleranceValue) || 0;
      var allowedDelta = 0;
      if (tolType === 'ABSOLUTE') {
        allowedDelta = Math.abs(tolVal);
      } else if (tolType === 'RELATIVE_PERCENT') {
        allowedDelta = Math.abs(target) * (Math.abs(tolVal) / 100);
      }
      isNumCorrect = Math.abs(numVal - target) <= allowedDelta + 1e-9;
    }

    return {
      isAnswered: true,
      gradingSource: 'AUTO_ENGINE',
      correctnessState: isNumCorrect ? 'CORRECT' : 'INCORRECT',
      awardedPointsBp: isNumCorrect ? maxBp : (negBp > 0 ? -negBp : 0),
      maxPointsBp: maxBp,
      requiresManualReview: false
    };
  }

  if (qType === 'SHORT_ANSWER') {
    var saText = String(p.textResponse !== undefined && p.textResponse !== null ? p.textResponse : '').trim();
    if (!saText) {
      return {
        isAnswered: false,
        gradingSource: gMode === 'MANUAL' ? 'UNGRADED' : 'AUTO_ENGINE',
        correctnessState: 'UNANSWERED',
        awardedPointsBp: 0,
        maxPointsBp: maxBp,
        requiresManualReview: false
      };
    }

    if (gMode === 'AUTO' || gMode === 'AUTO_WITH_MANUAL_REVIEW') {
      var accList = Array.isArray(spec.acceptedAnswers) ? spec.acceptedAnswers : [];
      var normCandidate = normalizeShortAnswerStringPhase5_(
        saText,
        Boolean(spec.caseSensitive),
        spec.collapseWhitespace !== false,
        spec.trimPunctuation !== false
      );
      var matchedAuto = false;
      for (var ai = 0; ai < accList.length; ai++) {
        var normAcc = normalizeShortAnswerStringPhase5_(
          accList[ai],
          Boolean(spec.caseSensitive),
          spec.collapseWhitespace !== false,
          spec.trimPunctuation !== false
        );
        if (normAcc && normCandidate === normAcc) {
          matchedAuto = true;
          break;
        }
      }
      if (matchedAuto) {
        return {
          isAnswered: true,
          gradingSource: 'AUTO_ENGINE',
          correctnessState: 'CORRECT',
          awardedPointsBp: maxBp,
          maxPointsBp: maxBp,
          requiresManualReview: false
        };
      }
      if (gMode === 'AUTO') {
        return {
          isAnswered: true,
          gradingSource: 'AUTO_ENGINE',
          correctnessState: 'INCORRECT',
          awardedPointsBp: 0,
          maxPointsBp: maxBp,
          requiresManualReview: false
        };
      }
      // AUTO_WITH_MANUAL_REVIEW falls back to manual review when no exact normalized string matched
    }

    return {
      isAnswered: true,
      gradingSource: 'UNGRADED',
      correctnessState: 'MANUAL_REVIEW_PENDING',
      awardedPointsBp: 0,
      maxPointsBp: maxBp,
      requiresManualReview: true
    };
  }

  // WRITTEN_RESPONSE
  var wrText = String(p.textResponse !== undefined && p.textResponse !== null ? p.textResponse : '').trim();
  if (!wrText) {
    return {
      isAnswered: false,
      gradingSource: 'UNGRADED',
      correctnessState: 'UNANSWERED',
      awardedPointsBp: 0,
      maxPointsBp: maxBp,
      requiresManualReview: false
    };
  }
  return {
    isAnswered: true,
    gradingSource: 'UNGRADED',
    correctnessState: 'MANUAL_REVIEW_PENDING',
    awardedPointsBp: 0,
    maxPointsBp: maxBp,
    requiresManualReview: true
  };
}

/**
 * Checks a single question response during an active attempt ONLY when the exam is
 * in PRACTICE mode with allow_per_question_practice_feedback === true ('exams.checkPracticeItem').
 * Strictly blocks MOCK_EXAM and ASSIGNED_ASSESSMENT!
 */
function handleStudentCheckPracticeItemPhase5_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required.'
    );
  }
  ensureExamPhase4SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  var attemptItemId = sanitizeSingleLineTextStep7_(req.attemptItemId, 64);
  var leaseToken = sanitizeSingleLineTextStep7_(req.leaseToken, 80);

  if (!attemptId || !attemptItemId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'attemptId and attemptItemId are required.'
    );
  }

  var attTbl = readSheetTable_('ExamAttempts');
  var exsTbl = readSheetTable_('ExamSets');
  var atiTbl = readSheetTable_('AttemptItems');
  var qvTbl = readSheetTable_('QuestionVersions');

  var attHit = attTbl.byId[attemptId];
  if (!attHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Attempt "' + attemptId + '" was not found.'
    );
  }
  var att = attHit.record;
  if (att.student_user_id !== usr.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Access denied: Attempt belongs to another student.'
    );
  }

  var exHit = exsTbl.byId[att.exam_set_id];
  var exRow = exHit ? exHit.record : null;
  if (
    !exRow ||
    exRow.exam_mode !== 'PRACTICE' ||
    !Boolean(exRow.allow_per_question_practice_feedback)
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Per-question immediate feedback is disabled for this examination mode (' +
        (exRow ? exRow.exam_mode : 'UNKNOWN') +
        ').'
    );
  }

  var atiHit = atiTbl.byId[attemptItemId];
  if (!atiHit || atiHit.record.attempt_id !== attemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Attempt item "' + attemptItemId + '" does not belong to attempt "' + attemptId + '".'
    );
  }
  var atiRec = atiHit.record;
  var qvHit = qvTbl.byId[atiRec.question_version_id];
  if (!qvHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Question version was not found.'
    );
  }
  var qvRec = qvHit.record;

  // Save the current response first if provided
  if (req.responsePayload !== undefined) {
    handleStudentSaveExamResponsesPhase4_(
      {
        attemptId: attemptId,
        leaseToken: leaseToken,
        clientRevisionNo: Number(req.clientRevisionNo) || (Number(att.latest_revision_no) || 0) + 1,
        responses: [
          {
            attemptItemId: attemptItemId,
            responsePayload: req.responsePayload
          }
        ]
      },
      context
    );
  }

  var evalRes = evaluateSingleAttemptItemScorePhase5_(
    qvRec,
    req.responsePayload || {},
    atiRec.points_bp,
    atiRec.negative_points_bp
  );

  var expDoc = parseStoredRichTextJsonSafe_(qvRec.explanation_richtext_json);
  return {
    attemptId: attemptId,
    attemptItemId: attemptItemId,
    correctnessState: evalRes.correctnessState,
    awardedPointsBp: evalRes.awardedPointsBp,
    awardedPointsDisplay: formatPointsBpDisplayPhase2_(evalRes.awardedPointsBp),
    maxPointsBp: evalRes.maxPointsBp,
    maxPointsDisplay: formatPointsBpDisplayPhase2_(evalRes.maxPointsBp),
    explanationRichText: expDoc,
    explanationPlainText: extractPlainTextFromRichTextDocPhase2_(expDoc),
    referenceText: qvRec.reference_text || ''
  };
}




// ============================================================================
// NATIVE ONLINE EXAMINATION SYSTEM -- PHASE 6: IDEMPOTENT SUBMISSION,
// BACKEND AUTO-GRADING, MANUAL RUBRIC GRADING & JOURNAL RECOVERY
// ============================================================================

/**
 * Dynamically registers the Phase 6 normalized 'ResultRevisions' worksheet
 * in PB_SHEET_NAMES_ and PB_SHEET_SCHEMAS_.
 */
function ensureExamPhase6SchemasRegistered_() {
  ensureExamPhase4SchemasRegistered_();
  if (typeof PB_SHEET_NAMES_ === 'object' && PB_SHEET_NAMES_ && !PB_SHEET_NAMES_.RESULT_REVISIONS) {
    var nextNames = {};
    var nameKeys = Object.keys(PB_SHEET_NAMES_);
    for (var i = 0; i < nameKeys.length; i++) {
      nextNames[nameKeys[i]] = PB_SHEET_NAMES_[nameKeys[i]];
    }
    nextNames.RESULT_REVISIONS = 'ResultRevisions';
    PB_SHEET_NAMES_ = Object.freeze(nextNames);
  }

  if (typeof PB_SHEET_SCHEMAS_ === 'object' && PB_SHEET_SCHEMAS_ && !PB_SHEET_SCHEMAS_.ResultRevisions) {
    var nextSchemas = {};
    var schemaKeys = Object.keys(PB_SHEET_SCHEMAS_);
    for (var j = 0; j < schemaKeys.length; j++) {
      nextSchemas[schemaKeys[j]] = PB_SHEET_SCHEMAS_[schemaKeys[j]];
    }

    nextSchemas.ResultRevisions = Object.freeze({
      sheetName: 'ResultRevisions',
      primaryKey: 'result_revision_id',
      idPrefix: 'rrv_',
      hasVersion: false,
      headers: Object.freeze([
        'result_revision_id',
        'attempt_id',
        'exam_set_id',
        'exam_version_id',
        'student_user_id',
        'revision_no',
        'revision_type',
        'auto_score_bp',
        'manual_score_bp',
        'total_score_bp',
        'max_score_bp',
        'percentage_bp',
        'passed_flag',
        'grading_status',
        'publication_status',
        'explanation_status',
        'reason',
        'actor_user_id',
        'created_at_utc'
      ]),
      requiredFields: Object.freeze([
        'result_revision_id',
        'attempt_id',
        'exam_set_id',
        'exam_version_id',
        'student_user_id',
        'revision_no',
        'revision_type',
        'grading_status',
        'publication_status',
        'explanation_status',
        'actor_user_id',
        'created_at_utc'
      ]),
      enums: Object.freeze({
        revision_type: Object.freeze([
          'INITIAL_AUTO_GRADE',
          'MANUAL_GRADING_COMPLETED',
          'PUBLICATION_CHANGE',
          'ADMIN_REGRADE'
        ]),
        grading_status: Object.freeze([
          'NOT_GRADED',
          'GRADING_IN_PROGRESS',
          'AUTO_GRADED_PENDING_MANUAL',
          'GRADED',
          'REGRADED'
        ]),
        publication_status: Object.freeze([
          'UNPUBLISHED',
          'SCHEDULED',
          'PUBLISHED',
          'WITHHELD'
        ]),
        explanation_status: Object.freeze(['WITHHELD', 'RELEASED'])
      }),
      booleanFields: Object.freeze(['passed_flag']),
      integerFields: Object.freeze([
        'revision_no',
        'auto_score_bp',
        'manual_score_bp',
        'total_score_bp',
        'max_score_bp',
        'percentage_bp'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    PB_SHEET_SCHEMAS_ = Object.freeze(nextSchemas);
  }
}

function ensureExamPhase6SheetsExist_() {
  ensureExamPhase6SchemasRegistered_();
  ensureExamPhase4SheetsExist_();
  var ss = openConfiguredSpreadsheet_();
  if (!ss.getSheetByName('ResultRevisions') && PB_SHEET_SCHEMAS_.ResultRevisions) {
    ensureSingleSheetSchema_(ss, 'ResultRevisions');
  }
}

function formatDurationSecondsHumanPhase6_(seconds) {
  var s = Math.max(0, Math.round(Number(seconds) || 0));
  var mins = Math.floor(s / 60);
  var remSec = s % 60;
  if (mins === 0) return remSec + 's';
  return mins + 'm ' + remSec + 's';
}

function buildSubmissionReceiptCodePhase6_(examCode, attemptNumber, attemptId) {
  var cleanCode = String(examCode || 'EXAM').replace(/[^A-Z0-9_-]/gi, '').toUpperCase().slice(0, 18);
  var shortId = String(attemptId || '').replace(/^att_/, '').slice(0, 8).toUpperCase();
  return 'RCPT-' + cleanCode + '-A' + (Number(attemptNumber) || 1) + '-' + shortId;
}

/**
 * Synchronizes a student's official aggregated score across all PUBLISHED attempts of an ExamSet
 * into the unified AssessmentScores table so native exam scores appear in My Profile & Course Scores.
 */
function syncPublishedExamScoreToAssessmentScoresInLockPhase6_(
  examSetRow,
  studentUserId,
  actorUserId
) {
  if (!examSetRow || !examSetRow.course_id) {
    return null;
  }
  var attTbl = readSheetTable_('ExamAttempts');
  var scoresTbl = readSheetTable_('AssessmentScores');
  var nowIso = nowUtcIso_();

  // Ensure ExamSet is linked to an Assessments record
  var linkedAssessmentId = examSetRow.assessment_id || '';
  if (!linkedAssessmentId) {
    var exvTbl = readSheetTable_('ExamVersions');
    var verHit = examSetRow.active_exam_version_id
      ? exvTbl.byId[examSetRow.active_exam_version_id]
      : null;
    linkedAssessmentId = syncExamSetToAssessmentsTablePhase3_(
      examSetRow,
      verHit ? verHit.record : null,
      actorUserId || 'SYSTEM'
    );
    if (linkedAssessmentId) {
      updateSheetRecordById_(
        'ExamSets',
        examSetRow.exam_set_id,
        { assessment_id: linkedAssessmentId, updated_at_utc: nowIso },
        Number(examSetRow.version),
        { skipLock: true }
      );
      examSetRow.assessment_id = linkedAssessmentId;
    }
  }
  if (!linkedAssessmentId) return null;

  // Collect all GRADED/REGRADED attempts for this student & exam whose publication_status is PUBLISHED
  var publishedAttempts = [];
  for (var i = 0; i < attTbl.records.length; i++) {
    var att = attTbl.records[i];
    if (
      att.exam_set_id === examSetRow.exam_set_id &&
      att.student_user_id === studentUserId &&
      (att.attempt_status === 'SUBMITTED' || att.attempt_status === 'EXPIRED_SUBMITTED') &&
      (att.grading_status === 'GRADED' || att.grading_status === 'REGRADED') &&
      att.publication_status === 'PUBLISHED'
    ) {
      publishedAttempts.push(att);
    }
  }

  publishedAttempts.sort(function (a, b) {
    return (Number(a.attempt_number) || 0) - (Number(b.attempt_number) || 0);
  });

  // Find existing AssessmentScores row for (course_id, assessment_id, student_user_id)
  var existingScoreHit = null;
  for (var s = 0; s < scoresTbl.records.length; s++) {
    var sRow = scoresTbl.records[s];
    if (
      sRow.course_id === examSetRow.course_id &&
      sRow.assessment_id === linkedAssessmentId &&
      sRow.student_user_id === studentUserId
    ) {
      existingScoreHit = scoresTbl.byId[sRow.score_id];
      break;
    }
  }

  if (publishedAttempts.length === 0) {
    // If all attempts were withheld/unpublished, set existing score row to DRAFT so it is hidden from student
    if (existingScoreHit && existingScoreHit.record.status === 'PUBLISHED') {
      return updateSheetRecordById_(
        'AssessmentScores',
        existingScoreHit.record.score_id,
        {
          status: 'DRAFT',
          updated_by_user_id: actorUserId || 'SYSTEM',
          updated_at_utc: nowIso
        },
        Number(existingScoreHit.record.version),
        { skipLock: true }
      );
    }
    return null;
  }

  var rule = examSetRow.aggregation_rule || 'BEST_PUBLISHED';
  var chosenAttempt = publishedAttempts[0];
  if (rule === 'LATEST_PUBLISHED') {
    chosenAttempt = publishedAttempts[publishedAttempts.length - 1];
  } else if (rule === 'BEST_PUBLISHED') {
    for (var k = 1; k < publishedAttempts.length; k++) {
      if (Number(publishedAttempts[k].total_score_bp) >= Number(chosenAttempt.total_score_bp)) {
        chosenAttempt = publishedAttempts[k];
      }
    }
  }

  var scorePoints = Math.round(Number(chosenAttempt.total_score_bp) || 0) / 100;
  var maxPoints = Math.max(0.25, Math.round(Number(chosenAttempt.max_score_bp) || 100) / 100);
  var feedbackNote =
    'Native Examination (' +
    examSetRow.exam_code +
    ', Attempt #' +
    chosenAttempt.attempt_number +
    ', Aggregation: ' +
    rule +
    ')';

  if (!existingScoreHit) {
    return insertSheetRecord_(
      'AssessmentScores',
      {
        score_id: generateEntityId_('scr_'),
        course_id: examSetRow.course_id,
        assessment_id: linkedAssessmentId,
        student_user_id: studentUserId,
        score_points: scorePoints,
        max_points: maxPoints,
        feedback_text: feedbackNote,
        status: 'PUBLISHED',
        published_at_utc: nowIso,
        updated_by_user_id: actorUserId || 'SYSTEM',
        created_at_utc: nowIso,
        updated_at_utc: nowIso
      },
      { skipLock: true }
    );
  } else {
    return updateSheetRecordById_(
      'AssessmentScores',
      existingScoreHit.record.score_id,
      {
        score_points: scorePoints,
        max_points: maxPoints,
        feedback_text: feedbackNote,
        status: 'PUBLISHED',
        published_at_utc: existingScoreHit.record.published_at_utc || nowIso,
        updated_by_user_id: actorUserId || 'SYSTEM',
        updated_at_utc: nowIso
      },
      Number(existingScoreHit.record.version),
      { skipLock: true }
    );
  }
}

/**
 * Evaluates all AttemptItems for a SUBMITTED or EXPIRED_SUBMITTED ExamAttempt inside LockService,
 * updates AttemptResponses, computes auto_score_bp + manual_score_bp, determines orthogonal
 * grading_status / publication_status / explanation_status, appends a ResultRevisions record,
 * and synchronizes published scores to AssessmentScores.
 */
function gradeSubmittedExamAttemptInLockPhase6_(
  attemptRow,
  opt_actorUserId,
  opt_revisionType,
  opt_reason
) {
  ensureExamPhase6SheetsExist_();
  var exsTbl = readSheetTable_('ExamSets');
  var exvTbl = readSheetTable_('ExamVersions');
  var atiTbl = readSheetTable_('AttemptItems');
  var atrTbl = readSheetTable_('AttemptResponses');
  var qvTbl = readSheetTable_('QuestionVersions');
  var rrvTbl = readSheetTable_('ResultRevisions');

  var exHit = exsTbl.byId[attemptRow.exam_set_id];
  var verHit = exvTbl.byId[attemptRow.exam_version_id];
  if (!exHit || !verHit) {
    return attemptRow;
  }
  var exRow = exHit.record;
  var verRow = verHit.record;

  var attemptItems = [];
  for (var i = 0; i < atiTbl.records.length; i++) {
    if (atiTbl.records[i].attempt_id === attemptRow.attempt_id) {
      attemptItems.push(atiTbl.records[i]);
    }
  }
  attemptItems.sort(function (a, b) {
    return (Number(a.display_number) || 0) - (Number(b.display_number) || 0);
  });

  var respByItemId = {};
  for (var r = 0; r < atrTbl.records.length; r++) {
    if (atrTbl.records[r].attempt_id === attemptRow.attempt_id) {
      respByItemId[atrTbl.records[r].attempt_item_id] = atrTbl.records[r];
    }
  }

  var nowIso = nowUtcIso_();
  var nowMs = Date.now();
  var autoScoreBp = 0;
  var manualScoreBp = 0;
  var maxScoreBp = 0;
  var answeredCount = 0;
  var pendingManualItemsCount = 0;
  var isRegrade = opt_revisionType === 'ADMIN_REGRADE';

  for (var k = 0; k < attemptItems.length; k++) {
    var ati = attemptItems[k];
    var itemMaxBp = Number(ati.points_bp) || 100;
    var itemNegBp = Number(ati.negative_points_bp) || 0;
    maxScoreBp += itemMaxBp;

    var qvHit = qvTbl.byId[ati.question_version_id];
    var qvRec = qvHit ? qvHit.record : null;
    var existingResp = respByItemId[ati.attempt_item_id] || null;

    var parsedPayload = {};
    if (existingResp && existingResp.response_payload_json) {
      try {
        parsedPayload = JSON.parse(existingResp.response_payload_json);
      } catch (e) {
        parsedPayload = {};
      }
    }

    // If instructor already manually graded this item, preserve the instructor's manual score
    if (
      existingResp &&
      existingResp.grading_source === 'MANUAL_INSTRUCTOR' &&
      existingResp.correctness_state !== 'MANUAL_REVIEW_PENDING'
    ) {
      if (existingResp.is_answered) answeredCount += 1;
      manualScoreBp += Number(existingResp.awarded_points_bp) || 0;
      continue;
    }

    var evalRes = evaluateSingleAttemptItemScorePhase5_(
      qvRec,
      parsedPayload,
      itemMaxBp,
      itemNegBp
    );
    if (evalRes.isAnswered) {
      answeredCount += 1;
    }

    var gSource = isRegrade && evalRes.gradingSource === 'AUTO_ENGINE'
      ? 'REGRADE_ENGINE'
      : evalRes.gradingSource;

    if (evalRes.requiresManualReview) {
      pendingManualItemsCount += 1;
    } else {
      autoScoreBp += evalRes.awardedPointsBp;
    }

    if (!existingResp) {
      var insertedResp = insertSheetRecord_(
        'AttemptResponses',
        {
          response_id: generateEntityId_('atr_'),
          attempt_id: attemptRow.attempt_id,
          attempt_item_id: ati.attempt_item_id,
          question_version_id: ati.question_version_id,
          student_user_id: attemptRow.student_user_id,
          response_payload_json: JSON.stringify(parsedPayload),
          is_answered: evalRes.isAnswered,
          client_revision_no: 0,
          server_revision_no: Number(attemptRow.latest_revision_no) || 1,
          saved_at_utc: nowIso,
          grading_source: gSource,
          awarded_points_bp: evalRes.awardedPointsBp,
          max_points_bp: itemMaxBp,
          correctness_state: evalRes.correctnessState,
          instructor_feedback: '',
          graded_by_user_id: opt_actorUserId || 'SYSTEM',
          graded_at_utc: evalRes.requiresManualReview ? '' : nowIso,
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
      respByItemId[ati.attempt_item_id] = insertedResp;
    } else {
      var updatedResp = updateSheetRecordById_(
        'AttemptResponses',
        existingResp.response_id,
        {
          is_answered: evalRes.isAnswered,
          grading_source: gSource,
          awarded_points_bp: evalRes.awardedPointsBp,
          max_points_bp: itemMaxBp,
          correctness_state: evalRes.correctnessState,
          graded_by_user_id: opt_actorUserId || 'SYSTEM',
          graded_at_utc: evalRes.requiresManualReview ? '' : nowIso,
          updated_at_utc: nowIso
        },
        Number(existingResp.version),
        { skipLock: true }
      );
      respByItemId[ati.attempt_item_id] = updatedResp;
    }
  }

  var totalScoreBp = Math.max(0, autoScoreBp + manualScoreBp);
  var percentageBp = maxScoreBp > 0 ? Math.round((totalScoreBp * 10000) / maxScoreBp) : 0;
  var passThresholdBp = (Number(exRow.pass_threshold_pct) || 60) * 100;
  var passedFlag = percentageBp >= passThresholdBp;

  var nextGradingStatus = 'GRADED';
  var nextPublicationStatus = attemptRow.publication_status || 'UNPUBLISHED';
  var nextExplanationStatus = attemptRow.explanation_status || 'WITHHELD';

  if (pendingManualItemsCount > 0) {
    nextGradingStatus = 'AUTO_GRADED_PENDING_MANUAL';
    nextPublicationStatus = 'UNPUBLISHED';
    nextExplanationStatus = 'WITHHELD';
  } else {
    nextGradingStatus = isRegrade ? 'REGRADED' : 'GRADED';
    // Preserve explicit PUBLISHED or WITHHELD if already set during regrade/manual completion,
    // otherwise evaluate ExamSets.score_release_policy
    if (
      nextPublicationStatus !== 'PUBLISHED' &&
      nextPublicationStatus !== 'WITHHELD'
    ) {
      var sPol = exRow.score_release_policy || 'MANUAL_ADMIN';
      if (sPol === 'IMMEDIATE_AUTO') {
        nextPublicationStatus = 'PUBLISHED';
      } else if (sPol === 'SCHEDULED') {
        var relMs = exRow.score_release_at_utc ? Date.parse(exRow.score_release_at_utc) : NaN;
        nextPublicationStatus = !isNaN(relMs) && nowMs >= relMs ? 'PUBLISHED' : 'SCHEDULED';
      } else if (sPol === 'AFTER_CLOSE') {
        var clsMs = exRow.close_at_utc ? Date.parse(exRow.close_at_utc) : NaN;
        nextPublicationStatus = !isNaN(clsMs) && nowMs >= clsMs ? 'PUBLISHED' : 'UNPUBLISHED';
      } else {
        nextPublicationStatus = 'UNPUBLISHED';
      }
    }

    if (nextExplanationStatus !== 'RELEASED') {
      var ePol = exRow.explanation_release_policy || 'WITH_SCORE';
      if (ePol === 'WITH_SCORE' && nextPublicationStatus === 'PUBLISHED') {
        nextExplanationStatus = 'RELEASED';
      } else if (ePol === 'SCHEDULED') {
        var eRelMs = exRow.explanation_release_at_utc ? Date.parse(exRow.explanation_release_at_utc) : NaN;
        nextExplanationStatus = !isNaN(eRelMs) && nowMs >= eRelMs ? 'RELEASED' : 'WITHHELD';
      } else if (ePol === 'AFTER_CLOSE') {
        var eClsMs = exRow.close_at_utc ? Date.parse(exRow.close_at_utc) : NaN;
        nextExplanationStatus = !isNaN(eClsMs) && nowMs >= eClsMs ? 'RELEASED' : 'WITHHELD';
      } else {
        nextExplanationStatus = 'WITHHELD';
      }
    }
  }

  var existingRevsForAttempt = 0;
  for (var rv = 0; rv < rrvTbl.records.length; rv++) {
    if (rrvTbl.records[rv].attempt_id === attemptRow.attempt_id) {
      var rn = Number(rrvTbl.records[rv].revision_no) || 0;
      if (rn > existingRevsForAttempt) existingRevsForAttempt = rn;
    }
  }
  var nextRevNo = existingRevsForAttempt + 1;
  var revId = generateEntityId_('rrv_');

  insertSheetRecord_(
    'ResultRevisions',
    {
      result_revision_id: revId,
      attempt_id: attemptRow.attempt_id,
      exam_set_id: attemptRow.exam_set_id,
      exam_version_id: attemptRow.exam_version_id,
      student_user_id: attemptRow.student_user_id,
      revision_no: nextRevNo,
      revision_type: opt_revisionType || 'INITIAL_AUTO_GRADE',
      auto_score_bp: autoScoreBp,
      manual_score_bp: manualScoreBp,
      total_score_bp: totalScoreBp,
      max_score_bp: maxScoreBp,
      percentage_bp: percentageBp,
      passed_flag: passedFlag,
      grading_status: nextGradingStatus,
      publication_status: nextPublicationStatus,
      explanation_status: nextExplanationStatus,
      reason: sanitizeSingleLineTextStep7_(opt_reason || 'Automated examination grading pass', 400),
      actor_user_id: opt_actorUserId || 'SYSTEM',
      created_at_utc: nowIso
    },
    { skipLock: true }
  );

  var freshAttemptHit = readSheetTable_('ExamAttempts').byId[attemptRow.attempt_id];
  var verToUpdate = freshAttemptHit ? Number(freshAttemptHit.record.version) : Number(attemptRow.version);

  var updatedAttempt = updateSheetRecordById_(
    'ExamAttempts',
    attemptRow.attempt_id,
    {
      grading_status: nextGradingStatus,
      publication_status: nextPublicationStatus,
      explanation_status: nextExplanationStatus,
      answered_count: answeredCount,
      auto_score_bp: autoScoreBp,
      manual_score_bp: manualScoreBp,
      total_score_bp: totalScoreBp,
      max_score_bp: maxScoreBp,
      percentage_bp: percentageBp,
      passed_flag: passedFlag,
      current_result_revision_id: revId,
      updated_at_utc: nowIso
    },
    verToUpdate,
    { skipLock: true }
  );

  if (nextPublicationStatus === 'PUBLISHED') {
    syncPublishedExamScoreToAssessmentScoresInLockPhase6_(
      exRow,
      attemptRow.student_user_id,
      opt_actorUserId || 'SYSTEM'
    );
  }

  return updatedAttempt;
}

/**
 * Recovers any interrupted PENDING entries in ExamOperationJournal inside LockService.
 */
function recoverPendingExamJournalsInLockPhase6_() {
  ensureExamPhase6SheetsExist_();
  var jrnTbl = readSheetTable_('ExamOperationJournal');
  var attTbl = readSheetTable_('ExamAttempts');
  var recoveredIds = [];
  var nowIso = nowUtcIso_();

  for (var i = 0; i < jrnTbl.records.length; i++) {
    var jrn = jrnTbl.records[i];
    if (jrn.journal_status !== 'PENDING') continue;
    var attHit = attTbl.byId[jrn.attempt_id];
    if (!attHit) {
      updateSheetRecordById_(
        'ExamOperationJournal',
        jrn.journal_id,
        { journal_status: 'HALTED_INCONSISTENT', committed_at_utc: nowIso },
        undefined,
        { skipLock: true }
      );
      continue;
    }
    var att = attHit.record;
    if (jrn.operation_type === 'SUBMIT_ATTEMPT' || jrn.operation_type === 'EXPIRE_FINALIZE') {
      if (att.attempt_status === 'IN_PROGRESS' || att.attempt_status === 'SUBMITTING') {
        att = updateSheetRecordById_(
          'ExamAttempts',
          att.attempt_id,
          {
            attempt_status: jrn.target_status || 'SUBMITTED',
            submitted_at_utc: att.submitted_at_utc || nowIso,
            active_lease_token: '',
            updated_at_utc: nowIso
          },
          Number(att.version),
          { skipLock: true }
        );
      }
      if (att.grading_status === 'NOT_GRADED' || att.grading_status === 'GRADING_IN_PROGRESS') {
        att = gradeSubmittedExamAttemptInLockPhase6_(
          att,
          'SYSTEM',
          'INITIAL_AUTO_GRADE',
          'Recovered interrupted submission grading via ExamOperationJournal'
        );
      }
    } else if (jrn.operation_type === 'INTEGRITY_COPY_EVENT') {
      recoverPendingIntegrityCopyEventJournalInLockPhaseB_(jrn, att, nowIso);
    }
    updateSheetRecordById_(
      'ExamOperationJournal',
      jrn.journal_id,
      { journal_status: 'COMMITTED', committed_at_utc: nowIso },
      undefined,
      { skipLock: true }
    );
    recoveredIds.push(jrn.journal_id);
  }

  return {
    recoveredCount: recoveredIds.length,
    recoveredJournalIds: recoveredIds
  };
}

/**
 * Builds the student-safe Submission Receipt DTO for a submitted or expired attempt.
 * Enforces strict read-time filtering so unreleased scores are NEVER included.
 */
function buildStudentSubmissionReceiptBundlePhase6_(attemptRow, examSetRow) {
  var nowMs = Date.now();
  var pubStatus = attemptRow.publication_status || 'UNPUBLISHED';
  var expStatus = attemptRow.explanation_status || 'WITHHELD';
  var gradStatus = attemptRow.grading_status || 'NOT_GRADED';

  // Read-time scheduled check
  if (
    (gradStatus === 'GRADED' || gradStatus === 'REGRADED') &&
    pubStatus !== 'WITHHELD'
  ) {
    if (
      pubStatus === 'SCHEDULED' &&
      examSetRow.score_release_at_utc &&
      nowMs >= Date.parse(examSetRow.score_release_at_utc)
    ) {
      pubStatus = 'PUBLISHED';
    } else if (
      examSetRow.score_release_policy === 'AFTER_CLOSE' &&
      examSetRow.close_at_utc &&
      nowMs >= Date.parse(examSetRow.close_at_utc)
    ) {
      pubStatus = 'PUBLISHED';
    }
  }
  if (
    expStatus !== 'RELEASED' &&
    examSetRow.explanation_release_policy === 'WITH_SCORE' &&
    pubStatus === 'PUBLISHED'
  ) {
    expStatus = 'RELEASED';
  }

  var atiTbl = readSheetTable_('AttemptItems');
  var totalQ = 0;
  for (var i = 0; i < atiTbl.records.length; i++) {
    if (atiTbl.records[i].attempt_id === attemptRow.attempt_id) {
      totalQ += 1;
    }
  }
  var ansCount = Number(attemptRow.answered_count) || 0;
  var flagCount = Number(attemptRow.flagged_count) || 0;

  var releaseNotice = '';
  if (gradStatus === 'AUTO_GRADED_PENDING_MANUAL') {
    releaseNotice =
      'Your objective answers have been auto-graded on the server, and your written/short-answer responses are queued for instructor rubric grading. Your official score will appear once manual grading and score publication are complete.';
  } else if (pubStatus === 'PUBLISHED') {
    releaseNotice =
      'Your official examination score has been published and is shown below.';
  } else if (pubStatus === 'SCHEDULED' && examSetRow.score_release_at_utc) {
    releaseNotice =
      'Your attempt has been graded and recorded. Official scores are scheduled for release at ' +
      formatBangkokTimestamp_(examSetRow.score_release_at_utc) +
      ' (Asia/Bangkok).';
  } else if (examSetRow.score_release_policy === 'AFTER_CLOSE' && examSetRow.close_at_utc) {
    releaseNotice =
      'Your attempt has been graded and recorded. Scores will be released after the examination closing deadline (' +
      formatBangkokTimestamp_(examSetRow.close_at_utc) +
      ').';
  } else {
    releaseNotice =
      'Your attempt has been recorded on the server. Official scores will appear in your course catalog and My Profile once published by your instructor.';
  }

  var publishedScoreResult = null;
  if (pubStatus === 'PUBLISHED' && (gradStatus === 'GRADED' || gradStatus === 'REGRADED')) {
    var totBp = Number(attemptRow.total_score_bp) || 0;
    var maxBp = Number(attemptRow.max_score_bp) || 100;
    var pctVal = Math.round((Number(attemptRow.percentage_bp) || 0) / 10) / 10;
    publishedScoreResult = {
      autoScoreBp: Number(attemptRow.auto_score_bp) || 0,
      autoScoreDisplay: formatPointsBpDisplayPhase2_(attemptRow.auto_score_bp || 0),
      manualScoreBp: Number(attemptRow.manual_score_bp) || 0,
      manualScoreDisplay: formatPointsBpDisplayPhase2_(attemptRow.manual_score_bp || 0),
      totalScoreBp: totBp,
      maxScoreBp: maxBp,
      scoreDisplay: formatPointsBpDisplayPhase2_(totBp) + ' / ' + formatPointsBpDisplayPhase2_(maxBp),
      percentageFormatted: pctVal.toFixed(1) + '%',
      percentageValue: pctVal,
      passedFlag: Boolean(attemptRow.passed_flag),
      explanationsReleased: expStatus === 'RELEASED',
      resultRevisionId: attemptRow.current_result_revision_id || ''
    };
  }

  return {
    receiptCode: buildSubmissionReceiptCodePhase6_(
      examSetRow.exam_code,
      attemptRow.attempt_number,
      attemptRow.attempt_id
    ),
    attemptId: attemptRow.attempt_id,
    examSetId: examSetRow.exam_set_id,
    examCode: examSetRow.exam_code,
    examTitle: examSetRow.title,
    examMode: examSetRow.exam_mode,
    examModeLabel: formatExamModeBadgeLabelPhase3_(examSetRow.exam_mode),
    courseId: attemptRow.course_id || examSetRow.course_id || '',
    attemptNumber: Number(attemptRow.attempt_number) || 1,
    attemptStatus: attemptRow.attempt_status,
    gradingStatus: gradStatus,
    publicationStatus: pubStatus,
    explanationStatus: expStatus,
    startedAtUtc: attemptRow.started_at_utc,
    startedAtBangkok: formatBangkokTimestamp_(attemptRow.started_at_utc),
    submittedAtUtc: attemptRow.submitted_at_utc,
    submittedAtBangkok: formatBangkokTimestamp_(attemptRow.submitted_at_utc),
    timeUsedSeconds: Number(attemptRow.time_used_seconds) || 0,
    timeUsedFormatted: formatDurationSecondsHumanPhase6_(attemptRow.time_used_seconds),
    totalQuestionsCount: totalQ,
    answeredCount: ansCount,
    unansweredCount: Math.max(0, totalQ - ansCount),
    flaggedCount: flagCount,
    releasePolicyExplanation: releaseNotice,
    publishedScoreResult: publishedScoreResult
  };
}

/**
 * Idempotently submits an active examination attempt ('exams.submitAttempt'),
 * flushing any bundled final responses (if within grace_deadline_utc), logging via
 * ExamOperationJournal, running backend auto-grading, and returning the Submission Receipt.
 */
function handleStudentSubmitExamAttemptPhase6_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to submit an examination attempt.'
    );
  }
  ensureExamPhase6SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  if (!attemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'attemptId is required to submit an examination.'
    );
  }

  var idempotencyKey =
    sanitizeSingleLineTextStep7_(req.idempotencyKey, 80) ||
    'submit_' + attemptId;

  // If finalResponses are bundled and attempt is still editable & within grace window, flush them first
  if (Array.isArray(req.finalResponses) && req.finalResponses.length > 0) {
    try {
      handleStudentSaveExamResponsesPhase4_(
        {
          attemptId: attemptId,
          leaseToken: req.leaseToken || '',
          forceTakeoverLease: true,
          clientRevisionNo: Number(req.clientRevisionNo) || 999999,
          responses: req.finalResponses
        },
        context
      );
    } catch (lateFlushErr) {
      var errCode = lateFlushErr && (lateFlushErr.pbCode || lateFlushErr.code);
      if (
        errCode === PB_ERROR_CODES_.ERR_EXAM_COPY_SUSPENDED ||
        errCode === PB_ERROR_CODES_.ERR_EXAM_ATTEMPT_INVALIDATED
      ) {
        throw lateFlushErr;
      }
      // If deadline already expired or already submitted, proceed to idempotent finalization
    }
  }

  var receiptBundle = null;
  var isIdempotentReplay = false;

  withScriptLock_(function () {
    recoverPendingExamJournalsInLockPhase6_();

    var attTbl = readSheetTable_('ExamAttempts');
    var exsTbl = readSheetTable_('ExamSets');

    var attHit = attTbl.byId[attemptId];
    if (!attHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination attempt "' + attemptId + '" was not found.'
      );
    }
    var att = attHit.record;

    if (usr.role !== 'ADMIN' && att.student_user_id !== usr.user_id) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: You cannot submit another student\'s examination attempt.'
      );
    }

    var exHit = exsTbl.byId[att.exam_set_id];
    if (!exHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination set was not found.'
      );
    }
    var exRow = exHit.record;

    // Idempotent replay: if already SUBMITTED or EXPIRED_SUBMITTED, return receipt without re-mutating
    if (att.attempt_status === 'SUBMITTED' || att.attempt_status === 'EXPIRED_SUBMITTED') {
      isIdempotentReplay = true;
      if (att.grading_status === 'NOT_GRADED') {
        att = gradeSubmittedExamAttemptInLockPhase6_(
          att,
          usr.user_id,
          'INITIAL_AUTO_GRADE',
          'Auto-graded on idempotent submit check'
        );
      }
      receiptBundle = buildStudentSubmissionReceiptBundlePhase6_(att, exRow);
      return;
    }

    if (
      att.attempt_status === 'INVALIDATED' ||
      att.attempt_status === 'INVALIDATED_COPY_POLICY'
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_EXAM_ATTEMPT_INVALIDATED,
        att.attempt_status === 'INVALIDATED_COPY_POLICY'
          ? 'Examination attempt invalidated: This attempt was invalidated after exceeding the permitted number of detected copy attempts. Your saved answers have been retained for administrator review.'
          : 'This attempt was invalidated by an administrator and cannot be submitted.',
        {
          attemptId: att.attempt_id,
          attemptStatus: att.attempt_status,
          invalidationReasonCode: att.invalidation_reason_code || 'ADMIN_MANUAL_INVALIDATION'
        }
      );
    }

    var nowMs = Date.now();
    var nowIso = new Date(nowMs).toISOString();
    var graceStr = att.grace_deadline_utc || att.effective_deadline_utc || '';
    var graceMs = graceStr ? Date.parse(graceStr) : NaN;
    var isPastGrace = !isNaN(graceMs) && nowMs > graceMs;
    if (!isPastGrace) {
      // Expiry finalization takes precedence if deadline expired during suspension;
      // otherwise block manual submission while the 5-second suspension is active!
      assertAttemptNotSuspendedByCopyPolicyPhaseB_(att, nowMs);
    }
    var finalAttemptStatus = isPastGrace ? 'EXPIRED_SUBMITTED' : 'SUBMITTED';

    var startedMs = Date.parse(att.started_at_utc) || nowMs;
    var effDeadMs = att.effective_deadline_utc ? Date.parse(att.effective_deadline_utc) : nowMs;
    var endMs = isPastGrace && !isNaN(effDeadMs) ? Math.min(nowMs, effDeadMs) : nowMs;
    var elapsedSec = Math.max(0, Math.round((endMs - startedMs) / 1000));

    var jrnId = generateEntityId_('exj_');
    insertSheetRecord_(
      'ExamOperationJournal',
      {
        journal_id: jrnId,
        operation_type: isPastGrace ? 'EXPIRE_FINALIZE' : 'SUBMIT_ATTEMPT',
        idempotency_key: idempotencyKey,
        attempt_id: attemptId,
        exam_set_id: att.exam_set_id,
        student_user_id: att.student_user_id,
        target_status: finalAttemptStatus,
        payload_json: JSON.stringify({
          submittedAtUtc: nowIso,
          timeUsedSeconds: elapsedSec
        }),
        journal_status: 'PENDING',
        created_at_utc: nowIso,
        committed_at_utc: ''
      },
      { skipLock: true }
    );

    att = updateSheetRecordById_(
      'ExamAttempts',
      attemptId,
      {
        attempt_status: finalAttemptStatus,
        grading_status: 'GRADING_IN_PROGRESS',
        submitted_at_utc: isPastGrace && att.effective_deadline_utc ? att.effective_deadline_utc : nowIso,
        last_saved_at_utc: nowIso,
        time_used_seconds: elapsedSec,
        active_lease_token: '',
        updated_at_utc: nowIso
      },
      Number(att.version),
      { skipLock: true }
    );

    att = gradeSubmittedExamAttemptInLockPhase6_(
      att,
      usr.user_id,
      'INITIAL_AUTO_GRADE',
      isPastGrace
        ? 'Attempt deadline expired; auto-finalized and auto-graded on server.'
        : 'Student confirmed final examination submission.'
    );

    updateSheetRecordById_(
      'ExamOperationJournal',
      jrnId,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: nowIso
      },
      undefined,
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: usr.user_id,
      actorRole: usr.role,
      eventType: isPastGrace ? 'STUDENT_EXAM_ATTEMPT_EXPIRED_SUBMITTED' : 'STUDENT_EXAM_ATTEMPT_SUBMITTED',
      targetEntityType: 'ExamAttempt',
      targetEntityId: attemptId,
      summary: {
        examSetId: att.exam_set_id,
        examCode: exRow.exam_code,
        attemptNumber: att.attempt_number,
        attemptStatus: att.attempt_status,
        gradingStatus: att.grading_status,
        publicationStatus: att.publication_status
      }
    });

    receiptBundle = buildStudentSubmissionReceiptBundlePhase6_(att, exRow);
  });

  return {
    submitted: true,
    idempotentReplay: isIdempotentReplay,
    receipt: receiptBundle,
    serverNowUtc: nowUtcIso_()
  };
}

/**
 * Queries the authoritative submission status & receipt of an attempt ('exams.getSubmissionStatus').
 */
function handleStudentGetSubmissionStatusPhase6_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required.'
    );
  }
  ensureExamPhase6SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  if (!attemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'attemptId is required.'
    );
  }

  var result = null;
  withScriptLock_(function () {
    recoverPendingExamJournalsInLockPhase6_();
    var attTbl = readSheetTable_('ExamAttempts');
    var exsTbl = readSheetTable_('ExamSets');

    var attHit = attTbl.byId[attemptId];
    if (!attHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination attempt "' + attemptId + '" was not found.'
      );
    }
    var att = attHit.record;
    if (usr.role !== 'ADMIN' && att.student_user_id !== usr.user_id) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: Attempt belongs to another student.'
      );
    }

    if (att.attempt_status === 'IN_PROGRESS') {
      var expCheck = checkAndFinalizeExpiredAttemptInLockPhase4_(att, Date.now());
      att = expCheck.attemptRow;
    }

    var exHit = exsTbl.byId[att.exam_set_id];
    var exRow = exHit ? exHit.record : null;

    result = {
      attemptId: att.attempt_id,
      attemptStatus: att.attempt_status,
      gradingStatus: att.grading_status,
      publicationStatus: att.publication_status,
      explanationStatus: att.explanation_status,
      isSubmitted: att.attempt_status === 'SUBMITTED' || att.attempt_status === 'EXPIRED_SUBMITTED',
      receipt:
        exRow && (att.attempt_status === 'SUBMITTED' || att.attempt_status === 'EXPIRED_SUBMITTED')
          ? buildStudentSubmissionReceiptBundlePhase6_(att, exRow)
          : null
    };
  });

  return result;
}

/**
 * Lists student examination attempts for Administrator Monitoring & Manual Grading ('admin.attempts.list').
 */
function handleAdminListAttemptsPhase6_(payload, context) {
  assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase6SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var filterExamSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  var filterAttemptStatus = String(req.attemptStatus || 'ALL').trim().toUpperCase();
  var filterGradingStatus = String(req.gradingStatus || 'ALL').trim().toUpperCase();

  var attTbl = readSheetTable_('ExamAttempts');
  var exsTbl = readSheetTable_('ExamSets');
  var usersTbl = readSheetTable_('Users');
  var coursesTbl = readSheetTable_('Courses');

  var counts = {
    totalAttempts: 0,
    inProgressCount: 0,
    submittedCount: 0,
    pendingManualGradingCount: 0,
    gradedCount: 0,
    publishedCount: 0
  };
  var items = [];

  for (var i = attTbl.records.length - 1; i >= 0; i--) {
    var att = attTbl.records[i];
    counts.totalAttempts += 1;
    if (att.attempt_status === 'IN_PROGRESS') counts.inProgressCount += 1;
    if (att.attempt_status === 'SUBMITTED' || att.attempt_status === 'EXPIRED_SUBMITTED') counts.submittedCount += 1;
    if (att.grading_status === 'AUTO_GRADED_PENDING_MANUAL') counts.pendingManualGradingCount += 1;
    if (att.grading_status === 'GRADED' || att.grading_status === 'REGRADED') counts.gradedCount += 1;
    if (att.publication_status === 'PUBLISHED') counts.publishedCount += 1;

    if (filterExamSetId && filterExamSetId !== 'ALL' && att.exam_set_id !== filterExamSetId) continue;
    if (filterAttemptStatus !== 'ALL' && att.attempt_status !== filterAttemptStatus) continue;
    if (filterGradingStatus !== 'ALL' && att.grading_status !== filterGradingStatus) continue;

    var exHit = exsTbl.byId[att.exam_set_id];
    var exRec = exHit ? exHit.record : null;
    var uHit = usersTbl.byId[att.student_user_id];
    var uRec = uHit ? uHit.record : null;
    var cHit = att.course_id ? coursesTbl.byId[att.course_id] : null;
    var cRec = cHit ? cHit.record : null;

    var totBp = Number(att.total_score_bp) || 0;
    var maxBp = Number(att.max_score_bp) || 100;
    var pctVal = Math.round((Number(att.percentage_bp) || 0) / 10) / 10;

    items.push({
      attemptId: att.attempt_id,
      examSetId: att.exam_set_id,
      examCode: exRec ? exRec.exam_code : '',
      examTitle: exRec ? exRec.title : '',
      examMode: exRec ? exRec.exam_mode : '',
      courseId: att.course_id || '',
      courseCode: cRec ? cRec.course_code : '',
      studentUserId: att.student_user_id,
      studentUsername: uRec ? uRec.username_display || uRec.username_lower : '',
      studentFullName: uRec ? uRec.full_name : '',
      attemptNumber: Number(att.attempt_number) || 1,
      attemptStatus: att.attempt_status,
      gradingStatus: att.grading_status,
      publicationStatus: att.publication_status,
      explanationStatus: att.explanation_status,
      startedAtBangkok: formatBangkokTimestamp_(att.started_at_utc),
      submittedAtBangkok: att.submitted_at_utc ? formatBangkokTimestamp_(att.submitted_at_utc) : '-',
      lastSavedAtBangkok: att.last_saved_at_utc ? formatBangkokTimestamp_(att.last_saved_at_utc) : '-',
      timeUsedFormatted: formatDurationSecondsHumanPhase6_(att.time_used_seconds),
      answeredCount: Number(att.answered_count) || 0,
      flaggedCount: Number(att.flagged_count) || 0,
      autoScoreBp: Number(att.auto_score_bp) || 0,
      autoScoreDisplay: formatPointsBpDisplayPhase2_(att.auto_score_bp || 0),
      manualScoreBp: Number(att.manual_score_bp) || 0,
      manualScoreDisplay: formatPointsBpDisplayPhase2_(att.manual_score_bp || 0),
      totalScoreBp: totBp,
      maxScoreBp: maxBp,
      scoreDisplay: formatPointsBpDisplayPhase2_(totBp) + ' / ' + formatPointsBpDisplayPhase2_(maxBp),
      percentageFormatted: pctVal.toFixed(1) + '%',
      passedFlag: Boolean(att.passed_flag),
      version: Number(att.version) || 1
    });
  }

  return {
    attempts: items,
    summary: counts
  };
}

/**
 * Inspects a single student attempt with full item-by-item responses, rubrics, and grading breakdown
 * for Administrator Review & Manual Rubric Grading ('admin.attempts.inspect').
 */
function handleAdminInspectAttemptPhase6_(payload, context) {
  assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase6SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  if (!attemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'attemptId is required.'
    );
  }

  var attTbl = readSheetTable_('ExamAttempts');
  var exsTbl = readSheetTable_('ExamSets');
  var atiTbl = readSheetTable_('AttemptItems');
  var atrTbl = readSheetTable_('AttemptResponses');
  var qbTbl = readSheetTable_('QuestionBank');
  var qvTbl = readSheetTable_('QuestionVersions');
  var qoTbl = readSheetTable_('QuestionOptions');
  var usersTbl = readSheetTable_('Users');
  var rrvTbl = readSheetTable_('ResultRevisions');

  var attHit = attTbl.byId[attemptId];
  if (!attHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Examination attempt "' + attemptId + '" was not found.'
    );
  }
  var att = attHit.record;
  var exHit = exsTbl.byId[att.exam_set_id];
  var exRow = exHit ? exHit.record : null;
  var uHit = usersTbl.byId[att.student_user_id];
  var uRec = uHit ? uHit.record : null;

  var optionsByQvId = {};
  for (var oi = 0; oi < qoTbl.records.length; oi++) {
    var op = qoTbl.records[oi];
    if (!optionsByQvId[op.question_version_id]) {
      optionsByQvId[op.question_version_id] = [];
    }
    optionsByQvId[op.question_version_id].push(op);
  }

  var respByItemId = {};
  for (var r = 0; r < atrTbl.records.length; r++) {
    if (atrTbl.records[r].attempt_id === attemptId) {
      respByItemId[atrTbl.records[r].attempt_item_id] = atrTbl.records[r];
    }
  }

  var attItems = [];
  for (var i = 0; i < atiTbl.records.length; i++) {
    if (atiTbl.records[i].attempt_id === attemptId) {
      attItems.push(atiTbl.records[i]);
    }
  }
  attItems.sort(function (a, b) {
    return (Number(a.display_number) || 0) - (Number(b.display_number) || 0);
  });

  var detailedItems = [];
  for (var k = 0; k < attItems.length; k++) {
    var ati = attItems[k];
    var qbHit = qbTbl.byId[ati.question_id];
    var qvHit = qvTbl.byId[ati.question_version_id];
    var qbRec = qbHit ? qbHit.record : null;
    var qvRec = qvHit ? qvHit.record : null;
    var respRow = respByItemId[ati.attempt_item_id] || null;

    var parsedResp = {};
    if (respRow && respRow.response_payload_json) {
      try {
        parsedResp = JSON.parse(respRow.response_payload_json);
      } catch (e) {
        parsedResp = {};
      }
    }

    var qAdminDto = qbRec && qvRec
      ? projectQuestionVersionDtoPhase2_(
          qbRec,
          qvRec,
          optionsByQvId[ati.question_version_id] || [],
          null,
          true
        )
      : null;

    detailedItems.push({
      attemptItemId: ati.attempt_item_id,
      displayNumber: Number(ati.display_number) || k + 1,
      questionId: ati.question_id,
      questionVersionId: ati.question_version_id,
      questionCode: qbRec ? qbRec.question_code : '',
      questionType: qvRec ? qvRec.question_type : '',
      gradingMode: qvRec ? qvRec.grading_mode : 'AUTO',
      maxPointsBp: Number(ati.points_bp) || 100,
      maxPoints: (Number(ati.points_bp) || 100) / 100,
      maxPointsDisplay: formatPointsBpDisplayPhase2_(ati.points_bp || 100),
      questionAdminView: qAdminDto,
      responseId: respRow ? respRow.response_id : '',
      responseVersion: respRow ? Number(respRow.version) || 1 : 1,
      isAnswered: Boolean(respRow && respRow.is_answered),
      responsePayload: parsedResp,
      gradingSource: respRow ? respRow.grading_source : 'UNGRADED',
      correctnessState: respRow ? respRow.correctness_state : 'UNGRADED',
      awardedPointsBp: respRow ? Number(respRow.awarded_points_bp) || 0 : 0,
      awardedPoints: respRow ? (Number(respRow.awarded_points_bp) || 0) / 100 : 0,
      awardedPointsDisplay: formatPointsBpDisplayPhase2_(respRow ? respRow.awarded_points_bp : 0),
      instructorFeedback: respRow ? respRow.instructor_feedback || '' : ''
    });
  }

  var revisions = [];
  for (var rv = 0; rv < rrvTbl.records.length; rv++) {
    var rev = rrvTbl.records[rv];
    if (rev.attempt_id === attemptId) {
      revisions.push({
        resultRevisionId: rev.result_revision_id,
        revisionNo: Number(rev.revision_no) || 1,
        revisionType: rev.revision_type,
        totalScoreDisplay: formatPointsBpDisplayPhase2_(rev.total_score_bp) + ' / ' + formatPointsBpDisplayPhase2_(rev.max_score_bp),
        gradingStatus: rev.grading_status,
        publicationStatus: rev.publication_status,
        explanationStatus: rev.explanation_status,
        reason: rev.reason,
        createdAtBangkok: formatBangkokTimestamp_(rev.created_at_utc)
      });
    }
  }

  return {
    attempt: {
      attemptId: att.attempt_id,
      examSetId: att.exam_set_id,
      examCode: exRow ? exRow.exam_code : '',
      examTitle: exRow ? exRow.title : '',
      studentUserId: att.student_user_id,
      studentUsername: uRec ? uRec.username_display || uRec.username_lower : '',
      studentFullName: uRec ? uRec.full_name : '',
      attemptNumber: Number(att.attempt_number) || 1,
      attemptStatus: att.attempt_status,
      gradingStatus: att.grading_status,
      publicationStatus: att.publication_status,
      explanationStatus: att.explanation_status,
      autoScoreDisplay: formatPointsBpDisplayPhase2_(att.auto_score_bp),
      manualScoreDisplay: formatPointsBpDisplayPhase2_(att.manual_score_bp),
      totalScoreDisplay: formatPointsBpDisplayPhase2_(att.total_score_bp) + ' / ' + formatPointsBpDisplayPhase2_(att.max_score_bp),
      version: Number(att.version) || 1
    },
    items: detailedItems,
    revisions: revisions
  };
}

/**
 * Saves instructor manual rubric scores & feedback for one or more items in an attempt
 * ('admin.grading.save'), recalculates total attempt score on the server, and transitions
 * grading_status to GRADED when all manual items have been reviewed.
 */
function handleAdminSaveManualGradingPhase6_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase6SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  if (!attemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'attemptId is required.'
    );
  }

  var itemGrades = Array.isArray(req.itemGrades) ? req.itemGrades : [];
  if (itemGrades.length === 0 && req.attemptItemId) {
    itemGrades.push({
      attemptItemId: req.attemptItemId,
      awardedPoints: req.awardedPoints,
      awardedPointsBp: req.awardedPointsBp,
      instructorFeedback: req.instructorFeedback,
      expectedResponseVersion: req.expectedResponseVersion
    });
  }
  if (itemGrades.length === 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'At least one itemGrade entry is required.'
    );
  }

  var publishNow = Boolean(req.publishNow);
  var releaseExplanationsNow = Boolean(req.releaseExplanationsNow);

  withScriptLock_(function () {
    var attTbl = readSheetTable_('ExamAttempts');
    var atiTbl = readSheetTable_('AttemptItems');
    var atrTbl = readSheetTable_('AttemptResponses');
    var exsTbl = readSheetTable_('ExamSets');

    var attHit = attTbl.byId[attemptId];
    if (!attHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination attempt "' + attemptId + '" was not found.'
      );
    }
    var att = attHit.record;

    if (req.expectedAttemptVersion !== undefined && req.expectedAttemptVersion !== null && req.expectedAttemptVersion !== '') {
      if (Number(req.expectedAttemptVersion) !== Number(att.version)) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Attempt version conflict: another administrator modified this attempt. Refresh before saving manual grades.'
        );
      }
    }

    var atiById = {};
    for (var i = 0; i < atiTbl.records.length; i++) {
      if (atiTbl.records[i].attempt_id === attemptId) {
        atiById[atiTbl.records[i].attempt_item_id] = atiTbl.records[i];
      }
    }

    var respByItemId = {};
    for (var r = 0; r < atrTbl.records.length; r++) {
      if (atrTbl.records[r].attempt_id === attemptId) {
        respByItemId[atrTbl.records[r].attempt_item_id] = atrTbl.records[r];
      }
    }

    var nowIso = nowUtcIso_();
    var fieldErrors = {};

    for (var g = 0; g < itemGrades.length; g++) {
      var ig = itemGrades[g] || {};
      var atiId = sanitizeSingleLineTextStep7_(ig.attemptItemId, 64);
      var atiRec = atiById[atiId];
      if (!atiRec) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
          'Attempt item "' + atiId + '" does not belong to attempt "' + attemptId + '".'
        );
      }

      var maxBp = Number(atiRec.points_bp) || 100;
      var awardedBp = 0;
      if (ig.awardedPointsBp !== undefined && ig.awardedPointsBp !== null && ig.awardedPointsBp !== '') {
        awardedBp = parseInt(ig.awardedPointsBp, 10);
      } else {
        awardedBp = parsePointsToBpPhase2_(
          ig.awardedPoints,
          'awardedPoints_' + atiId,
          'Awarded points',
          true,
          fieldErrors
        );
      }
      if (!isFinite(awardedBp) || awardedBp < 0 || awardedBp > maxBp) {
        fieldErrors['awardedPoints_' + atiId] =
          'Awarded points for question #' +
          atiRec.display_number +
          ' must be between 0 and ' +
          formatPointsBpDisplayPhase2_(maxBp) +
          '.';
        continue;
      }

      var feedback = sanitizeSingleLineTextStep7_(ig.instructorFeedback, 1000);
      var corrState =
        awardedBp >= maxBp
          ? 'CORRECT'
          : awardedBp > 0
          ? 'PARTIAL'
          : 'INCORRECT';

      var existingResp = respByItemId[atiId];
      if (!existingResp) {
        var createdR = insertSheetRecord_(
          'AttemptResponses',
          {
            response_id: generateEntityId_('atr_'),
            attempt_id: attemptId,
            attempt_item_id: atiId,
            question_version_id: atiRec.question_version_id,
            student_user_id: att.student_user_id,
            response_payload_json: '{}',
            is_answered: false,
            client_revision_no: 0,
            server_revision_no: Number(att.latest_revision_no) || 1,
            saved_at_utc: nowIso,
            grading_source: 'MANUAL_INSTRUCTOR',
            awarded_points_bp: awardedBp,
            max_points_bp: maxBp,
            correctness_state: corrState,
            instructor_feedback: feedback,
            graded_by_user_id: adminUser.user_id,
            graded_at_utc: nowIso,
            created_at_utc: nowIso,
            updated_at_utc: nowIso
          },
          { skipLock: true }
        );
        respByItemId[atiId] = createdR;
      } else {
        var expVer =
          ig.expectedResponseVersion !== undefined && ig.expectedResponseVersion !== null && ig.expectedResponseVersion !== ''
            ? Number(ig.expectedResponseVersion)
            : Number(existingResp.version);
        var updatedR = updateSheetRecordById_(
          'AttemptResponses',
          existingResp.response_id,
          {
            grading_source: 'MANUAL_INSTRUCTOR',
            awarded_points_bp: awardedBp,
            max_points_bp: maxBp,
            correctness_state: corrState,
            instructor_feedback: feedback,
            graded_by_user_id: adminUser.user_id,
            graded_at_utc: nowIso,
            updated_at_utc: nowIso
          },
          expVer,
          { skipLock: true }
        );
        respByItemId[atiId] = updatedR;
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Please fix the highlighted manual grading fields.',
        fieldErrors
      );
    }

    // Re-evaluate attempt totals and grading_status via gradeSubmittedExamAttemptInLockPhase6_
    att = gradeSubmittedExamAttemptInLockPhase6_(
      att,
      adminUser.user_id,
      'MANUAL_GRADING_COMPLETED',
      sanitizeSingleLineTextStep7_(req.reason || 'Instructor manual rubric grading saved', 300)
    );

    if (publishNow && (att.grading_status === 'GRADED' || att.grading_status === 'REGRADED')) {
      att = updateSheetRecordById_(
        'ExamAttempts',
        attemptId,
        {
          publication_status: 'PUBLISHED',
          explanation_status: releaseExplanationsNow ? 'RELEASED' : att.explanation_status,
          updated_at_utc: nowIso
        },
        Number(att.version),
        { skipLock: true }
      );
      var exHit = exsTbl.byId[att.exam_set_id];
      if (exHit) {
        syncPublishedExamScoreToAssessmentScoresInLockPhase6_(
          exHit.record,
          att.student_user_id,
          adminUser.user_id
        );
      }
    }

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_EXAM_MANUAL_GRADING_SAVED',
      targetEntityType: 'ExamAttempt',
      targetEntityId: attemptId,
      summary: {
        examSetId: att.exam_set_id,
        studentUserId: att.student_user_id,
        gradingStatus: att.grading_status,
        publicationStatus: att.publication_status,
        totalScoreBp: att.total_score_bp,
        maxScoreBp: att.max_score_bp
      }
    });
  });

  var inspected = handleAdminInspectAttemptPhase6_({ attemptId: attemptId }, context);
  var listBundle = handleAdminListAttemptsPhase6_({}, context);
  return {
    inspectedAttempt: inspected,
    attempts: listBundle.attempts,
    summary: listBundle.summary
  };
}




// ============================================================================
// NATIVE ONLINE EXAMINATION SYSTEM -- PHASE 7: READ-TIME FILTERED RESULTS,
// INDEPENDENT SCORE & EXPLANATION RELEASE, AUDITED REGRADING & MONITORING
// ============================================================================

/**
 * Evaluates effective read-time publication_status and explanation_status for an attempt
 * against the server clock and ExamSet release policies.
 */
function resolveEffectiveAttemptReleaseStatePhase7_(attemptRow, examSetRow, opt_nowMs) {
  var nowMs = opt_nowMs || Date.now();
  if (
    !attemptRow ||
    attemptRow.attempt_status === 'INVALIDATED' ||
    attemptRow.attempt_status === 'INVALIDATED_COPY_POLICY'
  ) {
    return {
      isGradedComplete: false,
      effectivePublicationStatus: 'WITHHELD',
      effectiveExplanationStatus: 'WITHHELD',
      scorePublished: false,
      explanationsReleased: false
    };
  }
  var gradStatus = attemptRow.grading_status || 'NOT_GRADED';
  var pubStatus = attemptRow.publication_status || 'UNPUBLISHED';
  var expStatus = attemptRow.explanation_status || 'WITHHELD';

  var isGradedComplete = gradStatus === 'GRADED' || gradStatus === 'REGRADED';
  if (!isGradedComplete) {
    return {
      isGradedComplete: false,
      effectivePublicationStatus: 'UNPUBLISHED',
      effectiveExplanationStatus: 'WITHHELD',
      scorePublished: false,
      explanationsReleased: false
    };
  }

  if (pubStatus !== 'WITHHELD' && pubStatus !== 'PUBLISHED') {
    var sPol = examSetRow ? examSetRow.score_release_policy : 'MANUAL_ADMIN';
    if (
      (pubStatus === 'SCHEDULED' || sPol === 'SCHEDULED') &&
      examSetRow &&
      examSetRow.score_release_at_utc &&
      nowMs >= Date.parse(examSetRow.score_release_at_utc)
    ) {
      pubStatus = 'PUBLISHED';
    } else if (
      sPol === 'AFTER_CLOSE' &&
      examSetRow &&
      examSetRow.close_at_utc &&
      nowMs >= Date.parse(examSetRow.close_at_utc)
    ) {
      pubStatus = 'PUBLISHED';
    }
  }

  var scorePublished = pubStatus === 'PUBLISHED';

  if (expStatus !== 'RELEASED' && examSetRow) {
    var ePol = examSetRow.explanation_release_policy || 'WITH_SCORE';
    if (ePol === 'NEVER') {
      expStatus = 'WITHHELD';
    } else if (ePol === 'WITH_SCORE' && scorePublished) {
      expStatus = 'RELEASED';
    } else if (
      ePol === 'SCHEDULED' &&
      examSetRow.explanation_release_at_utc &&
      nowMs >= Date.parse(examSetRow.explanation_release_at_utc)
    ) {
      expStatus = 'RELEASED';
    } else if (
      ePol === 'AFTER_CLOSE' &&
      examSetRow.close_at_utc &&
      nowMs >= Date.parse(examSetRow.close_at_utc)
    ) {
      expStatus = 'RELEASED';
    }
  }

  return {
    isGradedComplete: true,
    effectivePublicationStatus: pubStatus,
    effectiveExplanationStatus: expStatus,
    scorePublished: scorePublished,
    explanationsReleased: scorePublished && expStatus === 'RELEASED'
  };
}

/**
 * Returns the student's read-time filtered result & explanation view for a submitted attempt
 * or examination set ('exams.getPublishedResult').
 * - If scorePublished === false: strips all scores, per-item correctness, keys, and explanations.
 * - If scorePublished === true && explanationsReleased === false: returns scores, section breakdown,
 *   and per-item awarded points & instructor feedback, but strips answer keys and explanations.
 * - If scorePublished === true && explanationsReleased === true: includes full answer keys and explanations.
 */
function handleStudentGetPublishedResultPhase7_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to view examination results.'
    );
  }
  ensureExamPhase6SheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var requestedAttemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  var requestedExamSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);

  var attTbl = readSheetTable_('ExamAttempts');
  var exsTbl = readSheetTable_('ExamSets');
  var exsctTbl = readSheetTable_('ExamSections');
  var atiTbl = readSheetTable_('AttemptItems');
  var atrTbl = readSheetTable_('AttemptResponses');
  var qbTbl = readSheetTable_('QuestionBank');
  var qvTbl = readSheetTable_('QuestionVersions');
  var qoTbl = readSheetTable_('QuestionOptions');
  var stimTbl = readSheetTable_('SharedStimuli');
  var rrvTbl = readSheetTable_('ResultRevisions');

  var targetAttempt = null;
  var studentSubmittedAttempts = [];

  if (requestedAttemptId) {
    var hit = attTbl.byId[requestedAttemptId];
    if (!hit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination attempt "' + requestedAttemptId + '" was not found.'
      );
    }
    targetAttempt = hit.record;
    if (usr.role !== 'ADMIN' && targetAttempt.student_user_id !== usr.user_id) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: Attempt belongs to another student.'
      );
    }
    requestedExamSetId = targetAttempt.exam_set_id;
  }

  if (!requestedExamSetId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Either attemptId or examSetId is required.'
    );
  }

  var exHit = exsTbl.byId[requestedExamSetId];
  if (!exHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Examination set "' + requestedExamSetId + '" was not found.'
    );
  }
  var exRow = exHit.record;

  var targetStudentId = targetAttempt ? targetAttempt.student_user_id : usr.user_id;
  for (var i = 0; i < attTbl.records.length; i++) {
    var r = attTbl.records[i];
    if (
      r.exam_set_id === requestedExamSetId &&
      r.student_user_id === targetStudentId &&
      (r.attempt_status === 'SUBMITTED' || r.attempt_status === 'EXPIRED_SUBMITTED')
    ) {
      studentSubmittedAttempts.push(r);
    }
  }
  studentSubmittedAttempts.sort(function (a, b) {
    return (Number(a.attempt_number) || 0) - (Number(b.attempt_number) || 0);
  });

  if (!targetAttempt) {
    if (studentSubmittedAttempts.length === 0) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'No submitted attempts found for this examination.'
      );
    }
    // Choose attempt according to aggregation_rule across published attempts (or latest submitted)
    var rule = exRow.aggregation_rule || 'BEST_PUBLISHED';
    var pubCandidates = [];
    for (var pc = 0; pc < studentSubmittedAttempts.length; pc++) {
      var rel = resolveEffectiveAttemptReleaseStatePhase7_(studentSubmittedAttempts[pc], exRow);
      if (rel.scorePublished) {
        pubCandidates.push(studentSubmittedAttempts[pc]);
      }
    }
    var pool = pubCandidates.length > 0 ? pubCandidates : studentSubmittedAttempts;
    targetAttempt = pool[pool.length - 1];
    if (rule === 'FIRST_PUBLISHED') {
      targetAttempt = pool[0];
    } else if (rule === 'BEST_PUBLISHED') {
      targetAttempt = pool[0];
      for (var bi = 1; bi < pool.length; bi++) {
        if (Number(pool[bi].total_score_bp) >= Number(targetAttempt.total_score_bp)) {
          targetAttempt = pool[bi];
        }
      }
    }
  }

  var releaseState = resolveEffectiveAttemptReleaseStatePhase7_(targetAttempt, exRow);
  var receiptDto = buildStudentSubmissionReceiptBundlePhase6_(targetAttempt, exRow);

  var attemptSummaries = studentSubmittedAttempts.map(function (a) {
    var rel = resolveEffectiveAttemptReleaseStatePhase7_(a, exRow);
    return {
      attemptId: a.attempt_id,
      attemptNumber: Number(a.attempt_number) || 1,
      attemptStatus: a.attempt_status,
      gradingStatus: a.grading_status,
      publicationStatus: rel.effectivePublicationStatus,
      explanationStatus: rel.effectiveExplanationStatus,
      submittedAtBangkok: formatBangkokTimestamp_(a.submitted_at_utc),
      scoreDisplay: rel.scorePublished
        ? formatPointsBpDisplayPhase2_(a.total_score_bp) + ' / ' + formatPointsBpDisplayPhase2_(a.max_score_bp)
        : 'Pending Publication'
    };
  });

  // Case 1: Score is NOT published yet -> return receipt + status only, zero scores or items leaked!
  if (!releaseState.scorePublished) {
    return {
      scorePublished: false,
      explanationsReleased: false,
      attemptId: targetAttempt.attempt_id,
      attemptNumber: Number(targetAttempt.attempt_number) || 1,
      examSetId: exRow.exam_set_id,
      examCode: exRow.exam_code,
      examTitle: exRow.title,
      gradingStatus: targetAttempt.grading_status,
      publicationStatus: releaseState.effectivePublicationStatus,
      explanationStatus: releaseState.effectiveExplanationStatus,
      releasePolicyNotice: receiptDto.releasePolicyExplanation,
      receipt: receiptDto,
      attemptsHistory: attemptSummaries
    };
  }

  // Case 2: Score IS published -> build section breakdown and read-time filtered item review
  var optionsByQvId = {};
  for (var oi = 0; oi < qoTbl.records.length; oi++) {
    var op = qoTbl.records[oi];
    if (!optionsByQvId[op.question_version_id]) {
      optionsByQvId[op.question_version_id] = [];
    }
    optionsByQvId[op.question_version_id].push(op);
  }

  var respByItemId = {};
  for (var ri = 0; ri < atrTbl.records.length; ri++) {
    if (atrTbl.records[ri].attempt_id === targetAttempt.attempt_id) {
      respByItemId[atrTbl.records[ri].attempt_item_id] = atrTbl.records[ri];
    }
  }

  var sectionsById = {};
  for (var si = 0; si < exsctTbl.records.length; si++) {
    var sRec = exsctTbl.records[si];
    if (sRec.exam_version_id === targetAttempt.exam_version_id) {
      sectionsById[sRec.exam_section_id] = {
        examSectionId: sRec.exam_section_id,
        title: sRec.title,
        sortOrder: Number(sRec.sort_order) || 10,
        earnedBp: 0,
        maxBp: 0,
        questionCount: 0
      };
    }
  }

  var attItems = [];
  for (var ai = 0; ai < atiTbl.records.length; ai++) {
    if (atiTbl.records[ai].attempt_id === targetAttempt.attempt_id) {
      attItems.push(atiTbl.records[ai]);
    }
  }
  attItems.sort(function (a, b) {
    return (Number(a.display_number) || 0) - (Number(b.display_number) || 0);
  });

  var includeExplanations = releaseState.explanationsReleased;
  var reviewItems = [];

  for (var k = 0; k < attItems.length; k++) {
    var ati = attItems[k];
    var qbHit = qbTbl.byId[ati.question_id];
    var qvHit = qvTbl.byId[ati.question_version_id];
    var qbRec = qbHit ? qbHit.record : null;
    var qvRec = qvHit ? qvHit.record : null;
    var stimRec =
      ati.stimulus_id && stimTbl.byId[ati.stimulus_id]
        ? stimTbl.byId[ati.stimulus_id].record
        : null;
    var respRow = respByItemId[ati.attempt_item_id] || null;

    var itemEarnedBp = respRow ? Number(respRow.awarded_points_bp) || 0 : 0;
    var itemMaxBp = Number(ati.points_bp) || 100;

    if (sectionsById[ati.exam_section_id]) {
      sectionsById[ati.exam_section_id].earnedBp += Math.max(0, itemEarnedBp);
      sectionsById[ati.exam_section_id].maxBp += itemMaxBp;
      sectionsById[ati.exam_section_id].questionCount += 1;
    }

    var parsedResp = {};
    if (respRow && respRow.response_payload_json) {
      try {
        parsedResp = JSON.parse(respRow.response_payload_json);
      } catch (e) {
        parsedResp = {};
      }
    }

    // Order options in the student's persisted option_order_json order
    var rawOpts = optionsByQvId[ati.question_version_id] || [];
    var optMap = {};
    for (var om = 0; om < rawOpts.length; om++) {
      optMap[rawOpts[om].option_id] = rawOpts[om];
    }
    var persistedOptIds = [];
    try {
      persistedOptIds = JSON.parse(ati.option_order_json || '[]');
    } catch (e) {
      persistedOptIds = [];
    }
    var orderedOptRows = [];
    var seenOpt = {};
    for (var po = 0; po < persistedOptIds.length; po++) {
      if (optMap[persistedOptIds[po]]) {
        orderedOptRows.push(optMap[persistedOptIds[po]]);
        seenOpt[persistedOptIds[po]] = true;
      }
    }
    for (var ro = 0; ro < rawOpts.length; ro++) {
      if (!seenOpt[rawOpts[ro].option_id]) {
        orderedOptRows.push(rawOpts[ro]);
      }
    }

    // Project question DTO: ONLY pass includePrivate = true when explanationsReleased === true!
    var projectedQ = qbRec && qvRec
      ? projectQuestionVersionDtoPhase2_(qbRec, qvRec, orderedOptRows, stimRec, includeExplanations)
      : null;

    if (projectedQ && !includeExplanations) {
      // Double-ensure zero answer-key leakage when explanations are withheld
      delete projectedQ.privateGradingData;
      if (Array.isArray(projectedQ.options)) {
        for (var sc = 0; sc < projectedQ.options.length; sc++) {
          delete projectedQ.options[sc].isCorrect;
          delete projectedQ.options[sc].isCorrectPrivate;
        }
      }
    } else if (projectedQ && includeExplanations && projectedQ.privateGradingData) {
      // Strip private adminNotes even when explanations are released to students!
      delete projectedQ.privateGradingData.adminNotes;
    }

    var itemDto = {
      attemptItemId: ati.attempt_item_id,
      displayNumber: Number(ati.display_number) || k + 1,
      examSectionId: ati.exam_section_id,
      sectionTitle: sectionsById[ati.exam_section_id] ? sectionsById[ati.exam_section_id].title : 'Section',
      questionCode: qbRec ? qbRec.question_code : '',
      questionType: qvRec ? qvRec.question_type : '',
      isAnswered: Boolean(respRow && respRow.is_answered),
      studentResponse: parsedResp,
      correctnessState: respRow ? respRow.correctness_state : 'UNANSWERED',
      awardedPointsBp: itemEarnedBp,
      awardedPointsDisplay: formatPointsBpDisplayPhase2_(itemEarnedBp),
      maxPointsBp: itemMaxBp,
      maxPointsDisplay: formatPointsBpDisplayPhase2_(itemMaxBp),
      instructorFeedback: respRow ? respRow.instructor_feedback || '' : '',
      question: projectedQ
    };

    if (includeExplanations && projectedQ && projectedQ.privateGradingData) {
      itemDto.explanationRichText = projectedQ.privateGradingData.explanationRichText;
      itemDto.explanationPlainText = projectedQ.privateGradingData.explanationPlainText;
      itemDto.referenceText = projectedQ.privateGradingData.referenceText || '';
      itemDto.answerKeySummary = projectedQ.privateGradingData.gradingSpec || {};
    }

    reviewItems.push(itemDto);
  }

  var sectionBreakdown = Object.keys(sectionsById)
    .map(function (k) { return sectionsById[k]; })
    .sort(function (a, b) { return a.sortOrder - b.sortOrder; })
    .map(function (sec) {
      var pct = sec.maxBp > 0 ? Math.round((sec.earnedBp / sec.maxBp) * 1000) / 10 : 0;
      return {
        examSectionId: sec.examSectionId,
        title: sec.title,
        questionCount: sec.questionCount,
        earnedDisplay: formatPointsBpDisplayPhase2_(sec.earnedBp),
        maxDisplay: formatPointsBpDisplayPhase2_(sec.maxBp),
        scoreDisplay: formatPointsBpDisplayPhase2_(sec.earnedBp) + ' / ' + formatPointsBpDisplayPhase2_(sec.maxBp),
        percentageFormatted: pct.toFixed(1) + '%'
      };
    });

  // Check if attempt has an ADMIN_REGRADE revision in ResultRevisions
  var latestRegradeNote = '';
  for (var rv = rrvTbl.records.length - 1; rv >= 0; rv--) {
    var rev = rrvTbl.records[rv];
    if (rev.attempt_id === targetAttempt.attempt_id && rev.revision_type === 'ADMIN_REGRADE') {
      latestRegradeNote =
        'Regraded on ' + formatBangkokTimestamp_(rev.created_at_utc) + ': ' + (rev.reason || 'Answer key updated.');
      break;
    }
  }

  return {
    scorePublished: true,
    explanationsReleased: includeExplanations,
    attemptId: targetAttempt.attempt_id,
    attemptNumber: Number(targetAttempt.attempt_number) || 1,
    examSetId: exRow.exam_set_id,
    examCode: exRow.exam_code,
    examTitle: exRow.title,
    gradingStatus: targetAttempt.grading_status,
    publicationStatus: releaseState.effectivePublicationStatus,
    explanationStatus: releaseState.effectiveExplanationStatus,
    regradeNotice: latestRegradeNote,
    releasePolicyNotice: receiptDto.releasePolicyExplanation,
    receipt: receiptDto,
    scoreSummary: receiptDto.publishedScoreResult,
    sectionBreakdown: sectionBreakdown,
    items: reviewItems,
    attemptsHistory: attemptSummaries
  };
}

/**
 * Publishes or withholds scores and explanations independently for one or more attempts
 * or across an entire ExamSet ('admin.results.publish').
 */
function handleAdminPublishResultsPhase7_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase6SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  var singleAttemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  var attemptIds = Array.isArray(req.attemptIds) ? req.attemptIds.slice() : [];
  if (singleAttemptId && attemptIds.indexOf(singleAttemptId) === -1) {
    attemptIds.push(singleAttemptId);
  }

  var publicationAction = String(req.publicationAction || 'KEEP_CURRENT').trim().toUpperCase();
  var explanationAction = String(req.explanationAction || 'KEEP_CURRENT').trim().toUpperCase();
  var reason = sanitizeSingleLineTextStep7_(
    req.reason || 'Administrator updated score/explanation release state',
    300
  );

  var updatedCount = 0;
  var skippedPendingManualCount = 0;
  var warnings = [];

  withScriptLock_(function () {
    var attTbl = readSheetTable_('ExamAttempts');
    var exsTbl = readSheetTable_('ExamSets');
    var rrvTbl = readSheetTable_('ResultRevisions');
    var nowIso = nowUtcIso_();

    var targetAttempts = [];
    if (attemptIds.length > 0) {
      for (var i = 0; i < attemptIds.length; i++) {
        var hit = attTbl.byId[String(attemptIds[i] || '').trim()];
        if (hit) targetAttempts.push(hit.record);
      }
    } else if (examSetId) {
      for (var j = 0; j < attTbl.records.length; j++) {
        var r = attTbl.records[j];
        if (
          r.exam_set_id === examSetId &&
          (r.attempt_status === 'SUBMITTED' || r.attempt_status === 'EXPIRED_SUBMITTED')
        ) {
          targetAttempts.push(r);
        }
      }
    }

    if (targetAttempts.length === 0) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'No matching submitted attempts were found for publication update.'
      );
    }

    var affectedStudentsByExam = {};

    for (var k = 0; k < targetAttempts.length; k++) {
      var att = targetAttempts[k];
      var exHit = exsTbl.byId[att.exam_set_id];
      var exRow = exHit ? exHit.record : null;

      if (
        att.attempt_status === 'INVALIDATED' ||
        att.attempt_status === 'INVALIDATED_COPY_POLICY'
      ) {
        if (attemptIds.length === 1) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_EXAM_ATTEMPT_INVALIDATED,
            'Cannot publish results for an invalidated examination attempt ("' + att.attempt_id + '").'
          );
        }
        continue;
      }

      if (att.grading_status === 'AUTO_GRADED_PENDING_MANUAL' && publicationAction === 'PUBLISH_SCORES') {
        if (attemptIds.length === 1) {
          throw createAppError_(
            'ERR_MANUAL_GRADING_INCOMPLETE',
            'Cannot publish score for attempt "' +
              att.attempt_id +
              '" while written or short-answer items are still pending manual rubric grading.'
          );
        }
        skippedPendingManualCount += 1;
        continue;
      }

      var nextPub = att.publication_status || 'UNPUBLISHED';
      if (publicationAction === 'PUBLISH_SCORES') {
        nextPub = 'PUBLISHED';
      } else if (publicationAction === 'WITHHOLD_SCORES') {
        nextPub = 'WITHHELD';
      }

      var nextExp = att.explanation_status || 'WITHHELD';
      if (explanationAction === 'RELEASE_EXPLANATIONS') {
        nextExp = 'RELEASED';
      } else if (explanationAction === 'WITHHOLD_EXPLANATIONS') {
        nextExp = 'WITHHELD';
      }

      if (
        exRow &&
        nextExp === 'RELEASED' &&
        (Number(exRow.max_attempts) === 0 || Number(exRow.max_attempts) > 1)
      ) {
        warnings.push({
          code: 'RETAKE_ANSWER_KEY_EXPOSURE_WARNING',
          message:
            'Explanations and answer keys are now released for "' +
            exRow.exam_code +
            '" while multiple attempts are permitted.'
        });
      }

      var maxRevNo = 0;
      for (var rv = 0; rv < rrvTbl.records.length; rv++) {
        if (rrvTbl.records[rv].attempt_id === att.attempt_id) {
          var rn = Number(rrvTbl.records[rv].revision_no) || 0;
          if (rn > maxRevNo) maxRevNo = rn;
        }
      }
      var revId = generateEntityId_('rrv_');
      insertSheetRecord_(
        'ResultRevisions',
        {
          result_revision_id: revId,
          attempt_id: att.attempt_id,
          exam_set_id: att.exam_set_id,
          exam_version_id: att.exam_version_id,
          student_user_id: att.student_user_id,
          revision_no: maxRevNo + 1,
          revision_type: 'PUBLICATION_CHANGE',
          auto_score_bp: Number(att.auto_score_bp) || 0,
          manual_score_bp: Number(att.manual_score_bp) || 0,
          total_score_bp: Number(att.total_score_bp) || 0,
          max_score_bp: Number(att.max_score_bp) || 0,
          percentage_bp: Number(att.percentage_bp) || 0,
          passed_flag: Boolean(att.passed_flag),
          grading_status: att.grading_status,
          publication_status: nextPub,
          explanation_status: nextExp,
          reason: reason,
          actor_user_id: adminUser.user_id,
          created_at_utc: nowIso
        },
        { skipLock: true }
      );

      updateSheetRecordById_(
        'ExamAttempts',
        att.attempt_id,
        {
          publication_status: nextPub,
          explanation_status: nextExp,
          current_result_revision_id: revId,
          updated_at_utc: nowIso
        },
        Number(att.version),
        { skipLock: true }
      );

      updatedCount += 1;
      affectedStudentsByExam[att.exam_set_id + '|' + att.student_user_id] = {
        examSetRow: exRow,
        studentUserId: att.student_user_id
      };
    }

    var syncKeys = Object.keys(affectedStudentsByExam);
    for (var sk = 0; sk < syncKeys.length; sk++) {
      var info = affectedStudentsByExam[syncKeys[sk]];
      if (info.examSetRow) {
        syncPublishedExamScoreToAssessmentScoresInLockPhase6_(
          info.examSetRow,
          info.studentUserId,
          adminUser.user_id
        );
      }
    }

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_EXAM_RESULTS_PUBLICATION_UPDATED',
      targetEntityType: 'ExamSet',
      targetEntityId: examSetId || singleAttemptId || 'BATCH',
      summary: {
        publicationAction: publicationAction,
        explanationAction: explanationAction,
        updatedCount: updatedCount,
        skippedPendingManualCount: skippedPendingManualCount,
        reason: reason
      }
    });
  });

  var listBundle = handleAdminListAttemptsPhase6_({}, context);
  return {
    updatedCount: updatedCount,
    skippedPendingManualCount: skippedPendingManualCount,
    warnings: warnings,
    attempts: listBundle.attempts,
    summary: listBundle.summary
  };
}

/**
 * Executes an audited, reason-required server-side regrade across affected submitted attempts
 * ('admin.results.regrade'). Supports RE_EVALUATE_CURRENT_KEYS (with optional upgrade to a
 * question's latest active_version_id) and FULL_CREDIT_ITEM, recording ResultRevisions
 * and synchronizing AssessmentScores.
 */
function handleAdminRegradeExamPhase7_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase6SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  var singleAttemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  var targetQuestionId = sanitizeSingleLineTextStep7_(req.questionId, 64);
  var regradeMode = String(req.regradeMode || 'RE_EVALUATE_CURRENT_KEYS').trim().toUpperCase();
  var upgradeToLatestQuestionVersion = Boolean(req.upgradeToLatestQuestionVersion);
  var reason = sanitizeSingleLineTextStep7_(req.reason, 400);

  if (!reason || reason.length < 5) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'A descriptive audit reason (at least 5 characters) is mandatory when regrading examination attempts.',
      { reason: 'Regrade audit reason is required (min 5 characters).' }
    );
  }
  if (!examSetId && !singleAttemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Either examSetId or attemptId is required to execute a regrade.'
    );
  }
  if (regradeMode === 'FULL_CREDIT_ITEM' && !targetQuestionId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'questionId is required when regradeMode is FULL_CREDIT_ITEM.',
      { questionId: 'Select the question to grant full credit.' }
    );
  }

  var regradedAttemptsCount = 0;
  var regradedSummaries = [];

  withScriptLock_(function () {
    var attTbl = readSheetTable_('ExamAttempts');
    var atiTbl = readSheetTable_('AttemptItems');
    var atrTbl = readSheetTable_('AttemptResponses');
    var qbTbl = readSheetTable_('QuestionBank');
    var nowIso = nowUtcIso_();

    var latestQvIdForTargetQuestion = '';
    if (targetQuestionId) {
      var qbHit = qbTbl.byId[targetQuestionId];
      if (!qbHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Question "' + targetQuestionId + '" was not found in QuestionBank.'
        );
      }
      latestQvIdForTargetQuestion = qbHit.record.active_version_id;
    }

    var targetAttempts = [];
    for (var i = 0; i < attTbl.records.length; i++) {
      var att = attTbl.records[i];
      if (singleAttemptId && att.attempt_id !== singleAttemptId) continue;
      if (examSetId && att.exam_set_id !== examSetId) continue;
      if (att.attempt_status !== 'SUBMITTED' && att.attempt_status !== 'EXPIRED_SUBMITTED') continue;
      targetAttempts.push(att);
    }

    if (targetAttempts.length === 0) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'No submitted attempts found to regrade.'
      );
    }

    for (var a = 0; a < targetAttempts.length; a++) {
      var curAtt = targetAttempts[a];
      var previousTotalBp = Number(curAtt.total_score_bp) || 0;

      // Refresh tables inside loop
      atiTbl = readSheetTable_('AttemptItems');
      atrTbl = readSheetTable_('AttemptResponses');

      if (targetQuestionId) {
        for (var m = 0; m < atiTbl.records.length; m++) {
          var ati = atiTbl.records[m];
          if (ati.attempt_id !== curAtt.attempt_id || ati.question_id !== targetQuestionId) continue;

          if (upgradeToLatestQuestionVersion && latestQvIdForTargetQuestion && ati.question_version_id !== latestQvIdForTargetQuestion) {
            updateSheetRecordById_(
              'AttemptItems',
              ati.attempt_item_id,
              { question_version_id: latestQvIdForTargetQuestion },
              undefined,
              { skipLock: true }
            );
            ati.question_version_id = latestQvIdForTargetQuestion;
          }

          if (regradeMode === 'FULL_CREDIT_ITEM') {
            var itemMaxBp = Number(ati.points_bp) || 100;
            var existingResp = null;
            for (var r = 0; r < atrTbl.records.length; r++) {
              if (
                atrTbl.records[r].attempt_id === curAtt.attempt_id &&
                atrTbl.records[r].attempt_item_id === ati.attempt_item_id
              ) {
                existingResp = atrTbl.records[r];
                break;
              }
            }
            if (!existingResp) {
              insertSheetRecord_(
                'AttemptResponses',
                {
                  response_id: generateEntityId_('atr_'),
                  attempt_id: curAtt.attempt_id,
                  attempt_item_id: ati.attempt_item_id,
                  question_version_id: ati.question_version_id,
                  student_user_id: curAtt.student_user_id,
                  response_payload_json: '{}',
                  is_answered: false,
                  client_revision_no: 0,
                  server_revision_no: Number(curAtt.latest_revision_no) || 1,
                  saved_at_utc: nowIso,
                  grading_source: 'MANUAL_INSTRUCTOR',
                  awarded_points_bp: itemMaxBp,
                  max_points_bp: itemMaxBp,
                  correctness_state: 'CORRECT',
                  instructor_feedback: 'Full credit awarded via audited regrade: ' + reason,
                  graded_by_user_id: adminUser.user_id,
                  graded_at_utc: nowIso,
                  created_at_utc: nowIso,
                  updated_at_utc: nowIso
                },
                { skipLock: true }
              );
            } else {
              updateSheetRecordById_(
                'AttemptResponses',
                existingResp.response_id,
                {
                  question_version_id: ati.question_version_id,
                  grading_source: 'MANUAL_INSTRUCTOR',
                  awarded_points_bp: itemMaxBp,
                  max_points_bp: itemMaxBp,
                  correctness_state: 'CORRECT',
                  instructor_feedback: 'Full credit awarded via audited regrade: ' + reason,
                  graded_by_user_id: adminUser.user_id,
                  graded_at_utc: nowIso,
                  updated_at_utc: nowIso
                },
                Number(existingResp.version),
                { skipLock: true }
              );
            }
          }
        }
      }

      var jrnId = generateEntityId_('exj_');
      insertSheetRecord_(
        'ExamOperationJournal',
        {
          journal_id: jrnId,
          operation_type: 'REGRADE_ATTEMPT',
          idempotency_key: 'regrade_' + curAtt.attempt_id + '_' + Date.now() + '_' + a,
          attempt_id: curAtt.attempt_id,
          exam_set_id: curAtt.exam_set_id,
          student_user_id: curAtt.student_user_id,
          target_status: 'REGRADED',
          payload_json: JSON.stringify({
            regradeMode: regradeMode,
            questionId: targetQuestionId,
            previousTotalBp: previousTotalBp,
            reason: reason
          }),
          journal_status: 'PENDING',
          created_at_utc: nowIso,
          committed_at_utc: ''
        },
        { skipLock: true }
      );

      var regradedAtt = gradeSubmittedExamAttemptInLockPhase6_(
        curAtt,
        adminUser.user_id,
        'ADMIN_REGRADE',
        reason
      );

      updateSheetRecordById_(
        'ExamOperationJournal',
        jrnId,
        {
          journal_status: 'COMMITTED',
          committed_at_utc: nowIso
        },
        undefined,
        { skipLock: true }
      );

      regradedAttemptsCount += 1;
      regradedSummaries.push({
        attemptId: regradedAtt.attempt_id,
        studentUserId: regradedAtt.student_user_id,
        previousScoreBp: previousTotalBp,
        newScoreBp: Number(regradedAtt.total_score_bp) || 0,
        newScoreDisplay:
          formatPointsBpDisplayPhase2_(regradedAtt.total_score_bp) +
          ' / ' +
          formatPointsBpDisplayPhase2_(regradedAtt.max_score_bp),
        gradingStatus: regradedAtt.grading_status,
        publicationStatus: regradedAtt.publication_status
      });
    }

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_EXAM_REGRADE_EXECUTED',
      targetEntityType: 'ExamSet',
      targetEntityId: examSetId || singleAttemptId,
      summary: {
        regradeMode: regradeMode,
        questionId: targetQuestionId,
        upgradeToLatestQuestionVersion: upgradeToLatestQuestionVersion,
        regradedAttemptsCount: regradedAttemptsCount,
        reason: reason
      }
    });
  });

  var listBundle = handleAdminListAttemptsPhase6_({}, context);
  return {
    regradedAttemptsCount: regradedAttemptsCount,
    regradedSummaries: regradedSummaries,
    reason: reason,
    attempts: listBundle.attempts,
    summary: listBundle.summary
  };
}

/**
 * Manages an active or submitted student attempt ('admin.attempts.manage'):
 * - EXTEND_TIME: Adds +extraMinutes to an IN_PROGRESS attempt's effective_deadline_utc & grace_deadline_utc.
 * - FORCE_FINALIZE_EXPIRED: Finalizes an elapsed IN_PROGRESS attempt.
 * - INVALIDATE_ATTEMPT: Marks an attempt INVALIDATED with a mandatory audit reason so it does not count
 *   against the student's allowed attempts, and re-synchronizes AssessmentScores.
 */
function handleAdminManageAttemptPhase7_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase6SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  var operation = String(req.operation || '').trim().toUpperCase();
  var reason = sanitizeSingleLineTextStep7_(req.reason, 400);

  if (!attemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'attemptId is required.'
    );
  }
  if (!reason || reason.length < 3) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'An administrative audit reason is required for attempt management actions.',
      { reason: 'Audit reason is required.' }
    );
  }

  var updatedAttempt = null;
  withScriptLock_(function () {
    var attTbl = readSheetTable_('ExamAttempts');
    var exsTbl = readSheetTable_('ExamSets');
    var attHit = attTbl.byId[attemptId];
    if (!attHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Attempt "' + attemptId + '" was not found.'
      );
    }
    var att = attHit.record;
    var exHit = exsTbl.byId[att.exam_set_id];
    var exRow = exHit ? exHit.record : null;
    var nowIso = nowUtcIso_();

    if (operation === 'EXTEND_TIME') {
      var extraMinutes = Math.max(1, Math.min(240, parseInt(req.extraMinutes, 10) || 15));
      var baseMs = att.effective_deadline_utc
        ? Math.max(Date.now(), Date.parse(att.effective_deadline_utc))
        : Date.now() + 30 * 60 * 1000;
      var nextDeadMs = baseMs + extraMinutes * 60 * 1000;
      var graceSec = exRow ? Number(exRow.grace_seconds) || 15 : 15;
      var nextDeadIso = new Date(nextDeadMs).toISOString();
      var nextGraceIso = new Date(nextDeadMs + graceSec * 1000).toISOString();

      updatedAttempt = updateSheetRecordById_(
        'ExamAttempts',
        attemptId,
        {
          attempt_status: 'IN_PROGRESS',
          effective_deadline_utc: nextDeadIso,
          grace_deadline_utc: nextGraceIso,
          updated_at_utc: nowIso
        },
        Number(att.version),
        { skipLock: true }
      );
      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_EXAM_ATTEMPT_TIME_EXTENDED',
        targetEntityType: 'ExamAttempt',
        targetEntityId: attemptId,
        summary: {
          extraMinutes: extraMinutes,
          newEffectiveDeadlineUtc: nextDeadIso,
          reason: reason
        }
      });
    } else if (operation === 'INVALIDATE_ATTEMPT') {
      updatedAttempt = updateSheetRecordById_(
        'ExamAttempts',
        attemptId,
        {
          attempt_status: 'INVALIDATED',
          publication_status: 'WITHHELD',
          explanation_status: 'WITHHELD',
          active_lease_token: '',
          updated_at_utc: nowIso
        },
        Number(att.version),
        { skipLock: true }
      );
      if (exRow) {
        syncPublishedExamScoreToAssessmentScoresInLockPhase6_(
          exRow,
          att.student_user_id,
          adminUser.user_id
        );
      }
      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_EXAM_ATTEMPT_INVALIDATED',
        targetEntityType: 'ExamAttempt',
        targetEntityId: attemptId,
        summary: {
          examSetId: att.exam_set_id,
          studentUserId: att.student_user_id,
          reason: reason
        }
      });
    } else if (operation === 'FORCE_FINALIZE_EXPIRED') {
      var expCheck = checkAndFinalizeExpiredAttemptInLockPhase4_(
        att,
        Date.now() + 365 * 24 * 3600 * 1000
      );
      updatedAttempt = expCheck.attemptRow;
    } else {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'operation must be EXTEND_TIME, INVALIDATE_ATTEMPT, or FORCE_FINALIZE_EXPIRED.'
      );
    }
  });

  var listBundle = handleAdminListAttemptsPhase6_({}, context);
  return {
    attempt: updatedAttempt,
    attempts: listBundle.attempts,
    summary: listBundle.summary
  };
}

/**
 * Computes basic examination & per-question performance analytics for an ExamSet
 * ('admin.exams.analytics').
 */
function handleAdminGetExamAnalyticsPhase7_(payload, context) {
  assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase6SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId, 64);
  if (!examSetId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'examSetId is required.'
    );
  }

  var exsTbl = readSheetTable_('ExamSets');
  var attTbl = readSheetTable_('ExamAttempts');
  var atiTbl = readSheetTable_('AttemptItems');
  var atrTbl = readSheetTable_('AttemptResponses');
  var qbTbl = readSheetTable_('QuestionBank');

  var exHit = exsTbl.byId[examSetId];
  if (!exHit) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Examination set "' + examSetId + '" was not found.'
    );
  }
  var exRow = exHit.record;

  var statusCounts = {
    inProgress: 0,
    submitted: 0,
    expiredSubmitted: 0,
    invalidated: 0,
    pendingManual: 0,
    graded: 0,
    published: 0
  };
  var gradedAttempts = [];
  var validAttemptIds = {};

  for (var i = 0; i < attTbl.records.length; i++) {
    var att = attTbl.records[i];
    if (att.exam_set_id !== examSetId) continue;
    if (att.attempt_status === 'IN_PROGRESS') statusCounts.inProgress += 1;
    if (att.attempt_status === 'SUBMITTED') statusCounts.submitted += 1;
    if (att.attempt_status === 'EXPIRED_SUBMITTED') statusCounts.expiredSubmitted += 1;
    if (att.attempt_status === 'INVALIDATED') {
      statusCounts.invalidated += 1;
      continue;
    }
    validAttemptIds[att.attempt_id] = att;
    if (att.grading_status === 'AUTO_GRADED_PENDING_MANUAL') statusCounts.pendingManual += 1;
    if (att.grading_status === 'GRADED' || att.grading_status === 'REGRADED') {
      statusCounts.graded += 1;
      gradedAttempts.push(att);
    }
    if (att.publication_status === 'PUBLISHED') statusCounts.published += 1;
  }

  var pctList = [];
  var passCount = 0;
  var highestBp = null;
  var lowestBp = null;
  var maxPossibleBp = 0;

  for (var g = 0; g < gradedAttempts.length; g++) {
    var ga = gradedAttempts[g];
    var pct = (Number(ga.percentage_bp) || 0) / 100;
    var scBp = Number(ga.total_score_bp) || 0;
    maxPossibleBp = Number(ga.max_score_bp) || maxPossibleBp;
    pctList.push(pct);
    if (ga.passed_flag) passCount += 1;
    if (highestBp === null || scBp > highestBp) highestBp = scBp;
    if (lowestBp === null || scBp < lowestBp) lowestBp = scBp;
  }
  pctList.sort(function (a, b) { return a - b; });

  var meanPct = 0;
  var medianPct = 0;
  if (pctList.length > 0) {
    var sum = 0;
    for (var p = 0; p < pctList.length; p++) sum += pctList[p];
    meanPct = Math.round((sum / pctList.length) * 10) / 10;
    var mid = Math.floor(pctList.length / 2);
    medianPct =
      pctList.length % 2 === 1
        ? Math.round(pctList[mid] * 10) / 10
        : Math.round(((pctList[mid - 1] + pctList[mid]) / 2) * 10) / 10;
  }

  var respByItemId = {};
  for (var r = 0; r < atrTbl.records.length; r++) {
    var rRow = atrTbl.records[r];
    if (validAttemptIds[rRow.attempt_id]) {
      respByItemId[rRow.attempt_item_id] = rRow;
    }
  }

  var statsByQuestionId = {};
  for (var k = 0; k < atiTbl.records.length; k++) {
    var ati = atiTbl.records[k];
    if (!validAttemptIds[ati.attempt_id]) continue;
    var qId = ati.question_id;
    if (!statsByQuestionId[qId]) {
      var qbHit = qbTbl.byId[qId];
      var qbRec = qbHit ? qbHit.record : null;
      statsByQuestionId[qId] = {
        questionId: qId,
        questionCode: qbRec ? qbRec.question_code : qId,
        title: qbRec ? qbRec.title : '',
        questionType: qbRec ? qbRec.question_type : '',
        deliveredCount: 0,
        answeredCount: 0,
        correctCount: 0,
        flaggedCount: 0,
        totalAwardedBp: 0,
        maxPointsBp: Number(ati.points_bp) || 100
      };
    }
    var st = statsByQuestionId[qId];
    st.deliveredCount += 1;
    if (ati.is_flagged) st.flaggedCount += 1;
    var resp = respByItemId[ati.attempt_item_id];
    if (resp) {
      if (resp.is_answered) st.answeredCount += 1;
      if (resp.correctness_state === 'CORRECT') st.correctCount += 1;
      st.totalAwardedBp += Math.max(0, Number(resp.awarded_points_bp) || 0);
    }
  }

  var itemAnalytics = Object.keys(statsByQuestionId).map(function (qId) {
    var st = statsByQuestionId[qId];
    var corrPct = st.deliveredCount > 0 ? Math.round((st.correctCount / st.deliveredCount) * 1000) / 10 : 0;
    var flagPct = st.deliveredCount > 0 ? Math.round((st.flaggedCount / st.deliveredCount) * 1000) / 10 : 0;
    var avgBp = st.deliveredCount > 0 ? Math.round(st.totalAwardedBp / st.deliveredCount) : 0;
    return {
      questionId: st.questionId,
      questionCode: st.questionCode,
      title: st.title,
      questionType: st.questionType,
      deliveredCount: st.deliveredCount,
      answeredCount: st.answeredCount,
      correctCount: st.correctCount,
      correctRateFormatted: corrPct.toFixed(1) + '%',
      flaggedRateFormatted: flagPct.toFixed(1) + '%',
      averagePointsDisplay: formatPointsBpDisplayPhase2_(avgBp) + ' / ' + formatPointsBpDisplayPhase2_(st.maxPointsBp)
    };
  });

  return {
    examSetId: examSetId,
    examCode: exRow.exam_code,
    examTitle: exRow.title,
    statusCounts: statusCounts,
    scoreDistribution: {
      gradedCount: gradedAttempts.length,
      meanPercentageFormatted: meanPct.toFixed(1) + '%',
      medianPercentageFormatted: medianPct.toFixed(1) + '%',
      passRateFormatted:
        gradedAttempts.length > 0
          ? (Math.round((passCount / gradedAttempts.length) * 1000) / 10).toFixed(1) + '%'
          : '0.0%',
      highestScoreDisplay:
        highestBp !== null
          ? formatPointsBpDisplayPhase2_(highestBp) + ' / ' + formatPointsBpDisplayPhase2_(maxPossibleBp)
          : '-',
      lowestScoreDisplay:
        lowestBp !== null
          ? formatPointsBpDisplayPhase2_(lowestBp) + ' / ' + formatPointsBpDisplayPhase2_(maxPossibleBp)
          : '-'
    },
    itemAnalytics: itemAnalytics
  };
}




// ============================================================================
// NATIVE ONLINE EXAMINATION SYSTEM -- PHASE 8: QUOTA-SAFE MAINTENANCE SWEEP,
// SCHEDULED RELEASE PROMOTION, EXPIRED ATTEMPT FINALIZATION & E2E HARDENING
// ============================================================================

/**
 * Executes a quota-safe maintenance sweep across the Native Online Examination subsystem
 * inside LockService:
 * 1. Recovers any interrupted PENDING ExamOperationJournal entries.
 * 2. Auto-finalizes any IN_PROGRESS ExamAttempts whose grace_deadline_utc has elapsed.
 * 3. Promotes any GRADED/REGRADED attempts whose SCHEDULED or AFTER_CLOSE release window
 *    has elapsed to PUBLISHED (and RELEASED explanations when applicable) and syncs
 *    AssessmentScores so the student dashboard reflects newly released scheduled scores.
 */
function runExamSubsystemMaintenanceInLockPhase8_(opt_nowMs, opt_actorUserId) {
  ensureExamPhase6SheetsExist_();
  var nowMs = opt_nowMs || Date.now();
  var nowIso = new Date(nowMs).toISOString();
  var actorId = opt_actorUserId || 'SYSTEM_MAINTENANCE';

  var recoveredJournals = recoverPendingExamJournalsInLockPhase6_();
  var expiredFinalizedCount = 0;
  var scheduledPromotedCount = 0;

  var attTbl = readSheetTable_('ExamAttempts');
  var exsTbl = readSheetTable_('ExamSets');

  // Step 1: Auto-finalize elapsed IN_PROGRESS attempts
  for (var i = 0; i < attTbl.records.length; i++) {
    var att = attTbl.records[i];
    if (att.attempt_status === 'IN_PROGRESS' && att.grace_deadline_utc) {
      var graceMs = Date.parse(att.grace_deadline_utc);
      if (!isNaN(graceMs) && nowMs > graceMs) {
        var expRes = checkAndFinalizeExpiredAttemptInLockPhase4_(att, nowMs);
        if (expRes.expiredNow || expRes.expiredAndFinalized) {
          expiredFinalizedCount += 1;
        }
      }
    }
  }

  // Re-read attempts after any expirations
  attTbl = readSheetTable_('ExamAttempts');
  var affectedStudentExams = {};

  // Step 2: Promote elapsed SCHEDULED / AFTER_CLOSE releases and sync AssessmentScores
  for (var j = 0; j < attTbl.records.length; j++) {
    var curAtt = attTbl.records[j];
    if (curAtt.attempt_status !== 'SUBMITTED' && curAtt.attempt_status !== 'EXPIRED_SUBMITTED') {
      continue;
    }
    if (curAtt.grading_status !== 'GRADED' && curAtt.grading_status !== 'REGRADED') {
      continue;
    }
    var exHit = exsTbl.byId[curAtt.exam_set_id];
    if (!exHit) continue;
    var exRow = exHit.record;

    var relState = resolveEffectiveAttemptReleaseStatePhase7_(curAtt, exRow, nowMs);
    var needsUpdate = false;
    var patch = { updated_at_utc: nowIso };

    if (relState.scorePublished && curAtt.publication_status !== 'PUBLISHED') {
      patch.publication_status = 'PUBLISHED';
      needsUpdate = true;
    }
    if (relState.explanationsReleased && curAtt.explanation_status !== 'RELEASED') {
      patch.explanation_status = 'RELEASED';
      needsUpdate = true;
    }

    if (needsUpdate) {
      updateSheetRecordById_(
        'ExamAttempts',
        curAtt.attempt_id,
        patch,
        Number(curAtt.version),
        { skipLock: true }
      );
      scheduledPromotedCount += 1;
      affectedStudentExams[curAtt.exam_set_id + '|' + curAtt.student_user_id] = {
        examSetRow: exRow,
        studentUserId: curAtt.student_user_id
      };
    }
  }

  var syncKeys = Object.keys(affectedStudentExams);
  for (var k = 0; k < syncKeys.length; k++) {
    var info = affectedStudentExams[syncKeys[k]];
    syncPublishedExamScoreToAssessmentScoresInLockPhase6_(
      info.examSetRow,
      info.studentUserId,
      actorId
    );
  }

  return {
    recoveredJournalsCount: recoveredJournals.recoveredCount,
    expiredFinalizedCount: expiredFinalizedCount,
    scheduledPromotedCount: scheduledPromotedCount,
    sweptAtUtc: nowIso
  };
}

/**
 * Administrator RPC handler ('admin.exams.runMaintenance') to execute the quota-safe
 * examination maintenance sweep (journal recovery, expired attempt auto-finalization,
 * and scheduled publication promotion + AssessmentScores synchronization).
 */
function handleAdminRunExamMaintenancePhase8_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamPhase6SheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var sweepResult = null;

  withScriptLock_(function () {
    sweepResult = runExamSubsystemMaintenanceInLockPhase8_(Date.now(), adminUser.user_id);
    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_EXAM_MAINTENANCE_SWEEP_EXECUTED',
      targetEntityType: 'ExamSubsystem',
      targetEntityId: 'ALL_EXAMS',
      summary: sweepResult
    });
  });

  var listBundle = handleAdminListAttemptsPhase6_(
    { examSetId: req.examSetId || '' },
    context
  );
  return {
    maintenance: sweepResult,
    attempts: listBundle.attempts,
    summary: listBundle.summary
  };
}




// ============================================================================
// COPY-RESTRICTION & EXAMINATION-INTEGRITY POLICY EXTENSION -- PHASE A:
// POLICY SETTINGS, QUALIFYING EVENTS, ATTEMPT/ACCOUNT STATES & SCHEMA DEFINITIONS
// ============================================================================

/**
 * Authoritative default settings for the Copy-Restriction & Examination-Integrity Policy.
 * - Qualifying copy attempts 1..5 trigger a 5-second suspension (copyWarningCount <= maxCopyWarnings).
 * - The 6th qualifying copy attempt (copyWarningCount > maxCopyWarnings, i.e., 6 > 5) invalidates that attempt.
 * - Distinct non-overturned copy-policy attempt invalidations 1..3 do NOT lock the student account.
 * - The 4th distinct non-overturned copy-policy invalidation (count > maxIntegrityInvalidationsBeforeLock, i.e., 4 > 3)
 *   locks the student account pending administrator review.
 */
var PB_EXAM_INTEGRITY_POLICY_DEFAULTS_ = Object.freeze({
  POLICY_VERSION: 'pb-exam-integrity-v1',
  MAX_COPY_WARNINGS: 5,
  INVALIDATE_ON_COPY_ATTEMPT_NUMBER: 6,
  SUSPENSION_SECONDS: 5,
  MAX_INTEGRITY_INVALIDATIONS_BEFORE_LOCK: 3,
  LOCK_ACCOUNT_ON_INVALIDATION_NUMBER: 4,
  DEFAULT_ENABLED_BY_MODE: Object.freeze({
    MOCK_EXAM: true,
    ASSIGNED_ASSESSMENT: true,
    PRACTICE: false
  }),
  PROTECTED_TARGET_REGIONS: Object.freeze({
    QUESTION_STEM: true,
    OPTION_TEXT: true,
    SHARED_STIMULUS: true,
    QUESTION_CAPTION: true
  }),
  EXEMPT_INTERACTION_TYPES: Object.freeze({
    ORDINARY_SELECTION_ONLY: true,
    RIGHT_CLICK_OR_CONTEXT_MENU_ONLY: true,
    SELECT_ALL_SHORTCUT_ONLY: true,
    KEYBOARD_NAVIGATION: true,
    SCREEN_READER_NAVIGATION: true,
    ANSWER_CLICK_OR_TAP: true,
    STUDENT_OWN_ANSWER_FIELD_COPY: true,
    ATTEMPT_REFERENCE_COPY: true,
    SUPPORT_CONTACT_COPY: true,
    OUTSIDE_EXAM_CONTENT_COPY: true,
    TAB_SWITCH_OR_BLUR_ONLY: true
  }),
  DISCLOSURE_TEXT: Object.freeze({
    PRIMARY_NOTICE:
      'Copying question content is restricted during this examination. Each detected copy attempt temporarily pauses access to the examination for 5 seconds. A sixth detected attempt invalidates this examination attempt. Four non-overturned examination invalidations under this policy will lock your account pending administrator review.',
    TIMER_CONTINUES_NOTICE:
      'The examination timer continues during these temporary pauses.',
    TECHNICAL_LIMITATIONS_NOTICE:
      'This copy-restriction policy operates as a deterrent and an examination rule enforced on detected/reported copy events within protected question areas. Browser code cannot prevent screenshots, cameras, OCR, developer tools, or modified clients, and all automatic invalidations or account locks remain subject to administrator review and appeal.',
    ACCOMMODATION_CONTACT_NOTICE:
      'If you use assistive technology or require an accessibility accommodation for this examination, please contact Pattanabhumi Biology Support before starting your attempt.'
  })
});

/**
 * Registers the Phase A Examination Integrity worksheets
 * ('ExamIntegrityEvents', 'ExamPolicyAcknowledgments', 'StudentIntegrityProfiles', 'ExamIntegrityReviews')
 * and backward-compatibly extends 'ExamSets', 'ExamAssignments', and 'ExamAttempts' in PB_SHEET_SCHEMAS_.
 */
function ensureExamIntegrityPhaseASchemasRegistered_() {
  ensureExamPhase4SchemasRegistered_();
  ensureExamPhase6SchemasRegistered_();

  if (typeof PB_SHEET_NAMES_ === 'object' && PB_SHEET_NAMES_ && !PB_SHEET_NAMES_.EXAM_INTEGRITY_EVENTS) {
    var nextNames = {};
    var nameKeys = Object.keys(PB_SHEET_NAMES_);
    for (var i = 0; i < nameKeys.length; i++) {
      nextNames[nameKeys[i]] = PB_SHEET_NAMES_[nameKeys[i]];
    }
    nextNames.EXAM_INTEGRITY_EVENTS = 'ExamIntegrityEvents';
    nextNames.EXAM_POLICY_ACKNOWLEDGMENTS = 'ExamPolicyAcknowledgments';
    nextNames.STUDENT_INTEGRITY_PROFILES = 'StudentIntegrityProfiles';
    nextNames.EXAM_INTEGRITY_REVIEWS = 'ExamIntegrityReviews';
    PB_SHEET_NAMES_ = Object.freeze(nextNames);
  }

  if (typeof PB_SHEET_SCHEMAS_ === 'object' && PB_SHEET_SCHEMAS_ && !PB_SHEET_SCHEMAS_.ExamIntegrityEvents) {
    var nextSchemas = {};
    var schemaKeys = Object.keys(PB_SHEET_SCHEMAS_);
    for (var j = 0; j < schemaKeys.length; j++) {
      nextSchemas[schemaKeys[j]] = PB_SHEET_SCHEMAS_[schemaKeys[j]];
    }

    // Extend ExamSets with optional copy-restriction policy configuration columns
    if (nextSchemas.ExamSets) {
      var esHeaders = nextSchemas.ExamSets.headers.slice();
      var extraEsHeaders = [
        'copy_policy_enabled',
        'copy_policy_version',
        'max_copy_warnings',
        'copy_suspension_seconds',
        'max_integrity_invalidations_before_lock'
      ];
      for (var eh = 0; eh < extraEsHeaders.length; eh++) {
        if (esHeaders.indexOf(extraEsHeaders[eh]) === -1) {
          esHeaders.push(extraEsHeaders[eh]);
        }
      }
      var esBools = nextSchemas.ExamSets.booleanFields.slice();
      if (esBools.indexOf('copy_policy_enabled') === -1) esBools.push('copy_policy_enabled');
      var esInts = nextSchemas.ExamSets.integerFields.slice();
      ['max_copy_warnings', 'copy_suspension_seconds', 'max_integrity_invalidations_before_lock'].forEach(function (col) {
        if (esInts.indexOf(col) === -1) esInts.push(col);
      });
      nextSchemas.ExamSets = Object.freeze({
        sheetName: 'ExamSets',
        primaryKey: 'exam_set_id',
        idPrefix: 'exs_',
        hasVersion: true,
        headers: Object.freeze(esHeaders),
        requiredFields: nextSchemas.ExamSets.requiredFields,
        enums: nextSchemas.ExamSets.enums,
        booleanFields: Object.freeze(esBools),
        integerFields: Object.freeze(esInts),
        positiveSatangFields: nextSchemas.ExamSets.positiveSatangFields
      });
    }

    // Extend ExamAssignments with optional copy-policy accessibility accommodation columns
    if (nextSchemas.ExamAssignments) {
      var eaHeaders = nextSchemas.ExamAssignments.headers.slice();
      ['copy_policy_accommodation_mode', 'custom_max_copy_warnings'].forEach(function (col) {
        if (eaHeaders.indexOf(col) === -1) eaHeaders.push(col);
      });
      var eaInts = nextSchemas.ExamAssignments.integerFields.slice();
      if (eaInts.indexOf('custom_max_copy_warnings') === -1) eaInts.push('custom_max_copy_warnings');
      nextSchemas.ExamAssignments = Object.freeze({
        sheetName: 'ExamAssignments',
        primaryKey: 'assignment_id',
        idPrefix: 'exa_',
        hasVersion: true,
        headers: Object.freeze(eaHeaders),
        requiredFields: nextSchemas.ExamAssignments.requiredFields,
        enums: nextSchemas.ExamAssignments.enums,
        booleanFields: nextSchemas.ExamAssignments.booleanFields,
        integerFields: Object.freeze(eaInts),
        positiveSatangFields: nextSchemas.ExamAssignments.positiveSatangFields
      });
    }

    // Extend ExamAttempts with snapshotted policy & integrity suspension/invalidation columns
    if (nextSchemas.ExamAttempts) {
      var attHeaders = nextSchemas.ExamAttempts.headers.slice();
      var extraAttCols = [
        'copy_policy_enabled_snapshot',
        'copy_policy_version_snapshot',
        'max_copy_warnings_snapshot',
        'copy_suspension_seconds_snapshot',
        'max_invalidations_lock_snapshot',
        'policy_acknowledged_at_utc',
        'copy_warning_count',
        'suspension_until_utc',
        'invalidation_reason_code',
        'invalidated_at_utc',
        'invalidation_overturned',
        'invalidation_overturned_at_utc',
        'invalidation_overturned_by_user_id',
        'invalidation_review_reason'
      ];
      for (var ac = 0; ac < extraAttCols.length; ac++) {
        if (attHeaders.indexOf(extraAttCols[ac]) === -1) {
          attHeaders.push(extraAttCols[ac]);
        }
      }
      var attBools = nextSchemas.ExamAttempts.booleanFields.slice();
      ['copy_policy_enabled_snapshot', 'invalidation_overturned'].forEach(function (col) {
        if (attBools.indexOf(col) === -1) attBools.push(col);
      });
      var attInts = nextSchemas.ExamAttempts.integerFields.slice();
      [
        'max_copy_warnings_snapshot',
        'copy_suspension_seconds_snapshot',
        'max_invalidations_lock_snapshot',
        'copy_warning_count'
      ].forEach(function (col) {
        if (attInts.indexOf(col) === -1) attInts.push(col);
      });
      var attEnums = Object.assign({}, nextSchemas.ExamAttempts.enums, {
        attempt_status: Object.freeze([
          'IN_PROGRESS',
          'SUBMITTED',
          'EXPIRED_SUBMITTED',
          'INVALIDATED',
          'INVALIDATED_COPY_POLICY'
        ])
      });
      nextSchemas.ExamAttempts = Object.freeze({
        sheetName: 'ExamAttempts',
        primaryKey: 'attempt_id',
        idPrefix: 'att_',
        hasVersion: true,
        headers: Object.freeze(attHeaders),
        requiredFields: nextSchemas.ExamAttempts.requiredFields,
        enums: Object.freeze(attEnums),
        booleanFields: Object.freeze(attBools),
        integerFields: Object.freeze(attInts),
        positiveSatangFields: nextSchemas.ExamAttempts.positiveSatangFields
      });
    }

    // 1. ExamIntegrityEvents (eie_)
    nextSchemas.ExamIntegrityEvents = Object.freeze({
      sheetName: 'ExamIntegrityEvents',
      primaryKey: 'integrity_event_id',
      idPrefix: 'eie_',
      hasVersion: true,
      headers: Object.freeze([
        'integrity_event_id',
        'event_client_id',
        'attempt_id',
        'exam_set_id',
        'exam_version_id',
        'course_id',
        'student_user_id',
        'policy_version',
        'event_type',
        'target_region',
        'attempt_item_id',
        'question_id',
        'warning_count_after',
        'outcome_action',
        'suspension_until_utc',
        'triggered_invalidation',
        'triggered_account_lock',
        'review_status',
        'reviewed_by_user_id',
        'reviewed_at_utc',
        'review_reason',
        'detected_at_client_utc',
        'recorded_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'integrity_event_id',
        'event_client_id',
        'attempt_id',
        'exam_set_id',
        'student_user_id',
        'policy_version',
        'event_type',
        'target_region',
        'outcome_action',
        'review_status',
        'recorded_at_utc'
      ]),
      enums: Object.freeze({
        event_type: Object.freeze(['QUALIFYING_COPY_ATTEMPT']),
        target_region: Object.freeze([
          'QUESTION_STEM',
          'OPTION_TEXT',
          'SHARED_STIMULUS',
          'QUESTION_CAPTION'
        ]),
        outcome_action: Object.freeze([
          'SUSPENDED_5S',
          'ATTEMPT_INVALIDATED',
          'IGNORED_DURING_SUSPENSION',
          'IDEMPOTENT_REPLAY'
        ]),
        review_status: Object.freeze([
          'UNREVIEWED',
          'CONFIRMED',
          'ERRONEOUS_OVERTURNED'
        ])
      }),
      booleanFields: Object.freeze(['triggered_invalidation', 'triggered_account_lock']),
      integerFields: Object.freeze(['warning_count_after', 'version']),
      positiveSatangFields: Object.freeze([])
    });

    // 2. ExamPolicyAcknowledgments (epa_)
    nextSchemas.ExamPolicyAcknowledgments = Object.freeze({
      sheetName: 'ExamPolicyAcknowledgments',
      primaryKey: 'ack_id',
      idPrefix: 'epa_',
      hasVersion: true,
      headers: Object.freeze([
        'ack_id',
        'exam_set_id',
        'exam_version_id',
        'attempt_id',
        'student_user_id',
        'policy_version',
        'max_copy_warnings_snapshot',
        'suspension_seconds_snapshot',
        'max_invalidations_before_lock_snapshot',
        'acknowledged_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'ack_id',
        'exam_set_id',
        'student_user_id',
        'policy_version',
        'acknowledged_at_utc'
      ]),
      enums: Object.freeze({}),
      booleanFields: Object.freeze([]),
      integerFields: Object.freeze([
        'max_copy_warnings_snapshot',
        'suspension_seconds_snapshot',
        'max_invalidations_before_lock_snapshot',
        'version'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    // 3. StudentIntegrityProfiles (sip_)
    nextSchemas.StudentIntegrityProfiles = Object.freeze({
      sheetName: 'StudentIntegrityProfiles',
      primaryKey: 'profile_id',
      idPrefix: 'sip_',
      hasVersion: true,
      headers: Object.freeze([
        'profile_id',
        'student_user_id',
        'integrity_status',
        'distinct_copy_invalidations_total',
        'overturned_invalidations_total',
        'effective_strike_baseline',
        'effective_active_strikes',
        'locked_at_utc',
        'lock_trigger_attempt_id',
        'lock_reason_code',
        'unlocked_at_utc',
        'unlocked_by_user_id',
        'unlock_reason',
        'updated_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'profile_id',
        'student_user_id',
        'integrity_status',
        'updated_at_utc'
      ]),
      enums: Object.freeze({
        integrity_status: Object.freeze([
          'CLEAR',
          'WARNED',
          'INTEGRITY_LOCKED',
          'UNLOCKED_ON_PROBATION'
        ])
      }),
      booleanFields: Object.freeze([]),
      integerFields: Object.freeze([
        'distinct_copy_invalidations_total',
        'overturned_invalidations_total',
        'effective_strike_baseline',
        'effective_active_strikes',
        'version'
      ]),
      positiveSatangFields: Object.freeze([])
    });

    // 4. ExamIntegrityReviews (eir_)
    nextSchemas.ExamIntegrityReviews = Object.freeze({
      sheetName: 'ExamIntegrityReviews',
      primaryKey: 'review_id',
      idPrefix: 'eir_',
      hasVersion: true,
      headers: Object.freeze([
        'review_id',
        'target_type',
        'target_id',
        'student_user_id',
        'attempt_id',
        'exam_set_id',
        'action_taken',
        'previous_state_json',
        'new_state_json',
        'new_strike_baseline_count',
        'reason',
        'admin_user_id',
        'created_at_utc',
        'version'
      ]),
      requiredFields: Object.freeze([
        'review_id',
        'target_type',
        'target_id',
        'student_user_id',
        'action_taken',
        'reason',
        'admin_user_id',
        'created_at_utc'
      ]),
      enums: Object.freeze({
        target_type: Object.freeze([
          'INTEGRITY_EVENT',
          'ATTEMPT_INVALIDATION',
          'ACCOUNT_INTEGRITY_LOCK'
        ]),
        action_taken: Object.freeze([
          'MARK_EVENT_ERRONEOUS',
          'CONFIRM_INCIDENT',
          'OVERTURN_INVALIDATION',
          'GRANT_REPLACEMENT_ATTEMPT',
          'UNLOCK_ACCOUNT_SET_BASELINE'
        ])
      }),
      booleanFields: Object.freeze([]),
      integerFields: Object.freeze(['new_strike_baseline_count', 'version']),
      positiveSatangFields: Object.freeze([])
    });

    PB_SHEET_SCHEMAS_ = Object.freeze(nextSchemas);
  }
}

/**
 * Ensures the Phase A Examination Integrity worksheets exist in the configured spreadsheet
 * and that extended columns on ExamSets, ExamAssignments, and ExamAttempts are reconciled.
 */
function ensureExamIntegrityPhaseASheetsExist_(opt_spreadsheet) {
  ensureExamIntegrityPhaseASchemasRegistered_();
  ensureExamPhase6SheetsExist_(opt_spreadsheet);
  var ss = opt_spreadsheet || openConfiguredSpreadsheet_();
  var tabs = [
    'ExamSets',
    'ExamAssignments',
    'ExamAttempts',
    'ExamIntegrityEvents',
    'ExamPolicyAcknowledgments',
    'StudentIntegrityProfiles',
    'ExamIntegrityReviews'
  ];
  for (var i = 0; i < tabs.length; i++) {
    var tName = tabs[i];
    var sh = ss.getSheetByName(tName);
    var expCols = PB_SHEET_SCHEMAS_[tName] ? PB_SHEET_SCHEMAS_[tName].headers.length : 0;
    if (!sh || sh.getLastRow() === 0 || sh.getLastColumn() < expCols) {
      ensureSingleSheetSchema_(ss, tName);
    }
  }
}

/**
 * Returns the default copy-restriction policy settings for a given examination mode
 * ('MOCK_EXAM', 'ASSIGNED_ASSESSMENT', or 'PRACTICE').
 */
function getExamIntegrityPolicyDefaultsPhaseA_(opt_examMode) {
  var mode = String(opt_examMode || 'MOCK_EXAM').trim().toUpperCase();
  var enabledByDefault =
    PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.DEFAULT_ENABLED_BY_MODE[mode] !== undefined
      ? Boolean(PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.DEFAULT_ENABLED_BY_MODE[mode])
      : mode !== 'PRACTICE';

  return {
    policyVersion: PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.POLICY_VERSION,
    copyPolicyEnabled: enabledByDefault,
    maxCopyWarnings: PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.MAX_COPY_WARNINGS,
    invalidateOnCopyAttemptNumber:
      PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.INVALIDATE_ON_COPY_ATTEMPT_NUMBER,
    suspensionSeconds: PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.SUSPENSION_SECONDS,
    maxIntegrityInvalidationsBeforeLock:
      PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.MAX_INTEGRITY_INVALIDATIONS_BEFORE_LOCK,
    lockAccountOnInvalidationNumber:
      PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.LOCK_ACCOUNT_ON_INVALIDATION_NUMBER,
    disclosureText: PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.DISCLOSURE_TEXT
  };
}

/**
 * Resolves the immutable copy-restriction policy snapshot for a student's examination attempt,
 * taking into account the ExamSet mode defaults, explicit ExamSet overrides, and any approved
 * student accessibility accommodation in ExamAssignments.
 */
function resolveAttemptIntegrityPolicySnapshotPhaseA_(
  examSetRow,
  opt_examVersionRow,
  opt_studentAssignmentRow
) {
  var mode = (examSetRow && examSetRow.exam_mode) || 'MOCK_EXAM';
  var defaults = getExamIntegrityPolicyDefaultsPhaseA_(mode);

  var enabled = defaults.copyPolicyEnabled;
  if (
    examSetRow &&
    examSetRow.copy_policy_version &&
    examSetRow.copy_policy_enabled !== undefined &&
    examSetRow.copy_policy_enabled !== ''
  ) {
    enabled =
      examSetRow.copy_policy_enabled === true ||
      String(examSetRow.copy_policy_enabled).toLowerCase() === 'true';
  } else if (
    examSetRow &&
    (examSetRow.copy_policy_enabled === true ||
      String(examSetRow.copy_policy_enabled).toLowerCase() === 'true')
  ) {
    enabled = true;
  }

  var maxWarnings =
    examSetRow && Number(examSetRow.max_copy_warnings) > 0
      ? Math.floor(Number(examSetRow.max_copy_warnings))
      : defaults.maxCopyWarnings;
  var suspSec =
    examSetRow && Number(examSetRow.copy_suspension_seconds) > 0
      ? Math.floor(Number(examSetRow.copy_suspension_seconds))
      : defaults.suspensionSeconds;
  var maxInvBeforeLock =
    examSetRow && Number(examSetRow.max_integrity_invalidations_before_lock) > 0
      ? Math.floor(Number(examSetRow.max_integrity_invalidations_before_lock))
      : defaults.maxIntegrityInvalidationsBeforeLock;
  var polVersion =
    (examSetRow && examSetRow.copy_policy_version) || defaults.policyVersion;

  var accommodationMode = 'STANDARD';
  if (opt_studentAssignmentRow && opt_studentAssignmentRow.copy_policy_accommodation_mode) {
    accommodationMode = String(
      opt_studentAssignmentRow.copy_policy_accommodation_mode
    )
      .trim()
      .toUpperCase();
    if (accommodationMode === 'EXEMPT_ASSISTIVE_TECH') {
      enabled = false;
    } else if (
      accommodationMode === 'EXTENDED_WARNINGS' &&
      Number(opt_studentAssignmentRow.custom_max_copy_warnings) > maxWarnings
    ) {
      maxWarnings = Math.floor(
        Number(opt_studentAssignmentRow.custom_max_copy_warnings)
      );
    }
  }

  return {
    policyVersion: polVersion,
    copyPolicyEnabled: Boolean(enabled),
    accommodationMode: accommodationMode,
    maxCopyWarnings: maxWarnings,
    invalidateOnCopyAttemptNumber: maxWarnings + 1,
    suspensionSeconds: suspSec,
    maxIntegrityInvalidationsBeforeLock: maxInvBeforeLock,
    lockAccountOnInvalidationNumber: maxInvBeforeLock + 1,
    requiresPreExamAcknowledgment: Boolean(enabled),
    disclosureText: defaults.disclosureText
  };
}

/**
 * Pure threshold evaluator for a single newly detected qualifying copy attempt on an active attempt.
 * Uses strict greater-than comparison (nextWarningCount > maxCopyWarnings):
 * - Attempts 1 through maxCopyWarnings (default 1..5): triggers a 5-second suspension, does NOT invalidate.
 * - Attempt (maxCopyWarnings + 1) (default 6th attempt, 6 > 5): invalidates the examination attempt
 *   with reason code 'COPY_POLICY_LIMIT_EXCEEDED'.
 */
function evaluateCopyViolationThresholdPhaseA_(
  currentWarningCount,
  opt_policySnapshot,
  opt_nowMs
) {
  var snap = opt_policySnapshot || getExamIntegrityPolicyDefaultsPhaseA_('MOCK_EXAM');
  var maxWarnings =
    Number(snap.maxCopyWarnings) > 0
      ? Math.floor(Number(snap.maxCopyWarnings))
      : PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.MAX_COPY_WARNINGS;
  var suspSec =
    Number(snap.suspensionSeconds) > 0
      ? Math.floor(Number(snap.suspensionSeconds))
      : PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.SUSPENSION_SECONDS;
  var nowMs = opt_nowMs || Date.now();

  var prevCount = Math.max(0, Math.floor(Number(currentWarningCount) || 0));
  var nextWarningCount = prevCount + 1;

  // Strict greater-than comparison: > 5 means 6th attempt invalidates (5th attempt does NOT invalidate)
  var shouldInvalidate = nextWarningCount > maxWarnings;

  if (shouldInvalidate) {
    return {
      previousWarningCount: prevCount,
      newWarningCount: nextWarningCount,
      maxCopyWarnings: maxWarnings,
      outcomeAction: 'ATTEMPT_INVALIDATED',
      shouldSuspend: false,
      suspensionSeconds: 0,
      suspensionUntilUtc: '',
      shouldInvalidateAttempt: true,
      nextAttemptStatus: 'INVALIDATED_COPY_POLICY',
      invalidationReasonCode: 'COPY_POLICY_LIMIT_EXCEEDED',
      counterLabel:
        'Copy limit exceeded (' +
        nextWarningCount +
        ' detected attempts; maximum warnings allowed: ' +
        maxWarnings +
        ').'
    };
  }

  var suspUntilIso = new Date(nowMs + suspSec * 1000).toISOString();
  return {
    previousWarningCount: prevCount,
    newWarningCount: nextWarningCount,
    maxCopyWarnings: maxWarnings,
    outcomeAction: 'SUSPENDED_5S',
    shouldSuspend: true,
    suspensionSeconds: suspSec,
    suspensionUntilUtc: suspUntilIso,
    shouldInvalidateAttempt: false,
    nextAttemptStatus: 'IN_PROGRESS',
    invalidationReasonCode: '',
    counterLabel:
      'Copy attempt ' + nextWarningCount + ' of ' + maxWarnings + ' warnings.'
  };
}

/**
 * Pure threshold evaluator for account-level examination-integrity locking.
 * Counts distinct, non-overturned examination attempts invalidated specifically under
 * 'COPY_POLICY_LIMIT_EXCEEDED' minus any administrator-reviewed strike baseline offset.
 * Uses strict greater-than comparison (effectiveActiveStrikes > maxIntegrityInvalidationsBeforeLock):
 * - 1..3 non-overturned invalidations: account remains ACTIVE (does NOT lock on the 3rd invalidation).
 * - 4th non-overturned invalidation (4 > 3): account transitions to 'INTEGRITY_LOCKED'.
 * - If an administrator unlocks an account and sets effectiveStrikeBaseline = 4 (or reviewed count),
 *   unchanged historical invalidations (4 - 4 = 0 <= 3) do NOT immediately relock the account.
 */
function evaluateAccountIntegrityLockThresholdPhaseA_(
  distinctNonOverturnedCopyInvalidations,
  opt_effectiveStrikeBaseline,
  opt_maxInvalidationsBeforeLock
) {
  var totalNonOverturned = Math.max(
    0,
    Math.floor(Number(distinctNonOverturnedCopyInvalidations) || 0)
  );
  var baseline = Math.max(
    0,
    Math.floor(Number(opt_effectiveStrikeBaseline) || 0)
  );
  var maxBeforeLock =
    Number(opt_maxInvalidationsBeforeLock) > 0
      ? Math.floor(Number(opt_maxInvalidationsBeforeLock))
      : PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.MAX_INTEGRITY_INVALIDATIONS_BEFORE_LOCK;

  var effectiveActiveStrikes = Math.max(0, totalNonOverturned - baseline);
  // Strict greater-than comparison: > 3 means 4th invalidation locks the account (3rd does NOT lock)
  var shouldLockAccount = effectiveActiveStrikes > maxBeforeLock;

  return {
    distinctNonOverturnedCopyInvalidations: totalNonOverturned,
    effectiveStrikeBaseline: baseline,
    effectiveActiveStrikes: effectiveActiveStrikes,
    maxIntegrityInvalidationsBeforeLock: maxBeforeLock,
    lockThresholdInvalidationNumber: maxBeforeLock + 1,
    shouldLockAccount: shouldLockAccount,
    nextAccountStatus: shouldLockAccount ? 'INTEGRITY_LOCKED' : 'ACTIVE',
    nextIntegrityProfileStatus: shouldLockAccount
      ? 'INTEGRITY_LOCKED'
      : baseline > 0
      ? 'UNLOCKED_ON_PROBATION'
      : totalNonOverturned > 0
      ? 'WARNED'
      : 'CLEAR',
    lockReasonCode: shouldLockAccount ? 'REPEATED_EXAM_COPY_INVALIDATIONS' : ''
  };
}

/**
 * Evaluates whether an interaction descriptor represents a qualifying copy attempt on protected
 * examination content versus an exempt student or assistive-technology interaction.
 */
function isQualifyingProtectedCopyTargetRegionPhaseA_(interactionDescriptor) {
  var desc =
    interactionDescriptor && typeof interactionDescriptor === 'object'
      ? interactionDescriptor
      : {};
  var eventType = String(desc.domEventType || '').trim().toLowerCase();
  var targetRegion = String(desc.targetRegion || '').trim().toUpperCase();

  // Only canonical 'copy' or 'cut' events on protected regions qualify (never selectionchange, contextmenu, keydown alone, blur, etc.)
  if (eventType !== 'copy' && eventType !== 'cut') {
    return {
      qualifies: false,
      reason: 'NON_CLIPBOARD_EVENT_IGNORED'
    };
  }

  // Copying from student's own answer input/textarea, attempt reference, or support contact is always permitted
  if (
    desc.isStudentAnswerInput === true ||
    targetRegion === 'STUDENT_ANSWER_FIELD' ||
    targetRegion === 'ATTEMPT_REFERENCE' ||
    targetRegion === 'SUPPORT_CONTACT' ||
    targetRegion === 'OUTSIDE_EXAM'
  ) {
    return {
      qualifies: false,
      reason: 'EXEMPT_PERMITTED_REGION'
    };
  }

  if (!PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.PROTECTED_TARGET_REGIONS[targetRegion]) {
    return {
      qualifies: false,
      reason: 'UNPROTECTED_REGION'
    };
  }

  if (desc.isSuspensionDialogOpen === true) {
    return {
      qualifies: false,
      reason: 'IGNORED_WHILE_SUSPENSION_ACTIVE'
    };
  }

  return {
    qualifies: true,
    targetRegion: targetRegion,
    reason: 'QUALIFYING_PROTECTED_CONTENT_COPY'
  };
}




// ============================================================================
// COPY-RESTRICTION & EXAMINATION-INTEGRITY POLICY EXTENSION -- PHASE B:
// BACKEND EVENT PROCESSING, IDEMPOTENT COUNTING, 5S SUSPENSION, 6TH-EVENT
// INVALIDATION, 4TH-INVALIDATION ACCOUNT LOCK & JOURNAL RECOVERY
// ============================================================================

/**
 * Builds the student-safe integrityState summary attached to an ExamAttempt DTO.
 */
function buildAttemptIntegrityStateDtoPhaseB_(attemptRow, examSetRow, opt_nowMs) {
  var nowMs = opt_nowMs || Date.now();
  var enabled =
    attemptRow &&
    attemptRow.copy_policy_enabled_snapshot !== undefined &&
    attemptRow.copy_policy_enabled_snapshot !== ''
      ? attemptRow.copy_policy_enabled_snapshot === true ||
        String(attemptRow.copy_policy_enabled_snapshot).toLowerCase() === 'true'
      : Boolean(examSetRow && examSetRow.exam_mode !== 'PRACTICE');

  var maxWarnings =
    Number(attemptRow && attemptRow.max_copy_warnings_snapshot) > 0
      ? Number(attemptRow.max_copy_warnings_snapshot)
      : PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.MAX_COPY_WARNINGS;
  var suspSec =
    Number(attemptRow && attemptRow.copy_suspension_seconds_snapshot) > 0
      ? Number(attemptRow.copy_suspension_seconds_snapshot)
      : PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.SUSPENSION_SECONDS;
  var maxInvBeforeLock =
    Number(attemptRow && attemptRow.max_invalidations_lock_snapshot) > 0
      ? Number(attemptRow.max_invalidations_lock_snapshot)
      : PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.MAX_INTEGRITY_INVALIDATIONS_BEFORE_LOCK;

  var warningCount = Math.max(0, Number(attemptRow && attemptRow.copy_warning_count) || 0);
  var suspUntilStr = (attemptRow && attemptRow.suspension_until_utc) || '';
  var suspUntilMs = suspUntilStr ? Date.parse(suspUntilStr) : NaN;
  var isSuspended = Boolean(
    attemptRow &&
      attemptRow.attempt_status === 'IN_PROGRESS' &&
      !isNaN(suspUntilMs) &&
      suspUntilMs > nowMs
  );
  var remSuspSec = isSuspended ? Math.max(1, Math.ceil((suspUntilMs - nowMs) / 1000)) : 0;

  return {
    copyPolicyEnabled: enabled,
    policyVersion:
      (attemptRow && attemptRow.copy_policy_version_snapshot) ||
      PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.POLICY_VERSION,
    maxCopyWarnings: maxWarnings,
    invalidateOnCopyAttemptNumber: maxWarnings + 1,
    suspensionSeconds: suspSec,
    maxIntegrityInvalidationsBeforeLock: maxInvBeforeLock,
    lockAccountOnInvalidationNumber: maxInvBeforeLock + 1,
    copyWarningCount: warningCount,
    suspensionUntilUtc: isSuspended ? suspUntilStr : '',
    isCurrentlySuspended: isSuspended,
    remainingSuspensionSeconds: remSuspSec,
    invalidationReasonCode: (attemptRow && attemptRow.invalidation_reason_code) || '',
    invalidatedAtUtc: (attemptRow && attemptRow.invalidated_at_utc) || '',
    invalidationOverturned: Boolean(attemptRow && attemptRow.invalidation_overturned)
  };
}

/**
 * Throws ERR_EXAM_COPY_SUSPENDED if the attempt is currently within an active 5-second
 * copy-restriction suspension window on the server.
 */
function assertAttemptNotSuspendedByCopyPolicyPhaseB_(attemptRow, opt_nowMs) {
  if (!attemptRow || !attemptRow.suspension_until_utc) return;
  var nowMs = opt_nowMs || Date.now();
  var suspMs = Date.parse(attemptRow.suspension_until_utc);
  if (!isNaN(suspMs) && nowMs < suspMs) {
    var remSec = Math.max(1, Math.ceil((suspMs - nowMs) / 1000));
    var warnCount = Math.max(1, Number(attemptRow.copy_warning_count) || 1);
    var maxWarn =
      Number(attemptRow.max_copy_warnings_snapshot) ||
      PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.MAX_COPY_WARNINGS;
    throw createAppError_(
      PB_ERROR_CODES_.ERR_EXAM_COPY_SUSPENDED,
      'Copying is restricted: Please wait ' +
        remSec +
        ' second(s) for the temporary examination pause to finish before answering, navigating, or submitting.',
      {
        attemptId: attemptRow.attempt_id,
        copyWarningCount: String(warnCount),
        maxCopyWarnings: String(maxWarn),
        suspensionUntilUtc: attemptRow.suspension_until_utc,
        serverNowUtc: new Date(nowMs).toISOString(),
        remainingSuspensionSeconds: String(remSec)
      }
    );
  }
}

/**
 * Recomputes a student's distinct non-overturned copy-policy invalidation count across all
 * ExamAttempts in the application, updates StudentIntegrityProfiles, and if the count reaches
 * the lock threshold (> maxIntegrityInvalidationsBeforeLock, i.e., 4th invalidation), locks
 * the student account ('INTEGRITY_LOCKED'), revokes all active sessions, and freezes any other
 * active IN_PROGRESS attempts without counting them as additional copy invalidations.
 */
function recomputeStudentIntegrityProfileInLockPhaseB_(
  studentUserId,
  opt_triggerAttemptId,
  opt_maxInvalidationsBeforeLock,
  opt_nowIso
) {
  ensureExamIntegrityPhaseASheetsExist_();
  var nowIso = opt_nowIso || nowUtcIso_();
  var attTbl = readSheetTable_('ExamAttempts');
  var sipTbl = readSheetTable_('StudentIntegrityProfiles');
  var usrTbl = readSheetTable_('Users');

  var distinctNonOverturnedIds = {};
  var distinctOverturnedIds = {};
  var otherInProgressAttempts = [];

  for (var i = 0; i < attTbl.records.length; i++) {
    var att = attTbl.records[i];
    if (att.student_user_id !== studentUserId) continue;

    var isCopyPolicyInv =
      att.attempt_status === 'INVALIDATED_COPY_POLICY' ||
      (att.attempt_status === 'INVALIDATED' &&
        att.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED');

    if (isCopyPolicyInv && att.copy_policy_enabled_snapshot !== false) {
      var isOverturned =
        att.invalidation_overturned === true ||
        String(att.invalidation_overturned).toLowerCase() === 'true';
      if (isOverturned) {
        distinctOverturnedIds[att.attempt_id] = true;
      } else {
        distinctNonOverturnedIds[att.attempt_id] = true;
      }
    } else if (
      att.attempt_status === 'IN_PROGRESS' &&
      (!opt_triggerAttemptId || att.attempt_id !== opt_triggerAttemptId)
    ) {
      otherInProgressAttempts.push(att);
    }
  }

  var nonOverturnedCount = Object.keys(distinctNonOverturnedIds).length;
  var overturnedCount = Object.keys(distinctOverturnedIds).length;

  var existingProfile = null;
  for (var s = 0; s < sipTbl.records.length; s++) {
    if (sipTbl.records[s].student_user_id === studentUserId) {
      existingProfile = sipTbl.records[s];
      break;
    }
  }

  var baseline = existingProfile
    ? Math.max(0, Number(existingProfile.effective_strike_baseline) || 0)
    : 0;
  var lockEval = evaluateAccountIntegrityLockThresholdPhaseA_(
    nonOverturnedCount,
    baseline,
    opt_maxInvalidationsBeforeLock
  );

  var savedProfile = null;
  if (!existingProfile) {
    savedProfile = insertSheetRecord_(
      'StudentIntegrityProfiles',
      {
        profile_id: generateEntityId_('sip_'),
        student_user_id: studentUserId,
        integrity_status: lockEval.nextIntegrityProfileStatus,
        distinct_copy_invalidations_total: nonOverturnedCount,
        overturned_invalidations_total: overturnedCount,
        effective_strike_baseline: baseline,
        effective_active_strikes: lockEval.effectiveActiveStrikes,
        locked_at_utc: lockEval.shouldLockAccount ? nowIso : '',
        lock_trigger_attempt_id: lockEval.shouldLockAccount ? opt_triggerAttemptId || '' : '',
        lock_reason_code: lockEval.lockReasonCode,
        unlocked_at_utc: '',
        unlocked_by_user_id: '',
        unlock_reason: '',
        updated_at_utc: nowIso
      },
      { skipLock: true }
    );
  } else {
    var patchProfile = {
      integrity_status: lockEval.nextIntegrityProfileStatus,
      distinct_copy_invalidations_total: nonOverturnedCount,
      overturned_invalidations_total: overturnedCount,
      effective_strike_baseline: baseline,
      effective_active_strikes: lockEval.effectiveActiveStrikes,
      updated_at_utc: nowIso
    };
    if (lockEval.shouldLockAccount && existingProfile.integrity_status !== 'INTEGRITY_LOCKED') {
      patchProfile.locked_at_utc = nowIso;
      patchProfile.lock_trigger_attempt_id = opt_triggerAttemptId || '';
      patchProfile.lock_reason_code = lockEval.lockReasonCode;
    }
    savedProfile = updateSheetRecordById_(
      'StudentIntegrityProfiles',
      existingProfile.profile_id,
      patchProfile,
      Number(existingProfile.version),
      { skipLock: true }
    );
  }

  var accountLockedNow = false;
  var revokedSessionsCount = 0;
  var frozenOtherAttemptsCount = 0;
  var uHit = usrTbl.byId[studentUserId];

  if (lockEval.shouldLockAccount && uHit && uHit.record) {
    if (uHit.record.status !== 'INTEGRITY_LOCKED') {
      updateSheetRecordById_(
        'Users',
        studentUserId,
        {
          status: 'INTEGRITY_LOCKED',
          updated_at_utc: nowIso
        },
        Number(uHit.record.version),
        { skipLock: true }
      );
      accountLockedNow = true;
    }
    revokedSessionsCount = revokeAllUserSessions_(
      studentUserId,
      'EXAM_INTEGRITY_LOCK'
    );

    // Prevent further writes on any other active IN_PROGRESS attempts while preserving their data
    // and NOT counting them as additional copy-policy invalidations!
    for (var oa = 0; oa < otherInProgressAttempts.length; oa++) {
      var oAtt = otherInProgressAttempts[oa];
      if (oAtt.active_lease_token) {
        updateSheetRecordById_(
          'ExamAttempts',
          oAtt.attempt_id,
          {
            active_lease_token: '',
            updated_at_utc: nowIso
          },
          Number(oAtt.version),
          { skipLock: true }
        );
        frozenOtherAttemptsCount += 1;
      }
    }

    if (accountLockedNow) {
      recordAuditEvent_({
        actorUserId: studentUserId,
        actorRole: 'STUDENT',
        eventType: 'STUDENT_ACCOUNT_INTEGRITY_LOCKED',
        targetEntityType: 'User',
        targetEntityId: studentUserId,
        summary: {
          triggerAttemptId: opt_triggerAttemptId || '',
          distinctNonOverturnedCopyInvalidations: nonOverturnedCount,
          effectiveStrikeBaseline: baseline,
          effectiveActiveStrikes: lockEval.effectiveActiveStrikes,
          revokedSessionsCount: revokedSessionsCount,
          frozenOtherAttemptsCount: frozenOtherAttemptsCount
        }
      });
    }
  }

  return {
    profile: savedProfile,
    lockEval: lockEval,
    accountLocked: Boolean(
      lockEval.shouldLockAccount ||
        (uHit && uHit.record && uHit.record.status === 'INTEGRITY_LOCKED')
    ),
    accountLockedNow: accountLockedNow,
    revokedSessionsCount: revokedSessionsCount,
    frozenOtherAttemptsCount: frozenOtherAttemptsCount
  };
}

/**
 * Recovers an interrupted PENDING 'INTEGRITY_COPY_EVENT' entry from ExamOperationJournal
 * inside LockService without double-counting warnings or invalidations.
 */
function recoverPendingIntegrityCopyEventJournalInLockPhaseB_(jrnRow, attRow, nowIso) {
  ensureExamIntegrityPhaseASheetsExist_();
  var payload = {};
  try {
    payload = JSON.parse(jrnRow.payload_json || '{}');
  } catch (e) {
    payload = {};
  }

  var eventClientId = String(payload.eventClientId || '').trim();
  if (!eventClientId) return;

  var eieTbl = readSheetTable_('ExamIntegrityEvents');
  var existingEvt = null;
  for (var i = 0; i < eieTbl.records.length; i++) {
    var ev = eieTbl.records[i];
    if (ev.attempt_id === attRow.attempt_id && ev.event_client_id === eventClientId) {
      existingEvt = ev;
      break;
    }
  }

  var targetWarningCount = Number(payload.newWarningCount) || 1;
  var shouldInvalidate = Boolean(payload.shouldInvalidateAttempt);
  var suspUntilUtc = String(payload.suspensionUntilUtc || '');

  // 1. Ensure ExamAttempts reflects at least targetWarningCount & target status
  var freshAttHit = readSheetTable_('ExamAttempts').byId[attRow.attempt_id];
  var curAtt = freshAttHit ? freshAttHit.record : attRow;
  if (
    Number(curAtt.copy_warning_count || 0) < targetWarningCount ||
    (shouldInvalidate && curAtt.attempt_status !== 'INVALIDATED_COPY_POLICY')
  ) {
    var attPatch = {
      copy_warning_count: Math.max(Number(curAtt.copy_warning_count || 0), targetWarningCount),
      updated_at_utc: nowIso
    };
    if (shouldInvalidate) {
      attPatch.attempt_status = 'INVALIDATED_COPY_POLICY';
      attPatch.publication_status = 'WITHHELD';
      attPatch.explanation_status = 'WITHHELD';
      attPatch.suspension_until_utc = '';
      attPatch.invalidation_reason_code = 'COPY_POLICY_LIMIT_EXCEEDED';
      attPatch.invalidated_at_utc = curAtt.invalidated_at_utc || nowIso;
      attPatch.invalidation_overturned = false;
      attPatch.active_lease_token = '';
    } else if (suspUntilUtc) {
      attPatch.suspension_until_utc = suspUntilUtc;
    }
    curAtt = updateSheetRecordById_(
      'ExamAttempts',
      curAtt.attempt_id,
      attPatch,
      Number(curAtt.version),
      { skipLock: true }
    );
  }

  // 2. Ensure ExamIntegrityEvents row exists (idempotent by attempt_id + event_client_id)
  var lockOutcome = { accountLocked: false };
  if (shouldInvalidate) {
    var exHit = readSheetTable_('ExamSets').byId[curAtt.exam_set_id];
    if (exHit && exHit.record) {
      syncPublishedExamScoreToAssessmentScoresInLockPhase6_(
        exHit.record,
        curAtt.student_user_id,
        'SYSTEM_RECOVERY'
      );
    }
    lockOutcome = recomputeStudentIntegrityProfileInLockPhaseB_(
      curAtt.student_user_id,
      curAtt.attempt_id,
      Number(curAtt.max_invalidations_lock_snapshot) || 3,
      nowIso
    );
  }

  if (!existingEvt) {
    insertSheetRecord_(
      'ExamIntegrityEvents',
      {
        integrity_event_id: generateEntityId_('eie_'),
        event_client_id: eventClientId,
        attempt_id: curAtt.attempt_id,
        exam_set_id: curAtt.exam_set_id,
        exam_version_id: curAtt.exam_version_id,
        course_id: curAtt.course_id || '',
        student_user_id: curAtt.student_user_id,
        policy_version:
          curAtt.copy_policy_version_snapshot ||
          PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.POLICY_VERSION,
        event_type: 'QUALIFYING_COPY_ATTEMPT',
        target_region: payload.targetRegion || 'QUESTION_STEM',
        attempt_item_id: payload.attemptItemId || '',
        question_id: payload.questionId || '',
        warning_count_after: targetWarningCount,
        outcome_action: shouldInvalidate ? 'ATTEMPT_INVALIDATED' : 'SUSPENDED_5S',
        suspension_until_utc: shouldInvalidate ? '' : suspUntilUtc,
        triggered_invalidation: shouldInvalidate,
        triggered_account_lock: Boolean(lockOutcome.accountLocked),
        review_status: 'UNREVIEWED',
        reviewed_by_user_id: '',
        reviewed_at_utc: '',
        review_reason: '',
        detected_at_client_utc: payload.detectedAtClientUtc || nowIso,
        recorded_at_utc: nowIso
      },
      { skipLock: true }
    );
  }
}

/**
 * Processes a reported copy attempt on protected examination content ('exams.reportRestrictedCopy').
 * - Derives student identity strictly from context.authContext.user.user_id (ignoring client userId/warningCount).
 * - Enforces deadline expiry precedence before counting any violation.
 * - Enforces idempotency by (attemptId, eventId / eventClientId).
 * - Suppresses extra strikes while a 5-second suspension is already active on the server.
 * - Warnings 1..5 -> 5-second server-authoritative suspension ('SUSPENDED_5S').
 * - 6th warning (> 5) -> invalidates the attempt ('INVALIDATED_COPY_POLICY', 'COPY_POLICY_LIMIT_EXCEEDED'),
 *   excludes it from AssessmentScores, and evaluates the student's distinct non-overturned copy invalidation count.
 * - 4th distinct non-overturned invalidation (> 3) -> transitions Users.status to 'INTEGRITY_LOCKED' and revokes sessions.
 */
function handleStudentReportRestrictedCopyPhaseB_(payload, context) {
  var authContext = context && context.authContext;
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required.'
    );
  }
  ensureExamIntegrityPhaseASheetsExist_();

  var usr = authContext.user;
  var req = payload && typeof payload === 'object' ? payload : {};
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId, 64);
  var eventClientId = sanitizeSingleLineTextStep7_(
    req.eventId || req.eventClientId,
    120
  );
  var targetRegion = String(req.targetRegion || 'QUESTION_STEM')
    .trim()
    .toUpperCase();
  var domEventType = String(req.domEventType || 'copy')
    .trim()
    .toLowerCase();
  var attemptItemId = sanitizeSingleLineTextStep7_(req.attemptItemId || '', 64);
  var questionId = sanitizeSingleLineTextStep7_(req.questionId || '', 64);
  var detectedAtClientUtc = sanitizeSingleLineTextStep7_(
    req.detectedAtClientUtc || '',
    40
  );

  if (!attemptId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'attemptId is required.',
      { attemptId: 'Missing attemptId.' }
    );
  }
  if (!eventClientId || eventClientId.length < 3) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'A unique eventId (at least 3 characters) is required for idempotent processing.',
      { eventId: 'Missing unique eventId.' }
    );
  }

  var responseData = null;

  withScriptLock_(function () {
    // 1. Recover any interrupted PENDING journal operations first
    recoverPendingExamJournalsInLockPhase6_();

    var attTbl = readSheetTable_('ExamAttempts');
    var exsTbl = readSheetTable_('ExamSets');
    var eieTbl = readSheetTable_('ExamIntegrityEvents');
    var usrTbl = readSheetTable_('Users');

    var attHit = attTbl.byId[attemptId];
    if (!attHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Examination attempt "' + attemptId + '" was not found.'
      );
    }
    var att = attHit.record;

    // Strictly enforce attempt ownership using authenticated session identity
    if (att.student_user_id !== usr.user_id) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: This examination attempt belongs to another student.'
      );
    }

    var nowMs = Date.now();
    var nowIso = new Date(nowMs).toISOString();
    var exHit = exsTbl.byId[att.exam_set_id];
    var exRow = exHit ? exHit.record : null;

    // 2. Check idempotency by (attempt_id, event_client_id) FIRST so retries of an already-processed
    //    6th-strike or 1st..5th-strike event always return the exact committed result!
    for (var ei = 0; ei < eieTbl.records.length; ei++) {
      var ev = eieTbl.records[ei];
      if (ev.attempt_id === attemptId && ev.event_client_id === eventClientId) {
        var freshUserRec = usrTbl.byId[usr.user_id] ? usrTbl.byId[usr.user_id].record : usr;
        var suspMs = att.suspension_until_utc ? Date.parse(att.suspension_until_utc) : NaN;
        var stillSusp =
          att.attempt_status === 'IN_PROGRESS' && !isNaN(suspMs) && suspMs > nowMs;
        responseData = {
          idempotentReplay: true,
          acknowledgedEventId: eventClientId,
          integrityEventId: ev.integrity_event_id,
          attemptId: attemptId,
          attemptStatus: att.attempt_status,
          outcomeAction: ev.outcome_action,
          warningCount: Number(att.copy_warning_count) || Number(ev.warning_count_after) || 0,
          maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || 5,
          suspensionUntilUtc: stillSusp ? att.suspension_until_utc : (ev.suspension_until_utc || ''),
          remainingSuspensionSeconds: stillSusp
            ? Math.max(1, Math.ceil((suspMs - nowMs) / 1000))
            : 0,
          invalidationReasonCode: att.invalidation_reason_code || '',
          accountLocked: Boolean(freshUserRec && freshUserRec.status === 'INTEGRITY_LOCKED'),
          accountStatus: freshUserRec ? freshUserRec.status : 'ACTIVE',
          serverNowUtc: nowIso
        };
        return;
      }
    }

    // 3. If attempt is already invalidated, return current invalidated state without incrementing again
    if (
      att.attempt_status === 'INVALIDATED_COPY_POLICY' ||
      att.attempt_status === 'INVALIDATED'
    ) {
      var curUserRec = usrTbl.byId[usr.user_id] ? usrTbl.byId[usr.user_id].record : usr;
      responseData = {
        idempotentReplay: true,
        acknowledgedEventId: eventClientId,
        attemptId: attemptId,
        attemptStatus: att.attempt_status,
        outcomeAction: 'ATTEMPT_INVALIDATED',
        warningCount: Number(att.copy_warning_count) || 6,
        maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || 5,
        suspensionUntilUtc: '',
        remainingSuspensionSeconds: 0,
        invalidationReasonCode:
          att.invalidation_reason_code || 'COPY_POLICY_LIMIT_EXCEEDED',
        accountLocked: Boolean(curUserRec && curUserRec.status === 'INTEGRITY_LOCKED'),
        accountStatus: curUserRec ? curUserRec.status : 'ACTIVE',
        serverNowUtc: nowIso
      };
      return;
    }

    // 4. Expiry precedence: if the examination deadline expired before or during suspension,
    //    finalize according to the deadline policy and do NOT record a late copy violation!
    var expCheck = checkAndFinalizeExpiredAttemptInLockPhase4_(att, nowMs);
    if (expCheck.expiredNow || expCheck.attemptRow.attempt_status === 'EXPIRED_SUBMITTED') {
      att = expCheck.attemptRow;
      responseData = {
        idempotentReplay: false,
        expiredDuringOrBeforeEvent: true,
        acknowledgedEventId: eventClientId,
        attemptId: attemptId,
        attemptStatus: att.attempt_status,
        outcomeAction: 'EXPIRED_FINALIZED_PRECEDENCE',
        warningCount: Number(att.copy_warning_count) || 0,
        maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || 5,
        suspensionUntilUtc: '',
        remainingSuspensionSeconds: 0,
        accountLocked: false,
        accountStatus: 'ACTIVE',
        serverNowUtc: nowIso
      };
      return;
    }

    if (att.attempt_status !== 'IN_PROGRESS') {
      throw createAppError_(
        'ERR_EXAM_ATTEMPT_NOT_EDITABLE',
        'Attempt is no longer active (status: ' + att.attempt_status + ').'
      );
    }

    // 5. Check applicable snapshotted policy (e.g., Practice mode or EXEMPT_ASSISTIVE_TECH accommodation)
    var policyEnabled =
      att.copy_policy_enabled_snapshot !== undefined &&
      att.copy_policy_enabled_snapshot !== ''
        ? att.copy_policy_enabled_snapshot === true ||
          String(att.copy_policy_enabled_snapshot).toLowerCase() === 'true'
        : Boolean(exRow && exRow.exam_mode !== 'PRACTICE');

    if (!policyEnabled) {
      responseData = {
        idempotentReplay: false,
        copyPolicyEnabled: false,
        acknowledgedEventId: eventClientId,
        attemptId: attemptId,
        attemptStatus: att.attempt_status,
        outcomeAction: 'POLICY_DISABLED_NO_OP',
        warningCount: Number(att.copy_warning_count) || 0,
        maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || 5,
        suspensionUntilUtc: '',
        remainingSuspensionSeconds: 0,
        accountLocked: false,
        accountStatus: 'ACTIVE',
        serverNowUtc: nowIso
      };
      return;
    }

    // 6. Active server suspension guard: while suspension_until_utc is still in the future on the server,
    //    do NOT accumulate additional violations from key-repeat or repeated interaction!
    var activeSuspMs = att.suspension_until_utc ? Date.parse(att.suspension_until_utc) : NaN;
    if (!isNaN(activeSuspMs) && nowMs < activeSuspMs) {
      responseData = {
        idempotentReplay: false,
        ignoredDuringActiveSuspension: true,
        acknowledgedEventId: eventClientId,
        attemptId: attemptId,
        attemptStatus: att.attempt_status,
        outcomeAction: 'IGNORED_DURING_SUSPENSION',
        warningCount: Number(att.copy_warning_count) || 1,
        maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || 5,
        suspensionUntilUtc: att.suspension_until_utc,
        remainingSuspensionSeconds: Math.max(1, Math.ceil((activeSuspMs - nowMs) / 1000)),
        accountLocked: false,
        accountStatus: 'ACTIVE',
        serverNowUtc: nowIso
      };
      return;
    }

    // 7. Verify qualifying protected region vs. exempt interaction
    var targetEval = isQualifyingProtectedCopyTargetRegionPhaseA_({
      domEventType: domEventType,
      targetRegion: targetRegion,
      isStudentAnswerInput: Boolean(req.isStudentAnswerInput),
      isSuspensionDialogOpen: Boolean(req.isSuspensionDialogOpen)
    });
    if (!targetEval.qualifies) {
      responseData = {
        idempotentReplay: false,
        exemptInteraction: true,
        exemptReason: targetEval.reason,
        acknowledgedEventId: eventClientId,
        attemptId: attemptId,
        attemptStatus: att.attempt_status,
        outcomeAction: 'EXEMPT_IGNORED',
        warningCount: Number(att.copy_warning_count) || 0,
        maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || 5,
        suspensionUntilUtc: '',
        remainingSuspensionSeconds: 0,
        accountLocked: false,
        accountStatus: 'ACTIVE',
        serverNowUtc: nowIso
      };
      return;
    }

    // 8. Evaluate threshold (1..5 -> 5s suspension; 6th -> ATTEMPT_INVALIDATED)
    var policySnap = {
      maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || 5,
      suspensionSeconds: Number(att.copy_suspension_seconds_snapshot) || 5,
      maxIntegrityInvalidationsBeforeLock: Number(att.max_invalidations_lock_snapshot) || 3
    };
    var thresholdEval = evaluateCopyViolationThresholdPhaseA_(
      att.copy_warning_count,
      policySnap,
      nowMs
    );

    // 9. Write PENDING journal entry before mutating sheets
    var jrnId = generateEntityId_('exj_');
    insertSheetRecord_(
      'ExamOperationJournal',
      {
        journal_id: jrnId,
        operation_type: 'INTEGRITY_COPY_EVENT',
        idempotency_key: 'integrity_' + attemptId + '_' + eventClientId,
        attempt_id: attemptId,
        exam_set_id: att.exam_set_id,
        student_user_id: usr.user_id,
        target_status: thresholdEval.nextAttemptStatus,
        payload_json: JSON.stringify({
          eventClientId: eventClientId,
          targetRegion: targetEval.targetRegion,
          attemptItemId: attemptItemId,
          questionId: questionId,
          newWarningCount: thresholdEval.newWarningCount,
          shouldInvalidateAttempt: thresholdEval.shouldInvalidateAttempt,
          suspensionUntilUtc: thresholdEval.suspensionUntilUtc,
          detectedAtClientUtc: detectedAtClientUtc || nowIso
        }),
        journal_status: 'PENDING',
        created_at_utc: nowIso,
        committed_at_utc: ''
      },
      { skipLock: true }
    );

    // 10. Update ExamAttempts
    var attPatch = {
      copy_warning_count: thresholdEval.newWarningCount,
      updated_at_utc: nowIso
    };
    if (thresholdEval.shouldInvalidateAttempt) {
      attPatch.attempt_status = 'INVALIDATED_COPY_POLICY';
      attPatch.publication_status = 'WITHHELD';
      attPatch.explanation_status = 'WITHHELD';
      attPatch.suspension_until_utc = '';
      attPatch.invalidation_reason_code = 'COPY_POLICY_LIMIT_EXCEEDED';
      attPatch.invalidated_at_utc = nowIso;
      attPatch.invalidation_overturned = false;
      attPatch.active_lease_token = '';
    } else {
      attPatch.suspension_until_utc = thresholdEval.suspensionUntilUtc;
    }

    att = updateSheetRecordById_(
      'ExamAttempts',
      attemptId,
      attPatch,
      Number(att.version),
      { skipLock: true }
    );

    // 11. If invalidated on the 6th copy attempt, exclude from AssessmentScores and evaluate 4th-invalidation account lock
    var lockOutcome = {
      accountLocked: false,
      accountLockedNow: false,
      lockEval: {
        distinctNonOverturnedCopyInvalidations: 0,
        effectiveActiveStrikes: 0,
        maxIntegrityInvalidationsBeforeLock: policySnap.maxIntegrityInvalidationsBeforeLock
      }
    };

    if (thresholdEval.shouldInvalidateAttempt) {
      if (exRow) {
        syncPublishedExamScoreToAssessmentScoresInLockPhase6_(
          exRow,
          usr.user_id,
          'SYSTEM_INTEGRITY_POLICY'
        );
      }
      lockOutcome = recomputeStudentIntegrityProfileInLockPhaseB_(
        usr.user_id,
        attemptId,
        policySnap.maxIntegrityInvalidationsBeforeLock,
        nowIso
      );
    }

    // 12. Insert ExamIntegrityEvents record (never storing clipboard text or copied strings)
    var eieRec = insertSheetRecord_(
      'ExamIntegrityEvents',
      {
        integrity_event_id: generateEntityId_('eie_'),
        event_client_id: eventClientId,
        attempt_id: attemptId,
        exam_set_id: att.exam_set_id,
        exam_version_id: att.exam_version_id,
        course_id: att.course_id || '',
        student_user_id: usr.user_id,
        policy_version:
          att.copy_policy_version_snapshot ||
          PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.POLICY_VERSION,
        event_type: 'QUALIFYING_COPY_ATTEMPT',
        target_region: targetEval.targetRegion,
        attempt_item_id: attemptItemId,
        question_id: questionId,
        warning_count_after: thresholdEval.newWarningCount,
        outcome_action: thresholdEval.outcomeAction,
        suspension_until_utc: thresholdEval.suspensionUntilUtc,
        triggered_invalidation: thresholdEval.shouldInvalidateAttempt,
        triggered_account_lock: Boolean(lockOutcome.accountLocked),
        review_status: 'UNREVIEWED',
        reviewed_by_user_id: '',
        reviewed_at_utc: '',
        review_reason: '',
        detected_at_client_utc: detectedAtClientUtc || nowIso,
        recorded_at_utc: nowIso
      },
      { skipLock: true }
    );

    // 13. Commit journal entry
    updateSheetRecordById_(
      'ExamOperationJournal',
      jrnId,
      {
        journal_status: 'COMMITTED',
        committed_at_utc: nowIso
      },
      undefined,
      { skipLock: true }
    );

    recordAuditEvent_({
      actorUserId: usr.user_id,
      actorRole: usr.role,
      eventType: thresholdEval.shouldInvalidateAttempt
        ? 'EXAM_ATTEMPT_INVALIDATED_COPY_POLICY'
        : 'EXAM_COPY_WARNING_SUSPENSION_ISSUED',
      targetEntityType: 'ExamAttempt',
      targetEntityId: attemptId,
      summary: {
        integrityEventId: eieRec.integrity_event_id,
        eventClientId: eventClientId,
        targetRegion: targetEval.targetRegion,
        warningCountAfter: thresholdEval.newWarningCount,
        maxCopyWarnings: policySnap.maxCopyWarnings,
        outcomeAction: thresholdEval.outcomeAction,
        suspensionUntilUtc: thresholdEval.suspensionUntilUtc,
        triggeredInvalidation: thresholdEval.shouldInvalidateAttempt,
        triggeredAccountLock: Boolean(lockOutcome.accountLocked)
      }
    });

    responseData = {
      idempotentReplay: false,
      acknowledgedEventId: eventClientId,
      integrityEventId: eieRec.integrity_event_id,
      attemptId: attemptId,
      attemptStatus: att.attempt_status,
      outcomeAction: thresholdEval.outcomeAction,
      warningCount: thresholdEval.newWarningCount,
      maxCopyWarnings: policySnap.maxCopyWarnings,
      counterLabel: thresholdEval.counterLabel,
      suspensionSeconds: thresholdEval.suspensionSeconds,
      suspensionUntilUtc: thresholdEval.suspensionUntilUtc,
      remainingSuspensionSeconds: thresholdEval.suspensionSeconds,
      invalidationReasonCode: thresholdEval.invalidationReasonCode,
      invalidationTitle: thresholdEval.shouldInvalidateAttempt
        ? 'Examination attempt invalidated'
        : '',
      invalidationMessage: thresholdEval.shouldInvalidateAttempt
        ? 'This attempt was invalidated after exceeding the permitted number of detected copy attempts. Your saved answers have been retained for administrator review.'
        : '',
      accountLocked: Boolean(lockOutcome.accountLocked),
      accountStatus: lockOutcome.accountLocked ? 'INTEGRITY_LOCKED' : 'ACTIVE',
      lockTitle: lockOutcome.accountLocked ? 'Account temporarily locked' : '',
      lockMessage: lockOutcome.accountLocked
        ? 'Your account has been locked after repeated examination invalidations. Please contact Pattanabhumi Biology for review.'
        : '',
      distinctNonOverturnedInvalidations:
        lockOutcome.lockEval.distinctNonOverturnedCopyInvalidations,
      effectiveActiveStrikes: lockOutcome.lockEval.effectiveActiveStrikes,
      serverNowUtc: nowIso
    };
  });

  return responseData;
}

/**
 * Restricted support status flow ('auth.getIntegrityLockStatus') allowing a student whose
 * account was locked after 4 copy-policy invalidations to verify their identity (via username
 * + password) and view ONLY the minimal account-status/support notice without exposing any
 * course, score, or payment data.
 * Unauthenticated wrong-username or wrong-password requests return ERR_INVALID_CREDENTIALS
 * so username existence or lock state is never leaked without valid credentials.
 */
function handleGetIntegrityLockStatusPhaseB_(payload, context) {
  ensureExamIntegrityPhaseASheetsExist_();
  var req = payload && typeof payload === 'object' ? payload : {};
  var normalized = normalizeAndValidateUsername_(req.username);
  var rawPassword = typeof req.password === 'string' ? req.password : '';

  var usersTable = readSheetTable_('Users');
  var existingUser = findUserByUsernameLower_(normalized.usernameLower, usersTable);
  var userExists = Boolean(existingUser);

  assertLoginNotRateLimited_(normalized.usernameLower, userExists);
  if (!existingUser) {
    performDummyPasswordWork_(rawPassword);
    recordFailedLoginAttempt_(normalized.usernameLower, false);
    throw createAppError_(
      PB_ERROR_CODES_.ERR_INVALID_CREDENTIALS,
      'Invalid username or password.'
    );
  }

  var storedHashStr = String(existingUser.password_hash || '').trim();
  if (!verifyPassword_(rawPassword, storedHashStr)) {
    recordFailedLoginAttempt_(normalized.usernameLower, true);
    throw createAppError_(
      PB_ERROR_CODES_.ERR_INVALID_CREDENTIALS,
      'Invalid username or password.'
    );
  }

  var sipTbl = readSheetTable_('StudentIntegrityProfiles');
  var profile = null;
  for (var i = 0; i < sipTbl.records.length; i++) {
    if (sipTbl.records[i].student_user_id === existingUser.user_id) {
      profile = sipTbl.records[i];
      break;
    }
  }

  return {
    accountStatus: existingUser.status,
    isIntegrityLocked: existingUser.status === 'INTEGRITY_LOCKED',
    lockTitle:
      existingUser.status === 'INTEGRITY_LOCKED'
        ? 'Account temporarily locked'
        : 'Account status',
    lockMessage:
      existingUser.status === 'INTEGRITY_LOCKED'
        ? 'Your account has been locked after repeated examination invalidations. Please contact Pattanabhumi Biology for review.'
        : 'Your account status is ' + existingUser.status + '.',
    lockedAtUtc: profile ? profile.locked_at_utc || '' : '',
    lockedAtBangkok:
      profile && profile.locked_at_utc
        ? formatBangkokTimestamp_(profile.locked_at_utc)
        : '',
    triggerAttemptId: profile ? profile.lock_trigger_attempt_id || '' : '',
    distinctCopyInvalidationsCount: profile
      ? Number(profile.distinct_copy_invalidations_total) || 0
      : 0,
    effectiveActiveStrikes: profile
      ? Number(profile.effective_active_strikes) || 0
      : 0,
    supportContactEmail: 'biology@pattanabhumi.ac.th',
    appealInstructions:
      'Please contact Pattanabhumi Biology Support and reference your username and Triggering Attempt ID for administrator review.'
  };
}




// ============================================================================
// COPY-RESTRICTION & EXAMINATION-INTEGRITY POLICY EXTENSION -- PHASE D:
// ADMINISTRATOR INTEGRITY DASHBOARD, INCIDENT REVIEW, INVALIDATION OVERTURN,
// REPLACEMENT ATTEMPT GRANT & ACCOUNT UNLOCK WITH STRIKE BASELINE RESET
// ============================================================================

/**
 * Lists all examination integrity events, copy-policy invalidated attempts, student
 * integrity profiles, and administrator review history ('admin.integrity.list').
 * Labels records accurately as detected/reported browser copy events pending review.
 */
function handleAdminListIntegrityDashboardPhaseD_(payload, context) {
  assertStep7AdminRole_(context && context.authContext);
  ensureExamIntegrityPhaseASheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var filterStudentUserId = sanitizeSingleLineTextStep7_(req.studentUserId || '', 64);
  var filterExamSetId = sanitizeSingleLineTextStep7_(req.examSetId || '', 64);
  var filterReviewStatus = String(req.reviewStatus || 'ALL').trim().toUpperCase();

  var eieTbl = readSheetTable_('ExamIntegrityEvents');
  var attTbl = readSheetTable_('ExamAttempts');
  var exsTbl = readSheetTable_('ExamSets');
  var sipTbl = readSheetTable_('StudentIntegrityProfiles');
  var eirTbl = readSheetTable_('ExamIntegrityReviews');
  var usrTbl = readSheetTable_('Users');

  var totalEventsCount = 0;
  var unreviewedEventsCount = 0;
  var activeCopyInvalidationsCount = 0;
  var overturnedInvalidationsCount = 0;
  var integrityLockedAccountsCount = 0;

  var eventDtos = [];
  for (var i = eieTbl.records.length - 1; i >= 0; i--) {
    var ev = eieTbl.records[i];
    totalEventsCount += 1;
    if (ev.review_status === 'UNREVIEWED') unreviewedEventsCount += 1;

    if (filterStudentUserId && ev.student_user_id !== filterStudentUserId) continue;
    if (filterExamSetId && ev.exam_set_id !== filterExamSetId) continue;
    if (filterReviewStatus !== 'ALL' && ev.review_status !== filterReviewStatus) continue;

    var uHit = usrTbl.byId[ev.student_user_id];
    var uRec = uHit ? uHit.record : null;
    var exHit = exsTbl.byId[ev.exam_set_id];
    var exRec = exHit ? exHit.record : null;
    var attHit = attTbl.byId[ev.attempt_id];
    var attRec = attHit ? attHit.record : null;

    eventDtos.push({
      integrityEventId: ev.integrity_event_id,
      eventClientId: ev.event_client_id,
      attemptId: ev.attempt_id,
      attemptNumber: attRec ? Number(attRec.attempt_number) || 1 : 1,
      attemptStatus: attRec ? attRec.attempt_status : '',
      examSetId: ev.exam_set_id,
      examCode: exRec ? exRec.exam_code : '',
      examTitle: exRec ? exRec.title : '',
      studentUserId: ev.student_user_id,
      studentUsername: uRec ? uRec.username_display || uRec.username_lower : '',
      studentFullName: uRec ? uRec.full_name || '' : '',
      policyVersion: ev.policy_version,
      targetRegion: ev.target_region,
      attemptItemId: ev.attempt_item_id || '',
      questionId: ev.question_id || '',
      warningCountAfter: Number(ev.warning_count_after) || 0,
      outcomeAction: ev.outcome_action,
      suspensionUntilUtc: ev.suspension_until_utc || '',
      triggeredInvalidation: Boolean(ev.triggered_invalidation),
      triggeredAccountLock: Boolean(ev.triggered_account_lock),
      reviewStatus: ev.review_status || 'UNREVIEWED',
      reviewedByUserId: ev.reviewed_by_user_id || '',
      reviewedAtUtc: ev.reviewed_at_utc || '',
      reviewedAtBangkok: ev.reviewed_at_utc ? formatBangkokTimestamp_(ev.reviewed_at_utc) : '',
      reviewReason: ev.review_reason || '',
      detectedAtClientUtc: ev.detected_at_client_utc || '',
      recordedAtUtc: ev.recorded_at_utc || '',
      recordedAtBangkok: ev.recorded_at_utc ? formatBangkokTimestamp_(ev.recorded_at_utc) : '',
      version: Number(ev.version) || 1
    });
  }

  var invalidatedAttempts = [];
  for (var a = attTbl.records.length - 1; a >= 0; a--) {
    var att = attTbl.records[a];
    var isCopyInv =
      att.attempt_status === 'INVALIDATED_COPY_POLICY' ||
      (att.attempt_status === 'INVALIDATED' &&
        att.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED');
    if (!isCopyInv) continue;

    var isOverturned =
      att.invalidation_overturned === true ||
      String(att.invalidation_overturned).toLowerCase() === 'true';
    if (isOverturned) {
      overturnedInvalidationsCount += 1;
    } else {
      activeCopyInvalidationsCount += 1;
    }

    if (filterStudentUserId && att.student_user_id !== filterStudentUserId) continue;
    if (filterExamSetId && att.exam_set_id !== filterExamSetId) continue;

    var stuHit = usrTbl.byId[att.student_user_id];
    var stuRec = stuHit ? stuHit.record : null;
    var exSetHit = exsTbl.byId[att.exam_set_id];
    var exSetRec = exSetHit ? exSetHit.record : null;

    invalidatedAttempts.push({
      attemptId: att.attempt_id,
      attemptNumber: Number(att.attempt_number) || 1,
      attemptStatus: att.attempt_status,
      examSetId: att.exam_set_id,
      examCode: exSetRec ? exSetRec.exam_code : '',
      examTitle: exSetRec ? exSetRec.title : '',
      courseId: att.course_id || (exSetRec ? exSetRec.course_id : ''),
      studentUserId: att.student_user_id,
      studentUsername: stuRec ? stuRec.username_display || stuRec.username_lower : '',
      studentFullName: stuRec ? stuRec.full_name || '' : '',
      policyVersion: att.copy_policy_version_snapshot || 'pb-exam-integrity-v1',
      copyWarningCount: Number(att.copy_warning_count) || 6,
      maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || 5,
      invalidationReasonCode: att.invalidation_reason_code || 'COPY_POLICY_LIMIT_EXCEEDED',
      invalidatedAtUtc: att.invalidated_at_utc || '',
      invalidatedAtBangkok: att.invalidated_at_utc
        ? formatBangkokTimestamp_(att.invalidated_at_utc)
        : '',
      invalidationOverturned: isOverturned,
      invalidationOverturnedAtUtc: att.invalidation_overturned_at_utc || '',
      invalidationOverturnedAtBangkok: att.invalidation_overturned_at_utc
        ? formatBangkokTimestamp_(att.invalidation_overturned_at_utc)
        : '',
      invalidationOverturnedByUserId: att.invalidation_overturned_by_user_id || '',
      invalidationReviewReason: att.invalidation_review_reason || '',
      version: Number(att.version) || 1
    });
  }

  for (var uIdx = 0; uIdx < usrTbl.records.length; uIdx++) {
    if (usrTbl.records[uIdx].status === 'INTEGRITY_LOCKED') {
      integrityLockedAccountsCount += 1;
    }
  }

  var studentProfiles = [];
  for (var s = 0; s < sipTbl.records.length; s++) {
    var sp = sipTbl.records[s];
    if (filterStudentUserId && sp.student_user_id !== filterStudentUserId) continue;
    var usrHit = usrTbl.byId[sp.student_user_id];
    var usrRec = usrHit ? usrHit.record : null;

    studentProfiles.push({
      profileId: sp.profile_id,
      studentUserId: sp.student_user_id,
      studentUsername: usrRec ? usrRec.username_display || usrRec.username_lower : '',
      studentFullName: usrRec ? usrRec.full_name || '' : '',
      accountStatus: usrRec ? usrRec.status : 'UNKNOWN',
      accountVersion: usrRec ? Number(usrRec.version) || 1 : 1,
      integrityStatus: sp.integrity_status || 'CLEAR',
      distinctCopyInvalidationsTotal: Number(sp.distinct_copy_invalidations_total) || 0,
      overturnedInvalidationsTotal: Number(sp.overturned_invalidations_total) || 0,
      effectiveStrikeBaseline: Number(sp.effective_strike_baseline) || 0,
      effectiveActiveStrikes: Number(sp.effective_active_strikes) || 0,
      maxInvalidationsBeforeLock:
        PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.MAX_INTEGRITY_INVALIDATIONS_BEFORE_LOCK,
      lockedAtUtc: sp.locked_at_utc || '',
      lockedAtBangkok: sp.locked_at_utc ? formatBangkokTimestamp_(sp.locked_at_utc) : '',
      lockTriggerAttemptId: sp.lock_trigger_attempt_id || '',
      lockReasonCode: sp.lock_reason_code || '',
      unlockedAtUtc: sp.unlocked_at_utc || '',
      unlockedAtBangkok: sp.unlocked_at_utc ? formatBangkokTimestamp_(sp.unlocked_at_utc) : '',
      unlockedByUserId: sp.unlocked_by_user_id || '',
      unlockReason: sp.unlock_reason || '',
      version: Number(sp.version) || 1
    });
  }

  var reviewsHistory = [];
  for (var r = eirTbl.records.length - 1; r >= 0; r--) {
    var rv = eirTbl.records[r];
    if (filterStudentUserId && rv.student_user_id !== filterStudentUserId) continue;
    var ruHit = usrTbl.byId[rv.student_user_id];
    var ruRec = ruHit ? ruHit.record : null;
    reviewsHistory.push({
      reviewId: rv.review_id,
      targetType: rv.target_type,
      targetId: rv.target_id,
      studentUserId: rv.student_user_id,
      studentUsername: ruRec ? ruRec.username_display || ruRec.username_lower : '',
      studentFullName: ruRec ? ruRec.full_name || '' : '',
      attemptId: rv.attempt_id || '',
      examSetId: rv.exam_set_id || '',
      actionTaken: rv.action_taken,
      newStrikeBaselineCount: Number(rv.new_strike_baseline_count) || 0,
      reason: rv.reason,
      adminUserId: rv.admin_user_id,
      createdAtUtc: rv.created_at_utc,
      createdAtBangkok: formatBangkokTimestamp_(rv.created_at_utc),
      version: Number(rv.version) || 1
    });
  }

  return {
    disclaimerNotice:
      'Records below represent detected/reported browser copy events within protected question areas, not indisputable proof of academic misconduct. All automated invalidations and account locks remain subject to human administrator review and reversal.',
    summary: {
      totalEventsCount: totalEventsCount,
      unreviewedEventsCount: unreviewedEventsCount,
      activeCopyInvalidationsCount: activeCopyInvalidationsCount,
      overturnedInvalidationsCount: overturnedInvalidationsCount,
      integrityLockedAccountsCount: integrityLockedAccountsCount
    },
    events: eventDtos,
    invalidatedAttempts: invalidatedAttempts,
    studentProfiles: studentProfiles,
    reviewsHistory: reviewsHistory
  };
}

/**
 * Helper to grant +extraAttemptsToAdd on ExamAssignments inside LockService when an administrator
 * grants a replacement attempt during integrity review.
 */
function grantReplacementAttemptInLockPhaseD_(
  examSetId,
  studentUserId,
  extraAttemptsToAdd,
  reason,
  adminUserId,
  nowIso
) {
  var exsTbl = readSheetTable_('ExamSets');
  var exaTbl = readSheetTable_('ExamAssignments');
  var exHit = exsTbl.byId[examSetId];
  var courseId = exHit && exHit.record ? exHit.record.course_id || '' : '';
  var addCount = Math.max(1, Math.min(20, parseInt(extraAttemptsToAdd, 10) || 1));

  var existingStudentAsg = null;
  for (var i = 0; i < exaTbl.records.length; i++) {
    var r = exaTbl.records[i];
    if (
      r.exam_set_id === examSetId &&
      r.target_type === 'STUDENT' &&
      r.student_user_id === studentUserId
    ) {
      existingStudentAsg = r;
      break;
    }
  }

  if (!existingStudentAsg) {
    return insertSheetRecord_(
      'ExamAssignments',
      {
        assignment_id: generateEntityId_('exa_'),
        exam_set_id: examSetId,
        course_id: courseId,
        target_type: 'STUDENT',
        student_user_id: studentUserId,
        assignment_status: 'ASSIGNED',
        open_at_override_utc: '',
        override_deadline_utc: '',
        extra_time_minutes: 0,
        extra_attempts_granted: addCount,
        copy_policy_accommodation_mode: 'STANDARD',
        custom_max_copy_warnings: 0,
        accommodation_reason: 'Replacement attempt granted (' + reason + ')',
        assigned_by_user_id: adminUserId,
        created_at_utc: nowIso,
        updated_at_utc: nowIso
      },
      { skipLock: true }
    );
  } else {
    var nextExtra = (Number(existingStudentAsg.extra_attempts_granted) || 0) + addCount;
    return updateSheetRecordById_(
      'ExamAssignments',
      existingStudentAsg.assignment_id,
      {
        assignment_status: 'ASSIGNED',
        extra_attempts_granted: nextExtra,
        accommodation_reason: 'Replacement attempt granted (' + reason + ')',
        assigned_by_user_id: adminUserId,
        updated_at_utc: nowIso
      },
      Number(existingStudentAsg.version),
      { skipLock: true }
    );
  }
}

/**
 * Executes an audited administrator examination-integrity review or appeal action
 * ('admin.integrity.review'):
 * - CONFIRM_INCIDENT: Marks a detected event or attempt's events CONFIRMED.
 * - MARK_EVENT_ERRONEOUS: Marks a specific ExamIntegrityEvents row ERRONEOUS_OVERTURNED,
 *   decrements copy_warning_count on the attempt, and overturns invalidation if warnings drop <= maxCopyWarnings.
 * - OVERTURN_INVALIDATION: Marks invalidation_overturned = true on an INVALIDATED_COPY_POLICY attempt
 *   without deleting history or automatically reactivating expired exams/changing published grades,
 *   updates the student's effective strike count in StudentIntegrityProfiles, and optionally grants
 *   a replacement attempt.
 * - GRANT_REPLACEMENT_ATTEMPT: Grants +1 replacement attempt on ExamAssignments for the student.
 * - UNLOCK_ACCOUNT_SET_BASELINE: Unlocks a student account from 'INTEGRITY_LOCKED' -> 'ACTIVE' and
 *   sets a new effective_strike_baseline in StudentIntegrityProfiles so unchanged historical
 *   invalidations (e.g., 4) do not immediately relock the account.
 */
function handleAdminReviewIntegrityActionPhaseD_(payload, context) {
  var adminUser = assertStep7AdminRole_(context && context.authContext);
  ensureExamIntegrityPhaseASheetsExist_();

  var req = payload && typeof payload === 'object' ? payload : {};
  var actionTaken = String(req.actionTaken || req.action || '')
    .trim()
    .toUpperCase();
  var reason = sanitizeSingleLineTextStep7_(req.reason, 400);
  var integrityEventId = sanitizeSingleLineTextStep7_(req.integrityEventId || '', 64);
  var attemptId = sanitizeSingleLineTextStep7_(req.attemptId || '', 64);
  var studentUserId = sanitizeSingleLineTextStep7_(req.studentUserId || '', 64);
  var examSetId = sanitizeSingleLineTextStep7_(req.examSetId || '', 64);
  var expectedVersion =
    req.expectedVersion !== undefined &&
    req.expectedVersion !== null &&
    req.expectedVersion !== ''
      ? Number(req.expectedVersion)
      : undefined;

  var validActions = {
    CONFIRM_INCIDENT: true,
    MARK_EVENT_ERRONEOUS: true,
    OVERTURN_INVALIDATION: true,
    GRANT_REPLACEMENT_ATTEMPT: true,
    UNLOCK_ACCOUNT_SET_BASELINE: true
  };
  if (!validActions[actionTaken]) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'actionTaken must be CONFIRM_INCIDENT, MARK_EVENT_ERRONEOUS, OVERTURN_INVALIDATION, GRANT_REPLACEMENT_ATTEMPT, or UNLOCK_ACCOUNT_SET_BASELINE.',
      { actionTaken: 'Invalid review action.' }
    );
  }
  if (!reason || reason.length < 5) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'A descriptive administrator review reason (at least 5 characters) is mandatory for all integrity review and override actions.',
      { reason: 'Review reason is required (min 5 characters).' }
    );
  }

  var actionResultSummary = null;

  withScriptLock_(function () {
    recoverPendingExamJournalsInLockPhase6_();

    var eieTbl = readSheetTable_('ExamIntegrityEvents');
    var attTbl = readSheetTable_('ExamAttempts');
    var sipTbl = readSheetTable_('StudentIntegrityProfiles');
    var usrTbl = readSheetTable_('Users');
    var nowIso = nowUtcIso_();

    // 1. CONFIRM_INCIDENT
    if (actionTaken === 'CONFIRM_INCIDENT') {
      if (!integrityEventId && !attemptId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'integrityEventId or attemptId is required for CONFIRM_INCIDENT.'
        );
      }
      var confirmedEvents = [];
      for (var i = 0; i < eieTbl.records.length; i++) {
        var ev = eieTbl.records[i];
        if (
          (integrityEventId && ev.integrity_event_id === integrityEventId) ||
          (!integrityEventId && attemptId && ev.attempt_id === attemptId)
        ) {
          var verToCheck =
            integrityEventId && expectedVersion !== undefined
              ? expectedVersion
              : Number(ev.version);
          var updatedEv = updateSheetRecordById_(
            'ExamIntegrityEvents',
            ev.integrity_event_id,
            {
              review_status: 'CONFIRMED',
              reviewed_by_user_id: adminUser.user_id,
              reviewed_at_utc: nowIso,
              review_reason: reason
            },
            verToCheck,
            { skipLock: true }
          );
          confirmedEvents.push(updatedEv);
          studentUserId = studentUserId || ev.student_user_id;
          attemptId = attemptId || ev.attempt_id;
          examSetId = examSetId || ev.exam_set_id;
        }
      }
      if (confirmedEvents.length === 0) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Target integrity event was not found.'
        );
      }

      var revRec1 = insertSheetRecord_(
        'ExamIntegrityReviews',
        {
          review_id: generateEntityId_('eir_'),
          target_type: 'INTEGRITY_EVENT',
          target_id: integrityEventId || attemptId,
          student_user_id: studentUserId,
          attempt_id: attemptId,
          exam_set_id: examSetId,
          action_taken: 'CONFIRM_INCIDENT',
          previous_state_json: JSON.stringify({ reviewStatus: 'UNREVIEWED' }),
          new_state_json: JSON.stringify({
            reviewStatus: 'CONFIRMED',
            confirmedCount: confirmedEvents.length
          }),
          new_strike_baseline_count: 0,
          reason: reason,
          admin_user_id: adminUser.user_id,
          created_at_utc: nowIso
        },
        { skipLock: true }
      );
      actionResultSummary = {
        actionTaken: 'CONFIRM_INCIDENT',
        reviewId: revRec1.review_id,
        confirmedCount: confirmedEvents.length
      };
    }

    // 2. MARK_EVENT_ERRONEOUS
    else if (actionTaken === 'MARK_EVENT_ERRONEOUS') {
      if (!integrityEventId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'integrityEventId is required for MARK_EVENT_ERRONEOUS.'
        );
      }
      var evHit = eieTbl.byId[integrityEventId];
      if (!evHit) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Integrity event "' + integrityEventId + '" was not found.'
        );
      }
      var targetEv = evHit.record;
      var prevReviewStatus = targetEv.review_status;
      var evVer = expectedVersion !== undefined ? expectedVersion : Number(targetEv.version);

      updateSheetRecordById_(
        'ExamIntegrityEvents',
        integrityEventId,
        {
          review_status: 'ERRONEOUS_OVERTURNED',
          reviewed_by_user_id: adminUser.user_id,
          reviewed_at_utc: nowIso,
          review_reason: reason
        },
        evVer,
        { skipLock: true }
      );

      studentUserId = targetEv.student_user_id;
      attemptId = targetEv.attempt_id;
      examSetId = targetEv.exam_set_id;

      var attHit2 = attTbl.byId[attemptId];
      var updatedWarningCount = 0;
      var autoOverturnedAttempt = false;
      if (attHit2 && attHit2.record) {
        var curAtt2 = attHit2.record;
        var prevWarn = Number(curAtt2.copy_warning_count) || 0;
        updatedWarningCount =
          prevReviewStatus !== 'ERRONEOUS_OVERTURNED'
            ? Math.max(0, prevWarn - 1)
            : prevWarn;
        var maxWarnSnap = Number(curAtt2.max_copy_warnings_snapshot) || 5;
        var attPatch2 = {
          copy_warning_count: updatedWarningCount,
          suspension_until_utc: '',
          updated_at_utc: nowIso
        };
        if (
          curAtt2.attempt_status === 'INVALIDATED_COPY_POLICY' &&
          updatedWarningCount <= maxWarnSnap &&
          !curAtt2.invalidation_overturned
        ) {
          attPatch2.invalidation_overturned = true;
          attPatch2.invalidation_overturned_at_utc = nowIso;
          attPatch2.invalidation_overturned_by_user_id = adminUser.user_id;
          attPatch2.invalidation_review_reason = reason;
          autoOverturnedAttempt = true;
        }
        updateSheetRecordById_(
          'ExamAttempts',
          attemptId,
          attPatch2,
          Number(curAtt2.version),
          { skipLock: true }
        );
      }

      var profileSync2 = recomputeStudentIntegrityProfileInLockPhaseB_(
        studentUserId,
        attemptId,
        3,
        nowIso
      );

      var revRec2 = insertSheetRecord_(
        'ExamIntegrityReviews',
        {
          review_id: generateEntityId_('eir_'),
          target_type: 'INTEGRITY_EVENT',
          target_id: integrityEventId,
          student_user_id: studentUserId,
          attempt_id: attemptId,
          exam_set_id: examSetId,
          action_taken: 'MARK_EVENT_ERRONEOUS',
          previous_state_json: JSON.stringify({ reviewStatus: prevReviewStatus }),
          new_state_json: JSON.stringify({
            reviewStatus: 'ERRONEOUS_OVERTURNED',
            updatedWarningCount: updatedWarningCount,
            autoOverturnedAttempt: autoOverturnedAttempt
          }),
          new_strike_baseline_count: Number(profileSync2.profile.effective_strike_baseline) || 0,
          reason: reason,
          admin_user_id: adminUser.user_id,
          created_at_utc: nowIso
        },
        { skipLock: true }
      );
      actionResultSummary = {
        actionTaken: 'MARK_EVENT_ERRONEOUS',
        reviewId: revRec2.review_id,
        integrityEventId: integrityEventId,
        updatedWarningCount: updatedWarningCount,
        autoOverturnedAttempt: autoOverturnedAttempt,
        effectiveActiveStrikes: profileSync2.lockEval.effectiveActiveStrikes
      };
    }

    // 3. OVERTURN_INVALIDATION
    else if (actionTaken === 'OVERTURN_INVALIDATION') {
      if (!attemptId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'attemptId is required for OVERTURN_INVALIDATION.'
        );
      }
      var attHit3 = attTbl.byId[attemptId];
      if (!attHit3) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Examination attempt "' + attemptId + '" was not found.'
        );
      }
      var targetAtt = attHit3.record;
      var isCopyInv3 =
        targetAtt.attempt_status === 'INVALIDATED_COPY_POLICY' ||
        (targetAtt.attempt_status === 'INVALIDATED' &&
          targetAtt.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED');
      if (!isCopyInv3) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Attempt "' +
            attemptId +
            '" is not invalidated under the Copy-Restriction Policy (status: ' +
            targetAtt.attempt_status +
            ').'
        );
      }

      var attVer3 = expectedVersion !== undefined ? expectedVersion : Number(targetAtt.version);
      studentUserId = targetAtt.student_user_id;
      examSetId = targetAtt.exam_set_id;

      // Preserve attempt_status and historical rows while setting invalidation_overturned = true.
      // Never automatically reactivate expired exams or alter published grades!
      updateSheetRecordById_(
        'ExamAttempts',
        attemptId,
        {
          invalidation_overturned: true,
          invalidation_overturned_at_utc: nowIso,
          invalidation_overturned_by_user_id: adminUser.user_id,
          invalidation_review_reason: reason,
          updated_at_utc: nowIso
        },
        attVer3,
        { skipLock: true }
      );

      for (var ei3 = 0; ei3 < eieTbl.records.length; ei3++) {
        var ev3 = eieTbl.records[ei3];
        if (ev3.attempt_id === attemptId && ev3.review_status !== 'ERRONEOUS_OVERTURNED') {
          updateSheetRecordById_(
            'ExamIntegrityEvents',
            ev3.integrity_event_id,
            {
              review_status: 'ERRONEOUS_OVERTURNED',
              reviewed_by_user_id: adminUser.user_id,
              reviewed_at_utc: nowIso,
              review_reason: 'Overturned with attempt invalidation: ' + reason
            },
            Number(ev3.version),
            { skipLock: true }
          );
        }
      }

      var profileSync3 = recomputeStudentIntegrityProfileInLockPhaseB_(
        studentUserId,
        attemptId,
        Number(targetAtt.max_invalidations_lock_snapshot) || 3,
        nowIso
      );

      var grantedReplacement = false;
      if (Boolean(req.grantReplacementAttempt)) {
        grantReplacementAttemptInLockPhaseD_(
          examSetId,
          studentUserId,
          1,
          reason,
          adminUser.user_id,
          nowIso
        );
        grantedReplacement = true;
      }

      var revRec3 = insertSheetRecord_(
        'ExamIntegrityReviews',
        {
          review_id: generateEntityId_('eir_'),
          target_type: 'ATTEMPT_INVALIDATION',
          target_id: attemptId,
          student_user_id: studentUserId,
          attempt_id: attemptId,
          exam_set_id: examSetId,
          action_taken: 'OVERTURN_INVALIDATION',
          previous_state_json: JSON.stringify({
            invalidationOverturned: Boolean(targetAtt.invalidation_overturned)
          }),
          new_state_json: JSON.stringify({
            invalidationOverturned: true,
            distinctNonOverturnedTotal:
              profileSync3.lockEval.distinctNonOverturnedCopyInvalidations,
            effectiveActiveStrikes: profileSync3.lockEval.effectiveActiveStrikes,
            grantedReplacementAttempt: grantedReplacement
          }),
          new_strike_baseline_count: Number(profileSync3.profile.effective_strike_baseline) || 0,
          reason: reason,
          admin_user_id: adminUser.user_id,
          created_at_utc: nowIso
        },
        { skipLock: true }
      );

      actionResultSummary = {
        actionTaken: 'OVERTURN_INVALIDATION',
        reviewId: revRec3.review_id,
        attemptId: attemptId,
        studentUserId: studentUserId,
        distinctNonOverturnedInvalidations:
          profileSync3.lockEval.distinctNonOverturnedCopyInvalidations,
        effectiveActiveStrikes: profileSync3.lockEval.effectiveActiveStrikes,
        grantedReplacementAttempt: grantedReplacement
      };
    }

    // 4. GRANT_REPLACEMENT_ATTEMPT
    else if (actionTaken === 'GRANT_REPLACEMENT_ATTEMPT') {
      if (attemptId && (!examSetId || !studentUserId)) {
        var attHit4 = attTbl.byId[attemptId];
        if (attHit4 && attHit4.record) {
          examSetId = examSetId || attHit4.record.exam_set_id;
          studentUserId = studentUserId || attHit4.record.student_user_id;
        }
      }
      if (!examSetId || !studentUserId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'examSetId and studentUserId (or attemptId) are required for GRANT_REPLACEMENT_ATTEMPT.'
        );
      }

      var savedAsg = grantReplacementAttemptInLockPhaseD_(
        examSetId,
        studentUserId,
        req.extraAttemptsToAdd || 1,
        reason,
        adminUser.user_id,
        nowIso
      );

      var revRec4 = insertSheetRecord_(
        'ExamIntegrityReviews',
        {
          review_id: generateEntityId_('eir_'),
          target_type: 'ATTEMPT_INVALIDATION',
          target_id: attemptId || savedAsg.assignment_id,
          student_user_id: studentUserId,
          attempt_id: attemptId || '',
          exam_set_id: examSetId,
          action_taken: 'GRANT_REPLACEMENT_ATTEMPT',
          previous_state_json: '{}',
          new_state_json: JSON.stringify({
            extraAttemptsGranted: Number(savedAsg.extra_attempts_granted) || 1
          }),
          new_strike_baseline_count: 0,
          reason: reason,
          admin_user_id: adminUser.user_id,
          created_at_utc: nowIso
        },
        { skipLock: true }
      );

      actionResultSummary = {
        actionTaken: 'GRANT_REPLACEMENT_ATTEMPT',
        reviewId: revRec4.review_id,
        assignmentId: savedAsg.assignment_id,
        examSetId: examSetId,
        studentUserId: studentUserId,
        extraAttemptsGranted: Number(savedAsg.extra_attempts_granted) || 1
      };
    }

    // 5. UNLOCK_ACCOUNT_SET_BASELINE
    else if (actionTaken === 'UNLOCK_ACCOUNT_SET_BASELINE') {
      if (!studentUserId && attemptId) {
        var attHit5 = attTbl.byId[attemptId];
        if (attHit5 && attHit5.record) {
          studentUserId = attHit5.record.student_user_id;
        }
      }
      if (!studentUserId) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'studentUserId is required for UNLOCK_ACCOUNT_SET_BASELINE.'
        );
      }
      var usrHit5 = usrTbl.byId[studentUserId];
      if (!usrHit5) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_NOT_FOUND,
          'Student user "' + studentUserId + '" was not found.'
        );
      }
      var targetUsr = usrHit5.record;
      var usrVer5 = expectedVersion !== undefined ? expectedVersion : Number(targetUsr.version);

      // Count current distinct non-overturned copy-policy invalidations for this student
      var nonOverturnedIds = {};
      var overturnedIds = {};
      for (var k = 0; k < attTbl.records.length; k++) {
        var aRow = attTbl.records[k];
        if (aRow.student_user_id !== studentUserId) continue;
        var isCopyInv5 =
          aRow.attempt_status === 'INVALIDATED_COPY_POLICY' ||
          (aRow.attempt_status === 'INVALIDATED' &&
            aRow.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED');
        if (isCopyInv5 && aRow.copy_policy_enabled_snapshot !== false) {
          var isOv =
            aRow.invalidation_overturned === true ||
            String(aRow.invalidation_overturned).toLowerCase() === 'true';
          if (isOv) {
            overturnedIds[aRow.attempt_id] = true;
          } else {
            nonOverturnedIds[aRow.attempt_id] = true;
          }
        }
      }
      var totalNonOverturned5 = Object.keys(nonOverturnedIds).length;
      var totalOverturned5 = Object.keys(overturnedIds).length;
      var maxBeforeLock5 =
        PB_EXAM_INTEGRITY_POLICY_DEFAULTS_.MAX_INTEGRITY_INVALIDATIONS_BEFORE_LOCK;

      // Default newStrikeBaseline to totalNonOverturned5 (e.g. 4 -> effectiveActiveStrikes = 0)
      var newStrikeBaseline =
        req.newStrikeBaseline !== undefined &&
        req.newStrikeBaseline !== null &&
        req.newStrikeBaseline !== ''
          ? Math.max(0, Math.floor(Number(req.newStrikeBaseline)))
          : totalNonOverturned5;

      var postUnlockEval = evaluateAccountIntegrityLockThresholdPhaseA_(
        totalNonOverturned5,
        newStrikeBaseline,
        maxBeforeLock5
      );
      if (postUnlockEval.shouldLockAccount) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'The specified newStrikeBaseline (' +
            newStrikeBaseline +
            ') leaves effectiveActiveStrikes at ' +
            postUnlockEval.effectiveActiveStrikes +
            ' (> ' +
            maxBeforeLock5 +
            '), which would immediately relock the account. Set newStrikeBaseline to at least ' +
            Math.max(0, totalNonOverturned5 - maxBeforeLock5) +
            '.',
          {
            newStrikeBaseline:
              'Must be at least ' + Math.max(0, totalNonOverturned5 - maxBeforeLock5) + '.'
          }
        );
      }

      // Restore Users.status to ACTIVE
      updateSheetRecordById_(
        'Users',
        studentUserId,
        {
          status: 'ACTIVE',
          updated_at_utc: nowIso
        },
        usrVer5,
        { skipLock: true }
      );

      // Update or create StudentIntegrityProfiles with the new effective_strike_baseline
      var existingProf5 = null;
      for (var spIdx = 0; spIdx < sipTbl.records.length; spIdx++) {
        if (sipTbl.records[spIdx].student_user_id === studentUserId) {
          existingProf5 = sipTbl.records[spIdx];
          break;
        }
      }

      var savedProf5 = null;
      if (!existingProf5) {
        savedProf5 = insertSheetRecord_(
          'StudentIntegrityProfiles',
          {
            profile_id: generateEntityId_('sip_'),
            student_user_id: studentUserId,
            integrity_status: 'UNLOCKED_ON_PROBATION',
            distinct_copy_invalidations_total: totalNonOverturned5,
            overturned_invalidations_total: totalOverturned5,
            effective_strike_baseline: newStrikeBaseline,
            effective_active_strikes: postUnlockEval.effectiveActiveStrikes,
            locked_at_utc: '',
            lock_trigger_attempt_id: '',
            lock_reason_code: '',
            unlocked_at_utc: nowIso,
            unlocked_by_user_id: adminUser.user_id,
            unlock_reason: reason,
            updated_at_utc: nowIso
          },
          { skipLock: true }
        );
      } else {
        savedProf5 = updateSheetRecordById_(
          'StudentIntegrityProfiles',
          existingProf5.profile_id,
          {
            integrity_status: 'UNLOCKED_ON_PROBATION',
            distinct_copy_invalidations_total: totalNonOverturned5,
            overturned_invalidations_total: totalOverturned5,
            effective_strike_baseline: newStrikeBaseline,
            effective_active_strikes: postUnlockEval.effectiveActiveStrikes,
            unlocked_at_utc: nowIso,
            unlocked_by_user_id: adminUser.user_id,
            unlock_reason: reason,
            updated_at_utc: nowIso
          },
          Number(existingProf5.version),
          { skipLock: true }
        );
      }

      var revRec5 = insertSheetRecord_(
        'ExamIntegrityReviews',
        {
          review_id: generateEntityId_('eir_'),
          target_type: 'ACCOUNT_INTEGRITY_LOCK',
          target_id: studentUserId,
          student_user_id: studentUserId,
          attempt_id: attemptId || (existingProf5 ? existingProf5.lock_trigger_attempt_id : ''),
          exam_set_id: examSetId || '',
          action_taken: 'UNLOCK_ACCOUNT_SET_BASELINE',
          previous_state_json: JSON.stringify({
            accountStatus: targetUsr.status,
            previousBaseline: existingProf5
              ? Number(existingProf5.effective_strike_baseline) || 0
              : 0
          }),
          new_state_json: JSON.stringify({
            accountStatus: 'ACTIVE',
            integrityStatus: 'UNLOCKED_ON_PROBATION',
            distinctNonOverturnedTotal: totalNonOverturned5,
            newStrikeBaseline: newStrikeBaseline,
            effectiveActiveStrikes: postUnlockEval.effectiveActiveStrikes
          }),
          new_strike_baseline_count: newStrikeBaseline,
          reason: reason,
          admin_user_id: adminUser.user_id,
          created_at_utc: nowIso
        },
        { skipLock: true }
      );

      actionResultSummary = {
        actionTaken: 'UNLOCK_ACCOUNT_SET_BASELINE',
        reviewId: revRec5.review_id,
        studentUserId: studentUserId,
        accountStatus: 'ACTIVE',
        integrityStatus: 'UNLOCKED_ON_PROBATION',
        distinctNonOverturnedInvalidations: totalNonOverturned5,
        effectiveStrikeBaseline: newStrikeBaseline,
        effectiveActiveStrikes: postUnlockEval.effectiveActiveStrikes
      };
    }

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_EXAM_INTEGRITY_REVIEW_' + actionTaken,
      targetEntityType: 'ExamIntegrityReview',
      targetEntityId:
        (actionResultSummary && actionResultSummary.reviewId) ||
        attemptId ||
        integrityEventId ||
        studentUserId,
      summary: Object.assign({}, actionResultSummary, { reason: reason })
    });
  });

  var dashboard = handleAdminListIntegrityDashboardPhaseD_({}, context);
  return {
    reviewAction: actionResultSummary,
    dashboard: dashboard
  };
}