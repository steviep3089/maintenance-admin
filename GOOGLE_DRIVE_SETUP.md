# Google Drive Setup Guide

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

### 3. Create OAuth 2.0 Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **+ CREATE CREDENTIALS** → **OAuth client ID**
3. If prompted, configure the OAuth consent screen:
   - User Type: **External**
   - App name: "Maintenance Portal"
   - User support email: your email
   - Developer contact: your email
   - Add test users (your admin emails)
   - Click **Save and Continue** through the scopes (no need to add any)
4. Back at Create OAuth client ID:
   - Application type: **Web application**
   - Name: "Maintenance Portal Web Client"
   - Authorized JavaScript origins:
     - `http://localhost:5173` (for development)
     - Add your production URL when deployed
   - Authorized redirect URIs:
     - `http://localhost:5173` (for development)
     - Add your production URL when deployed
5. Click **Create**
6. **Copy the Client ID** (looks like: `123456789-abc.apps.googleusercontent.com`)

### 4. Create API Key

1. Go to **APIs & Services** → **Credentials**
2. Click **+ CREATE CREDENTIALS** → **API key**
3. **Copy the API key**
4. (Optional) Click **Restrict Key**:
   - API restrictions: Select "Google Drive API"
   - Save

### 5. Create/Get Google Drive Folder ID

1. Go to [Google Drive](https://drive.google.com/)
2. Create a new folder called "Maintenance Reports" (or use existing folder)
3. Open the folder
4. Look at the URL in your browser: `https://drive.google.com/drive/folders/FOLDER_ID_HERE`
5. **Copy the FOLDER_ID** (the long string after `/folders/`)

### 6. Update App.jsx Configuration

Open `src/App.jsx` and replace these lines (around line 8-11):

```javascript
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
const GOOGLE_API_KEY = 'YOUR_GOOGLE_API_KEY';
const GOOGLE_DRIVE_FOLDER_ID = 'YOUR_FOLDER_ID';
```

With your actual values:

```javascript
const GOOGLE_CLIENT_ID = '123456789-abc.apps.googleusercontent.com'; // From step 3
const GOOGLE_API_KEY = 'AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // From step 4
const GOOGLE_DRIVE_FOLDER_ID = '1a2B3c4D5e6F7g8H9i0J'; // From step 5
```

### 7. Test the Integration

1. Start your dev server: `npm run dev`
2. Open the portal in your browser
3. Generate a report and click "📧 Email Report to Me"
4. On first use, a Google sign-in popup will appear
5. Sign in and grant access to Google Drive
6. The PDF will be emailed AND saved to your Google Drive folder!

## How It Works

- When you click "📧 Email Report to Me", the system:
  1. Generates a PDF with all defect details and photos (embedded as base64)
  2. Sends the PDF via email to the current user
  3. Uploads the same PDF to your Google Drive folder
  4. Shows success message for both actions

- The first time you use it, you'll be prompted to sign in to Google
- After that, it will remember your authorization

## Troubleshooting

**"Failed to sign in to Google Drive"**
- Make sure you added the correct JavaScript origins in OAuth settings
- Check browser console for detailed error messages

**"Google API not initialized"**
- Wait a few seconds after page load for the API to initialize
- Check if GOOGLE_API_KEY and GOOGLE_CLIENT_ID are correct

**"Upload failed"**
- Verify the GOOGLE_DRIVE_FOLDER_ID is correct
- Make sure the folder is accessible (not deleted/moved)
- Check if you have permission to write to the folder

**Files not showing in Drive**
- Check the specific folder (not "My Drive" root)
- Refresh Google Drive page
- Check "Shared with me" if folder is owned by another account

## Security Notes

- Don't commit the actual API keys to git (keep them in .env or similar)
- The OAuth flow is secure - you authenticate each user individually
- Each user needs Google account access
- Files are uploaded to the folder you specified with the credentials of the signed-in user
