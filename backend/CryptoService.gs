/**
 * CalendarService.gs
 * Pattanabhumi Biology Learning Management System - Step 13 Class Calendar Service
 *
 * Responsibilities:
 * - Read the configured private Google Calendar ID (`Settings.CALENDAR_ID` or `ScriptProperties.CALENDAR_ID`)
 *   without requiring public calendar sharing or public `<iframe>` embeds.
 * - Validate requested `month` (`YYYY-MM`) or `startDate` / `endDate` (`YYYY-MM-DD`) in `Asia/Bangkok`
 *   (`UTC+07:00`), enforcing a bounded query window (`<= 62` days) and bounded event count (`<= 500` raw /
 *   `<= 200` returned).
 * - Strictly parse and validate event visibility markers:
 *     1. Course marker: `PB_COURSE_ID: [course UUID]` (or `PB_COURSE_ID: crs_...`) on a dedicated marker line,
 *        verified against real `Courses` and `Enrollments` records.
 *     2. School-wide marker: `PB_ALL_STUDENTS` on a dedicated marker line.
 *     3. Events without an approved marker, or with invalid/unreferenced course IDs, are strictly hidden.
 * - Handle timed events, all-day events (single-day and multi-day exclusive end dates), events crossing
 *   midnight in `Asia/Bangkok`, and recurring event occurrences.
 * - Strip all event descriptions (including marker text and private notes) and never return attendee lists,
 *   guest emails, or organizer emails.
 *
 * Security Note:
 * - Every function in this file ends with an underscore (_) so it cannot be called directly from
 *   `google.script.run`; all browser requests pass through `rpcDispatch`.
 */

var PB_STEP13_IN_MEMORY_SAMPLE_EVENTS_ = null;

/**
 * Formats a UTC epoch millisecond timestamp into `YYYY-MM-DD` in `Asia/Bangkok` (`UTC+07:00`).
 * Uses fixed +07:00 offset arithmetic (Thailand does not observe DST) so results are identical
 * in Google Apps Script V8 and Node V8 verification harnesses.
 *
 * @param {number} utcMs Epoch milliseconds.
 * @return {string} `YYYY-MM-DD` in `Asia/Bangkok`.
 */
function formatUtcMsToBangkokDateStrStep13_(utcMs) {
  var bkkMs = Number(utcMs) + 7 * 3600 * 1000;
  var d = new Date(bkkMs);
  var yyyy = String(d.getUTCFullYear());
  var mm = String(d.getUTCMonth() + 1);
  if (mm.length < 2) mm = '0' + mm;
  var dd = String(d.getUTCDate());
  if (dd.length < 2) dd = '0' + dd;
  return yyyy + '-' + mm + '-' + dd;
}

/**
 * Formats a UTC epoch millisecond timestamp into `HH:mm` (24-hour) in `Asia/Bangkok` (`UTC+07:00`).
 *
 * @param {number} utcMs Epoch milliseconds.
 * @return {string} `HH:mm` in `Asia/Bangkok`.
 */
function formatUtcMsToBangkokTimeHmStep13_(utcMs) {
  var bkkMs = Number(utcMs) + 7 * 3600 * 1000;
  var d = new Date(bkkMs);
  var hh = String(d.getUTCHours());
  if (hh.length < 2) hh = '0' + hh;
  var mi = String(d.getUTCMinutes());
  if (mi.length < 2) mi = '0' + mi;
  return hh + ':' + mi;
}

/**
 * Checks whether `year`, `month` (1..12), and `day` (1..31) form a valid Gregorian calendar date.
 *
 * @param {number} year Full year (e.g. 2026).
 * @param {number} month Month 1..12.
 * @param {number} day Day 1..31.
 * @return {boolean} True if valid calendar date.
 */
function isValidCalendarYmdStep13_(year, month, day) {
  if (
    typeof year !== 'number' ||
    typeof month !== 'number' ||
    typeof day !== 'number' ||
    isNaN(year) ||
    isNaN(month) ||
    isNaN(day)
  ) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  var daysInMonths = [
    31,
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day <= daysInMonths[month - 1];
}

/**
 * Converts a validated `YYYY-MM-DD` string in `Asia/Bangkok` into the UTC epoch millisecond
 * of `00:00:00.000` on that date in `Asia/Bangkok`.
 *
 * @param {string} ymdStr `YYYY-MM-DD`.
 * @return {number} UTC epoch milliseconds.
 */
function bangkokYmdStartToUtcMsStep13_(ymdStr) {
  var parts = String(ymdStr).split('-');
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  var d = parseInt(parts[2], 10);
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 7 * 3600 * 1000;
}

/**
 * Converts a validated `YYYY-MM-DD` string in `Asia/Bangkok` into the UTC epoch millisecond
 * of `23:59:59.999` on that date in `Asia/Bangkok`.
 *
 * @param {string} ymdStr `YYYY-MM-DD`.
 * @return {number} UTC epoch milliseconds.
 */
function bangkokYmdEndToUtcMsStep13_(ymdStr) {
  var parts = String(ymdStr).split('-');
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  var d = parseInt(parts[2], 10);
  return Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 7 * 3600 * 1000;
}

/**
 * Enumerates all `YYYY-MM-DD` strings from `startDateBkk` to `endDateBkk` inclusive (bounded to 62 days).
 *
 * @param {string} startDateBkk `YYYY-MM-DD`.
 * @param {string} endDateBkk `YYYY-MM-DD`.
 * @return {Array<string>} Ordered list of `YYYY-MM-DD` dates.
 */
function enumerateBangkokDatesInclusiveStep13_(startDateBkk, endDateBkk) {
  var startMs = bangkokYmdStartToUtcMsStep13_(startDateBkk);
  var endMs = bangkokYmdStartToUtcMsStep13_(endDateBkk);
  if (endMs < startMs) {
    return [];
  }
  var out = [];
  var curMs = startMs;
  var maxSteps = 366;
  var step = 0;
  while (curMs <= endMs && step < maxSteps) {
    out.push(formatUtcMsToBangkokDateStrStep13_(curMs));
    curMs += 24 * 3600 * 1000;
    step++;
  }
  return out;
}

/**
 * Validates the requested `month` (`YYYY-MM`) or `startDate`/`endDate` (`YYYY-MM-DD`) in `Asia/Bangkok`
 * and enforces the maximum query span (`MAX_CALENDAR_QUERY_DAYS = 62` days) and year range (`2020..2035`).
 *
 * @param {Object} payload Request payload.
 * @return {Object} Validated range descriptor in `Asia/Bangkok`.
 */
function validateAndResolveBangkokDateRangeStep13_(payload) {
  var req = payload && typeof payload === 'object' ? payload : {};
  var minYear = PB_APP_CONSTANTS_.MIN_CALENDAR_YEAR || 2020;
  var maxYear = PB_APP_CONSTANTS_.MAX_CALENDAR_YEAR || 2035;
  var maxDays = PB_APP_CONSTANTS_.MAX_CALENDAR_QUERY_DAYS || 62;

  var rawMonth =
    req.month !== undefined && req.month !== null
      ? String(req.month).trim()
      : '';
  var rawStart =
    req.startDate !== undefined && req.startDate !== null
      ? String(req.startDate).trim()
      : '';
  var rawEnd =
    req.endDate !== undefined && req.endDate !== null
      ? String(req.endDate).trim()
      : '';

  var monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ];

  var startDateBkk = '';
  var endDateBkk = '';
  var resolvedMonthKey = '';
  var resolvedYear = 0;
  var resolvedMonthNum = 0;

  if (rawStart || rawEnd) {
    if (!rawStart || !rawEnd) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Both startDate and endDate (YYYY-MM-DD in Asia/Bangkok) are required when querying by date range.',
        {
          dateRange: 'Provide both startDate and endDate in YYYY-MM-DD format.'
        }
      );
    }
    var sm = rawStart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var em = rawEnd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!sm || !em) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Invalid date format. Expected YYYY-MM-DD in Asia/Bangkok.',
        {
          dateRange: 'startDate and endDate must match YYYY-MM-DD.'
        }
      );
    }
    var sy = parseInt(sm[1], 10);
    var smo = parseInt(sm[2], 10);
    var sd = parseInt(sm[3], 10);
    var ey = parseInt(em[1], 10);
    var emo = parseInt(em[2], 10);
    var ed = parseInt(em[3], 10);

    if (
      sy < minYear ||
      sy > maxYear ||
      ey < minYear ||
      ey > maxYear ||
      !isValidCalendarYmdStep13_(sy, smo, sd) ||
      !isValidCalendarYmdStep13_(ey, emo, ed)
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Requested startDate or endDate is not a valid calendar date between ' +
          minYear +
          ' and ' +
          maxYear +
          '.',
        {
          dateRange: 'Invalid calendar date or year out of allowed bounds (' + minYear + '..' + maxYear + ').'
        }
      );
    }

    var sMs = bangkokYmdStartToUtcMsStep13_(rawStart);
    var eMs = bangkokYmdStartToUtcMsStep13_(rawEnd);
    if (eMs < sMs) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Invalid date range: endDate (' +
          rawEnd +
          ') cannot be earlier than startDate (' +
          rawStart +
          ').',
        {
          dateRange: 'endDate must be on or after startDate.'
        }
      );
    }

    var spanDays = Math.round((eMs - sMs) / (24 * 3600 * 1000)) + 1;
    if (spanDays > maxDays) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Requested date range (' +
          spanDays +
          ' days) exceeds the maximum bounded query window of ' +
          maxDays +
          ' days.',
        {
          dateRange:
            'Query range (' +
            spanDays +
            ' days) exceeds MAX_CALENDAR_QUERY_DAYS (' +
            maxDays +
            ' days).'
        }
      );
    }

    startDateBkk = rawStart;
    endDateBkk = rawEnd;
    resolvedYear = sy;
    resolvedMonthNum = smo;
    resolvedMonthKey = sm[1] + '-' + sm[2];
  } else {
    if (!rawMonth) {
      var nowBkkDate = formatUtcMsToBangkokDateStrStep13_(Date.now());
      rawMonth = nowBkkDate.slice(0, 7);
    }
    var mmMatch = rawMonth.match(/^(\d{4})-(\d{2})$/);
    if (!mmMatch) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Invalid month format "' +
          rawMonth +
          '". Expected YYYY-MM (for example, "2026-10").',
        {
          month: 'Month must match YYYY-MM format (e.g. 2026-10).'
        }
      );
    }
    resolvedYear = parseInt(mmMatch[1], 10);
    resolvedMonthNum = parseInt(mmMatch[2], 10);
    if (
      resolvedYear < minYear ||
      resolvedYear > maxYear ||
      resolvedMonthNum < 1 ||
      resolvedMonthNum > 12
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Invalid month "' +
          rawMonth +
          '". Year must be between ' +
          minYear +
          ' and ' +
          maxYear +
          ' and month must be 01..12.',
        {
          month:
            'Year must be in ' +
            minYear +
            '..' +
            maxYear +
            ' and month must be 01..12.'
        }
      );
    }
    var daysInMonth = [
      31,
      (resolvedYear % 4 === 0 && resolvedYear % 100 !== 0) ||
      resolvedYear % 400 === 0
        ? 29
        : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31
    ][resolvedMonthNum - 1];

    resolvedMonthKey = mmMatch[1] + '-' + mmMatch[2];
    startDateBkk = resolvedMonthKey + '-01';
    endDateBkk =
      resolvedMonthKey +
      '-' +
      (daysInMonth < 10 ? '0' + daysInMonth : String(daysInMonth));
  }

  var rangeStartUtcMs = bangkokYmdStartToUtcMsStep13_(startDateBkk);
  var rangeEndUtcMs = bangkokYmdEndToUtcMsStep13_(endDateBkk);
  var daysList = enumerateBangkokDatesInclusiveStep13_(startDateBkk, endDateBkk);

  /* First day of week (0=Sunday .. 6=Saturday) for the 1st of the resolved month in Asia/Bangkok */
  var firstOfMonthUtcMs = bangkokYmdStartToUtcMsStep13_(
    resolvedMonthKey + '-01'
  );
  var firstOfMonthBkkObj = new Date(firstOfMonthUtcMs + 7 * 3600 * 1000);
  var firstDayOfWeek = firstOfMonthBkkObj.getUTCDay();

  var prevYear = resolvedMonthNum === 1 ? resolvedYear - 1 : resolvedYear;
  var prevMonth = resolvedMonthNum === 1 ? 12 : resolvedMonthNum - 1;
  var nextYear = resolvedMonthNum === 12 ? resolvedYear + 1 : resolvedYear;
  var nextMonth = resolvedMonthNum === 12 ? 1 : resolvedMonthNum + 1;

  var pad2 = function (n) {
    return n < 10 ? '0' + String(n) : String(n);
  };

  return {
    monthKey: resolvedMonthKey,
    year: resolvedYear,
    monthNumber: resolvedMonthNum,
    monthDisplayName:
      monthNames[resolvedMonthNum - 1] + ' ' + String(resolvedYear),
    startDateBkk: startDateBkk,
    endDateBkk: endDateBkk,
    rangeStartUtcMs: rangeStartUtcMs,
    rangeEndUtcMs: rangeEndUtcMs,
    totalDaysInRange: daysList.length,
    daysInMonth: daysList.length,
    firstDayOfWeek: firstDayOfWeek,
    previousMonthKey: String(prevYear) + '-' + pad2(prevMonth),
    nextMonthKey: String(nextYear) + '-' + pad2(nextMonth),
    timezone: 'Asia/Bangkok',
    timezoneDisplayLabel: 'Asia/Bangkok (UTC+07:00 / ICT)'
  };
}

/**
 * Strictly parses and validates event visibility markers from a Google Calendar event's
 * description (and checks for any stray markers in the title to strip them).
 *
 * Approved Markers:
 * 1. Course event marker:
 *      PB_COURSE_ID: [course UUID]
 *    (Also accepts `PB_COURSE_ID: crs_...` on its own marker line).
 *    Must reference an existing `crs_...` UUID in the `Courses` worksheet.
 * 2. School-wide event marker:
 *      PB_ALL_STUDENTS
 *    Must appear on its own marker line.
 *
 * Security Rules:
 * - Events without an approved marker are classified as `UNMARKED_PRIVATE` and hidden.
 * - Loose substring mentions embedded in prose sentences (e.g. "See PB_ALL_STUDENTS note")
 *   do NOT match because markers must stand on their own line (`^\s*...\s*$`).
 * - Conflicting markers (e.g. two different `PB_COURSE_ID` values, or both `PB_ALL_STUDENTS`
 *   and `PB_COURSE_ID`) or references to non-existent course UUIDs fail closed and hide the event.
 *
 * @param {string} rawDescription Raw Google Calendar event description.
 * @param {Object} coursesById Map of `course_id -> courseRecord` from `Courses` sheet.
 * @return {Object} Parsed marker validation result.
 */
function parseAndValidateCalendarEventMarkersStep13_(
  rawDescription,
  coursesById
) {
  var desc = typeof rawDescription === 'string' ? rawDescription : '';
  var lines = desc.split(/\r?\n/);

  var matchedCourseIds = [];
  var invalidCourseRefDetected = false;
  var invalidCourseRawValue = '';
  var hasAllStudentsMarker = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) {
      continue;
    }

    if (/^PB_ALL_STUDENTS$/i.test(line)) {
      hasAllStudentsMarker = true;
      continue;
    }

    if (/^PB_COURSE_ID\b/i.test(line)) {
      var m = line.match(
        /^PB_COURSE_ID\s*:\s*(?:\[\s*([^\]]+?)\s*\]|(\S+))\s*$/i
      );
      if (!m) {
        invalidCourseRefDetected = true;
        invalidCourseRawValue = line;
        continue;
      }
      var candidateId = String(m[1] || m[2] || '')
        .trim()
        .toLowerCase();
      if (!/^crs_[a-z0-9_-]{4,64}$/i.test(candidateId)) {
        invalidCourseRefDetected = true;
        invalidCourseRawValue = candidateId;
        continue;
      }
      if (!coursesById || !coursesById[candidateId]) {
        invalidCourseRefDetected = true;
        invalidCourseRawValue = candidateId;
        continue;
      }
      if (matchedCourseIds.indexOf(candidateId) === -1) {
        matchedCourseIds.push(candidateId);
      }
    }
  }

  if (invalidCourseRefDetected) {
    return {
      isAuthorizedMarker: false,
      markerType: 'INVALID_COURSE_REF',
      reasonCode: 'INVALID_OR_UNKNOWN_COURSE_UUID',
      invalidValue: invalidCourseRawValue,
      courseId: '',
      courseRecord: null
    };
  }

  if (matchedCourseIds.length > 1) {
    return {
      isAuthorizedMarker: false,
      markerType: 'CONFLICTING_MARKERS',
      reasonCode: 'MULTIPLE_COURSE_MARKERS_ON_SINGLE_EVENT',
      courseId: '',
      courseRecord: null
    };
  }

  if (matchedCourseIds.length === 1 && hasAllStudentsMarker) {
    return {
      isAuthorizedMarker: false,
      markerType: 'CONFLICTING_MARKERS',
      reasonCode: 'BOTH_COURSE_AND_ALL_STUDENTS_MARKERS_PRESENT',
      courseId: '',
      courseRecord: null
    };
  }

  if (matchedCourseIds.length === 1) {
    var cid = matchedCourseIds[0];
    return {
      isAuthorizedMarker: true,
      markerType: 'COURSE',
      reasonCode: 'VALID_COURSE_MARKER',
      courseId: cid,
      courseRecord: coursesById[cid]
    };
  }

  if (hasAllStudentsMarker) {
    return {
      isAuthorizedMarker: true,
      markerType: 'SCHOOL_WIDE',
      reasonCode: 'VALID_SCHOOL_WIDE_MARKER',
      courseId: '',
      courseRecord: null
    };
  }

  return {
    isAuthorizedMarker: false,
    markerType: 'UNMARKED_PRIVATE',
    reasonCode: 'NO_APPROVED_MARKER',
    courseId: '',
    courseRecord: null
  };
}

/**
 * Strips any accidental marker tokens from an event title and enforces a clean title string.
 *
 * @param {string} rawTitle Raw event title.
 * @return {string} Sanitized event title.
 */
function sanitizeCalendarEventTitleStep13_(rawTitle) {
  var t = typeof rawTitle === 'string' ? rawTitle : '';
  t = t
    .replace(/PB_COURSE_ID\s*:\s*\[[^\]]*\]/gi, '')
    .replace(/PB_COURSE_ID\s*:\s*\S+/gi, '')
    .replace(/\bPB_ALL_STUDENTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) {
    return 'Scheduled Biology Session';
  }
  return t.length > 200 ? t.slice(0, 200) : t;
}

/**
 * Sanitizes event location (never exposing descriptions or private URLs if not appropriate).
 *
 * @param {string} rawLocation Raw location from Google Calendar event.
 * @return {string} Sanitized location string (`<= 240` chars).
 */
function sanitizeCalendarEventLocationStep13_(rawLocation) {
  if (typeof rawLocation !== 'string') {
    return '';
  }
  var loc = rawLocation.replace(/\s+/g, ' ').trim();
  return loc.length > 240 ? loc.slice(0, 240) : loc;
}

/**
 * Wraps a plain event specification object into an object implementing the standard
 * Apps Script `CalendarEvent` interface (`getId`, `getTitle`, `getDescription`, `getLocation`,
 * `isAllDayEvent`, `getAllDayStartDate`, `getAllDayEndDate`, `getStartTime`, `getEndTime`,
 * `isRecurringEvent`, `getGuestList`, `getCreators`).
 *
 * @param {Object} spec Plain event spec.
 * @return {Object} CalendarEvent-compatible object.
 */
function wrapRawEventSpecAsCalendarEventStep13_(spec) {
  var isAllDay = Boolean(spec.isAllDay);
  var startDateObj = isAllDay
    ? new Date(bangkokYmdStartToUtcMsStep13_(spec.allDayStartDateBkk))
    : new Date(spec.startUtcIso || spec.startTimeMs);
  var endDateObj = isAllDay
    ? new Date(bangkokYmdStartToUtcMsStep13_(spec.allDayEndDateExclusiveBkk))
    : new Date(spec.endUtcIso || spec.endTimeMs);

  return {
    getId: function () {
      return String(spec.eventId || 'evt_spec');
    },
    getTitle: function () {
      return String(spec.title || '');
    },
    getDescription: function () {
      return String(spec.description || '');
    },
    getLocation: function () {
      return String(spec.location || '');
    },
    isAllDayEvent: function () {
      return isAllDay;
    },
    getAllDayStartDate: function () {
      return startDateObj;
    },
    getAllDayEndDate: function () {
      return endDateObj;
    },
    getStartTime: function () {
      return startDateObj;
    },
    getEndTime: function () {
      return endDateObj;
    },
    isRecurringEvent: function () {
      return Boolean(spec.isRecurring);
    },
    getGuestList: function () {
      return Array.isArray(spec.guests) ? spec.guests : [];
    },
    getCreators: function () {
      return Array.isArray(spec.creators)
        ? spec.creators
        : ['private.owner@pattanabhumi.edu.th'];
    }
  };
}

