# Google Drive Setup Guide (Server-Side)

This portal uploads Drive reports through a Supabase Edge Function using a Google service account. No user sign-in prompts are required.

## Steps to Enable Google Drive Storage

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Name it "Maintenance Portal" or similar
4. Click "Create"

### 2. Enable Google Drive API

1. In the Google Cloud Console, go to **APIs & Services** → **Library**
2. Search for "Google Drive API"
3. Click on it and press **Enable**

### 3. Create a Service Account

1. Go to **APIs & Services** → **Credentials**
2. Click **+ CREATE CREDENTIALS** → **Service account**
3. Name it "maintenance-portal-drive" (or similar)
4. Click **Create and Continue**
5. You can skip role assignment (Drive access is via folder sharing)
6. Click **Done**

### 4. Create a Service Account Key

1. Open the new service account
2. Go to the **Keys** tab
3. Click **Add Key** → **Create new key**
4. Choose **JSON** and download the key

### 5. Share the Drive Folder

1. Open your target Google Drive folder
2. Click **Share**
3. Add the service account email (from the JSON key) as **Editor**

> For Shared Drives: add the service account as a member of the Shared Drive (Manager or Content manager) and ensure it can access the folder.

### 6. Set Supabase Function Environment Variables

In your Supabase project settings, add these environment variables:

- `GOOGLE_SERVICE_ACCOUNT_JSON` = the entire JSON key contents
- `GOOGLE_DRIVE_FOLDER_ID` = the folder ID from the Drive URL

Notes:
- Keep the JSON exactly as-is (including line breaks). Supabase supports multiline secrets.
- Do not commit the JSON key to git.

### 7. Deploy the Edge Function

Deploy the new function:

```bash
supabase functions deploy upload-drive
```

### 8. Test the Integration

1. Start your dev server: `npm run dev`
2. Open the portal in your browser
3. Generate a report and click "Save to Drive"
4. The PDF should appear in the Drive folder without any Google sign-in prompt

## Troubleshooting

**"Drive upload failed"**
- Confirm the service account email is shared on the folder
- Confirm the folder ID is correct
- Ensure the Drive API is enabled in the Google Cloud project

**"Missing GOOGLE_SERVICE_ACCOUNT_JSON"**
- Confirm the secret is set in Supabase and redeploy the function

**Files not showing in Drive**
- Check the specific folder (not "My Drive" root)
- Refresh the Drive page
- For Shared Drives, confirm the service account is a member

## Security Notes

- Do not commit the service account JSON key to git
- Limit access to the service account by sharing only the target folder
- All uploads are performed by the service account identity
