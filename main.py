# main.py
from flask import Flask, request
from openai import OpenAI
from supabase import create_client
import os

app = Flask(__name__)

# Environment variables
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
BOT_TOKEN = os.getenv("TELEGRAM_TOKEN")
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY")

# Initialize clients
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=OPENROUTER_KEY,
    default_headers={
        "HTTP-Referer": "https://ai-telegram-study-bot.onrender.com",
        "X-Title": "AI Telegram Study Assistant Bot"
    }
)

@app.route('/')
def home():
    return {'status': 'running', 'bot': 'AI Telegram Study Assistant Bot'}

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.get_json()
    if not data or 'message' not in data:
        return {'ok': False}

    chat_id = data['message']['chat']['id']
    text = data['message'].get('text', '')

    # Process user message with OpenRouter + Gemini 2.5 Flash
    response = client.chat.completions.create(
        model="google/gemini-2.5-flash",
        messages=[
            {"role": "system", "content": "You are a helpful study assistant bot."},
            {"role": "user", "content": text}
        ]
    )

    reply = response.choices[0].message.content

    # Store interaction in Supabase
    supabase.table("study_material").insert({
        "user_id": str(chat_id),
        "description": text,
        "file_name": "N/A",
        "file_type": "text"
    }).execute()

    return {'ok': True, 'response': reply}

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000)
