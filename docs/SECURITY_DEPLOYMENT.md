# Baby家計簿 private Firestore access migration

## Risk

The public site formerly used `signInAnonymously()` and a fixed, public `SPACE_ID`. The app also inserted the current user into `memberUids` without an admin approval gate. Neither a Firebase client API key nor a fixed path is an authorization secret. Security depends on the actual Firestore rules.

## Admin prerequisites (before merging/deploying)

1. Export Firestore backup and local CSV on both devices. Avoid losing local-only records.
2. Enable Google Authentication in Firebase Authentication. Both partners must sign in to gather their distinct Firebase UIDs.
3. In Firestore Console (trusted admin), create `approvedBudgetUsers/<UID>` documents for the two approved users. The client must have NO permission to create or update these.
4. Merge the `docs/firestore-rules-fragment.rules` match blocks into the EXISTING entire project's Firestore rules and deploy. These are fragments; do not overwrite other apps' rules. Remove broader overlapping grants, or the fragment alone will not reliably block unapproved access.
5. In Rules Playground test approved/unauthorized/anonymous read/write on all budget documents, nested backups and history. Check with the Firebase Emulator as well.
6. Deploy Google Pages only after server rules are active. Existing anonymous users must explicitly sign in and retain their exported data.
7. Keep `sync-config.js` public API key, but enforce Firebase API key restrictions and quotas in Google Cloud Console.

This PR gates client sync on a non-anonymous Google identity and removes public client-driven membership changes. It does NOT by itself harden Firebase server rules. The site remains usable locally offline when unauthenticated.
