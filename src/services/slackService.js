import axios from "axios";
import PQueue from "p-queue";
import { SLACK_BOT_TOKEN, SLACK_CHANNEL_ID } from "../../config/env.js";
import { withRetry } from "../utils/retry.js";

const queue = new PQueue({ concurrency: 1, interval: 1000 });

export async function sendSlackMessage(text) {
  return queue.add(() =>
    withRetry(() =>
      axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          channel: SLACK_CHANNEL_ID,
          text,
          mrkdwn: true,
        },
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
