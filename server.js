import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cron from "node-cron";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // Optional: for sending group summaries

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const app = express();
app.use(express.json());

// Store chat info
async function storeChat(chat) {
  const { id, username } = chat;

  const { error } = await supabase.from("chats").upsert(
    { id, username, first_seen: new Date() },
    { onConflict: "id" }
  );

  if (error) {
    console.error("Error storing chat info:", error);
  } else {
    console.log(`Stored chat id: ${id}, username: ${username || "N/A"}`);
  }
}

// Store user activity message
async function storeUserActivity(msg) {
  const userId = msg.from.id;
  const username = msg.from.username || "unknown";

  let content = "";
  let messageType = "text";

  if (msg.text) {
    content = msg.text;
    if (content.includes("youtube.com") || content.includes("youtu.be")) {
      messageType = "youtube_link";
    }
  } else if (msg.photo) {
    messageType = "photo";
    content = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.video) {
    messageType = "video";
    content = msg.video.file_id;
  }

  const { error } = await supabase.from("user_activity").insert({
    user_id: userId,
    username: username,
    message_type: messageType,
    content: content,
    activity_date: new Date().toISOString().slice(0, 10),
  });

  if (error) {
    console.error("Error storing user activity:", error);
  } else {
    console.log(`Stored activity for user: ${username}`);
  }
}

// Generate AI summary from texts
async function generateAISummary(texts) {
  if (!texts || texts.length === 0) {
    return "No study activities recorded today.";
  }

  const joinedText = texts.join("\n");
  const prompt = `Analyze the following study activities and provide a concise summary with 3-5 key points about what was studied today:\n\n${joinedText}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error generating AI summary:", error);
    return "Unable to generate summary at this moment.";
  }
}

// Send daily individual reports with AI summary
async function sendDailyReports() {
  console.log("Starting daily report generation...");

  const today = new Date().toISOString().slice(0, 10);

  // Fetch all unique users with activity today
  const { data: users, error } = await supabase
    .from("user_activity")
    .select("user_id, username")
    .eq("activity_date", today)
    .order("user_id");

  if (error) {
    console.error("Error fetching users:", error);
    return;
  }

  if (!users || users.length === 0) {
    console.log("No user activity found for today.");
    return;
  }

  // Remove duplicates
  const uniqueUsers = [...new Map(users.map((u) => [u.user_id, u])).values()];

  let reportsSent = 0;

  for (const user of uniqueUsers) {
    try {
      // Fetch all activities for this user today
      const { data: activities, error: activitiesError } = await supabase
        .from("user_activity")
        .select("message_type, content")
        .eq("user_id", user.user_id)
        .eq("activity_date", today);

      if (activitiesError) {
        console.error(`Error fetching activities for user ${user.user_id}:`, activitiesError);
        continue;
      }

      // Extract text and YouTube links for AI summary
      const textContents = activities
        .filter(
          (a) => a.message_type === "text" || a.message_type === "youtube_link"
        )
        .map((a) => a.content);

      // Generate AI summary
      const aiSummary = await generateAISummary(textContents);

      // Count activity types
      const photoCount = activities.filter((a) => a.message_type === "photo").length;
      const videoCount = activities.filter((a) => a.message_type === "video").length;
      const textCount = textContents.length;

      // Compose personalized report
      const report = `📚 **Daily Study Report for ${user.username || `User ${user.user_id}`}**\n\n**AI Summary:**\n${aiSummary}\n\n**Activity Count:**\n• Text/Links: ${textCount}\n• Photos: ${photoCount}\n• Videos: ${videoCount}\n• Total: ${activities.length}`;

      // Send private message to user
      await bot.sendMessage(user.user_id, report, { parse_mode: "Markdown" });
      reportsSent++;
      console.log(`Report sent to ${user.username || user.user_id}`);
    } catch (err) {
      console.error(`Error sending report to user ${user.user_id}:`, err);
    }
  }

  // Optional: Send group notification
  if (GROUP_CHAT_ID) {
    try {
      await bot.sendMessage(
        GROUP_CHAT_ID,
        `✅ Daily study reports with AI summaries sent to ${reportsSent} members.`
      );
    } catch (err) {
      console.error("Error sending group notification:", err);
    }
  }

  console.log(`Daily reports completed. Sent to ${reportsSent} users.`);
}

// Cron job to run daily reports at 9 PM (21:00)
cron.schedule("0 21 * * *", () => {
  console.log("Running scheduled daily reports...");
  sendDailyReports();
});

// Manual trigger endpoint for testing
app.post("/send-reports", async (req, res) => {
  await sendDailyReports();
  res.json({ message: "Daily reports triggered manually" });
});

// On any message, store chat and activity
bot.on("message", async (msg) => {
  const chat = msg.chat;

  console.log(`Received message in chat ID: ${chat.id}`);

  await storeChat(chat);
  await storeUserActivity(msg);
});

// Express server
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Telegram Supabase AI Bot Running"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
