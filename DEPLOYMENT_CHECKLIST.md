# IDEA CLUB LMS Deployment Checklist

## Before Deploy

- Commit `index.html` together with `assets/styles.css`; the page now depends on the external stylesheet.
- Publish `firestore.rules` and `storage.rules` to Firebase before opening real student/admin data.
- Create the first admin profile at `users/{uid}` after Firebase Auth user creation:

```json
{
  "role": "admin",
  "appRole": "SuperAdmin",
  "permissions": ["admin.full"],
  "status": "active"
}
```

- Keep `.env.local` out of git. `.env.example` is only a template for a future build setup; the current static `index.html` still contains the Firebase web config.

## Quick Smoke Test

- Open the site through a local server, not only by double-clicking the file.
- Confirm `assets/styles.css` returns HTTP 200 in DevTools Network.
- Login as admin and open: Dashboard, Students, Courses, Payments, Settings.
- Login as a student and check: course status, payment QR, receipts, exam links.
- Test mobile width around 390px and confirm admin menu/table areas scroll without page overflow.
