import dotenv from "dotenv";
dotenv.config();

import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import cron from "node-cron";

// Helper function to read env variable or exit
function getEnv(name) {
  if (process.env[name]) return process.env[name];
  console.error(`❌ Missing required env variable: ${name}`);
  process.exit(1);
}

const TELEGRAM_TOKEN = getEnv("TELEGRAM_TOKEN");
const SUPABASE_URL = getEnv("SUPABASE_URL");
const SUPABASE_ANON_KEY = getEnv("SUPABASE_ANON_KEY");
const OPENAI_API_KEY = getEnv("OPENAI_API_KEY");
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || null;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const app = express();
app.use(express.json());

// Store chat info
async function storeChat(chat) {
  const { id, username, type } = chat;
  const { error } = await supabase.from("chats").upsert({
    id,
    username: username || null,
    chat_type: type,
    first_seen: new Date().toISOString(),
  }, { onConflict: "id" });
  if (error) console.error("Error storing chat:", error.message);
}

// Store user activity message
async function storeUserActivity(msg) {
  const userId = msg.from.id;
  const username = msg.from.username || `User_${userId}`;
  const firstName = msg.from.first_name || "";
  const lastName = msg.from.last_name || "";
  let content = "";
  let messageType = "text";
  if (msg.text) {
    content = msg.text;
    if (content.includes("youtube.com") || content.includes("youtu.be"))
      messageType = "youtube_link";
  } else if (msg.photo) {
    messageType = "photo";
    content = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.video) {
    messageType = "video";
    content = msg.video.file_id;
  } else if (msg.document) {
    messageType = "document";
    content = msg.document.file_name;
  }
  if (!content) return;
  await supabase.from("user_activity").insert({
    user_id: userId,
    username,
    first_name: firstName,
    last_name: lastName,
    message_type: messageType,
    content,
    activity_date: new Date().toISOString().split("T")[0],
    created_at: new Date().toISOString(),
  });
}

// Generate AI summary from study activities
async function generateAISummary(texts) {
  if (!texts || texts.length === 0)
    return "No study activities recorded today.";
  const prompt = `You are a study assistant. Analyze the following study activities and provide a concise summary with 3-5 key learning points:\n\n${texts.join("\n")}`;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.7,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    return "AI summary unavailable right now.";
  }
}

// Daily report sender
async function sendDailyReports() {
  const today = new Date().toISOString().split("T")[0];
  const { data: users, error } = await supabase
    .from("user_activity")
    .select("user_id, username")
    .eq("activity_date", today);
  if (error || !users) return;
  const uniqueUserIds = [...new Map(users.map(u => [u.user_id, u])).values()];
  let sent = 0;
  for (const user of uniqueUserIds) {
    const { data: acts } = await supabase
      .from("user_activity")
      .select("message_type, content")
      .eq("user_id", user.user_id)
      .eq("activity_date", today);
    const texts = acts.filter(a => ["text", "youtube_link"].includes(a.message_type)).map(a => a.content);
    const aiSummary = await generateAISummary(texts);
    const photoCount = acts.filter(a => a.message_type === "photo").length;
    const videoCount = acts.filter(a => a.message_type === "video").length;
    const msg = `📚 Daily Study Report for @${user.username}:\n\n${aiSummary}\n\nPhotos: ${photoCount}\nVideos: ${videoCount}\nTotal: ${acts.length}`;
    await bot.sendMessage(user.user_id, msg);
    sent++;
  }
  if (GROUP_CHAT_ID) {
    await bot.sendMessage(GROUP_CHAT_ID, `✅ Daily study reports sent to ${sent} members.`);
  }
}

// Telegram bot handlers
bot.on("message", async (msg) => {
  const chat = msg.chat;
  await storeChat(chat);
  await storeUserActivity(msg);
});

// Bot commands
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    "👋 Welcome to the AI Study Bot! Send notes, links, photos, or documents. Get daily reports with AI summaries.");
});
bot.onText(/\/report/, async (msg) => {
  const userId = msg.from.id;
  const today = new Date().toISOString().split("T")[0];
  const { data: acts } = await supabase
    .from("user_activity")
    .select("message_type, content")
    .eq("user_id", userId)
    .eq("activity_date", today);
  if (!acts || acts.length === 0) {
    await bot.sendMessage(userId, "No activities recorded today.");
    return;
  }
  const texts = acts.filter(a => ["text", "youtube_link"].includes(a.message_type)).map(a => a.content);
  const aiSummary = await generateAISummary(texts);
  await bot.sendMessage(userId, `📚 Today's Study Summary:\n${aiSummary}\nTotal activities: ${acts.length}`);
});

// Scheduled tasks
cron.schedule("0 21 * * *", () => sendDailyReports()); // 9 PM daily

// Express healthcheck
app.get("/", (req, res) => res.send("AI Telegram Study Bot Running."));
app.get("/health", (req, res) => res.send("healthy"));

// Start server
app.listen(PORT, () => console.log(`Server running at port ${PORT}`));
