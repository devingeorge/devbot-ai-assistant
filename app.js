const { App } = require('@slack/bolt');
const axios = require('axios');
require('dotenv').config();

// Initialize your app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  port: process.env.PORT || 3000,
  endpoints: {
    events: '/slack/events',
    interactive: '/slack/events',
    commands: '/slack/events'
  }
});

// GROK API integration function
async function callGrokAPI(message, userId) {
  try {
    // Note: You'll need to replace this with the actual GROK API endpoint and format
    // This is a placeholder structure
    const response = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-2-1212',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful AI assistant integrated into Slack. Be concise and helpful in your responses.'
        },
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('GROK API Error:', error.response?.data || error.message);
    throw new Error('Failed to get AI response');
  }
}

// Listen to messages that mention the bot
app.event('app_mention', async ({ event, say, client }) => {
  try {
    // Extract the message text without the mention
    const messageText = event.text.replace(/<@[^>]+>/g, '').trim();
    
    if (!messageText) {
      await say('Hello! How can I help you today?');
      return;
    }

    // Show typing indicator
    await client.conversations.mark({
      channel: event.channel,
      ts: event.ts
    });

    // Get AI response from GROK
    const aiResponse = await callGrokAPI(messageText, event.user);
    
    // Reply with the AI response
    await say({
      text: aiResponse,
      thread_ts: event.ts
    });
  } catch (error) {
    console.error('Error processing mention:', error);
    await say({
      text: 'Sorry, I encountered an error processing your request. Please try again.',
      thread_ts: event.ts
    });
  }
});

// Slash command handler
app.command('/ai', async ({ command, ack, say, respond }) => {
  await ack();

  try {
    const query = command.text.trim();
    
    if (!query) {
      await respond('Please provide a question or request. Usage: `/ai <your question>`');
      return;
    }

    // Show typing indicator
    await say('Thinking... 🤔');

    // Get AI response from GROK
    const aiResponse = await callGrokAPI(query, command.user_id);
    
    // Reply with the AI response
    await respond({
      text: aiResponse,
      response_type: 'in_channel'
    });
  } catch (error) {
    console.error('Error processing slash command:', error);
    await respond('Sorry, I encountered an error processing your request. Please try again.');
  }
});

// Listen to direct messages
app.event('message', async ({ event, say, client }) => {
  // Skip messages from bots (including ourselves)
  if (event.bot_id || event.subtype) {
    return;
  }

  // Only respond to direct messages (channel type 'im')
  if (event.channel_type === 'im') {
    try {
      // Show typing indicator
      await client.conversations.mark({
        channel: event.channel,
        ts: event.ts
      });

      // Get AI response from GROK
      const aiResponse = await callGrokAPI(event.text, event.user);
      
      // Reply with the AI response
      await say(aiResponse);
    } catch (error) {
      console.error('Error processing DM:', error);
      await say('Sorry, I encountered an error processing your request. Please try again.');
    }
  }
});

// Home tab handler
app.event('app_home_opened', async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Welcome to your AI Assistant! 🤖*\n\nI can help you with various tasks. Here are some ways to interact with me:\n\n• *Mention me* in any channel: `@AI Assistant <your question>`\n• *Use the slash command*: `/ai <your question>`\n• *Send me a direct message* with your questions\n\nWhat would you like to know?'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Quick Actions:*'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Help'
                },
                action_id: 'help_button',
                style: 'primary'
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error publishing home view:', error);
  }
});

// Button click handler
app.action('help_button', async ({ ack, say }) => {
  await ack();
  await say('I\'m an AI assistant powered by GROK! I can help you with questions, provide information, and assist with various tasks. Just ask me anything!');
});

// Error handling
app.error((error) => {
  console.error('App error:', error);
});

// Start the app
(async () => {
  try {
    await app.start();
    console.log('⚡️ Slack AI Assistant is running!');
  } catch (error) {
    console.error('Failed to start the app:', error);
    process.exit(1);
  }
})();
