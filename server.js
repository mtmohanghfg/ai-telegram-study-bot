import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cron from "node-cron";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  "TELEGRAM_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "OPENAI_API_KEY",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID ? Number(process.env.GROUP_CHAT_ID) : null;
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const app = express();
app.use(express.json());

console.log(`✅ Bot initialized in ${NODE_ENV} mode`);

// ============================================
// DATABASE FUNCTIONS
// ============================================

/**
 * Store chat information in Supabase
 */
async function storeChat(chat) {
  try {
    const { id, username, type } = chat;

    const { error } = await supabase.from("chats").upsert(
      {
        id,
        username: username || null,
        chat_type: type,
        first_seen: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

    if (error) {
      console.error(`⚠️ Error storing chat ${id}:`, error.message);
    } else {
      console.log(`✅ Stored chat ID: ${id}, Type: ${type}, Username: ${username || "N/A"}`);
    }
  } catch (err) {
    console.error("❌ Exception in storeChat:", err);
  }
}

/**
 * Store user activity message in Supabase
 */
async function storeUserActivity(msg) {
  try {
    const userId = msg.from.id;
    const username = msg.from.username || `User_${userId}`;
    const firstName = msg.from.first_name || "";
    const lastName = msg.from.last_name || "";

    let content = "";
    let messageType = "text";

    if (msg.text) {
      content = msg.text;
      if (content.includes("youtube.com") || content.includes("youtu.be")) {
        messageType = "youtube_link";
      }
    } else if (msg.photo) {
      messageType = "photo";
      content = msg.photo[msg.photo.length - 1].file_id || "photo";
    } else if (msg.video) {
      messageType = "video";
      content = msg.video.file_id || "video";
    } else if (msg.document) {
      messageType = "document";
      content = msg.document.file_name || "document";
    } else if (msg.audio) {
      messageType = "audio";
      content = "audio file";
    }

    if (!content) {
      console.log(`⏭️ Skipping message with no content from ${username}`);
      return;
    }

    const { error } = await supabase.from("user_activity").insert({
      user_id: userId,
      username: username,
      first_name: firstName,
      last_name: lastName,
      message_type: messageType,
      content: content,
      activity_date: new Date().toISOString().split("T")[0],
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error(`⚠️ Error storing activity for ${username}:`, error.message);
    } else {
      console.log(`✅ Stored ${messageType} from @${username}`);
    }
  } catch (err) {
    console.error("❌ Exception in storeUserActivity:", err);
  }
}

// ============================================
// AI FUNCTIONS
// ============================================

/**
 * Generate AI summary from study activities
 */
async function generateAISummary(texts) {
  try {
    if (!texts || texts.length === 0) {
      return "No study activities recorded today.";
    }

    const joinedText = texts.slice(0, 10).join("\n"); // Limit to first 10 items to avoid token limits
    const prompt = `You are a study assistant. Analyze the following study activities and provide a concise summary with 3-5 key learning points. Be encouraging and constructive:\n\n${joinedText}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.7,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Error generating AI summary:", error.message);
    return "Unable to generate summary at this moment. Please try again later.";
  }
}

/**
 * Generate AI learning tips based on activities
 */
async function generateLearningTips(activities) {
  try {
    if (!activities || activities.length === 0) {
      return "Keep up the great work!";
    }

    const summary = activities.slice(0, 5).join(", ");
    const prompt = `Based on these study activities: "${summary}", provide 2-3 personalized learning tips to improve productivity and retention.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.7,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Error generating learning tips:", error.message);
    return "Keep studying consistently!";
  }
}

// ============================================
// REPORT FUNCTIONS
// ============================================

/**
 * Send daily individual reports with AI summaries
 */
async function sendDailyReports() {
  console.log("🔄 Starting daily report generation...");

  try {
    const today = new Date().toISOString().split("T")[0];

    // Fetch all unique users with activity today
    const { data: users, error: usersError } = await supabase
      .from("user_activity")
      .select("user_id, username, first_name")
      .eq("activity_date", today)
      .order("user_id");

    if (usersError) {
      console.error("❌ Error fetching users:", usersError.message);
      return;
    }

    if (!users || users.length === 0) {
      console.log("ℹ️ No user activity found for today");
      return;
    }

    // Remove duplicates
    const uniqueUsers = [...new Map(users.map((u) => [u.user_id, u])).values()];

    let reportsSent = 0;
    let reportsFailed = 0;

    for (const user of uniqueUsers) {
      try {
        // Fetch all activities for this user today
        const { data: activities, error: activitiesError } = await supabase
          .from("user_activity")
          .select("message_type, content")
          .eq("user_id", user.user_id)
          .eq("activity_date", today)
          .order("created_at");

        if (activitiesError) {
          console.error(`⚠️ Error fetching activities for ${user.username}:`, activitiesError.message);
          reportsFailed++;
          continue;
        }

        if (!activities || activities.length === 0) {
          console.log(`⏭️ No activities for ${user.username}`);
          continue;
        }

        // Extract content for AI summary
        const textContents = activities
          .filter(
            (a) =>
              a.message_type === "text" ||
              a.message_type === "youtube_link" ||
              a.message_type === "document"
          )
          .map((a) => a.content);

        // Generate AI summary
        const aiSummary = await generateAISummary(textContents);

        // Generate learning tips
        const learningTips = await generateLearningTips(textContents);

        // Count activity types
        const photoCount = activities.filter((a) => a.message_type === "photo").length;
        const videoCount = activities.filter((a) => a.message_type === "video").length;
        const documentCount = activities.filter((a) => a.message_type === "document").length;
        const linkCount = activities.filter((a) => a.message_type === "youtube_link").length;
        const textCount = textContents.length;

        // Compose personalized report
        const userDisplayName = user.first_name || user.username || `User ${user.user_id}`;
        const report = `📚 *Daily Study Report for ${userDisplayName}*\n\n` +
          `📊 *Your Activity Today:*\n` +
          `• Text/Notes: ${textCount}\n` +
          `• YouTube Links: ${linkCount}\n` +
          `• Photos: ${photoCount}\n` +
          `• Videos: ${videoCount}\n` +
          `• Documents: ${documentCount}\n` +
          `• Total Items: ${activities.length}\n\n` +
          `🤖 *AI Summary:*\n${aiSummary}\n\n` +
          `💡 *Learning Tips:*\n${learningTips}\n\n` +
          `✨ Great effort today! Keep it up!`;

        // Send private message to user
        await bot.sendMessage(user.user_id, report, { parse_mode: "Markdown" });
        reportsSent++;
        console.log(`✅ Report sent to ${userDisplayName}`);

        // Add slight delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        console.error(`❌ Error sending report to user ${user.user_id}:`, err.message);
        reportsFailed++;
      }
    }

    // Send group notification if GROUP_CHAT_ID is set
    if (GROUP_CHAT_ID) {
      try {
        const groupMessage = `✅ Daily study reports with AI summaries sent to ${reportsSent} members.${
          reportsFailed > 0 ? ` (${reportsFailed} failed)` : ""
        }`;
        await bot.sendMessage(GROUP_CHAT_ID, groupMessage);
        console.log("✅ Group notification sent");
      } catch (err) {
        console.error("⚠️ Error sending group notification:", err.message);
      }
    }

    console.log(
      `📈 Daily reports completed. Sent: ${reportsSent}, Failed: ${reportsFailed}`
    );
  } catch (err) {
    console.error("❌ Exception in sendDailyReports:", err);
  }
}

/**
 * Send weekly statistics report
 */
async function sendWeeklyStats() {
  console.log("📊 Generating weekly statistics...");

  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const { data: stats, error } = await supabase
      .from("user_activity")
      .select("user_id, username, message_type")
      .gte("activity_date", weekAgo);

    if (error) {
      console.error("❌ Error fetching weekly stats:", error.message);
      return;
    }

    if (!stats || stats.length === 0) {
      console.log("ℹ️ No activity for weekly report");
      return;
    }

    // Calculate stats by user
    const userStats = {};
    stats.forEach((activity) => {
      if (!userStats[activity.user_id]) {
        userStats[activity.user_id] = {
          username: activity.username,
          total: 0,
          by_type: {},
        };
      }
      userStats[activity.user_id].total++;
      userStats[activity.user_id].by_type[activity.message_type] =
        (userStats[activity.user_id].by_type[activity.message_type] || 0) + 1;
    });

    // Send stats to each user
    for (const [userId, data] of Object.entries(userStats)) {
      try {
        const typeList = Object.entries(data.by_type)
          .map(([type, count]) => `• ${type}: ${count}`)
          .join("\n");

        const message = `📊 *Weekly Study Statistics*\n\n` +
          `Total activities: ${data.total}\n\n` +
          `By type:\n${typeList}\n\n` +
          `Keep maintaining your study streak! 🌟`;

        await bot.sendMessage(userId, message, { parse_mode: "Markdown" });
        console.log(`✅ Weekly stats sent to ${data.username}`);
      } catch (err) {
        console.error(`⚠️ Error sending weekly stats to ${userId}:`, err.message);
      }
    }

    console.log("✅ Weekly statistics sent to all active users");
  } catch (err) {
    console.error("❌ Exception in sendWeeklyStats:", err);
  }
}

// ============================================
// TELEGRAM BOT HANDLERS
// ============================================

/**
 * Handle any incoming message
 */
bot.on("message", async (msg) => {
  try {
    const chat = msg.chat;

    console.log(`📨 Message from ${msg.from.username || msg.from.id} in chat ${chat.id}`);

    await storeChat(chat);
    await storeUserActivity(msg);
  } catch (err) {
    console.error("❌ Error handling message:", err);
  }
});

/**
 * Handle /start command
 */
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || "Friend";

    const welcomeMessage = `👋 Welcome to the AI Study Bot, ${userName}!\n\n` +
      `I track your study activities and provide:\n` +
      `📚 Daily AI-powered study summaries\n` +
      `💡 Personalized learning tips\n` +
      `📊 Weekly progress statistics\n\n` +
      `Just share your study materials, links, and notes in the group, and I'll keep track!\n\n` +
      `Commands:\n` +
      `/help - Show available commands\n` +
      `/stats - View your study statistics`;

    await bot.sendMessage(chatId, welcomeMessage);
    console.log(`✅ Welcome message sent to ${userName}`);
  } catch (err) {
    console.error("❌ Error in /start command:", err);
  }
});

