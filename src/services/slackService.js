import axios from "axios";
import PQueue from "p-queue";
import { SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, CALL_SLACK_CHANNEL_ID, PM_SLACK_CHANNEL } from "../../config/env.js";
import { withRetry } from "../utils/retry.js";

const queue = new PQueue({ concurrency: 1, interval: 1000 });

/**
 * Post a Slack message to an explicit channel ID.
 * Use this to support multi-channel posting while keeping existing env-based defaults.
 * Optional `blocks` enables Block Kit (e.g. dividers). `text` is always sent as the
 * notification/fallback preview.
 */
export async function sendSlackMessageToChannel(text, channel, blocks) {
  if (!channel) {
    throw new Error("Slack channel ID is missing");
  }

  const payload = {
    channel,
    text,
    mrkdwn: true,
  };
  if (Array.isArray(blocks) && blocks.length) {
    payload.blocks = blocks;
  }

  return queue.add(() =>
    withRetry(() =>
      axios.post(
        "https://slack.com/api/chat.postMessage",
        payload,
        {
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      )
    )
  );
}

export async function sendSlackMessage(text, blocks) {
  return sendSlackMessageToChannel(text, SLACK_CHANNEL_ID, blocks);
}

export async function sendCallSlackMessage(text) {
  return sendSlackMessageToChannel(text, CALL_SLACK_CHANNEL_ID);
}

export async function sendPmSlackMessage(text) {
  return sendSlackMessageToChannel(text, PM_SLACK_CHANNEL);
}

// -----------------------------
// Mentions / user lookup helpers
// -----------------------------
const slackUserIdByEmailCache = new Map(); // email(lowercased) -> userId | null

export async function lookupSlackUserIdByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  if (slackUserIdByEmailCache.has(normalized)) {
    return slackUserIdByEmailCache.get(normalized);
  }

  try {
    const { data } = await queue.add(() =>
      withRetry(() =>
        axios.get("https://slack.com/api/users.lookupByEmail", {
          params: { email: normalized },
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
        })
      )
    );

    const userId = data?.ok ? data?.user?.id : null;
    slackUserIdByEmailCache.set(normalized, userId);
    return userId;
  } catch (e) {
    slackUserIdByEmailCache.set(normalized, null);
    return null;
  }
}

export async function mentionByEmail(email) {
  const userId = await lookupSlackUserIdByEmail(email);
  return userId ? `<@${userId}>` : "";
}

export async function mentionsFromEmails(emails = []) {
  const list = Array.isArray(emails) ? emails : [];
  const mentions = [];
  for (const email of list) {
    const m = await mentionByEmail(email);
    if (m) mentions.push(m);
  }
  return mentions.join(" ");
}
