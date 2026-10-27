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

## Local testing (no tunnel)

1. Leave the app on `https://dash.trainertwin.localhost` and keep Next dev listening on port 3000.
2. In the OAuth client's **Authorized redirect URIs**, add exactly:
   `http://localhost:3000/api/connectors/google-drive/oauth/local-callback`
   Keep the production callback too if you use the same client for both environments. Google accepts literal `localhost`; do not register `dash.trainertwin.localhost` as an OAuth redirect.
3. Add `https://dash.trainertwin.localhost/*` to the Picker browser API key's allowed website referrers. This is an API-key restriction, not an OAuth redirect or an OAuth JavaScript origin. The authorization-code flow runs server-side, not through Google's browser sign-in SDK.
4. Ensure your Google account is on the consent screen's **Test users** list while the app is in testing mode.
5. Set in local `web/.env`:

   ```dotenv
   GOOGLE_DRIVE_REDIRECT_URI=http://localhost:3000/api/connectors/google-drive/oauth/local-callback
   ```

6. Restart `next dev`, sign in at the normal local studio, and open **Knowledge → Add source → Google Drive → Connect Google Drive**. Finish consent, choose a small file, and import it. Confirm it appears in Knowledge and that both S3 copies exist.

The local bridge redirects Google's code/state back to the fixed HTTPS studio callback. Only that callback reads the existing studio session/state cookies, validates state + PKCE, exchanges the code (using the registered localhost redirect URI), and sets the encrypted access cookie. No token or cookie is issued on plain-HTTP localhost. Cancellation takes the same return path. The bridge is disabled in production, only works when the app's base domain ends in `.localhost`, and rejects requests on any origin other than the configured loopback origin. Treat OAuth callback URLs as sensitive and do not paste them into logs or chat.

For a staging/tunnel setup, use an HTTPS studio origin consistently for the app, OAuth redirect and browser API-key referrer restrictions instead; the bridge isn't needed.

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
