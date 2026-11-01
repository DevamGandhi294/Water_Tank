Put secret files here on the server (this folder is mounted read-only into the backend at /run/secrets).
Everything except this README is git-ignored.

- fcm-service-account.json: Firebase service account for push notifications.
  Then set FCM_SERVICE_ACCOUNT_FILE=/run/secrets/fcm-service-account.json in .env.
