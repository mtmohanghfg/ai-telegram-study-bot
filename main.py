import os
import requests
from flask import Flask, request
from telegram import Update
from telegram.ext import Application, MessageHandler, filters, ContextTypes
from supabase import create_client, Client

# Environment variables
TELEGRAM_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN')
SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_KEY')
OPENROUTER_API_KEY = os.getenv('OPENROUTER_API_KEY')

# Initialize Supabase client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Flask app for webhook
app = Flask(__name__)

# Function to call OpenRouter AI
def get_ai_response(text):
    try:
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "model": "google/gemini-2.0-flash-exp:free",
                "messages": [{"role": "user", "content": text}]
            }
        )
        result = response.json()
        return result['choices'][0]['message']['content']
    except Exception as e:
        return f"AI Error: {str(e)}"

# Message handler
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    text = update.message.text
    
    # Save to Supabase
    try:
        supabase.table('study_material').insert({
            'user_id': user.id,
            'username': user.username,
            'content': text,
            'type': 'text'
        }).execute()
    except:
        pass
    
    # Get AI response
    ai_response = get_ai_response(text)
    await update.message.reply_text(f"📚 Study Assistant:\\n\\n{ai_response}")

# Webhook endpoint
@app.route('/webhook', methods=['POST'])
async def webhook():
    update = Update.de_json(request.get_json(force=True), application.bot)
    await application.process_update(update)
    return 'ok'

@app.route('/')
def home():
    return 'AI Telegram Study Bot is running!'

# Initialize bot
application = Application.builder().token(TELEGRAM_TOKEN).build()
application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

if __name__ == '__main__':
    port = int(os.getenv('PORT', 10000))
    app.run(host='0.0.0.0', port=port)