/**
 * Projects a verified `CalendarEvent` occurrence into `Asia/Bangkok` (`UTC+07:00`) dates and times,
 * handling:
 * - Timed single-day events.
 * - Timed events crossing midnight (`crossesMidnight: true`, projected onto every spanned day).
 * - All-day single-day and multi-day events (converting Google Calendar's exclusive end date into inclusive Bangkok dates).
 * - Recurring event occurrences (`isRecurring: true`).
 * - Privacy & Data Minimization: strips all descriptions, markers, attendee lists, and creator emails.
 *
 * @param {Object} calEvent Apps Script `CalendarEvent` (or compatible wrapper).
 * @param {Object} markerResult Validated marker result from `parseAndValidateCalendarEventMarkersStep13_`.
 * @param {Object} rangeInfo Validated range descriptor from `validateAndResolveBangkokDateRangeStep13_`.
 * @param {number} indexSeq Monotonic sequence number for deterministic occurrence IDs.
 * @return {Object|null} Sanitized event DTO, or `null` if the event does not overlap `[rangeInfo.startDateBkk, rangeInfo.endDateBkk]`.
 */
function projectAuthorizedCalendarEventToBangkokDtoStep13_(
  calEvent,
  markerResult,
  rangeInfo,
  indexSeq
) {
  var isAllDay = Boolean(
    typeof calEvent.isAllDayEvent === 'function' && calEvent.isAllDayEvent()
  );
  var isRecurring = Boolean(
    typeof calEvent.isRecurringEvent === 'function' &&
      calEvent.isRecurringEvent()
  );

  var rawEventId =
    typeof calEvent.getId === 'function'
      ? String(calEvent.getId() || '')
      : 'evt_' + String(indexSeq);
  var cleanTitle = sanitizeCalendarEventTitleStep13_(
    typeof calEvent.getTitle === 'function' ? calEvent.getTitle() : ''
  );
  var cleanLocation = sanitizeCalendarEventLocationStep13_(
    typeof calEvent.getLocation === 'function' ? calEvent.getLocation() : ''
  );

  var startDateBkk = '';
  var endDateBkk = '';
  var startTimeBkk = '';
  var endTimeBkk = '';
  var crossesMidnight = false;
  var isMultiDay = false;
  var timeLabelBkk = '';
  var fullScheduleLabelBkk = '';
  var sortEpochMs = 0;

  if (isAllDay) {
    var allDayStartObj =
      typeof calEvent.getAllDayStartDate === 'function'
        ? calEvent.getAllDayStartDate()
        : calEvent.getStartTime();
    var allDayEndExclusiveObj =
      typeof calEvent.getAllDayEndDate === 'function'
        ? calEvent.getAllDayEndDate()
        : calEvent.getEndTime();

    var sUtcMs = allDayStartObj.getTime();
    /* Exclusive end date is midnight of the day after the last all-day date; subtract 12 hours to land safely on the last inclusive day */
    var eExclusiveUtcMs = allDayEndExclusiveObj.getTime();
    var eInclusiveUtcMs = Math.max(sUtcMs, eExclusiveUtcMs - 12 * 3600 * 1000);

    startDateBkk = formatUtcMsToBangkokDateStrStep13_(sUtcMs);
    endDateBkk = formatUtcMsToBangkokDateStrStep13_(eInclusiveUtcMs);
    if (endDateBkk < startDateBkk) {
      endDateBkk = startDateBkk;
    }

    isMultiDay = endDateBkk > startDateBkk;
    crossesMidnight = false;
    startTimeBkk = 'ALL_DAY';
    endTimeBkk = 'ALL_DAY';
    timeLabelBkk = isMultiDay
      ? 'All-day (' + startDateBkk + ' to ' + endDateBkk + ')'
      : 'All-day';
    fullScheduleLabelBkk = isMultiDay
      ? startDateBkk + ' to ' + endDateBkk + ' (All-day, Asia/Bangkok)'
      : startDateBkk + ' (All-day, Asia/Bangkok)';
    sortEpochMs = bangkokYmdStartToUtcMsStep13_(startDateBkk);
  } else {
    var startObj = calEvent.getStartTime();
    var endObj = calEvent.getEndTime();
    var startMs = startObj.getTime();
    var endMs = Math.max(startMs, endObj.getTime());

    startDateBkk = formatUtcMsToBangkokDateStrStep13_(startMs);
    startTimeBkk = formatUtcMsToBangkokTimeHmStep13_(startMs);

    /* If an event ends at exact 00:00:00 of the next day, treat its last active calendar date as (endMs - 1 ms) */
    var rawEndDateBkk = formatUtcMsToBangkokDateStrStep13_(endMs);
    var rawEndTimeBkk = formatUtcMsToBangkokTimeHmStep13_(endMs);
    if (
      rawEndDateBkk > startDateBkk &&
      rawEndTimeBkk === '00:00' &&
      formatUtcMsToBangkokDateStrStep13_(Math.max(startMs, endMs - 1)) ===
        startDateBkk
    ) {
      endDateBkk = startDateBkk;
      endTimeBkk = '24:00';
    } else {
      endDateBkk = rawEndDateBkk;
      endTimeBkk = rawEndTimeBkk;
    }

    crossesMidnight = endDateBkk > startDateBkk;
    isMultiDay = crossesMidnight;

    if (crossesMidnight) {
      timeLabelBkk =
        startTimeBkk + ' - ' + endTimeBkk + ' (+1d) ICT';
      fullScheduleLabelBkk =
        startDateBkk +
        ' ' +
        startTimeBkk +
        ' to ' +
        endDateBkk +
        ' ' +
        endTimeBkk +
        ' ICT (Asia/Bangkok - Crosses midnight)';
    } else {
      timeLabelBkk = startTimeBkk + ' - ' + endTimeBkk + ' ICT';
      fullScheduleLabelBkk =
        startDateBkk +
        ' | ' +
        startTimeBkk +
        ' - ' +
        endTimeBkk +
        ' ICT (Asia/Bangkok)';
    }
    sortEpochMs = startMs;
  }

  /* Verify overlap with the requested [rangeInfo.startDateBkk, rangeInfo.endDateBkk] window */
  if (
    endDateBkk < rangeInfo.startDateBkk ||
    startDateBkk > rangeInfo.endDateBkk
  ) {
    return null;
  }

  var allEventDates = enumerateBangkokDatesInclusiveStep13_(
    startDateBkk,
    endDateBkk
  );
  var totalSpanDays = allEventDates.length || 1;
  var spannedDatesInMonth = [];

  for (var dIdx = 0; dIdx < allEventDates.length; dIdx++) {
    var dStr = allEventDates[dIdx];
    if (dStr < rangeInfo.startDateBkk || dStr > rangeInfo.endDateBkk) {
      continue;
    }
    var dayNumberInSpan = dIdx + 1;
    var dayTimeLabel = timeLabelBkk;
    if (isAllDay) {
      dayTimeLabel =
        totalSpanDays > 1
          ? 'All-day (Day ' + dayNumberInSpan + ' of ' + totalSpanDays + ')'
          : 'All-day';
    } else if (crossesMidnight) {
      if (dayNumberInSpan === 1) {
        dayTimeLabel =
          startTimeBkk +
          ' - 24:00 ICT (Continues past midnight -> ' +
          endTimeBkk +
          ')';
      } else if (dayNumberInSpan === totalSpanDays) {
        dayTimeLabel =
          '00:00 - ' +
          endTimeBkk +
          ' ICT (Continued from ' +
          startDateBkk +
          ' ' +
          startTimeBkk +
          ')';
      } else {
        dayTimeLabel =
          '00:00 - 24:00 ICT (Day ' +
          dayNumberInSpan +
          ' of ' +
          totalSpanDays +
          ')';
      }
    }

    spannedDatesInMonth.push({
      dateBkk: dStr,
      dayIndex: dayNumberInSpan,
      totalDays: totalSpanDays,
      dayTimeLabelBkk: dayTimeLabel
    });
  }

  if (spannedDatesInMonth.length === 0) {
    return null;
  }

  var courseRec = markerResult.courseRecord;
  var isCourseEvent = markerResult.markerType === 'COURSE' && Boolean(courseRec);
  var occurrenceId =
    'calocc_' +
    sha256Hex_(
      rawEventId + '|' + startDateBkk + '|' + startTimeBkk + '|' + String(indexSeq)
    ).slice(0, 16);

  return {
    occurrenceId: occurrenceId,
    eventId: rawEventId,
    title: cleanTitle,
    visibilityScope: isCourseEvent ? 'COURSE' : 'SCHOOL_WIDE',
    scopeBadgeLabel: isCourseEvent
      ? '[' + courseRec.course_code + '] ' + courseRec.title
      : 'School-Wide Event (PB_ALL_STUDENTS)',
    courseId: isCourseEvent ? courseRec.course_id : '',
    courseCode: isCourseEvent ? courseRec.course_code : '',
    courseTitle: isCourseEvent ? courseRec.title : '',
    isAllDay: isAllDay,
    isMultiDay: isMultiDay,
    crossesMidnight: crossesMidnight,
    isRecurring: isRecurring,
    startDateBkk: startDateBkk,
    endDateBkk: endDateBkk,
    startTimeBkk: startTimeBkk,
    endTimeBkk: endTimeBkk,
    timeLabelBkk: timeLabelBkk,
    fullScheduleLabelBkk: fullScheduleLabelBkk,
    location: cleanLocation,
    spannedDatesInMonth: spannedDatesInMonth,
    sortEpochMs: sortEpochMs,
    timezone: 'Asia/Bangkok'
  };
}

/**
 * Resolves the configured private Calendar ID from `Settings.CALENDAR_ID` or `ScriptProperties.CALENDAR_ID`.
 *
 * @return {{ calendarId: string, source: string, configured: boolean }}
 */
function resolveConfiguredCalendarIdStep13_() {
  var fromSettings = '';
  try {
    var settingsTbl = readSheetTable_('Settings');
    if (
      settingsTbl &&
      settingsTbl.byId &&
      settingsTbl.byId.CALENDAR_ID &&
      settingsTbl.byId.CALENDAR_ID.record &&
      settingsTbl.byId.CALENDAR_ID.record.setting_value
    ) {
      var candidate = String(
        settingsTbl.byId.CALENDAR_ID.record.setting_value
      ).trim();
      if (
        candidate &&
        candidate !== 'placeholder_calendar@group.calendar.google.com'
      ) {
        fromSettings = candidate;
      }
    }
  } catch (ignoreSettingsErr) {}

  if (fromSettings) {
    var validSetId = validateResourceIdFormat_('CALENDAR_ID', fromSettings);
    return {
      calendarId: validSetId,
      source: 'SETTINGS_SHEET',
      configured: true
    };
  }

  var fromProps = '';
  try {
    var props = PropertiesService.getScriptProperties();
    fromProps = String(props.getProperty('CALENDAR_ID') || '').trim();
  } catch (ignorePropsErr) {}

  if (fromProps) {
    var validPropId = validateResourceIdFormat_('CALENDAR_ID', fromProps);
    return {
      calendarId: validPropId,
      source: 'SCRIPT_PROPERTIES',
      configured: true
    };
  }

  return {
    calendarId: '',
    source: 'UNCONFIGURED',
    configured: false
  };
}

/**
 * Builds the canonical Step 13 sample calendar events for a target `YYYY-MM` month (defaulting to
 * `2026-10`) using the real `course_id` UUIDs from the `Courses` worksheet (`BIO-101-CELL` Course A,
 * `BIO-102-GENETICS` Course B, and `BIO-103-ECOLOGY-DRAFT` Draft Course).
 *
 * Covers all 7 event categories required by Step 13:
 * 1. Course A timed event (`PB_COURSE_ID: [<courseA_id>]`).
 * 2. School-wide timed event (`PB_ALL_STUDENTS`).
 * 3. Unmarked private staff event (no marker -> must be hidden).
 * 4. Course B timed event (`PB_COURSE_ID: [<courseB_id>]` -> visible to Student B, hidden from Student A).
 * 5. All-day single-day & multi-day events (`PB_ALL_STUDENTS` and `PB_COURSE_ID`).
 * 6. Timed event crossing midnight in `Asia/Bangkok` (`22:30` Day 18 to `01:00` Day 19 ICT).
 * 7. Recurring weekly class event (`isRecurring: true`, 4 weekly Tuesdays in the month).
 * Plus:
 * - Event with invalid/unknown `PB_COURSE_ID: [crs_nonexistent_999999]` (must be hidden).
 * - Event with `DRAFT` course `PB_COURSE_ID: [<draftCourse_id>]` (must be hidden from students).
 * - Loose substring mention in prose (`"Note: do not type PB_ALL_STUDENTS inline"`) (must be hidden).
 *
 * @param {string} monthKey `YYYY-MM` (e.g. `2026-10`).
 * @return {Object} Sample event specs and resolved course IDs.
 */
function buildStep13CanonicalSampleEventSpecs_(monthKey) {
  var mKey =
    typeof monthKey === 'string' && /^\d{4}-\d{2}$/.test(monthKey)
      ? monthKey
      : '2026-10';
  var coursesTbl = readSheetTable_('Courses');
  var courseA = null;
  var courseB = null;
  var draftCourse = null;

  for (var i = 0; i < coursesTbl.records.length; i++) {
    var c = coursesTbl.records[i];
    if (c.course_code === 'BIO-101-CELL') {
      courseA = c;
    } else if (c.course_code === 'BIO-102-GENETICS') {
      courseB = c;
    } else if (c.status === 'DRAFT' && !draftCourse) {
      draftCourse = c;
    }
  }
  if (!courseA && coursesTbl.records.length > 0) {
    courseA = coursesTbl.records[0];
  }

  var courseAId = courseA ? courseA.course_id : 'crs_missing_course_a';
  var courseBId = courseB ? courseB.course_id : 'crs_missing_course_b';
  var draftCourseId = draftCourse
    ? draftCourse.course_id
    : 'crs_missing_draft_course';

  var specs = [
    /* 1. Course A Timed Event */
    {
      eventId: 'evt_s13_course_a_lecture_' + mKey,
      title: 'BIO-101 Live Lecture: ATP Synthase & Oxidative Phosphorylation',
      description:
        'Instructor private prep notes: review electron transport chain slides 12-28.\n' +
        'PB_COURSE_ID: [' +
        courseAId +
        ']\n' +
        'Confidential Zoom host key: 998877 (must never be sent to browser)',
      location: 'Room 302 (Chiang Rai Campus) & Live Zoom Stream',
      isAllDay: false,
      isRecurring: false,
      startUtcIso: mKey + '-10T02:00:00.000Z', /* 09:00 ICT (+07:00) on the 10th */
      endUtcIso: mKey + '-10T04:00:00.000Z',   /* 11:00 ICT (+07:00) on the 10th */
      guests: [
        { email: 'private.student.guest@example.com', name: 'Private Guest' }
      ],
      creators: ['ajarn.lead@pattanabhumi.edu.th']
    },
    /* 2. School-Wide Timed Event */
    {
      eventId: 'evt_s13_school_wide_orientation_' + mKey,
      title: 'Pattanabhumi Biology Term Orientation & Exam Strategy Q&A',
      description:
        'Open to all Pattanabhumi Biology students.\nPB_ALL_STUDENTS\nInternal staff note: record attendance.',
      location: 'Main Auditorium / School Live Broadcast',
      isAllDay: false,
      isRecurring: false,
      startUtcIso: mKey + '-05T07:00:00.000Z', /* 14:00 ICT (+07:00) on the 5th */
      endUtcIso: mKey + '-05T08:30:00.000Z',   /* 15:30 ICT (+07:00) on the 5th */
      guests: [{ email: 'all.staff@pattanabhumi.edu.th' }]
    },
    /* 3. Unmarked Private Event (Must be strictly hidden!) */
    {
      eventId: 'evt_s13_unmarked_private_staff_' + mKey,
      title: 'PRIVATE STAFF MEETING: Instructor Payroll & Exam Paper Security',
      description:
        'Strictly confidential internal administrator meeting. No calendar marker included.',
      location: 'Director Office',
      isAllDay: false,
      isRecurring: false,
      startUtcIso: mKey + '-12T06:00:00.000Z',
      endUtcIso: mKey + '-12T07:30:00.000Z',
      guests: [{ email: 'payroll@pattanabhumi.edu.th' }]
    },
    /* 4. Another Course's Event (Course B -> visible to Student B, hidden from Student A & C) */
    {
      eventId: 'evt_s13_course_b_genetics_lab_' + mKey,
      title: 'BIO-102 Mendelian Pedigree Analysis & Linkage Mapping Workshop',
      description:
        'Genetics problem set walkthrough.\nPB_COURSE_ID: [' +
        courseBId +
        ']\nPrivate answer key link inside teacher Drive.',
      location: 'Genetics Lab B2',
      isAllDay: false,
      isRecurring: false,
      startUtcIso: mKey + '-14T09:00:00.000Z', /* 16:00 ICT (+07:00) on the 14th */
      endUtcIso: mKey + '-14T11:00:00.000Z',   /* 18:00 ICT (+07:00) on the 14th */
      guests: []
    },
    /* 5A. Single-Day All-Day School-Wide Event */
    {
      eventId: 'evt_s13_allday_single_' + mKey,
      title: 'Chulalongkorn Memorial Day - School Holiday (Self-Study Day)',
      description: 'Public holiday notice.\nPB_ALL_STUDENTS',
      location: 'All Campuses Closed',
      isAllDay: true,
      isRecurring: false,
      allDayStartDateBkk: mKey + '-23',
      allDayEndDateExclusiveBkk: mKey + '-24'
    },
    /* 5B. Multi-Day All-Day Course A Event (25th through 26th inclusive -> exclusive end 27th) */
    {
      eventId: 'evt_s13_allday_multiday_course_a_' + mKey,
      title: 'BIO-101 Intensive Cellular Respiration Mock Exam Window',
      description:
        'Two-day mock exam window for Course A students.\nPB_COURSE_ID: [' +
        courseAId +
        ']',
      location: 'Online Assessment Portal',
      isAllDay: true,
      isRecurring: false,
      allDayStartDateBkk: mKey + '-25',
      allDayEndDateExclusiveBkk: mKey + '-27'
    },
    /* 6. Timed Event Crossing Midnight in Asia/Bangkok (22:30 on 18th to 01:00 on 19th ICT) */
    {
      eventId: 'evt_s13_midnight_crossing_course_a_' + mKey,
      title: 'BIO-101 Late-Night Olympiad Problem Marathon (Crosses Midnight)',
      description:
        'Starts 22:30 BKK on the 18th and finishes 01:00 BKK on the 19th.\nPB_COURSE_ID: [' +
        courseAId +
        ']',
      location: 'Live Online Classroom #1',
      isAllDay: false,
      isRecurring: false,
      startUtcIso: mKey + '-18T15:30:00.000Z', /* 2026-10-18 22:30 ICT (+07:00) */
      endUtcIso: mKey + '-18T18:00:00.000Z'    /* 2026-10-19 01:00 ICT (+07:00) */
    },
    /* 7A. Recurring Event Occurrence #1 (Weekly Lab Clinic - Week 1) */
    {
      eventId: 'evt_s13_recurring_clinic_series',
      title: 'BIO-101 Weekly Microscopy & Enzyme Q&A Clinic',
      description: 'Weekly recurring clinic.\nPB_COURSE_ID: [' + courseAId + ']',
      location: 'Lab Room 104',
      isAllDay: false,
      isRecurring: true,
      startUtcIso: mKey + '-06T10:00:00.000Z', /* 17:00 ICT (+07:00) on the 6th */
      endUtcIso: mKey + '-06T11:30:00.000Z'    /* 18:30 ICT (+07:00) on the 6th */
    },
    /* 7B. Recurring Event Occurrence #2 (Weekly Lab Clinic - Week 2) */
    {
      eventId: 'evt_s13_recurring_clinic_series',
      title: 'BIO-101 Weekly Microscopy & Enzyme Q&A Clinic',
      description: 'Weekly recurring clinic.\nPB_COURSE_ID: [' + courseAId + ']',
      location: 'Lab Room 104',
      isAllDay: false,
      isRecurring: true,
      startUtcIso: mKey + '-13T10:00:00.000Z', /* 17:00 ICT (+07:00) on the 13th */
      endUtcIso: mKey + '-13T11:30:00.000Z'    /* 18:30 ICT (+07:00) on the 13th */
    },
    /* 7C. Recurring Event Occurrence #3 (Weekly Lab Clinic - Week 3) */
    {
      eventId: 'evt_s13_recurring_clinic_series',
      title: 'BIO-101 Weekly Microscopy & Enzyme Q&A Clinic',
      description: 'Weekly recurring clinic.\nPB_COURSE_ID: [' + courseAId + ']',
      location: 'Lab Room 104',
      isAllDay: false,
      isRecurring: true,
      startUtcIso: mKey + '-20T10:00:00.000Z', /* 17:00 ICT (+07:00) on the 20th */
      endUtcIso: mKey + '-20T11:30:00.000Z'    /* 18:30 ICT (+07:00) on the 20th */
    },
    /* 8A. Invalid / Non-Existent Course UUID Marker (Must be hidden!) */
    {
      eventId: 'evt_s13_invalid_course_uuid_' + mKey,
      title: 'Event With Unknown Course UUID (Must Be Withheld)',
      description: 'PB_COURSE_ID: [crs_nonexistent_ghost_uuid_999999]',
      location: 'Room X',
      isAllDay: false,
      isRecurring: false,
      startUtcIso: mKey + '-15T03:00:00.000Z',
      endUtcIso: mKey + '-15T04:00:00.000Z'
    },
    /* 8B. Draft Course Event (Must be hidden from students!) */
    {
      eventId: 'evt_s13_draft_course_event_' + mKey,
      title: 'Draft Ecology Planning Session (Hidden From Students)',
      description: 'PB_COURSE_ID: [' + draftCourseId + ']',
      location: 'Room 401',
      isAllDay: false,
      isRecurring: false,
      startUtcIso: mKey + '-16T03:00:00.000Z',
      endUtcIso: mKey + '-16T04:00:00.000Z'
    },
    /* 8C. Loose Substring Mention Inside Prose (Must NOT be treated as a valid marker!) */
    {
      eventId: 'evt_s13_loose_substring_prose_' + mKey,
      title: 'Private Note Discussing PB_ALL_STUDENTS Marker Syntax',
      description:
        'Reminder to staff: do not put PB_ALL_STUDENTS or PB_COURSE_ID: [' +
        courseAId +
        '] in the middle of a sentence on private events.',
      location: 'Staff Room',
      isAllDay: false,
      isRecurring: false,
      startUtcIso: mKey + '-17T03:00:00.000Z',
      endUtcIso: mKey + '-17T04:00:00.000Z'
    }
  ];

  return {
    monthKey: mKey,
    courseAId: courseAId,
    courseBId: courseBId,
    draftCourseId: draftCourseId,
    specs: specs
  };
}

