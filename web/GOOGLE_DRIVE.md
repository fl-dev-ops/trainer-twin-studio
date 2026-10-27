# Google Drive imports

The Knowledge → Add source → Google Drive option imports selected files once. It does not crawl folders, watch for changes, request whole-Drive access, enqueue ingestion, or generate embeddings.

## Google Cloud setup

1. In one Google Cloud project, enable **Google Drive API** and **Google Picker API**.
2. Configure the OAuth consent screen. Request only `https://www.googleapis.com/auth/drive.file`. In testing mode, add the Google accounts that will test imports.
3. Create an OAuth **Web application** client. Set its authorized redirect URI to:
   `https://dash.trainertwin.com/api/connectors/google-drive/oauth/callback`
   Add the studio's HTTPS origin as an authorized JavaScript origin.
4. Create a browser API key in the same project. Restrict it to Google Picker API and the studio's website referrer(s), for example `https://dash.trainertwin.com/*`. Do not use an unrestricted server API key.
5. Set these server environment variables (also listed in `.env.example`):

   ```dotenv
   GOOGLE_DRIVE_CLIENT_ID=
   GOOGLE_DRIVE_CLIENT_SECRET=
   GOOGLE_DRIVE_REDIRECT_URI=https://dash.trainertwin.com/api/connectors/google-drive/oauth/callback
   GOOGLE_DRIVE_PICKER_API_KEY=
   GOOGLE_DRIVE_PROJECT_NUMBER=
   GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY=
   ```

   `PROJECT_NUMBER` is the numeric Cloud project number, not the project ID. Generate a dedicated encryption key with `openssl rand -base64 32`.

6. Restart the web app. Sign in as an admin/team member, open **Twin’s brain → Add source → Google Drive**, connect, select files, and click Import.

For local testing, use a Google-accepted HTTPS staging/tunnel domain that serves the studio (configure the app's base domain and auth URLs consistently). Google may reject custom `*.localhost` OAuth callback domains. The callback origin and the page serving Picker must match `GOOGLE_DRIVE_REDIRECT_URI`. Set the corresponding authorized origins, redirect URI and API-key website restrictions for that test domain.

No database migration or extra package is needed. Google API script loads only when someone chooses Drive files.

## Behavior and limits

- Only admin/team studio members may authorize or import. Authorization is bound to the initiating org and user.
- OAuth uses state + PKCE. Encrypted, HttpOnly, host-only cookies hold the 10-minute OAuth state and an access token valid for at most one hour. No refresh token is saved. Cookie state is cleared on callback; Google authorization codes are single use.
- The authenticated picker endpoint supplies the short-lived, `drive.file`-scoped access token to Google's picker. It is never stored in localStorage or sent as part of import request bodies. Keep tokens and picker session responses out of logs/analytics.
- The app downloads only the file IDs selected by the user. Names, types, download permissions and sizes come from the Google Drive API, not the browser.
- Binary documents are downloaded unchanged. Native Google Docs/Sheets/Slides are exported to DOCX/XLSX/PPTX; these exported files are the originals kept in S3. Google-native documents have no downloadable original binary.
- Original/exported file: `<existing-S3-base-prefix>/<org>/knowledge/files/<doc-id>/<filename>`.
- Converted Markdown: `<existing-S3-base-prefix>/<org>/ingest/files/<doc-id>/content.md`.
- The existing upload service marks complete only when both writes succeed. Neither import nor upload queues ingestion.
- Up to 50 files may be selected. Each is imported separately, with individual failure/retry status. Files are bounded to 25 MB; Google Workspace exports also have Google's 10 MB limit.
- A repeat import of an already uploaded Drive file in the same org is reported as already imported. To replace a snapshot after editing it in Drive, delete the local copy and import it again. This is a sequential duplicate check, not an exactly-once guarantee for concurrent imports.
- Drive provenance is saved in the existing document `externalId`; the document list exposes its original Drive URL. Imported files appear alongside uploaded files, not as synced connector sources.
- Deleting a knowledge document removes our original and Markdown copies, not the Drive file. “Use another account” forgets the current import-session cookie; it does not revoke permissions in the user's Google account.
- Other sources (Notion/YouTube) keep their existing behavior.

## Verification

Run each suite separately because this repository's Bun module mocks are process-global:

```sh
bun test tests/lib/google-drive.test.ts
bun test tests/api/google-drive-import.test.ts
bun test tests/lib/knowledge-upload.test.ts
bunx tsc --noEmit
```

A live Google consent/picker/import test still requires the Cloud configuration above. Test success, cancellation, expired authorization, one denied/unsupported file among successful imports, repeat import, and deletion of the local copy.

Official references:
- https://developers.google.com/workspace/drive/picker/guides/overview
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export
