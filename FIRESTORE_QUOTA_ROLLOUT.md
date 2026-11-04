# Firestore quota optimization rollout

The optimized loaders remain disabled until `settings/main.studentSearchIndexVersion`
and `settings/main.quotaOptimizedLoadingVersion` are both at least `1`.

## 1. Deploy infrastructure

Cloud Functions v2 requires the Firebase project to be on the Blaze plan even if
daily Firestore usage remains inside the no-cost quota. Confirm billing and a budget
alert before deploying the search-index triggers.

Deploy indexes and rules before the functions and web loader:

```sh
firebase deploy --only firestore:indexes,firestore:rules
firebase deploy --only functions
```

Wait until every composite index reports `Enabled` in Firebase Console.

## 2. Preview and backfill

The command is dry-run by default. It never writes unless `--write` is present.
Each run is capped at 15,000 writes and each batch at 400 writes.

```sh
npm run backfill:student-search -- --max-writes=15000
npm run backfill:student-search -- --write --max-writes=15000
```

If the output reports `completed:false`, continue from the exact cursor printed as
`resumeAfter`:

```sh
npm run backfill:student-search -- --write --resume-after=LAST_STUDENT_ID --max-writes=15000
```

Do not use `--activate` until the final run reports `completed:true`. The completed
run writes `studentSearchIndexVersion: 1` but leaves the optimized loader off.

## 3. Activate and monitor

Preview activation, then enable it without rewriting the index:

```sh
npm run backfill:student-search -- --activate-only
npm run backfill:student-search -- --write --activate-only
```

Enable for staff first, verify Firestore Usage and the staff/student flows, then
continue monitoring for 48 hours. A full backup remains an explicit Super Admin
operation and intentionally performs high-read unbounded queries.

## Rollback

Set `settings/main.quotaOptimizedLoadingVersion` to `0`. Existing search-index
documents and canonical payment fields are backward-compatible and do not need to
be deleted. The legacy loader remains available while the flag is off.