/**
 * Core backend implementation for `calendar.getEvents`.
 *
 * Security & Authorization Rules:
 * - Requires an authenticated `STUDENT` or `ADMIN` session with current Privacy Notice acknowledged.
 * - Validates `month` (`YYYY-MM`) or `startDate`/`endDate` (`YYYY-MM-DD`) in `Asia/Bangkok` (`<= 62` days).
 * - Reads the private Google Calendar configured in `Settings.CALENDAR_ID` or `ScriptProperties.CALENDAR_ID`.
 * - Strictly parses `PB_COURSE_ID: [course UUID]` and `PB_ALL_STUDENTS` markers.
 * - Filters out:
 *   1. All unmarked private events (`UNMARKED_PRIVATE`).
 *   2. All events with invalid or unknown course references (`INVALID_COURSE_REF` / `CONFLICTING_MARKERS`).
 *   3. For `STUDENT` callers (or when `ADMIN` previews a specific student's feed via `previewAsUserId`):
 *      any course event where `course.status !== 'PUBLISHED'` or the student does not hold an `ACTIVE`
 *      `Enrollments` row for `course_id`.
 * - Never returns attendee lists, guest emails, organizer emails, or raw descriptions.
 *
 * @param {Object} authContext Verified authentication context.
 * @param {Object} payload Request payload.
 * @return {Object} Authorized calendar events response for the requested month/range.
 */
function getAuthorizedClassCalendarEventsStep13_(authContext, payload) {
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to view the class calendar.'
    );
  }

  var req = payload && typeof payload === 'object' ? payload : {};
  var rangeInfo = validateAndResolveBangkokDateRangeStep13_(req);

  var callerUser = authContext.user;
  var callerRole = String(callerUser.role || 'STUDENT');
  var effectiveStudentUserId = callerUser.user_id;
  var isAdminFullView = false;

  if (callerRole === 'ADMIN') {
    var previewUid =
      req.previewAsUserId !== undefined && req.previewAsUserId !== null
        ? String(req.previewAsUserId).trim()
        : '';
    if (previewUid && previewUid !== 'ADMIN_ALL') {
      effectiveStudentUserId = previewUid;
      isAdminFullView = false;
    } else {
      isAdminFullView = true;
    }
  }

  /* 1. Load Courses and active Enrollments for the effective user */
  var coursesTbl = readSheetTable_('Courses');
  var coursesById = {};
  var publishedCoursesList = [];
  var adminCoursesReferenceList = [];

  for (var cIdx = 0; cIdx < coursesTbl.records.length; cIdx++) {
    var crs = coursesTbl.records[cIdx];
    var cidLower = String(crs.course_id || '')
      .trim()
      .toLowerCase();
    if (!cidLower) continue;
    coursesById[cidLower] = crs;
    if (crs.status === 'PUBLISHED') {
      publishedCoursesList.push(crs);
    }
    if (callerRole === 'ADMIN') {
      adminCoursesReferenceList.push({
        courseId: crs.course_id,
        courseCode: crs.course_code,
        title: crs.title,
        status: crs.status,
        calendarMarkerSyntax: 'PB_COURSE_ID: [' + crs.course_id + ']'
      });
    }
  }

  var enrolledCourseIdsMap = {};
  var enrolledCourseSummaries = [];
  if (!isAdminFullView) {
    var enrTbl = readSheetTable_('Enrollments');
    for (var eIdx = 0; eIdx < enrTbl.records.length; eIdx++) {
      var enr = enrTbl.records[eIdx];
      if (
        enr.user_id === effectiveStudentUserId &&
        enr.status === 'ACTIVE' &&
        enr.course_id
      ) {
        var normCid = String(enr.course_id).trim().toLowerCase();
        var linkedCourse = coursesById[normCid];
        if (linkedCourse && linkedCourse.status === 'PUBLISHED') {
          enrolledCourseIdsMap[normCid] = true;
          enrolledCourseSummaries.push({
            courseId: linkedCourse.course_id,
            courseCode: linkedCourse.course_code,
            title: linkedCourse.title
          });
        }
      }
    }
  } else {
    for (var pIdx = 0; pIdx < publishedCoursesList.length; pIdx++) {
      var pc = publishedCoursesList[pIdx];
      enrolledCourseIdsMap[String(pc.course_id).toLowerCase()] = true;
      enrolledCourseSummaries.push({
        courseId: pc.course_id,
        courseCode: pc.course_code,
        title: pc.title
      });
    }
  }

  /* 2. Fetch raw events from configured private Google Calendar (or test/demo fixtures when enabled) */
  var calConfig = resolveConfiguredCalendarIdStep13_();
  var rawEvents = [];
  var calendarSourceMode = 'LIVE_GOOGLE_CALENDAR';
  var calendarName = 'Pattanabhumi Biology Class Calendar';

  var fetchStartObj = new Date(rangeInfo.rangeStartUtcMs - 24 * 3600 * 1000);
  var fetchEndObj = new Date(rangeInfo.rangeEndUtcMs + 24 * 3600 * 1000);

  if (Array.isArray(req._testEventSpecs)) {
    calendarSourceMode = 'TEST_INJECTED_SPECS';
    for (var tIdx = 0; tIdx < req._testEventSpecs.length; tIdx++) {
      rawEvents.push(wrapRawEventSpecAsCalendarEventStep13_(req._testEventSpecs[tIdx]));
    }
  } else {
    var liveCalError = null;
    if (
      calConfig.configured &&
      typeof CalendarApp !== 'undefined' &&
      CalendarApp &&
      typeof CalendarApp.getCalendarById === 'function'
    ) {
      try {
        var calObj = CalendarApp.getCalendarById(calConfig.calendarId);
        if (calObj) {
          if (typeof calObj.getName === 'function') {
            calendarName = calObj.getName() || calendarName;
          }
          var fetched = calObj.getEvents(fetchStartObj, fetchEndObj) || [];
          for (var fIdx = 0; fIdx < fetched.length; fIdx++) {
            rawEvents.push(fetched[fIdx]);
          }
        } else {
          liveCalError = 'Calendar not found or inaccessible.';
        }
      } catch (calErr) {
        liveCalError = calErr && calErr.message ? calErr.message : String(calErr);
      }
    }

    /* If sample demonstration events were seeded by Admin (or if CalendarApp returned 0 events and sample mode is active), merge sample events for that month */
    var useSampleFallback = Boolean(req.includeSampleEvents);
    if (!useSampleFallback && PB_STEP13_IN_MEMORY_SAMPLE_EVENTS_ === true) {
      useSampleFallback = true;
    }
    if (!useSampleFallback) {
      try {
        var propsCheck = PropertiesService.getScriptProperties();
        if (propsCheck.getProperty('STEP13_SAMPLE_EVENTS_ENABLED') === 'TRUE') {
          useSampleFallback = true;
        }
      } catch (ignorePropErr) {}
    }

    if (useSampleFallback) {
      var sampleBundle = buildStep13CanonicalSampleEventSpecs_(
        rangeInfo.monthKey
      );
      for (var sIdx = 0; sIdx < sampleBundle.specs.length; sIdx++) {
        rawEvents.push(
          wrapRawEventSpecAsCalendarEventStep13_(sampleBundle.specs[sIdx])
        );
      }
      calendarSourceMode =
        rawEvents.length > sampleBundle.specs.length
          ? 'LIVE_CALENDAR_PLUS_STEP13_SAMPLE_EVENTS'
          : 'STEP13_SAMPLE_CALENDAR_EVENTS';
    } else if (liveCalError && !calConfig.configured) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_CONFIG_MISSING,
        'CALENDAR_ID is not configured in Settings or Script Properties.'
      );
    } else if (liveCalError && req.requireLiveCalendar === true) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_RESOURCE_INACCESSIBLE,
        'Unable to read configured private Google Calendar: ' + liveCalError
      );
    }
  }

  /* 2B. Merge web-created custom events and filter out web-deleted event IDs */
  if (!Array.isArray(req._testEventSpecs) && req.requireLiveCalendar !== true) {
    var customSpecs = readPortalCustomCalendarEventsStep13_();
    for (var cSpecIdx = 0; cSpecIdx < customSpecs.length; cSpecIdx++) {
      rawEvents.push(wrapRawEventSpecAsCalendarEventStep13_(customSpecs[cSpecIdx]));
    }
    var deletedIdsMap = readPortalDeletedCalendarEventIdsStep13_();
    if (deletedIdsMap && Object.keys(deletedIdsMap).length > 0) {
      var filteredRaw = [];
      for (var rIdx = 0; rIdx < rawEvents.length; rIdx++) {
        var rev = rawEvents[rIdx];
        var revId = rev && typeof rev.getId === 'function' ? String(rev.getId() || '') : '';
        var revTitle = rev && typeof rev.getTitle === 'function' ? String(rev.getTitle() || '').trim().toLowerCase() : '';
        if (!deletedIdsMap[revId] && !(revTitle && deletedIdsMap['title:' + revTitle])) {
          filteredRaw.push(rev);
        }
      }
      rawEvents = filteredRaw;
    }
  }

  /* 3. Bound raw events inspected and filter strictly by marker & course enrollment */
  var maxRawInspected =
    PB_APP_CONSTANTS_.MAX_CALENDAR_RAW_EVENTS_INSPECTED || 500;
  var maxReturned =
    PB_APP_CONSTANTS_.MAX_CALENDAR_AUTHORIZED_EVENTS_RETURNED || 200;
  var rawTruncated = rawEvents.length > maxRawInspected;
  var inspectCount = Math.min(rawEvents.length, maxRawInspected);

  var authorizedEvents = [];
  var eventsByDateBkk = {};
  var stats = {
    rawEventsInspected: inspectCount,
    authorizedEventsReturned: 0,
    courseEventsReturned: 0,
    schoolWideEventsReturned: 0,
    withheldUnmarkedCount: 0,
    withheldInvalidMarkerRefCount: 0,
    withheldUnauthorizedCourseCount: 0,
    withheldOutOfRangeCount: 0,
    queryBounded: true,
    truncated: false
  };

  for (var idx = 0; idx < inspectCount; idx++) {
    var ev = rawEvents[idx];
    if (!ev) continue;

    var rawDesc =
      typeof ev.getDescription === 'function' ? ev.getDescription() : '';
    var markerRes = parseAndValidateCalendarEventMarkersStep13_(
      rawDesc,
      coursesById
    );

    if (!markerRes.isAuthorizedMarker) {
      if (markerRes.markerType === 'UNMARKED_PRIVATE') {
        stats.withheldUnmarkedCount++;
      } else {
        stats.withheldInvalidMarkerRefCount++;
      }
      continue;
    }

    if (markerRes.markerType === 'COURSE') {
      var targetCourse = markerRes.courseRecord;
      var targetCidLower = String(markerRes.courseId || '').toLowerCase();
      if (!targetCourse) {
        stats.withheldInvalidMarkerRefCount++;
        continue;
      }
      if (!isAdminFullView) {
        if (
          targetCourse.status !== 'PUBLISHED' ||
          enrolledCourseIdsMap[targetCidLower] !== true
        ) {
          stats.withheldUnauthorizedCourseCount++;
          continue;
        }
      } else {
        if (targetCourse.status === 'ARCHIVED') {
          stats.withheldUnauthorizedCourseCount++;
          continue;
        }
      }
    }

    var dto = projectAuthorizedCalendarEventToBangkokDtoStep13_(
      ev,
      markerRes,
      rangeInfo,
      idx + 1
    );
    if (!dto) {
      stats.withheldOutOfRangeCount++;
      continue;
    }

    if (authorizedEvents.length >= maxReturned) {
      stats.truncated = true;
      break;
    }

    authorizedEvents.push(dto);
    if (dto.visibilityScope === 'COURSE') {
      stats.courseEventsReturned++;
    } else {
      stats.schoolWideEventsReturned++;
    }

    for (var sp = 0; sp < dto.spannedDatesInMonth.length; sp++) {
      var dayEntry = dto.spannedDatesInMonth[sp];
      var dayKey = dayEntry.dateBkk;
      if (!eventsByDateBkk[dayKey]) {
        eventsByDateBkk[dayKey] = [];
      }
      eventsByDateBkk[dayKey].push({
        occurrenceId: dto.occurrenceId,
        eventId: dto.eventId,
        title: dto.title,
        visibilityScope: dto.visibilityScope,
        scopeBadgeLabel: dto.scopeBadgeLabel,
        courseId: dto.courseId,
        courseCode: dto.courseCode,
        courseTitle: dto.courseTitle,
        isAllDay: dto.isAllDay,
        isMultiDay: dto.isMultiDay,
        crossesMidnight: dto.crossesMidnight,
        isRecurring: dto.isRecurring,
        dayIndex: dayEntry.dayIndex,
        totalDays: dayEntry.totalDays,
        dayTimeLabelBkk: dayEntry.dayTimeLabelBkk,
        location: dto.location,
        sortEpochMs: dto.sortEpochMs
      });
    }
  }

  /* Sort authorized events chronologically by sortEpochMs then title */
  authorizedEvents.sort(function (a, b) {
    if (a.sortEpochMs !== b.sortEpochMs) {
      return a.sortEpochMs - b.sortEpochMs;
    }
    return String(a.title).localeCompare(String(b.title));
  });

  var dateKeys = Object.keys(eventsByDateBkk);
  for (var dk = 0; dk < dateKeys.length; dk++) {
    eventsByDateBkk[dateKeys[dk]].sort(function (a, b) {
      if (a.isAllDay !== b.isAllDay) {
        return a.isAllDay ? -1 : 1;
      }
      if (a.sortEpochMs !== b.sortEpochMs) {
        return a.sortEpochMs - b.sortEpochMs;
      }
      return String(a.title).localeCompare(String(b.title));
    });
  }

  stats.authorizedEventsReturned = authorizedEvents.length;
  if (rawTruncated) {
    stats.truncated = true;
  }

  var responseObj = {
    range: rangeInfo,
    calendarDisplayName: calendarName,
    timezone: 'Asia/Bangkok',
    timezoneDisplayLabel: 'Asia/Bangkok (UTC+07:00 / ICT)',
    viewerRole: callerRole,
    effectiveViewerMode: isAdminFullView
      ? 'ADMIN_ALL_COURSES'
      : 'STUDENT_ENROLLED_ONLY',
    effectiveStudentUserId: isAdminFullView ? '' : effectiveStudentUserId,
    enrolledCourses: enrolledCourseSummaries,
    events: authorizedEvents,
    eventsByDateBkk: eventsByDateBkk,
    stats: stats,
    privacyAndSecurityGuarantee: {
      calendarKeptPrivate: true,
      publicIframeUsed: false,
      attendeeDataWithheld: true,
      privateDescriptionsWithheld: true,
      unmarkedEventsHidden: true
    },
    beginnerInstructions: [
      '1. Locate the course ID in Admin (Admin Dashboard -> 3. Courses, Sections & Cards -> copy PB_COURSE_ID: [crs_...]).',
      '2. Create the event in the correct private Google Calendar configured for Pattanabhumi Biology.',
      '3. Add the marker on its own line in the event Description: PB_COURSE_ID: [course UUID] (for a course) or PB_ALL_STUDENTS (for all students).',
      '4. Save the event in Google Calendar (keep the calendar Private - never make it public).',
      '5. Open the event month in the Class Calendar page on this website.',
      '6. Test using enrolled and non-enrolled student accounts to confirm course-level isolation.'
    ]
  };

  if (callerRole === 'ADMIN') {
    responseObj.adminDiagnostics = {
      calendarIdConfigured: calConfig.configured,
      calendarIdSource: calConfig.source,
      calendarIdMaskedOrFull: calConfig.calendarId || '(Not Set)',
      calendarSourceMode: calendarSourceMode,
      coursesReferenceList: adminCoursesReferenceList
    };
  }

  return responseObj;
}

function handleCalendarGetEventsStep13_(payload, context) {
  return getAuthorizedClassCalendarEventsStep13_(context.authContext, payload);
}

/**
 * Administrator helper (`admin.seedStep13SampleCalendarEvents`) that seeds the Step 9/13
 * learning cohort if needed and enables the Step 13 sample calendar events for immediate
 * browser testing across `student_a`, `student_b`, `student_c`, and `ADMIN`.
 */
function adminSeedStep13SampleCalendarEvents_(authContext, payload) {
  if (!authContext || !authContext.user || authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Only an administrator can enable or seed sample calendar events.'
    );
  }
  var req = payload && typeof payload === 'object' ? payload : {};
  if (typeof adminSeedStep9LearningCohort_ === 'function') {
    adminSeedStep9LearningCohort_(authContext, {});
  }

  var enableFlag = req.enabled !== false;
  PB_STEP13_IN_MEMORY_SAMPLE_EVENTS_ = enableFlag;
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty(
      'STEP13_SAMPLE_EVENTS_ENABLED',
      enableFlag ? 'TRUE' : 'FALSE'
    );
  } catch (ignoreErr) {}

  var monthKey =
    typeof req.month === 'string' && /^\d{4}-\d{2}$/.test(req.month)
      ? req.month
      : formatUtcMsToBangkokDateStrStep13_(Date.now()).slice(0, 7);
  var bundle = buildStep13CanonicalSampleEventSpecs_(monthKey);

  recordAuditEvent_({
    actorUserId: authContext.user.user_id,
    actorRole: 'ADMIN',
    eventType: 'ADMIN_CALENDAR_SAMPLE_EVENTS_CONFIGURED',
    targetEntityType: 'Calendar',
    targetEntityId: monthKey,
    summary: {
      monthKey: monthKey,
      sampleEventsEnabled: enableFlag,
      sampleSpecsCount: bundle.specs.length,
      courseAId: bundle.courseAId,
      courseBId: bundle.courseBId
    }
  });

  return {
    sampleEventsEnabled: enableFlag,
    monthKey: monthKey,
    courseAId: bundle.courseAId,
    courseBId: bundle.courseBId,
    draftCourseId: bundle.draftCourseId,
    sampleSpecsCount: bundle.specs.length,
    savedMessage: enableFlag
      ? 'Enabled Step 13 sample calendar events for ' +
        monthKey +
        ' (Course A: ' +
        bundle.courseAId +
        ', Course B: ' +
        bundle.courseBId +
        ', School-Wide: PB_ALL_STUDENTS, plus unmarked/invalid/draft negative test events).'
      : 'Disabled Step 13 sample calendar events (using live Google Calendar only).'
  };
}

function handleAdminSeedStep13SampleCalendarEvents_(payload, context) {
  return adminSeedStep13SampleCalendarEvents_(context.authContext, payload);
}

/**
 * Step 13 Automated Verification Suite (`admin.runStep13VerificationSuite`).
 * Executes all 8 required Step 13 Class Calendar verification scenarios:
 * 1. Course event (`PB_COURSE_ID: [courseA_id]` visible to enrolled Student A, hidden from Student B & C;
 *    private descriptions & attendee lists stripped).
 * 2. School-wide event (`PB_ALL_STUDENTS` visible to Student A, Student B, and unenrolled Student C).
 * 3. Unmarked private event (strictly hidden from all students and withheld; loose prose substring also withheld).
 * 4. Another course's event (`PB_COURSE_ID: [courseB_id]` visible to Student B, hidden from Student A;
 *    `DRAFT` and unknown course UUIDs also hidden).
 * 5. All-day event (single-day on 23rd and multi-day 25th..26th inclusive from exclusive end 27th in `Asia/Bangkok`).
 * 6. Event crossing midnight (`22:30` on 18th to `01:00` on 19th in `Asia/Bangkok`, projected onto both days).
 * 7. Recurring event (3 weekly recurring occurrences expanded in the requested month with `isRecurring: true`).
 * 8. Invalid requested date range (`month: '2026-13'`, `endDate < startDate`, and `> 62` day range rejected with `ERR_VALIDATION_FAILED`).
 */
