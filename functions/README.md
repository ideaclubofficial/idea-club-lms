# IDEA CLUB Functions

## Setup Google Drive OCR

The payment slip OCR function uploads student slip images to Google Drive and uses Cloud Vision OCR for a first-pass review.

## Required APIs

- Google Drive API
- Cloud Vision API

## Required Local Secret

- Create the real service account JSON at `functions/service-account-drive.json`.
- Do not commit the real `service-account-drive.json` file.
- Share the target Google Drive folder with the service account email as Editor.

## Required Env/Constant

- Set `DRIVE_FOLDER_ID` before deploy, or replace the local placeholder only in a safe deployment environment.
- The code placeholder is `PUT_GOOGLE_DRIVE_FOLDER_ID_HERE`.

## Deploy Command Later

```sh
firebase deploy --only functions:uploadPaymentSlipToDriveAndOcr
```
