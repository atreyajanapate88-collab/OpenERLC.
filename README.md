# OpenERLC

ER:LC-only AI chatbot. Answers from the ER:LC Fandom wiki (live lookups) and shows live server stats through the ER:LC MCP server.

## Run locally
```
pip install -r requirements.txt
set GROQ_API_KEY=...                # Windows Command Prompt; or use .env / env.txt
set ERLC_SERVER_KEY=...             # in-game: Settings > API key (omit to disable live stats)
python app.py
```
Open http://localhost:8000

The app reads `.env` and then fills any missing values from `env.txt` in the project folder. Set
`OPENERLC_MODEL=openai/gpt-oss-120b` there to select the Groq model.

## Host it
Deploy this folder with the Dockerfile on Railway, Render, Fly.io or a VPS. Set `GROQ_API_KEY` and, optionally, `ERLC_SERVER_KEY` as environment variables on the host (never in the code or page).

## Notes
- Live tools are read-only; `run_command` is force-disabled for the chatbot.
- Public visitors can see live player data, so set `OPENERLC_LIVE_ENABLED=false` if that's not OK.
- Each visitor message costs AI tokens; a per-IP limit is built in (`OPENERLC_RATE_PER_MIN`). Add authentication before sharing widely.
- Live calls are cached for 10 seconds so many users don't exhaust the ER:LC API rate limit.
