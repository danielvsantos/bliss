# Account Security & Sessions

How long you stay signed in to Bliss, how to sign out a device you no longer have, and why Bliss sometimes asks you to confirm it's you.

## How long you stay signed in

Once you sign in — with your password or with Google — Bliss keeps you signed in on that device while you use it, in the browser and in the installed app:

- **Up to 15 days.** After 15 days you sign in again, however often you used Bliss in between.
- **7 days without use.** A device you haven't opened for 7 days signs you out by itself.
- **Behind the scenes** your sign-in is renewed every few minutes while you use the app. You never see this; it just means a stolen sign-in stops working quickly.

The installed app (Add to Home Screen) behaves exactly the same: open it after a few days and you are still signed in.

## Sign out of all other devices

Lost a phone, or signed in on a shared computer? In **Settings → General**, under your password, choose **Sign out of all other devices** and confirm.

- Every other browser and installed app signed in to your account is signed out the next time it does anything.
- The device you're using stays signed in.
- Anyone can use it, whatever their role in the workspace.

**Changing your password** (Settings → General → Change Password) does the same thing automatically: every other device is signed out, and you stay signed in where you changed it.

**Signing out** ends the session on this device only and removes the copy of your data the app keeps on the device.

## "Confirm it's you"

Some actions hand out access to your data, so Bliss wants to be sure it's really you at the keyboard:

- creating an integration or a new API key (Settings → Integrations);
- approving an AI app's connection (for example a Claude connector).

If you signed in within the last 15 minutes, nothing changes. Otherwise Bliss shows a **Confirm it's you** dialog first:

- Enter your **password**, or
- choose **Continue with Google** if you use Google to sign in. You come straight back to where you were — including the connection request you were approving.

A wrong password just shows an error; it never signs you out. Cancel, and nothing is created.

## For self-hosters

No configuration is needed and there are no new environment variables. After upgrading, people who are already signed in stay signed in until their old sign-in expires (at most 24 hours), then sign in once more. If your web app and API are on different domains (`SameSite=None` cookies), make sure `FRONTEND_URL` is the exact address people open — session changes are only accepted from it. Technical details: [`docs/specs/api/01-user-identity.md` §1.5h](/docs/specs/api/01-user-identity).
