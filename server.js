// server.js - Main Render Web Service (Handles Webhooks)
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import express from 'express';

// --- Configuration ---
// These environment variables MUST be set in your Render Web Service dashboard
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Service Role Key is required for secure backend ops
const PORT = process.env.PORT || 3000;

// Initialize clients
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const app = express();

// --- Supabase Interaction Logic ---

/**
 * Registers the user if new, updates their private chat ID, and logs the study data.
 */
async function logStudyData(telegram_user_id, chat_id, username, log_type, content) {
    try {
        let { data: userData, error: fetchError } = await supabase
            .from('users')
            .select('id, group_chat_id')
            .eq('telegram_user_id', telegram_user_id)
            .single();

        let userId;

        // 1. Register/Update User
        if (fetchError && fetchError.code === 'PGRST116') { // No rows found
            // Insert new user record. Use user_id for the private_chat_id initially.
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert({ 
                    telegram_user_id: telegram_user_id, 
                    telegram_private_chat_id: telegram_user_id, 
                    username: username,
                    group_chat_id: chat_id 
                })
                .select('id')
                .single();

            if (insertError) throw insertError;
            userId = newUser.id;
        } else if (fetchError) {
            throw fetchError;
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
        return `❌ Failed to log study data. Please contact the group admin.`;
    }
}

// --- Telegram Bot Event Handlers ---

// Bot command to start and set the private chat ID (Crucial for individual notifications)
bot.start(async (ctx) => {
    const chat_id = ctx.chat.id;
    const telegram_user_id = ctx.from.id;

    if (telegram_user_id === chat_id) { // Private chat
        // Update the telegram_private_chat_id to ensure DMs work
        const { error } = await supabase
            .from('users')
            .update({ telegram_private_chat_id: chat_id })
            .eq('telegram_user_id', telegram_user_id);
            
        if (error) {
            console.error("Error updating private chat ID:", error);
            return ctx.reply("Hello! Use /start in the group first. Error updating private setting.");
        }
        
        return ctx.reply("👋 Notifications Activated! I'll send your daily study reports and reminders directly here. Now, head back to the group to log your study!");
    } else {
        // Group chat welcome message
        return ctx.reply("Hello everyone! I'm your daily study progress bot. Send me text, links, photos, or videos to log your study. Use /start in a private chat with me to enable individual notifications!");
    }
});


// Handle all incoming text and media
bot.on(['text', 'photo', 'video', 'document'], async (ctx) => {
    // Only process logs sent in the group chat, not in private DMs
    if (ctx.chat.type === 'private') {
        return ctx.reply("Please use the group chat to log your study. Use /start here only to enable private notifications.");
    }

    const chat_id = ctx.chat.id;
    const telegram_user_id = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || 'Anonymous';
    
    let log_type;
    let content;

    // Logic to determine log type and content
    if (ctx.message.text) {
        // Simple text or link log
        log_type = 'TEXT';
        content = ctx.message.text;
    } else if (ctx.message.caption || ctx.message.photo || ctx.message.video || ctx.message.document) {
        // Handle media. We log the Telegram file_id, which is necessary for the cron job to retrieve or link to media later.
        if (ctx.message.photo) {
            log_type = 'PHOTO';
            content = ctx.message.photo.pop().file_id; // Get the largest photo file_id
        } else if (ctx.message.video) {
            log_type = 'VIDEO';
            content = ctx.message.video.file_id;
        } else if (ctx.message.document) {
            log_type = 'DOCUMENT';
            content = ctx.message.document.file_id;
        }
        // If there's a caption, log it as an additional entry
        if (ctx.message.caption) {
             // Log the caption text separately, often contains the link/context
             await logStudyData(telegram_user_id, chat_id, username, 'TEXT (Caption)', ctx.message.caption);
        }
    } else {
        return; // Ignore unsupported message types
    }

    // Only log if content was found from the message
    if (content) {
        const response = await logStudyData(telegram_user_id, chat_id, username, log_type, content);
        await ctx.reply(response, { reply_to_message_id: ctx.message.message_id });
    }
});

// --- Server Setup for Render Web Service ---

// Use Express middleware to parse incoming JSON from the webhook
app.use(express.json());

// Set the webhook for the bot (Render will forward requests here)
app.use(bot.webhookCallback('/webhook')); 

// Basic endpoint for health check
app.get('/', (req, res) => {
  res.status(200).send('Study Bot Webhook Listener is Running!');
});

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
