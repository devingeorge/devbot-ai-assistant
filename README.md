# Slack AI Assistant

A Slack bot powered by GROK API that provides AI assistant functionality within Slack workspaces.

## Features

- **App Mentions**: Mention the bot in any channel to get AI responses
- **Slash Commands**: Use `/ai <question>` for quick AI assistance
- **Direct Messages**: Send direct messages to the bot for private conversations
- **App Home**: Interactive home tab with quick actions
- **Thread Responses**: Maintains conversation context in threads

## Prerequisites

- Node.js (v16 or higher)
- Slack workspace with admin permissions
- GROK API key
- Render account (for deployment)

## Setup

### 1. Clone and Install Dependencies

```bash
git clone <your-repo-url>
cd slack-ai-assistant
npm install
```

### 2. Environment Configuration

Copy the example environment file and fill in your credentials:

```bash
cp env.example .env
```

Update `.env` with your actual values:
- `SLACK_BOT_TOKEN`: Your Slack bot token
- `SLACK_SIGNING_SECRET`: Your Slack app signing secret
- `GROK_API_KEY`: Your GROK API key

### 3. Slack App Configuration

You'll need to configure the following in your Slack app settings:

#### Event Subscriptions
- `app_mention`: Respond to @ mentions
- `message.im`: Respond to direct messages
- `app_home_opened`: Handle home tab interactions

#### Slash Commands
- `/ai`: Command to interact with the AI assistant

#### OAuth & Permissions
Required bot token scopes:
- `app_mentions:read`
- `channels:history`
- `chat:write`
- `im:history`
- `im:read`
- `im:write`
- `users:read`

#### Interactive Components
- Enable interactivity for button clicks

### 4. Local Development

```bash
npm run dev
```

### 5. Deploy to Render

1. Push your code to GitHub
2. Connect your GitHub repo to Render
3. Create a new Web Service
4. Configure environment variables in Render
5. Deploy!

## Usage

### App Mentions
```
@AI Assistant What's the weather like today?
```

### Slash Commands
```
/ai How do I deploy a Node.js app?
```

### Direct Messages
Simply send a message to the bot in a DM.

### App Home
Click on the bot in your app directory to access the interactive home tab.

## API Integration

The bot integrates with GROK API for AI responses. Make sure to:

1. Obtain a GROK API key
2. Update the API endpoint in `app.js` if needed
3. Configure the request format according to GROK's API documentation

## Troubleshooting

- Check your environment variables are correctly set
- Verify Slack app permissions and event subscriptions
- Ensure GROK API key is valid and has sufficient credits
- Check Render logs for deployment issues

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License