/**
 * Handle /help command
 */
bot.onText(/\/help/, async (msg) => {
  try {
    const chatId = msg.chat.id;

    const helpMessage = `🤖 *AI Study Bot Commands*\n\n` +
      `/start - Welcome message\n` +
      `/help - Show this help menu\n` +
      `/stats - Your study statistics\n` +
      `/report - Get today's summary report\n\n` +
      `*How it works:*\n` +
      `✅ Share study materials in the group\n` +
      `✅ I automatically track your activities\n` +
      `✅ Get daily AI summaries at 9 PM\n` +
      `✅ Receive personalized learning tips\n\n` +
      `Supported content:\n` +
      `📝 Text notes\n` +
      `🎥 YouTube links\n` +
      `📸 Photos\n` +
      `🎬 Videos\n` +
      `📄 Documents`;

    await bot.sendMessage(chatId, helpMessage, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error in /help command:", err);
  }
});

/**
 * Handle /report command
 */
bot.onText(/\/report/, async (msg) => {
  try {
    const userId = msg.from.id;
    const today = new Date().toISOString().split("T")[0];

    const { data: activities, error } = await supabase
      .from("user_activity")
      .select("message_type, content")
      .eq("user_id", userId)
      .eq("activity_date", today);

    if (error) {
      await bot.sendMessage(userId, "❌ Error fetching your activities");
      return;
    }

    if (!activities || activities.length === 0) {
      await bot.sendMessage(userId, "ℹ️ No activities recorded yet today");
      return;
    }

    const textContents = activities
      .filter(
        (a) =>
          a.message_type === "text" ||
          a.message_type === "youtube_link" ||
          a.message_type === "document"
      )
      .map((a) => a.content);

    const aiSummary = await generateAISummary(textContents);

    const report = `📚 *Today's Study Summary*\n\n${aiSummary}\n\n` +
      `Total activities: ${activities.length}`;

    await bot.sendMessage(userId, report, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error in /report command:", err);
  }
});

/**
 * Handle /stats command
 */
bot.onText(/\/stats/, async (msg) => {
  try {
    const userId = msg.from.id;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const { data: activities, error } = await supabase
      .from("user_activity")
      .select("message_type")
      .eq("user_id", userId)
      .gte("activity_date", weekAgo);

    if (error) {
      await bot.sendMessage(userId, "❌ Error fetching statistics");
      return;
    }

    if (!activities || activities.length === 0) {
      await bot.sendMessage(userId, "ℹ️ No activity data available yet");
      return;
    }

    const byType = {};
    activities.forEach((a) => {
      byType[a.message_type] = (byType[a.message_type] || 0) + 1;
    });

    const typeList = Object.entries(byType)
      .map(([type, count]) => `• ${type}: ${count}`)
      .join("\n");

    const statsMessage = `📊 *Your Weekly Statistics*\n\n` +
      `Total activities: ${activities.length}\n\n` +
      `By type:\n${typeList}`;

    await bot.sendMessage(userId, statsMessage, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error in /stats command:", err);
  }
});

// ============================================
// SCHEDULED TASKS
// ============================================

// Daily reports at 9 PM (21:00)
cron.schedule("0 21 * * *", () => {
  console.log("⏰ Scheduled daily reports triggered");
  sendDailyReports();
});

// Weekly statistics every Sunday at 8 PM
cron.schedule("0 20 * * 0", () => {
  console.log("⏰ Scheduled weekly stats triggered");
  sendWeeklyStats();
});

// ============================================
// EXPRESS SERVER ROUTES
// ============================================

app.get("/", (req, res) => {
  res.json({
    status: "✅ Bot is running",
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
});

// Manual trigger for reports (for testing)
app.post("/trigger-reports", async (req, res) => {
  console.log("🔄 Manual report trigger requested");
  await sendDailyReports();
  res.json({ message: "Reports triggered successfully" });
});

// Manual trigger for weekly stats
app.post("/trigger-weekly-stats", async (req, res) => {
  console.log("📊 Manual weekly stats trigger requested");
  await sendWeeklyStats();
  res.json({ message: "Weekly stats triggered successfully" });
});

// Environment variable verification endpoint (for debugging)
app.get("/env-check", (req, res) => {
  res.json({
    telegram_token_set: !!process.env.TELEGRAM_TOKEN,
    supabase_url_set: !!process.env.SUPABASE_URL,
    supabase_key_set: !!process.env.SUPABASE_ANON_KEY,
    openai_key_set: !!process.env.OPENAI_API_KEY,
    group_chat_id_set: !!process.env.GROUP_CHAT_ID,
    port: PORT,
    environment: NODE_ENV,
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🚀 AI Telegram Study Bot Started`);
  console.log(`📦 Port: ${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`⏰ Daily Reports: 9 PM (21:00)`);
  console.log(`📊 Weekly Stats: Sunday 8 PM (20:00)`);
  console.log(`${"=".repeat(50)}\n`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n❌ Bot shutting down gracefully...");
  process.exit(0);
});
