// server.js
import express from "express";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const app = express();
app.use(express.json());

// Telegram + Supabase + AI config
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const PORT = process.env.PORT || 3000;

// Clients
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai = new OpenAI({
  apiKey: OPENROUTER_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://study-assistant.onrender.com",
    "X-Title": "AI Telegram Study Assistant Bot",
  },
});

// Middleware for file uploads
const upload = multer({ dest: "uploads/" });

// Root endpoint
app.get("/", (req, res) => {
  res.json({ status: "Bot operational", service: "Render-Node: Active" });
});

// Telegram webhook route
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// User message handling
bot.on("message", async (ctx) => {
  const text = ctx.message.text;
  const name = ctx.message.from.first_name || "User";

  try {
    // Store message event
    await supabase.from("study_material").insert([
      {
        description: text,
        file_name: "text_message",
        file_type: "text",
      },
    ]);

    // AI reply
    const completion = await ai.chat.completions.create({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content:
            "You are an AI tutor helping students summarize and understand study materials.",
        },
        { role: "user", content: text },
      ],
    });

    const reply = completion.choices[0].message.content.trim();
    await ctx.reply(`📘 ${name}, here's an AI response:\n\n${reply}`);
  } catch (err) {
    console.error("Bot Error:", err);
    await ctx.reply("⚠️ Sorry, something went wrong. Please try again later.");
  }
});

// Handle uploaded files (PDF, images, etc.)
app.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  const path = `files/${file.originalname}`;
  const fileBuffer = fs.readFileSync(file.path);

  const { error: uploadError } = await supabase.storage
    .from("study-files")
    .upload(path, fileBuffer, { upsert: true });

  if (uploadError) {
    console.error(uploadError);
    return res.status(400).json({ error: uploadError.message });
  }

  fs.unlinkSync(file.path);
  res.json({ message: "File uploaded successfully", file: path });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
