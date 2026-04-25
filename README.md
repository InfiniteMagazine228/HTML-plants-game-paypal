# Grow a Garden Pro

Full-stack version:

- Frontend: HTML/CSS/JS
- Backend: Node.js + Express
- Auth + database: Supabase
- Payment: PayPal Orders API + webhook
- Deploy: Render Web Service

## 1. Supabase setup

Create a Supabase project, then run `schema.sql` in SQL Editor.

Enable Email/Password auth:

Authentication -> Providers -> Email

## 2. PayPal setup

Create a PayPal Developer app:

https://developer.paypal.com/dashboard/applications/sandbox

Copy:

- Client ID
- Secret

Create a webhook in PayPal Developer dashboard.

Webhook URL:

```txt
https://YOUR-RENDER-APP.onrender.com/api/paypal/webhook
```

Events:

- CHECKOUT.ORDER.APPROVED
- PAYMENT.CAPTURE.COMPLETED

Copy the webhook ID.

## 3. Render setup

Create New -> Web Service.

Build command:

```txt
npm install
```

Start command:

```txt
npm start
```

Environment variables:

```txt
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
APP_URL=https://YOUR-RENDER-APP.onrender.com
```

## Important

Do not put SUPABASE_SERVICE_ROLE_KEY or PayPal secret in frontend JavaScript.
They must only stay in Render environment variables.
