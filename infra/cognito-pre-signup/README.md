# Cognito pre sign-up rule: only your domain can register

CloudCraft already refuses other domains before it talks to Cognito (`ALLOWED_EMAIL_DOMAINS`). But the Cognito app client ID is not secret enough
to rely on: anyone who learns it can call Cognito directly and have it create an account and send a verification code to **any** address, never
touching CloudCraft. This small Lambda function closes that gap **inside Cognito**.

It runs every time Cognito is about to create a user (sign-up, an administrator creating a user, or a sign-in through an outside provider) and
refuses when the address is not on an allowed domain. The rule is the same as CloudCraft's: exactly one `@`, and what follows must equal a
listed domain. `x@neozaar.com.evil.com`, `x@sub.neozaar.com` and look-alike letters are refused. If its setting is missing or wrong it refuses
**everyone** (a mistake can never open registration).

You do this once, in your AWS account, in the same **region** as the user pool. It costs nothing worth mentioning (a few milliseconds per sign-up).

## 1. Create the function

1. AWS Console, **Lambda**, **Create function**, "Author from scratch".
2. Name: `cloudcraft-pre-signup`. Runtime: **Node.js 20.x** (or newer). Leave the rest as it is. **Create function**.
3. In the code editor, open `index.mjs`, delete what is there, paste the whole of [`index.mjs`](./index.mjs) from this folder, and press **Deploy**.
4. **Configuration**, **Environment variables**, **Edit**, add:
   - Key `ALLOWED_EMAIL_DOMAINS`, value `neozaar.com` (the same value as in CloudCraft's `.env`; several domains are separated by commas).

## 2. Try it without touching anything real

In the function's **Test** tab make a test event and paste this (it is what Cognito sends):

```json
{
  "version": "1", "triggerSource": "PreSignUp_SignUp", "region": "eu-north-1", "userPoolId": "pool", "userName": "test",
  "request": { "userAttributes": { "email": "someone@gmail.com" }, "validationData": null },
  "response": { "autoConfirmUser": false, "autoVerifyEmail": false, "autoVerifyPhone": false }
}
```

Press **Test**. It must **fail** with `Access is limited to @neozaar.com email addresses.` Now change the address to `anyone@neozaar.com` and test again:
it must **succeed** and return the event unchanged.

## 3. Attach it to the user pool

1. AWS Console, **Cognito**, **User pools**, open the pool CloudCraft uses.
2. **Extensions** (older consoles: "User pool properties", "Lambda triggers"), **Add Lambda trigger**.
3. Trigger type **Sign-up**, then **Pre sign-up trigger**, and choose `cloudcraft-pre-signup`. Save. (The console gives Cognito permission to call
   the function for you.)

## 4. Check it end to end

In the user pool, **Users**, **Create user**, and use an address such as `test@gmail.com` with a temporary password. It must be **refused** with
an error that starts `PreSignUp failed with error Access is limited to @neozaar.com email addresses.` Do not create a real user with a
`@neozaar.com` address just to test: that would send a real invitation. The Lambda test in step 2 already proves that case.

Then try creating an account on CloudCraft with a `@neozaar.com` address as usual. It must still work.

## Things to know

- **Two places hold the list.** CloudCraft's `.env` (`ALLOWED_EMAIL_DOMAINS`) and this function's environment variable. Change both together.
- **If sign-ups suddenly all fail** with "Sign-up is not available right now", the function's `ALLOWED_EMAIL_DOMAINS` is empty or not a domain. Fix it
  in the Lambda settings. The reason is in the function's CloudWatch logs.
- **Existing users are not removed.** Accounts that were registered before this (for example with a Gmail address) stay in the pool. CloudCraft
  already refuses them at sign-in. You can delete them under **Users** if you want them gone.
- **To undo it,** remove the trigger from the user pool (step 3 in reverse). Nothing else changes.
- **Logs** are in CloudWatch under `/aws/lambda/cloudcraft-pre-signup`. They name the kind of sign-up that was refused, never the email address.
