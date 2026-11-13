# Duplicate function definitions in the backend

Apps Script loads every `.gs` file into one global scope. When the same function name is defined more than once, **the definition in the file that loads last wins** (file order in the Apps Script editor sidebar / `filePushOrder`). This project was ported **as-is** (faithful port), so behaviour is unchanged, but the duplication should be cleaned up.

- Functions defined more than once with **identical** bodies: **306** (harmless; mostly copies inside `Code.gs`).
- Functions defined more than once with **different** bodies: **17** (listed below; the live version depends on file order).

> Before deduplicating, open the Apps Script editor and note the file order, or set `filePushOrder` in `.clasp.json`, so you keep the version that actually runs today. Pay particular attention to the authentication functions (`authenticateUserLogin_`, `requireAuthenticatedSessionGuard_`).

| Function | Definitions (file:line) |
|---|---|
| `authenticateUserLogin_` | `AuthService.gs:589`, `Code.gs:4968` |
| `bootstrapInitialAdminFromEditor_` | `AuthService.gs:1210`, `Code.gs:5619` |
| `deleteSheetRecordById_` | `AdminService.gs:199`, `Code.gs:3562`, `Code.gs:6620`, `SheetRepo.gs:860` |
| `getAuthorizedClassCalendarEventsStep13_` | `CalendarService.gs:1181`, `Code.gs:23122`, `CryptoService.gs:1181` |
| `getUnavailabilityEmailArchitectureExplanationStep14_` | `CalendarService.gs:2446`, `Code.gs:24387`, `CryptoService.gs:2117` |
| `handleAdminListAssessmentScoresPhase4_` | `Code.gs:14438`, `CourseService.gs:4735` |
| `handleAdminListFilesStep8_` | `Code.gs:16552`, `DriveService.gs:2090` |
| `handleAdminRunStep10VerificationSuite_` | `Code.gs:20895`, `PaymentService.gs:4333` |
| `handleAdminRunStep11VerificationSuite_` | `Code.gs:21284`, `PaymentService.gs:4719` |
| `handleAdminRunStep12VerificationSuite_` | `Code.gs:21909`, `PaymentService.gs:5341` |
| `handleAdminRunStep13VerificationSuite_` | `CalendarService.gs:2266`, `Code.gs:24207`, `CryptoService.gs:1933` |
| `handleAdminRunStep14VerificationSuite_` | `CalendarService.gs:4687`, `Code.gs:26628`, `CryptoService.gs:4321` |
| `handleStudentGetProfileStep6_` | `AdminService.gs:2886`, `Code.gs:9150` |
| `readPaymentSupportContactStep11_` | `Code.gs:17253`, `PaymentService.gs:683` |
| `requireAuthenticatedSessionGuard_` | `AuthService.gs:756`, `Code.gs:5188` |
| `resolveNotificationRecipientEmailStep14_` | `CalendarService.gs:2374`, `Code.gs:24315`, `CryptoService.gs:2040` |
| `sendUnavailabilityNotificationEmailStep14_` | `CalendarService.gs:2900`, `Code.gs:24841`, `CryptoService.gs:2571` |