function adminRunStep13VerificationSuite_(authContext, payload) {
  if (!authContext || !authContext.user || authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Only an administrator can run the Step 13 verification suite.'
    );
  }

  if (typeof adminSeedStep9LearningCohort_ === 'function') {
    adminSeedStep9LearningCohort_(authContext, {});
  }

  var usersTbl = readSheetTable_('Users');
  var studentA = null;
  var studentB = null;
  var studentC = null;
  for (var i = 0; i < usersTbl.records.length; i++) {
    var u = usersTbl.records[i];
    if (u.username_lower === 'student_a') studentA = u;
    if (u.username_lower === 'student_b') studentB = u;
    if (u.username_lower === 'student_c') studentC = u;
  }
  if (!studentA || !studentB || !studentC) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Step 9 sample students (student_a, student_b, student_c) are required for Step 13 verification.'
    );
  }

  var stuACtx = { user: studentA, session: { session_id: 'ses_s13_stua' } };
  var stuBCtx = { user: studentB, session: { session_id: 'ses_s13_stub' } };
  var stuCCtx = { user: studentC, session: { session_id: 'ses_s13_stuc' } };

  var testMonth = '2026-10';
  var sampleBundle = buildStep13CanonicalSampleEventSpecs_(testMonth);
  var specs = sampleBundle.specs;

  /* Query calendar for Student A, Student B, and Student C */
  var resA = getAuthorizedClassCalendarEventsStep13_(stuACtx, {
    month: testMonth,
    _testEventSpecs: specs
  });
  var resB = getAuthorizedClassCalendarEventsStep13_(stuBCtx, {
    month: testMonth,
    _testEventSpecs: specs
  });
  var resC = getAuthorizedClassCalendarEventsStep13_(stuCCtx, {
    month: testMonth,
    _testEventSpecs: specs
  });

  function hasEventId(resObj, targetEventId) {
    var list = (resObj && resObj.events) || [];
    for (var k = 0; k < list.length; k++) {
      if (list[k].eventId === targetEventId) return true;
    }
    return false;
  }

  function findEventsByEventId(resObj, targetEventId) {
    var list = (resObj && resObj.events) || [];
    var matches = [];
    for (var k = 0; k < list.length; k++) {
      if (list[k].eventId === targetEventId) matches.push(list[k]);
    }
    return matches;
  }

  var report = {
    suite: 'STEP_13_CLASS_CALENDAR_AND_AUTHORIZATION_VERIFICATION',
    executedAtUtc: nowUtcIso_(),
    executedAtBangkok: formatBangkokTimestamp_(new Date()),
    testMonth: testMonth,
    courseAId: sampleBundle.courseAId,
    courseBId: sampleBundle.courseBId,
    tests: {}
  };

  /* Test 1: Course Event (Course A visible to Student A, hidden from Student B & C; no description/attendees leaked) */
  var courseAEventId = 'evt_s13_course_a_lecture_' + testMonth;
  var courseAEventsForA = findEventsByEventId(resA, courseAEventId);
  var courseAEventDto = courseAEventsForA[0] || null;
  var noPrivateDataLeaked =
    Boolean(courseAEventDto) &&
    courseAEventDto.description === undefined &&
    courseAEventDto.guests === undefined &&
    courseAEventDto.attendees === undefined &&
    JSON.stringify(courseAEventDto).indexOf('998877') === -1 &&
    JSON.stringify(courseAEventDto).indexOf('private.student.guest') === -1;

  report.tests.test1_courseEventAuthorizedAndSanitized = {
    passed:
      hasEventId(resA, courseAEventId) === true &&
      hasEventId(resB, courseAEventId) === false &&
      hasEventId(resC, courseAEventId) === false &&
      noPrivateDataLeaked === true &&
      courseAEventDto.timeLabelBkk === '09:00 - 11:00 ICT',
    visibleToStudentA: hasEventId(resA, courseAEventId),
    visibleToStudentB: hasEventId(resB, courseAEventId),
    visibleToStudentC: hasEventId(resC, courseAEventId),
    noPrivateDescriptionOrAttendeesLeaked: noPrivateDataLeaked,
    timeLabelBkk: courseAEventDto ? courseAEventDto.timeLabelBkk : ''
  };

  /* Test 2: School-Wide Event (PB_ALL_STUDENTS visible to Student A, B, and C) */
  var schoolWideId = 'evt_s13_school_wide_orientation_' + testMonth;
  report.tests.test2_schoolWideEventVisibleToAllStudents = {
    passed:
      hasEventId(resA, schoolWideId) === true &&
      hasEventId(resB, schoolWideId) === true &&
      hasEventId(resC, schoolWideId) === true,
    visibleToStudentA: hasEventId(resA, schoolWideId),
    visibleToStudentB: hasEventId(resB, schoolWideId),
    visibleToStudentC: hasEventId(resC, schoolWideId)
  };

  /* Test 3: Unmarked Private Event & Loose Prose Mention (Hidden from all students) */
  var unmarkedId = 'evt_s13_unmarked_private_staff_' + testMonth;
  var looseProseId = 'evt_s13_loose_substring_prose_' + testMonth;
  report.tests.test3_unmarkedPrivateEventHidden = {
    passed:
      hasEventId(resA, unmarkedId) === false &&
      hasEventId(resB, unmarkedId) === false &&
      hasEventId(resC, unmarkedId) === false &&
      hasEventId(resA, looseProseId) === false &&
      resA.stats.withheldUnmarkedCount >= 2,
    unmarkedVisibleToAnyStudent:
      hasEventId(resA, unmarkedId) ||
      hasEventId(resB, unmarkedId) ||
      hasEventId(resC, unmarkedId),
    looseProseMentionHidden: !hasEventId(resA, looseProseId),
    withheldUnmarkedCount: resA.stats.withheldUnmarkedCount
  };

  /* Test 4: Another Course's Event (Course B visible to Student B, hidden from Student A & C; Draft & Unknown UUID hidden) */
  var courseBEventId = 'evt_s13_course_b_genetics_lab_' + testMonth;
  var invalidUuidEventId = 'evt_s13_invalid_course_uuid_' + testMonth;
  var draftCourseEventId = 'evt_s13_draft_course_event_' + testMonth;
  report.tests.test4_anotherCoursesEventIsolated = {
    passed:
      hasEventId(resB, courseBEventId) === true &&
      hasEventId(resA, courseBEventId) === false &&
      hasEventId(resC, courseBEventId) === false &&
      hasEventId(resA, invalidUuidEventId) === false &&
      hasEventId(resA, draftCourseEventId) === false,
    courseBVisibleToStudentB: hasEventId(resB, courseBEventId),
    courseBVisibleToStudentA: hasEventId(resA, courseBEventId),
    courseBVisibleToStudentC: hasEventId(resC, courseBEventId),
    invalidUuidEventHidden: !hasEventId(resA, invalidUuidEventId),
    draftCourseEventHidden: !hasEventId(resA, draftCourseEventId)
  };

  /* Test 5: All-Day Event (Single-day on 23rd and Multi-day 25th..26th inclusive) */
  var allDaySingleDto = findEventsByEventId(
    resA,
    'evt_s13_allday_single_' + testMonth
  )[0];
  var allDayMultiDto = findEventsByEventId(
    resA,
    'evt_s13_allday_multiday_course_a_' + testMonth
  )[0];
  var day23List = resA.eventsByDateBkk[testMonth + '-23'] || [];
  var day25List = resA.eventsByDateBkk[testMonth + '-25'] || [];
  var day26List = resA.eventsByDateBkk[testMonth + '-26'] || [];
  var day27List = resA.eventsByDateBkk[testMonth + '-27'] || [];
  var multiOn27 = false;
  for (var m27 = 0; m27 < day27List.length; m27++) {
    if (
      day27List[m27].eventId ===
      'evt_s13_allday_multiday_course_a_' + testMonth
    ) {
      multiOn27 = true;
    }
  }

  report.tests.test5_allDaySingleAndMultiDayEvents = {
    passed:
      Boolean(allDaySingleDto) &&
      allDaySingleDto.isAllDay === true &&
      allDaySingleDto.startDateBkk === testMonth + '-23' &&
      allDaySingleDto.endDateBkk === testMonth + '-23' &&
      day23List.length >= 1 &&
      Boolean(allDayMultiDto) &&
      allDayMultiDto.isAllDay === true &&
      allDayMultiDto.isMultiDay === true &&
      allDayMultiDto.startDateBkk === testMonth + '-25' &&
      allDayMultiDto.endDateBkk === testMonth + '-26' &&
      day25List.length >= 1 &&
      day26List.length >= 1 &&
      multiOn27 === false,
    singleAllDayDate: allDaySingleDto ? allDaySingleDto.startDateBkk : '',
    multiAllDaySpan: allDayMultiDto
      ? allDayMultiDto.startDateBkk + '..' + allDayMultiDto.endDateBkk
      : '',
    exclusiveEndDateCorrectlyExcluded: !multiOn27
  };

  /* Test 6: Event Crossing Midnight in Asia/Bangkok (22:30 on 18th to 01:00 on 19th ICT) */
  var midnightDto = findEventsByEventId(
    resA,
    'evt_s13_midnight_crossing_course_a_' + testMonth
  )[0];
  var day18Events = resA.eventsByDateBkk[testMonth + '-18'] || [];
  var day19Events = resA.eventsByDateBkk[testMonth + '-19'] || [];
  var foundOn18 = false;
  var foundOn19 = false;
  for (var d18 = 0; d18 < day18Events.length; d18++) {
    if (day18Events[d18].eventId === 'evt_s13_midnight_crossing_course_a_' + testMonth) {
      foundOn18 = true;
    }
  }
  for (var d19 = 0; d19 < day19Events.length; d19++) {
    if (day19Events[d19].eventId === 'evt_s13_midnight_crossing_course_a_' + testMonth) {
      foundOn19 = true;
    }
  }

  report.tests.test6_eventCrossingMidnightBangkok = {
    passed:
      Boolean(midnightDto) &&
      midnightDto.crossesMidnight === true &&
      midnightDto.startDateBkk === testMonth + '-18' &&
      midnightDto.endDateBkk === testMonth + '-19' &&
      midnightDto.startTimeBkk === '22:30' &&
      midnightDto.endTimeBkk === '01:00' &&
      foundOn18 === true &&
      foundOn19 === true,
    startDateBkk: midnightDto ? midnightDto.startDateBkk : '',
    endDateBkk: midnightDto ? midnightDto.endDateBkk : '',
    startTimeBkk: midnightDto ? midnightDto.startTimeBkk : '',
    endTimeBkk: midnightDto ? midnightDto.endTimeBkk : '',
    projectedOnBothDays: foundOn18 && foundOn19
  };

  /* Test 7: Recurring Event (3 weekly occurrences expanded in month) */
  var recurringMatches = findEventsByEventId(
    resA,
    'evt_s13_recurring_clinic_series'
  );
  report.tests.test7_recurringEventOccurrencesExpanded = {
    passed:
      recurringMatches.length === 3 &&
      recurringMatches[0].isRecurring === true &&
      recurringMatches[0].occurrenceId !== recurringMatches[1].occurrenceId &&
      recurringMatches[1].occurrenceId !== recurringMatches[2].occurrenceId,
    occurrencesCount: recurringMatches.length,
    occurrenceDates: recurringMatches.map(function (r) {
      return r.startDateBkk;
    })
  };

  /* Test 8: Invalid Requested Date Range Rejected (malformed month, reversed dates, > 62 days) */
  var badMonthCode = '';
  var reversedRangeCode = '';
  var oversizedRangeCode = '';
  try {
    getAuthorizedClassCalendarEventsStep13_(stuACtx, { month: '2026-13' });
  } catch (e1) {
    badMonthCode = e1.code || '';
  }
  try {
    getAuthorizedClassCalendarEventsStep13_(stuACtx, {
      startDate: '2026-10-20',
      endDate: '2026-10-10'
    });
  } catch (e2) {
    reversedRangeCode = e2.code || '';
  }
  try {
    getAuthorizedClassCalendarEventsStep13_(stuACtx, {
      startDate: '2026-01-01',
      endDate: '2026-05-01'
    });
  } catch (e3) {
    oversizedRangeCode = e3.code || '';
  }

  report.tests.test8_invalidDateRangesRejected = {
    passed:
      badMonthCode === 'ERR_VALIDATION_FAILED' &&
      reversedRangeCode === 'ERR_VALIDATION_FAILED' &&
      oversizedRangeCode === 'ERR_VALIDATION_FAILED',
    badMonthErrorCode: badMonthCode,
    reversedRangeErrorCode: reversedRangeCode,
    oversizedRangeErrorCode: oversizedRangeCode
  };

  /* Also enable the sample events for interactive UI inspection */
  adminSeedStep13SampleCalendarEvents_(authContext, {
    month: testMonth,
    enabled: true
  });

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

function handleAdminRunStep13VerificationSuite_(payload, context) {
  return withIsolatedSyntheticSandboxStep15_(function () {
    return adminRunStep13VerificationSuite_(context.authContext, payload);
  });
}

/* ==========================================================================
 * STEP 14: REPORT UNAVAILABILITY (STUDENT SUBMISSION, IDEMPOTENCY, RATE LIMIT,
 * RECORD-BEFORE-SEND, HEADER SANITIZATION, HONEST EMAIL STATUS & ADMIN VIEW)
 * ========================================================================== */

/**
 * In-memory fallback registry for uncertain post-send email outcomes when the
 * post-send Google Sheets write fails after `MailApp.sendEmail` has already succeeded.
 * Keyed by `request_id`.
 */
var PB_STEP14_UNCERTAIN_OUTCOMES_MEM_ = {};

/**
 * Test/inspection log of emails transmitted through `sendUnavailabilityNotificationEmailStep14_`
 * during the current execution context.
 */
var PB_STEP14_SENT_EMAIL_LOG_ = [];

/**
 * Parses the structured idempotency & retry metadata prefix stored in `admin_note`
 * on `UnavailabilityRequests` rows:
 *   `[IDEM:<idempotencyKey>|HASH:<payloadHash>|RETRIES:<retryCount>] <optional human admin note>`
 *
 * This preserves the exact 13-column schema of `UnavailabilityRequests` in `Config.gs`
 * while persisting idempotency keys, payload hashes, and retry counters in the database.
 *
 * @param {string} rawAdminNote Raw `admin_note` cell string.
 * @return {{ idempotencyKey: string, payloadHash: string, retryCount: number, cleanAdminNote: string }}
 */
function parseUnavailabilityMetadataPrefixStep14_(rawAdminNote) {
  var str = rawAdminNote !== undefined && rawAdminNote !== null ? String(rawAdminNote) : '';
  var match = /^\[IDEM:([^|\]\r\n]+)\|HASH:([a-f0-9]{16,64})\|RETRIES:(\d+)\]\s*(.*)$/s.exec(str);
  if (!match) {
    return {
      idempotencyKey: '',
      payloadHash: '',
      retryCount: 0,
      cleanAdminNote: str.trim()
    };
  }
  var parsedRetries = parseInt(match[3], 10);
  return {
    idempotencyKey: String(match[1] || '').trim(),
    payloadHash: String(match[2] || '').trim(),
    retryCount: isNaN(parsedRetries) || parsedRetries < 0 ? 0 : parsedRetries,
    cleanAdminNote: String(match[4] || '').trim()
  };
}

/**
 * Formats the structured metadata prefix and human administrator note for `UnavailabilityRequests.admin_note`.
 *
 * @param {{ idempotencyKey: string, payloadHash: string, retryCount: number }} metaObj
 * @param {string} cleanAdminNote Human-readable administrator note.
 * @return {string} Combined string for `admin_note` column.
 */
function buildUnavailabilityMetadataPrefixStep14_(metaObj, cleanAdminNote) {
  var idem = String((metaObj && metaObj.idempotencyKey) || 'none').replace(/[|\]\r\n]/g, '_');
  var hash = String((metaObj && metaObj.payloadHash) || '0000000000000000').replace(/[^a-f0-9]/gi, '');
  if (hash.length < 16) {
    hash = (hash + '0000000000000000').slice(0, 16);
  }
  var retries = Number((metaObj && metaObj.retryCount) || 0);
  if (isNaN(retries) || retries < 0) retries = 0;

  var prefix = '[IDEM:' + idem + '|HASH:' + hash + '|RETRIES:' + String(Math.floor(retries)) + ']';
  var noteTrimmed = cleanAdminNote !== undefined && cleanAdminNote !== null
    ? sanitizeTextBasic_(String(cleanAdminNote), 1000)
    : '';
  return noteTrimmed ? prefix + ' ' + noteTrimmed : prefix;
}

/**
 * Sanitizes any string before inclusion in an email header (`Subject`) so CR/LF header injection
 * (`\r`, `\n`, `\0`, `Bcc:`, `Cc:`, `To:`) is impossible.
 *
 * @param {string} rawValue Raw string.
 * @param {number=} opt_maxLen Maximum length (default 120).
 * @return {string} Single-line ASCII-safe token with all CR/LF and control characters stripped.
 */
function sanitizeEmailHeaderTokenStep14_(rawValue, opt_maxLen) {
  var maxLen = opt_maxLen && opt_maxLen > 0 ? opt_maxLen : 120;
  if (rawValue === undefined || rawValue === null) return '';
  var cleaned = String(rawValue)
    .replace(/[\r\n\0\x00-\x1F\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen).trim();
  }
  return cleaned;
}

/**
 * Reads the school notification recipient address strictly from server-side settings
 * (`Settings.ADMIN_NOTIFICATION_EMAIL` or fallback `ScriptProperties.ADMIN_NOTIFICATION_EMAIL`).
 * Never uses any student-supplied email address as the recipient.
 *
 * @param {Object=} opt_testOverrides Optional test flags (`_simulateRecipientUnconfigured`).
 * @return {{ recipientEmail: string, configured: boolean, source: string }}
 */
function resolveNotificationRecipientEmailStep14_(opt_testOverrides) {
  if (opt_testOverrides && opt_testOverrides._simulateRecipientUnconfigured === true) {
    return {
      recipientEmail: 'UNCONFIGURED',
      configured: false,
      source: 'SIMULATED_UNCONFIGURED'
    };
  }

  var candidate = '';
  var source = 'UNCONFIGURED';
  try {
    var settingsTbl = readSheetTable_('Settings');
    if (
      settingsTbl &&
      settingsTbl.byId &&
      settingsTbl.byId.ADMIN_NOTIFICATION_EMAIL &&
      settingsTbl.byId.ADMIN_NOTIFICATION_EMAIL.record &&
      settingsTbl.byId.ADMIN_NOTIFICATION_EMAIL.record.setting_value
    ) {
      var rawVal = String(
        settingsTbl.byId.ADMIN_NOTIFICATION_EMAIL.record.setting_value
      ).trim();
      if (
        rawVal &&
        rawVal.toLowerCase() !== 'placeholder_admin_notify@example.com'
      ) {
        candidate = rawVal;
        source = 'SETTINGS_SHEET';
      }
    }
  } catch (ignoreSettingsErr) {}

  if (!candidate) {
    try {
      var props = PropertiesService.getScriptProperties();
      var propVal = String(props.getProperty('ADMIN_NOTIFICATION_EMAIL') || '').trim();
      if (
        propVal &&
        propVal.toLowerCase() !== 'placeholder_admin_notify@example.com'
      ) {
        candidate = propVal;
        source = 'SCRIPT_PROPERTIES';
      }
    } catch (ignorePropsErr) {}
  }

  if (!candidate && PB_APP_CONSTANTS_.CONTACT_DEFAULTS && PB_APP_CONSTANTS_.CONTACT_DEFAULTS.email) {
    candidate = PB_APP_CONSTANTS_.CONTACT_DEFAULTS.email;
    source = 'CONTACT_DEFAULTS';
  }

  /* Validate email syntax and ensure zero CR/LF characters */
  var emailClean = sanitizeEmailHeaderTokenStep14_(candidate, 254);
  var emailRegex = /^[^\s@<>,;:"'\\]+@[^\s@<>,;:"'\\]+\.[^\s@<>,;:"'\\]+$/;
  if (!emailClean || !emailRegex.test(emailClean)) {
    return {
      recipientEmail: 'UNCONFIGURED',
      configured: false,
      source: 'UNCONFIGURED'
    };
  }

  return {
    recipientEmail: emailClean,
    configured: true,
    source: source
  };
}

/**
 * Returns the architectural explanation required by Step 14 regarding how `MailApp`
 * sends unavailability notifications in Google Apps Script.
 *
 * @param {string=} opt_configuredRecipient Currently configured recipient address.
 * @return {Object} Structured explanation object.
 */
