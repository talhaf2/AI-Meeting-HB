import dotenv from "dotenv";
dotenv.config();

export const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
export const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

// export const SMTP_USER = process.env.EMAIL_USER;
// export const SMTP_PASS = process.env.EMAIL_PASS;
// export const MODE = process.env.MODE || 'dev';

// export const EMAIL_RECIPIENTS = MODE === "prod"
//   ? ["talha.kh58@gmail.com"]
//   : ["talha.kh58@gmail.com"]; // adjust later for staging/test if needed
