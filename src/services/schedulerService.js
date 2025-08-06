import cron from "node-cron";
import { DateTime } from "luxon";
import { postSlackMessages } from "../controllers/slackBot.js";

export function scheduleDailySlackUpdate() {
  cron.schedule(
    "0 9 * * *", // 9:00 AM Pacific
    () => {
      const nowPST = DateTime.now().setZone("America/Los_Angeles");
      console.log("🌎 Pacific Time:", nowPST.toFormat("MMMM d, yyyy – h:mm a ZZZZ"));
      console.log(`📊 Running daily Slack update for ${nowPST.toISODate()} (PST)`);
      postSlackMessages();
    },
    {
      timezone: "America/Los_Angeles",
    }
  );
}