function getUnavailabilityEmailArchitectureExplanationStep14_(opt_configuredRecipient) {
  var resolved = opt_configuredRecipient
    ? { recipientEmail: opt_configuredRecipient }
    : resolveNotificationRecipientEmailStep14_({});
  var effectiveSellerAccount = 'Authorized Google Account running the Apps Script deployment (Execution Identity)';
  try {
    if (
      typeof Session !== 'undefined' &&
      Session &&
      typeof Session.getEffectiveUser === 'function'
    ) {
      var effEmail = String(Session.getEffectiveUser().getEmail() || '').trim();
      if (effEmail) {
        effectiveSellerAccount = effEmail + ' (Google account under which Apps Script is authorized to run)';
      }
    }
  } catch (ignoreSessionErr) {}

  return {
    senderExplanation:
      'Sender is the Google account under which the Google Apps Script web app is authorized to run (' +
      effectiveSellerAccount +
      ') via Apps Script MailApp.',
    recipientExplanation:
      'Recipient is strictly the school notification address configured on the server in Settings.ADMIN_NOTIFICATION_EMAIL (' +
      (resolved.recipientEmail || 'UNCONFIGURED') +
      '). Arbitrary recipient addresses from the browser are never accepted.',
    noPasswordStoredExplanation:
      'No Gmail password, SMTP password, or OAuth client secret belongs in or is stored anywhere in the application code, Script Properties, or Google Sheets.',
    deliveryGuaranteeExplanation:
      'Requests are recorded in UnavailabilityRequests (PENDING_ATTEMPT) BEFORE MailApp.sendEmail is called. Because email protocols do not support two-phase commit with Google Sheets, the portal never promises exactly-once delivery: if MailApp.sendEmail succeeds but updating the row to SENT fails, the status is marked UNCERTAIN_POST_SEND_UPDATE_FAILED and automatic/manual resends are blocked to prevent duplicate emails.',
    nonCancellationNotice:
      'Submitting an unavailability report notifies the school administration and instructor of your planned absence, but does NOT automatically cancel, reschedule, or excuse a scheduled class session.'
  };
}

/**
 * Validates and normalizes the student unavailability request payload (`calendar.submitUnavailability`),
 * deriving student identity strictly from `authContext.user`.
 *
 * @param {Object} authContext Verified authentication context.
 * @param {Object} req Raw request payload.
 * @return {Object} Validated & normalized request descriptor.
 */
function sanitizeTextBasic_(rawStr, opt_maxLen) {
  var maxLen = opt_maxLen && opt_maxLen > 0 ? opt_maxLen : 1000;
  if (rawStr === undefined || rawStr === null) return '';
  var s = String(rawStr)
    .replace(/[--]/g, '')
    .trim();
  if (s.length > maxLen) {
    s = s.slice(0, maxLen).trim();
  }
  return s;
}

function validateIdempotencyKey_(rawKey) {
  var k = rawKey !== undefined && rawKey !== null ? String(rawKey).trim() : '';
  if (!k || k.length < 8 || k.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(k)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'idempotencyKey must be 8..80 characters containing only letters, digits, underscores, hyphens, dots, or colons.'
    );
  }
  return k;
}

function parseStrictBangkokYmdStep13_(rawStr) {
  if (rawStr === undefined || rawStr === null) return null;
  var s = String(rawStr).trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  var y = parseInt(m[1], 10);
  var mo = parseInt(m[2], 10);
  var d = parseInt(m[3], 10);
  if (!isValidCalendarYmdStep13_(y, mo, d)) return null;
  return { year: y, month: mo, day: d, dateStr: s };
}

function validateUnavailabilityRequestInputStep14_(authContext, req) {
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to submit an unavailability report.'
    );
  }

  var callerUser = authContext.user;
  var payload = req && typeof req === 'object' ? req : {};
  var fieldErrors = {};

  /* Detect and ignore any attempt by client to supply arbitrary recipient/header fields */
  var clientSuppliedRecipientIgnored = Boolean(
    payload.to !== undefined ||
      payload.recipient !== undefined ||
      payload.emailRecipient !== undefined ||
      payload.cc !== undefined ||
      payload.bcc !== undefined ||
      payload.subject !== undefined
  );

  /* Detect if client attempted to spoof another userId */
  if (
    payload.userId !== undefined &&
    payload.userId !== null &&
    String(payload.userId).trim() !== '' &&
    String(payload.userId).trim() !== callerUser.user_id
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Student identity is derived strictly from your authenticated session; submitting on behalf of another user_id is forbidden.'
    );
  }

  /* 1. Validate Unavailable Start Date & End Date in Asia/Bangkok (YYYY-MM-DD) */
  var rawStart =
    payload.unavailableStartDateBkk !== undefined &&
    payload.unavailableStartDateBkk !== null &&
    String(payload.unavailableStartDateBkk).trim() !== ''
      ? String(payload.unavailableStartDateBkk).trim()
      : payload.unavailableDate !== undefined && payload.unavailableDate !== null
      ? String(payload.unavailableDate).trim()
      : '';

  var rawEnd =
    payload.unavailableEndDateBkk !== undefined &&
    payload.unavailableEndDateBkk !== null &&
    String(payload.unavailableEndDateBkk).trim() !== ''
      ? String(payload.unavailableEndDateBkk).trim()
      : rawStart;

  var parsedStart = parseStrictBangkokYmdStep13_(rawStart);
  var parsedEnd = parseStrictBangkokYmdStep13_(rawEnd);

  if (!parsedStart) {
    fieldErrors.unavailableStartDateBkk =
      'Unavailable date must be a valid calendar date in YYYY-MM-DD format (Asia/Bangkok, years 2020..2035).';
  }
  if (!parsedEnd) {
    fieldErrors.unavailableEndDateBkk =
      'Unavailable end date must be a valid calendar date in YYYY-MM-DD format (Asia/Bangkok, years 2020..2035).';
  }

  var spanDays = 1;
  if (parsedStart && parsedEnd) {
    if (parsedEnd.dateStr < parsedStart.dateStr) {
      fieldErrors.unavailableEndDateBkk =
        'Unavailable end date (' +
        parsedEnd.dateStr +
        ') cannot be earlier than start date (' +
        parsedStart.dateStr +
        ').';
    } else {
      var startMs = bangkokYmdStartToUtcMsStep13_(parsedStart.dateStr);
      var endMs = bangkokYmdStartToUtcMsStep13_(parsedEnd.dateStr);
      spanDays = Math.round((endMs - startMs) / (24 * 3600 * 1000)) + 1;
      var maxSpan = PB_APP_CONSTANTS_.UNAVAILABILITY_MAX_SPAN_DAYS || 30;
      if (spanDays > maxSpan) {
        fieldErrors.unavailableEndDateBkk =
          'Single unavailability report span (' +
          spanDays +
          ' days) exceeds the maximum allowed ' +
          maxSpan +
          '-day window.';
      }
    }
  }

  /* 2. Validate Reason (5..1,000 characters) */
  var minReasonChars = PB_APP_CONSTANTS_.UNAVAILABILITY_REASON_MIN_CHARS || 5;
  var maxReasonChars = PB_APP_CONSTANTS_.UNAVAILABILITY_REASON_MAX_CHARS || 1000;
  var rawReason =
    payload.reason !== undefined && payload.reason !== null
      ? String(payload.reason)
      : '';
  /* Strip null bytes & non-printable control chars while preserving standard newlines */
  var cleanedReason = rawReason
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();

  if (!cleanedReason) {
    fieldErrors.reason = 'Please enter a reason for your unavailability.';
  } else if (cleanedReason.length < minReasonChars) {
    fieldErrors.reason =
      'Reason must be at least ' +
      minReasonChars +
      ' characters (received ' +
      cleanedReason.length +
      ').';
  } else if (cleanedReason.length > maxReasonChars) {
    fieldErrors.reason =
      'Reason must not exceed ' +
      maxReasonChars +
      ' characters (received ' +
      cleanedReason.length +
      ').';
  }

  /* 3. Validate Optional Course ID */
  var rawCourseId =
    payload.courseId !== undefined && payload.courseId !== null
      ? String(payload.courseId).trim()
      : '';
  var matchedCourseRecord = null;
  if (rawCourseId && rawCourseId !== 'ALL' && rawCourseId !== 'GENERAL') {
    var coursesTbl = readSheetTable_('Courses');
    var courseHit = coursesTbl.byId[rawCourseId];
    if (!courseHit || !courseHit.record) {
      fieldErrors.courseId = 'Selected course (' + rawCourseId + ') does not exist.';
    } else {
      matchedCourseRecord = courseHit.record;
      if (callerUser.role !== 'ADMIN') {
        var enrTbl = readSheetTable_('Enrollments');
        var isEnrolled = false;
        for (var eIdx = 0; eIdx < enrTbl.records.length; eIdx++) {
          var enr = enrTbl.records[eIdx];
          if (
            enr.user_id === callerUser.user_id &&
            enr.course_id === rawCourseId &&
            enr.status === 'ACTIVE'
          ) {
            isEnrolled = true;
            break;
          }
        }
        if (!isEnrolled) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
            'You can only attach a course to an unavailability report if you hold an ACTIVE enrollment in that course.'
          );
        }
      }
    }
  } else {
    rawCourseId = '';
  }

  /* 4. Validate Idempotency Key */
  var rawIdemKey =
    payload.idempotencyKey !== undefined && payload.idempotencyKey !== null
      ? String(payload.idempotencyKey).trim()
      : '';
  var validatedIdemKey = '';
  if (rawIdemKey) {
    try {
      validatedIdemKey = validateIdempotencyKey_(rawIdemKey);
    } catch (idemErr) {
      fieldErrors.idempotencyKey = idemErr.message || 'Invalid idempotencyKey format.';
    }
  } else {
    fieldErrors.idempotencyKey =
      'A stable idempotencyKey (8..80 chars) is required to prevent duplicate unavailability submissions.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    var firstKey = Object.keys(fieldErrors)[0];
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      fieldErrors[firstKey],
      fieldErrors
    );
  }

  var payloadCanonicalString =
    callerUser.user_id +
    '|' +
    parsedStart.dateStr +
    '|' +
    parsedEnd.dateStr +
    '|' +
    rawCourseId +
    '|' +
    cleanedReason;
  var payloadHash = sha256Hex_(payloadCanonicalString).slice(0, 32);

  return {
    studentUser: callerUser,
    unavailableStartDateBkk: parsedStart.dateStr,
    unavailableEndDateBkk: parsedEnd.dateStr,
    spanDays: spanDays,
    courseId: rawCourseId,
    courseRecord: matchedCourseRecord,
    reason: cleanedReason,
    idempotencyKey: validatedIdemKey,
    payloadHash: payloadHash,
    clientSuppliedRecipientIgnored: clientSuppliedRecipientIgnored
  };
}

/**
 * Checks and increments the per-student unavailability submission rate limit in `LoginAttempts`
 * under key `unavail:user:<user_id>`.
 *
 * Must be called inside `withScriptLock_` AFTER checking idempotency (so idempotent replays of
 * an already-created request do not consume rate-limit quota).
 *
 * @param {string} userId Authenticated user's `user_id`.
 * @param {string} role Authenticated user's `role`.
 * @return {{ attemptCountInWindow: number, maxAllowedInWindow: number, remainingInWindow: number }}
 */
function checkAndRecordUnavailabilityRateLimitStep14_(userId, role) {
  var windowMs =
    PB_APP_CONSTANTS_.UNAVAILABILITY_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000;
  var maxPerWindow =
    PB_APP_CONSTANTS_.UNAVAILABILITY_RATE_LIMIT_MAX_PER_WINDOW || 5;
  var nowMs = Date.now();
  var nowIso = new Date(nowMs).toISOString();
  var attemptKey = 'unavail:user:' + String(userId);

  var table = readSheetTable_('LoginAttempts');
  var existingEntry = table.byId[attemptKey];

  if (existingEntry && existingEntry.record) {
    var rec = existingEntry.record;
    var firstFailureMs = rec.window_start_utc
      ? Date.parse(rec.window_start_utc)
      : 0;
    var lockedUntilMs = rec.locked_until_utc
      ? Date.parse(rec.locked_until_utc)
      : 0;
    var currentCount = Number(rec.failure_count || 0);

    if (!isNaN(lockedUntilMs) && lockedUntilMs > nowMs) {
      var waitSec = Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 1000));
      recordAuditEvent_({
        actorUserId: userId,
        actorRole: role || 'STUDENT',
        eventType: 'UNAVAILABILITY_RATE_LIMITED',
        targetEntityType: 'UnavailabilityRequests',
        targetEntityId: attemptKey,
        summary: {
          attemptCount: currentCount,
          maxAllowedInWindow: maxPerWindow,
          retryAfterSeconds: waitSec
        }
      });
      throw createAppError_(
        PB_ERROR_CODES_.ERR_RATE_LIMITED,
        'Unavailability submission frequency limit reached (maximum ' +
          maxPerWindow +
          ' requests per 15 minutes). Please wait ' +
          waitSec +
          ' seconds before submitting another request.',
        {
          retryAfterSeconds: waitSec,
          maxPerWindow: maxPerWindow
        }
      );
    }

    var windowExpired =
      isNaN(firstFailureMs) || firstFailureMs <= 0 || nowMs - firstFailureMs > windowMs;

    if (!windowExpired && currentCount >= maxPerWindow) {
      var lockUntilIso = new Date(firstFailureMs + windowMs).toISOString();
      var remSec = Math.max(
        1,
        Math.ceil((firstFailureMs + windowMs - nowMs) / 1000)
      );
      updateSheetRecordById_(
        'LoginAttempts',
        attemptKey,
        {
          last_attempt_at_utc: nowIso,
          locked_until_utc: lockUntilIso,
          updated_at_utc: nowIso
        },
        null
      );
      recordAuditEvent_({
        actorUserId: userId,
        actorRole: role || 'STUDENT',
        eventType: 'UNAVAILABILITY_RATE_LIMITED',
        targetEntityType: 'UnavailabilityRequests',
        targetEntityId: attemptKey,
        summary: {
          attemptCount: currentCount,
          maxAllowedInWindow: maxPerWindow,
          retryAfterSeconds: remSec
        }
      });
      throw createAppError_(
        PB_ERROR_CODES_.ERR_RATE_LIMITED,
        'Unavailability submission frequency limit reached (maximum ' +
          maxPerWindow +
          ' requests per 15 minutes). Please wait ' +
          remSec +
          ' seconds before submitting another request.',
        {
          retryAfterSeconds: remSec,
          maxPerWindow: maxPerWindow
        }
      );
    }

    var nextCount = windowExpired ? 1 : currentCount + 1;
    var nextFirstIso = windowExpired ? nowIso : rec.window_start_utc;
    var nextLockedIso =
      nextCount > maxPerWindow
        ? new Date(Date.parse(nextFirstIso) + windowMs).toISOString()
        : '';

    updateSheetRecordById_(
      'LoginAttempts',
      attemptKey,
      {
        failure_count: nextCount,
        window_start_utc: nextFirstIso,
        last_attempt_at_utc: nowIso,
        locked_until_utc: nextLockedIso,
        updated_at_utc: nowIso
      },
      null
    );

    return {
      attemptCountInWindow: nextCount,
      maxAllowedInWindow: maxPerWindow,
      remainingInWindow: Math.max(0, maxPerWindow - nextCount)
    };
  }

  insertSheetRecord_('LoginAttempts', {
    subject_key: attemptKey,
    window_start_utc: nowIso,
    failure_count: 1,
    locked_until_utc: '',
    last_attempt_at_utc: nowIso,
    updated_at_utc: nowIso
  });

  return {
    attemptCountInWindow: 1,
    maxAllowedInWindow: maxPerWindow,
    remainingInWindow: Math.max(0, maxPerWindow - 1)
  };
}

/**
 * Sends the English plain-text unavailability notification email via Google Apps Script `MailApp`
 * using strictly server-configured recipient settings and header-injection-safe subject formatting.
 *
 * Never places unvalidated student input into email headers, and never accepts client-supplied
 * recipient addresses.
 *
 * @param {Object} requestRecord Persisted `UnavailabilityRequests` record.
 * @param {Object} studentUser Verified student `Users` record from `authContext.user`.
 * @param {Object|null} courseRecord Optional `Courses` record.
 * @param {{ recipientEmail: string, configured: boolean, source: string }} recipientConfig
 * @param {Object=} opt_testOptions Optional test simulation flags.
 * @return {{ status: string, attemptedAtUtc: string, recipientEmail: string, errorDetail: string, subject: string }}
 */
function sendUnavailabilityNotificationEmailStep14_(
  requestRecord,
  studentUser,
  courseRecord,
  recipientConfig,
  opt_testOptions
) {
  var testOpts = opt_testOptions && typeof opt_testOptions === 'object' ? opt_testOptions : {};
  var attemptedAtUtc = nowUtcIso_();
  var attemptedAtBkk = formatBangkokTimestamp_(new Date(attemptedAtUtc));

  if (!recipientConfig || !recipientConfig.configured || !recipientConfig.recipientEmail || recipientConfig.recipientEmail === 'UNCONFIGURED') {
    return {
      status: 'RECIPIENT_NOT_CONFIGURED',
      attemptedAtUtc: attemptedAtUtc,
      recipientEmail: 'UNCONFIGURED',
      errorDetail:
        'Settings.ADMIN_NOTIFICATION_EMAIL is not configured yet. The unavailability request was saved in the database, but no email could be dispatched until an administrator configures the notification recipient email in School Settings.',
      subject: ''
    };
  }

  var toAddress = sanitizeEmailHeaderTokenStep14_(recipientConfig.recipientEmail, 254);
  var safeUsername = sanitizeEmailHeaderTokenStep14_(studentUser.username || studentUser.user_id, 60);
  var startDateBkk = sanitizeEmailHeaderTokenStep14_(requestRecord.unavailable_start_date_bkk, 16);
  var endDateBkk = sanitizeEmailHeaderTokenStep14_(requestRecord.unavailable_end_date_bkk, 16);
  var dateRangeLabel =
    endDateBkk && endDateBkk !== startDateBkk
      ? startDateBkk + ' to ' + endDateBkk
      : startDateBkk;

  /* Construct header strictly from validated server-side identifiers and YYYY-MM-DD dates */
  var safeSubject = sanitizeEmailHeaderTokenStep14_(
    '[Pattanabhumi Biology] Student Unavailability Report - ' +
      safeUsername +
      ' (' +
      dateRangeLabel +
      ') [' +
      requestRecord.request_id +
      ']',
    180
  );

  var courseLabel = courseRecord
    ? '[' + String(courseRecord.course_code || '') + '] ' + String(courseRecord.title || '') + ' (' + String(courseRecord.course_id || '') + ')'
    : 'General / All Enrolled Courses';

  /* English plain-text body containing only necessary student and request information */
  var englishBodyLines = [
    'Pattanabhumi Biology Learning Management System',
    'Student Unavailability / Planned Absence Notification',
    '====================================================================',
    '',
    'Request Reference ID : ' + String(requestRecord.request_id || ''),
    'Submitted Timestamp  : ' + attemptedAtBkk + ' (UTC: ' + String(requestRecord.created_at_utc || attemptedAtUtc) + ')',
    'Student Username     : ' + String(studentUser.username || ''),
    'Student Full Name    : ' + String(studentUser.full_name || '-'),
    'Student Account Email: ' + String(studentUser.email || '-'),
    'Course Context       : ' + courseLabel,
    'Unavailable Date(s)  : ' + dateRangeLabel + ' (Asia/Bangkok)',
    '',
    'Submitted Reason:',
    '--------------------------------------------------------------------',
    String(requestRecord.reason || ''),
    '--------------------------------------------------------------------',
    '',
    'Important Scheduling Policy Notice:',
    'This unavailability report is an informational notice to the school',
    'administration and instructor. It does NOT automatically cancel,',
    'reschedule, or excuse a scheduled class session.',
    '',
    'Delivery & Authorization Note:',
    'Sent automatically by Google Apps Script MailApp under the Google',
    'account authorized to run the school deployment to the configured',
    'school notification address (' + toAddress + ').'
  ];
  var englishBody = englishBodyLines.join('\n');

  /* Check simulated quota exhaustion */
  if (testOpts._simulateQuotaExceeded === true) {
    return {
      status: 'QUOTA_EXCEEDED',
      attemptedAtUtc: attemptedAtUtc,
      recipientEmail: toAddress,
      errorDetail:
        'Simulated or actual Apps Script daily MailApp quota exhausted (remaining quota = 0). Request is safely stored in UnavailabilityRequests.',
      subject: safeSubject
    };
  }

  /* Check simulated transport failure */
  if (testOpts._simulateEmailTransportFailure === true) {
    return {
      status: 'FAILED',
      attemptedAtUtc: attemptedAtUtc,
      recipientEmail: toAddress,
      errorDetail:
        'MailApp transport error: Simulated SMTP/MailApp delivery exception while dispatching notification email.',
      subject: safeSubject
    };
  }

  try {
    if (typeof MailApp !== 'undefined' && MailApp) {
      if (typeof MailApp.getRemainingDailyQuota === 'function') {
        var remQuota = Number(MailApp.getRemainingDailyQuota());
        if (!isNaN(remQuota) && remQuota <= 0) {
          return {
            status: 'QUOTA_EXCEEDED',
            attemptedAtUtc: attemptedAtUtc,
            recipientEmail: toAddress,
            errorDetail:
              'Google Apps Script MailApp daily email quota is exhausted (0 remaining). The unavailability request is saved in the database.',
            subject: safeSubject
          };
        }
      }
      if (typeof MailApp.sendEmail === 'function') {
        MailApp.sendEmail({
          to: toAddress,
          subject: safeSubject,
          body: englishBody,
          noReply: false
        });
      }
    }

    PB_STEP14_SENT_EMAIL_LOG_.push({
      requestId: requestRecord.request_id,
      userId: studentUser.user_id,
      to: toAddress,
      subject: safeSubject,
      body: englishBody,
      sentAtUtc: attemptedAtUtc
    });

    return {
      status: 'SENT',
      attemptedAtUtc: attemptedAtUtc,
      recipientEmail: toAddress,
      errorDetail: '',
      subject: safeSubject
    };
  } catch (sendErr) {
    var errMsg =
      sendErr && sendErr.message
        ? String(sendErr.message)
        : String(sendErr || 'Unknown MailApp error');
    var isQuotaErr = /quota|limit exceeded|too many emails/i.test(errMsg);
    return {
      status: isQuotaErr ? 'QUOTA_EXCEEDED' : 'FAILED',
      attemptedAtUtc: attemptedAtUtc,
      recipientEmail: toAddress,
      errorDetail: sanitizeTextBasic_('MailApp send failed: ' + errMsg, 500),
      subject: safeSubject
    };
  }
}

