// server.js
import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Environment variables
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const PORT = process.env.PORT || 3000;

// Telegram bot instance
const bot = new Telegraf(BOT_TOKEN);

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// OpenRouter client
const ai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://ai-telegram-study-bot.onrender.com",
    "X-Title": "AI Telegram Study Assistant Bot",
  },
});

// Webhook Endpoint for Telegram
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  await bot.handleUpdate(req.body, res);
});

// Telegram Message Handler
bot.on("message", async (ctx) => {
  const userMessage = ctx.message.text || "No text provided by user";

  try {
    // AI Response with Gemini 2.5 Flash
    const completion = await ai.chat.completions.create({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful AI study assistant that summarizes, explains, and provides study guidance.",
        },
        { role: "user", content: userMessage },
      ],
    });

    const aiReply = completion.choices[0].message.content.trim();

    // Save record to Supabase
    await supabase.from("study_material").insert([
      {
        file_name: "TextPrompt",
        file_type: "text",
        description: userMessage,
      },
    ]);

    await ctx.reply(aiReply);
  } catch (err) {
    console.error("AI Processing Error:", err.message);
    await ctx.reply("Sorry, something went wrong processing your message.");
  }
});

// Home Route
app.get("/", (req, res) => {
  res.send("AI Telegram Study Assistant Bot is active on Render!");
});

// Start Flask-like Express Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
