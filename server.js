// server.js - Render Web Service for Study Log Bot
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import express from 'express';

// --- Configuration ---
// Load environment variables (from Render Environment Variables)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
// Use the service key for secure database writes on the backend
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

// Initialize clients
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const app = express();

// --- Supabase Interaction Logic ---

/**
 * Registers the user if new and logs the study data.
 * @param {number} telegram_user_id - User's unique Telegram ID.
 * @param {number} chat_id - The ID of the chat where the message was sent (group or private).
 * @param {string} username - User's Telegram username.
 * @param {string} log_type - Type of content ('TEXT', 'LINK', 'PHOTO', 'VIDEO', etc.).
 * @param {string} content - The text, URL, or Telegram file_id.
 */
async function logStudyData(telegram_user_id, chat_id, username, log_type, content) {
    try {
        let { data: userData, error: fetchError } = await supabase
            .from('users')
            .select('id')
            .eq('telegram_user_id', telegram_user_id)
            .single();

        let userId;

        // 1. Register/Update User
        if (fetchError && fetchError.code === 'PGRST116') { // 'PGRST116' means 'no rows found'
            // User is new: Insert new user record
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert({ 
                    telegram_user_id: telegram_user_id, 
                    telegram_private_chat_id: telegram_user_id, // User ID is the private chat ID
                    username: username,
                    group_chat_id: chat_id // Save the group ID where the log occurred
                })
                .select('id')
                .single();

            if (insertError) throw insertError;
            userId = newUser.id;
        } else if (fetchError) {
            throw fetchError; // Handle other Supabase errors
        } else {
            // User exists
            userId = userData.id;
        }

        // 2. Insert Log
        const { error: logError } = await supabase
            .from('study_logs')
            .insert({
                user_id: userId,
                log_type: log_type,
                content: content
            });

        if (logError) throw logError;
        
        return '✅ Logged successfully! Your progress is recorded.';
        
    } catch (error) {
        console.error('Error in logStudyData:', error);
        return `❌ Failed to log study data. Error: ${error.message}`;
    }
}

// --- Telegram Bot Event Handlers ---

// Bot command to start and set the private chat ID
bot.start(async (ctx) => {
    const chat_id = ctx.chat.id;
    const telegram_user_id = ctx.from.id;

    // Check if it's a private chat (User ID = Chat ID)
    if (telegram_user_id === chat_id) {
        // This is a private chat. Save/Update the private chat ID in the users table.
        // NOTE: This assumes the user has already joined the group and been logged once.
        const { error } = await supabase
            .from('users')
            .update({ telegram_private_chat_id: chat_id })
            .eq('telegram_user_id', telegram_user_id);
            
        if (error) {
            return ctx.reply("Error updating your private notification setting. Have you logged study in the group chat yet?");
        }
        
        return ctx.reply("Hello! This is our private channel for notifications. I'll send your daily study reminders and reports here. Go to the group chat to log your study!");
    } else {
        // Group chat welcome message
        return ctx.reply("Hello everyone! I'm your daily study progress bot. Send me text, links, photos, or videos to log your study. I'll post a group summary and individual reports daily.");
    }
});


// Handle all incoming text, links, and media captions
bot.on(['text', 'photo', 'video', 'document'], async (ctx) => {
    // We only process logs sent in group chats (chat.type !== 'private')
    if (ctx.chat.type === 'private') {
        return ctx.reply("Please use the group chat to log your study. Use /start here to ensure private notifications work.");
    }

    const chat_id = ctx.chat.id;
    const telegram_user_id = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || 'Anonymous';
    
    let log_type;
    let content;

    // Logic to determine log type and content
    if (ctx.message.text) {
        log_type = 'TEXT';
        content = ctx.message.text;
    } else if (ctx.message.caption || ctx.message.photo || ctx.message.video || ctx.message.document) {
        // For media, log the Telegram file_id. Supabase Storage upload can be handled later 
        // by a separate process or is often managed by keeping the file_id for later retrieval if needed.
        if (ctx.message.photo) {
            log_type = 'PHOTO';
            content = ctx.message.photo.pop().file_id; // Get the largest photo file_id
        } else if (ctx.message.video) {
            log_type = 'VIDEO';
            content = ctx.message.video.file_id;
        } else if (ctx.message.document) {
            log_type = 'DOCUMENT';
            content = ctx.message.document.file_id;
        } else if (ctx.message.caption) {
            log_type = 'TEXT (Caption)';
            content = ctx.message.caption;
        }
    } else {
        return; // Ignore other message types
    }

    const response = await logStudyData(telegram_user_id, chat_id, username, log_type, content);
    
    // Reply back in the group
    await ctx.reply(response, { 
        reply_to_message_id: ctx.message.message_id 
    });
});

// --- Server Setup for Render Web Service ---

// Set the webhook for the bot (Render will forward requests here)
// You MUST manually set your Telegram Bot Webhook to point to your Render service URL + /webhook
// e.g., https://your-render-service.onrender.com/webhook
app.use(bot.webhookCallback('/webhook')); 

// Basic endpoint for health check (Render needs this)
app.get('/', (req, res) => {
  res.status(200).send('Study Bot Webhook Listener is Running!');
});

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