/**
 * Formats an `UnavailabilityRequests` sheet row into a sanitized client/admin DTO.
 *
 * @param {Object} row Raw record from `UnavailabilityRequests`.
 * @param {Object=} opt_usersById Map of `user_id -> Users record`.
 * @param {Object=} opt_coursesById Map of `course_id -> Courses record`.
 * @param {boolean=} opt_isAdmin Whether to include admin-only fields.
 * @return {Object} Enriched unavailability request DTO.
 */
function formatUnavailabilityRequestDtoStep14_(
  row,
  opt_usersById,
  opt_coursesById,
  opt_isAdmin
) {
  var meta = parseUnavailabilityMetadataPrefixStep14_(row.admin_note);
  var memUncertain = PB_STEP14_UNCERTAIN_OUTCOMES_MEM_[row.request_id] || null;
  var effectiveStatus = memUncertain
    ? 'UNCERTAIN_POST_SEND_UPDATE_FAILED'
    : String(row.email_delivery_status || 'PENDING_ATTEMPT');
  var effectiveErrorDetail = memUncertain
    ? memUncertain.errorDetail
    : String(row.email_error_detail || '');

  var stu =
    opt_usersById && opt_usersById[row.user_id]
      ? opt_usersById[row.user_id].record || opt_usersById[row.user_id]
      : null;
  var crs =
    row.course_id && opt_coursesById && opt_coursesById[row.course_id]
      ? opt_coursesById[row.course_id].record || opt_coursesById[row.course_id]
      : null;

  var maxRetries = PB_APP_CONSTANTS_.UNAVAILABILITY_MAX_EMAIL_RETRIES || 2;
  var retriesUsed = meta.retryCount || 0;
  var retriesRemaining = Math.max(0, maxRetries - retriesUsed);
  var canRetryEmail =
    (effectiveStatus === 'FAILED' ||
      effectiveStatus === 'QUOTA_EXCEEDED' ||
      effectiveStatus === 'RECIPIENT_NOT_CONFIGURED') &&
    retriesRemaining > 0;

  var statusHumanLabel = '';
  if (effectiveStatus === 'SENT') {
    statusHumanLabel = 'Recorded in DB & Notification Email Sent (SENT)';
  } else if (effectiveStatus === 'PENDING_ATTEMPT') {
    statusHumanLabel = 'Recorded in DB - Email Pending Attempt (PENDING_ATTEMPT)';
  } else if (effectiveStatus === 'UNCERTAIN_POST_SEND_UPDATE_FAILED') {
    statusHumanLabel =
      'Recorded in DB - Email Dispatched, Post-Send Status Update Uncertain (UNCERTAIN_POST_SEND_UPDATE_FAILED)';
  } else if (effectiveStatus === 'QUOTA_EXCEEDED') {
    statusHumanLabel =
      'Recorded in DB - Email Deferred: Daily MailApp Quota Exceeded (QUOTA_EXCEEDED)';
  } else if (effectiveStatus === 'RECIPIENT_NOT_CONFIGURED') {
    statusHumanLabel =
      'Recorded in DB - Email Not Sent: School Notification Email Not Configured (RECIPIENT_NOT_CONFIGURED)';
  } else {
    statusHumanLabel =
      'Recorded in DB - Email Delivery Failed (FAILED)';
  }

  var startDateBkk = String(row.unavailable_start_date_bkk || '');
  var endDateBkk = String(row.unavailable_end_date_bkk || startDateBkk);
  var dateRangeBkkLabel =
    endDateBkk && endDateBkk !== startDateBkk
      ? startDateBkk + ' to ' + endDateBkk
      : startDateBkk;

  var dto = {
    requestId: String(row.request_id || ''),
    userId: String(row.user_id || ''),
    studentUsername: stu ? String(stu.username || '') : '',
    studentFullName: stu ? String(stu.full_name || '') : '',
    studentEmail: stu ? String(stu.email || '') : '',
    courseId: String(row.course_id || ''),
    courseCode: crs ? String(crs.course_code || '') : '',
    courseTitle: crs ? String(crs.title || '') : '',
    unavailableDate: startDateBkk,
    unavailableStartDateBkk: startDateBkk,
    unavailableEndDateBkk: endDateBkk,
    dateRangeBkkLabel: dateRangeBkkLabel,
    reason: String(row.reason || ''),
    emailDeliveryStatus: effectiveStatus,
    emailStatusHumanLabel: statusHumanLabel,
    emailErrorDetail: effectiveErrorDetail,
    emailAttemptedAtUtc: String(row.email_attempted_at_utc || ''),
    emailAttemptedAtBangkok: row.email_attempted_at_utc
      ? formatBangkokTimestamp_(new Date(row.email_attempted_at_utc))
      : '',
    retriesUsed: retriesUsed,
    maxRetriesAllowed: maxRetries,
    retriesRemaining: retriesRemaining,
    canRetryEmail: canRetryEmail,
    adminNote: meta.cleanAdminNote || '',
    createdAtUtc: String(row.created_at_utc || ''),
    createdAtBangkok: row.created_at_utc
      ? formatBangkokTimestamp_(new Date(row.created_at_utc))
      : '',
    version: Number(row.version || 1),
    doesNotCancelClassNotice:
      'Submitting this unavailability request notifies the school but does NOT automatically cancel or reschedule a class.'
  };

  if (opt_isAdmin) {
    dto.emailRecipient = String(row.email_recipient || '');
    dto.idempotencyKey = meta.idempotencyKey || '';
  }

  return dto;
}

/**
 * Core backend implementation for `calendar.submitUnavailability`.
 *
 * Enforces all Step 14 requirements:
 * 1. Derives student identity strictly from the verified session (`authContext.user`).
 * 2. Validates unavailable date (`YYYY-MM-DD` in `Asia/Bangkok`) and reason (`5..1,000` chars).
 * 3. Enforces idempotency (`idempotencyKey` + SHA-256 payload fingerprint):
 *    - Same key + same payload returns the existing record without resending email.
 *    - Same key + different payload throws `ERR_IDEMPOTENCY_CONFLICT`.
 * 4. Limits submission frequency per user (`unavail:user:<user_id>` in `LoginAttempts`, max 5 per 15m).
 * 5. Records the request in `UnavailabilityRequests` (`email_delivery_status = 'PENDING_ATTEMPT'`)
 *    BEFORE attempting `MailApp.sendEmail`.
 * 6. Reads recipient strictly from `Settings.ADMIN_NOTIFICATION_EMAIL` (ignoring client-supplied recipients)
 *    and sanitizes headers against CR/LF injection.
 * 7. Sends English plain-text email with only necessary student and request details.
 * 8. Handles post-send database update failures honestly (`UNCERTAIN_POST_SEND_UPDATE_FAILED`) without
 *    promising exactly-once delivery or triggering duplicate emails.
 *
 * @param {Object} authContext Verified authentication context.
 * @param {Object} payload Request payload.
 * @return {Object} Authoritative unavailability submission result.
 */
function submitStudentUnavailabilityStep14_(authContext, payload) {
  var req = payload && typeof payload === 'object' ? payload : {};
  var validated = validateUnavailabilityRequestInputStep14_(authContext, req);
  var studentUser = validated.studentUser;

  /* Phase 1: Inside ScriptLock, check idempotency, check rate limit, and record PENDING_ATTEMPT row BEFORE sending email */
  var phase1Result = withScriptLock_(function () {
    var unavailTbl = readSheetTable_('UnavailabilityRequests');
    var usersTbl = readSheetTable_('Users');
    var coursesTbl = readSheetTable_('Courses');

    /* 1A. Idempotency check across existing UnavailabilityRequests for this user */
    for (var i = 0; i < unavailTbl.records.length; i++) {
      var existingRow = unavailTbl.records[i];
      if (existingRow.user_id !== studentUser.user_id) {
        continue;
      }
      var existingMeta = parseUnavailabilityMetadataPrefixStep14_(
        existingRow.admin_note
      );
      if (
        existingMeta.idempotencyKey &&
        existingMeta.idempotencyKey === validated.idempotencyKey
      ) {
        if (existingMeta.payloadHash !== validated.payloadHash) {
          throw createAppError_(
            PB_ERROR_CODES_.ERR_IDEMPOTENCY_CONFLICT,
            'Idempotency key (' +
              validated.idempotencyKey +
              ') was already used for a different unavailability request payload.'
          );
        }

        var replayDto = formatUnavailabilityRequestDtoStep14_(
          existingRow,
          usersTbl.byId,
          coursesTbl.byId,
          studentUser.role === 'ADMIN'
        );
        return {
          isIdempotentReplay: true,
          existingRow: existingRow,
          replayDto: replayDto
        };
      }
    }

    /* 1B. Check and record per-user submission frequency rate limit (max 5 per 15 minutes) */
    var rateLimitInfo = checkAndRecordUnavailabilityRateLimitStep14_(
      studentUser.user_id,
      studentUser.role
    );

    /* 1C. Resolve server-side notification recipient */
    var recipientConfig = resolveNotificationRecipientEmailStep14_(req);

    /* 1D. Create and persist UnavailabilityRequests row with PENDING_ATTEMPT BEFORE sending email */
    var requestId = generateEntityId_('unv');
    var createdIso = nowUtcIso_();
    var initialAdminNote = buildUnavailabilityMetadataPrefixStep14_(
      {
        idempotencyKey: validated.idempotencyKey,
        payloadHash: validated.payloadHash,
        retryCount: 0
      },
      ''
    );

    var newRow = {
      request_id: requestId,
      user_id: studentUser.user_id,
      course_id: validated.courseId || '',
      unavailable_start_date_bkk: validated.unavailableStartDateBkk,
      unavailable_end_date_bkk: validated.unavailableEndDateBkk,
      reason: validated.reason,
      email_recipient: recipientConfig.recipientEmail || 'UNCONFIGURED',
      email_delivery_status: 'PENDING_ATTEMPT',
      email_error_detail: '',
      email_attempted_at_utc: '',
      admin_note: initialAdminNote,
      created_at_utc: createdIso,
      version: 1
    };

    insertSheetRecord_('UnavailabilityRequests', newRow);

    recordAuditEvent_({
      actorUserId: studentUser.user_id,
      actorRole: studentUser.role || 'STUDENT',
      eventType: 'UNAVAILABILITY_REPORT_CREATED',
      targetEntityType: 'UnavailabilityRequests',
      targetEntityId: requestId,
      summary: {
        unavailableStartDateBkk: validated.unavailableStartDateBkk,
        unavailableEndDateBkk: validated.unavailableEndDateBkk,
        courseId: validated.courseId || '',
        initialEmailStatus: 'PENDING_ATTEMPT',
        recordedBeforeEmailSend: true,
        clientSuppliedRecipientIgnored: validated.clientSuppliedRecipientIgnored
      }
    });

    return {
      isIdempotentReplay: false,
      requestId: requestId,
      persistedRow: newRow,
      recipientConfig: recipientConfig,
      rateLimitInfo: rateLimitInfo
    };
  });

  /* If this was an idempotent replay, return the existing result immediately WITHOUT resending email */
  if (phase1Result.isIdempotentReplay) {
    var existingDto = phase1Result.replayDto;
    return {
      idempotentReplay: true,
      emailResent: false,
      requestRecorded: true,
      recordedBeforeEmailAttempt: true,
      emailDeliveryStatus: existingDto.emailDeliveryStatus,
      uncertainOutcome:
        existingDto.emailDeliveryStatus === 'UNCERTAIN_POST_SEND_UPDATE_FAILED',
      clientSuppliedRecipientIgnored: validated.clientSuppliedRecipientIgnored,
      request: existingDto,
      resultMessage:
        'Idempotent replay detected for key "' +
        validated.idempotencyKey +
        '". Returned existing unavailability report (' +
        existingDto.requestId +
        ', email status: ' +
        existingDto.emailDeliveryStatus +
        ') without creating a duplicate record or resending the email.',
      doesNotCancelClassNotice:
        'Important Notice: Submitting an unavailability report notifies the school administration and instructor of your planned absence, but it does NOT automatically cancel, reschedule, or excuse a scheduled class session.',
      emailArchitectureExplanation:
        getUnavailabilityEmailArchitectureExplanationStep14_()
    };
  }

  /* Phase 2: Attempt to send English notification email AFTER the PENDING_ATTEMPT record is safely saved */
  var persistedRow = phase1Result.persistedRow;
  var recipientConfig = phase1Result.recipientConfig;
  var sendOutcome = sendUnavailabilityNotificationEmailStep14_(
    persistedRow,
    studentUser,
    validated.courseRecord,
    recipientConfig,
    req
  );

  /* Phase 3: Record the post-send email outcome in UnavailabilityRequests, handling uncertain post-send failures honestly */
  var finalRowState = null;
  var uncertainOutcomeFlag = false;
  var postSendPersistenceErrorMsg = '';

  try {
    if (req._simulatePostSendRecordFailure === true && sendOutcome.status === 'SENT') {
      throw new Error(
        'Simulated Google Sheets write timeout after MailApp.sendEmail had already transmitted the email.'
      );
    }

    finalRowState = withScriptLock_(function () {
      var updated = updateSheetRecordById_(
        'UnavailabilityRequests',
        persistedRow.request_id,
        {
          email_delivery_status: sendOutcome.status,
          email_error_detail: sendOutcome.errorDetail || '',
          email_attempted_at_utc: sendOutcome.attemptedAtUtc,
          email_recipient: sendOutcome.recipientEmail || recipientConfig.recipientEmail || 'UNCONFIGURED'
        },
        1
      );

      recordAuditEvent_({
        actorUserId: studentUser.user_id,
        actorRole: studentUser.role || 'STUDENT',
        eventType:
          sendOutcome.status === 'SENT'
            ? 'UNAVAILABILITY_EMAIL_SENT'
            : 'UNAVAILABILITY_EMAIL_FAILED',
        targetEntityType: 'UnavailabilityRequests',
        targetEntityId: persistedRow.request_id,
        summary: {
          emailDeliveryStatus: sendOutcome.status,
          attemptedAtUtc: sendOutcome.attemptedAtUtc,
          errorDetail: sendOutcome.errorDetail || ''
        }
      });

      return updated.record || updated;
    });
  } catch (postSendUpdateErr) {
    /*
     * CRITICAL STEP 14 INTEGRITY REQUIREMENT:
     * If `MailApp.sendEmail` succeeded (the email was already transmitted), but recording the `SENT`
     * status in Google Sheets failed, do NOT pretend the request failed or prompt an automatic retry
     * that would send duplicate emails. Mark the outcome as `UNCERTAIN_POST_SEND_UPDATE_FAILED`.
     */
    uncertainOutcomeFlag = true;
    postSendPersistenceErrorMsg =
      postSendUpdateErr && postSendUpdateErr.message
        ? String(postSendUpdateErr.message)
        : String(postSendUpdateErr || 'Post-send database update failed');

    var uncertainDetail = sanitizeTextBasic_(
      'Email was dispatched via MailApp.sendEmail at ' +
        sendOutcome.attemptedAtUtc +
        ', but updating UnavailabilityRequests from PENDING_ATTEMPT to SENT failed (' +
        postSendPersistenceErrorMsg +
        '). Automatic and manual email retries are disabled for this request to prevent duplicate emails.',
      500
    );

    PB_STEP14_UNCERTAIN_OUTCOMES_MEM_[persistedRow.request_id] = {
      requestId: persistedRow.request_id,
      status: 'UNCERTAIN_POST_SEND_UPDATE_FAILED',
      attemptedAtUtc: sendOutcome.attemptedAtUtc,
      errorDetail: uncertainDetail
    };

    try {
      withScriptLock_(function () {
        var recovered = updateSheetRecordById_(
          'UnavailabilityRequests',
          persistedRow.request_id,
          {
            email_delivery_status: 'UNCERTAIN_POST_SEND_UPDATE_FAILED',
            email_error_detail: uncertainDetail,
            email_attempted_at_utc: sendOutcome.attemptedAtUtc
          },
          Number(persistedRow.version || 1)
        );
        finalRowState = recovered.record || recovered;
      });
    } catch (ignoreSecondarySheetErr) {
      finalRowState = {
        request_id: persistedRow.request_id,
        user_id: persistedRow.user_id,
        course_id: persistedRow.course_id,
        unavailable_start_date_bkk: persistedRow.unavailable_start_date_bkk,
        unavailable_end_date_bkk: persistedRow.unavailable_end_date_bkk,
        reason: persistedRow.reason,
        email_recipient: persistedRow.email_recipient,
        email_delivery_status: 'UNCERTAIN_POST_SEND_UPDATE_FAILED',
        email_error_detail: uncertainDetail,
        email_attempted_at_utc: sendOutcome.attemptedAtUtc,
        admin_note: persistedRow.admin_note,
        created_at_utc: persistedRow.created_at_utc,
        version: 1
      };
    }

    try {
      recordAuditEvent_({
        actorUserId: studentUser.user_id,
        actorRole: studentUser.role || 'STUDENT',
        eventType: 'UNAVAILABILITY_EMAIL_UNCERTAIN',
        targetEntityType: 'UnavailabilityRequests',
        targetEntityId: persistedRow.request_id,
        summary: {
          emailDeliveryStatus: 'UNCERTAIN_POST_SEND_UPDATE_FAILED',
          attemptedAtUtc: sendOutcome.attemptedAtUtc,
          postSendPersistenceError: postSendPersistenceErrorMsg
        }
      });
    } catch (ignoreAuditErr) {}
  }

  var usersTblFinal = readSheetTable_('Users');
  var coursesTblFinal = readSheetTable_('Courses');
  var finalDto = formatUnavailabilityRequestDtoStep14_(
    finalRowState || persistedRow,
    usersTblFinal.byId,
    coursesTblFinal.byId,
    studentUser.role === 'ADMIN'
  );

  var actualResultMessage = '';
  if (uncertainOutcomeFlag || finalDto.emailDeliveryStatus === 'UNCERTAIN_POST_SEND_UPDATE_FAILED') {
    actualResultMessage =
      'Unavailability report ' +
      finalDto.requestId +
      ' was recorded in the database BEFORE sending, and MailApp.sendEmail completed, so the notification email was likely delivered to the school. However, updating the database status from PENDING_ATTEMPT to SENT encountered a post-send write error (UNCERTAIN_POST_SEND_UPDATE_FAILED). To avoid sending duplicate emails, automatic and manual resends are disabled for this request. Reminder: this report does NOT automatically cancel a class.';
  } else if (finalDto.emailDeliveryStatus === 'SENT') {
    actualResultMessage =
      'Unavailability report ' +
      finalDto.requestId +
      ' for ' +
      finalDto.dateRangeBkkLabel +
      ' (Asia/Bangkok) has been recorded in the database and the English notification email was sent to the school (' +
      finalDto.emailDeliveryStatus +
      '). Please note: submitting this request does NOT automatically cancel or reschedule a class.';
  } else {
    actualResultMessage =
      'Unavailability report ' +
      finalDto.requestId +
      ' for ' +
      finalDto.dateRangeBkkLabel +
      ' (Asia/Bangkok) was safely recorded in the school database, but the email notification was not delivered (' +
      finalDto.emailDeliveryStatus +
      ': ' +
      (finalDto.emailErrorDetail || 'See status details') +
      '). Administrators can still view your recorded request in the Admin Dashboard, or you can use the controlled Retry Email button (up to 2 retries). Reminder: this request does NOT automatically cancel a class.';
  }

  return {
    idempotentReplay: false,
    emailResent: false,
    requestRecorded: true,
    recordedBeforeEmailAttempt: true,
    emailDeliveryStatus: finalDto.emailDeliveryStatus,
    uncertainOutcome:
      uncertainOutcomeFlag ||
      finalDto.emailDeliveryStatus === 'UNCERTAIN_POST_SEND_UPDATE_FAILED',
    clientSuppliedRecipientIgnored: validated.clientSuppliedRecipientIgnored,
    rateLimit: phase1Result.rateLimitInfo,
    request: finalDto,
    resultMessage: actualResultMessage,
    doesNotCancelClassNotice:
      'Important Notice: Submitting an unavailability report notifies the school administration and instructor of your planned absence, but it does NOT automatically cancel, reschedule, or excuse a scheduled class session.',
    emailArchitectureExplanation:
      getUnavailabilityEmailArchitectureExplanationStep14_(
        recipientConfig.recipientEmail
      )
  };
}

function handleCalendarSubmitUnavailabilityStep14_(payload, context) {
  return submitStudentUnavailabilityStep14_(context.authContext, payload);
}

/**
 * Lists the signed-in student's own unavailability requests (`calendar.listMyUnavailability`).
 * Strictly filters by `row.user_id === authContext.user.user_id` so a student can never see
 * another student's unavailability requests.
 *
 * @param {Object} authContext Verified authentication context.
 * @param {Object} payload Request payload.
 * @return {Object} Student's own unavailability requests and policy explanations.
 */
function listStudentOwnUnavailabilityStep14_(authContext, payload) {
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to view your unavailability reports.'
    );
  }

  var callerUser = authContext.user;
  var unavailTbl = readSheetTable_('UnavailabilityRequests');
  var usersTbl = readSheetTable_('Users');
  var coursesTbl = readSheetTable_('Courses');

  var ownRequests = [];
  for (var i = 0; i < unavailTbl.records.length; i++) {
    var r = unavailTbl.records[i];
    if (r.user_id === callerUser.user_id) {
      ownRequests.push(
        formatUnavailabilityRequestDtoStep14_(
          r,
          usersTbl.byId,
          coursesTbl.byId,
          false
        )
      );
    }
  }

  ownRequests.sort(function (a, b) {
    return String(b.createdAtUtc || '').localeCompare(String(a.createdAtUtc || ''));
  });

  var enrTbl = readSheetTable_('Enrollments');
  var enrolledCourses = [];
  for (var eIdx = 0; eIdx < enrTbl.records.length; eIdx++) {
    var enr = enrTbl.records[eIdx];
    if (
      enr.user_id === callerUser.user_id &&
      enr.status === 'ACTIVE' &&
      enr.course_id &&
      coursesTbl.byId[enr.course_id]
    ) {
      var cRec = coursesTbl.byId[enr.course_id].record;
      if (cRec && cRec.status === 'PUBLISHED') {
        enrolledCourses.push({
          courseId: cRec.course_id,
          courseCode: cRec.course_code,
          title: cRec.title
        });
      }
    }
  }

  return {
    userId: callerUser.user_id,
    username: callerUser.username,
    requests: ownRequests,
    totalOwnRequests: ownRequests.length,
    enrolledCourses: enrolledCourses,
    doesNotCancelClassNotice:
      'Submitting an unavailability report notifies the school administration and instructor of your planned absence, but it does NOT automatically cancel, reschedule, or excuse a scheduled class session.',
    emailArchitectureExplanation:
      getUnavailabilityEmailArchitectureExplanationStep14_()
  };
}

function handleCalendarListMyUnavailabilityStep14_(payload, context) {
  return listStudentOwnUnavailabilityStep14_(context.authContext, payload);
}

/**
 * Retrieves a single unavailability request by `requestId` (`calendar.getUnavailabilityRequest`),
 * enforcing strict ownership isolation: if a `STUDENT` attempts to read another student's
 * `requestId`, the backend logs an audit event and throws `ERR_FORBIDDEN_RESOURCE`.
 *
 * @param {Object} authContext Verified authentication context.
 * @param {Object} payload Request payload (`{ requestId }`).
 * @return {Object} Single unavailability request DTO.
 */
function getStudentUnavailabilityByIdStep14_(authContext, payload) {
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to view an unavailability report.'
    );
  }

  var req = payload && typeof payload === 'object' ? payload : {};
  var requestId =
    req.requestId !== undefined && req.requestId !== null
      ? String(req.requestId).trim()
      : '';
  if (!requestId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'requestId is required.'
    );
  }

  var unavailTbl = readSheetTable_('UnavailabilityRequests');
  var hit = unavailTbl.byId[requestId];
  if (!hit || !hit.record) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Unavailability request not found.'
    );
  }

  var callerUser = authContext.user;
  var row = hit.record;
  if (callerUser.role !== 'ADMIN' && row.user_id !== callerUser.user_id) {
    recordAuditEvent_({
      actorUserId: callerUser.user_id,
      actorRole: callerUser.role || 'STUDENT',
      eventType: 'UNAVAILABILITY_UNAUTHORIZED_ACCESS_BLOCKED',
      targetEntityType: 'UnavailabilityRequests',
      targetEntityId: requestId,
      summary: {
        ownerUserId: row.user_id,
        attemptedByUserId: callerUser.user_id
      }
    });
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
      'Access denied: you are not authorized to view another student\'s unavailability report.'
    );
  }

  var usersTbl = readSheetTable_('Users');
  var coursesTbl = readSheetTable_('Courses');
  return {
    request: formatUnavailabilityRequestDtoStep14_(
      row,
      usersTbl.byId,
      coursesTbl.byId,
      callerUser.role === 'ADMIN'
    )
  };
}

function handleCalendarGetUnavailabilityRequestStep14_(payload, context) {
  return getStudentUnavailabilityByIdStep14_(context.authContext, payload);
}

/**
 * Controlled, visible, and bounded manual email retry (`calendar.retryUnavailabilityEmail`).
 *
 * Rules:
 * - Page refresh never calls this action; it must be explicitly triggered by the owning student or admin.
 * - Verifies ownership (`row.user_id === caller.user_id` or `caller.role === 'ADMIN'`; otherwise throws `ERR_FORBIDDEN_RESOURCE`).
 * - Blocks retry if `email_delivery_status` is already `'SENT'` or `'UNCERTAIN_POST_SEND_UPDATE_FAILED'`
 *   (throws `ERR_INVALID_STATE_TRANSITION`).
 * - Limits manual retries per request to `PB_APP_CONSTANTS_.UNAVAILABILITY_MAX_EMAIL_RETRIES` (2 retries).
 *
 * @param {Object} authContext Verified authentication context.
 * @param {Object} payload Request payload (`{ requestId }`).
 * @return {Object} Updated unavailability request DTO and retry outcome.
 */
function retryUnavailabilityEmailStep14_(authContext, payload) {
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required to retry an unavailability notification email.'
    );
  }

  var req = payload && typeof payload === 'object' ? payload : {};
  var requestId =
    req.requestId !== undefined && req.requestId !== null
      ? String(req.requestId).trim()
      : '';
  if (!requestId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'requestId is required to retry email delivery.'
    );
  }

  var callerUser = authContext.user;
  var maxRetries = PB_APP_CONSTANTS_.UNAVAILABILITY_MAX_EMAIL_RETRIES || 2;

  /* Step 1: Validate ownership, state, and retry ceiling inside ScriptLock */
  var preRetryInfo = withScriptLock_(function () {
    var unavailTbl = readSheetTable_('UnavailabilityRequests');
    var hit = unavailTbl.byId[requestId];
    if (!hit || !hit.record) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Unavailability request (' + requestId + ') was not found.'
      );
    }

    var row = hit.record;
    if (callerUser.role !== 'ADMIN' && row.user_id !== callerUser.user_id) {
      recordAuditEvent_({
        actorUserId: callerUser.user_id,
        actorRole: callerUser.role || 'STUDENT',
        eventType: 'UNAVAILABILITY_UNAUTHORIZED_RETRY_BLOCKED',
        targetEntityType: 'UnavailabilityRequests',
        targetEntityId: requestId,
        summary: {
          ownerUserId: row.user_id,
          attemptedByUserId: callerUser.user_id
        }
      });
      throw createAppError_(
        PB_ERROR_CODES_.ERR_FORBIDDEN_RESOURCE,
        'Access denied: you cannot retry email delivery for another student\'s unavailability request.'
      );
    }

    var effectiveStatus = PB_STEP14_UNCERTAIN_OUTCOMES_MEM_[requestId]
      ? 'UNCERTAIN_POST_SEND_UPDATE_FAILED'
      : String(row.email_delivery_status || 'PENDING_ATTEMPT');

    if (effectiveStatus === 'SENT') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
        'Notification email for request ' +
          requestId +
          ' has already been marked SENT. Resending is blocked to prevent duplicate emails.'
      );
    }

    if (effectiveStatus === 'UNCERTAIN_POST_SEND_UPDATE_FAILED') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_INVALID_STATE_TRANSITION,
        'Request ' +
          requestId +
          ' is in UNCERTAIN_POST_SEND_UPDATE_FAILED state because MailApp.sendEmail completed before a post-send database error. Manual retry is disabled to prevent duplicate emails.'
      );
    }

    var meta = parseUnavailabilityMetadataPrefixStep14_(row.admin_note);
    if (meta.retryCount >= maxRetries) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_RATE_LIMITED,
        'Controlled retry ceiling reached: request ' +
          requestId +
          ' has already used ' +
          meta.retryCount +
          ' of ' +
          maxRetries +
          ' allowed manual email retries.'
      );
    }

    var nextRetryCount = meta.retryCount + 1;
    var nextAdminNote = buildUnavailabilityMetadataPrefixStep14_(
      {
        idempotencyKey: meta.idempotencyKey || 'retry_' + requestId,
        payloadHash: meta.payloadHash || '0000000000000000',
        retryCount: nextRetryCount
      },
      meta.cleanAdminNote
    );

    var updatedPending = updateSheetRecordById_(
      'UnavailabilityRequests',
      requestId,
      {
        email_delivery_status: 'PENDING_ATTEMPT',
        admin_note: nextAdminNote
      },
      Number(row.version || 1)
    );

    var usersTbl = readSheetTable_('Users');
    var coursesTbl = readSheetTable_('Courses');
    var ownerUser =
      usersTbl.byId[row.user_id] && usersTbl.byId[row.user_id].record
        ? usersTbl.byId[row.user_id].record
        : callerUser;
    var courseRec =
      row.course_id &&
      coursesTbl.byId[row.course_id] &&
      coursesTbl.byId[row.course_id].record
        ? coursesTbl.byId[row.course_id].record
        : null;

    return {
      row: updatedPending.record || updatedPending,
      ownerUser: ownerUser,
      courseRecord: courseRec,
      retryNumber: nextRetryCount,
      recipientConfig: resolveNotificationRecipientEmailStep14_(req)
    };
  });

  /* Step 2: Dispatch email via MailApp */
  var sendOutcome = sendUnavailabilityNotificationEmailStep14_(
    preRetryInfo.row,
    preRetryInfo.ownerUser,
    preRetryInfo.courseRecord,
    preRetryInfo.recipientConfig,
    req
  );

  /* Step 3: Persist retry outcome inside ScriptLock */
  var finalRow = withScriptLock_(function () {
    var updated = updateSheetRecordById_(
      'UnavailabilityRequests',
      requestId,
      {
        email_delivery_status: sendOutcome.status,
        email_error_detail: sendOutcome.errorDetail || '',
        email_attempted_at_utc: sendOutcome.attemptedAtUtc,
        email_recipient:
          sendOutcome.recipientEmail ||
          preRetryInfo.recipientConfig.recipientEmail ||
          'UNCONFIGURED'
      },
      Number(preRetryInfo.row.version || 2)
    );

    recordAuditEvent_({
      actorUserId: callerUser.user_id,
      actorRole: callerUser.role || 'STUDENT',
      eventType: 'UNAVAILABILITY_EMAIL_RETRIED',
      targetEntityType: 'UnavailabilityRequests',
      targetEntityId: requestId,
      summary: {
        retryNumber: preRetryInfo.retryNumber,
        maxRetriesAllowed: maxRetries,
        emailDeliveryStatus: sendOutcome.status,
        errorDetail: sendOutcome.errorDetail || ''
      }
    });

    return updated.record || updated;
  });

  var usersTblFinal = readSheetTable_('Users');
  var coursesTblFinal = readSheetTable_('Courses');
  var dto = formatUnavailabilityRequestDtoStep14_(
    finalRow,
    usersTblFinal.byId,
    coursesTblFinal.byId,
    callerUser.role === 'ADMIN'
  );

  return {
    retried: true,
    retryNumber: preRetryInfo.retryNumber,
    maxRetriesAllowed: maxRetries,
    emailDeliveryStatus: dto.emailDeliveryStatus,
    request: dto,
    resultMessage:
      dto.emailDeliveryStatus === 'SENT'
        ? 'Controlled retry #' +
          preRetryInfo.retryNumber +
          ' succeeded: notification email for ' +
          requestId +
          ' has been sent (SENT).'
        : 'Controlled retry #' +
          preRetryInfo.retryNumber +
          ' completed with status ' +
          dto.emailDeliveryStatus +
          ' (' +
          (dto.emailErrorDetail || 'Email not sent') +
          '). Remaining retries: ' +
          dto.retriesRemaining +
          '.'
  };
}

function handleCalendarRetryUnavailabilityEmailStep14_(payload, context) {
  return retryUnavailabilityEmailStep14_(context.authContext, payload);
}

/**
 * Administrator endpoint (`admin.listUnavailabilityRequests`) to list, filter, and search
 * all student unavailability reports with their requested dates, student details, reasons,
 * and email delivery statuses.
 *
 * @param {Object} authContext Verified authentication context (must be `ADMIN`).
 * @param {Object} payload Filter/search criteria (`{ userId, emailStatusFilter, dateFilter, searchQuery }`).
 * @return {Object} Filtered unavailability requests, summary counts, and architecture explanation.
 */
function adminListUnavailabilityRequestsStep14_(authContext, payload) {
  if (!authContext || !authContext.user || authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Only an administrator can list all student unavailability requests.'
    );
  }

  var req = payload && typeof payload === 'object' ? payload : {};
  var filterUserId =
    req.userId !== undefined && req.userId !== null
      ? String(req.userId).trim()
      : 'ALL';
  var filterStatus =
    req.emailStatusFilter !== undefined && req.emailStatusFilter !== null
      ? String(req.emailStatusFilter).trim().toUpperCase()
      : 'ALL';
  var filterDate =
    req.dateFilter !== undefined && req.dateFilter !== null
      ? String(req.dateFilter).trim()
      : '';
  var searchQuery =
    req.searchQuery !== undefined && req.searchQuery !== null
      ? String(req.searchQuery).trim().toLowerCase()
      : '';

  var unavailTbl = readSheetTable_('UnavailabilityRequests');
  var usersTbl = readSheetTable_('Users');
  var coursesTbl = readSheetTable_('Courses');

  var studentsList = [];
  for (var uIdx = 0; uIdx < usersTbl.records.length; uIdx++) {
    var u = usersTbl.records[uIdx];
    if (u.role === 'STUDENT') {
      studentsList.push({
        userId: u.user_id,
        username: u.username,
        fullName: u.full_name || '',
        email: u.email || '',
        status: u.status
      });
    }
  }

  var summaryCounts = {
    totalRequests: unavailTbl.records.length,
    sentCount: 0,
    failedCount: 0,
    pendingCount: 0,
    uncertainCount: 0,
    quotaExceededCount: 0,
    unconfiguredCount: 0
  };

  var filteredItems = [];
  for (var i = 0; i < unavailTbl.records.length; i++) {
    var row = unavailTbl.records[i];
    var dto = formatUnavailabilityRequestDtoStep14_(
      row,
      usersTbl.byId,
      coursesTbl.byId,
      true
    );

    if (dto.emailDeliveryStatus === 'SENT') {
      summaryCounts.sentCount++;
    } else if (dto.emailDeliveryStatus === 'PENDING_ATTEMPT') {
      summaryCounts.pendingCount++;
    } else if (dto.emailDeliveryStatus === 'UNCERTAIN_POST_SEND_UPDATE_FAILED') {
      summaryCounts.uncertainCount++;
    } else if (dto.emailDeliveryStatus === 'QUOTA_EXCEEDED') {
      summaryCounts.quotaExceededCount++;
    } else if (dto.emailDeliveryStatus === 'RECIPIENT_NOT_CONFIGURED') {
      summaryCounts.unconfiguredCount++;
    } else {
      summaryCounts.failedCount++;
    }

    if (filterUserId && filterUserId !== 'ALL' && dto.userId !== filterUserId) {
      continue;
    }

    if (filterStatus && filterStatus !== 'ALL') {
      if (filterStatus === 'FAILED_ANY') {
        if (
          dto.emailDeliveryStatus !== 'FAILED' &&
          dto.emailDeliveryStatus !== 'QUOTA_EXCEEDED' &&
          dto.emailDeliveryStatus !== 'RECIPIENT_NOT_CONFIGURED'
        ) {
          continue;
        }
      } else if (dto.emailDeliveryStatus !== filterStatus) {
        continue;
      }
    }

    if (filterDate) {
      var matchesDate =
        dto.unavailableStartDateBkk.indexOf(filterDate) === 0 ||
        dto.unavailableEndDateBkk.indexOf(filterDate) === 0 ||
        (filterDate.length === 10 &&
          filterDate >= dto.unavailableStartDateBkk &&
          filterDate <= dto.unavailableEndDateBkk);
      if (!matchesDate) {
        continue;
      }
    }

    if (searchQuery) {
      var haystack = [
        dto.requestId,
        dto.userId,
        dto.studentUsername,
        dto.studentFullName,
        dto.studentEmail,
        dto.courseCode,
        dto.courseTitle,
        dto.unavailableStartDateBkk,
        dto.unavailableEndDateBkk,
        dto.reason,
        dto.emailDeliveryStatus,
        dto.adminNote
      ]
        .join(' ')
        .toLowerCase();
      if (haystack.indexOf(searchQuery) === -1) {
        continue;
      }
    }

    filteredItems.push(dto);
  }

  filteredItems.sort(function (a, b) {
    return String(b.createdAtUtc || '').localeCompare(String(a.createdAtUtc || ''));
  });

  var recipientCfg = resolveNotificationRecipientEmailStep14_({});

  return {
    requests: filteredItems,
    filteredCount: filteredItems.length,
    summaryCounts: summaryCounts,
    studentsList: studentsList,
    configuredNotificationRecipient: recipientCfg.recipientEmail,
    recipientConfigured: recipientCfg.configured,
    recipientSource: recipientCfg.source,
    emailArchitectureExplanation:
      getUnavailabilityEmailArchitectureExplanationStep14_(
        recipientCfg.recipientEmail
      )
  };
}

function handleAdminListUnavailabilityRequestsStep14_(payload, context) {
  return adminListUnavailabilityRequestsStep14_(context.authContext, payload);
}

/**
 * Administrator endpoint (`admin.updateUnavailabilityNote`) to record or update an
 * administrative note on a student's unavailability request with optimistic concurrency
 * (`expectedVersion`) and audit logging (`ADMIN_UNAVAILABILITY_NOTE_UPDATED`).
 *
 * @param {Object} authContext Verified authentication context (must be `ADMIN`).
 * @param {Object} payload `{ requestId, adminNote, expectedVersion }`.
 * @return {Object} Updated unavailability request DTO.
 */
function adminUpdateUnavailabilityNoteStep14_(authContext, payload) {
  if (!authContext || !authContext.user || authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Only an administrator can update unavailability request notes.'
    );
  }

  var req = payload && typeof payload === 'object' ? payload : {};
  var requestId =
    req.requestId !== undefined && req.requestId !== null
      ? String(req.requestId).trim()
      : '';
  if (!requestId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'requestId is required.'
    );
  }

  var cleanNote =
    req.adminNote !== undefined && req.adminNote !== null
      ? sanitizeTextBasic_(String(req.adminNote), 1000)
      : '';
  var expectedVersion =
    req.expectedVersion !== undefined && req.expectedVersion !== null
      ? Number(req.expectedVersion)
      : null;

  var updatedRecord = withScriptLock_(function () {
    var unavailTbl = readSheetTable_('UnavailabilityRequests');
    var hit = unavailTbl.byId[requestId];
    if (!hit || !hit.record) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Unavailability request (' + requestId + ') not found.'
      );
    }

    var row = hit.record;
    var meta = parseUnavailabilityMetadataPrefixStep14_(row.admin_note);
    var encodedAdminNote = buildUnavailabilityMetadataPrefixStep14_(
      {
        idempotencyKey: meta.idempotencyKey || 'note_' + requestId,
        payloadHash: meta.payloadHash || '0000000000000000',
        retryCount: meta.retryCount || 0
      },
      cleanNote
    );

    var updated = updateSheetRecordById_(
      'UnavailabilityRequests',
      requestId,
      {
        admin_note: encodedAdminNote
      },
      expectedVersion
    );

    recordAuditEvent_({
      actorUserId: authContext.user.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_UNAVAILABILITY_NOTE_UPDATED',
      targetEntityType: 'UnavailabilityRequests',
      targetEntityId: requestId,
      summary: {
        studentUserId: row.user_id,
        adminNoteLength: cleanNote.length,
        newVersion: (updated.record || updated).version
      }
    });

    return updated.record || updated;
  });

  var usersTbl = readSheetTable_('Users');
  var coursesTbl = readSheetTable_('Courses');
  var dto = formatUnavailabilityRequestDtoStep14_(
    updatedRecord,
    usersTbl.byId,
    coursesTbl.byId,
    true
  );

  return {
    request: dto,
    savedMessage:
      'Saved administrator note on unavailability request ' +
      requestId +
      ' (v' +
      String(dto.version) +
      ').'
  };
}

function handleAdminUpdateUnavailabilityNoteStep14_(payload, context) {
  return adminUpdateUnavailabilityNoteStep14_(context.authContext, payload);
}

/**
 * Step 14 Automated Verification Suite (`admin.runStep14VerificationSuite`).
 *
 * Verifies all 6 required Step 14 scenarios against the real backend and database sheets:
 * 1. Successful email attempt (session-derived student identity, recorded as `PENDING_ATTEMPT`
 *    before send, server-side `ADMIN_NOTIFICATION_EMAIL` recipient ignoring client-supplied
 *    override, CR/LF header sanitization, English email text, final status `SENT`).
 * 2. Failed send (`MailApp` transport failure & quota/unconfigured handling: request remains
 *    durably recorded in `UnavailabilityRequests` with `FAILED`, honest result message returned,
 *    and controlled manual retry `calendar.retryUnavailabilityEmail` recovers to `SENT` while
 *    enforcing the 2-retry ceiling).
 * 3. Duplicate submission (`idempotencyKey`: repeating with same key + same payload returns
 *    `idempotentReplay: true` without creating a second row or resending email; repeating with
 *    same key + modified payload throws `ERR_IDEMPOTENCY_CONFLICT`).
 * 4. Rate limit (`unavail:user:<user_id>` in `LoginAttempts`: 6th distinct submission within
 *    15 minutes for the same student is rejected with `ERR_RATE_LIMITED`).
 * 5. Another user's request access (`student_b` attempting to view or retry `student_a`'s
 *    request is rejected with `ERR_FORBIDDEN_RESOURCE`; `student_b` calling `listMyUnavailability`
 *    never sees `student_a`'s rows; `student_b` calling `admin.listUnavailabilityRequests` is
 *    rejected with `ERR_FORBIDDEN_ROLE`).
 * 6. Uncertain send outcome handling (`_simulatePostSendRecordFailure: true` after `MailApp.sendEmail`
 *    succeeds: backend records `UNCERTAIN_POST_SEND_UPDATE_FAILED` and `UNAVAILABILITY_EMAIL_UNCERTAIN`
 *    audit event, does not promise exactly-once delivery, blocks automatic/manual duplicate resends,
 *    and explains honestly what happened).
 *
 * @param {Object} authContext Verified administrator context.
 * @param {Object} payload Optional suite payload.
 * @return {Object} Structured Step 14 verification suite report.
 */
function adminRunStep14VerificationSuite_(authContext, payload) {
  if (!authContext || !authContext.user || authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Only an administrator can run the Step 14 verification suite.'
    );
  }

  if (typeof adminSeedStep9LearningCohort_ === 'function') {
    adminSeedStep9LearningCohort_(authContext, {});
  }

  /* Ensure Settings.ADMIN_NOTIFICATION_EMAIL is configured with a valid school notification address */
  var settingsTbl = readSheetTable_('Settings');
  var configuredEmail = 'registrar.notify@pattanabhumi.edu.th';
  var existingSettingHit =
    settingsTbl && settingsTbl.byId ? settingsTbl.byId.ADMIN_NOTIFICATION_EMAIL : null;
  var existingSettingRec = existingSettingHit
    ? existingSettingHit.record || existingSettingHit
    : null;
  if (existingSettingRec && existingSettingRec.setting_key) {
    var existingEmail = String(existingSettingRec.setting_value || '').trim();
    if (
      !existingEmail ||
      existingEmail === 'placeholder_admin_notify@example.com'
    ) {
      updateSheetRecordById_(
        'Settings',
        'ADMIN_NOTIFICATION_EMAIL',
        {
          setting_value: configuredEmail,
          updated_by_user_id: authContext.user.user_id,
          updated_at_utc: nowUtcIso_()
        },
        Number(existingSettingRec.version || 1)
      );
    } else {
      configuredEmail = existingEmail;
    }
  } else {
    insertSheetRecord_('Settings', {
      setting_key: 'ADMIN_NOTIFICATION_EMAIL',
      setting_value: configuredEmail,
      updated_by_user_id: authContext.user.user_id,
      updated_at_utc: nowUtcIso_(),
      version: 1
    });
  }

  var usersTbl = readSheetTable_('Users');
  var studentA = null;
  var studentB = null;
  var studentC = null;
  for (var i = 0; i < usersTbl.records.length; i++) {
    var u = usersTbl.records[i];
    if (u.username_lower === 'student_a') studentA = u;
    if (u.username_lower === 'student_b') studentB = u;
    if (u.username_lower === 'student_c') studentC = u;
  }
  if (!studentA || !studentB || !studentC) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_NOT_FOUND,
      'Sample students (student_a, student_b, student_c) are required for Step 14 verification.'
    );
  }

  var coursesTbl = readSheetTable_('Courses');
  var courseA = null;
  for (var cIdx = 0; cIdx < coursesTbl.records.length; cIdx++) {
    if (coursesTbl.records[cIdx].course_code === 'BIO-101-CELL') {
      courseA = coursesTbl.records[cIdx];
      break;
    }
  }

  /* Clear any prior rate-limit rows for student_a, student_b, student_c so suite runs cleanly */
  var attemptsTbl = readSheetTable_('LoginAttempts');
  var resetUsers = [studentA.user_id, studentB.user_id, studentC.user_id];
  for (var rIdx = 0; rIdx < resetUsers.length; rIdx++) {
    var rKey = 'unavail:user:' + resetUsers[rIdx];
    if (attemptsTbl.byId[rKey]) {
      updateSheetRecordById_(
        'LoginAttempts',
        rKey,
        {
          failure_count: 0,
          window_start_utc: nowUtcIso_(),
          last_attempt_at_utc: nowUtcIso_(),
          locked_until_utc: '',
          updated_at_utc: nowUtcIso_()
        },
        null
      );
    }
  }

  var stuACtx = { user: studentA, session: { session_id: 'ses_s14_stua' } };
  var stuBCtx = { user: studentB, session: { session_id: 'ses_s14_stub' } };
  var stuCCtx = { user: studentC, session: { session_id: 'ses_s14_stuc' } };

  var suiteRunTag = String(Date.now()).slice(-6);
  var report = {
    suite: 'STEP_14_REPORT_UNAVAILABILITY_AND_EMAIL_VERIFICATION',
    executedAtUtc: nowUtcIso_(),
    executedAtBangkok: formatBangkokTimestamp_(new Date()),
    configuredNotificationRecipient: configuredEmail,
    tests: {}
  };

  /* ========================================================================
   * TEST 1: Successful Email Attempt (Record-before-send, server recipient, header safety)
   * ======================================================================== */
  var logCountBeforeT1 = PB_STEP14_SENT_EMAIL_LOG_.length;
  var idemKeyT1 = 'idem_s14_t1_success_' + suiteRunTag;
  var t1Res = submitStudentUnavailabilityStep14_(stuACtx, {
    unavailableStartDateBkk: '2026-10-20',
    unavailableEndDateBkk: '2026-10-20',
    courseId: courseA ? courseA.course_id : '',
    reason:
      'Attending regional biology olympiad qualification exam in Chiang Mai on 20 Oct 2026.',
    idempotencyKey: idemKeyT1,
    /* Supply an attacker recipient override to prove the backend ignores it */
    to: 'attacker_override@evil.example.com',
    recipient: 'attacker_override@evil.example.com'
  });

  var sentEmailT1 =
    PB_STEP14_SENT_EMAIL_LOG_[PB_STEP14_SENT_EMAIL_LOG_.length - 1] || null;
  var headerCleanCheck =
    sanitizeEmailHeaderTokenStep14_(
      'Test\r\nBcc: victim@example.com\nSubject: Injected',
      120
    ).indexOf('\n') === -1 &&
    sanitizeEmailHeaderTokenStep14_(
      'Test\r\nBcc: victim@example.com\nSubject: Injected',
      120
    ).indexOf('\r') === -1;

  report.tests.test1_successfulEmailAttempt = {
    passed:
      t1Res.requestRecorded === true &&
      t1Res.recordedBeforeEmailAttempt === true &&
      t1Res.emailDeliveryStatus === 'SENT' &&
      t1Res.clientSuppliedRecipientIgnored === true &&
      PB_STEP14_SENT_EMAIL_LOG_.length === logCountBeforeT1 + 1 &&
      Boolean(sentEmailT1) &&
      sentEmailT1.to === configuredEmail &&
      sentEmailT1.body.indexOf('student_a') !== -1 &&
      sentEmailT1.body.indexOf('does NOT automatically cancel') !== -1 &&
      headerCleanCheck === true,
    requestId: t1Res.request.requestId,
    emailDeliveryStatus: t1Res.emailDeliveryStatus,
    recipientUsed: sentEmailT1 ? sentEmailT1.to : '',
    clientSuppliedRecipientIgnored: t1Res.clientSuppliedRecipientIgnored,
    recordedBeforeEmailAttempt: t1Res.recordedBeforeEmailAttempt,
    headerInjectionStripped: headerCleanCheck
  };

  /* ========================================================================
   * TEST 2: Failed Send & Controlled Bounded Retry
   * ======================================================================== */
  var idemKeyT2 = 'idem_s14_t2_failed_' + suiteRunTag;
  var t2Res = submitStudentUnavailabilityStep14_(stuACtx, {
    unavailableStartDateBkk: '2026-10-22',
    unavailableEndDateBkk: '2026-10-22',
    courseId: courseA ? courseA.course_id : '',
    reason:
      'Hospital dental appointment scheduled during afternoon microscopy clinic.',
    idempotencyKey: idemKeyT2,
    _simulateEmailTransportFailure: true
  });

  /* Verify the row is durably stored in UnavailabilityRequests with FAILED status */
  var sheetAfterT2 = readSheetTable_('UnavailabilityRequests');
  var persistedT2Row =
    sheetAfterT2.byId[t2Res.request.requestId] &&
    sheetAfterT2.byId[t2Res.request.requestId].record;

  /* Test controlled manual retry #1 (also fails when transport still down) */
  var retry1Res = retryUnavailabilityEmailStep14_(stuACtx, {
    requestId: t2Res.request.requestId,
    _simulateEmailTransportFailure: true
  });

  /* Test controlled manual retry #2 (succeeds when transport recovers) */
  var retry2Res = retryUnavailabilityEmailStep14_(stuACtx, {
    requestId: t2Res.request.requestId
  });

  /* Verify retry #3 is blocked because status is now SENT */
  var retryAfterSentCode = '';
  try {
    retryUnavailabilityEmailStep14_(stuACtx, {
      requestId: t2Res.request.requestId
    });
  } catch (eRetrySent) {
    retryAfterSentCode = eRetrySent.code || '';
  }

  report.tests.test2_failedSendAndControlledRetry = {
    passed:
      t2Res.requestRecorded === true &&
      t2Res.emailDeliveryStatus === 'FAILED' &&
      Boolean(persistedT2Row) &&
      retry1Res.emailDeliveryStatus === 'FAILED' &&
      retry1Res.retryNumber === 1 &&
      retry2Res.emailDeliveryStatus === 'SENT' &&
      retry2Res.retryNumber === 2 &&
      retryAfterSentCode === 'ERR_INVALID_STATE_TRANSITION',
    requestId: t2Res.request.requestId,
    initialStatus: t2Res.emailDeliveryStatus,
    afterRetry1Status: retry1Res.emailDeliveryStatus,
    afterRetry2Status: retry2Res.emailDeliveryStatus,
    retryAfterSentBlockedCode: retryAfterSentCode
  };

  /* ========================================================================
   * TEST 3: Duplicate Submission (Idempotency)
   * ======================================================================== */
  var logCountBeforeT3Replay = PB_STEP14_SENT_EMAIL_LOG_.length;
  var unavailCountBeforeT3Replay =
    readSheetTable_('UnavailabilityRequests').records.length;

  /* 3A. Exact replay with same idempotencyKey and identical payload */
  var t3ReplayRes = submitStudentUnavailabilityStep14_(stuACtx, {
    unavailableStartDateBkk: '2026-10-20',
    unavailableEndDateBkk: '2026-10-20',
    courseId: courseA ? courseA.course_id : '',
    reason:
      'Attending regional biology olympiad qualification exam in Chiang Mai on 20 Oct 2026.',
    idempotencyKey: idemKeyT1
  });

  var logCountAfterT3Replay = PB_STEP14_SENT_EMAIL_LOG_.length;
  var unavailCountAfterT3Replay =
    readSheetTable_('UnavailabilityRequests').records.length;

  /* 3B. Conflicting payload with same idempotencyKey must throw ERR_IDEMPOTENCY_CONFLICT */
  var conflictErrorCode = '';
  try {
    submitStudentUnavailabilityStep14_(stuACtx, {
      unavailableStartDateBkk: '2026-10-29',
      unavailableEndDateBkk: '2026-10-29',
      courseId: courseA ? courseA.course_id : '',
      reason: 'Different date and reason using the same idempotency key.',
      idempotencyKey: idemKeyT1
    });
  } catch (eConflict) {
    conflictErrorCode = eConflict.code || '';
  }

  report.tests.test3_duplicateSubmissionIdempotency = {
    passed:
      t3ReplayRes.idempotentReplay === true &&
      t3ReplayRes.emailResent === false &&
      t3ReplayRes.request.requestId === t1Res.request.requestId &&
      logCountAfterT3Replay === logCountBeforeT3Replay &&
      unavailCountAfterT3Replay === unavailCountBeforeT3Replay &&
      conflictErrorCode === 'ERR_IDEMPOTENCY_CONFLICT',
    idempotentReplayReturnedExistingId:
      t3ReplayRes.request.requestId === t1Res.request.requestId,
    noDuplicateRowCreated:
      unavailCountAfterT3Replay === unavailCountBeforeT3Replay,
    noDuplicateEmailSent: logCountAfterT3Replay === logCountBeforeT3Replay,
    mismatchedPayloadBlockedWithCode: conflictErrorCode
  };

  /* ========================================================================
   * TEST 4: Per-User Submission Frequency Rate Limit (Max 5 per 15 minutes)
   * ======================================================================== */
  var rateLimitCodes = [];
  var rateLimitBlockedOnAttempt = 0;
  /* Use student_c for clean 1..6 rate limit test */
  for (var attemptNum = 1; attemptNum <= 6; attemptNum++) {
    try {
      submitStudentUnavailabilityStep14_(stuCCtx, {
        unavailableStartDateBkk: '2026-11-0' + String(attemptNum),
        unavailableEndDateBkk: '2026-11-0' + String(attemptNum),
        reason:
          'Student C rate limit verification submission #' +
          String(attemptNum) +
          ' for planned family travel.',
        idempotencyKey:
          'idem_s14_t4_rl_' + suiteRunTag + '_' + String(attemptNum)
      });
      rateLimitCodes.push('OK');
    } catch (rlErr) {
      rateLimitCodes.push(rlErr.code || 'ERR');
      if (!rateLimitBlockedOnAttempt) {
        rateLimitBlockedOnAttempt = attemptNum;
      }
    }
  }

  /* Reset student_c rate limit after test so interactive testing is not locked */
  updateSheetRecordById_(
    'LoginAttempts',
    'unavail:user:' + studentC.user_id,
    {
      failure_count: 0,
      locked_until_utc: '',
      updated_at_utc: nowUtcIso_()
    },
    null
  );

  report.tests.test4_rateLimitEnforced = {
    passed:
      rateLimitBlockedOnAttempt === 6 &&
      rateLimitCodes[0] === 'OK' &&
      rateLimitCodes[4] === 'OK' &&
      rateLimitCodes[5] === 'ERR_RATE_LIMITED',
    attemptOutcomes: rateLimitCodes,
    blockedOnAttemptNumber: rateLimitBlockedOnAttempt
  };

  /* ========================================================================
   * TEST 5: Another User's Request Access Blocked (Cross-Student Isolation)
   * ======================================================================== */
  var crossReadCode = '';
  var crossRetryCode = '';
  var studentAdminListCode = '';
  var spoofedUserIdSubmitCode = '';

  try {
    getStudentUnavailabilityByIdStep14_(stuBCtx, {
      requestId: t1Res.request.requestId
    });
  } catch (eRead) {
    crossReadCode = eRead.code || '';
  }

  try {
    retryUnavailabilityEmailStep14_(stuBCtx, {
      requestId: t2Res.request.requestId
    });
  } catch (eRetryCross) {
    crossRetryCode = eRetryCross.code || '';
  }

  try {
    adminListUnavailabilityRequestsStep14_(stuBCtx, {});
  } catch (eAdminList) {
    studentAdminListCode = eAdminList.code || '';
  }

  try {
    submitStudentUnavailabilityStep14_(stuBCtx, {
      userId: studentA.user_id,
      unavailableStartDateBkk: '2026-10-25',
      reason: 'Attempting to spoof student_a user_id from student_b session.',
      idempotencyKey: 'idem_s14_t5_spoof_' + suiteRunTag
    });
  } catch (eSpoof) {
    spoofedUserIdSubmitCode = eSpoof.code || '';
  }

  var stuBOwnList = listStudentOwnUnavailabilityStep14_(stuBCtx, {});
  var stuBSeesStuARequests = false;
  for (var bIdx = 0; bIdx < stuBOwnList.requests.length; bIdx++) {
    if (stuBOwnList.requests[bIdx].userId !== studentB.user_id) {
      stuBSeesStuARequests = true;
    }
  }

  report.tests.test5_anotherUsersRequestAccessBlocked = {
    passed:
      crossReadCode === 'ERR_FORBIDDEN_RESOURCE' &&
      crossRetryCode === 'ERR_FORBIDDEN_RESOURCE' &&
      studentAdminListCode === 'ERR_FORBIDDEN_ROLE' &&
      spoofedUserIdSubmitCode === 'ERR_FORBIDDEN_RESOURCE' &&
      stuBSeesStuARequests === false,
    crossStudentGetRequestCode: crossReadCode,
    crossStudentRetryCode: crossRetryCode,
    studentCallingAdminListCode: studentAdminListCode,
    spoofedUserIdSubmitCode: spoofedUserIdSubmitCode,
    studentBListLeakedOtherStudentRows: stuBSeesStuARequests
  };

  /* ========================================================================
   * TEST 6: Uncertain Send Outcome Handling (Send Succeeds, Post-Send DB Update Fails)
   * ======================================================================== */
  var idemKeyT6 = 'idem_s14_t6_uncertain_' + suiteRunTag;
  var t6Res = submitStudentUnavailabilityStep14_(stuBCtx, {
    unavailableStartDateBkk: '2026-10-28',
    unavailableEndDateBkk: '2026-10-29',
    reason:
      'Representing school at Northern Thailand Science Symposium (2-day absence).',
    idempotencyKey: idemKeyT6,
    _simulatePostSendRecordFailure: true
  });

  /* Verify manual retry is blocked on UNCERTAIN_POST_SEND_UPDATE_FAILED to prevent duplicate emails */
  var uncertainRetryBlockedCode = '';
  try {
    retryUnavailabilityEmailStep14_(stuBCtx, {
      requestId: t6Res.request.requestId
    });
  } catch (eUncertainRetry) {
    uncertainRetryBlockedCode = eUncertainRetry.code || '';
  }

  /* Verify idempotent replay of the uncertain request also does NOT resend email */
  var logCountBeforeT6Replay = PB_STEP14_SENT_EMAIL_LOG_.length;
  var t6ReplayRes = submitStudentUnavailabilityStep14_(stuBCtx, {
    unavailableStartDateBkk: '2026-10-28',
    unavailableEndDateBkk: '2026-10-29',
    reason:
      'Representing school at Northern Thailand Science Symposium (2-day absence).',
    idempotencyKey: idemKeyT6
  });
  var logCountAfterT6Replay = PB_STEP14_SENT_EMAIL_LOG_.length;

  report.tests.test6_uncertainSendOutcomeHandledHonestly = {
    passed:
      t6Res.requestRecorded === true &&
      t6Res.recordedBeforeEmailAttempt === true &&
      t6Res.uncertainOutcome === true &&
      t6Res.emailDeliveryStatus === 'UNCERTAIN_POST_SEND_UPDATE_FAILED' &&
      t6Res.request.canRetryEmail === false &&
      uncertainRetryBlockedCode === 'ERR_INVALID_STATE_TRANSITION' &&
      t6ReplayRes.idempotentReplay === true &&
      logCountAfterT6Replay === logCountBeforeT6Replay,
    requestId: t6Res.request.requestId,
    emailDeliveryStatus: t6Res.emailDeliveryStatus,
    uncertainOutcomeFlag: t6Res.uncertainOutcome,
    manualRetryBlockedCode: uncertainRetryBlockedCode,
    replayDidNotResendEmail: logCountAfterT6Replay === logCountBeforeT6Replay
  };

  var allPassed = true;
  var tKeys = Object.keys(report.tests);
  for (var k = 0; k < tKeys.length; k++) {
    if (!report.tests[tKeys[k]] || report.tests[tKeys[k]].passed !== true) {
      allPassed = false;
    }
  }
  report.allPassed = allPassed;

  return report;
}

function handleAdminRunStep14VerificationSuite_(payload, context) {
  return withIsolatedSyntheticSandboxStep15_(function () {
    return adminRunStep14VerificationSuite_(context.authContext, payload);
  });
}

// === END OF CalendarService.gs (Complete - Step 13 Class Calendar & Step 14 Report Unavailability Verified) ===